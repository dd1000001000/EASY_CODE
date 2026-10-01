/**
 * Pure Thread event replay: rebuilds a SessionState from its durable journal.
 * No I/O happens here; ThreadStore owns storage, leases and projections.
 */

import { foldCompactionControl, prefixHash, completeExchange } from "../context/compaction-transaction.js";
import { compactionSnapshot } from "../context/semantic-compaction.js";
import { foldPendingOperations } from "../context/pending-operations.js";
import { foldPressureRecovery, foldContextMaintenance, foldMemoryGate } from "../context/pressure-recovery.js";
import { foldServerContextReset } from "../context/server-reset.js";
import { recordUserRequirement } from "../context/user-requirements.js";
import { foldReconciliation } from "../context/reconciliation.js";
import {
  type ChatMessage,
  type CommandAuditEntry,
  type EventRecord,
  type PlanReviewState,
  type SessionState,
} from "../core/types.js";
import { foldReviewEvent } from "../review/session.js";
import { isSubagentTaskGraphSource } from "../subagents/tool-names.js";
import {
  subagentTaskOperationSchema,
  taskGraphOperationSchema,
  validateSubagentTaskTransition,
  validateTaskGraphTransition,
} from "../tasks/task-graph.js";
import {
  deserializeSessionState,
  deserializeThreadCheckpointDelta,
  isChatMessage,
  isPlanReviewState,
  serializeChatMessage,
  serializeSessionState,
} from "./serialization.js";
import { clonePlanReviewState, returnPlanExecutionToReview, type PlanExecutionReturnOutcome } from "../plans/plan.js";
import { normalizeCommandApprovalPrefix, validateCommandApprovalPrefixes } from "../command/approval.js";
import { loadPromptBundleCatalog } from "../prompt-bundle/index.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { createProgressGuardState, foldProgressHint, foldProgressObservation } from "../progress/guard.js";
import { parseProgressObservation } from "../progress/observation.js";
import { foldCompletionControl } from "../runtime/completion-gate.js";
import { validateToolApprovalGrants } from "../tools/approval.js";
import { cloneMessage, asPayloadRecord, artifactPayload } from "./event-values.js";
import { cloneSteeringEntry, mergeTurnSteeringEntries, steeringEntry } from "./steering-entries.js";
import { applyThreadCheckpointDelta, mergeFileChanges, mergeCommandAudits } from "./checkpoint-delta.js";

export function interruptedTurnAssistantMessage(): string {
  return loadPromptBundleCatalog().readText("runtime/interrupted-turn.md").trimEnd();
}

export function appendMessageIfNew(state: SessionState, message: ChatMessage): number {
  const previous = state.messages[state.messages.length - 1];
  if (previous && serializeChatMessage(previous) === serializeChatMessage(message)) {
    return state.messages.length - 1;
  }
  state.messages.push(cloneMessage(message));
  return state.messages.length - 1;
}

export function updateRecoveredLatestRequest(state: SessionState, sourceMessageIndex: number, content: string): void {
  recordUserRequirement(state, sourceMessageIndex);
  const previous = state.contextIntentLedger;
  const text = redactSensitiveInformation(content).trim().slice(0, 400) || "[User message contains attachments only]";
  state.contextIntentLedger = {
    latestRequest: { sourceMessageIndex, text },
    activeConstraints: previous?.activeConstraints.map((item) => ({ ...item })) ?? [],
    userCorrections: previous?.userCorrections.map((item) => ({ ...item })) ?? [],
    supersededRequests: previous?.supersededRequests.map((item) => ({ ...item })) ?? [],
  };
}

export function appendRecoveredCorrection(state: SessionState, sourceMessageIndex: number, content: string): void {
  recordUserRequirement(state, sourceMessageIndex);
  const previous = state.contextIntentLedger;
  const quote = {
    sourceMessageIndex,
    text: redactSensitiveInformation(content).trim().slice(0, 400) || "[User message contains attachments only]",
  };
  state.contextIntentLedger = {
    latestRequest: previous?.latestRequest ? { ...previous.latestRequest } : quote,
    activeConstraints: previous?.activeConstraints.map((item) => ({ ...item })) ?? [],
    userCorrections: [...(previous?.userCorrections.map((item) => ({ ...item })) ?? []), quote].slice(-32),
    supersededRequests: previous?.supersededRequests.map((item) => ({ ...item })) ?? [],
  };
}

export function validateInterruptedTurnRecovery(
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

  const latestToolCallMessage = [...state.messages]
    .reverse()
    .find(
      (message): message is Extract<ChatMessage, { role: "assistant" }> =>
        message.role === "assistant" && Boolean(message.tool_calls?.length),
    );
  const latestToolCallIndex = latestToolCallMessage ? state.messages.lastIndexOf(latestToolCallMessage) : -1;
  const completedCallIds = new Set(
    state.messages
      .slice(latestToolCallIndex + 1)
      .filter((message): message is Extract<ChatMessage, { role: "tool" }> => message.role === "tool")
      .map((message) => message.tool_call_id),
  );
  const missingCalls = (latestToolCallMessage?.tool_calls ?? []).filter((call) => !completedCallIds.has(call.id));
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
    (message): message is Extract<ChatMessage, { role: "assistant" }> => message.role === "assistant",
  );
  const lastMessage = state.messages[state.messages.length - 1];
  const durableFinalAssistant = Boolean(
    lastMessage?.role === "assistant" && lastMessage.content?.trim() && !lastMessage.tool_calls?.length,
  );
  if (durableFinalAssistant) {
    if (assistantMessages.length !== 0) {
      throw new Error(`Turn recovery ${event.eventId} duplicated a durable final assistant`);
    }
  } else if (
    assistantMessages.length !== 1 ||
    assistantMessages[0]?.content !== interruptedTurnAssistantMessage() ||
    assistantMessages[0].tool_calls?.length
  ) {
    throw new Error(`Turn recovery ${event.eventId} has an invalid interruption marker`);
  }

  if (JSON.stringify(payload.planReview) !== JSON.stringify(expectedPlanReview)) {
    throw new Error(`Turn recovery ${event.eventId} has invalid plan provenance`);
  }
}

export function planExecutionReturnOutcome(value: unknown): PlanExecutionReturnOutcome | undefined {
  return value === "failed" || value === "interrupted" || value === "limit_reached" ? value : undefined;
}

export function validatePlanExecutionReturnedToReview(
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
    throw new Error(`Invalid approved-plan execution recovery in event ${event.eventId}`);
  }
  const expected = returnPlanExecutionToReview(executingReview, outcome);
  if (
    payload.planId !== expected.proposal.id ||
    payload.revision !== expected.proposal.revision ||
    !isPlanReviewState(payload.planReview) ||
    JSON.stringify(payload.planReview) !== JSON.stringify(expected)
  ) {
    throw new Error(`Approved-plan execution recovery ${event.eventId} changed the reviewed proposal`);
  }
  return expected;
}

export function foldAutoRouteSelection(
  state: SessionState,
  event: Pick<EventRecord, "phase" | "turnId" | "timestamp">,
  payload: Record<string, unknown> | undefined,
): void {
  if (
    event.phase !== "completed" ||
    !event.turnId ||
    state.activeTurnId !== event.turnId ||
    state.mode !== "auto" ||
    (payload?.mode !== "plan" && payload?.mode !== "code") ||
    typeof payload.reason !== "string" ||
    !payload.reason.trim()
  ) {
    throw new Error("Invalid Auto mode selection event");
  }
  state.mode = payload.mode;
  state.updatedAt = event.timestamp;
}

export function recoverFromEvents(threadId: string, events: readonly EventRecord[]): SessionState {
  let state: SessionState | undefined;
  const interruptedPlanExecutions = new Map<string, PlanReviewState>();
  for (const event of events) {
    const payload = asPayloadRecord(event.payload);
    if (event.type === "thread.created") {
      if (!payload || !("state" in payload)) {
        throw new Error(`Missing state in ${event.type} event`);
      }
      if (state) throw new Error(`Duplicate thread creation event ${event.eventId}`);
      const created = deserializeSessionState(payload.state);
      created.progressGuard = createProgressGuardState();
      created.compactionControl = { phaseEnds: [] };
      created.reviewSessions = [];
      state = created;
      continue;
    }
    if (event.type === "thread.checkpoint.updated") {
      if (!state) throw new Error(`Thread ${threadId} has no creation event`);
      const delta = deserializeThreadCheckpointDelta(event.payload);
      applyThreadCheckpointDelta(state, delta, event);
      state.updatedAt = event.timestamp;
      continue;
    }
    if (!state) throw new Error(`Thread ${threadId} has no creation event`);

    if (event.type === "mode.auto_route") {
      foldAutoRouteSelection(state, event, payload);
    } else if (event.type === "context.server_reset") {
      foldServerContextReset(state, payload);
    } else if (event.type === "context.reconciled") {
      foldReconciliation(state, String(payload?.tool), payload?.observation);
    } else if (event.type === "context.memory.gated") {
      foldMemoryGate(state, payload);
    } else if (event.type === "context.maintenance.checked") {
      foldContextMaintenance(state, payload);
    } else if (event.type === "context.history.evicted") {
      foldPressureRecovery(state, payload);
    } else if (
      event.type === "context.phase.closed" ||
      (event.type.startsWith("context.compaction.") && event.type !== "context.compaction.committed")
    ) {
      foldCompactionControl(state, event.type, payload);
    } else if (event.type === "turn.started") {
      state.activeTurnId = event.turnId;
      state.steeringSealedTurnId = undefined;
      if (payload && isChatMessage(payload.message) && payload.message.role === "user") {
        const messageIndex = appendMessageIfNew(state, payload.message);
        updateRecoveredLatestRequest(state, messageIndex, payload.message.content);
        if (payload.message.content.trim()) state.goal = payload.message.content;
      }
    } else if (event.type === "turn.completed") {
      state.activeTurnId = undefined;
      if (payload && isChatMessage(payload.message) && payload.message.role === "assistant") {
        appendMessageIfNew(state, payload.message);
      }
      if ((payload?.reason === "success" || payload?.reason === "planned") && completeExchange(state.messages)) {
        foldCompactionControl(state, "context.phase.closed", {
          end: state.messages.length,
          kind: "turn",
          turnId: event.turnId,
        });
      }
    } else if (event.type === "message.recorded") {
      if (payload && isChatMessage(payload.message)) {
        const index = appendMessageIfNew(state, payload.message);
        if (payload.source === "assignment" && payload.message.role === "user") recordUserRequirement(state, index);
      }
    } else if (event.type === "message.user" && event.turnId) {
      state.steeringSealedTurnId = undefined;
      if (payload && isChatMessage(payload.message) && payload.message.role === "user") {
        state.activeTurnId = event.turnId;
        const messageIndex = appendMessageIfNew(state, payload.message);
        updateRecoveredLatestRequest(state, messageIndex, payload.message.content);
        if (payload.message.content.trim()) state.goal = payload.message.content;
      } else if (typeof payload?.content === "string") {
        state.activeTurnId = event.turnId;
        const messageIndex = appendMessageIfNew(state, { role: "user", content: payload.content });
        updateRecoveredLatestRequest(state, messageIndex, payload.content);
        if (payload.content.trim()) state.goal = payload.content;
      }
    } else if (
      event.type === "decision.delivery.challenge_requested" &&
      payload &&
      isChatMessage(payload.message) &&
      payload.message.role === "user"
    ) {
      appendMessageIfNew(state, payload.message);
    } else if (event.type.startsWith("turn.steering.")) {
      replaySteeringEvent(state, event, payload);
    } else if (
      event.type === "message.user.synthetic" &&
      isChatMessage(event.payload) &&
      event.payload.role === "user"
    ) {
      appendMessageIfNew(state, event.payload);
    } else if (
      event.type === "subagent.message.delivered" &&
      payload &&
      isChatMessage(payload.message) &&
      payload.message.role === "user"
    ) {
      appendMessageIfNew(state, payload.message);
    } else if (
      (event.type === "message.assistant" || event.type === "message.assistant.synthetic") &&
      isChatMessage(event.payload)
    ) {
      appendMessageIfNew(state, event.payload);
    } else if (event.type === "subagent.collected" && payload) {
      if (
        event.phase !== "completed" ||
        payload.tool !== "observe_subagents" ||
        !isChatMessage(payload.message) ||
        payload.message.role !== "user"
      ) {
        throw new Error(`Invalid Runtime child collection in event ${event.eventId}`);
      }
      foldPendingOperations(state, payload);
      if ("taskGraph" in payload) {
        state.taskGraph = replayTaskGraphResult(state, event, payload);
      }
      appendMessageIfNew(state, payload.message);
    } else if (event.type === "tool.result" && payload) {
      if (!replayToolResult(state, event, payload)) continue;
    } else if (event.type === "subagent.reconciled" && payload && "taskGraph" in payload) {
      state.taskGraph = replayTaskGraphResult(state, event, payload);
    } else if (event.type === "subagent.artifact" && payload) {
      const artifacts = artifactPayload(payload);
      mergeFileChanges(state.changes, artifacts.changes);
      mergeCommandAudits(state.commands, artifacts.commands);
    } else if (event.type === "turn.recovered" && payload && event.turnId) {
      replayRecoveredTurn(state, event, event.turnId, payload, interruptedPlanExecutions);
    } else if (event.type === "plan.execution_returned_to_review" && payload && event.turnId) {
      state.planReview = validatePlanExecutionReturnedToReview(
        state,
        event,
        payload,
        interruptedPlanExecutions.get(event.turnId),
      );
      interruptedPlanExecutions.delete(event.turnId);
    } else if (
      (event.type === "plan.proposed" ||
        event.type === "plan.approved" ||
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
        interruptedPlanExecutions.set(event.turnId, clonePlanReviewState(state.planReview));
      }
      replayPlanReviewEvent(state, event, payload);
      if (isChatMessage(payload.message) && payload.message.role === "user") {
        appendMessageIfNew(state, payload.message);
      }
    } else if (event.type === "context.compaction.committed" && payload) {
      if (!replayCompactionCommit(state, payload)) continue;
    } else if (event.type === "command.audit.recorded" && payload) {
      const entry = payload.entry as CommandAuditEntry | undefined;
      if (entry && typeof entry.id === "string" && !state.commands.some((command) => command.id === entry.id)) {
        state.commands.push({ ...entry, args: [...entry.args] });
      }
    } else if (
      event.type === "command.approval_prefix_granted" ||
      event.type === "command.approval_prefix_revoked" ||
      event.type === "approval.tool_granted"
    ) {
      replayApprovalGrant(state, event, payload);
    } else if (event.type === "review.assignment.event") {
      foldReviewEvent(state, event.payload);
    } else if (event.type === "completion.rejected" || event.type === "completion.resolved") {
      foldCompletionControl(state, event.type, event.payload);
    } else if (event.type === "progress.hint.presented") {
      state.progressGuard = foldProgressHint(state.progressGuard, event.payload);
    }
    state.updatedAt = event.timestamp;
  }

  if (!state) throw new Error(`Thread ${threadId} has no recoverable state`);
  if (state.threadId !== threadId) {
    throw new Error(`Recovered thread id ${state.threadId} does not match ${threadId}`);
  }
  return state;
}

/** Fold a tool result: pending operations, progress observation, task graph and plan review, then its tool message. Returns false when the result names no call to answer (the event then leaves updatedAt alone). */
function replayToolResult(state: SessionState, event: EventRecord, payload: Record<string, unknown>): boolean {
  foldPendingOperations(state, payload);
  if ("progressObservation" in payload) {
    if (typeof payload.callId !== "string" || typeof payload.tool !== "string") {
      throw new Error(`Missing progress call binding in event ${event.eventId}`);
    }
    const observation = parseProgressObservation(payload.progressObservation, {
      sourceEventId: event.eventId,
      sourceCallId: payload.callId,
      tool: payload.tool,
    });
    const expectedScope =
      typeof payload.taskId === "string"
        ? `thread:${event.threadId}/task:${payload.taskId}`
        : typeof event.turnId === "string"
          ? `thread:${event.threadId}/turn:${event.turnId}`
          : undefined;
    if (!expectedScope || observation.scopeKey !== expectedScope) {
      throw new Error(`Invalid progress scope in event ${event.eventId}`);
    }
    const progressFold = foldProgressObservation(state.progressGuard, observation);
    state.progressGuard = progressFold.state;
  }
  if ("taskGraph" in payload) {
    state.taskGraph = replayTaskGraphResult(state, event, payload);
  }
  if ("planReview" in payload) {
    replayPlanReviewEvent(state, event, payload);
  }
  if (isChatMessage(payload.message) && payload.message.role === "tool") {
    appendMessageIfNew(state, payload.message);
  } else {
    const callId = payload.callId;
    const tool = payload.tool;
    if (typeof callId !== "string" || typeof tool !== "string") return false;
    appendMessageIfNew(state, {
      role: "tool",
      tool_call_id: callId,
      name: tool,
      content: JSON.stringify(payload.result ?? null).slice(0, 64_000),
    });
  }
  return true;
}

/** Fold the recovery of an interrupted turn: its closing messages and, for an interrupted plan execution, the review it returns to. */
function replayRecoveredTurn(
  state: SessionState,
  event: EventRecord,
  turnId: string,
  payload: Record<string, unknown>,
  interruptedPlanExecutions: Map<string, PlanReviewState>,
): void {
  const interruptedExecution = interruptedPlanExecutions.get(turnId);
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
  interruptedPlanExecutions.delete(turnId);
  state.activeTurnId = undefined;
}

/** Fold a committed compaction after checking it against the open transaction. Returns false for a repeated commit (the event then leaves updatedAt alone). */
function replayCompactionCommit(state: SessionState, payload: Record<string, unknown>): boolean {
  const transaction = state.compactionControl?.transaction;
  if (payload.transactionId !== undefined) {
    if (!transaction || payload.transactionId !== transaction.id) throw new Error("Unknown compaction commit");
    if (transaction.status === "committed") return false;
    if (
      transaction.start !== state.compactedMessageCount ||
      payload.compactedMessageCount !== transaction.end ||
      transaction.sourceHash !== prefixHash(state, transaction.end) ||
      ((!transaction.candidate || transaction.feedback) && !transaction.fallback) ||
      (transaction.snapshot && payload.snapshotDigest !== transaction.snapshot.digest) ||
      (transaction.snapshot && compactionSnapshot(state, transaction.end).digest !== transaction.snapshot.digest) ||
      asPayloadRecord(payload.contextCompactionMetadata)?.sourceEndMessageIndex !== transaction.end ||
      asPayloadRecord(payload.contextCompactionMetadata)?.sourceStartMessageIndex !== transaction.start
    )
      throw new Error("Stale compaction commit");
  }
  const summary = payload.summary;
  const compactedMessageCount = payload.compactedMessageCount;
  if (
    typeof summary === "string" &&
    typeof compactedMessageCount === "number" &&
    Number.isInteger(compactedMessageCount) &&
    compactedMessageCount >= state.compactedMessageCount &&
    compactedMessageCount <= state.messages.length
  ) {
    const replayed = deserializeSessionState({
      ...serializeSessionState(state),
      workingSummary: summary,
      compactedMessageCount,
      ...(payload.contextIntentLedger === undefined ? {} : { contextIntentLedger: payload.contextIntentLedger }),
      ...(payload.contextCompactionMetadata === undefined
        ? {}
        : { contextCompactionMetadata: payload.contextCompactionMetadata }),
    });
    state.workingSummary = replayed.workingSummary;
    state.compactedMessageCount = replayed.compactedMessageCount;
    state.contextIntentLedger = replayed.contextIntentLedger;
    state.contextCompactionMetadata = replayed.contextCompactionMetadata;
    if (payload.transactionId !== undefined && transaction) {
      transaction.status = "committed";
      transaction.candidate = undefined;
      transaction.feedback = undefined;
      transaction.semantic = undefined;
      transaction.fallback = undefined;
      state.compactionControl!.seed = undefined;
    }
  }
  return true;
}

/** Fold a command-prefix grant or revocation, or a tool approval grant. */
function replayApprovalGrant(
  state: SessionState,
  event: EventRecord,
  payload: Record<string, unknown> | undefined,
): void {
  if (event.type === "command.approval_prefix_granted") {
    if (event.phase !== "completed" || !payload || typeof payload.commandPrefix !== "string") {
      throw new Error(`Invalid command approval prefix grant in event ${event.eventId}`);
    }
    state.commandApprovalPrefixes = validateCommandApprovalPrefixes([
      ...state.commandApprovalPrefixes.filter((prefix) => prefix !== payload.commandPrefix),
      payload.commandPrefix,
    ]);
  } else if (event.type === "command.approval_prefix_revoked") {
    if (event.phase !== "completed" || typeof payload?.commandPrefix !== "string")
      throw new Error("Invalid prefix revocation event");
    const prefix = normalizeCommandApprovalPrefix(payload.commandPrefix);
    state.commandApprovalPrefixes = state.commandApprovalPrefixes.filter(
      (p) => normalizeCommandApprovalPrefix(p) !== prefix,
    );
  } else if (event.type === "approval.tool_granted") {
    if (event.phase !== "completed" || typeof payload?.key !== "string") {
      throw new Error(`Invalid tool approval grant in event ${event.eventId}`);
    }
    state.toolApprovalGrants = validateToolApprovalGrants([...(state.toolApprovalGrants ?? []), payload.key]);
  }
}

export function replaySteeringEvent(
  state: SessionState,
  event: Pick<EventRecord, "eventId" | "timestamp" | "type" | "phase" | "turnId">,
  payload: Record<string, unknown> | undefined,
): void {
  if (event.phase !== "completed" || !event.turnId || state.activeTurnId !== event.turnId || !payload) {
    throw new Error(`Invalid steering transition in event ${event.eventId}`);
  }
  const pending = state.pendingSteering;
  const assigned = state.steeringSequence;
  const watermark = state.steeringWatermark;

  if (event.type === "turn.steering.queued") {
    const entry = steeringEntry(payload.entry);
    if (
      !entry ||
      state.steeringSealedTurnId === event.turnId ||
      entry.targetTurnId !== event.turnId ||
      entry.sequence !== assigned + 1 ||
      entry.sequence <= watermark ||
      pending.some((candidate) => candidate.id === entry.id)
    ) {
      throw new Error(`Invalid steering enqueue in event ${event.eventId}`);
    }
    pending.push(cloneSteeringEntry(entry));
    state.steeringSequence = entry.sequence;
    return;
  }

  if (event.type === "turn.steering.applied") {
    const throughSequence = payload.throughSequence;
    const entryIds = payload.entryIds;
    if (
      !Number.isSafeInteger(throughSequence) ||
      Number(throughSequence) <= watermark ||
      Number(throughSequence) > assigned ||
      !Array.isArray(entryIds) ||
      !entryIds.every((id) => typeof id === "string") ||
      !isChatMessage(payload.message) ||
      payload.message.role !== "user"
    ) {
      throw new Error(`Invalid steering application in event ${event.eventId}`);
    }
    const prefix = pending.filter((entry) => entry.sequence <= Number(throughSequence));
    if (
      prefix.length === 0 ||
      prefix[prefix.length - 1]?.sequence !== throughSequence ||
      prefix.length !== entryIds.length ||
      !prefix.every((entry, index) => entry.id === entryIds[index])
    ) {
      throw new Error(`Steering application is not an exact FIFO prefix in event ${event.eventId}`);
    }
    const expectedMessage = mergeTurnSteeringEntries(prefix);
    if (serializeChatMessage(expectedMessage) !== serializeChatMessage(payload.message)) {
      throw new Error(`Steering application changed model-visible content in event ${event.eventId}`);
    }
    state.pendingSteering = pending.slice(prefix.length).map(cloneSteeringEntry);
    state.steeringWatermark = throughSequence as number;
    const messageIndex = appendMessageIfNew(state, expectedMessage);
    if (prefix[0]!.source === "user_adjust") appendRecoveredCorrection(state, messageIndex, expectedMessage.content);
    return;
  }

  if (event.type === "turn.steering.sealed") {
    if (payload.throughSequence !== watermark || pending.length !== 0 || state.steeringSealedTurnId === event.turnId) {
      throw new Error(`Invalid steering finalization seal in event ${event.eventId}`);
    }
    state.steeringSealedTurnId = event.turnId;
    return;
  }

  throw new Error(`Unknown steering event type ${event.type}`);
}

export function replayTaskGraphResult(
  state: Readonly<SessionState>,
  event: Pick<EventRecord, "type" | "phase" | "turnId" | "eventId">,
  payload: Record<string, unknown>,
): NonNullable<SessionState["taskGraph"]> {
  if (
    (event.type !== "tool.result" && event.type !== "subagent.reconciled" && event.type !== "subagent.collected") ||
    event.phase !== "completed" ||
    typeof event.turnId !== "string" ||
    !event.turnId ||
    ((event.type === "tool.result" || event.type === "subagent.collected") &&
      payload.tool !== "manage_tasks" &&
      !isSubagentTaskGraphSource(payload.tool))
  ) {
    throw new Error(`Invalid task DAG source in tool.result event ${event.eventId}`);
  }
  try {
    if (payload.tool === "manage_tasks" && "taskGraphOperation" in payload) {
      const parsed = taskGraphOperationSchema.safeParse(payload.taskGraphOperation);
      if (!parsed.success || parsed.data.action === "list") {
        throw new Error("Invalid model task DAG operation");
      }
      return validateTaskGraphTransition(state.taskGraph, parsed.data, payload.taskGraph, event.turnId);
    }
    if (
      (isSubagentTaskGraphSource(payload.tool) || event.type === "subagent.reconciled") &&
      "subagentTaskOperation" in payload
    ) {
      const parsed = subagentTaskOperationSchema.parse(payload.subagentTaskOperation);
      return validateSubagentTaskTransition(state.taskGraph, parsed, payload.taskGraph, event.turnId);
    }
    throw new Error("The event did not declare an authorized task DAG transition");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid task DAG transition in tool.result event ${event.eventId}: ${message}`);
  }
}

export function replayPlanReviewEvent(
  state: SessionState,
  event: Pick<EventRecord, "eventId" | "timestamp" | "type" | "turnId" | "phase">,
  payload: Record<string, unknown>,
): void {
  if (event.type === "tool.result" || event.type === "plan.proposed") {
    if (
      event.phase !== "completed" ||
      (event.type === "tool.result" && payload.tool !== "propose_plan") ||
      !isPlanReviewState(payload.planReview) ||
      payload.planReview.status !== "awaiting_review" ||
      !event.turnId ||
      payload.planReview.proposal.proposedByTurnId !== event.turnId
    ) {
      throw new Error(`Invalid plan proposal source in event ${event.eventId}`);
    }
    const previous = state.planReview?.proposal;
    const next = payload.planReview.proposal;
    if (previous) {
      if (
        state.planReview?.status !== "awaiting_review" ||
        next.id !== previous.id ||
        next.revision !== previous.revision + 1
      ) {
        throw new Error(`Invalid plan revision in event ${event.eventId}`);
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
    if (payload.replacedTaskGraphId !== undefined) {
      if (
        typeof payload.replacedTaskGraphId !== "string" ||
        state.taskGraph?.id !== payload.replacedTaskGraphId ||
        state.taskGraph.status === "completed"
      ) {
        throw new Error(`Invalid replaced task DAG in event ${event.eventId}`);
      }
      state.taskGraph = undefined;
    }
    state.planReview = undefined;
    return;
  }

  throw new Error(`Unsupported plan review event ${event.type}`);
}
