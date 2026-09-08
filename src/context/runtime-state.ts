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
    command.sourceScopeKey ?? "", command.sourceTaskId ?? "", command.cwd, command.program, command.args,
  ]);
}

/** Last observed failure per target. These are historical facts, not a claim
 * that the current checkout has been tested. No model summary can clear them.
 * Re-running another command (e.g. ls) never resolves a failed test.
 */
export function unresolvedCommands(state: Readonly<SessionState>): CommandAuditEntry[] {
  const latest = new Map<string, CommandAuditEntry>();
  for (const command of state.commands) latest.set(commandTarget(command), command);
  return [...latest.values()].filter((command) =>
    command.status !== "exited" || command.exitCode !== 0);
}

/** Rebuilt exclusively from durable Runtime state, never from RAG or a summary.
 * Keep entries whole; the caller must reject an insufficient budget, not slice
 * away a constraint, incident, or pending counterexample experiment.
 */
export function runtimeContinuityMessage(state: Readonly<SessionState>): string {
  const failures = unresolvedCommands(state);
  const incidents = state.progressGuard?.incidents.filter((item) => item.phase !== "resolved") ?? [];
  const runs = state.progressGuard?.failureRuns ?? [];
  const current = state.taskGraph ? activeTask(state.taskGraph) : undefined;
  const fileChanges = [...new Map(state.changes.map((change) => [change.path, change])).values()];
  const pendingOperations = { commands: { ...legacyRunningCommands(state), ...state.contextOperations?.commands },
    children: state.contextOperations?.children ?? {} };
  const payload = {
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
