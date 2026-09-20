import type { FileDiffPresentation, ImageAttachment, PlanProposal } from "./core/types.js";
import type { UISessionInfo, UIActivityKind, UIReviewPhase } from "./ui/contracts.js";
import type { TaskGraphView } from "./tasks/task-graph.js";
import type { SubagentView } from "./subagents/types.js";
import type { InteractionChoice } from "./ui/interaction-port.js";

export type WebEntryKind = "user" | "assistant" | "thinking" | "tool" | "info" | "success" | "warning" | "error" | "diff" | "plan";
export interface WebEntry {
  id: string;
  kind: WebEntryKind;
  text: string;
  images?: readonly Pick<ImageAttachment, "id" | "label" | "mediaType">[];
  diff?: FileDiffPresentation;
  timestamp: number;
}
export interface WebDecision {
  id: string;
  kind: "approval" | "choice" | "secret" | "plan";
  title: string;
  description?: string;
  choices?: readonly InteractionChoice[];
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
  | { kind: "entries.reset"; entries: readonly WebEntry[] }
  | { kind: "state"; state: Omit<WebView, "entries"> };
export interface WebChange { sequence: number; view: WebView; patch?: WebPatch }
