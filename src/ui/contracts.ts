import type {
  AgentMode,
  ApprovalPolicyName,
  ApprovalRequest,
  ImageAttachment,
  PlanProposal,
  ProviderName,
  ThinkingEffort,
  ToolName,
  ToolPresentation,
} from "../core/types.js";
import type { SubagentView } from "../subagents/types.js";
import type { TaskGraphView } from "../tasks/task-graph.js";

/** Stable session facts rendered in the header and compact status line. */
export interface UISessionInfo {
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly mode: AgentMode;
  readonly provider: ProviderName;
  readonly model: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly approvalPolicy?: ApprovalPolicyName;
  /** Current context size when the provider exposes token accounting. */
  readonly contextTokens?: number;
  /** Model context limit when it is known. */
  readonly contextLimitTokens?: number;
}

export interface UIHeaderState {
  readonly title: string;
  readonly session: UISessionInfo | null;
}

export type UITranscriptKind =
  | "user"
  | "assistant"
  | "tool"
  | "info"
  | "success"
  | "warning"
  | "error"
  | "raw";

/**
 * One completed scrollback item. Items are only appended; the store may evict
 * the oldest items to keep the in-memory viewport bounded.
 */
export interface UITranscriptEntry {
  readonly kind: UITranscriptKind;
  readonly text: string;
  readonly id?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly timestamp?: string;
  readonly reasoning?: string;
  readonly images?: readonly Readonly<ImageAttachment>[];
  readonly toolName?: ToolName;
  readonly toolCallId?: string;
  readonly presentation?: ToolPresentation;
}

export type UIActivityKind = "model" | "tool" | "command" | "waiting" | "other";

/** Ephemeral work shown in the dynamic region instead of terminal scrollback. */
export interface UIActivityState {
  readonly id: string;
  readonly label: string;
  readonly kind?: UIActivityKind;
  readonly detail?: string;
  /** Epoch milliseconds supplied by the caller; the reducer never reads a clock. */
  readonly startedAt?: number;
}

export type UIProgressKind = "step" | "tool" | "status";
export type UIProgressStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "stopped";

/** One ephemeral Step/Tool/status row in the current turn's progress tree. */
export interface UIProgressItem {
  readonly id: string;
  readonly kind: UIProgressKind;
  readonly label: string;
  readonly status: UIProgressStatus;
  readonly detail?: string;
  readonly parentId?: string;
  readonly startedAt?: number;
}

export interface UILiveState {
  readonly activity: UIActivityState | null;
  readonly progress: readonly UIProgressItem[];
  readonly tasks: TaskGraphView | null;
  readonly subagents: readonly SubagentView[];
}

export interface UIOverlayRow {
  readonly label: string;
  readonly id?: string;
  readonly detail?: string;
  readonly disabled?: boolean;
}

interface UIOverlayPickerFields {
  readonly id?: string;
  readonly title: string;
  readonly rows: readonly UIOverlayRow[];
  readonly selectedIndex: number;
  readonly hint: string;
  readonly detail?: string;
}

/** Generic overlay used by model, resume, and other arrow-key pickers. */
export interface UIPickerOverlayState extends UIOverlayPickerFields {
  readonly kind: "picker";
}

/** Approval keeps the trusted Runtime request attached to its visible choices. */
export interface UIApprovalOverlayState extends UIOverlayPickerFields {
  readonly kind: "approval";
  readonly request: Readonly<ApprovalRequest>;
}

/** Plan review keeps the exact structured proposal attached to its choices. */
export interface UIPlanReviewOverlayState extends UIOverlayPickerFields {
  readonly kind: "plan-review";
  readonly proposal: Readonly<PlanProposal>;
  readonly feedback?: string;
}

export type UIOverlayState =
  | UIPickerOverlayState
  | UIApprovalOverlayState
  | UIPlanReviewOverlayState;

export interface UIComposerState {
  readonly text: string;
  /** UTF-16 offset into text, matching Node readline/string indexing. */
  readonly cursor: number;
  readonly busy: boolean;
  readonly placeholder: string;
  readonly images: readonly Readonly<ImageAttachment>[];
}

export interface UIState {
  readonly header: UIHeaderState;
  readonly transcript: readonly UITranscriptEntry[];
  readonly live: UILiveState;
  readonly overlay: UIOverlayState | null;
  readonly composer: UIComposerState;
}

export type UIHeaderPatch = Partial<UIHeaderState>;
export type UIComposerPatch = Partial<UIComposerState>;

/** Every terminal mutation enters the pure store through this event union. */
export type UIEvent =
  | { readonly type: "header.merge"; readonly patch: UIHeaderPatch }
  | { readonly type: "session.set"; readonly session: UISessionInfo | null }
  | { readonly type: "transcript.append"; readonly entry: UITranscriptEntry }
  | { readonly type: "activity.start"; readonly activity: UIActivityState }
  | { readonly type: "activity.stop"; readonly id?: string }
  | {
      readonly type: "progress.set";
      readonly progress: readonly UIProgressItem[];
    }
  | { readonly type: "progress.clear" }
  | { readonly type: "tasks.set"; readonly tasks: Readonly<TaskGraphView> }
  | { readonly type: "tasks.clear" }
  | {
      readonly type: "subagents.set";
      readonly subagents: readonly Readonly<SubagentView>[];
    }
  | { readonly type: "subagents.clear" }
  | { readonly type: "overlay.show"; readonly overlay: UIOverlayState }
  | { readonly type: "overlay.hide"; readonly id?: string }
  | { readonly type: "composer.patch"; readonly patch: UIComposerPatch }
  | { readonly type: "composer.reset" };
