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

export { toolRunContinuesAcross, turnContinuesAcross } from "../web-tool-run.js";

export type ConversationDisplayItem =
  | { kind: "entry"; id: string; entry: WebEntry }
  | { kind: "tool-group"; id: string; tools: readonly WebEntry[] };

export interface ConversationTurnDisplay {
  id: string;
  status: "running" | "finalizing" | "completed";
  request?: WebEntry;
  /** Flat, current-order rows shown while a turn is running. */
  liveItems: readonly ConversationDisplayItem[];
  /** Everything except the initial request and accepted final answer. */
  processItems: readonly ConversationDisplayItem[];
  finalAnswer?: WebEntry;
  startedAt: number;
  completedAt?: number;
}

export interface ViewportRange { top: number; bottom: number }
export interface ViewportUserMessage extends ViewportRange { id: string }
export interface ViewportConversationTurn extends ViewportRange { requestId?: string }

function intersectsViewport(item: ViewportRange, viewport: ViewportRange): boolean {
  return item.bottom > viewport.top && item.top < viewport.bottom;
}

/** Resolve the user-message rail marker for the content currently being read. */
export function activeMessageIdsForViewport(
  viewport: ViewportRange,
  users: readonly ViewportUserMessage[],
  turns: readonly ViewportConversationTurn[],
): string[] {
  const visibleUsers = users.filter(user => intersectsViewport(user, viewport)).map(user => user.id);
  if (visibleUsers.length) return visibleUsers;

  const visibleTurns = turns.filter(turn => turn.requestId && intersectsViewport(turn, viewport));
  if (visibleTurns.length) {
    const containingTop = visibleTurns
      .filter(turn => turn.top <= viewport.top && turn.bottom > viewport.top)
      .sort((left, right) => right.top - left.top)[0];
    const nearest = containingTop ?? [...visibleTurns].sort((left, right) => left.top - right.top)[0];
    if (nearest?.requestId) return [nearest.requestId];
  }

  const nearestAbove = users
    .filter(user => user.bottom <= viewport.top)
    .sort((left, right) => right.bottom - left.bottom)[0];
  if (nearestAbove) return [nearestAbove.id];
  const nearestBelow = users
    .filter(user => user.top >= viewport.bottom)
    .sort((left, right) => left.top - right.top)[0];
  return nearestBelow ? [nearestBelow.id] : [];
}

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

/** Project entries into Runtime turns without guessing from assistant-message position. */
export function groupConversationTurns(entries: readonly WebEntry[]): ConversationTurnDisplay[] {
  const grouped = new Map<string, WebEntry[]>();
  for (const entry of entries) {
    const id = entry.turnId ?? `unowned:${entry.id}`;
    const existing = grouped.get(id);
    if (existing) existing.push(entry);
    else grouped.set(id, [entry]);
  }
  return [...grouped].map(([id, turnEntries]) => {
    const request = turnEntries.find(entry => entry.kind === "user");
    const finalAnswer = [...turnEntries].reverse().find(entry =>
      entry.kind === "assistant" && (entry.answerState === "finalizing" || entry.answerState === "confirmed"));
    const terminal = turnEntries.find(entry => entry.turnCompletedAt !== undefined);
    const completedAt = terminal?.turnCompletedAt;
    const processEntries = turnEntries.filter(entry => entry !== request && entry !== finalAnswer);
    return {
      id,
      status: completedAt !== undefined ? "completed" : finalAnswer ? "finalizing" : "running",
      ...(request ? { request } : {}),
      liveItems: groupConversationTools(turnEntries),
      processItems: groupConversationTools(processEntries),
      ...(finalAnswer ? { finalAnswer } : {}),
      startedAt: terminal?.turnStartedAt ?? turnEntries.find(entry => entry.turnStartedAt !== undefined)?.turnStartedAt ?? turnEntries[0]?.timestamp ?? 0,
      ...(completedAt !== undefined ? { completedAt } : {}),
    };
  });
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
