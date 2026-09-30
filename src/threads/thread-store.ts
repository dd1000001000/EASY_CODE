import { hostname } from "node:os";
import { CoordinationStore } from "../coordination/store.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import {
  currentProcessIdentity,
  processOwnerState,
  validProcessIdentity,
  type ProcessIdentity,
} from "../core/process-owner.js";

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
  type PromptBundleBinding,
  type ExecutionEnvironmentSnapshot,
  type ResultArtifact,
  type TurnSteeringBatch,
  type TurnSteeringEntry,
} from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { ACTIVE_MODEL_REGISTRY_HASH } from "../models/catalog.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { createId } from "../utils/ids.js";
import { aggregateModelUsage, parseModelUsageRecord, type ModelUsageSummary } from "../usage/model-usage.js";
import { cloneTaskGraph } from "../tasks/task-graph.js";
import { EventJournal, type AppendEventInput } from "./event-journal.js";
import { deserializeSessionState, isChatMessage, serializeSessionState } from "./serialization.js";
import { CURRENT_PROTOCOL } from "../protocol/versions.js";
import { clonePlanReviewState, returnPlanExecutionToReview } from "../plans/plan.js";
import { isExecutionEnvironmentSnapshot, isResultArtifact } from "../workspace/execution-environment.js";
import { grantCommandApprovalPrefix, normalizeCommandApprovalPrefix } from "../command/approval.js";
import { activePromptBundleBinding } from "../prompt-bundle/index.js";
import { createProgressGuardState, foldProgressHint } from "../progress/guard.js";
import { parseProgressObservation } from "../progress/observation.js";
import { validateToolApprovalGrants } from "../tools/approval.js";
import { cloneMessage, asPayloadRecord } from "./event-values.js";
import {
  cloneSteeringEntry,
  type UserChatMessage,
  cloneUserMessage,
  mergeTurnSteeringEntries,
} from "./steering-entries.js";
import {
  createThreadCheckpointDelta,
  threadCheckpointDeltaHasChanges,
  applyThreadCheckpointDelta,
} from "./checkpoint-delta.js";
import { subagentAssignment, sameSubagentAssignmentIdentity } from "./subagent-assignment.js";
import {
  recoverFromEvents,
  foldAutoRouteSelection,
  replaySteeringEvent,
  replayTaskGraphResult,
  validatePlanExecutionReturnedToReview,
  replayPlanReviewEvent,
  validateInterruptedTurnRecovery,
} from "./event-replay.js";
import { ThreadProjection } from "./thread-projection.js";

export interface ThreadCreateInput {
  readonly threadId?: string;
  readonly workspaceRoot: string;
  readonly projectId?: string;
  readonly workspaceRevision?: number;
  readonly workspaceFolders?: Array<{ id: string; key: string; path: string }>;
  readonly primaryWorkspaceFolderId?: string;
  readonly mode: AgentMode;
  readonly provider: ProviderName;
  readonly model: string;
  readonly orchestrationEnabled?: boolean;
  readonly thinkingEffort?: ThinkingEffort;
  readonly promptBundle?: PromptBundleBinding;
  readonly modelRegistryHash?: string;
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
  readonly ownerProcessIdentity?: ProcessIdentity;
}

export interface DurableSubagentResult {
  readonly agentId: string;
  readonly taskId: string;
  readonly reason: "completed" | "blocked" | "needs_parent_decision" | "failed" | "stopped" | "interrupted";
  readonly report?: SubagentTaskReport;
  readonly error?: string;
  readonly environment?: ExecutionEnvironmentSnapshot;
  readonly resultArtifact?: ResultArtifact;
  readonly timestamp: string;
}

export interface DurableSubagentAssignment {
  readonly assignment: SubagentAssignmentSnapshot;
  readonly createdByTurnId: string;
  readonly observed: boolean;
}

export interface DurableStandaloneAssignment extends DurableSubagentAssignment {
  readonly assignment: Extract<SubagentAssignmentSnapshot, { kind: "standalone" }>;
}

export interface ThreadLeaseAcquireOptions {
  /** Primarily useful for deterministic dead-process recovery tests. */
  readonly processId?: number;
  readonly ownerHostname?: string;
  readonly ownerToken?: string;
  readonly now?: () => Date;
  readonly isProcessAlive?: (processId: number) => boolean;
}

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
  owner_process_identity: string | null;
}

/** Locate a saved Thread without opening SQLite or mutating its projections. */
export function peekThreadWorkspaceRoot(dataDir: string, threadId: string): string {
  const events = new EventJournal(dataDir, threadId, { createDirectory: false }).read();
  const created = events.find((event) => event.type === "thread.created");
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
  readonly coordination: CoordinationStore;
  private static readonly MAX_CACHED_JOURNALS = 16;
  private readonly journals = new Map<string, EventJournal>();
  private readonly projection: ThreadProjection;

  constructor(private readonly storage: EasyCodeStorage) {
    this.coordination = new CoordinationStore(storage);
    this.projection = new ThreadProjection(storage);
  }

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
      orchestrationEnabled: input.orchestrationEnabled ?? false,
      thinkingEffort: input.thinkingEffort ?? DEFAULT_THINKING_EFFORT,
      projectId: input.projectId ?? workspaceIdFromRoot(input.workspaceRoot),
      workspaceRevision: input.workspaceRevision ?? 1,
      workspaceFolders: input.workspaceFolders?.map((folder) => ({ ...folder })) ?? [
        {
          id: "folder_primary",
          key: "workspace",
          path: input.workspaceRoot,
        },
      ],
      primaryWorkspaceFolderId: input.primaryWorkspaceFolderId ?? input.workspaceFolders?.[0]?.id ?? "folder_primary",
      workspaceRoot: input.workspaceRoot,
      promptBundle: { ...(input.promptBundle ?? activePromptBundleBinding()) },
      modelRegistryHash: input.modelRegistryHash ?? ACTIVE_MODEL_REGISTRY_HASH,
      goal: input.goal,
      constraints: [...(input.constraints ?? [])],
      messages: (input.messages ?? []).map(cloneMessage),
      userMessageIndices: (input.messages ?? []).flatMap((message, messageIndex) =>
        message.role === "user" ? [messageIndex] : [],
      ),
      filesRead: new Map(),
      changes: [],
      commands: [],
      commandApprovalPrefixes: [],
      toolApprovalGrants: [],
      pendingSteering: [],
      steeringSequence: 0,
      steeringWatermark: 0,
      workingSummary: "",
      compactedMessageCount: 0,
      progressGuard: createProgressGuardState(),
      compactionControl: { phaseEnds: [] },
      reviewSessions: [],
      createdAt: now,
      updatedAt: now,
    };

    const persistedState = serializeSessionState(state);
    // Round-trip with the reader's rules before anything is durable: the
    // serializer is more permissive than the deserializer, and a thread.created
    // payload the deserializer rejects would make the Thread unrecoverable.
    const detached = deserializeSessionState(JSON.parse(JSON.stringify(persistedState)));
    detached.progressGuard = createProgressGuardState();

    let event!: EventRecord;
    this.storage.db.transaction(() => {
      if (journal.read().length > 0 || this.threadExists(threadId)) {
        throw new Error(`Thread already exists: ${threadId}`);
      }
      event = journal.append({
        type: "thread.created",
        payload: { state: persistedState },
      });
      this.projection.projectState(state, "active");
      this.projection.projectEvent(event, journal.filePath);
    })();
    return detached;
  }

  get(threadId: string): SessionState | undefined {
    const journal = this.journal(threadId);
    const events = journal.read();
    if (events.length === 0) return undefined;
    const state = recoverFromEvents(threadId, events);
    this.projection.reconcileProjection(state, events, journal.filePath);
    return state;
  }

  recover(threadId: string): SessionState {
    const state = this.get(threadId);
    if (!state) throw new Error(`Thread not found: ${threadId}`);
    return state;
  }

  save(state: SessionState): void {
    const journal = this.journal(state.threadId);
    const checkpointTimestamp = new Date().toISOString();
    const snapshot: SessionState = {
      ...state,
      updatedAt: checkpointTimestamp,
      constraints: [...state.constraints],
      messages: state.messages.map(cloneMessage),
      filesRead: new Map(state.filesRead),
      changes: state.changes.map((change) => ({ ...change })),
      commands: state.commands.map((command) => ({
        ...command,
        args: [...command.args],
      })),
      commandApprovalPrefixes: [...state.commandApprovalPrefixes],
      promptBundle: { ...state.promptBundle },
      ...(state.taskGraph ? { taskGraph: cloneTaskGraph(state.taskGraph) } : {}),
      ...(state.planReview ? { planReview: clonePlanReviewState(state.planReview) } : {}),
      pendingSteering: state.pendingSteering.map(cloneSteeringEntry),
      steeringSequence: state.steeringSequence,
      steeringWatermark: state.steeringWatermark,
      ...(state.steeringSealedTurnId ? { steeringSealedTurnId: state.steeringSealedTurnId } : {}),
    };
    let checkpointEvent: EventRecord | undefined;
    try {
      this.storage.db.transaction(() => {
        const priorEvents = journal.read();
        if (priorEvents.length === 0 || !this.threadExists(state.threadId)) {
          throw new Error(`Cannot save unknown thread: ${state.threadId}`);
        }
        const durable = recoverFromEvents(state.threadId, priorEvents);
        const baseSequence = priorEvents[priorEvents.length - 1]?.sequence;
        if (baseSequence === undefined) {
          throw new Error(`Cannot save unknown thread: ${state.threadId}`);
        }
        const delta = createThreadCheckpointDelta(durable, snapshot, baseSequence);
        if (!threadCheckpointDeltaHasChanges(delta)) return;
        const effective = deserializeSessionState(serializeSessionState(durable));
        applyThreadCheckpointDelta(effective, delta, {
          eventId: "pending_thread_checkpoint_update",
          sequence: baseSequence + 1,
        });
        effective.updatedAt = checkpointTimestamp;
        checkpointEvent = journal.append({
          type: "thread.checkpoint.updated",
          payload: delta,
          turnId: effective.activeTurnId,
          timestamp: checkpointTimestamp,
        });
        state.updatedAt = checkpointTimestamp;
        if (checkpointEvent.sequence !== baseSequence + 1) {
          throw new Error("Thread journal advanced while saving its checkpoint delta");
        }
        this.projection.projectState(effective, "active");
        this.projection.projectEvent(checkpointEvent, journal.filePath);
        // SQLite is only a repairable projection. Preserve save()'s existing
        // audit-reconciliation behavior without repeating commands in JSONL.
        for (const command of effective.commands) {
          this.projection.projectToolAudit(effective.threadId, effective.activeTurnId, command);
        }
      })();
    } catch (error) {
      if (!checkpointEvent) throw error;
      const committed = journal.read().some((candidate) => candidate.eventId === checkpointEvent?.eventId);
      if (!committed) throw error;
      try {
        const events = journal.read();
        const recovered = recoverFromEvents(state.threadId, events);
        this.projection.reconcileProjection(recovered, events, journal.filePath);
      } catch {
        // The checkpoint delta is durable; a later get/recover retries projection.
      }
    }
  }

  list(options: ThreadListOptions = {}): ThreadSummary[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 100_000));
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

  /** Aggregate durable provider-reported usage without loading it into model context. */
  modelUsageSummary(threadId: string): ModelUsageSummary {
    if (!this.threadExists(threadId)) throw new Error(`Thread not found: ${threadId}`);
    const records = this.journal(threadId)
      .read()
      .flatMap((event) => {
        if (event.type !== "model.usage" || event.phase !== "completed") return [];
        const record = parseModelUsageRecord(event.payload);
        if (!record) {
          throw new Error(`Invalid model usage payload in event ${event.eventId}`);
        }
        return [record];
      });
    return aggregateModelUsage(records);
  }

  /** Persist one user follow-up before acknowledging it to the interactive UI. */
  enqueueTurnSteering(threadId: string, turnId: string, message: UserChatMessage): TurnSteeringEntry {
    // Round-trip validation also clones the attachment metadata away from UI-owned objects.
    const safeMessage = cloneUserMessage(message);
    const prior = this.recover(threadId);
    if (prior.activeTurnId !== turnId) {
      throw new Error(`Cannot steer inactive turn ${turnId}`);
    }
    if (prior.steeringSealedTurnId === turnId) {
      throw new Error(`Turn ${turnId} is already sealed for finalization`);
    }
    const entry: TurnSteeringEntry = {
      source: "user_adjust",
      id: createId("steering"),
      sequence: prior.steeringSequence + 1,
      targetTurnId: turnId,
      message: safeMessage,
      queuedAt: new Date().toISOString(),
    };
    this.appendEvent(threadId, {
      type: "turn.steering.queued",
      turnId,
      phase: "completed",
      payload: { entry },
    });
    return cloneSteeringEntry(entry);
  }

  /** Read-only FIFO snapshot. No entry-count truncation is applied. */
  pendingTurnSteering(threadId: string): TurnSteeringEntry[] {
    return this.recover(threadId).pendingSteering.map(cloneSteeringEntry);
  }

  hasPendingTurnSteering(threadId: string, turnId?: string): boolean {
    const state = this.recover(threadId);
    if (turnId !== undefined && state.activeTurnId !== turnId) return false;
    return (state.pendingSteering?.length ?? 0) > 0;
  }

  /**
   * Durably consume the current FIFO prefix and return its exact model-visible
   * message. Entries queued after this snapshot remain pending for the next boundary.
   */
  drainTurnSteering(
    threadId: string,
    turnId: string,
    limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS,
    admitPeers = true,
  ): TurnSteeringBatch | undefined {
    if (admitPeers) this.admitPeerMessages(threadId, turnId, limits);
    const prior = this.recover(threadId);
    if (prior.activeTurnId !== turnId) {
      throw new Error(`Cannot drain steering for inactive turn ${turnId}`);
    }
    const firstSource = prior.pendingSteering[0]?.source;
    const end = prior.pendingSteering.findIndex((entry) => entry.source !== firstSource);
    const entries = prior.pendingSteering.slice(0, end < 0 ? undefined : end).map(cloneSteeringEntry);
    if (entries.length === 0) return undefined;
    const message = mergeTurnSteeringEntries(entries);
    const throughSequence = entries[entries.length - 1]!.sequence;
    this.appendEvent(threadId, {
      type: "turn.steering.applied",
      turnId,
      phase: "completed",
      payload: {
        throughSequence,
        entryIds: entries.map((entry) => entry.id),
        message,
      },
    });
    return {
      source: entries[0]!.source,
      entries: entries.map(cloneSteeringEntry),
      throughSequence,
      message: cloneUserMessage(message),
    };
  }

  /**
   * Close admission immediately before a successful terminal response. If a
   * follow-up won the race, consume it instead and let Runtime continue.
   */
  sealTurnSteering(
    threadId: string,
    turnId: string,
    limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS,
  ): TurnSteeringBatch | undefined {
    // Recovery may re-enter finalization after a durable seal. Keep replay's
    // duplicate-event check strict, but do not append a second seal here.
    const current = this.recover(threadId);
    if (current.activeTurnId !== turnId) {
      throw new Error(`Cannot seal inactive turn ${turnId}`);
    }
    if (current.steeringSealedTurnId === turnId) return undefined;
    const pending = this.drainTurnSteering(threadId, turnId, limits);
    if (pending) return pending;
    const prior = this.recover(threadId);
    if (prior.activeTurnId !== turnId) {
      throw new Error(`Cannot seal inactive turn ${turnId}`);
    }
    if (prior.steeringSealedTurnId === turnId) return undefined;
    try {
      this.appendEvent(threadId, {
        type: "turn.steering.sealed",
        turnId,
        phase: "completed",
        payload: { throughSequence: prior.steeringWatermark },
      });
      return undefined;
    } catch (error) {
      const latest = this.recover(threadId);
      if (latest.activeTurnId === turnId && latest.steeringSealedTurnId === turnId) {
        return undefined;
      }
      // If enqueue won the append lock after our empty snapshot, consume that
      // newly durable prefix instead of finalizing over it.
      const raced = this.drainTurnSteering(threadId, turnId, limits);
      if (raced) return raced;
      throw error;
    }
  }

  private admitPeerMessages(threadId: string, turnId: string, limits: Readonly<RuntimeLimits>): void {
    if (!limits.coordinationEnabled) return;
    const state = this.recover(threadId);
    if (state.activeTurnId !== turnId || state.steeringSealedTurnId === turnId || state.pendingSteering.length) return;
    const pending = this.coordination.pending(threadId, limits.coordinationMessagesPerBoundary);
    if (!pending.length) return;
    const committed = new Set(
      this.journal(threadId)
        .read()
        .map((event) => event.eventId),
    );
    let sequence = state.steeringSequence;
    for (const message of pending) {
      const eventId = `peer_admitted_${message.id}`;
      if (!committed.has(eventId)) {
        const entry: TurnSteeringEntry = {
          id: message.id,
          source: "peer_message",
          senderThreadId: message.sender_thread_id,
          targetTurnId: turnId,
          sequence: ++sequence,
          queuedAt: message.queued_at,
          message: { role: "user", content: message.text },
        };
        this.appendEvent(threadId, {
          eventId,
          type: "turn.steering.queued",
          turnId,
          phase: "completed",
          payload: { entry },
        });
      }
      // If the process died after journaling, the stable event ID prevents a second admission.
      this.coordination.acknowledge(message.id);
    }
  }

  appendEvent(threadId: string, input: AppendEventInput): EventRecord {
    const journal = this.journal(threadId);
    let event: EventRecord | undefined;
    try {
      this.storage.db.transaction(() => {
        if (!this.threadExists(threadId)) throw new Error(`Thread not found: ${threadId}`);
        const priorEvents = journal.read();
        if (priorEvents.length === 0) throw new Error(`Thread not found: ${threadId}`);
        if (
          input.type === "context.memory.gated" ||
          input.type === "context.reconciled" ||
          input.type === "context.server_reset" ||
          input.type === "review.assignment.event" ||
          input.type === "context.maintenance.checked" ||
          input.type === "context.history.evicted" ||
          input.type === "context.phase.closed" ||
          input.type.startsWith("context.compaction.") ||
          (input.type === "context.compaction.committed" && asPayloadRecord(input.payload)?.transactionId !== undefined)
        ) {
          // Validate before append, so malformed control events cannot poison
          // recovery. A commit is checked against the same event-folded state.
          recoverFromEvents(threadId, [
            ...priorEvents,
            {
              ...input,
              eventId: input.eventId ?? "pending_compaction",
              schemaVersion: CURRENT_PROTOCOL.journalEvent,
              sequence: priorEvents.at(-1)!.sequence + 1,
              threadId,
              timestamp: input.timestamp ?? new Date().toISOString(),
            },
          ]);
        }
        const payload = asPayloadRecord(input.payload);
        if (
          input.type === "decision.delivery.challenge_requested" &&
          (!payload ||
            !isChatMessage(payload.message) ||
            payload.message.role !== "user" ||
            typeof payload.decisionId !== "string")
        ) {
          throw new Error("Delivery challenge requires one durable user feedback message");
        }
        if (input.type === "mode.auto_route") {
          const priorState = recoverFromEvents(threadId, priorEvents);
          foldAutoRouteSelection(
            priorState,
            {
              phase: input.phase,
              turnId: input.turnId,
              timestamp: input.timestamp ?? new Date().toISOString(),
            },
            payload,
          );
        }
        if (input.type === "model.usage" && (input.phase !== "completed" || !parseModelUsageRecord(input.payload))) {
          throw new Error("Model usage events require a valid completed usage record");
        }
        if (payload && "progressObservation" in payload) {
          if (
            input.type !== "tool.result" ||
            typeof input.eventId !== "string" ||
            typeof payload.callId !== "string" ||
            typeof payload.tool !== "string"
          ) {
            throw new Error("ProgressObservation requires an explicitly identified tool.result event");
          }
          const observation = parseProgressObservation(payload.progressObservation, {
            sourceEventId: input.eventId,
            sourceCallId: payload.callId,
            tool: payload.tool,
          });
          const expectedScope =
            typeof payload.taskId === "string"
              ? `thread:${threadId}/task:${payload.taskId}`
              : typeof input.turnId === "string"
                ? `thread:${threadId}/turn:${input.turnId}`
                : undefined;
          if (!expectedScope || observation.scopeKey !== expectedScope) {
            throw new Error("ProgressObservation scope does not match its tool.result event");
          }
        }
        if (input.type === "progress.hint.presented") {
          const priorState = recoverFromEvents(threadId, priorEvents);
          foldProgressHint(priorState.progressGuard, input.payload);
        }
        if (input.type.startsWith("turn.steering.")) {
          const priorState = recoverFromEvents(threadId, priorEvents);
          replaySteeringEvent(
            priorState,
            {
              eventId: input.eventId ?? "pending_steering_event",
              timestamp: input.timestamp ?? new Date().toISOString(),
              type: input.type,
              phase: input.phase,
              turnId: input.turnId,
            },
            payload,
          );
        }
        if (input.type === "command.approval_prefix_granted") {
          if (input.phase !== "completed" || !payload || typeof payload.commandPrefix !== "string") {
            throw new Error("Command approval prefix grants require one completed prefix");
          }
          // Validate against the event-authoritative state while the same DB
          // transaction holds EventJournal's cross-process append lock.
          const priorState = recoverFromEvents(threadId, priorEvents);
          grantCommandApprovalPrefix(priorState.commandApprovalPrefixes, payload.commandPrefix);
        }
        if (input.type === "approval.tool_granted") {
          if (input.phase !== "completed" || !payload || typeof payload.key !== "string") {
            throw new Error("Tool approval grants require one completed key");
          }
          const priorState = recoverFromEvents(threadId, priorEvents);
          validateToolApprovalGrants([...(priorState.toolApprovalGrants ?? []), payload.key]);
        }
        if (input.type === "command.approval_prefix_revoked") {
          if (input.phase !== "completed" || typeof payload?.commandPrefix !== "string")
            throw new Error("Invalid prefix revocation");
          normalizeCommandApprovalPrefix(payload.commandPrefix);
        }
        if (payload && "taskGraph" in payload) {
          const priorState = recoverFromEvents(threadId, priorEvents);
          replayTaskGraphResult(
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
          const priorState = recoverFromEvents(threadId, priorEvents);
          validatePlanExecutionReturnedToReview(
            priorState,
            {
              eventId: input.eventId ?? "pending_plan_execution_recovery",
              turnId: input.turnId,
              phase: input.phase,
            },
            payload,
            input.turnId ? this.approvedPlanExecution(threadId, input.turnId) : undefined,
          );
        } else if (
          payload &&
          (((input.type === "tool.result" || input.type === "plan.proposed") && "planReview" in payload) ||
            input.type === "plan.approved" ||
            input.type === "plan.rejected" ||
            input.type === "plan.feedback_submitted" ||
            input.type === "plan.execution_started")
        ) {
          const priorState = recoverFromEvents(threadId, priorEvents);
          replayPlanReviewEvent(
            priorState,
            {
              eventId: input.eventId ?? "pending_plan_event",
              timestamp: input.timestamp ?? new Date().toISOString(),
              type: input.type,
              turnId: input.turnId,
              phase: input.phase,
            },
            payload,
          );
        }
        if (input.type === "turn.recovered") {
          if (!payload || !input.turnId) {
            throw new Error("Interrupted-turn recovery requires a payload and turn ID");
          }
          const priorState = recoverFromEvents(threadId, priorEvents);
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
        this.projection.projectEvent(event, journal.filePath);
        this.projection.projectAuxiliaryEvent(threadId, event);
        if (input.type === "mode.auto_route") {
          this.storage.db.prepare("UPDATE threads SET mode = ? WHERE id = ?").run(payload!.mode, threadId);
        }
        this.projection.touchThread(threadId, event.timestamp);
      })();
    } catch (error) {
      // The fsynced JSONL journal is the source of truth. SQLite cannot roll it
      // back, so a projection error after append is still a committed event.
      if (!event) throw error;
      const committed = journal.read().find((candidate) => candidate.eventId === event?.eventId);
      if (!committed) throw error;
      try {
        const events = journal.read();
        const recovered = recoverFromEvents(threadId, events);
        this.projection.reconcileProjection(recovered, events, journal.filePath);
      } catch {
        // Recovery on the next get/recover call retries this derived projection.
      }
      return committed;
    }
    if (!event) throw new Error("Thread event append did not produce a durable event");
    return event;
  }

  acquireThreadLease(threadId: string, options: ThreadLeaseAcquireOptions = {}): ThreadLease {
    const ownerPid = options.processId ?? process.pid;
    const ownerHostname = options.ownerHostname ?? hostname();
    const ownerToken = options.ownerToken ?? createId("thread_lease");
    const acquiredAt = (options.now ?? (() => new Date()))().toISOString();
    const lease: ThreadLease = {
      threadId,
      ownerPid,
      ownerHostname,
      ownerToken,
      acquiredAt,
      ...(ownerPid === process.pid && ownerHostname === hostname()
        ? { ownerProcessIdentity: currentProcessIdentity() }
        : {}),
    };
    assertValidThreadLease(lease);

    this.storage.db.transaction(() => {
      if (!this.threadExists(threadId)) {
        const journal = this.journal(threadId);
        const events = journal.read();
        if (events.length === 0) throw new Error(`Thread not found: ${threadId}`);
        const recovered = recoverFromEvents(threadId, events);
        this.projection.projectRecoveredThread(recovered, events, journal.filePath);
      }

      const existing = this.storage.db
        .prepare<[string], ThreadLeaseRow>(
          `SELECT thread_id, owner_pid, owner_hostname, owner_token, acquired_at, owner_process_identity
             FROM thread_leases
            WHERE thread_id = ?`,
        )
        .get(threadId);
      if (existing) {
        assertValidThreadLeaseRow(existing);
        const ownerState = options.isProcessAlive
          ? existing.owner_hostname === ownerHostname
            ? options.isProcessAlive(existing.owner_pid)
              ? "active"
              : "inactive"
            : "unknown"
          : processOwnerState({
              pid: existing.owner_pid,
              hostname: existing.owner_hostname,
              processIdentity: existing.owner_process_identity
                ? JSON.parse(existing.owner_process_identity)
                : undefined,
            });
        if (ownerState !== "inactive") {
          throw new Error(
            `Thread ${threadId} is already active in another EASY CODE process ` +
              `(PID ${existing.owner_pid} on ${existing.owner_hostname}). Close it before resuming.`,
          );
        }
        const removed = this.storage.db
          .prepare<[string, string]>("DELETE FROM thread_leases WHERE thread_id = ? AND owner_token = ?")
          .run(threadId, existing.owner_token);
        if (removed.changes !== 1) {
          throw new Error(`Thread lease ownership changed while recovering ${threadId}`);
        }
      }

      this.storage.db
        .prepare(
          `INSERT INTO thread_leases(
             thread_id, owner_pid, owner_hostname, owner_token, acquired_at, owner_process_identity
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          ownerPid,
          ownerHostname,
          ownerToken,
          acquiredAt,
          lease.ownerProcessIdentity ? JSON.stringify(lease.ownerProcessIdentity) : null,
        );
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
        .run(lease.threadId, lease.ownerPid, lease.ownerHostname, lease.ownerToken);
      if (removed.changes !== 1) {
        throw new Error(`Cannot release thread lease for ${lease.threadId}: ownership no longer matches`);
      }
    })();
  }

  startTurn(threadId: string, userMessage: string | UserChatMessage, turnId = createId("turn")): TurnStartResult {
    const message: UserChatMessage =
      typeof userMessage === "string"
        ? { role: "user", content: userMessage }
        : (cloneMessage(userMessage) as UserChatMessage);
    const startedAt = new Date().toISOString();
    const event = this.appendEvent(threadId, {
      type: "turn.started",
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
    const message = cloneMessage(assistantMessage) as Extract<ChatMessage, { role: "assistant" }>;
    const completedAt = new Date().toISOString();
    const event = this.appendEvent(threadId, {
      type: "turn.completed",
      turnId,
      timestamp: completedAt,
      phase: "completed",
      payload: { message, reason },
    });
    return event;
  }

  recordMessage(threadId: string, message: ChatMessage, turnId?: string, source?: "assignment"): EventRecord {
    if (!isChatMessage(message)) throw new Error("Invalid chat message");
    return this.appendEvent(threadId, {
      type: "message.recorded",
      payload: { message: cloneMessage(message), ...(source ? { source } : {}) },
      turnId,
    });
  }

  recordToolAudit(threadId: string, turnId: string | undefined, entry: CommandAuditEntry): EventRecord {
    const event = this.appendEvent(threadId, {
      type: "command.audit.recorded",
      payload: { entry: { ...entry, args: [...entry.args] } },
      turnId,
      phase: entry.status === "policy_denied" ? "denied" : "completed",
      timestamp: entry.timestamp,
    });
    return event;
  }

  /** Atomically persist one exact executable grant in the Thread journal. */
  recordCommandApprovalPrefixGrant(threadId: string, commandPrefix: string, turnId?: string): EventRecord {
    const normalized = normalizeCommandApprovalPrefix(commandPrefix);
    return this.appendEvent(threadId, {
      type: "command.approval_prefix_granted",
      turnId,
      phase: "completed",
      payload: { commandPrefix: normalized },
    });
  }

  /** Durable same-tool grant; the caller must not execute if this append fails. */
  recordToolApprovalGrant(threadId: string, key: string, turnId?: string): EventRecord {
    validateToolApprovalGrants([key]);
    return this.appendEvent(threadId, {
      type: "approval.tool_granted",
      turnId,
      phase: "completed",
      payload: { key },
    });
  }

  recordCommandApprovalPrefixRevocation(threadId: string, commandPrefix: string, turnId?: string): EventRecord {
    return this.appendEvent(threadId, {
      type: "command.approval_prefix_revoked",
      turnId,
      phase: "completed",
      payload: { commandPrefix: normalizeCommandApprovalPrefix(commandPrefix) },
    });
  }

  recordSubagentArtifacts(
    threadId: string,
    turnId: string | undefined,
    input: {
      agentId: string;
      taskId: string;
      changes: readonly FileChangeRecord[];
      commands: readonly CommandAuditEntry[];
      /** False records isolated progress without projecting it into parent state. */
      mergeIntoParent?: boolean;
    },
  ): EventRecord {
    return this.appendEvent(threadId, {
      type: input.mergeIntoParent === false ? "subagent.progress" : "subagent.artifact",
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
        mergeIntoParent: input.mergeIntoParent !== false,
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
        ...(input.report ? { report: JSON.parse(JSON.stringify(input.report)) as SubagentTaskReport } : {}),
        ...(input.error ? { error: input.error } : {}),
        ...(input.environment ? { environment: { ...input.environment } } : {}),
        ...(input.resultArtifact
          ? {
              resultArtifact: {
                ...input.resultArtifact,
                ...(input.resultArtifact.parentArtifactIds
                  ? { parentArtifactIds: [...input.resultArtifact.parentArtifactIds] }
                  : {}),
                changedFiles: [...input.resultArtifact.changedFiles],
              },
            }
          : {}),
      },
    });
  }

  latestSubagentResult(threadId: string, agentId: string, taskId: string): DurableSubagentResult | undefined {
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
          payload.reason !== "needs_parent_decision" &&
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
        ...(isExecutionEnvironmentSnapshot(payload.environment) ? { environment: { ...payload.environment } } : {}),
        ...(isResultArtifact(payload.resultArtifact)
          ? {
              resultArtifact: {
                ...payload.resultArtifact,
                ...(payload.resultArtifact.parentArtifactIds
                  ? { parentArtifactIds: [...payload.resultArtifact.parentArtifactIds] }
                  : {}),
                changedFiles: [...payload.resultArtifact.changedFiles],
              },
            }
          : {}),
        timestamp: event.timestamp,
      };
    }
    return undefined;
  }

  /** Return the latest durable handoff disposition for an immutable result ID. */
  latestSubagentHandoffArtifact(threadId: string, artifactId: string): ResultArtifact | undefined {
    const events = this.journal(threadId).read();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "subagent.handoff_completed") continue;
      const payload = asPayloadRecord(event.payload);
      if (payload?.artifactId !== undefined && payload.artifactId !== artifactId) continue;
      if (!isResultArtifact(payload?.artifact)) continue;
      if (payload.artifact.id !== artifactId) continue;
      return {
        ...payload.artifact,
        ...(payload.artifact.parentArtifactIds ? { parentArtifactIds: [...payload.artifact.parentArtifactIds] } : {}),
        changedFiles: [...payload.artifact.changedFiles],
      };
    }
    return undefined;
  }

  /** Rebuild every durable child binding, including already observed history. */
  subagentAssignments(threadId: string): readonly DurableSubagentAssignment[] {
    const assignments = new Map<string, DurableSubagentAssignment>();
    for (const event of this.journal(threadId).read()) {
      if ((event.type !== "tool.result" && event.type !== "subagent.collected") || event.phase !== "completed")
        continue;
      const payload = asPayloadRecord(event.payload);
      const lifecycle = asPayloadRecord(payload?.subagentLifecycle);
      if (payload?.tool !== "manage_subagents" || !lifecycle) continue;
      if (lifecycle.action === "activate") {
        const assignment = subagentAssignment(payload.subagentAssignment);
        if (!assignment || assignment.agentId !== lifecycle.agentId || !event.turnId) {
          throw new Error(`Invalid child activation in event ${event.eventId}`);
        }
        const existing = assignments.get(assignment.agentId);
        if (existing) {
          throw new Error(`Duplicate child activation for ${assignment.agentId}`);
        }
        assignments.set(assignment.agentId, {
          assignment,
          createdByTurnId: event.turnId,
          observed: false,
        });
        continue;
      }
      if (lifecycle.action === "observe") {
        const assignment = subagentAssignment(payload.subagentAssignment);
        if (!assignment) continue;
        const existing = assignments.get(assignment.agentId);
        if (
          !existing ||
          assignment.agentId !== lifecycle.agentId ||
          !sameSubagentAssignmentIdentity(existing.assignment, assignment)
        ) {
          throw new Error(`Invalid child observation in event ${event.eventId}`);
        }
        assignments.set(assignment.agentId, { ...existing, observed: true });
      }
    }
    return [...assignments.values()].map((entry) => ({
      ...entry,
      assignment: {
        ...entry.assignment,
        completionChecks: [...entry.assignment.completionChecks],
      },
    }));
  }

  /** Durable child bindings that still require collection by the parent. */
  unobservedSubagentAssignments(threadId: string): readonly DurableSubagentAssignment[] {
    return this.subagentAssignments(threadId).filter((entry) => !entry.observed);
  }

  /** Standalone subset used by callers that do not manage DAG assignments. */
  unobservedStandaloneAssignments(threadId: string): readonly DurableStandaloneAssignment[] {
    return this.unobservedSubagentAssignments(threadId).filter(
      (entry): entry is DurableStandaloneAssignment => entry.assignment.kind === "standalone",
    );
  }

  hasCommittedSubagentStop(threadId: string, agentId: string): boolean {
    return this.journal(threadId)
      .read()
      .some((event) => {
        if (event.type !== "tool.result" || event.phase !== "completed") return false;
        const payload = asPayloadRecord(event.payload);
        const lifecycle = asPayloadRecord(payload?.subagentLifecycle);
        return (
          payload?.tool === "manage_subagents" && lifecycle?.action === "request_stop" && lifecycle.agentId === agentId
        );
      });
  }

  isBoundSubagentThread(threadId: string): boolean {
    return this.journal(threadId)
      .read()
      .some((event) => event.type === "subagent.session_bound" && event.phase === "completed");
  }

  /** Recover the approved proposal whose execution was interrupted in this Turn. */
  interruptedPlanReview(threadId: string, turnId: string): PlanReviewState | undefined {
    const review = this.approvedPlanExecution(threadId, turnId);
    return review ? returnPlanExecutionToReview(review, "interrupted") : undefined;
  }

  /** Locate the still-unresolved approval consumed by an execution turn. */
  private approvedPlanExecution(threadId: string, turnId: string): PlanReviewState | undefined {
    const events = this.journal(threadId).read();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.turnId !== turnId) continue;
      if (event.type === "plan.execution_returned_to_review") return undefined;
      if (event.type !== "plan.execution_started") continue;
      const payload = asPayloadRecord(event.payload);
      if (!payload) return undefined;
      const before = recoverFromEvents(threadId, events.slice(0, index));
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
        event.type === "thread.checkpoint.updated" ||
        event.type === "subagent.artifact" ||
        event.type === "subagent.result" ||
        event.type === "command.audit.recorded"
      ) {
        continue;
      }
      if (event.type !== "message.assistant" && event.type !== "message.assistant.synthetic") {
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
    const cached = this.journals.get(threadId);
    if (cached) {
      // Refresh insertion order so active parent/child Threads survive bounded
      // cache eviction while old resumed Threads release their parsed journals.
      this.journals.delete(threadId);
      this.journals.set(threadId, cached);
      return cached;
    }
    const journal = new EventJournal(this.storage.dataDir, threadId);
    this.journals.set(threadId, journal);
    if (this.journals.size > ThreadStore.MAX_CACHED_JOURNALS) {
      const oldestThreadId = this.journals.keys().next().value as string | undefined;
      if (oldestThreadId !== undefined) this.journals.delete(oldestThreadId);
    }
    return journal;
  }

  rebuildProjection(threadId: string): SessionState {
    const journal = this.journal(threadId);
    const events = journal.read();
    if (events.length === 0) throw new Error(`Thread not found: ${threadId}`);
    const state = recoverFromEvents(threadId, events);
    this.projection.reconcileProjection(state, events, journal.filePath);
    return state;
  }

  private threadExists(threadId: string): boolean {
    return (
      this.storage.db
        .prepare<[string], { present: number }>("SELECT 1 AS present FROM threads WHERE id = ?")
        .get(threadId) !== undefined
    );
  }
}

function assertValidThreadLease(lease: ThreadLease): void {
  if (!lease.threadId || lease.threadId.includes("\u0000")) {
    throw new Error("Invalid thread lease thread id");
  }
  if (!Number.isSafeInteger(lease.ownerPid) || lease.ownerPid <= 0) {
    throw new Error("Invalid thread lease owner PID");
  }
  if (!lease.ownerHostname || lease.ownerHostname.length > 255 || /[\u0000\r\n]/u.test(lease.ownerHostname)) {
    throw new Error("Invalid thread lease owner hostname");
  }
  if (!/^thread_lease_[0-9a-f-]{36}$/iu.test(lease.ownerToken)) {
    throw new Error("Invalid thread lease ownership token");
  }
  if (!lease.acquiredAt || !Number.isFinite(Date.parse(lease.acquiredAt))) {
    throw new Error("Invalid thread lease acquisition time");
  }
  if (lease.ownerProcessIdentity !== undefined && !validProcessIdentity(lease.ownerProcessIdentity))
    throw new Error("Invalid thread lease process identity");
}

function assertValidThreadLeaseRow(row: ThreadLeaseRow): void {
  assertValidThreadLease({
    threadId: row.thread_id,
    ownerPid: row.owner_pid,
    ownerHostname: row.owner_hostname,
    ownerToken: row.owner_token,
    acquiredAt: row.acquired_at,
    ...(row.owner_process_identity ? { ownerProcessIdentity: JSON.parse(row.owner_process_identity) } : {}),
  });
}
