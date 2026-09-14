/**
 * The complete journal vocabulary for the current development protocol.
 * Producers and recovery share this closed set; unknown spellings are never
 * treated as forward- or backward-compatible state.
 */
export const CURRENT_JOURNAL_EVENT_TYPES = [
  "approval.decided",
  "approval.mode_changed",
  "approval.reviewed",
  "approval.user_required",
  "command.approval_prefix_granted",
  "command.approval_prefix_revoked",
  "command.audit.recorded",
  "command.boundary_grant_consumed",
  "command.boundary_intervention",
  "command.boundary_state_failed",
  "command.capability_rejected",
  "command.cleanup_complete",
  "command.cleanup_error",
  "command.cleanup_requested",
  "command.execution_exited",
  "command.execution_request_sent",
  "command.finished",
  "command.host_escalation_requested",
  "command.preparing",
  "command.request_normalized",
  "command.ready",
  "command.sandbox_boundary_violation",
  "command.sandbox_error",
  "command.stage",
  "command.target_spawn_error",
  "command.target_started",
  "command.validation.standard",
  "completion.rejected",
  "completion.resolved",
  "context.compaction.abandoned",
  "context.compaction.accepted",
  "context.compaction.attempt",
  "context.compaction.candidate",
  "context.compaction.committed",
  "context.compaction.fallback",
  "context.compaction.prepared",
  "context.compaction.rejected",
  "context.compaction.requested",
  "context.compaction.snapshot",
  "context.compaction.started",
  "context.compaction.transport_failed",
  "context.history.evicted",
  "context.maintenance.checked",
  "context.memory.gated",
  "context.memory.selected",
  "context.phase.closed",
  "context.reconciled",
  "context.server_reset",
  "context.summary.response",
  "delivery.required",
  "memory.commit_failed",
  "memory.committed",
  "memory.discarded",
  "message.assistant",
  "message.assistant.synthetic",
  "message.recorded",
  "message.user",
  "message.user.synthetic",
  "mode.auto_direct_response",
  "mode.auto_route",
  "mode.review_override",
  "model.api_attempt",
  "model.attempt.steering_interrupted",
  "model.error",
  "model.output.captured",
  "model.usage",
  "network.authorization",
  "network.connection",
  "plan.approved",
  "plan.execution_returned_to_review",
  "plan.execution_started",
  "plan.feedback_submitted",
  "plan.rejected",
  "progress.review.completed",
  "progress.review.model_request.finished",
  "progress.review.model_request.started",
  "progress.review.requested",
  "progress.review.stale",
  "progress.review.started",
  "progress.review.unavailable",
  "progress.validation.baseline",
  "reasoning",
  "review.actor.event",
  "review.session.event",
  "review.unavailable",
  "runtime.task_budget",
  "subagent.artifact",
  "subagent.collected",
  "subagent.environment_bound",
  "subagent.handoff_completed",
  "subagent.handoff_failed",
  "subagent.handoff_requested",
  "subagent.progress",
  "subagent.reconciled",
  "subagent.result",
  "subagent.session_bound",
  "thread.checkpoint.updated",
  "thread.created",
  "tool.call",
  "tool.catalog.bound",
  "tool.result",
  "turn.completed",
  "turn.recovered",
  "turn.started",
  "turn.steering.applied",
  "turn.steering.queued",
  "turn.steering.sealed",
] as const;

export type JournalEventType = (typeof CURRENT_JOURNAL_EVENT_TYPES)[number];
export type CommandJournalEventType = Extract<
  JournalEventType,
  `command.${string}` | `network.${string}`
>;
export type ContextCompactionJournalEventType = Extract<
  JournalEventType,
  `context.compaction.${string}`
>;

const CURRENT_JOURNAL_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  CURRENT_JOURNAL_EVENT_TYPES,
);

export function isJournalEventType(value: unknown): value is JournalEventType {
  return typeof value === "string" && CURRENT_JOURNAL_EVENT_TYPE_SET.has(value);
}

export function assertJournalEventType(value: unknown): asserts value is JournalEventType {
  if (!isJournalEventType(value)) {
    throw new Error(`Unsupported current journal event type: ${String(value)}`);
  }
}
