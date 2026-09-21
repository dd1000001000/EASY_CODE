import type { WebEntry, WebEntryKind } from "../web-contracts.js";
import type { ProjectItem, ThreadItem } from "./api.js";

const conversationKinds = new Set<WebEntryKind>(["user", "assistant", "thinking", "tool", "plan"]);
const noticeKinds = new Set<WebEntryKind>(["info", "success", "warning", "error"]);

export function isConversationEntry(entry: WebEntry): boolean {
  return conversationKinds.has(entry.kind);
}

export function isNoticeEntry(entry: WebEntry): entry is WebEntry & { kind: "info" | "success" | "warning" | "error" } {
  return noticeKinds.has(entry.kind);
}

export { toolRunContinuesAcross } from "../web-tool-run.js";

export type ConversationDisplayItem =
  | { kind: "entry"; id: string; entry: WebEntry }
  | { kind: "tool-group"; id: string; tools: readonly WebEntry[] };

/** Group adjacent logical tool calls for the Web transcript only. */
export function groupConversationTools(entries: readonly WebEntry[]): ConversationDisplayItem[] {
  const items: ConversationDisplayItem[] = [];
  let tools: WebEntry[] = [];
  const flushTools = (): void => {
    if (tools.length === 1) items.push({ kind: "entry", id: tools[0]!.id, entry: tools[0]! });
    else if (tools.length > 1) items.push({ kind: "tool-group", id: `tool-group:${tools[0]!.id}`, tools });
    tools = [];
  };
  for (const entry of entries) {
    if (entry.kind === "tool") tools.push(entry);
    else {
      flushTools();
      items.push({ kind: "entry", id: entry.id, entry });
    }
  }
  flushTools();
  return items;
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
