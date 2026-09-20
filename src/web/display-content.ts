import type { WebEntry, WebEntryKind } from "../web-contracts.js";
import type { ProjectItem, ThreadItem } from "./api.js";

const conversationKinds = new Set<WebEntryKind>(["user", "assistant", "thinking", "tool", "diff", "plan"]);
const noticeKinds = new Set<WebEntryKind>(["info", "success", "warning", "error"]);

export function isConversationEntry(entry: WebEntry): boolean {
  return conversationKinds.has(entry.kind);
}

export function isNoticeEntry(entry: WebEntry): entry is WebEntry & { kind: "info" | "success" | "warning" | "error" } {
  return noticeKinds.has(entry.kind);
}

export function displayProject(
  threadId: string | undefined,
  workspaceRoot: string | undefined,
  threads: readonly ThreadItem[],
  projects: readonly ProjectItem[],
  selectedProjectId: string | undefined,
): ProjectItem | undefined {
  if (!threadId) return projects.find(project => project.id === selectedProjectId);
  const thread = threads.find(item => item.threadId === threadId);
  return projects.find(project => project.id === thread?.workspaceId || project.root === workspaceRoot);
}

export function displayTitle(
  threadId: string | undefined,
  project: ProjectItem | undefined,
  threads: readonly ThreadItem[],
): string {
  if (threadId) return threads.find(item => item.threadId === threadId)?.title ?? `Thread ${threadId.slice(0, 8)}`;
  return project?.name ?? "EASY CODE";
}
