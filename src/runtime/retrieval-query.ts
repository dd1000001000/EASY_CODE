import type { SessionState } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { activeTask } from "../tasks/task-graph.js";

/**
 * The query for layered context retrieval: the current request, goal, constraints and active task, the latest
 * tool or command failure, recent diff and path evidence and the recent conversation, redacted and bounded.
 */
export function contextRetrievalQuery(state: Readonly<SessionState>, currentUserInput: string): string {
  const task = state.taskGraph ? activeTask(state.taskGraph) : undefined;
  const blockedTask = state.taskGraph?.tasks.find((candidate) => candidate.status === "blocked");
  const latestCommand = state.commands.at(-1);
  const latestFailedCommand =
    latestCommand && (latestCommand.status !== "exited" || latestCommand.exitCode !== 0) ? latestCommand : undefined;
  let latestToolFailure = "";
  const recentToolPathEvidence: string[] = [];
  const observedToolNames = new Set<string>();
  const earliestToolMessageIndex = Math.max(0, state.messages.length - 64);
  for (let index = state.messages.length - 1; index >= earliestToolMessageIndex; index -= 1) {
    const message = state.messages[index];
    if (!message || message.role !== "tool") continue;
    const toolName = message.name ?? "unknown";
    const isLatestForTool = !observedToolNames.has(toolName);
    observedToolNames.add(toolName);
    try {
      const parsed = JSON.parse(message.content) as {
        ok?: unknown;
        summary?: unknown;
        error?: unknown;
        data?: unknown;
      };
      const data =
        parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : undefined;
      const path = typeof data?.path === "string" ? data.path : "";
      const beforeHash = typeof data?.beforeHash === "string" ? data.beforeHash : "";
      const contentHash = typeof data?.contentHash === "string" ? data.contentHash : "";
      if (path && recentToolPathEvidence.length < 6) {
        recentToolPathEvidence.push(
          [toolName, path, beforeHash ? `before=${beforeHash}` : "", contentHash ? `after=${contentHash}` : ""]
            .filter(Boolean)
            .join(" "),
        );
      }
      if (!latestToolFailure && isLatestForTool && (parsed.ok === false || typeof parsed.error === "string")) {
        latestToolFailure = [
          `tool=${toolName}`,
          typeof parsed.summary === "string" ? parsed.summary : "",
          typeof parsed.error === "string" ? parsed.error : "",
          path ? `path=${path}` : "",
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 2_500);
      }
    } catch {
      // Opaque tool output remains available in recent conversation/RAG; only
      // structured evidence is promoted into the high-priority query fields.
    }
  }
  const latestFailure = [
    latestToolFailure,
    latestFailedCommand
      ? [
          `command=${latestFailedCommand.program}`,
          `status=${latestFailedCommand.status}`,
          `exitCode=${String(latestFailedCommand.exitCode)}`,
          latestFailedCommand.summary,
          `cwd=${latestFailedCommand.cwd}`,
        ].join("\n")
      : "",
    blockedTask?.blockerDetails ? `blockedTask=${blockedTask.id}\n${blockedTask.blockerDetails.reason}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4_000);
  const diffAndPathEvidence = [
    ...state.changes
      .slice(-12)
      .map((change) =>
        [
          `${change.operation}:${change.path}`,
          `status=${change.status}`,
          change.beforeHash ? `before=${change.beforeHash}` : "",
          change.afterHash ? `after=${change.afterHash}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      ),
    ...recentToolPathEvidence,
    ...[...state.filesRead.values()].slice(-8).map((file) => `read:${file.path} hash=${file.hash}`),
  ]
    .join("\n")
    .slice(0, 4_000);
  const recentConversation = state.messages
    .slice(-8)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => message.content?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
  return [
    currentUserInput.trim() ? `[CURRENT_REQUEST]\n${currentUserInput.trim().slice(0, 4_000)}` : "",
    state.goal?.trim() ? `[CURRENT_GOAL]\n${state.goal.trim().slice(0, 2_500)}` : "",
    state.constraints.length ? `[CURRENT_CONSTRAINTS]\n${state.constraints.join("\n").slice(0, 2_500)}` : "",
    task
      ? `[ACTIVE_TASK]\n${task.title}\n${task.description}\n` +
        `${task.completionChecks.join("\n")}\n${task.blockerDetails?.reason ?? ""}`
      : "",
    latestFailure ? `[LATEST_FAILURE]\n${latestFailure}` : "",
    diffAndPathEvidence ? `[CURRENT_DIFF_AND_PATH_EVIDENCE]\n${diffAndPathEvidence}` : "",
    recentConversation ? `[RECENT_CONVERSATION]\n${recentConversation}` : "",
  ]
    .filter(Boolean)
    .map((section) => redactSensitiveInformation(section))
    .join("\n\n")
    .slice(0, 12_000);
}
