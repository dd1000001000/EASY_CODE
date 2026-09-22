import type { ImageAttachment, PlanProposal, ToolDisplayDetail } from "./core/types.js";
import type { UISessionInfo, UIActivityKind, UIReviewPhase } from "./ui/contracts.js";
import type { TaskGraphView } from "./tasks/task-graph.js";
import type { SubagentView } from "./subagents/types.js";
import type { InteractionChoice } from "./ui/interaction-port.js";
import type { ThreadResourceAttachment } from "./resources/types.js";

export type WebEntryKind = "user" | "assistant" | "thinking" | "tool" | "info" | "success" | "warning" | "error" | "plan";
export type WebAnswerState = "streaming" | "finalizing" | "confirmed";
export interface WebEntry {
  id: string;
  kind: WebEntryKind;
  text: string;
  /** Durable Runtime turn ownership. Conversation entries always carry this in the current protocol. */
  turnId?: string;
  /** Wall-clock start of the owning turn, repeated to keep paged transcript fragments self-contained. */
  turnStartedAt?: number;
  /** Wall-clock terminal time. Present on the final answer, or the last process row if no answer exists. */
  turnCompletedAt?: number;
  /** Presentation state for assistant output; only Runtime completion may set confirmed. */
  answerState?: WebAnswerState;
  toolName?: string;
  toolStatus?: "running" | "completed" | "failed";
  images?: readonly Pick<ImageAttachment, "id" | "label" | "mediaType">[];
  resources?: readonly Pick<ThreadResourceAttachment, "id" | "filename" | "kind" | "mediaType" | "uri">[];
  toolDetails?: readonly ToolDisplayDetail[];
  timestamp: number;
}
export interface WebHistoryMarker { id: string; preview: string }
export interface WebHistoryState {
  epoch: string;
  hasEarlier: boolean;
  markers: readonly WebHistoryMarker[];
}
export interface WebHistoryPage {
  entries: readonly WebEntry[];
  hasEarlier: boolean;
  hasLater: boolean;
}
export interface WebDecision {
  id: string;
  kind: "approval" | "choice" | "secret" | "plan";
  title: string;
  description?: string;
  choices?: readonly InteractionChoice[];
  initialId?: string;
  plan?: PlanProposal;
}
export interface WebView {
  session: UISessionInfo | null;
  entries: readonly WebEntry[];
  tasks: TaskGraphView | null;
  subagents: readonly SubagentView[];
  activities: readonly { id: string; text: string; kind?: UIActivityKind }[];
  review: { id: string; phase: UIReviewPhase; startedAt: number } | null;
  decision: WebDecision | null;
  busy: boolean;
}
export type WebPatch =
  | { kind: "entry.append"; entry: WebEntry }
  | { kind: "entry.replace"; entry: WebEntry }
  | { kind: "entries.reset"; entries: readonly WebEntry[]; history?: WebHistoryState }
  | { kind: "thread.title"; threadId: string; title: string }
  | { kind: "state"; state: Omit<WebView, "entries"> };
export interface WebChange { sequence: number; view: WebView; patch?: WebPatch }
