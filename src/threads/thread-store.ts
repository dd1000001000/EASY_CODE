import { hostname } from "node:os";

import {
  DEFAULT_THINKING_EFFORT,
  type AgentMode,
  type AgentRunResult,
  type ChatMessage,
  type CommandAuditEntry,
  type EventRecord,
  type ProviderName,
  type SessionState,
  type ThinkingEffort,
} from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { createId } from "../utils/ids.js";
import { EventJournal, type AppendEventInput } from "./event-journal.js";
import {
  deserializeSessionState,
  isChatMessage,
  serializeChatMessage,
  serializeSessionState,
} from "./serialization.js";

export interface ThreadCreateInput {
  readonly threadId?: string;
  readonly workspaceRoot: string;
  readonly mode: AgentMode;
  readonly provider: ProviderName;
  readonly model: string;
  readonly thinkingEffort?: ThinkingEffort;
  readonly goal?: string;
  readonly constraints?: readonly string[];
  readonly messages?: readonly ChatMessage[];
}

export interface ThreadListOptions {
  readonly workspaceId?: string;
  readonly limit?: number;
}

export interface ThreadSummary {
  readonly id: string;
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly mode: AgentMode;
  readonly provider: ProviderName;
  readonly model: string;
  readonly goal?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TurnStartResult {
  readonly turnId: string;
  readonly event: EventRecord;
}

export interface ThreadLease {
  readonly threadId: string;
  readonly ownerPid: number;
  readonly ownerHostname: string;
  readonly ownerToken: string;
  readonly acquiredAt: string;
}

export interface ThreadLeaseAcquireOptions {
  /** Primarily useful for deterministic dead-process recovery tests. */
  readonly processId?: number;
  readonly ownerHostname?: string;
  readonly ownerToken?: string;
  readonly now?: () => Date;
  readonly isProcessAlive?: (processId: number) => boolean;
}

export type UserChatMessage = Extract<ChatMessage, { role: "user" }>;

interface ThreadRow {
  id: string;
  workspace_root: string;
  workspace_id: string;
  mode: AgentMode;
  provider: ProviderName;
  model: string;
  goal: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ThreadLeaseRow {
  thread_id: string;
  owner_pid: number;
  owner_hostname: string;
  owner_token: string;
  acquired_at: string;
}

function asPayloadRecord(payload: unknown): Record<string, unknown> | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  return payload as Record<string, unknown>;
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return JSON.parse(serializeChatMessage(message)) as ChatMessage;
}

function appendMessageIfNew(state: SessionState, message: ChatMessage): void {
  const previous = state.messages[state.messages.length - 1];
  if (previous && serializeChatMessage(previous) === serializeChatMessage(message)) return;
  state.messages.push(cloneMessage(message));
}

/** Stores thread metadata as SQLite projections and recovers state from JSONL. */
export class ThreadStore {
  constructor(private readonly storage: EasyCodeStorage) {}

  create(input: ThreadCreateInput): SessionState {
    const threadId = input.threadId ?? createId("thread");
    const journal = this.journal(threadId);
    const now = new Date().toISOString();
    const state: SessionState = {
      threadId,
      mode: input.mode,
      provider: input.provider,
      model: input.model,
      thinkingEffort: input.thinkingEffort ?? DEFAULT_THINKING_EFFORT,
      workspaceRoot: input.workspaceRoot,
      goal: input.goal,
      constraints: [...(input.constraints ?? [])],
      messages: (input.messages ?? []).map(cloneMessage),
      filesRead: new Map(),
      changes: [],
      commands: [],
      workingSummary: "",
      compactedMessageCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    let event!: EventRecord;
    this.storage.db.transaction(() => {
      if (journal.read().length > 0 || this.threadExists(threadId)) {
        throw new Error(`Thread already exists: ${threadId}`);
      }
      event = journal.append({
        type: "thread_created",
        payload: { state: serializeSessionState(state) },
      });
      this.projectState(state, "active");
      this.projectEvent(event, journal.filePath);
    })();
    return deserializeSessionState(serializeSessionState(state));
  }

  get(threadId: string): SessionState | undefined {
    const journal = this.journal(threadId);
    const events = journal.read();
    if (events.length === 0) return undefined;
    const state = this.recoverFromEvents(threadId, events);
    this.reconcileProjection(state, events, journal.filePath);
    return state;
  }

  recover(threadId: string): SessionState {
    const state = this.get(threadId);
    if (!state) throw new Error(`Thread not found: ${threadId}`);
    return state;
  }

  save(state: SessionState): void {
    const journal = this.journal(state.threadId);
    const snapshot: SessionState = {
      ...state,
      updatedAt: new Date().toISOString(),
      constraints: [...state.constraints],
      messages: state.messages.map(cloneMessage),
      filesRead: new Map(state.filesRead),
      changes: state.changes.map((change) => ({ ...change })),
      commands: state.commands.map((command) => ({
        ...command,
        args: [...command.args],
      })),
    };
    state.updatedAt = snapshot.updatedAt;

    this.storage.db.transaction(() => {
      if (journal.read().length === 0 || !this.threadExists(state.threadId)) {
        throw new Error(`Cannot save unknown thread: ${state.threadId}`);
      }
      const event = journal.append({
        type: "thread_checkpoint",
        payload: { state: serializeSessionState(snapshot) },
        turnId: snapshot.activeTurnId,
      });
      this.projectState(snapshot, "active");
      this.projectEvent(event, journal.filePath);
      for (const command of snapshot.commands) {
        this.projectToolAudit(snapshot.threadId, snapshot.activeTurnId, command);
      }
    })();
  }

  list(options: ThreadListOptions = {}): ThreadSummary[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const rows = options.workspaceId
      ? this.storage.db
          .prepare<[string, number], ThreadRow>(
            `SELECT id, workspace_root, workspace_id, mode, provider, model,
                    goal, status, created_at, updated_at
               FROM threads
              WHERE workspace_id = ?
              ORDER BY updated_at DESC
              LIMIT ?`,
          )
          .all(options.workspaceId, limit)
      : this.storage.db
          .prepare<[number], ThreadRow>(
            `SELECT id, workspace_root, workspace_id, mode, provider, model,
                    goal, status, created_at, updated_at
               FROM threads
              ORDER BY updated_at DESC
              LIMIT ?`,
          )
          .all(limit);

    return rows.map((row) => ({
      id: row.id,
      threadId: row.id,
      workspaceRoot: row.workspace_root,
      workspaceId: row.workspace_id,
      mode: row.mode,
      provider: row.provider,
      model: row.model,
      goal: row.goal ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  appendEvent(threadId: string, input: AppendEventInput): EventRecord {
    const journal = this.journal(threadId);
    let event!: EventRecord;
    this.storage.db.transaction(() => {
      if (!this.threadExists(threadId)) throw new Error(`Thread not found: ${threadId}`);
      event = journal.append(input);
      this.projectEvent(event, journal.filePath);
      this.projectAuxiliaryEvent(threadId, event);
      this.touchThread(threadId, event.timestamp);
    })();
    return event;
  }

  acquireThreadLease(
    threadId: string,
    options: ThreadLeaseAcquireOptions = {},
  ): ThreadLease {
    const ownerPid = options.processId ?? process.pid;
    const ownerHostname = options.ownerHostname ?? hostname();
    const ownerToken = options.ownerToken ?? createId("thread_lease");
    const acquiredAt = (options.now ?? (() => new Date()))().toISOString();
    const isProcessAlive = options.isProcessAlive ?? processIsAlive;
    const lease: ThreadLease = {
      threadId,
      ownerPid,
      ownerHostname,
      ownerToken,
      acquiredAt,
    };
    assertValidThreadLease(lease);

    this.storage.db.transaction(() => {
      if (!this.threadExists(threadId)) {
        const journal = this.journal(threadId);
        const events = journal.read();
        if (events.length === 0) throw new Error(`Thread not found: ${threadId}`);
        const recovered = this.recoverFromEvents(threadId, events);
        this.projectRecoveredThread(recovered, events, journal.filePath);
      }

      const existing = this.storage.db
        .prepare<[string], ThreadLeaseRow>(
          `SELECT thread_id, owner_pid, owner_hostname, owner_token, acquired_at
             FROM thread_leases
            WHERE thread_id = ?`,
        )
        .get(threadId);
      if (existing) {
        assertValidThreadLeaseRow(existing);
        const ownerState = existing.owner_hostname === ownerHostname
          ? (isProcessAlive(existing.owner_pid) ? "alive" : "dead")
          : "unknown";
        if (ownerState !== "dead") {
          throw new Error(
            `Thread ${threadId} is already active in another EASY CODE process ` +
            `(PID ${existing.owner_pid} on ${existing.owner_hostname}). Close it before resuming.`,
          );
        }
        const removed = this.storage.db
          .prepare<[string, string]>(
            "DELETE FROM thread_leases WHERE thread_id = ? AND owner_token = ?",
          )
          .run(threadId, existing.owner_token);
        if (removed.changes !== 1) {
          throw new Error(`Thread lease ownership changed while recovering ${threadId}`);
        }
      }

      this.storage.db
        .prepare(
          `INSERT INTO thread_leases(
             thread_id, owner_pid, owner_hostname, owner_token, acquired_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(threadId, ownerPid, ownerHostname, ownerToken, acquiredAt);
    })();
    return lease;
  }

  releaseThreadLease(lease: ThreadLease): void {
    assertValidThreadLease(lease);
    this.storage.db.transaction(() => {
      const removed = this.storage.db
        .prepare<[string, number, string, string]>(
          `DELETE FROM thread_leases
            WHERE thread_id = ?
              AND owner_pid = ?
              AND owner_hostname = ?
              AND owner_token = ?`,
        )
        .run(
          lease.threadId,
          lease.ownerPid,
          lease.ownerHostname,
          lease.ownerToken,
        );
      if (removed.changes !== 1) {
        throw new Error(
          `Cannot release thread lease for ${lease.threadId}: ownership no longer matches`,
        );
      }
    })();
  }

  startTurn(
    threadId: string,
    userMessage: string | UserChatMessage,
    turnId = createId("turn"),
  ): TurnStartResult {
    const message: UserChatMessage =
      typeof userMessage === "string"
        ? { role: "user", content: userMessage }
        : cloneMessage(userMessage) as UserChatMessage;
    const startedAt = new Date().toISOString();
    const event = this.appendEvent(threadId, {
      type: "turn_started",
      turnId,
      timestamp: startedAt,
      payload: { message },
    });
    return { turnId, event };
  }

  completeTurn(
    threadId: string,
    turnId: string,
    assistantMessage: Extract<ChatMessage, { role: "assistant" }>,
    reason: AgentRunResult["reason"] = "success",
  ): EventRecord {
    if (!isChatMessage(assistantMessage) || assistantMessage.role !== "assistant") {
      throw new Error("completeTurn requires an assistant chat message");
    }
    const message = cloneMessage(assistantMessage) as Extract<
      ChatMessage,
      { role: "assistant" }
    >;
    const completedAt = new Date().toISOString();
    const event = this.appendEvent(threadId, {
      type: "turn_completed",
      turnId,
      timestamp: completedAt,
      phase: "completed",
      payload: { message, reason },
    });
    return event;
  }

  recordMessage(threadId: string, message: ChatMessage, turnId?: string): EventRecord {
    if (!isChatMessage(message)) throw new Error("Invalid chat message");
    return this.appendEvent(threadId, {
      type: "chat_message",
      payload: { message: cloneMessage(message) },
      turnId,
    });
  }

  recordToolAudit(
    threadId: string,
    turnId: string | undefined,
    entry: CommandAuditEntry,
  ): EventRecord {
    const event = this.appendEvent(threadId, {
      type: "tool_audit",
      payload: { entry: { ...entry, args: [...entry.args] } },
      turnId,
      phase: entry.status === "policy_denied" ? "denied" : "completed",
      timestamp: entry.timestamp,
    });
    return event;
  }

  journal(threadId: string): EventJournal {
    return new EventJournal(this.storage.dataDir, threadId);
  }

  rebuildProjection(threadId: string): SessionState {
    const journal = this.journal(threadId);
    const events = journal.read();
    if (events.length === 0) throw new Error(`Thread not found: ${threadId}`);
    const state = this.recoverFromEvents(threadId, events);
    this.reconcileProjection(state, events, journal.filePath);
    return state;
  }

  private recoverFromEvents(threadId: string, events: readonly EventRecord[]): SessionState {
    let state: SessionState | undefined;
    for (const event of events) {
      const payload = asPayloadRecord(event.payload);
      if (event.type === "thread_created" || event.type === "thread_checkpoint") {
        if (!payload || !("state" in payload)) {
          throw new Error(`Missing state in ${event.type} event`);
        }
        state = deserializeSessionState(payload.state);
        continue;
      }
      if (!state) throw new Error(`Thread ${threadId} has no creation event`);

      if (event.type === "turn_started") {
        state.activeTurnId = event.turnId;
        if (payload && isChatMessage(payload.message) && payload.message.role === "user") {
          appendMessageIfNew(state, payload.message);
        }
      } else if (event.type === "turn_completed") {
        state.activeTurnId = undefined;
        if (
          payload &&
          isChatMessage(payload.message) &&
          payload.message.role === "assistant"
        ) {
          appendMessageIfNew(state, payload.message);
        }
      } else if (event.type === "chat_message") {
        if (payload && isChatMessage(payload.message)) {
          appendMessageIfNew(state, payload.message);
        }
      } else if (event.type === "message.user" && event.turnId) {
        if (payload && isChatMessage(payload.message) && payload.message.role === "user") {
          state.activeTurnId = event.turnId;
          appendMessageIfNew(state, payload.message);
        } else if (typeof payload?.content === "string") {
          state.activeTurnId = event.turnId;
          appendMessageIfNew(state, { role: "user", content: payload.content });
        }
      } else if (
        event.type === "message.user.synthetic" &&
        isChatMessage(event.payload) &&
        event.payload.role === "user"
      ) {
        appendMessageIfNew(state, event.payload);
      } else if (
        (event.type === "message.assistant" || event.type === "message.assistant.synthetic") &&
        isChatMessage(event.payload)
      ) {
        appendMessageIfNew(state, event.payload);
      } else if (event.type === "tool.result" && payload) {
        if (isChatMessage(payload.message) && payload.message.role === "tool") {
          appendMessageIfNew(state, payload.message);
        } else {
          const callId = payload.callId;
          const tool = payload.tool;
          if (typeof callId !== "string" || typeof tool !== "string") continue;
          appendMessageIfNew(state, {
            role: "tool",
            tool_call_id: callId,
            name: tool,
            content: JSON.stringify(payload.result ?? null).slice(0, 64_000),
          });
        }
      } else if (event.type === "turn.completed") {
        state.activeTurnId = undefined;
      } else if (event.type === "context.compacted" && payload) {
        const summary = payload.summary;
        const compactedMessageCount = payload.compactedMessageCount;
        if (
          typeof summary === "string" &&
          typeof compactedMessageCount === "number" &&
          Number.isInteger(compactedMessageCount) &&
          compactedMessageCount >= state.compactedMessageCount &&
          compactedMessageCount <= state.messages.length
        ) {
          state.workingSummary = summary;
          state.compactedMessageCount = compactedMessageCount;
        }
      } else if (event.type === "tool_audit" && payload) {
        const entry = payload.entry as CommandAuditEntry | undefined;
        if (
          entry &&
          typeof entry.id === "string" &&
          !state.commands.some((command) => command.id === entry.id)
        ) {
          state.commands.push({ ...entry, args: [...entry.args] });
        }
      }
      state.updatedAt = event.timestamp;
    }

    if (!state) throw new Error(`Thread ${threadId} has no recoverable state`);
    if (state.threadId !== threadId) {
      throw new Error(`Recovered thread id ${state.threadId} does not match ${threadId}`);
    }
    return state;
  }

  private threadExists(threadId: string): boolean {
    return (
      this.storage.db
        .prepare<[string], { present: number }>(
          "SELECT 1 AS present FROM threads WHERE id = ?",
        )
        .get(threadId) !== undefined
    );
  }

  private reconcileProjection(
    state: SessionState,
    events: readonly EventRecord[],
    journalPath: string,
  ): void {
    this.storage.db.transaction(() => {
      this.projectRecoveredThread(state, events, journalPath);
    })();
  }

  private projectRecoveredThread(
    state: SessionState,
    events: readonly EventRecord[],
    journalPath: string,
  ): void {
    this.projectState(state, "active");
    for (const event of events) {
      this.projectEvent(event, journalPath);
      this.projectAuxiliaryEvent(state.threadId, event);
    }
    // Auxiliary events rebuild turn/audit rows. The recovered snapshot remains
    // authoritative for the thread's final mode and active-turn pointer.
    this.projectState(state, "active");
  }

  private projectAuxiliaryEvent(threadId: string, event: EventRecord): void {
    const payload = asPayloadRecord(event.payload);
    if (event.type === "turn_started" && event.turnId && payload) {
      if (isChatMessage(payload.message) && payload.message.role === "user") {
        this.projectTurnStarted(
          threadId,
          event.turnId,
          payload.message as UserChatMessage,
          event.timestamp,
        );
        this.storage.db
          .prepare("UPDATE threads SET active_turn_id = ? WHERE id = ?")
          .run(event.turnId, threadId);
      }
      return;
    }
    if (event.type === "message.user" && event.turnId && payload) {
      const message = isChatMessage(payload.message) && payload.message.role === "user"
        ? payload.message
        : typeof payload.content === "string"
          ? { role: "user" as const, content: payload.content }
          : undefined;
      if (message) {
        this.projectTurnStarted(
          threadId,
          event.turnId,
          message,
          event.timestamp,
        );
        this.storage.db
          .prepare("UPDATE threads SET active_turn_id = ? WHERE id = ?")
          .run(event.turnId, threadId);
      }
      return;
    }
    if (
      (event.type === "message.assistant" || event.type === "message.assistant.synthetic") &&
      event.turnId
    ) {
      if (isChatMessage(event.payload) && event.payload.role === "assistant") {
        this.projectTurnAssistant(
          threadId,
          event.turnId,
          event.payload,
          event.timestamp,
        );
      }
      return;
    }
    if (event.type === "turn.completed" && event.turnId) {
      const reason = typeof payload?.reason === "string" ? payload.reason : "success";
      this.projectRuntimeTurnCompleted(
        threadId,
        event.turnId,
        reason,
        event.timestamp,
      );
      this.storage.db
        .prepare("UPDATE threads SET active_turn_id = NULL WHERE id = ?")
        .run(threadId);
      return;
    }
    if (event.type === "turn_completed" && event.turnId && payload) {
      if (isChatMessage(payload.message) && payload.message.role === "assistant") {
        const reason = typeof payload.reason === "string" ? payload.reason : "success";
        this.projectTurnCompleted(
          threadId,
          event.turnId,
          payload.message,
          reason,
          event.timestamp,
        );
        this.storage.db
          .prepare("UPDATE threads SET active_turn_id = NULL WHERE id = ?")
          .run(threadId);
      }
      return;
    }
    if (event.type === "tool_audit" && payload) {
      const entry = payload.entry as CommandAuditEntry | undefined;
      if (entry && typeof entry.id === "string" && Array.isArray(entry.args)) {
        this.projectToolAudit(threadId, event.turnId, entry);
      }
    }
  }

  private projectTurnStarted(
    threadId: string,
    turnId: string,
    message: UserChatMessage,
    startedAt: string,
  ): void {
    this.storage.db
      .prepare(
        `INSERT INTO turns(
           id, thread_id, status, user_message_json, started_at
         ) VALUES (?, ?, 'active', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           user_message_json = COALESCE(turns.user_message_json, excluded.user_message_json),
           started_at = MIN(turns.started_at, excluded.started_at)`,
      )
      .run(turnId, threadId, serializeChatMessage(message), startedAt);
  }

  private projectTurnCompleted(
    threadId: string,
    turnId: string,
    message: Extract<ChatMessage, { role: "assistant" }>,
    reason: string,
    completedAt: string,
  ): void {
    this.storage.db
      .prepare(
        `INSERT INTO turns(
           id, thread_id, status, assistant_message_json, result_reason,
           started_at, completed_at
         ) VALUES (?, ?, 'completed', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = 'completed',
           assistant_message_json = excluded.assistant_message_json,
           result_reason = excluded.result_reason,
           completed_at = excluded.completed_at`,
      )
      .run(
        turnId,
        threadId,
        serializeChatMessage(message),
        reason,
        completedAt,
        completedAt,
      );
  }

  private projectTurnAssistant(
    threadId: string,
    turnId: string,
    message: Extract<ChatMessage, { role: "assistant" }>,
    timestamp: string,
  ): void {
    this.storage.db
      .prepare(
        `INSERT INTO turns(
           id, thread_id, status, assistant_message_json, started_at
         ) VALUES (?, ?, 'active', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           assistant_message_json = excluded.assistant_message_json`,
      )
      .run(turnId, threadId, serializeChatMessage(message), timestamp);
  }

  private projectRuntimeTurnCompleted(
    threadId: string,
    turnId: string,
    reason: string,
    completedAt: string,
  ): void {
    this.storage.db
      .prepare(
        `INSERT INTO turns(
           id, thread_id, status, result_reason, started_at, completed_at
         ) VALUES (?, ?, 'completed', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = 'completed',
           result_reason = excluded.result_reason,
           completed_at = excluded.completed_at`,
      )
      .run(turnId, threadId, reason, completedAt, completedAt);
  }

  private projectState(state: SessionState, status: string): void {
    this.storage.db
      .prepare(
        `INSERT INTO threads(
           id, workspace_root, workspace_id, mode, provider, model, goal,
           constraints_json, working_summary, active_turn_id, status,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_root = excluded.workspace_root,
           workspace_id = excluded.workspace_id,
           mode = excluded.mode,
           provider = excluded.provider,
           model = excluded.model,
           goal = excluded.goal,
           constraints_json = excluded.constraints_json,
           working_summary = excluded.working_summary,
           active_turn_id = excluded.active_turn_id,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.threadId,
        state.workspaceRoot,
        workspaceIdFromRoot(state.workspaceRoot),
        state.mode,
        state.provider,
        state.model,
        state.goal ?? null,
        JSON.stringify(state.constraints),
        state.workingSummary,
        state.activeTurnId ?? null,
        status,
        state.createdAt,
        state.updatedAt,
      );
  }

  private projectEvent(event: EventRecord, journalPath: string): void {
    this.storage.db
      .prepare(
        `INSERT INTO item_index(
           event_id, thread_id, turn_id, sequence, event_type, phase,
           timestamp, journal_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(
        event.eventId,
        event.threadId,
        event.turnId ?? null,
        event.sequence,
        event.type,
        event.phase ?? null,
        event.timestamp,
        journalPath,
      );
  }

  private projectToolAudit(
    threadId: string,
    turnId: string | undefined,
    entry: CommandAuditEntry,
  ): void {
    this.storage.db
      .prepare(
        `INSERT INTO tool_audit(
           id, thread_id, turn_id, program, args_json, cwd, status,
           exit_code, duration_ms, timestamp, summary
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           exit_code = excluded.exit_code,
           duration_ms = excluded.duration_ms,
           timestamp = excluded.timestamp,
           summary = excluded.summary`,
      )
      .run(
        entry.id,
        threadId,
        turnId ?? null,
        entry.program,
        JSON.stringify(entry.args),
        entry.cwd,
        entry.status,
        entry.exitCode,
        entry.durationMs,
        entry.timestamp,
        entry.summary,
      );
  }

  private touchThread(threadId: string, timestamp: string): void {
    this.storage.db
      .prepare("UPDATE threads SET updated_at = ? WHERE id = ?")
      .run(timestamp, threadId);
  }
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but this user cannot signal it. Treat all
    // ambiguous failures as alive so a lease is never stolen unsafely.
    return true;
  }
}

function assertValidThreadLease(lease: ThreadLease): void {
  if (!lease.threadId || lease.threadId.includes("\u0000")) {
    throw new Error("Invalid thread lease thread id");
  }
  if (!Number.isSafeInteger(lease.ownerPid) || lease.ownerPid <= 0) {
    throw new Error("Invalid thread lease owner PID");
  }
  if (
    !lease.ownerHostname ||
    lease.ownerHostname.length > 255 ||
    /[\u0000\r\n]/u.test(lease.ownerHostname)
  ) {
    throw new Error("Invalid thread lease owner hostname");
  }
  if (!/^thread_lease_[0-9a-f-]{36}$/iu.test(lease.ownerToken)) {
    throw new Error("Invalid thread lease ownership token");
  }
  if (!lease.acquiredAt || !Number.isFinite(Date.parse(lease.acquiredAt))) {
    throw new Error("Invalid thread lease acquisition time");
  }
}

function assertValidThreadLeaseRow(row: ThreadLeaseRow): void {
  assertValidThreadLease({
    threadId: row.thread_id,
    ownerPid: row.owner_pid,
    ownerHostname: row.owner_hostname,
    ownerToken: row.owner_token,
    acquiredAt: row.acquired_at,
  });
}
