import type {
  AgentMode,
  ApprovalPolicyName,
  ApprovalRequest,
  CommandExecutionMode,
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
  readonly orchestrationEnabled?: boolean;
  readonly agentConcurrencyLimit?: number;
  readonly threadId: string;
  readonly projectId?: string;
  readonly workspaceRevision?: number;
  readonly workspaceFolders?: readonly { id: string; key: string; path: string }[];
  readonly workspaceRoot: string;
  readonly mode: AgentMode;
  readonly provider: ProviderName;
  readonly model: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly approvalPolicy?: ApprovalPolicyName;
  readonly commandExecutionMode?: CommandExecutionMode;
  readonly commandEnvironment?: "sandbox" | "host" | "container";
  /** Current context size when the provider exposes token accounting. */
  readonly contextTokens?: number;
  /** Model context limit when it is known. */
  readonly contextLimitTokens?: number;
  /** How the context window is used; absent when context is measured in characters. */
  readonly contextUsage?: ContextUsageReport;
}

/** A part of a model request, by what its tokens carry. */
export type ContextUsageCategory =
  "messages" | "systemPrompt" | "instructions" | "skills" | "memory" | "runtimeContext" | "systemTools" | "mcpTools";

/** Estimated tokens of each part of one request. */
export type ContextUsageCounts = Readonly<Record<ContextUsageCategory, number>>;

/** How the conversation uses the model's context window. */
export interface ContextUsageReport {
  readonly windowTokens: number;
  /** Messages are counted as they stand; the other parts as the latest request sent them. */
  readonly categories: ContextUsageCounts;
  /** Kept free for the response, tool results and estimation error. */
  readonly reservedTokens: number;
  /** Request size at which older history is compacted. */
  readonly compactionTokens: number;
  /** False until a request of this conversation is measured; until then only its messages are counted. */
  readonly measured: boolean;
}

export interface UIHeaderState {
  readonly title: string;
  readonly session: UISessionInfo | null;
}

export type UITranscriptKind = "user" | "assistant" | "tool" | "info" | "success" | "warning" | "error" | "raw";

/**
 * One completed scrollback item. Items remain in the local display until an
 * explicit screen clear or thread switch; model history is stored separately.
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
  /** An assistant entry that continues the answer above it, so it has no bullet of its own. */
  readonly continuation?: boolean;
  /** The one-line summary printed after a completed request. */
  readonly turnSummary?: TurnSummary;
}

/** One workspace file the turn created, edited or deleted. */
/** How a request left a file: new, changed, or removed. */
export type FileChangeKind = "created" | "modified" | "deleted";

/** Lines a request added to and removed from one file, net over all its edits. */
export interface TurnLineCounts {
  readonly added: number;
  readonly removed: number;
}

/** One region of a file's net change, with up to three unchanged lines around it. */
export interface TurnDiffHunk {
  /** First line of the region before and after the request, 1-based (0 for an empty side). */
  readonly oldStart: number;
  readonly newStart: number;
  /** Each line starts with " " (unchanged), "+" (added) or "-" (removed). */
  readonly lines: readonly string[];
}

export interface TurnFileDiff {
  readonly hunks: readonly TurnDiffHunk[];
  /** Lines were left out to keep the saved diff bounded; the counts still cover the whole change. */
  readonly truncated: boolean;
}

/** Where one file-tool call's diff is saved; the Web transcript loads it when the call is opened. */
export interface ToolDiffRef {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
}

export interface TurnChangedFile {
  /** Workspace-relative path, as shown to the user. */
  readonly path: string;
  readonly absolutePath: string;
  readonly change: FileChangeKind;
  /** Known when the file was changed through the file tools only. */
  readonly lines?: TurnLineCounts;
  /** The request's net change of the file was saved and can be opened (see TurnDiffStore). */
  readonly hasDiff?: boolean;
}

/** What one completed request cost and changed, shown after it. */
export interface TurnSummary {
  /** The request, for reading its saved diffs. */
  readonly threadId?: string;
  readonly turnId?: string;
  readonly durationMs: number;
  /** Provider-reported tokens across every model request of the turn; absent when none were reported. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly changedFiles: readonly TurnChangedFile[];
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

export type UIReviewPhase = "main_brief" | "independent_review";

/** Review is independent of transient model/tool spinners. */
export interface UIReviewState {
  readonly id: string;
  readonly startedAt: number;
  readonly phase: UIReviewPhase;
}

export type UIProgressKind = "step" | "tool" | "status";
export type UIProgressStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";

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
  readonly review: UIReviewState | null;
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

export type UIOverlayState = UIPickerOverlayState | UIApprovalOverlayState | UIPlanReviewOverlayState;

/** Composer chrome shared with the status bar; the Ink editor owns its own draft. */
export interface UIComposerState {
  /** Steering submissions accepted by the editor but not yet acknowledged. */
  readonly pendingSubmissions: number;
  readonly placeholder: string;
}

export interface UIState {
  readonly header: UIHeaderState;
  readonly transcript: readonly UITranscriptEntry[];
  readonly live: UILiveState;
  readonly composer: UIComposerState;
}

export type UIHeaderPatch = Partial<UIHeaderState>;
export type UIComposerPatch = Partial<UIComposerState>;

/** Every terminal mutation enters the pure store through this event union. */
export type UIEvent =
  | { readonly type: "header.merge"; readonly patch: UIHeaderPatch }
  | { readonly type: "session.set"; readonly session: UISessionInfo | null }
  | { readonly type: "transcript.append"; readonly entry: UITranscriptEntry }
  | {
      readonly type: "transcript.replace";
      readonly id: string;
      readonly entry: UITranscriptEntry;
    }
  | { readonly type: "activity.start"; readonly activity: UIActivityState }
  | { readonly type: "activity.stop"; readonly id?: string }
  | { readonly type: "review.set"; readonly review: UIReviewState }
  | { readonly type: "review.clear"; readonly id?: string }
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
  | { readonly type: "composer.patch"; readonly patch: UIComposerPatch }
  | { readonly type: "composer.reset" };
