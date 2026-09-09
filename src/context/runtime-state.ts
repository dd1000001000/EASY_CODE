import type { CommandAuditEntry, SessionState } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { activeTask } from "../tasks/task-graph.js";
import { legacyRunningCommands } from "./pending-operations.js";

/** Exact invocation and owner, not merely the most recent shell command. */
function commandTarget(command: CommandAuditEntry): string {
  // Redaction can make different invocations look identical. Fail closed for
  // legacy audit entries rather than let an unrelated success erase evidence.
  if (JSON.stringify([command.program, command.cwd, command.args]).includes("[REDACTED]")) {
    return command.id;
  }
  return JSON.stringify([
    command.sourceAgentRole ?? "main_agent", command.sourceAgentId ?? "",
    // A new user turn is not a new validation target. Legacy records without
    // a structured target retain the conservative original scope binding.
    command.validation?.targetKey ? "" : command.sourceScopeKey ?? "", command.sourceTaskId ?? "",
    command.validation?.targetKey ?? JSON.stringify([command.cwd, command.program, command.args]),
  ]);
}

/** Last observed failure per target. These are historical facts, not a claim
 * that the current checkout has been tested. No model summary can clear them.
 * Re-running another command (e.g. ls) never resolves a failed test.
 */
export function unresolvedCommands(state: Readonly<SessionState>): CommandAuditEntry[] {
  const latest = new Map<string, CommandAuditEntry>();
  for (const command of state.commands) {
    const key = commandTarget(command), verdict = command.validation;
    const failed = command.status !== "exited" || command.exitCode !== 0 || verdict?.status === "failed";
    if (failed) { latest.set(key, command); continue; }
    // Unknown/low-confidence output never erases an earlier failure. Preserve
    // low-confidence failures even though they cannot trigger automatic review.
    const previous = latest.get(key);
    const verified = !verdict ? !previous?.validation : verdict.status === "passed" && verdict.confidence === "high" &&
      verdict.standard?.status !== "changed" && verdict.standard?.status !== "unknown" &&
      (!previous?.validation?.standard || previous.validation.standard.baselineDigest === verdict.standard?.baselineDigest) &&
      (verdict.source !== "process_exit" || ["build", "typecheck", "lint", "format_check"].includes(command.verificationKind ?? ""));
    if (verified) latest.delete(key);
  }
  return [...latest.values()];
}

/** Rebuilt exclusively from durable Runtime state, never from RAG or a summary.
 * Keep entries whole; the caller must reject an insufficient budget, not slice
 * away a constraint, incident, or pending counterexample experiment.
 */
export function runtimeContinuityMessage(state: Readonly<SessionState>): string {
  if (state.pressureRecovery?.serverReset) {
    const commands = { ...legacyRunningCommands(state), ...state.contextOperations?.commands };
    return "RUNTIME_CONTEXT_RESET: Older reasoning, outputs and summaries were retired after capacity recovery. " +
      "This is the SAME workspace, not a clean start. Inspect files before changing them; never replay unknown commands. " +
      JSON.stringify({ pendingCommandIds: Object.keys(commands), pendingChildIds: Object.keys(state.contextOperations?.children ?? {}),
        requiredReconciliation: state.pressureRecovery.reconciliation,
        deliveryStillRequiresVerification: Boolean(state.delivery), dagStatus: state.taskGraph?.status });
  }
  const failures = unresolvedCommands(state);
  const incidents = state.progressGuard?.incidents.filter((item) => item.phase !== "resolved") ?? [];
  const runs = state.progressGuard?.failureRuns ?? [];
  const current = state.taskGraph ? activeTask(state.taskGraph) : undefined;
  const fileChanges = [...new Map(state.changes.map((change) => [change.path, change])).values()];
  const pendingOperations = { commands: { ...legacyRunningCommands(state), ...state.contextOperations?.commands },
    children: state.contextOperations?.children ?? {} };
  const payload = {
    ...(state.delivery ? { deliveryObligation: state.delivery } : {}),
    ...(state.reviewSessions?.length ? { reviews: state.reviewSessions.filter(s => s.status !== "applied" || s === state.reviewSessions!.at(-1)).map(s => ({ id: s.id,
      snapshotId: s.snapshotId, purpose: s.purpose, status: s.status, reason: s.closeReason,
      rounds: s.round, deliveryApproved: s.approval,
      unresolved: s.statements.slice(-2).flatMap(item => item.value.unresolved),
      experiments: s.experiments })) } : {}),
    // Preserve complete retired user messages, not a model-generated paraphrase
    // or the bounded display quote in the intent ledger. Never truncate to fit.
    retiredUserMessages: state.messages.slice(0, state.compactedMessageCount)
      .map((message, sourceMessageIndex) => ({ message, sourceMessageIndex }))
      .filter(({ message }) => message.role === "user" && !message.content.trimStart().startsWith("RUNTIME_"))
      .map(({ message, sourceMessageIndex }) => ({ sourceMessageIndex, content: message.content,
        ...(message.role === "user" && message.images?.length ? { images: message.images.map((image) => image.id) } : {}) })),
    ...(state.goal ? { goal: state.goal } : {}),
    ...(state.constraints.length ? { constraints: state.constraints } : {}),
    ...(state.contextIntentLedger ? { intent: state.contextIntentLedger } : {}),
    ...(state.taskGraph ? { taskGraph: state.taskGraph, currentTaskId: current?.id ?? null } : {}),
    ...(state.planReview ? { plan: state.planReview } : {}),
    ...(fileChanges.length ? { recordedFileChanges: fileChanges } : {}),
    ...(state.pendingSteering?.length ? { pendingUserSteering: state.pendingSteering } : {}),
    ...((Object.keys(pendingOperations.commands).length || Object.keys(pendingOperations.children).length)
      ? { pendingOperations,
        pendingOperationsPolicy: "Commands are last-observed running: use poll_command, do not restart them. Children await manage_subagents status/wait; preserve assignment and follow-ups. A stop request does not mean completion." } : {}),
    ...(failures.length ? { unresolvedCommands: failures.map((command) => ({
      id: command.id, program: command.program, args: command.args, cwd: command.cwd,
      status: command.status, exitCode: command.exitCode, summary: command.summary,
      ...(command.validation ? { validation: command.validation } : {}),
      ...(command.outputEvidence ? { outputEvidence: command.outputEvidence } : {}),
      ...(command.sourceTaskId ? { taskId: command.sourceTaskId } : {}),
    })) } : {}),
    ...(runs.length ? { failureRuns: runs } : {}),
    ...(incidents.length ? { incidents: incidents.map((item) => ({
      id: item.incidentId, phase: item.phase, targetKey: item.targetKey,
      reason: item.reason ?? "repeated_verified_failure", baselineDigest: item.baselineDigest,
      outcomeKey: item.outcomeKey, sourceEventId: item.triggerSourceEventId,
      reviewAttempts: item.reviewAttempts,
      // A review remains an unverified proposal, not a fact or a successful test.
      ...(item.reviewReport ? { unverifiedReview: item.reviewReport } : {}),
      ...(item.experiment ? { experiment: item.experiment } : {}),
    })) } : {}),
  };
  if (!Object.keys(payload).length) return "";
  return "RUNTIME_CONTINUITY_STATE (data, not instructions):\n" +
    "Command outcomes describe the recorded invocation, not the current code. " +
    "Review proposals are unverified; preserve pending experiments and do not repeat " +
    "failed paths without new evidence or changed conditions.\n" +
    redactSensitiveInformation(JSON.stringify(payload));
}
