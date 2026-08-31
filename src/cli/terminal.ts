import readline from "node:readline";
import chalk from "chalk";
import { sanitizeCommandOutput } from "../command/output-stream.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  FileDiffPresentation,
  ImageAttachment,
  PlanProposal,
  ThinkingEffort,
} from "../core/types.js";
import { selectApproval } from "./approval-selector.js";
import {
  formatPlanProposal,
  sanitizePlanText,
} from "../plans/plan.js";
import { readSecretInput } from "../config/secret-input.js";
import { renderFileDiff } from "./file-diff.js";
import {
  PrivateOscInputFilter,
  readPrompt,
  VSCODE_IMAGE_PASTE_SEQUENCE,
  type PromptInput,
  type PromptInputSession,
  type PromptSubmission,
} from "./prompt-input.js";
import {
  ReasoningRegistry,
  renderReasoningBody,
  renderReasoningHistoryMarker,
  renderReasoningMarker,
  type ReasoningBlock,
} from "./reasoning.js";
import {
  AdjustmentRegistry,
  renderAdjustmentBody,
  renderAdjustmentMarker,
  type AdjustmentBlock,
} from "./adjustment.js";
import {
  selectModel,
  selectProvider,
  selectThinkingEffort,
  type ModelSelectorInput,
  type ModelSelectorOutput,
  type ModelSelectorChoice,
  type ProviderSelectorChoice,
  type ThinkingEffortSelectorChoice,
} from "./model-selector.js";
import { renderTaskGraph } from "./task-graph.js";
import type { TaskGraphView } from "../tasks/task-graph.js";
import { renderSubagents } from "./subagents.js";
import type { SubagentView } from "../subagents/types.js";
import {
  renderMenu,
  selectMenuIndex,
  type MenuSelectorOverlay,
} from "./menu-selector.js";
import { createVsCodeMenuBridge } from "./vscode-menu-bridge.js";
import type {
  UIActivityKind,
  UIOverlayState,
  UIProgressItem,
  UISessionInfo,
  UITranscriptKind,
  UITranscriptEntry,
} from "../ui/contracts.js";
import { applyEvent, createUIState } from "../ui/store.js";
import { ScreenWriter } from "../ui/render/screen-writer.js";
import {
  FullScreenWriter,
  applyDisclosureViewCommand,
  createDisclosureViewState,
  layoutVirtualDocument,
  renderDisclosureView,
  replaceDisclosureViewNodes,
  resizeDisclosureView,
  updateDisclosureViewChrome,
  type DisclosureViewFrame,
  type DisclosureViewState,
  type DisclosureViewTarget,
  type VirtualDocumentNode,
} from "../ui/tui/index.js";
import {
  TuiInputCore,
  type TuiInputEvent,
} from "./tui-input.js";
import {
  displayWidth,
  stripAnsi,
  truncateToWidth,
  wrapToWidth,
} from "../ui/render/layout.js";
import {
  renderComposerStatusRegion,
  renderLiveRegion,
  renderSessionHeader,
} from "../ui/render/view.js";

export type PlanReviewDecision =
  | { action: "approve" }
  | { action: "reject" }
  | { action: "adjust"; feedback: string }
  | { action: "defer" };

export interface PlanReviewInputOptions {
  /** Read clipboard text when a terminal sends a paste hotkey to EASY CODE. */
  readonly captureText?: (
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
}

export interface TerminalChoice {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly disabled?: boolean;
}

export interface CurrentRequestOptions {
  /** Preserve Ctrl+C cancellation while the busy UI owns stdin in raw mode. */
  readonly onInterrupt?: () => void;
  /** Queue one user-authored adjustment without ending the busy editor. */
  readonly onSteer?: (
    submission: Readonly<PromptSubmission>,
  ) => void | Promise<void>;
  readonly captureImage?: (
    index: number,
    signal?: AbortSignal,
  ) => Promise<ImageAttachment>;
  readonly captureText?: (
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  /** Last image number already allocated in the Thread. */
  readonly initialImageCount?: number;
  /** Release images whose draft markers were removed or cancelled. */
  readonly onDiscardImages?: (
    images: readonly Readonly<ImageAttachment>[],
  ) => void | Promise<void>;
}

interface BusyInputOwner {
  readonly filter: PrivateOscInputFilter;
  readonly wasRaw: boolean;
  readonly wasFlowing: boolean;
  readonly onError: () => void;
}

interface MutableTurnSegment {
  readonly entry: Readonly<UITranscriptEntry>;
  readonly reasoning?: Readonly<ReasoningBlock>;
  readonly adjustment?: Readonly<AdjustmentBlock>;
}

type DisclosureKind = "thinking" | "adjustment";

interface ActiveDisclosureViewer {
  readonly writer: FullScreenWriter;
  readonly input: TuiInputCore;
  state: DisclosureViewState;
  frame: DisclosureViewFrame;
  kind: DisclosureKind;
  registryId: number;
  readonly suspendedSession?: PromptInputSession;
  /** The readline lifecycle ended while its alternate-screen view was open. */
  sessionReleased: boolean;
  readonly wasRaw: boolean;
  readonly wasFlowing: boolean;
  readonly onData: (chunk: Buffer | string) => void;
  readonly onError: () => void;
  readonly deferredCommits: string[];
  idleTimer?: NodeJS.Timeout;
  closing: boolean;
}

type StableStatusKind = Extract<
  UITranscriptKind,
  "info" | "success" | "warning" | "error"
>;

type StatusPresentation =
  | { readonly destination: "live"; readonly kind: UIProgressItem["kind"] }
  | { readonly destination: "stable"; readonly kind: StableStatusKind };

/**
 * Runtime status defaults to durable scrollback. Only the finite, audited set
 * of in-flight messages is allowed into the replaceable live region, so a new
 * warning cannot silently disappear merely because it arrived through
 * `onStatus`.
 */
function classifyStatus(text: string): StatusPresentation {
  if (/^Tool:\s*\S/iu.test(text)) {
    return { destination: "live", kind: "tool" };
  }
  if (/^Step\s+\d+\/\d+:?\s*requesting\b/iu.test(text)) {
    return { destination: "live", kind: "step" };
  }
  if (
    /^Auto mode is choosing how to handle this request\.\.\.$/iu.test(text) ||
    /^Pre-route context compaction\s+\d+\/\d+:/iu.test(text) ||
    /^Reserved (?:one correction step for required context compaction|one continuation step after required context compaction|\d+ finalization step\(s\) after memory maintenance|one final response step after the task DAG reached a terminal state)\.$/iu.test(text)
  ) {
    return { destination: "live", kind: "status" };
  }

  if (
    /^Context utilization is\b/iu.test(text) ||
    /^Ignored\b/iu.test(text) ||
    /^The (?:model|child) (?:did not|attempted|violated)\b/iu.test(text) ||
    /^Model usage accounting could not be saved\b/iu.test(text) ||
    /^Long-term memory maintenance was not saved\b/iu.test(text)
  ) {
    return { destination: "stable", kind: "warning" };
  }
  if (/^(?:Context utilization returned below|Context compacted|Committed\b)/iu.test(text)) {
    return { destination: "stable", kind: "success" };
  }
  if (/^Auto mode (?:review transition|selected|answered directly)\b/iu.test(text)) {
    return { destination: "stable", kind: "info" };
  }
  if (/\b(?:error|failed|failure|fatal)\b/iu.test(text)) {
    return { destination: "stable", kind: "error" };
  }
  return { destination: "stable", kind: "info" };
}

export class Terminal {
  private static readonly ACTIVITY_FRAMES = [
    "⠋",
    "⠙",
    "⠹",
    "⠸",
    "⠼",
    "⠴",
    "⠦",
    "⠧",
    "⠇",
    "⠏",
  ] as const;
  private static readonly ACTIVITY_INTERVAL_MS = 80;

  private rl?: readline.Interface;
  private closed = false;
  private promptActive = false;
  private guardedInputActive = false;
  private activePromptController?: AbortController;
  private readlineInputFilter?: PrivateOscInputFilter;
  private currentRequestOptions?: Readonly<CurrentRequestOptions>;
  private busyInputOwner?: BusyInputOwner;
  private busyPromptController?: AbortController;
  private busyPromptSession?: PromptInputSession;
  private busyPromptGeneration = 0;
  private steeringDeliveryQueue: Promise<void> = Promise.resolve();
  private steeringAdmissionPaused = false;
  private readonly reasoning = new ReasoningRegistry();
  private readonly adjustments = new AdjustmentRegistry();
  /**
   * Foldable disclosures from the most recent turn remain redrawable until
   * the next request is submitted. Ordinary transcript rows are committed
   * directly to scrollback so a long answer can never be clipped merely to
   * keep these controls interactive.
   */
  private mutableTurnTail: MutableTurnSegment[] = [];
  /**
   * First transcript entry owned by the current model turn. The boundary is
   * intentionally retained after completion so its Thinking controls remain
   * useful beside the idle Request editor, then replaced only when a new turn
   * actually starts.
   */
  private currentTurnTranscriptStart?: number;
  /** Exclusive completed-turn boundary; active turns grow to transcript.length. */
  private currentTurnTranscriptEnd?: number;
  /** User row committed by readPrompt before executePrompt calls setCurrentRequest. */
  private pendingRequestTranscriptStart?: number;
  /** A completed turn remains viewable, but a later direct/resumed request is new. */
  private currentTurnCompleted = false;
  private activityTimer?: NodeJS.Timeout;
  private activityStartedAt = 0;
  private activityFrameIndex = 0;
  private activityText = "";
  private activityVisible = false;
  private screen?: ScreenWriter;
  private uiState = createUIState();
  private inlineShellActive = false;
  private activePromptSession?: PromptInputSession;
  /**
   * Alternate-screen, continuously scrollable disclosure viewer. It owns
   * stdin only while open and restores the exact readline draft on close.
   */
  private disclosureViewer?: ActiveDisclosureViewer;
  private lastPlan?: Readonly<PlanProposal>;
  private progressItems: UIProgressItem[] = [];
  private progressSequence = 0;
  private activeActivityId?: string;
  private activitySequence = 0;
  private agentConcurrencyLimit?: number;
  /** Track DEC cursor visibility while EASY CODE owns the inline shell. */
  private terminalCursorVisible = true;
  private readonly vscodeMenuBridge = createVsCodeMenuBridge();
  private readonly onResize = (): void => {
    if (this.disclosureViewer) this.resizeDisclosureViewer();
    else this.refresh();
  };

  constructor(
    private readonly input: PromptInput = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout
  ) {}

  isInteractive(): boolean {
    return Boolean(
      this.input.isTTY &&
      (this.output as NodeJS.WriteStream).isTTY,
    );
  }

  /** Enable the retained inline UI only for a real TTY owned by this instance. */
  beginShell(session: Readonly<UISessionInfo>): boolean {
    if (this.inlineShellActive) {
      this.setSessionInfo(session);
      return true;
    }
    if (!this.canUseInlineShell()) return false;
    this.uiState = applyEvent(this.uiState, {
      type: "session.set",
      session,
    });
    this.screen = new ScreenWriter(
      this.output as NodeJS.WriteStream,
      () => (this.output as NodeJS.WriteStream).columns,
    );
    this.inlineShellActive = true;
    this.output.on("resize", this.onResize);
    return true;
  }

  isInlineShell(): boolean {
    return this.inlineShellActive;
  }

  setSessionInfo(session: Readonly<UISessionInfo>, announce = false): void {
    this.uiState = applyEvent(this.uiState, { type: "session.set", session });
    if (!this.inlineShellActive) return;
    if (announce) this.showSessionHeader();
    else this.refresh();
  }

  showSessionHeader(): void {
    if (!this.inlineShellActive || !this.screen) return;
    this.screen.commit(
      `\n${renderSessionHeader(this.uiState, this.viewOptions())}\n\n`,
    );
    this.refresh();
  }

  setCurrentRequest(
    text: string,
    images: readonly Readonly<ImageAttachment>[] = [],
    options: Readonly<CurrentRequestOptions> = {},
  ): void {
    this.closeDisclosureViewer();
    this.stopBusyComposer();
    this.stopBusyInputOwner();
    this.steeringAdmissionPaused = false;
    this.currentRequestOptions = options;
    if (!this.inlineShellActive) return;
    const pendingStart = this.pendingRequestTranscriptStart;
    // A completed turn remains interactive while its idle Request editor is
    // visible. Starting the next busy turn is the ownership boundary at which
    // that prior tail becomes immutable scrollback.
    if (!this.uiState.composer.busy) this.flushMutableTurnTail();
    const pendingEntry = pendingStart === undefined
      ? undefined
      : this.uiState.transcript[pendingStart];
    if (pendingEntry?.kind === "user") {
      this.currentTurnTranscriptStart = pendingStart;
    } else if (
      this.currentTurnTranscriptStart === undefined ||
      this.currentTurnCompleted
    ) {
      // Resumed/approved operations can enter executePrompt without passing
      // through the interactive Request editor. Retain their request in this
      // turn's virtual transcript without printing a duplicate scrollback row.
      this.currentTurnTranscriptStart = this.uiState.transcript.length;
      this.uiState = applyEvent(this.uiState, {
        type: "transcript.append",
        entry: {
          kind: "user",
          text,
          images: images.map((image) => ({ ...image })),
        },
      });
    }
    this.pendingRequestTranscriptStart = undefined;
    this.currentTurnCompleted = false;
    this.currentTurnTranscriptEnd = undefined;
    this.progressItems = [];
    this.progressSequence = 0;
    this.uiState = applyEvent(this.uiState, { type: "progress.clear" });
    const summary = this.safeInline(text, 120);
    this.uiState = applyEvent(this.uiState, {
      type: "composer.patch",
      patch: {
        busy: true,
        text: "",
        pendingSubmissions: 0,
        placeholder: options.onSteer
          ? "Type an adjustment for the current task…"
          : summary
            ? `Working on: ${summary}`
            : "Working…",
        images,
      },
    });
    this.refresh();
    if (options.onSteer) this.startBusyComposer();
    else this.startBusyInputOwner();
  }

  clearCurrentRequest(): void {
    this.closeDisclosureViewer();
    this.currentRequestOptions = undefined;
    this.steeringAdmissionPaused = false;
    this.stopBusyComposer();
    this.stopBusyInputOwner();
    if (!this.inlineShellActive) return;
    this.currentTurnCompleted = true;
    this.currentTurnTranscriptEnd = this.uiState.transcript.length;
    this.progressItems = [];
    this.progressSequence = 0;
    this.uiState = applyEvent(this.uiState, { type: "progress.clear" });
    this.uiState = applyEvent(this.uiState, { type: "composer.reset" });
    this.refresh();
  }

  /**
   * Establish the final-answer steering barrier.
   *
   * New text is drained before the first await, while every line that already
   * crossed Enter (including an image capture still settling) is allowed to
   * reach the durable onSteer callback. A returned value means steering won
   * the seal, so the same editor is resumed for the next model attempt. When
   * the callback returns undefined the editor remains frozen until the request
   * is cleared.
   */
  async sealCurrentRequestSteering<T>(
    seal: () => T | undefined | Promise<T | undefined>,
  ): Promise<T | undefined> {
    const requestOptions = this.currentRequestOptions;
    if (!requestOptions?.onSteer || this.steeringAdmissionPaused) {
      return seal();
    }

    this.steeringAdmissionPaused = true;
    const session = this.busyPromptSession;
    const editorSuspended = session?.suspendInput() ?? false;
    if (editorSuspended) {
      if (this.activePromptSession === session) this.activePromptSession = undefined;
      this.promptActive = false;
    }
    // Own and drain stdin during the barrier. Merely pausing the source lets a
    // real ConPTY buffer late keystrokes and replay them after resume.
    this.startBusyInputOwner();

    const resume = (): void => {
      if (this.currentRequestOptions !== requestOptions || this.closed) return;
      this.steeringAdmissionPaused = false;
      this.stopBusyInputOwner();
      if (editorSuspended && session && this.busyPromptSession === session) {
        session.resumeInput();
        this.activePromptSession = session;
        this.promptActive = true;
        this.refresh();
        return;
      }
      this.startBusyComposer();
      this.startBusyInputOwner();
    };

    try {
      await session?.flushSubmissions();
      await this.steeringDeliveryQueue.catch(() => undefined);
      const result = await seal();
      if (result !== undefined) resume();
      return result;
    } catch (error) {
      resume();
      throw error;
    }
  }

  /** Route audited runtime progress to live UI and retain all other notices. */
  status(text: string): void {
    const complete = redactSensitiveInformation(sanitizeCommandOutput(text)).trim();
    if (!complete) return;
    const label = this.safeInline(complete, 240);
    const presentation = classifyStatus(complete);
    if (!this.inlineShellActive) {
      this.writeStableStatus(
        presentation.destination === "stable" ? complete : label,
        presentation.destination === "stable" ? presentation.kind : "info",
      );
      return;
    }
    if (presentation.destination === "stable") {
      this.removeRunningProgress("status");
      this.writeStableStatus(complete, presentation.kind);
      this.refresh();
      return;
    }

    const kind = presentation.kind;
    this.removeRunningProgress(kind);
    this.progressSequence += 1;
    this.progressItems.push({
      id: `progress_${this.progressSequence}`,
      kind,
      label,
      status: "running",
      startedAt: Date.now(),
    });
    this.progressItems = this.progressItems.slice(-12);
    this.uiState = applyEvent(this.uiState, {
      type: "progress.set",
      progress: this.progressItems,
    });
    this.refresh();
  }

  toolCompleted(
    toolName: string,
    ok: boolean,
    summary?: string,
    error?: string,
  ): void {
    if (!this.inlineShellActive) return;
    // Completion is durable scrollback. Keeping a second completed copy in the
    // redrawable region makes every tool appear twice and lets Progress grow
    // for the lifetime of a request.
    this.removeRunningProgress("tool");
    const completeSummary = summary
      ? redactSensitiveInformation(sanitizeCommandOutput(summary)).trim()
      : "";
    const summaryPreview = completeSummary
      ? this.safeInline(completeSummary, 160)
      : "";
    const detail = summaryPreview ? ` — ${summaryPreview}` : "";
    // The completion row stays compact, but it must not become the only copy
    // of a longer or multiline tool summary. Keep the full sanitized summary
    // directly below its preview in stable scrollback.
    const summaryBody = completeSummary && completeSummary !== summaryPreview
      ? `\n${completeSummary.split(/\r?\n/gu).map((line) => `  ${line}`).join("\n")}`
      : "";
    const completeError = !ok && error
      ? redactSensitiveInformation(sanitizeCommandOutput(error)).trim()
      : "";
    const errorBody = completeError
      ? `\n${completeError.split(/\r?\n/gu).map((line) => `  ${line}`).join("\n")}`
      : "";
    this.commitTranscript({
      kind: "tool",
      text: `${ok ? "✓" : "✗"} Tool: ${this.safeInline(toolName, 80)}${detail}` +
        `${summaryBody}${errorBody}\n`,
      title: toolName,
    });
    this.refresh();
  }

  clearScreen(): void {
    if (!this.inlineShellActive) {
      if ((this.output as NodeJS.WriteStream).isTTY) this.output.write("\u001Bc");
      return;
    }
    this.screen?.clearLive();
    this.output.write("\u001Bc");
    this.showSessionHeader();
  }

  /** Clear every process-local UI projection when a new Thread becomes active. */
  resetForNewThread(session: Readonly<UISessionInfo>): void {
    this.closeDisclosureViewer();
    this.currentRequestOptions = undefined;
    this.stopBusyComposer();
    this.stopBusyInputOwner();
    this.resetActivityState();
    this.activeActivityId = undefined;
    this.lastPlan = undefined;
    this.progressItems = [];
    this.progressSequence = 0;
    this.agentConcurrencyLimit = undefined;
    this.clearMutableTurnTail();
    this.currentTurnTranscriptStart = undefined;
    this.currentTurnTranscriptEnd = undefined;
    this.pendingRequestTranscriptStart = undefined;
    this.currentTurnCompleted = false;
    this.reasoning.clear();
    this.adjustments.clear();
    this.uiState = createUIState({
      header: {
        title: this.uiState.header.title,
        session,
      },
    });

    if (!this.inlineShellActive) {
      if ((this.output as NodeJS.WriteStream).isTTY) this.output.write("\u001Bc");
      return;
    }
    this.screen?.clearLive();
    this.output.write("\u001Bc");
    this.showSessionHeader();
  }

  question(prompt: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.promptActive || this.guardedInputActive) {
      throw new Error("A terminal prompt is already active.");
    }
    if (this.inlineShellActive) this.screen?.clearLive();
    const rl = this.ensureReadline();
    return new Promise((resolve) => {
      let settled = false;
      const onClose = (): void => {
        this.releaseReadlineInput(rl);
        if (settled) return;
        settled = true;
        this.closed = true;
        resolve(null);
      };
      rl.once("close", onClose);
      rl.question(prompt, (answer) => {
        if (settled) return;
        settled = true;
        rl.close();
        this.releaseReadlineInput(rl);
        this.refresh();
        resolve(answer);
      });
    });
  }

  /**
   * Read text that may contain a bracketed multiline paste. Plain readline
   * treats every pasted newline as an immediate submission, so plan feedback
   * must use the same atomic paste transport as the main composer. Images are
   * intentionally rejected here; the optional clipboard-text fallback keeps
   * native paste shortcuts useful across supported terminals.
   */
  private async multilineTextQuestion(
    prompt: string,
    captureText?: PlanReviewInputOptions["captureText"],
  ): Promise<Pick<PromptSubmission, "text" | "pasteErrors"> | null> {
    if (this.closed) return null;
    if (this.rl || this.promptActive || this.guardedInputActive) {
      throw new Error("A terminal prompt is already active.");
    }
    if (
      !this.input.isTTY ||
      !(this.output as NodeJS.WriteStream).isTTY
    ) {
      const text = await this.question(prompt);
      return text === null ? null : { text, pasteErrors: [] };
    }
    if (typeof this.input.setRawMode !== "function") {
      this.warning(
        "Multiline plan feedback requires terminal Raw Mode support.",
      );
      return null;
    }

    if (this.inlineShellActive) this.screen?.clearLive();
    this.promptActive = true;
    const promptController = new AbortController();
    this.activePromptController = promptController;
    try {
      const result = await readPrompt({
        input: this.input,
        output: this.output as import("./prompt-input.js").PromptOutput,
        prompt,
        signal: promptController.signal,
        captureImage: async () => {
          throw new Error("Images are not supported in plan feedback.");
        },
        captureText,
        textOnlyPaste: true,
        clearOnSubmit: this.inlineShellActive,
      });
      if (result === null) {
        this.closed = true;
        return null;
      }
      return { text: result.text, pasteErrors: result.pasteErrors };
    } finally {
      if (this.activePromptController === promptController) {
        this.activePromptController = undefined;
      }
      this.promptActive = false;
      if (!this.closed) this.refresh();
    }
  }

  private async planTextQuestion(
    prompt: string,
    captureText?: PlanReviewInputOptions["captureText"],
  ): Promise<string | null> {
    while (!this.closed) {
      const submission = await this.multilineTextQuestion(prompt, captureText);
      if (submission === null) return null;
      if (submission.pasteErrors.length === 0) return submission.text;
      this.warning(
        `Plan feedback paste failed: ${submission.pasteErrors.join("; ")}`,
      );
    }
    return null;
  }

  private recordAcceptedPlanFeedback(feedback: string): void {
    if (!this.inlineShellActive) return;
    this.flushMutableTurnTail();
    this.uiState = applyEvent(this.uiState, {
      type: "transcript.append",
      entry: {
        kind: "user",
        text: feedback,
        images: [],
      },
    });
    this.screen?.commit(`${formatSubmittedRequest(feedback)}\n\n`);
  }

  async readPrompt(
    prompt: string,
    options: {
      initialImageCount?: number;
      captureImage: (
        index: number,
        signal?: AbortSignal,
      ) => Promise<ImageAttachment>;
      captureText?: (signal?: AbortSignal) => Promise<string | undefined>;
    },
  ): Promise<PromptSubmission | null> {
    if (this.closed) return null;
    this.closeDisclosureViewer();
    if (this.rl || this.promptActive || this.guardedInputActive) {
      throw new Error("A terminal prompt is already active.");
    }
    if (
      !(this.input as NodeJS.ReadStream).isTTY ||
      !(this.output as NodeJS.WriteStream).isTTY ||
      typeof (this.input as NodeJS.ReadStream).setRawMode !== "function"
    ) {
      const text = await this.question(prompt);
      return text === null ? null : { text, images: [], pasteErrors: [] };
    }
    this.promptActive = true;
    if (this.inlineShellActive) {
      this.screen?.clearLive();
      this.uiState = applyEvent(this.uiState, {
        type: "composer.patch",
        patch: {
          busy: false,
          text: "",
          cursor: 0,
          placeholder: "Type your request…",
          images: [],
        },
      });
    }
    const promptController = new AbortController();
    this.activePromptController = promptController;
    let ownedSession: PromptInputSession | undefined;
    try {
      const result = await readPrompt({
        input: this.input as import("./prompt-input.js").PromptInput,
        output: this.output as import("./prompt-input.js").PromptOutput,
        prompt: this.inlineShellActive ? this.composerPromptPrefix() : prompt,
        initialImageCount: options.initialImageCount,
        signal: promptController.signal,
        captureImage: options.captureImage,
        captureText: options.captureText,
        onSessionReady: (session) => {
          if (session) {
            ownedSession = session;
            this.activePromptSession = session;
            if (!this.disclosureViewer) this.setTerminalCursorVisible(true);
            return;
          }
          const viewer = this.disclosureViewer;
          if (viewer && viewer.suspendedSession === ownedSession) {
            viewer.sessionReleased = true;
            this.closeDisclosureViewer();
          }
          if (this.activePromptSession === ownedSession) {
            this.activePromptSession = undefined;
          }
        },
        onDraftChange: (draft) => {
          if (!this.inlineShellActive) return;
          this.uiState = applyEvent(this.uiState, {
            type: "composer.patch",
            patch: {
              text: draft.text,
              cursor: draft.cursor,
              images: draft.images,
            },
          });
          this.refresh();
          if (!this.disclosureViewer) this.setTerminalCursorVisible(true);
        },
        ...(this.inlineShellActive
          ? {
              renderPrompt: () => this.composerPromptPrefix(),
              renderBelow: () => this.composerPromptSuffix(),
              clearOnSubmit: true,
            }
          : {}),
        onShowThinking: (id) => {
          const shown = id === "last"
            ? this.showLatestReasoning()
            : this.showReasoning(id);
          if (!shown) {
            this.info(
              id === "last"
                ? "No Thinking content is available in this thread."
                : `Thinking block #${id} is not available in this thread.`,
            );
          }
        },
        onToggleThinking: (id) => {
          this.openDisclosureViewer("thinking", id);
        },
        onToggleAdjustment: (id) => {
          this.openDisclosureViewer("adjustment", id);
        },
      });
      if (result === null) this.closed = true;
      if (this.inlineShellActive && result !== null) {
        // readPrompt has erased its dynamic prefix at this point. Freeze the
        // previous completed turn before printing the newly submitted request,
        // so the old Thinking marker cannot move below the new user message.
        this.flushMutableTurnTail();
        this.pendingRequestTranscriptStart = this.uiState.transcript.length;
        this.uiState = applyEvent(this.uiState, {
          type: "transcript.append",
          entry: {
            kind: "user",
            text: result.text,
            images: result.images,
          },
        });
        this.screen?.commit(`${formatSubmittedRequest(result.text)}\n\n`);
      }
      return result;
    } finally {
      this.activePromptSession = undefined;
      if (this.activePromptController === promptController) {
        this.activePromptController = undefined;
      }
      this.promptActive = false;
      if (!this.closed) this.refresh();
    }
  }

  async selectProvider(
    choices: readonly ProviderSelectorChoice[],
    initialProvider: ProviderSelectorChoice["provider"],
  ): Promise<ProviderSelectorChoice["provider"] | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    if (this.rl || this.promptActive || this.guardedInputActive) throw new Error("Provider selection cannot start while a prompt is active.");
    return this.withPrivateProtocolFilteredInput((input) =>
      selectProvider(choices, {
        input: input as ModelSelectorInput,
        output: this.output as ModelSelectorOutput,
        initialProvider,
        color: this.colorEnabled(),
        ...(this.inlineShellActive
          ? {
              overlay: this.menuOverlay("provider-picker", "picker"),
              ...(this.vscodeMenuBridge
                ? { navigation: this.vscodeMenuBridge }
                : {}),
            }
          : {}),
      }),
    );
  }

  async selectModel(
    providerName: string,
    choices: readonly ModelSelectorChoice[],
    initialModel?: string,
  ): Promise<string | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    if (this.rl || this.promptActive || this.guardedInputActive) throw new Error("Model selection cannot start while a prompt is active.");
    return this.withPrivateProtocolFilteredInput((input) =>
      selectModel(providerName, choices, {
        input: input as ModelSelectorInput,
        output: this.output as ModelSelectorOutput,
        initialModel,
        color: this.colorEnabled(),
        ...(this.inlineShellActive
          ? {
              overlay: this.menuOverlay("model-picker", "picker"),
              ...(this.vscodeMenuBridge
                ? { navigation: this.vscodeMenuBridge }
                : {}),
            }
          : {}),
      }),
    );
  }

  async selectThinkingEffort(
    providerName: string,
    model: string,
    choices: readonly ThinkingEffortSelectorChoice[],
    initialEffort: ThinkingEffort,
  ): Promise<ThinkingEffort | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    if (this.rl || this.promptActive || this.guardedInputActive) throw new Error("Thinking effort selection cannot start while a prompt is active.");
    return this.withPrivateProtocolFilteredInput((input) =>
      selectThinkingEffort(providerName, model, choices, {
        input: input as ModelSelectorInput,
        output: this.output as ModelSelectorOutput,
        initialEffort,
        color: this.colorEnabled(),
        ...(this.inlineShellActive
          ? {
              overlay: this.menuOverlay("thinking-picker", "picker"),
              ...(this.vscodeMenuBridge
                ? { navigation: this.vscodeMenuBridge }
                : {}),
            }
          : {}),
      }),
    );
  }

  async readSecret(prompt: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Terminal input is closed."));
    if (this.rl || this.promptActive || this.guardedInputActive) throw new Error("Secret input must be read before the prompt is opened.");
    if (this.inlineShellActive) this.screen?.clearLive();
    try {
      return await this.withPrivateProtocolFilteredInput((input) =>
        readSecretInput(
          input as ModelSelectorInput,
          this.output,
          prompt,
        ),
      );
    } finally {
      this.refresh();
    }
  }

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    const title = redactSensitiveInformation(sanitizeCommandOutput(request.title))
      .replace(/\s+/gu, " ")
      .trim();
    const description = redactSensitiveInformation(
      sanitizeCommandOutput(request.description),
    );
    const preview = request.commandPreview
      ? redactSensitiveInformation(sanitizeCommandOutput(request.commandPreview))
        .replace(/[\r\n]+/gu, " ")
      : undefined;
    // Approval is a security decision. Its complete description and resolved
    // command are durable scrollback; the bounded selector card below is only
    // a navigation aid and must never be the sole copy the user can inspect.
    this.write(
      chalk.yellow(`\nApproval required: ${title}\n`) +
        `${description}\n` +
        (preview ? chalk.gray(`Command: ${preview}\n`) : ""),
    );

    if (
      this.closed ||
      !this.isInteractive() ||
      this.rl ||
      (this.promptActive && !this.busyPromptSession) ||
      this.guardedInputActive
    ) {
      return "reject";
    }
    try {
      return await this.withPrivateProtocolFilteredInput((input) =>
        selectApproval(request.commandPrefix, {
          input: input as ModelSelectorInput,
          output: this.output as ModelSelectorOutput,
          color: this.colorEnabled(),
          ...(this.inlineShellActive
            ? {
                overlay: this.menuOverlay(
                  request.id,
                  "approval",
                  request,
                ),
                ...(this.vscodeMenuBridge
                  ? { navigation: this.vscodeMenuBridge }
                  : {}),
              }
            : {}),
        }),
      );
    } catch {
      return "reject";
    }
  }

  showPlan(plan: Readonly<PlanProposal>): void {
    this.lastPlan = plan;
    this.write(`\n${formatPlanProposal(plan)}\n`);
  }

  async reviewPlan(
    options: Readonly<PlanReviewInputOptions> = {},
  ): Promise<PlanReviewDecision> {
    if (!this.isInteractive()) return { action: "defer" };
    if (this.inlineShellActive && this.lastPlan) {
      const choices = [
        "Yes, use Auto mode",
        "No, reject plan",
        "Adjust plan with feedback",
      ];
      const selection = await this.withPrivateProtocolFilteredInput((input) =>
        selectMenuIndex(
          choices.length,
          0,
          (selectedIndex) => renderMenu(
            "Review proposed plan",
            choices,
            selectedIndex,
            this.colorEnabled(),
          ),
          {
            input,
            output: this.output as ModelSelectorOutput,
            color: this.colorEnabled(),
            overlay: this.menuOverlay(
              this.lastPlan?.id ?? "plan-review",
              "plan-review",
              this.lastPlan,
            ),
            ...(this.vscodeMenuBridge
              ? { navigation: this.vscodeMenuBridge }
              : {}),
          },
          "No plan review choices are available.",
        ),
      );
      if (selection === undefined) return { action: "defer" };
      if (selection === 0) return { action: "approve" };
      if (selection === 1) return { action: "reject" };
      const feedback = await this.planTextQuestion(
        "Plan feedback > ",
        options.captureText,
      );
      if (feedback === null) return { action: "defer" };
      const sanitized = sanitizePlanText(feedback);
      if (!sanitized) return { action: "defer" };
      this.recordAcceptedPlanFeedback(sanitized);
      return { action: "adjust", feedback: sanitized };
    }
    while (!this.closed) {
      this.write("\nWhat would you like to do?\n\n");
      this.write("1. Yes, use Auto mode\n");
      this.write("2. No, reject plan\n");
      this.write("3. Type feedback and press Enter to adjust the plan\n\n");
      const response = await this.planTextQuestion(
        "Choose 1/2, or type feedback to adjust > ",
        options.captureText,
      );
      if (response === null) return { action: "defer" };
      const answer = sanitizePlanText(response);
      if (!answer) continue;
      const normalized = answer.toLowerCase();
      if (normalized === "1" || normalized === "y" || normalized === "yes") {
        return { action: "approve" };
      }
      if (normalized === "2" || normalized === "n" || normalized === "no") {
        return { action: "reject" };
      }
      if (normalized === "3") {
        const feedback = await this.planTextQuestion(
          "Plan feedback > ",
          options.captureText,
        );
        if (feedback === null) return { action: "defer" };
        const sanitized = sanitizePlanText(feedback);
        if (!sanitized) continue;
        this.recordAcceptedPlanFeedback(sanitized);
        return { action: "adjust", feedback: sanitized };
      }
      this.recordAcceptedPlanFeedback(answer);
      return { action: "adjust", feedback: answer };
    }
    return { action: "defer" };
  }

  async selectChoice(
    title: string,
    choices: readonly TerminalChoice[],
    initialId?: string,
  ): Promise<string | undefined> {
    if (this.closed || choices.length === 0) return undefined;
    if (
      !this.isInteractive() ||
      (this.promptActive && !this.busyPromptSession) ||
      this.guardedInputActive
    ) {
      return undefined;
    }
    const initialIndex = Math.max(
      0,
      choices.findIndex((choice) => choice.id === initialId),
    );
    const selection = await this.withPrivateProtocolFilteredInput((input) =>
      selectMenuIndex(
        choices.length,
        initialIndex,
        (selectedIndex) => renderMenu(
          title,
          choices.map((choice) =>
            `${choice.label}${choice.detail ? `  [${choice.detail}]` : ""}`),
          selectedIndex,
          this.colorEnabled(),
          512,
        ),
        {
          input,
          output: this.output as ModelSelectorOutput,
          color: this.colorEnabled(),
          ...(this.inlineShellActive
            ? {
                overlay: this.menuOverlay(`choice-${Date.now()}`, "picker"),
                ...(this.vscodeMenuBridge
                  ? { navigation: this.vscodeMenuBridge }
                  : {}),
              }
            : {}),
        },
        `No choices are available for ${title}.`,
      ),
    );
    const choice = selection === undefined ? undefined : choices[selection];
    return choice?.disabled ? undefined : choice?.id;
  }

  write(text: string): void {
    if (this.inlineShellActive) {
      this.commitTranscript({ kind: "raw", text });
      this.refresh();
      return;
    }
    this.stopActivity();
    this.output.write(text);
  }

  /** Show a transient TTY spinner until the pending operation completes. */
  startActivity(
    text: string,
    kind: UIActivityKind = "model",
  ): string | undefined {
    this.stopActivity();
    if (!this.canAnimateActivity()) return undefined;

    const sanitized = this.safeInline(text, 160);
    this.activityText = sanitized || "Waiting for the model response";
    this.activityStartedAt = Date.now();
    this.activityFrameIndex = 0;
    this.activitySequence += 1;
    this.activeActivityId =
      `activity_${this.activityStartedAt}_${this.activitySequence}`;
    if (this.inlineShellActive) {
      this.uiState = applyEvent(this.uiState, {
        type: "activity.start",
        activity: {
          id: this.activeActivityId,
          kind,
          label: this.activityText,
          startedAt: this.activityStartedAt,
        },
      });
    }
    try {
      this.renderActivity();
    } catch {
      if (this.inlineShellActive) {
        this.uiState = applyEvent(this.uiState, {
          type: "activity.stop",
          ...(this.activeActivityId ? { id: this.activeActivityId } : {}),
        });
      }
      this.resetActivityState();
      this.activeActivityId = undefined;
      return undefined;
    }

    const activityId = this.activeActivityId;
    this.activityTimer = setInterval(() => {
      try {
        if (!this.canAnimateActivity()) {
          this.stopActivity(activityId);
          return;
        }
        this.activityFrameIndex =
          (this.activityFrameIndex + 1) % Terminal.ACTIVITY_FRAMES.length;
        this.renderActivity();
      } catch {
        try {
          this.stopActivity(activityId);
        } catch {
          this.resetActivityState();
          this.activeActivityId = undefined;
        }
      }
    }, Terminal.ACTIVITY_INTERVAL_MS);
    this.activityTimer.unref();
    return activityId;
  }

  /** Clear the transient spinner without adding a blank line. */
  stopActivity(activityId?: string): void {
    if (activityId !== undefined && activityId !== this.activeActivityId) return;
    const wasVisible = this.activityVisible;
    const activeActivityId = this.activeActivityId;
    const activityKind = this.uiState.live.activity?.kind;
    this.resetActivityState();
    this.activeActivityId = undefined;
    if (this.inlineShellActive) {
      this.uiState = applyEvent(this.uiState, {
        type: "activity.stop",
        ...(activeActivityId ? { id: activeActivityId } : {}),
      });
      if (activityKind === "model") this.removeRunningProgress("step");
      this.refresh();
      return;
    }
    if (wasVisible) {
      this.output.write("\r\u001B[2K");
    }
  }

  info(text: string): void {
    this.write(chalk.cyan(text) + "\n");
  }

  success(text: string): void {
    this.write(chalk.green(text) + "\n");
  }

  warning(text: string): void {
    this.write(chalk.yellow(text) + "\n");
  }

  error(text: string): void {
    this.write(chalk.red(text) + "\n");
  }

  fileDiff(presentation: FileDiffPresentation): void {
    this.write(renderFileDiff(presentation, { color: this.colorEnabled() }));
  }

  taskGraph(graph: Readonly<TaskGraphView>): void {
    if (this.inlineShellActive) {
      this.uiState = applyEvent(this.uiState, {
        type: "tasks.set",
        tasks: graph,
      });
      this.refresh();
      return;
    }
    this.write(renderTaskGraph(graph, { color: this.colorEnabled() }));
  }

  showTaskGraphSnapshot(graph: Readonly<TaskGraphView>): void {
    if (this.inlineShellActive) {
      this.uiState = applyEvent(this.uiState, { type: "tasks.set", tasks: graph });
      this.commitTranscript({
        kind: "raw",
        text: renderTaskGraph(graph, { color: this.colorEnabled() }),
      });
      this.refresh();
      return;
    }
    this.taskGraph(graph);
  }

  clearTaskGraph(): void {
    if (!this.inlineShellActive) return;
    this.uiState = applyEvent(this.uiState, { type: "tasks.clear" });
    this.refresh();
  }

  subagents(
    agents: readonly Readonly<SubagentView>[],
    taskGraph?: Readonly<TaskGraphView>,
    concurrencyLimit?: number,
  ): void {
    if (this.inlineShellActive) {
      this.agentConcurrencyLimit = concurrencyLimit;
      this.uiState = applyEvent(this.uiState, {
        type: "subagents.set",
        subagents: agents,
      });
      if (taskGraph) {
        this.uiState = applyEvent(this.uiState, {
          type: "tasks.set",
          tasks: taskGraph,
        });
      }
      this.refresh();
      return;
    }
    this.write(renderSubagents(agents, {
      color: this.colorEnabled(),
      ...(taskGraph ? { taskGraph } : {}),
      ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
    }));
  }

  showSubagentsSnapshot(
    agents: readonly Readonly<SubagentView>[],
    taskGraph?: Readonly<TaskGraphView>,
    concurrencyLimit?: number,
  ): void {
    if (this.inlineShellActive) {
      this.subagents(agents, taskGraph, concurrencyLimit);
      this.commitTranscript({
        kind: "raw",
        text: renderSubagents(agents, {
          color: this.colorEnabled(),
          ...(taskGraph ? { taskGraph } : {}),
          ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
        }),
      });
      this.refresh();
      return;
    }
    this.subagents(agents, taskGraph, concurrencyLimit);
  }

  emergencyRestore(): void {
    this.closeDisclosureViewer();
    this.currentRequestOptions = undefined;
    this.stopBusyComposer();
    this.stopBusyInputOwner();
    try {
      this.screen?.clearLive();
      this.output.write("\u001B[?25h");
      this.input.setRawMode?.(false);
    } catch {
      // Emergency cleanup must never mask the original interrupt.
    }
  }

  /** Store provider thinking safely and print only its collapsed marker. */
  addReasoning(text: string): number {
    const block = this.reasoning.add(text);
    if (this.isInteractive()) {
      const entry = {
        kind: "raw",
        id: `thinking_${block.id}`,
        text: renderReasoningMarker(block, { color: this.colorEnabled() }),
        reasoning: block.text,
      } as const;
      if (this.inlineShellActive) {
        this.appendMutableTurnSegment(entry, block);
        this.refresh();
      } else {
        this.write(entry.text);
      }
    }
    return block.id;
  }

  /** Retain one durable user adjustment and present it as ordinary user input. */
  addQueuedAdjustment(
    id: number,
    text: string,
    images: readonly Readonly<ImageAttachment>[] = [],
  ): number {
    const block = this.adjustments.add(id, text, images);
    if (this.isInteractive()) {
      const entry = {
        kind: "user",
        id: `adjustment_message_${block.id}`,
        text: block.text,
        images: images.map((image) => ({ ...image })),
      } as const;
      if (this.inlineShellActive) {
        // The adjustment registry remains available to `/adjustment`, while
        // the main transcript shows only the user-authored message. Runtime
        // queue terminology and disclosure controls are implementation detail.
        this.commitTranscript(entry);
        this.refresh();
      } else {
        this.write(`${this.formatUserTranscriptEntry(entry)}\n\n`);
      }
    }
    return block.id;
  }

  /** Write one retained adjustment body into stable scrollback. */
  showAdjustment(id: number | "last"): boolean {
    if (!this.isInteractive()) return false;
    const block = this.adjustments.get(id);
    if (!block) return false;
    this.write(renderAdjustmentBody(block, { color: this.colorEnabled() }));
    return true;
  }

  /** Toggle a queued adjustment at its original mutable transcript position. */
  toggleAdjustment(id: number): boolean {
    return this.openDisclosureViewer("adjustment", id);
  }

  /** Rebuild `/thinking` history for a resumed Thread without replaying old markers. */
  restoreReasoning(texts: readonly string[]): number {
    this.closeDisclosureViewer();
    this.clearMutableTurnTail();
    const count = this.reasoning.rebuild(texts);
    this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
    this.refresh();
    return count;
  }

  /** Append one complete sanitized Thinking block. Missing IDs are silent. */
  showReasoning(id: number | "last"): boolean {
    if (!this.isInteractive()) return false;
    const block = this.reasoning.get(id);
    if (!block) return false;
    this.write(renderReasoningBody(block, { color: this.colorEnabled() }));
    return true;
  }

  showLatestReasoning(): boolean {
    return this.showReasoning("last");
  }

  /** Toggle one complete Thinking body in the managed transcript viewer. */
  toggleReasoning(id: number): boolean {
    return this.openDisclosureViewer("thinking", id);
  }

  /** Drop the current Thread's blocks without reusing IDs from old markers. */
  clearReasoning(): void {
    this.closeDisclosureViewer();
    this.flushMutableTurnTail();
    this.reasoning.clear();
    this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
    this.refresh();
  }

  close(): void {
    this.vscodeMenuBridge?.close();
    if (this.closed) return;
    this.closeDisclosureViewer();
    this.currentRequestOptions = undefined;
    this.stopBusyComposer();
    this.stopBusyInputOwner();
    this.stopActivity();
    if (this.inlineShellActive) {
      this.output.removeListener("resize", this.onResize);
      this.screen?.close();
      this.screen = undefined;
      this.inlineShellActive = false;
      try {
        this.output.write("\u001B[?25h");
        this.input.setRawMode?.(false);
      } catch {
        // The terminal may already be gone; cleanup is best effort.
      }
    }
    this.closed = true;
    this.activePromptController?.abort();
    this.activePromptController = undefined;
    const rl = this.rl;
    rl?.close();
    if (rl) this.releaseReadlineInput(rl);
  }

  private ensureReadline(): readline.Interface {
    if (this.closed) throw new Error("Terminal input is closed.");
    if (!this.rl) {
      const inputFilter = new PrivateOscInputFilter(this.input);
      try {
        // readline enables Raw Mode through the filter. Create it before
        // piping process.stdin so Windows ConPTY never starts a cooked-mode
        // read that would swallow the first arrow keys until Enter arrives.
        const rl = readline.createInterface({
          input: inputFilter,
          output: this.output,
          terminal:
            Boolean(this.input.isTTY) &&
            Boolean((this.output as NodeJS.WriteStream).isTTY),
        });
        this.input.pipe(inputFilter);
        this.rl = rl;
        this.readlineInputFilter = inputFilter;
      } catch (error) {
        this.input.unpipe(inputFilter);
        inputFilter.destroy();
        throw error;
      }
    }
    return this.rl;
  }

  private releaseReadlineInput(rl: readline.Interface): void {
    if (this.rl !== rl) return;
    this.rl = undefined;
    const inputFilter = this.readlineInputFilter;
    this.readlineInputFilter = undefined;
    if (!inputFilter) return;
    this.input.unpipe(inputFilter);
    if (!inputFilter.destroyed) inputFilter.destroy();
  }

  /**
   * Keep the extension's no-newline private protocol responsive while a model
   * request owns the visible composer. All ordinary input is deliberately
   * drained; only Thinking toggles and Ctrl+C have busy-phase semantics.
   */
  private startBusyComposer(): void {
    const requestOptions = this.currentRequestOptions;
    if (
      !requestOptions?.onSteer ||
      this.steeringAdmissionPaused ||
      this.busyPromptController ||
      !this.inlineShellActive ||
      this.closed ||
      this.promptActive ||
      this.guardedInputActive ||
      this.rl
    ) {
      return;
    }

    const generation = this.busyPromptGeneration + 1;
    this.busyPromptGeneration = generation;
    const controller = new AbortController();
    this.busyPromptController = controller;
    this.promptActive = true;
    this.screen?.clearLive();
    let ownedSession: PromptInputSession | undefined;

    const pendingCount = (delta: number): void => {
      if (this.busyPromptGeneration !== generation) return;
      this.uiState = applyEvent(this.uiState, {
        type: "composer.patch",
        patch: {
          pendingSubmissions: Math.max(
            0,
            this.uiState.composer.pendingSubmissions + delta,
          ),
        },
      });
      this.refresh();
    };

    const deliver = (submission: Readonly<PromptSubmission>): void => {
      for (const error of submission.pasteErrors) {
        this.writeStableStatus(`Steering paste failed: ${error}`, "error");
      }
      if (submission.text.trim().length === 0 && submission.images.length === 0) {
        return;
      }
      pendingCount(1);
      const queued = this.steeringDeliveryQueue
        .catch(() => undefined)
        .then(() => requestOptions.onSteer?.(submission));
      this.steeringDeliveryQueue = queued.then(
        () => pendingCount(-1),
        (error: unknown) => {
          pendingCount(-1);
          this.writeStableStatus(
            `Unable to queue steering input: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        },
      );
    };

    void readPrompt({
      input: this.input as import("./prompt-input.js").PromptInput,
      output: this.output as import("./prompt-input.js").PromptOutput,
      prompt: this.composerPromptPrefix(),
      initialImageCount: requestOptions.initialImageCount ?? 0,
      signal: controller.signal,
      captureImage: requestOptions.captureImage ?? (async () => {
        throw new Error("Image steering is unavailable for this request.");
      }),
      captureText: requestOptions.captureText,
      keepOpen: true,
      onSubmit: (submission) => deliver(submission),
      onInterrupt: requestOptions.onInterrupt,
      onDiscardImages: requestOptions.onDiscardImages,
      renderPrompt: () => this.composerPromptPrefix(),
      renderBelow: () => this.composerPromptSuffix(),
      clearOnSubmit: true,
      onDraftChange: (draft) => {
        if (
          this.busyPromptGeneration !== generation ||
          this.currentRequestOptions !== requestOptions
        ) return;
        this.uiState = applyEvent(this.uiState, {
          type: "composer.patch",
          patch: {
            text: draft.text,
            cursor: draft.cursor,
            images: draft.images,
          },
        });
        this.refresh();
        if (!this.disclosureViewer) this.setTerminalCursorVisible(true);
      },
      onSessionReady: (session) => {
        if (
          this.busyPromptGeneration !== generation ||
          this.currentRequestOptions !== requestOptions
        ) return;
        if (session) {
          ownedSession = session;
          this.busyPromptSession = session;
          this.activePromptSession = session;
          if (!this.disclosureViewer) this.setTerminalCursorVisible(true);
        } else {
          const viewer = this.disclosureViewer;
          if (viewer && viewer.suspendedSession === ownedSession) {
            viewer.sessionReleased = true;
            this.closeDisclosureViewer();
          }
          if (this.busyPromptSession === ownedSession) {
            this.busyPromptSession = undefined;
          }
          if (this.activePromptSession === ownedSession) {
            this.activePromptSession = undefined;
          }
        }
      },
      onToggleThinking: (id) => {
        this.openDisclosureViewer("thinking", id);
      },
      onToggleAdjustment: (id) => {
        this.openDisclosureViewer("adjustment", id);
      },
      onShowThinking: (id) => {
        const shown = id === "last"
          ? this.showLatestReasoning()
          : this.showReasoning(id);
        if (!shown) this.info("No Thinking content is available in this thread.");
      },
    }).catch((error: unknown) => {
      if (this.busyPromptGeneration !== generation || this.closed) return;
      this.writeStableStatus(
        `Busy input editor failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }).finally(() => {
      if (this.busyPromptGeneration !== generation) return;
      this.busyPromptController = undefined;
      if (this.busyPromptSession === ownedSession) this.busyPromptSession = undefined;
      if (this.activePromptSession === ownedSession) this.activePromptSession = undefined;
      this.promptActive = false;
      if (this.currentRequestOptions === requestOptions && !this.closed) {
        // Preserve Ctrl+C/Thinking controls if the richer editor becomes
        // unavailable on a particular terminal.
        this.startBusyInputOwner();
      }
    });
  }

  private stopBusyComposer(): void {
    const controller = this.busyPromptController;
    const session = this.busyPromptSession;
    if (!controller && !session) return;
    this.busyPromptGeneration += 1;
    this.busyPromptController = undefined;
    this.busyPromptSession = undefined;
    if (this.activePromptSession === session) this.activePromptSession = undefined;
    controller?.abort();
    this.promptActive = false;
  }

  private startBusyInputOwner(): void {
    if (
      this.busyInputOwner ||
      !this.currentRequestOptions ||
      !this.inlineShellActive ||
      this.closed ||
      this.promptActive ||
      this.guardedInputActive ||
      this.rl
    ) {
      return;
    }

    const wasRaw = Boolean(this.input.isRaw);
    const wasFlowing = this.input.readableFlowing === true;
    let filter!: PrivateOscInputFilter;
    const onError = (): void => {
      if (this.busyInputOwner?.filter !== filter) return;
      this.stopBusyInputOwner();
    };
    filter = new PrivateOscInputFilter(
      this.input,
      (id) => {
        if (
          this.busyInputOwner?.filter !== filter ||
          !this.currentRequestOptions ||
          this.guardedInputActive ||
          this.promptActive ||
          this.rl
        ) {
          return;
        }
        this.openDisclosureViewer("thinking", id);
      },
      () => {
        if (
          this.busyInputOwner?.filter !== filter ||
          !this.currentRequestOptions ||
          this.guardedInputActive ||
          this.promptActive ||
          this.rl
        ) {
          return;
        }
        this.currentRequestOptions.onInterrupt?.();
      },
      (id) => {
        if (
          this.busyInputOwner?.filter !== filter ||
          !this.currentRequestOptions ||
          this.guardedInputActive ||
          this.promptActive ||
          this.rl
        ) {
          return;
        }
        this.openDisclosureViewer("adjustment", id);
      },
    );
    this.busyInputOwner = { filter, wasRaw, wasFlowing, onError };
    filter.on("error", onError);

    try {
      this.input.setRawMode?.(true);
      this.input.pipe(filter);
      // The control owner has no downstream UI. Flowing the readable side
      // drains ordinary keys after the filter has inspected private controls.
      filter.resume();
      this.input.resume();
    } catch {
      this.stopBusyInputOwner();
    }
  }

  private stopBusyInputOwner(): void {
    const owner = this.busyInputOwner;
    if (!owner) return;
    this.busyInputOwner = undefined;
    owner.filter.removeListener("error", owner.onError);
    this.input.unpipe(owner.filter);
    if (!owner.filter.destroyed) owner.filter.destroy();
    try {
      this.input.setRawMode?.(owner.wasRaw);
    } catch {
      // A disappearing TTY must not prevent the remaining cleanup.
    }
    if (owner.wasFlowing) this.input.resume();
    else this.input.pause();
  }

  private async withPrivateProtocolFilteredInput<T>(
    action: (input: PrivateOscInputFilter) => Promise<T>,
  ): Promise<T> {
    this.closeDisclosureViewer();
    if (this.guardedInputActive) {
      throw new Error("A terminal input operation is already active.");
    }
    this.guardedInputActive = true;

    // A busy steering editor is the sole normal stdin owner. Freeze its
    // readline buffer before a modal selector attaches, then restore the same
    // session after the selector has removed every listener. This preserves
    // draft text/images/cursor without ever piping stdin to two consumers.
    const suspendedBusySession = this.busyPromptSession;
    const busyEditorSuspended = suspendedBusySession?.suspendInput() ?? false;
    if (busyEditorSuspended) {
      if (this.activePromptSession === suspendedBusySession) {
        this.activePromptSession = undefined;
      }
      this.promptActive = false;
    }

    // A command approval normally interrupts the busy request owner. Borrow
    // its already-piped raw input filter instead of tearing process.stdin down
    // and immediately rebuilding it. Rapid raw-mode/pipe transitions can lose
    // the first key on real Windows ConPTY terminals even though PassThrough
    // tests look correct. The modal selector pauses the drain, owns the same
    // filter temporarily, and hands it back after cleanup; extra key repeats
    // are then drained by the busy owner rather than leaking into a later
    // composer.
    const borrowedOwner = this.busyInputOwner;
    if (borrowedOwner && !borrowedOwner.filter.destroyed) {
      borrowedOwner.filter.pause();
      borrowedOwner.filter.resetPendingInput();
      try {
        return await action(borrowedOwner.filter);
      } finally {
        this.guardedInputActive = false;
        if (
          this.busyInputOwner === borrowedOwner &&
          this.currentRequestOptions &&
          !this.closed &&
          !borrowedOwner.filter.destroyed
        ) {
          borrowedOwner.filter.resume();
        } else {
          // The request may have been replaced while the modal was open. Its
          // setter cannot start a new owner while guarded input is active, so
          // re-establish the current request's owner after releasing the guard.
          this.startBusyInputOwner();
        }
      }
    }

    this.stopBusyInputOwner();
    const wasRaw = Boolean(this.input.isRaw);
    const wasFlowing = this.input.readableFlowing === true;
    const inputFilter = new PrivateOscInputFilter(this.input);
    let pending: Promise<T> | undefined;
    try {
      // A Windows console read inherits cooked/raw behavior when the read is
      // first issued. Piping before Raw Mode therefore makes the first menu
      // ignore arrows until Enter completes that cooked read. Acquire Raw Mode
      // first, synchronously let the modal install its data listener, and only
      // then start source flow into the filter.
      this.input.pause();
      if (!wasRaw) this.input.setRawMode?.(true);
      pending = action(inputFilter);
      this.input.pipe(inputFilter);
      this.input.resume();
      return await pending;
    } finally {
      this.input.pause();
      this.input.unpipe(inputFilter);
      if (!inputFilter.destroyed) inputFilter.destroy();
      try {
        if (!wasRaw) this.input.setRawMode?.(false);
      } catch {
        // Input restoration is best effort if the terminal disappeared.
      }
      if (wasFlowing) this.input.resume();
      this.guardedInputActive = false;
      if (
        busyEditorSuspended &&
        suspendedBusySession !== undefined &&
        this.busyPromptSession === suspendedBusySession &&
        this.currentRequestOptions?.onSteer &&
        !this.closed
      ) {
        // The overlay cleanup may briefly paint the static busy card through
        // ScreenWriter. Remove it before readline restores its saved rows.
        this.screen?.clearLive();
        this.promptActive = true;
        this.activePromptSession = suspendedBusySession;
        suspendedBusySession.resumeInput({
          discardLeadingModalControls: true,
        });
      } else {
        this.startBusyInputOwner();
      }
    }
  }

  /**
   * Open one complete Thinking/Adjustment body in a managed alternate-screen
   * transcript. The primary terminal remains untouched, so closing the viewer
   * can restore the collapsed marker at exactly the same logical position.
   */
  private openDisclosureViewer(kind: DisclosureKind, id: number): boolean {
    if (!this.inlineShellActive || !this.isInteractive() || this.closed) {
      return false;
    }
    if (!this.disclosureAvailable(kind, id)) {
      const label = kind === "thinking" ? "Thinking block" : "Queued adjustment";
      this.writeStableStatus(
        `${label} #${id} is historical or unavailable; use /${kind === "thinking" ? "thinking" : "adjustment"} ${id} to view retained content.`,
        "info",
      );
      return false;
    }

    const current = this.disclosureViewer;
    if (current) {
      if (current.kind === kind && current.registryId === id) {
        this.closeDisclosureViewer();
        return true;
      }
      return this.switchDisclosureViewer(current, kind, id);
    }

    const rows = this.physicalRows();
    if (rows < 7) {
      this.writeStableStatus(
        "The terminal needs at least 7 rows to open a complete disclosure view.",
        "warning",
      );
      return false;
    }

    const priorBusyOwner = this.busyInputOwner;
    const wasRaw = priorBusyOwner?.wasRaw ?? Boolean(this.input.isRaw);
    const wasFlowing = priorBusyOwner?.wasFlowing ??
      this.input.readableFlowing === true;
    const suspendedSession = this.activePromptSession;
    const sessionSuspended = suspendedSession?.suspendInput() ?? false;
    if (suspendedSession && !sessionSuspended) return false;
    if (sessionSuspended) {
      if (this.activePromptSession === suspendedSession) {
        this.activePromptSession = undefined;
      }
      this.promptActive = false;
    } else {
      this.stopBusyInputOwner();
    }

    const columns = this.physicalColumns();
    const target = this.disclosureTarget(kind, id);
    const nodes = this.disclosureDocumentNodes(kind, id);
    const headerLines = this.disclosureHeaderLines(columns);
    const composerLines = this.disclosureComposerLines(columns, rows);
    const footerLines = this.disclosureFooterLines();
    let state: DisclosureViewState;
    try {
      state = createDisclosureViewState({
        nodes,
        target,
        columns,
        rows,
        headerLines,
        composerLines,
        footerLines,
        anchorScreenRow: this.disclosureAnchorScreenRow({
          nodes,
          target,
          columns,
          rows,
          headerLines,
          composerLines,
          footerLines,
        }),
        expanded: true,
        preserveAnsi: true,
      });
    } catch (error) {
      if (sessionSuspended && suspendedSession) {
        this.promptActive = true;
        this.activePromptSession = suspendedSession;
        suspendedSession.resumeInput({ discardLeadingModalControls: true });
      } else {
        this.startBusyInputOwner();
      }
      this.writeStableStatus(
        `Unable to open disclosure view: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return false;
    }

    const writer = new FullScreenWriter({
      output: this.output as import("../ui/render/screen-writer.js").ScreenOutput,
      columns: () => this.physicalColumns(),
      rows: () => this.physicalRows(),
    });
    const tuiInput = new TuiInputCore({ focus: "viewer", mouseWheelLines: 3 });
    let viewer!: ActiveDisclosureViewer;
    const onData = (chunk: Buffer | string): void => {
      if (this.disclosureViewer !== viewer || viewer.closing) return;
      try {
        const decoded = viewer.input.feed(chunk);
        this.scheduleDisclosureInputFlush(viewer);
        for (const event of decoded.events) {
          this.handleDisclosureInput(viewer, event);
          if (this.disclosureViewer !== viewer) break;
        }
      } catch {
        this.closeDisclosureViewer();
      }
    };
    const onError = (): void => this.closeDisclosureViewer();
    const frame = renderDisclosureView(state);
    viewer = {
      writer,
      input: tuiInput,
      state,
      frame,
      kind,
      registryId: id,
      ...(sessionSuspended && suspendedSession
        ? { suspendedSession }
        : {}),
      sessionReleased: false,
      wasRaw,
      wasFlowing,
      onData,
      onError,
      deferredCommits: [],
      closing: false,
    };
    this.disclosureViewer = viewer;
    if (kind === "thinking") {
      const block = this.reasoning.get(id);
      if (block && this.uiState.live.thinking?.id !== id) {
        this.uiState = applyEvent(this.uiState, {
          type: "thinking.toggle",
          panel: block,
        });
      }
    } else {
      this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
    }

    try {
      this.input.pause();
      this.input.setRawMode?.(true);
      this.input.on("data", onData);
      this.input.on("error", onError);
      writer.render(frame.rows);
      writer.enter();
      // FullScreenWriter owns DEC cursor visibility while the alternate
      // buffer is active. Keep our cache synchronized with its hidden cursor.
      this.terminalCursorVisible = false;
      this.input.resume();
      return true;
    } catch (error) {
      this.closeDisclosureViewer();
      this.writeStableStatus(
        `Unable to start disclosure view: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return false;
    }
  }

  private closeDisclosureViewer(): void {
    const viewer = this.disclosureViewer;
    if (!viewer || viewer.closing) return;
    viewer.closing = true;
    this.disclosureViewer = undefined;
    this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
    if (viewer.idleTimer) clearTimeout(viewer.idleTimer);
    viewer.idleTimer = undefined;

    try {
      this.input.pause();
      this.input.removeListener("data", viewer.onData);
      this.input.removeListener("error", viewer.onError);
      viewer.writer.close();
      // The writer's paired exit sequence restores the physical cursor.
      this.terminalCursorVisible = true;
    } finally {
      try {
        this.input.setRawMode?.(viewer.wasRaw);
      } catch {
        // A disappearing terminal must not prevent prompt restoration.
      }

      // Stable output produced while the alternate buffer was visible must be
      // committed once to the primary scrollback before readline redraws the
      // preserved draft. UI state was already updated when it arrived.
      for (const text of viewer.deferredCommits) this.screen?.commit(text);

      if (viewer.suspendedSession && !viewer.sessionReleased && !this.closed) {
        this.promptActive = true;
        this.activePromptSession = viewer.suspendedSession;
        viewer.suspendedSession.resumeInput({
          discardLeadingModalControls: true,
        });
        this.setTerminalCursorVisible(true);
      } else {
        if (viewer.wasFlowing) this.input.resume();
        else this.input.pause();
        if (!this.closed) this.startBusyInputOwner();
      }
      if (!this.closed) this.refresh();
    }
  }

  private refreshDisclosureViewer(nodesChanged = false): void {
    const viewer = this.disclosureViewer;
    if (!viewer || viewer.closing) return;
    try {
      if (nodesChanged) {
        viewer.state = replaceDisclosureViewNodes(
          viewer.state,
          this.disclosureDocumentNodes(viewer.kind, viewer.registryId),
        );
      }
      viewer.state = updateDisclosureViewChrome(viewer.state, {
        headerLines: this.disclosureHeaderLines(viewer.state.columns),
        composerLines: this.disclosureComposerLines(
          viewer.state.columns,
          viewer.state.rows,
        ),
        footerLines: this.disclosureFooterLines(),
      });
      viewer.frame = renderDisclosureView(viewer.state);
      viewer.writer.render(viewer.frame.rows);
    } catch {
      this.closeDisclosureViewer();
    }
  }

  private resizeDisclosureViewer(): void {
    const viewer = this.disclosureViewer;
    if (!viewer || viewer.closing) return;
    try {
      const columns = this.physicalColumns();
      const rows = this.physicalRows();
      if (rows < 7) {
        this.closeDisclosureViewer();
        return;
      }
      viewer.writer.resize(columns, rows);
      viewer.state = resizeDisclosureView(viewer.state, columns, rows);
      viewer.state = updateDisclosureViewChrome(viewer.state, {
        headerLines: this.disclosureHeaderLines(columns),
        composerLines: this.disclosureComposerLines(columns, rows),
        footerLines: this.disclosureFooterLines(),
      });
      viewer.frame = renderDisclosureView(viewer.state);
      viewer.writer.render(viewer.frame.rows);
    } catch {
      this.closeDisclosureViewer();
    }
  }

  private handleDisclosureInput(
    viewer: ActiveDisclosureViewer,
    event: Readonly<TuiInputEvent>,
  ): void {
    if (event.type === "input-error") {
      this.writeStableStatus(event.message, "warning");
      return;
    }
    if (event.type === "toggle-thinking") {
      this.toggleDisclosureFromViewer(viewer, "thinking", event.id);
      return;
    }
    if (event.type === "toggle-adjustment") {
      this.toggleDisclosureFromViewer(viewer, "adjustment", event.id);
      return;
    }
    if (event.type === "mouse") {
      const mouse = event;
      if (mouse.action === "wheel-up" || mouse.action === "wheel-down") {
        viewer.state = applyDisclosureViewCommand(viewer.state, {
          type: "scroll-lines",
          lines: mouse.action === "wheel-up" ? -3 : 3,
        });
        this.refreshDisclosureViewer();
        return;
      }
      if (mouse.action !== "press" || mouse.button !== "left") return;
      const row = viewer.frame.visibleRows[mouse.row - 1];
      if (!row || row.part !== "title" || !row.nodeId) return;
      if (row.nodeKind !== "thinking" && row.nodeKind !== "adjustment") return;
      const id = this.registryIdFromVirtualNode(row.nodeId, row.nodeKind);
      if (id !== undefined) {
        this.toggleDisclosureFromViewer(viewer, row.nodeKind, id);
      }
      return;
    }
    if (event.type === "key" && event.key === "page-up") {
      viewer.state = applyDisclosureViewCommand(viewer.state, {
        type: "page-up",
      });
      this.refreshDisclosureViewer();
      return;
    }
    if (event.type === "key" && event.key === "page-down") {
      viewer.state = applyDisclosureViewCommand(viewer.state, {
        type: "page-down",
      });
      this.refreshDisclosureViewer();
      return;
    }
    if (event.type === "key" && event.key === "interrupt") {
      try {
        if (this.currentRequestOptions?.onInterrupt) {
          this.currentRequestOptions.onInterrupt();
        } else {
          this.activePromptController?.abort();
        }
      } finally {
        this.closeDisclosureViewer();
      }
      return;
    }

    const raw = this.disclosureEditorInput(event);
    if (!raw) return;
    if (!viewer.suspendedSession?.feedInput(raw)) {
      // A session can finish synchronously when Enter is forwarded. Its
      // lifecycle callback normally closes the viewer; this fallback covers
      // a disappearing terminal without leaving a read-only screen behind.
      if (this.disclosureViewer === viewer && viewer.sessionReleased) {
        this.closeDisclosureViewer();
      }
    }
  }

  /** Encode one decoded editing event back into the canonical readline path. */
  private disclosureEditorInput(
    event: Readonly<TuiInputEvent>,
  ): Buffer | string | undefined {
    if (event.type === "text") return event.text;
    if (event.type === "paste") {
      return `\u001B[200~${event.text}\u001B[201~`;
    }
    if (event.type === "paste-image") return VSCODE_IMAGE_PASTE_SEQUENCE;
    if (event.type !== "key") return undefined;
    switch (event.key) {
      case "left":
        return "\u001B[D";
      case "right":
        return "\u001B[C";
      case "up":
        return "\u001B[A";
      case "down":
        return "\u001B[B";
      case "home":
        return "\u001B[H";
      case "end":
        return "\u001B[F";
      case "backspace":
        return Buffer.from([0x7f]);
      case "delete":
        return "\u001B[3~";
      case "enter":
        return "\r";
      case "newline":
        return "\u001B\r";
      case "interrupt":
      case "page-up":
      case "page-down":
        return undefined;
    }
  }

  private toggleDisclosureFromViewer(
    viewer: ActiveDisclosureViewer,
    kind: DisclosureKind,
    id: number,
  ): void {
    if (viewer.kind === kind && viewer.registryId === id) {
      this.closeDisclosureViewer();
      return;
    }
    this.switchDisclosureViewer(viewer, kind, id);
  }

  private switchDisclosureViewer(
    viewer: ActiveDisclosureViewer,
    kind: DisclosureKind,
    id: number,
  ): boolean {
    if (this.disclosureViewer !== viewer || !this.disclosureAvailable(kind, id)) {
      return false;
    }
    try {
      const target = this.disclosureTarget(kind, id);
      const nodes = this.disclosureDocumentNodes(kind, id);
      const columns = viewer.state.columns;
      const rows = viewer.state.rows;
      const headerLines = this.disclosureHeaderLines(columns);
      const composerLines = this.disclosureComposerLines(columns, rows);
      const footerLines = this.disclosureFooterLines();
      viewer.state = createDisclosureViewState({
        nodes,
        target,
        columns,
        rows,
        headerLines,
        composerLines,
        footerLines,
        anchorScreenRow: this.disclosureAnchorScreenRow({
          nodes,
          target,
          columns,
          rows,
          headerLines,
          composerLines,
          footerLines,
        }),
        expanded: true,
        preserveAnsi: true,
      });
      viewer.kind = kind;
      viewer.registryId = id;
      if (kind === "thinking") {
        const block = this.reasoning.get(id);
        this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
        if (block) {
          this.uiState = applyEvent(this.uiState, {
            type: "thinking.toggle",
            panel: block,
          });
        }
      } else {
        this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
      }
      viewer.frame = renderDisclosureView(viewer.state);
      viewer.writer.render(viewer.frame.rows);
      return true;
    } catch {
      return false;
    }
  }

  private scheduleDisclosureInputFlush(viewer: ActiveDisclosureViewer): void {
    if (viewer.idleTimer) clearTimeout(viewer.idleTimer);
    viewer.idleTimer = undefined;
    if (!viewer.input.decoder.awaitingInput) return;
    viewer.idleTimer = setTimeout(() => {
      viewer.idleTimer = undefined;
      if (this.disclosureViewer !== viewer || viewer.closing) return;
      // Discard an incomplete OSC/paste packet so the next click or wheel
      // packet starts from a clean boundary instead of freezing the viewer.
      const flushed = viewer.input.flushIncomplete();
      for (const event of flushed.events) {
        this.handleDisclosureInput(viewer, event);
        if (this.disclosureViewer !== viewer) break;
      }
    }, 1_500);
    viewer.idleTimer.unref();
  }

  private disclosureAvailable(kind: DisclosureKind, id: number): boolean {
    const retained = kind === "thinking"
      ? this.reasoning.get(id)
      : this.adjustments.get(id);
    if (!retained) return false;
    return this.mutableTurnTail.some((segment) => kind === "thinking"
      ? segment.reasoning?.id === id
      : segment.adjustment?.id === id);
  }

  private disclosureTarget(kind: DisclosureKind, id: number): DisclosureViewTarget {
    return { id: this.virtualDisclosureId(kind, id), kind };
  }

  private virtualDisclosureId(kind: DisclosureKind, id: number): string {
    return `${kind}:${id}`;
  }

  private registryIdFromVirtualNode(
    nodeId: string,
    kind: DisclosureKind,
  ): number | undefined {
    const match = new RegExp(`^${kind}:([1-9][0-9]{0,15})$`, "u").exec(nodeId);
    if (!match) return undefined;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) ? id : undefined;
  }

  private disclosureDocumentNodes(
    activeKind: DisclosureKind,
    activeId: number,
  ): readonly VirtualDocumentNode[] {
    const nodes: VirtualDocumentNode[] = [];
    // The alternate buffer is a lossless projection of exactly one turn. Its
    // rows keep the same order as primary scrollback; only the selected
    // Thinking entry changes shape from marker+preview to title+full body.
    // Slicing at an explicit turn boundary prevents prior answers from being
    // replayed while retaining the initial request, steering, statuses, tools,
    // and the final assistant answer from this turn.
    const reasoningByEntryId = new Map<string, Readonly<ReasoningBlock>>();
    for (const segment of this.mutableTurnTail) {
      if (segment.entry.id && segment.reasoning) {
        reasoningByEntryId.set(segment.entry.id, segment.reasoning);
      }
    }
    const fallbackStart = (() => {
      const firstLiveEntryId = this.mutableTurnTail.find((segment) =>
        segment.reasoning
      )?.entry.id;
      if (!firstLiveEntryId) return this.uiState.transcript.length;
      const index = this.uiState.transcript.findIndex((entry) =>
        entry.id === firstLiveEntryId
      );
      return index < 0 ? this.uiState.transcript.length : index;
    })();
    const end = Math.max(
      0,
      Math.min(
        this.currentTurnTranscriptEnd ?? this.uiState.transcript.length,
        this.uiState.transcript.length,
      ),
    );
    const start = Math.max(
      0,
      Math.min(
        this.currentTurnTranscriptStart ?? fallbackStart,
        end,
      ),
    );
    for (let index = start; index < end; index += 1) {
      const entry = this.uiState.transcript[index];
      if (!entry) continue;
      const reasoning = entry.id
        ? reasoningByEntryId.get(entry.id)
        : undefined;
      if (reasoning) {
        nodes.push(this.reasoningDisclosureNode(
          reasoning,
          activeKind === "thinking" && activeId === reasoning.id,
        ));
        continue;
      }
      nodes.push({
        id: `transcript:${index}`,
        kind: "text",
        text: entry.kind === "user"
          ? this.formatUserTranscriptEntry(entry)
          : entry.text,
      });
    }
    return nodes;
  }

  private reasoningDisclosureNode(
    block: Readonly<ReasoningBlock>,
    active: boolean,
  ): VirtualDocumentNode {
    const marker = stripAnsi(renderReasoningMarker(block, {
      color: false,
    })).trimEnd().split("\n");
    return {
      id: this.virtualDisclosureId("thinking", block.id),
      kind: "thinking",
      title: active
        ? chalk.gray(`↕ Thinking #${block.id} · /thinking ${block.id} · VS Code Ctrl/Cmd+click to toggle`)
        : chalk.gray(marker[0] ?? `▶ Thinking #${block.id} · /thinking ${block.id}`),
      preview: chalk.gray(marker.slice(1).join("\n")),
      body: chalk.gray(
        (block.text || "(No visible Thinking text.)")
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
      ),
      expanded: active,
    };
  }

  private adjustmentDisclosureNode(
    block: Readonly<AdjustmentBlock>,
    active: boolean,
  ): VirtualDocumentNode {
    const marker = stripAnsi(renderAdjustmentMarker(block, {
      color: false,
    })).trimEnd().split("\n");
    const attachmentLabels = block.imageLabels
      .filter((label) => !block.text.includes(`[${label}]`))
      .map((label) => `[${label}]`)
      .join(" ");
    const completeText = block.text ||
      "(No text; this adjustment contains attachments only.)";
    return {
      id: this.virtualDisclosureId("adjustment", block.id),
      kind: "adjustment",
      title: active
        ? chalk.gray(`↕ Queued adjustment #${block.id} · /adjustment ${block.id} · VS Code Ctrl/Cmd+click to toggle`)
        : chalk.gray(marker[0] ?? `▶ Queued adjustment #${block.id} · /adjustment ${block.id}`),
      preview: chalk.gray(marker.slice(1).join("\n")),
      body: chalk.gray(
        `${completeText.split("\n").map((line) => `  ${line}`).join("\n")}` +
        `${attachmentLabels ? `\n  Attachments: ${attachmentLabels}` : ""}`,
      ),
      expanded: active,
    };
  }

  private formatAdjustmentAsSubmittedRequest(
    block: Readonly<AdjustmentBlock>,
  ): string {
    const attachmentLabels = block.imageLabels
      .filter((label) => !block.text.includes(`[${label}]`))
      .map((label) => `[${label}]`)
      .join(" ");
    return formatSubmittedRequest(
      [block.text, attachmentLabels].filter(Boolean).join(" "),
    );
  }

  private formatUserTranscriptEntry(
    entry: Pick<UITranscriptEntry, "text" | "images">,
  ): string {
    const images = entry.images
      ?.map((image) => `[${image.label}]`)
      .filter((label) => !entry.text.includes(label))
      .join(" ");
    return formatSubmittedRequest(
      [entry.text, images].filter(Boolean).join(" "),
    );
  }

  private disclosureHeaderLines(columns: number): readonly string[] {
    const session = this.uiState.header.session;
    const danger = session?.commandExecutionMode === "unrestricted";
    const title = danger ? "! EASY CODE" : "EASY CODE";
    const facts = session
      ? `${session.mode} · ${session.provider}/${session.model} · thinking:${session.thinkingEffort}`
      : "complete disclosure";
    const label = ` ${title} · ${facts} `;
    const fitted = truncateToWidth(label, Math.max(1, columns - 3), {
      preserveAnsi: false,
    });
    const fill = "─".repeat(Math.max(0, columns - 3 - displayWidth(fitted)));
    const border = danger ? chalk.red : chalk.cyan;
    return [border(`╭─${fitted}${fill}╮`), border(`╰${"─".repeat(Math.max(0, columns - 2))}╯`)];
  }

  private disclosureComposerLines(
    columns: number,
    rows: number,
  ): readonly string[] {
    const label = this.uiState.composer.busy ? "Adjust current task" : "Request";
    const fitted = truncateToWidth(` ${label} `, Math.max(1, columns - 3), {
      preserveAnsi: false,
    });
    const fill = "─".repeat(Math.max(0, columns - 3 - displayWidth(fitted)));
    const text = this.uiState.composer.text;
    const cursor = Math.max(0, Math.min(text.length, this.uiState.composer.cursor));
    const attachmentSuffix = this.uiState.composer.images
      .map((image) => `[${image.label}]`)
      .filter((marker) => !text.includes(marker))
      .join(" ");
    const before = text.slice(0, cursor);
    const after = text.slice(cursor);
    const placeholder = this.uiState.composer.placeholder ||
      (this.uiState.composer.busy
        ? "Type an adjustment for the current task…"
        : "Type your request…");
    const visibleDraft = text || attachmentSuffix
      ? `${before}${chalk.inverse(" ")}${after}` +
        `${attachmentSuffix ? `${text ? " " : ""}${attachmentSuffix}` : ""}`
      : `${chalk.inverse(" ")}${chalk.gray(placeholder)}`;
    const interiorWidth = Math.max(1, columns - 4);
    const allRows = wrapToWidth(`> ${visibleDraft}`, interiorWidth, {
      preserveAnsi: true,
    });
    // A very large draft remains fully retained in readline. Limit only the
    // on-screen composer window so complete Thinking/Adjustment content keeps
    // at least one transcript row, and mark either omitted side explicitly.
    const maximumDraftRows = Math.max(1, rows - 6);
    const cursorRow = Math.max(
      0,
      wrapToWidth(`> ${before}`, interiorWidth, { preserveAnsi: false }).length - 1,
    );
    const start = Math.max(
      0,
      Math.min(
        Math.max(0, allRows.length - maximumDraftRows),
        cursorRow - Math.floor(maximumDraftRows / 2),
      ),
    );
    const visibleRows = allRows.slice(start, start + maximumDraftRows);
    if (start > 0 && visibleRows.length > 0) {
      visibleRows[0] = chalk.gray("… ") + (visibleRows[0] ?? "");
    }
    if (start + visibleRows.length < allRows.length && visibleRows.length > 0) {
      visibleRows[visibleRows.length - 1] =
        (visibleRows.at(-1) ?? "") + chalk.gray(" …");
    }
    const framedRows = visibleRows.map((line) => {
      const clipped = truncateToWidth(line, interiorWidth, { preserveAnsi: true });
      const padding = " ".repeat(
        Math.max(0, interiorWidth - displayWidth(clipped)),
      );
      return `${chalk.cyan("│")} ${clipped}${padding} ${chalk.cyan("│")}`;
    });
    return [
      chalk.cyan(`╭─${fitted}${fill}╮`),
      ...framedRows,
      chalk.cyan(`╰${"─".repeat(Math.max(0, columns - 2))}╯`),
    ];
  }

  private disclosureFooterLines(): readonly string[] {
    return [chalk.gray(
      "Complete content · PgUp/PgDn scroll · drag to select/copy · type normally · " +
      "Ctrl/Cmd+click the title to close",
    )];
  }

  /**
   * Place a complete disclosure without the arbitrary empty band produced by
   * a fixed percentage anchor. A short current-turn document stays attached
   * to the Request card; a long document starts the selected Thinking block
   * at the top of the transcript viewport so its body is immediately useful.
   */
  private disclosureAnchorScreenRow(options: Readonly<{
    nodes: readonly VirtualDocumentNode[];
    target: Readonly<DisclosureViewTarget>;
    columns: number;
    rows: number;
    headerLines: readonly string[];
    composerLines: readonly string[];
    footerLines: readonly string[];
  }>): number {
    const wrappedRows = (lines: readonly string[]): number =>
      lines.reduce(
        (total, line) => total + wrapToWidth(line, options.columns, {
          preserveAnsi: true,
        }).length,
        0,
      );
    const headerRows = wrappedRows(options.headerLines);
    const composerRows = wrappedRows(options.composerLines);
    const footerRows = wrappedRows(options.footerLines);
    const viewportRows = Math.max(
      1,
      options.rows - headerRows - composerRows - footerRows,
    );
    const layout = layoutVirtualDocument(options.nodes, options.columns, {
      preserveAnsi: true,
    });
    const titleRow = layout.titleRows.get(options.target.id) ?? 0;

    if (layout.totalRows > viewportRows) return headerRows;

    // createDisclosureViewState derives scrollOffset as titleRow minus the
    // local anchor. This anchor therefore yields totalRows - viewportRows,
    // bottom-aligning the complete short document immediately above Request.
    const localAnchor = titleRow + viewportRows - layout.totalRows;
    return headerRows + Math.max(0, Math.min(viewportRows - 1, localAnchor));
  }

  private physicalColumns(): number {
    return Math.max(
      12,
      this.screen?.columns ??
        (Number((this.output as NodeJS.WriteStream).columns) || 80),
    );
  }

  private physicalRows(): number {
    const value = Number((this.output as NodeJS.WriteStream).rows);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 24;
  }

  private refresh(): void {
    if (this.disclosureViewer) {
      this.refreshDisclosureViewer();
      return;
    }
    if (
      !this.inlineShellActive ||
      !this.screen ||
      this.closed
    ) {
      return;
    }
    if (this.activePromptSession) {
      this.activePromptSession.refreshBelow();
      return;
    }
    if (this.promptActive) return;
    const live = renderLiveRegion(
      this.uiState,
      Date.now(),
      this.viewOptions(),
    );
    if (this.uiState.overlay) {
      this.screen.renderLive(live);
      this.syncTerminalCursorVisibility();
      return;
    }
    const tail = this.renderMutableTurnTail(
      false,
      this.mutableTailRowBudget(live, 1),
    );
    this.screen.renderLive(this.joinLiveBlocks(tail, live));
    this.syncTerminalCursorVisibility();
  }

  private viewOptions(): {
    columns: number;
    rows?: number;
    color: boolean;
    agentConcurrencyLimit?: number;
    spinnerFrame: number;
  } {
    const rows = Number((this.output as NodeJS.WriteStream).rows);
    return {
      columns: this.screen?.columns ??
        (Number((this.output as NodeJS.WriteStream).columns) || 80),
      ...(Number.isFinite(rows) && rows > 0 ? { rows: Math.floor(rows) } : {}),
      color: this.colorEnabled(),
      ...(this.agentConcurrencyLimit === undefined
        ? {}
        : { agentConcurrencyLimit: this.agentConcurrencyLimit }),
      spinnerFrame: this.activityFrameIndex,
    };
  }

  private commitTranscript(entry: Readonly<UITranscriptEntry>): void {
    this.uiState = applyEvent(this.uiState, {
      type: "transcript.append",
      entry,
    });
    const renderedText = entry.kind === "user"
      ? `${this.formatUserTranscriptEntry(entry)}\n\n`
      : entry.text;
    const viewer = this.disclosureViewer;
    if (viewer) {
      viewer.deferredCommits.push(renderedText);
      this.refreshDisclosureViewer(true);
      return;
    }
    // Only explicit disclosure segments belong in mutableTurnTail. Stable
    // transcript output must never inherit the disclosure tray's row budget.
    if (this.activePromptSession) {
      this.activePromptSession.writeAbove(renderedText);
    } else {
      this.screen?.commit(renderedText);
    }
  }

  private appendMutableTurnSegment(
    entry: Readonly<UITranscriptEntry>,
    reasoning?: Readonly<ReasoningBlock>,
    adjustment?: Readonly<AdjustmentBlock>,
  ): void {
    this.uiState = applyEvent(this.uiState, {
      type: "transcript.append",
      entry,
    });
    this.mutableTurnTail.push({
      entry: { ...entry },
      ...(reasoning ? { reasoning: { ...reasoning } } : {}),
      ...(adjustment ? { adjustment: { ...adjustment } } : {}),
    });
    if (this.disclosureViewer) this.refreshDisclosureViewer(true);
  }

  private renderMutableTurnTail(
    historical = false,
    maximumRows?: number,
  ): string {
    if (this.mutableTurnTail.length === 0) return "";
    const rendered = this.mutableTurnTail.map((segment) => {
      const adjustment = segment.adjustment;
      if (adjustment) {
        return `${this.formatAdjustmentAsSubmittedRequest(adjustment)}\n`;
      }
      const block = segment.reasoning;
      if (!block) return segment.entry.text;
      if (historical) {
        return renderReasoningHistoryMarker(block, {
          color: this.colorEnabled(),
        });
      }
      return renderReasoningMarker(block, { color: this.colorEnabled() });
    }).join("");
    if (historical || maximumRows === undefined) return rendered;
    const focusedDisclosure = (() => {
      const latest = [...this.mutableTurnTail].reverse().find((segment) =>
        segment.reasoning
      );
      return latest?.reasoning
          ? { kind: "thinking" as const, id: latest.reasoning.id }
          : undefined;
    })();
    return this.fitMutableTailRows(
      rendered,
      maximumRows,
      focusedDisclosure,
    );
  }

  /** Freeze the previous turn only when a new request takes ownership. */
  private flushMutableTurnTail(): void {
    if (this.mutableTurnTail.length === 0) return;
    const historical = this.renderMutableTurnTail(true).replace(/\n*$/u, "\n\n");
    this.screen?.clearLive();
    this.screen?.commit(historical);
    this.clearMutableTurnTail();
  }

  private clearMutableTurnTail(): void {
    this.mutableTurnTail = [];
    this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
  }

  private joinLiveBlocks(first: string, second: string): string {
    if (!first) return second;
    if (!second) return first;
    return `${first.replace(/\n+$/u, "")}\n\n${second}`;
  }

  private mutableTailRowBudget(otherLiveText: string, reservedRows: number): number {
    const rows = Number((this.output as NodeJS.WriteStream).rows);
    if (!Number.isFinite(rows) || rows < 1) return Number.MAX_SAFE_INTEGER;
    const otherRows = this.visualRowCount(otherLiveText);
    return Math.max(0, Math.floor(rows) - otherRows - Math.max(0, reservedRows));
  }

  private visualRowCount(text: string): number {
    if (!text) return 0;
    const columns = Math.max(1, this.screen?.columns ?? 80);
    return wrapToWidth(text, columns, { preserveAnsi: true }).length;
  }

  private fitMutableTailRows(
    text: string,
    maximumRows: number,
    focusedDisclosure?: Readonly<{
      kind: "thinking" | "adjustment";
      id: number;
    }>,
  ): string {
    const limit = Number.isFinite(maximumRows)
      ? Math.max(0, Math.floor(maximumRows))
      : Number.MAX_SAFE_INTEGER;
    if (limit === 0 || !text) return "";
    const columns = Math.max(1, this.screen?.columns ?? 80);
    const lines = wrapToWidth(text, columns, { preserveAnsi: true });
    if (lines.length <= limit) return lines.join("\n");
    if (limit === 1) return lines[0] ?? "";

    if (focusedDisclosure !== undefined) {
      const noun = focusedDisclosure.kind === "thinking"
        ? "Thinking"
        : "Queued adjustment";
      const command = focusedDisclosure.kind === "thinking"
        ? "thinking"
        : "adjustment";
      const anchorText = `▶ ${noun} #${focusedDisclosure.id}`;
      const anchorIndex = lines.findIndex((line) => stripAnsi(line).includes(anchorText));
      if (anchorIndex >= 0) {
        const contextBefore = Math.min(
          anchorIndex,
          Math.max(0, Math.floor((limit - 1) * 0.2)),
        );
        let start = Math.max(0, anchorIndex - contextBefore);
        let end = Math.min(lines.length, start + limit);
        if (end - start < limit) start = Math.max(0, end - limit);
        const window = lines.slice(start, end);
        if (start > 0 && window.length > 1) {
          window[0] = chalk.gray(`… ${start} earlier live row(s) hidden …`);
        }
        if (end < lines.length && window.length > 1) {
          window[window.length - 1] = chalk.gray(
            `… ${lines.length - end} later live row(s) hidden to keep Request responsive …`,
          );
        }
        return window.join("\n");
      }
    }

    // Keep the Thinking control at the beginning and the latest answer/tool
    // rows at the end. The omitted middle remains available after the next
    // request freezes the complete tail into scrollback.
    const contentRows = Math.max(1, limit - 1);
    const headRows = Math.max(1, Math.ceil(contentRows * 0.6));
    const tailRows = Math.max(0, contentRows - headRows);
    const omitted = chalk.gray(
      `… ${lines.length - headRows - tailRows} live row(s) hidden to keep Request responsive …`,
    );
    return [
      ...lines.slice(0, headRows),
      omitted,
      ...(tailRows > 0 ? lines.slice(lines.length - tailRows) : []),
    ].join("\n");
  }

  private removeRunningProgress(kind: UIProgressItem["kind"]): void {
    const retained = this.progressItems.filter((item) =>
      item.kind !== kind || item.status !== "running"
    );
    if (retained.length !== this.progressItems.length) {
      this.progressItems = retained;
      this.uiState = applyEvent(this.uiState, {
        type: "progress.set",
        progress: this.progressItems,
      });
    }
  }

  private writeStableStatus(text: string, kind: StableStatusKind): void {
    const rendered = kind === "error"
      ? chalk.red(text)
      : kind === "warning"
        ? chalk.yellow(text)
        : kind === "success"
          ? chalk.green(text)
          : chalk.cyan(text);
    const entry = { kind, text: `${rendered}\n` } as const;
    if (this.inlineShellActive) {
      this.commitTranscript(entry);
    } else {
      this.write(entry.text);
    }
  }

  private menuOverlay(
    id: string,
    kind: UIOverlayState["kind"],
    payload?: Readonly<ApprovalRequest> | Readonly<PlanProposal>,
  ): MenuSelectorOverlay {
    return {
      render: (lines) => {
        // A picker has no text caret. Hide the physical cursor before painting
        // it so ScreenWriter's live-region anchor is not exposed as a white
        // block/dot inside Progress when the VS Code terminal loses focus.
        this.setTerminalCursorVisible(false);
        const plain = lines.map((line) => stripAnsi(line));
        const renderedRows = plain.slice(1, -1);
        const selectedIndex = Math.max(
          0,
          renderedRows.findIndex((line) => /^\s*›/u.test(line)),
        );
        const rows = renderedRows.map((line, index) => ({
          id: `${id}-${index}`,
          label: line.replace(/^\s*[› ]\s?/u, "").trim(),
        }));
        const common = {
          id,
          title: plain[0]?.trim() || "Select",
          rows,
          selectedIndex,
          hint: plain[plain.length - 1]?.trim() ||
            "Use ↑/↓ to move, Enter to confirm, or Esc to cancel",
        };
        let overlay: UIOverlayState;
        if (kind === "approval") {
          overlay = {
            ...common,
            kind,
            request: payload as Readonly<ApprovalRequest>,
          };
        } else if (kind === "plan-review") {
          overlay = {
            ...common,
            kind,
            proposal: payload as Readonly<PlanProposal>,
          };
        } else {
          overlay = { ...common, kind: "picker" };
        }
        this.uiState = applyEvent(this.uiState, {
          type: "overlay.show",
          overlay,
        });
        this.refresh();
      },
      clear: () => {
        this.uiState = applyEvent(this.uiState, {
          type: "overlay.hide",
          id,
        });
        this.refresh();
      },
    };
  }

  private syncTerminalCursorVisibility(): void {
    if (!this.inlineShellActive) return;
    // readline owns a real edit caret. Busy/model state and modal overlays do
    // not: their cursor is only ScreenWriter's redraw anchor and must stay
    // hidden. Once an idle composer is about to open, make the caret visible
    // again without repainting or changing stdin ownership.
    const visible = this.promptActive || (
      !this.uiState.overlay &&
      !this.uiState.composer.busy &&
      !this.currentRequestOptions
    );
    this.setTerminalCursorVisible(visible);
  }

  private setTerminalCursorVisible(visible: boolean): void {
    if (!this.inlineShellActive || this.terminalCursorVisible === visible) return;
    this.output.write(visible ? "\u001B[?25h" : "\u001B[?25l");
    this.terminalCursorVisible = visible;
  }

  private composerPromptPrefix(): string {
    const columns = Math.max(12, this.screen?.columns ?? 80);
    const label = this.uiState.composer.busy
      ? " Adjust current task "
      : " Request ";
    const title = truncateToWidth(label, Math.max(1, columns - 3), {
      preserveAnsi: false,
    });
    const fill = "─".repeat(Math.max(0, columns - 3 - displayWidth(title)));
    const top = chalk.cyan(`╭─${title}${fill}╮`);
    const composer = `${top}\n${chalk.cyan("│")} > `;
    const suffixRows = this.visualRowCount(this.composerPromptSuffix());
    const rows = Number((this.output as NodeJS.WriteStream).rows);
    const tailBudget = Number.isFinite(rows) && rows > 0
      ? Math.max(0, Math.floor(rows) - suffixRows - 4)
      : undefined;
    const tail = this.renderMutableTurnTail(false, tailBudget);
    return tail ? this.joinLiveBlocks(tail, composer) : composer;
  }

  private composerBottomBorder(): string {
    const columns = Math.max(12, this.screen?.columns ?? 80);
    return chalk.cyan(`╰${"─".repeat(columns - 2)}╯`);
  }

  private composerPromptSuffix(): string {
    const options = this.viewOptions();
    const sections = [this.composerBottomBorder()];
    sections.push(renderComposerStatusRegion(this.uiState, options, Date.now()));
    return sections.join("\n");
  }

  private safeInline(value: string, maximum: number): string {
    // Remove controls first so invisible bytes cannot split a credential and
    // evade the broader sensitive-information redaction pass.
    const safe = redactSensitiveInformation(sanitizeCommandOutput(value))
      .replace(/[\r\n\t]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return safe.length <= maximum
      ? safe
      : `${safe.slice(0, Math.max(0, maximum - 1))}…`;
  }

  private canUseInlineShell(): boolean {
    const ci = process.env.CI?.trim().toLowerCase();
    const output = this.output as NodeJS.WriteStream;
    return Boolean(
      !this.closed &&
      this.input.isTTY &&
      output.isTTY &&
      typeof this.input.setRawMode === "function" &&
      !output.destroyed &&
      !output.writableEnded &&
      process.env.TERM !== "dumb" &&
      ci !== "1" &&
      ci !== "true",
    );
  }

  private colorEnabled(): boolean {
    const forceColor = process.env.FORCE_COLOR;
    return (
      !Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR") &&
      forceColor !== "0" &&
      (Boolean((this.output as NodeJS.WriteStream).isTTY) || Boolean(forceColor))
    );
  }

  private canAnimateActivity(): boolean {
    const ci = process.env.CI?.trim().toLowerCase();
    const output = this.output as NodeJS.WriteStream;
    return Boolean(
      !this.closed &&
      output.isTTY &&
      !output.destroyed &&
      !output.writableEnded &&
      process.env.TERM !== "dumb" &&
      ci !== "1" &&
      ci !== "true",
    );
  }

  private renderActivity(): void {
    if (this.inlineShellActive) {
      this.activityVisible = true;
      this.refresh();
      return;
    }
    const frame = Terminal.ACTIVITY_FRAMES[this.activityFrameIndex] ?? "•";
    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - this.activityStartedAt) / 1_000),
    );
    const elapsed = elapsedSeconds < 60
      ? `${elapsedSeconds}s`
      : `${Math.floor(elapsedSeconds / 60)}m ${String(elapsedSeconds % 60).padStart(2, "0")}s`;
    const prefix = `${frame} `;
    const suffix = ` · ${elapsed}`;
    const columns = Number((this.output as NodeJS.WriteStream).columns);
    const maxWidth = Number.isFinite(columns) && columns > 0
      ? Math.max(8, Math.floor(columns) - 1)
      : 120;
    const labelWidth = Math.max(0, maxWidth - prefix.length - suffix.length);
    const label = this.activityText.length <= labelWidth
      ? this.activityText
      : labelWidth >= 4
        ? `${this.activityText.slice(0, labelWidth - 3)}...`
        : "";
    const text = label
      ? `${prefix}${label}${suffix}`
      : `${frame} ${elapsed}`.slice(0, maxWidth);
    const rendered = this.colorEnabled() ? chalk.gray(text) : text;
    this.output.write(`\r\u001B[2K${rendered}`);
    this.activityVisible = true;
  }

  private resetActivityState(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = undefined;
    }
    this.activityVisible = false;
    this.activityText = "";
    this.activityStartedAt = 0;
    this.activityFrameIndex = 0;
  }
}

function formatSubmittedRequest(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  return normalized
    .split("\n")
    .map((line, index) => `${index === 0 ? "> " : "  "}${line}`)
    .join("\n");
}

export function printBanner(terminal: Terminal): void {
  if (terminal.isInlineShell()) {
    terminal.showSessionHeader();
    terminal.info("Type /help for commands, /model to switch models, or /exit to quit.");
    return;
  }
  terminal.write(chalk.bold.cyan("\nEASY CODE") + chalk.gray(" — local CLI coding agent\n"));
  terminal.write(chalk.gray("Type /help for commands, or /exit to quit.\n\n"));
  terminal.write(
    chalk.gray(
      process.platform === "win32"
        ? "Paste an image with Ctrl+V in VS Code. Use /image clipboard in terminals that intercept it.\n\n"
        : process.platform === "darwin"
          ? "Paste an image with Command+V in VS Code. Use /image clipboard in terminals that intercept it.\n\n"
          : "Paste an image with Ctrl+Shift+V in VS Code. Use /image clipboard in terminals that intercept it.\n\n",
    ),
  );
}
