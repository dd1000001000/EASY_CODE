import { hostname } from "node:os";

import {
  DEFAULT_THINKING_EFFORT,
  type AgentMode,
  type AgentRunResult,
  type ChatMessage,
  type CommandAuditEntry,
  type EventRecord,
  type FileChangeRecord,
  type PlanReviewState,
  type ProviderName,
  type SessionState,
  type SubagentAssignmentSnapshot,
  type SubagentTaskReport,
  type ThinkingEffort,
} from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { createId } from "../utils/ids.js";
import {
  cloneTaskGraph,
  subagentTaskOperationSchema,
  taskGraphOperationSchema,
  validateSubagentTaskTransition,
  validateTaskGraphTransition,
} from "../tasks/task-graph.js";
import { EventJournal, type AppendEventInput } from "./event-journal.js";
import {
  deserializeSessionState,
  isChatMessage,
  isPlanReviewState,
  serializeChatMessage,
  serializeSessionState,
} from "./serialization.js";
import {
  clonePlanReviewState,
  returnPlanExecutionToReview,
  type PlanExecutionReturnOutcome,
} from "../plans/plan.js";

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

export interface DurableSubagentResult {
  readonly agentId: string;
  readonly taskId: string;
  readonly reason: "completed" | "blocked" | "failed" | "stopped" | "interrupted";
  readonly report?: SubagentTaskReport;
  readonly error?: string;
  readonly timestamp: string;
}

export interface DurableStandaloneAssignment {
  readonly assignment: Extract<SubagentAssignmentSnapshot, { kind: "standalone" }>;
  readonly createdByTurnId: string;
  readonly observed: boolean;
}

export const INTERRUPTED_TURN_ASSISTANT_MESSAGE =
  "The previous EASY CODE process exited before this turn completed; the turn has been marked as interrupted.";

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

function standaloneAssignment(
  value: unknown,
): Extract<SubagentAssignmentSnapshot, { kind: "standalone" }> | undefined {
  const input = asPayloadRecord(value);
  if (
    input?.kind !== "standalone" ||
    typeof input.agentId !== "string" ||
    !input.agentId ||
    typeof input.taskId !== "string" ||
    !input.taskId ||
    typeof input.taskTitle !== "string" ||
    !input.taskTitle ||
    typeof input.taskDescription !== "string" ||
    !input.taskDescription ||
    !Array.isArray(input.completionChecks) ||
    input.completionChecks.length === 0 ||
    !input.completionChecks.every((check) => typeof check === "string" && check.length > 0) ||
    (input.provider !== "qwen" && input.provider !== "deepseek" && input.provider !== "glm") ||
    typeof input.model !== "string" ||
    !input.model ||
    (input.thinkingEffort !== "none" &&
      input.thinkingEffort !== "low" &&
      input.thinkingEffort !== "medium" &&
      input.thinkingEffort !== "high") ||
    typeof input.createdAt !== "string" ||
    !input.createdAt
  ) {
    return undefined;
  }
  return {
    kind: "standalone",
    agentId: input.agentId,
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    taskDescription: input.taskDescription,
    completionChecks: [...input.completionChecks] as string[],
    provider: input.provider,
    model: input.model,
    thinkingEffort: input.thinkingEffort,
    createdAt: input.createdAt,
  };
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return JSON.parse(serializeChatMessage(message)) as ChatMessage;
}

function appendMessageIfNew(state: SessionState, message: ChatMessage): void {
  const previous = state.messages[state.messages.length - 1];
  if (previous && serializeChatMessage(previous) === serializeChatMessage(message)) return;
  state.messages.push(cloneMessage(message));
}

function messagePrefix(
  prefix: readonly ChatMessage[],
  messages: readonly ChatMessage[],
): boolean {
  if (prefix.length > messages.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (JSON.stringify(prefix[index]) !== JSON.stringify(messages[index])) return false;
  }
  return true;
}

function validateInterruptedTurnRecovery(
  state: Readonly<SessionState>,
  event: Pick<EventRecord, "eventId" | "turnId">,
  payload: Record<string, unknown>,
  expectedPlanReview: Readonly<PlanReviewState> | undefined,
): void {
  if (!event.turnId || state.activeTurnId !== event.turnId) {
    throw new Error(`Turn recovery ${event.eventId} does not target the active turn`);
  }
  if (payload.reason !== "interrupted" || payload.recovered !== true || payload.steps !== 0) {
    throw new Error(`Turn recovery ${event.eventId} has invalid terminal metadata`);
  }
  if (!Array.isArray(payload.messages) || !payload.messages.every(isChatMessage)) {
    throw new Error(`Turn recovery ${event.eventId} has invalid messages`);
  }

  const latestToolCallMessage = [...state.messages].reverse().find(
    (message): message is Extract<ChatMessage, { role: "assistant" }> =>
      message.role === "assistant" && Boolean(message.tool_calls?.length),
  );
  const latestToolCallIndex = latestToolCallMessage
    ? state.messages.lastIndexOf(latestToolCallMessage)
    : -1;
  const completedCallIds = new Set(
    state.messages
      .slice(latestToolCallIndex + 1)
      .filter((message): message is Extract<ChatMessage, { role: "tool" }> =>
        message.role === "tool")
      .map((message) => message.tool_call_id),
  );
  const missingCalls = (latestToolCallMessage?.tool_calls ?? []).filter(
    (call) => !completedCallIds.has(call.id),
  );
  const toolMessages = payload.messages.filter(
    (message): message is Extract<ChatMessage, { role: "tool" }> => message.role === "tool",
  );
  if (toolMessages.length !== missingCalls.length) {
    throw new Error(`Turn recovery ${event.eventId} did not cover the exact missing tool calls`);
  }
  for (let index = 0; index < missingCalls.length; index += 1) {
    const call = missingCalls[index];
    const message = toolMessages[index];
    let content: unknown;
    try {
      content = message ? JSON.parse(message.content) : undefined;
    } catch {
      throw new Error(`Turn recovery ${event.eventId} has invalid tool-result JSON`);
    }
    const result = asPayloadRecord(content);
    if (
      !call ||
      !message ||
      message.tool_call_id !== call.id ||
      message.name !== call.function.name ||
      result?.ok !== false ||
      result.error !== "interrupted"
    ) {
      throw new Error(`Turn recovery ${event.eventId} changed a missing tool call`);
    }
  }

  const assistantMessages = payload.messages.filter(
    (message): message is Extract<ChatMessage, { role: "assistant" }> =>
      message.role === "assistant",
  );
  const lastMessage = state.messages[state.messages.length - 1];
  const durableFinalAssistant = Boolean(
    lastMessage?.role === "assistant" &&
    lastMessage.content?.trim() &&
    !lastMessage.tool_calls?.length,
  );
  if (durableFinalAssistant) {
    if (assistantMessages.length !== 0) {
      throw new Error(`Turn recovery ${event.eventId} duplicated a durable final assistant`);
    }
  } else if (
    assistantMessages.length !== 1 ||
    assistantMessages[0]?.content !== INTERRUPTED_TURN_ASSISTANT_MESSAGE ||
    assistantMessages[0].tool_calls?.length
  ) {
    throw new Error(`Turn recovery ${event.eventId} has an invalid interruption marker`);
  }

  if (
    JSON.stringify(payload.planReview) !== JSON.stringify(expectedPlanReview)
  ) {
    throw new Error(`Turn recovery ${event.eventId} has invalid plan provenance`);
  }
}

function planExecutionReturnOutcome(
  value: unknown,
): PlanExecutionReturnOutcome | undefined {
  return value === "failed" || value === "interrupted" || value === "limit_reached"
    ? value
    : undefined;
}

function validatePlanExecutionReturnedToReview(
  state: Readonly<SessionState>,
  event: Pick<EventRecord, "eventId" | "turnId" | "phase">,
  payload: Record<string, unknown>,
  executingReview: Readonly<PlanReviewState> | undefined,
): PlanReviewState {
  const outcome = planExecutionReturnOutcome(payload.outcome);
  if (
    event.phase !== "completed" ||
    !event.turnId ||
    state.activeTurnId !== event.turnId ||
    state.planReview !== undefined ||
    !executingReview ||
    !outcome
  ) {
    throw new Error(
      `Invalid approved-plan execution recovery in event ${event.eventId}`,
    );
  }
  const expected = returnPlanExecutionToReview(executingReview, outcome);
  if (
    payload.planId !== expected.proposal.id ||
    payload.revision !== expected.proposal.revision ||
    !isPlanReviewState(payload.planReview) ||
    JSON.stringify(payload.planReview) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `Approved-plan execution recovery ${event.eventId} changed the reviewed proposal`,
    );
  }
  return expected;
}

function fileChangeKey(change: Readonly<FileChangeRecord>): string {
  return [
    change.timestamp,
    change.path,
    change.operation,
    change.beforeHash ?? "",
    change.afterHash ?? "",
  ].join("|");
}

function mergeFileChanges(
  target: FileChangeRecord[],
  additions: readonly FileChangeRecord[],
): void {
  const known = new Set(target.map(fileChangeKey));
  for (const change of additions) {
    const key = fileChangeKey(change);
    if (known.has(key)) continue;
    target.push({ ...change });
    known.add(key);
  }
}

function mergeCommandAudits(
  target: CommandAuditEntry[],
  additions: readonly CommandAuditEntry[],
): void {
  const known = new Set(target.map((entry) => entry.id));
  for (const entry of additions) {
    if (known.has(entry.id)) continue;
    target.push({ ...entry, args: [...entry.args] });
    known.add(entry.id);
  }
}

function artifactPayload(payload: Record<string, unknown>): {
  changes: FileChangeRecord[];
  commands: CommandAuditEntry[];
} {
  const changes = payload.changes;
  const commands = payload.commands;
  if (!Array.isArray(changes) || !Array.isArray(commands)) {
    throw new Error("Invalid subagent artifact event payload");
  }
  for (const change of changes) {
    if (
      change === null ||
      typeof change !== "object" ||
      typeof (change as Partial<FileChangeRecord>).path !== "string" ||
      typeof (change as Partial<FileChangeRecord>).timestamp !== "string"
    ) {
      throw new Error("Invalid subagent file-change record");
    }
  }
  for (const command of commands) {
    if (
      command === null ||
      typeof command !== "object" ||
      typeof (command as Partial<CommandAuditEntry>).id !== "string" ||
      !Array.isArray((command as Partial<CommandAuditEntry>).args)
    ) {
      throw new Error("Invalid subagent command-audit record");
    }
  }
  return {
    changes: changes.map((change) => ({ ...(change as FileChangeRecord) })),
    commands: commands.map((command) => ({
      ...(command as CommandAuditEntry),
      args: [...(command as CommandAuditEntry).args],
    })),
  };
}

/** Locate a saved Thread without opening SQLite or mutating its projections. */
export function peekThreadWorkspaceRoot(dataDir: string, threadId: string): string {
  const events = new EventJournal(dataDir, threadId, { createDirectory: false }).read();
  const created = events.find((event) => event.type === "thread_created");
  const payload = created ? asPayloadRecord(created.payload) : undefined;
  if (!payload || !("state" in payload)) {
    throw new Error(`Thread not found: ${threadId}`);
  }
  const state = deserializeSessionState(payload.state);
  if (state.threadId !== threadId) {
    throw new Error(`Thread creation snapshot belongs to ${state.threadId}, expected ${threadId}`);
  }
  return state.workspaceRoot;
}

/** Stores thread metadata as SQLite projections and recovers state from JSONL. */
export class ThreadStore {
  constructor(private readonly storage: EasyCodeStorage) {}

  /** Read only the creation snapshot needed to locate a Thread's workspace. */
  peekWorkspaceRoot(threadId: string): string {
    return peekThreadWorkspaceRoot(this.storage.dataDir, threadId);
  }

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
      ...(state.taskGraph ? { taskGraph: cloneTaskGraph(state.taskGraph) } : {}),
      ...(state.planReview ? { planReview: clonePlanReviewState(state.planReview) } : {}),
    };
    state.updatedAt = snapshot.updatedAt;

    let checkpointEvent: EventRecord | undefined;
    try {
      this.storage.db.transaction(() => {
        if (journal.read().length === 0 || !this.threadExists(state.threadId)) {
          throw new Error(`Cannot save unknown thread: ${state.threadId}`);
        }
        checkpointEvent = journal.append({
          type: "thread_checkpoint",
          payload: { state: serializeSessionState(snapshot) },
          turnId: snapshot.activeTurnId,
        });
        this.projectState(snapshot, "active");
        this.projectEvent(checkpointEvent, journal.filePath);
        for (const command of snapshot.commands) {
          this.projectToolAudit(snapshot.threadId, snapshot.activeTurnId, command);
        }
      })();
    } catch (error) {
      if (!checkpointEvent) throw error;
      const committed = journal.read().some(
        (candidate) => candidate.eventId === checkpointEvent?.eventId,
      );
      if (!committed) throw error;
      try {
        const events = journal.read();
        const recovered = this.recoverFromEvents(state.threadId, events);
        this.reconcileProjection(recovered, events, journal.filePath);
      } catch {
        // The checkpoint is durable; a later get/recover retries projection.
      }
    }
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
    let event: EventRecord | undefined;
    try {
      this.storage.db.transaction(() => {
        if (!this.threadExists(threadId)) throw new Error(`Thread not found: ${threadId}`);
        const priorEvents = journal.read();
        if (priorEvents.length === 0) throw new Error(`Thread not found: ${threadId}`);
        const payload = asPayloadRecord(input.payload);
        if (payload && "taskGraph" in payload) {
          const priorState = this.recoverFromEvents(threadId, priorEvents);
          this.replayTaskGraphResult(
            priorState,
            {
              type: input.type,
              phase: input.phase,
              turnId: input.turnId,
              eventId: input.eventId ?? "pending_tool_result",
            },
            payload,
          );
        }
        if (payload && input.type === "plan.execution_returned_to_review") {
          const priorState = this.recoverFromEvents(threadId, priorEvents);
          validatePlanExecutionReturnedToReview(
            priorState,
            {
              eventId: input.eventId ?? "pending_plan_execution_recovery",
              turnId: input.turnId,
              phase: input.phase,
            },
            payload,
            input.turnId
              ? this.approvedPlanExecution(threadId, input.turnId)
              : undefined,
          );
        } else if (
          payload &&
          ((input.type === "tool.result" && "planReview" in payload) ||
            input.type === "plan.approved" ||
            input.type === "plan.rejected" ||
            input.type === "plan.feedback_submitted" ||
            input.type === "plan.execution_started")
        ) {
          const priorState = this.recoverFromEvents(threadId, priorEvents);
          this.replayPlanReviewEvent(priorState, {
            eventId: input.eventId ?? "pending_plan_event",
            timestamp: input.timestamp ?? new Date().toISOString(),
            type: input.type,
            turnId: input.turnId,
            phase: input.phase,
          }, payload);
        }
        if (input.type === "turn.recovered") {
          if (!payload || !input.turnId) {
            throw new Error("Interrupted-turn recovery requires a payload and turn ID");
          }
          const priorState = this.recoverFromEvents(threadId, priorEvents);
          validateInterruptedTurnRecovery(
            priorState,
            {
              eventId: input.eventId ?? "pending_turn_recovery",
              turnId: input.turnId,
            },
            payload,
            this.interruptedPlanReview(threadId, input.turnId),
          );
        }
        // Keep append inside the database write transaction: its cross-process
        // lock serializes EventJournal's scan/sequence/append critical section.
        event = journal.append(input);
        this.projectEvent(event, journal.filePath);
        this.projectAuxiliaryEvent(threadId, event);
        this.touchThread(threadId, event.timestamp);
      })();
    } catch (error) {
      // The fsynced JSONL journal is the source of truth. SQLite cannot roll it
      // back, so a projection error after append is still a committed event.
      if (!event) throw error;
      const committed = journal.read().find((candidate) => candidate.eventId === event?.eventId);
      if (!committed) throw error;
      try {
        const events = journal.read();
        const recovered = this.recoverFromEvents(threadId, events);
        this.reconcileProjection(recovered, events, journal.filePath);
      } catch {
        // Recovery on the next get/recover call retries this derived projection.
      }
      return committed;
    }
    if (!event) throw new Error("Thread event append did not produce a durable event");
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

  recordSubagentArtifacts(
    threadId: string,
    turnId: string | undefined,
    input: {
      agentId: string;
      taskId: string;
      changes: readonly FileChangeRecord[];
      commands: readonly CommandAuditEntry[];
    },
  ): EventRecord {
    return this.appendEvent(threadId, {
      type: "subagent.artifact",
      turnId,
      phase: "completed",
      payload: {
        agentId: input.agentId,
        taskId: input.taskId,
        changes: input.changes.map((change) => ({ ...change })),
        commands: input.commands.map((command) => ({
          ...command,
          args: [...command.args],
        })),
      },
    });
  }

  recordSubagentResult(
    threadId: string,
    turnId: string | undefined,
    input: Omit<DurableSubagentResult, "timestamp">,
  ): EventRecord {
    return this.appendEvent(threadId, {
      type: "subagent.result",
      turnId,
      phase: input.reason === "completed" ? "completed" : "failed",
      payload: {
        agentId: input.agentId,
        taskId: input.taskId,
        reason: input.reason,
        ...(input.report
          ? { report: JSON.parse(JSON.stringify(input.report)) as SubagentTaskReport }
          : {}),
        ...(input.error ? { error: input.error } : {}),
      },
    });
  }

  latestSubagentResult(
    threadId: string,
    agentId: string,
    taskId: string,
  ): DurableSubagentResult | undefined {
    const events = this.journal(threadId).read();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "subagent.result") continue;
      const payload = asPayloadRecord(event.payload);
      if (
        !payload ||
        payload.agentId !== agentId ||
        payload.taskId !== taskId ||
        (payload.reason !== "completed" &&
          payload.reason !== "blocked" &&
          payload.reason !== "failed" &&
          payload.reason !== "stopped" &&
          payload.reason !== "interrupted")
      ) {
        continue;
      }
      return {
        agentId,
        taskId,
        reason: payload.reason,
        ...(payload.report
          ? {
              report: JSON.parse(JSON.stringify(payload.report)) as SubagentTaskReport,
            }
          : {}),
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
        timestamp: event.timestamp,
      };
    }
    return undefined;
  }

  /** Rebuild standalone child bindings that still need a parent observation. */
  unobservedStandaloneAssignments(
    threadId: string,
  ): readonly DurableStandaloneAssignment[] {
    const assignments = new Map<string, DurableStandaloneAssignment>();
    for (const event of this.journal(threadId).read()) {
      if (event.type !== "tool.result" || event.phase !== "completed") continue;
      const payload = asPayloadRecord(event.payload);
      const lifecycle = asPayloadRecord(payload?.subagentLifecycle);
      if (payload?.tool !== "manage_subagents" || !lifecycle) continue;
      if (lifecycle.action === "activate") {
        const rawAssignment = asPayloadRecord(payload.subagentAssignment);
        if (rawAssignment?.kind === "dag") {
          // DAG bindings are reconciled from the authoritative task-graph
          // transition and must never enter standalone recovery.
          continue;
        }
        const assignment = standaloneAssignment(payload.subagentAssignment);
        if (!assignment || assignment.agentId !== lifecycle.agentId || !event.turnId) {
          // Legacy DAG activations have no standalone descriptor and remain
          // governed by task-graph recovery.
          if (payload.subagentAssignment === undefined) continue;
          throw new Error(`Invalid standalone child activation in event ${event.eventId}`);
        }
        const existing = assignments.get(assignment.agentId);
        if (existing) {
          throw new Error(`Duplicate standalone child activation for ${assignment.agentId}`);
        }
        assignments.set(assignment.agentId, {
          assignment,
          createdByTurnId: event.turnId,
          observed: false,
        });
        continue;
      }
      if (lifecycle.action === "observe") {
        const assignment = standaloneAssignment(payload.subagentAssignment);
        if (!assignment) continue;
        const existing = assignments.get(assignment.agentId);
        if (
          !existing ||
          assignment.agentId !== lifecycle.agentId ||
          assignment.taskId !== existing.assignment.taskId ||
          assignment.createdAt !== existing.assignment.createdAt
        ) {
          throw new Error(`Invalid standalone child observation in event ${event.eventId}`);
        }
        assignments.set(assignment.agentId, { ...existing, observed: true });
      }
    }
    return [...assignments.values()]
      .filter((entry) => !entry.observed)
      .map((entry) => ({
        ...entry,
        assignment: {
          ...entry.assignment,
          completionChecks: [...entry.assignment.completionChecks],
        },
      }));
  }

  hasCommittedSubagentStop(threadId: string, agentId: string): boolean {
    return this.journal(threadId).read().some((event) => {
      if (event.type !== "tool.result" || event.phase !== "completed") return false;
      const payload = asPayloadRecord(event.payload);
      const lifecycle = asPayloadRecord(payload?.subagentLifecycle);
      return (
        payload?.tool === "manage_subagents" &&
        lifecycle?.action === "request_stop" &&
        lifecycle.agentId === agentId
      );
    });
  }

  /** Recover the approved proposal whose execution was interrupted in this Turn. */
  interruptedPlanReview(
    threadId: string,
    turnId: string,
  ): PlanReviewState | undefined {
    const review = this.approvedPlanExecution(threadId, turnId);
    return review
      ? returnPlanExecutionToReview(review, "interrupted")
      : undefined;
  }

  /** Locate the still-unresolved approval consumed by an execution turn. */
  private approvedPlanExecution(
    threadId: string,
    turnId: string,
  ): PlanReviewState | undefined {
    const events = this.journal(threadId).read();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.turnId !== turnId) continue;
      if (event.type === "plan.execution_returned_to_review") return undefined;
      if (event.type !== "plan.execution_started") continue;
      const payload = asPayloadRecord(event.payload);
      if (!payload) return undefined;
      const before = this.recoverFromEvents(threadId, events.slice(0, index));
      const review = before.planReview;
      if (
        review?.status !== "approved_pending_execution" ||
        payload.planId !== review.proposal.id ||
        payload.revision !== review.proposal.revision
      ) {
        return undefined;
      }
      return clonePlanReviewState(review);
    }
    return undefined;
  }

  /** True when the model's terminal assistant reply was durable but turn completion was not. */
  hasDurableFinalAssistant(threadId: string, turnId: string): boolean {
    const events = this.journal(threadId).read();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.turnId !== turnId) continue;
      if (
        event.type === "thread_checkpoint" ||
        event.type === "subagent.artifact" ||
        event.type === "subagent.result" ||
        event.type === "tool_audit"
      ) {
        continue;
      }
      if (
        event.type !== "message.assistant" &&
        event.type !== "message.assistant.synthetic"
      ) {
        return false;
      }
      if (
        (event.phase !== undefined && event.phase !== "completed") ||
        !isChatMessage(event.payload) ||
        event.payload.role !== "assistant"
      ) {
        return false;
      }
      return Boolean(event.payload.content?.trim()) && !event.payload.tool_calls?.length;
    }
    return false;
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
    const interruptedPlanExecutions = new Map<string, PlanReviewState>();
    for (const event of events) {
      const payload = asPayloadRecord(event.payload);
      if (event.type === "thread_created" || event.type === "thread_checkpoint") {
        if (!payload || !("state" in payload)) {
          throw new Error(`Missing state in ${event.type} event`);
        }
        const checkpoint = deserializeSessionState(payload.state);
        if (event.type === "thread_checkpoint" && state) {
          // Messages and the active-turn pointer advance through journal events.
          // A derived checkpoint may add a legacy tail, but it must never erase
          // or fork an event-replayed prefix.
          if (messagePrefix(checkpoint.messages, state.messages)) {
            checkpoint.messages = state.messages.map(cloneMessage);
            checkpoint.goal = state.goal;
          } else if (!messagePrefix(state.messages, checkpoint.messages)) {
            throw new Error(
              `Thread checkpoint ${event.eventId} diverged from durable message history`,
            );
          }
          checkpoint.activeTurnId = state.activeTurnId;
          if (state.taskGraph) {
            // Checkpoints are derived snapshots. Only replayed model DAG or
            // Runtime-owned subagent transitions may advance the authority.
            checkpoint.taskGraph = cloneTaskGraph(state.taskGraph);
          } else if (checkpoint.taskGraph) {
            throw new Error(
              `Thread checkpoint ${event.eventId} introduced a task DAG without a legal transition`,
            );
          }
          if (state.planReview) {
            checkpoint.planReview = clonePlanReviewState(state.planReview);
          } else if (checkpoint.planReview) {
            throw new Error(
              `Thread checkpoint ${event.eventId} introduced a plan review without a legal event`,
            );
          }
          // Context compaction is an event-authoritative monotonic boundary.
          // A checkpoint may have been serialized before a background append;
          // never let that derived snapshot expand already-compacted history.
          if (state.compactedMessageCount >= checkpoint.compactedMessageCount) {
            if (state.compactedMessageCount > checkpoint.messages.length) {
              checkpoint.messages = state.messages.map(cloneMessage);
            }
            checkpoint.workingSummary = state.workingSummary;
            checkpoint.compactedMessageCount = state.compactedMessageCount;
          }
          // A background child can append artifacts between the caller taking
          // its checkpoint snapshot and the checkpoint append. Durable
          // side-effect/audit events must never be erased by that stale view.
          mergeFileChanges(checkpoint.changes, state.changes);
          mergeCommandAudits(checkpoint.commands, state.commands);
        }
        state = checkpoint;
        continue;
      }
      if (!state) throw new Error(`Thread ${threadId} has no creation event`);

      if (event.type === "turn_started") {
        state.activeTurnId = event.turnId;
        if (payload && isChatMessage(payload.message) && payload.message.role === "user") {
          appendMessageIfNew(state, payload.message);
          if (payload.message.content.trim()) state.goal = payload.message.content;
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
          if (payload.message.content.trim()) state.goal = payload.message.content;
        } else if (typeof payload?.content === "string") {
          state.activeTurnId = event.turnId;
          appendMessageIfNew(state, { role: "user", content: payload.content });
          if (payload.content.trim()) state.goal = payload.content;
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
        if ("taskGraph" in payload) {
          state.taskGraph = this.replayTaskGraphResult(state, event, payload);
        }
        if ("planReview" in payload) {
          this.replayPlanReviewEvent(state, event, payload);
        }
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
      } else if (event.type === "subagent.recovery" && payload && "taskGraph" in payload) {
        state.taskGraph = this.replayTaskGraphResult(state, event, payload);
      } else if (event.type === "subagent.artifact" && payload) {
        const artifacts = artifactPayload(payload);
        mergeFileChanges(state.changes, artifacts.changes);
        mergeCommandAudits(state.commands, artifacts.commands);
      } else if (event.type === "turn.recovered" && payload && event.turnId) {
        const interruptedExecution = interruptedPlanExecutions.get(event.turnId);
        const expectedPlanReview = interruptedExecution
          ? returnPlanExecutionToReview(interruptedExecution, "interrupted")
          : undefined;
        validateInterruptedTurnRecovery(state, event, payload, expectedPlanReview);
        for (const message of payload.messages as ChatMessage[]) {
          if (message.role !== "tool" && message.role !== "assistant") {
            throw new Error(`Invalid recovery message role in event ${event.eventId}`);
          }
          appendMessageIfNew(state, message);
        }
        if (payload.planReview !== undefined) {
          if (!isPlanReviewState(payload.planReview)) {
            throw new Error(`Invalid recovered plan review in event ${event.eventId}`);
          }
          state.planReview = clonePlanReviewState(payload.planReview);
        }
        interruptedPlanExecutions.delete(event.turnId);
        state.activeTurnId = undefined;
      } else if (
        event.type === "plan.execution_returned_to_review" &&
        payload &&
        event.turnId
      ) {
        state.planReview = validatePlanExecutionReturnedToReview(
          state,
          event,
          payload,
          interruptedPlanExecutions.get(event.turnId),
        );
        interruptedPlanExecutions.delete(event.turnId);
      } else if (
        (event.type === "plan.approved" ||
          event.type === "plan.rejected" ||
          event.type === "plan.feedback_submitted" ||
          event.type === "plan.execution_started") &&
        payload
      ) {
        if (
          event.type === "plan.execution_started" &&
          event.turnId &&
          state.planReview?.status === "approved_pending_execution"
        ) {
          interruptedPlanExecutions.set(
            event.turnId,
            clonePlanReviewState(state.planReview),
          );
        }
        this.replayPlanReviewEvent(state, event, payload);
        if (isChatMessage(payload.message) && payload.message.role === "user") {
          appendMessageIfNew(state, payload.message);
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

  private replayTaskGraphResult(
    state: Readonly<SessionState>,
    event: Pick<EventRecord, "type" | "phase" | "turnId" | "eventId">,
    payload: Record<string, unknown>,
  ): NonNullable<SessionState["taskGraph"]> {
    if (
      (event.type !== "tool.result" && event.type !== "subagent.recovery") ||
      event.phase !== "completed" ||
      typeof event.turnId !== "string" ||
      !event.turnId ||
      (event.type === "tool.result" &&
        payload.tool !== "manage_tasks" &&
        payload.tool !== "manage_subagents")
    ) {
      throw new Error(`Invalid task DAG source in tool.result event ${event.eventId}`);
    }
    try {
      if (payload.tool === "manage_tasks" && "taskGraphOperation" in payload) {
        const parsed = taskGraphOperationSchema.safeParse(payload.taskGraphOperation);
        if (!parsed.success || parsed.data.action === "list") {
          throw new Error("Invalid model task DAG operation");
        }
        return validateTaskGraphTransition(
          state.taskGraph,
          parsed.data,
          payload.taskGraph,
          event.turnId,
        );
      }
      if (
        (payload.tool === "manage_subagents" || event.type === "subagent.recovery") &&
        "subagentTaskOperation" in payload
      ) {
        const parsed = subagentTaskOperationSchema.parse(payload.subagentTaskOperation);
        return validateSubagentTaskTransition(
          state.taskGraph,
          parsed,
          payload.taskGraph,
          event.turnId,
        );
      }
      throw new Error("The event did not declare an authorized task DAG transition");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid task DAG transition in tool.result event ${event.eventId}: ${message}`);
    }
  }

  private replayPlanReviewEvent(
    state: SessionState,
    event: Pick<EventRecord, "eventId" | "timestamp" | "type" | "turnId" | "phase">,
    payload: Record<string, unknown>,
  ): void {
    if (event.type === "tool.result") {
      if (
        event.phase !== "completed" ||
        payload.tool !== "propose_plan" ||
        !isPlanReviewState(payload.planReview) ||
        payload.planReview.status !== "awaiting_review" ||
        !event.turnId ||
        payload.planReview.proposal.proposedByTurnId !== event.turnId
      ) {
        throw new Error(`Invalid plan proposal source in tool.result event ${event.eventId}`);
      }
      const previous = state.planReview?.proposal;
      const next = payload.planReview.proposal;
      if (previous) {
        if (
          state.planReview?.status !== "awaiting_review" ||
          next.id !== previous.id ||
          next.revision !== previous.revision + 1
        ) {
          throw new Error(`Invalid plan revision in tool.result event ${event.eventId}`);
        }
      } else if (next.revision !== 1) {
        throw new Error(`Initial plan proposal must use revision 1 in event ${event.eventId}`);
      }
      state.planReview = clonePlanReviewState(payload.planReview);
      return;
    }

    const current = state.planReview;
    const planId = payload.planId;
    const revision = payload.revision;
    if (
      !current ||
      typeof planId !== "string" ||
      !Number.isInteger(revision) ||
      current.proposal.id !== planId ||
      current.proposal.revision !== revision
    ) {
      throw new Error(`Plan review event ${event.eventId} does not match the pending proposal`);
    }

    if (event.type === "plan.feedback_submitted") {
      if (current.status !== "awaiting_review") {
        throw new Error(`Cannot adjust an approved plan in event ${event.eventId}`);
      }
      const feedback = payload.feedback;
      if (
        typeof feedback !== "string" ||
        feedback.trim().length === 0 ||
        feedback.length > 4_000 ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(feedback)
      ) {
        throw new Error(`Invalid plan feedback in event ${event.eventId}`);
      }
      state.planReview = {
        ...clonePlanReviewState(current),
        feedback,
      };
      return;
    }

    if (event.type === "plan.approved") {
      if (current.status !== "awaiting_review") {
        throw new Error(`Plan ${planId} was already approved in event ${event.eventId}`);
      }
      state.planReview = {
        ...clonePlanReviewState(current),
        status: "approved_pending_execution",
        approvedAt: event.timestamp,
      };
      return;
    }

    if (event.type === "plan.rejected") {
      if (current.status !== "awaiting_review") {
        throw new Error(`Cannot reject an approved plan in event ${event.eventId}`);
      }
      state.planReview = undefined;
      return;
    }

    if (event.type === "plan.execution_started") {
      if (current.status !== "approved_pending_execution") {
        throw new Error(`Cannot execute an unapproved plan in event ${event.eventId}`);
      }
      state.planReview = undefined;
      return;
    }

    throw new Error(`Unsupported plan review event ${event.type}`);
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
    if (event.type === "turn.recovered" && event.turnId && payload) {
      const messages = Array.isArray(payload.messages)
        ? payload.messages.filter(isChatMessage)
        : [];
      const assistant = [...messages].reverse().find(
        (message): message is Extract<ChatMessage, { role: "assistant" }> =>
          message.role === "assistant",
      );
      if (assistant) {
        this.projectTurnCompleted(
          threadId,
          event.turnId,
          assistant,
          "interrupted",
          event.timestamp,
        );
      } else {
        this.projectRuntimeTurnCompleted(
          threadId,
          event.turnId,
          "interrupted",
          event.timestamp,
        );
      }
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
      return;
    }
    if (event.type === "subagent.artifact" && payload) {
      const artifacts = artifactPayload(payload);
      for (const entry of artifacts.commands) {
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
           exit_code, duration_ms, timestamp, summary, source_agent_role,
           source_agent_id, source_task_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           exit_code = excluded.exit_code,
           duration_ms = excluded.duration_ms,
           timestamp = excluded.timestamp,
           summary = excluded.summary,
           source_agent_role = excluded.source_agent_role,
           source_agent_id = excluded.source_agent_id,
           source_task_id = excluded.source_task_id`,
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
        entry.sourceAgentRole ?? null,
        entry.sourceAgentId ?? null,
        entry.sourceTaskId ?? null,
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
