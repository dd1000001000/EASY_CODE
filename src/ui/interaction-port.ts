import type {
  ApprovalDecision,
  ApprovalRequest,
  FileDiffPresentation,
  ImageAttachment,
  PlanProposal,
  ProviderName,
  ProviderStreamEvent,
  ThinkingEffort,
  UserQuestion,
  UserQuestionAnswer,
} from "../core/types.js";
import type { SlashArgumentSource } from "../cli/slash-suggestions.js";
import type { Language } from "../i18n/language.js";
import type { VisionSupport } from "../models/catalog.js";
import type { SubagentView } from "../subagents/types.js";
import type { TaskGraphView } from "../tasks/task-graph.js";
import type {
  ContextUsageReport,
  ToolDiffRef,
  TurnSummary,
  UIActivityKind,
  UIReviewPhase,
  UISessionInfo,
} from "./contracts.js";

export type { TurnChangedFile, TurnSummary } from "./contracts.js";

/** A submitted user message, independent of how its editor captured it. */
export interface UserSubmission {
  readonly text: string;
  readonly images: ImageAttachment[];
  readonly pasteErrors: string[];
}

export type PlanReviewDecision =
  { action: "approve" } | { action: "reject" } | { action: "adjust"; feedback: string } | { action: "defer" };

export interface PlanReviewInputOptions {
  readonly captureText?: (signal?: AbortSignal) => Promise<string | undefined>;
  readonly plan?: Readonly<PlanProposal>;
  readonly idleTimeoutMs?: number;
}

/**
 * One ask_user call on screen. `signal` withdraws it: the time ran out, the
 * user sent a message instead, or the request ended.
 */
export interface UserQuestionPrompt {
  readonly questions: readonly UserQuestion[];
  /** When the question closes by itself (epoch milliseconds), for a countdown. */
  readonly expiresAt: number;
  readonly signal: AbortSignal;
}

/** The answers; "skipped"; or undefined when `signal` withdrew the question. */
export type UserQuestionReply = readonly UserQuestionAnswer[] | "skipped" | undefined;

export interface InteractionChoice {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly disabled?: boolean;
}

/** Only approval choices opt into an unattended, request-scoped selection. */
export interface TimedChoiceOptions {
  readonly idleTimeoutMs: number;
  readonly idleChoiceId: string;
  readonly signal?: AbortSignal;
}

export interface ProviderSelectorChoice {
  readonly provider: ProviderName;
  readonly label: string;
  readonly apiKeyConfigured: boolean;
}

export interface ModelSelectorChoice {
  readonly id: string;
  readonly label: string;
  readonly vision?: VisionSupport;
}

export interface ThinkingEffortSelectorChoice {
  readonly id: ThinkingEffort;
  readonly label: string;
  readonly applied: boolean;
}

export interface CurrentRequestOptions {
  readonly onInterrupt?: () => void;
  readonly onSteer?: (submission: Readonly<UserSubmission>) => void | Promise<void>;
  readonly captureImage?: (index: number, signal?: AbortSignal) => Promise<ImageAttachment>;
  readonly captureText?: (signal?: AbortSignal) => Promise<string | undefined>;
  readonly initialImageCount?: number;
  readonly onDiscardImages?: (images: readonly Readonly<ImageAttachment>[]) => void | Promise<void>;
}

export interface CompletedTurnTiming {
  readonly startedAt: number;
  readonly completedAt: number;
}

export interface RequestInputOptions {
  readonly initialImageCount?: number;
  readonly captureImage: (index: number, signal?: AbortSignal) => Promise<ImageAttachment>;
  readonly captureText?: (signal?: AbortSignal) => Promise<string | undefined>;
  /** Session-dependent values offered in the slash-command menu. */
  readonly slashArguments?: SlashArgumentSource;
  /** Workspace-relative file paths offered after `@`. */
  readonly mentionPaths?: () => readonly string[];
}

/** Runtime-to-user notifications; no ANSI, stdin, or browser protocol here. */
export interface AgentPresentationPort {
  compactionProgress?(progress: import("./compaction.js").CompactionProgress): void;
  write(text: string): void;
  info(text: string): void;
  success(text: string): void;
  warning(text: string): void;
  error(text: string): void;
  status(text: string): void;
  toolCompleted(
    toolName: string,
    ok: boolean,
    summary?: string,
    error?: string,
    details?: readonly import("../core/types.js").ToolDisplayDetail[],
  ): void;
  threadTitleChanged?(title: string): void;
  /** A file tool changed a file; `saved` names the diff kept for the call that just completed. */
  fileDiff(presentation: FileDiffPresentation, saved?: ToolDiffRef): void;
  taskGraph(graph: Readonly<TaskGraphView>): void;
  showTaskGraphSnapshot(graph: Readonly<TaskGraphView>): void;
  clearTaskGraph(): void;
  subagents(
    agents: readonly Readonly<SubagentView>[],
    taskGraph?: Readonly<TaskGraphView>,
    concurrencyLimit?: number,
  ): void;
  showSubagentsSnapshot(
    agents: readonly Readonly<SubagentView>[],
    taskGraph?: Readonly<TaskGraphView>,
    concurrencyLimit?: number,
  ): void;
  modelStream(event: Readonly<ProviderStreamEvent>): void;
  addReasoning(text: string): number;
  restoreReasoning(texts: readonly string[]): number;
  showReasoning(id: number | "last"): boolean;
  showAdjustment(id: number | "last"): boolean;
  addQueuedAdjustment(sequence: number, text: string, images?: readonly Readonly<ImageAttachment>[]): void;
  peerMessage?(threadId: string, text: string, outgoing?: boolean): void;
  finalizeStreamedAnswer(text: string, timing?: Readonly<CompletedTurnTiming>): boolean;
  /** A request finished: its duration, token use and changed files. */
  turnCompleted?(summary: Readonly<TurnSummary>): void;
  /** Show how the context window is used, for `/context`. */
  contextUsage?(report: Readonly<ContextUsageReport>): void;
  startActivity(text: string, kind?: UIActivityKind, toolName?: string): string | undefined;
  stopActivity(activityId?: string): void;
  startReview(): string;
  updateReview(id: string, phase: UIReviewPhase): void;
  stopReview(id?: string): void;
}

/** Explicit decisions remain owned by the current interactive host. */
export interface AgentDecisionPort {
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Show the model's questions and wait for the user's answers. */
  askUser(prompt: Readonly<UserQuestionPrompt>): Promise<UserQuestionReply>;
  selectChoice(
    title: string,
    choices: readonly InteractionChoice[],
    initialId?: string,
    timed?: Readonly<TimedChoiceOptions>,
  ): Promise<string | undefined>;
  selectProvider(
    choices: readonly ProviderSelectorChoice[],
    initialProvider: ProviderSelectorChoice["provider"],
  ): Promise<ProviderSelectorChoice["provider"] | undefined>;
  selectModel(
    providerName: string,
    choices: readonly ModelSelectorChoice[],
    initialModel?: string,
  ): Promise<string | undefined>;
  selectThinkingEffort(
    providerName: string,
    model: string,
    choices: readonly ThinkingEffortSelectorChoice[],
    initialEffort: ThinkingEffort,
  ): Promise<ThinkingEffort | undefined>;
  readSecret(prompt: string): Promise<string>;
  showPlan(plan: Readonly<PlanProposal>): void;
  reviewPlan(options?: Readonly<PlanReviewInputOptions>): Promise<PlanReviewDecision>;
  withCancellableExternalOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** The existing CLI session lifecycle, kept separate from the Agent's decisions. */
export interface SessionInteractionPort {
  /** Set by the Web host, whose users change project folders in its project editor; unset in the CLI. */
  readonly surface?: "web";
  setLanguage?(language: Language): void;
  configureStreaming(limits: { streamFlushIntervalMs: number; streamPreviewMaxChars: number }): void;
  setContextTokensProvider(provider: (() => number) | undefined): void;
  isInteractive(): boolean;
  beginShell(session: Readonly<UISessionInfo>): boolean;
  isInlineShell(): boolean;
  setSessionInfo(session: Readonly<UISessionInfo>, announce?: boolean): void;
  showSessionHeader(): void;
  readPrompt(prompt: string, options: RequestInputOptions): Promise<UserSubmission | null>;
  setCurrentRequest(
    text: string,
    images?: readonly Readonly<ImageAttachment>[],
    options?: Readonly<CurrentRequestOptions>,
  ): void;
  clearCurrentRequest(): void;
  sealCurrentRequestSteering<T>(seal: () => T | undefined | Promise<T | undefined>): Promise<T | undefined>;
  resetForNewThread(session: Readonly<UISessionInfo>): void;
  clearScreen(): void;
  emergencyRestore(): void;
  close(): void;
}

export interface AppInteractionPort extends AgentPresentationPort, AgentDecisionPort, SessionInteractionPort {}
