import { TerminalDecisions, type TerminalDecisionsContext } from "./terminal-decisions.js";
import { TerminalDisclosureViewer, type TerminalDisclosureViewerContext } from "./terminal-disclosure-viewer.js";
import { TerminalInputOwnership, type TerminalInputOwnershipContext } from "./terminal-input-ownership.js";
import { classifyStatus } from "./terminal-status.js";
import type {
  ActiveDisclosureViewer,
  BusyInputOwner,
  CurrentTurnDisclosure,
  StableStatusKind,
} from "./terminal-types.js";

import chalk from "chalk";
import readline from "node:readline";
import { sanitizeCommandOutput } from "../command/output-stream.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  FileDiffPresentation,
  ImageAttachment,
  PlanProposal,
  ProviderStreamEvent,
  ThinkingEffort,
  ToolDisplayDetail,
} from "../core/types.js";
import { translate } from "../i18n/catalog.js";
import { DEFAULT_LANGUAGE, type Language } from "../i18n/language.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { formatPlanProposal } from "../plans/plan.js";
import { redactImageDataUrls } from "../providers/errors.js";
import type { SubagentView } from "../subagents/types.js";
import type { TaskGraphView } from "../tasks/task-graph.js";
import {
  compactionActivityLabel,
  compactionLabel,
  compactionRunning,
  type CompactionProgress,
} from "../ui/compaction.js";
import type {
  UIActivityKind,
  UIProgressItem,
  UIReviewPhase,
  UISessionInfo,
  UITranscriptEntry,
} from "../ui/contracts.js";
import type {
  AppInteractionPort,
  CurrentRequestOptions,
  InteractionChoice,
  PlanReviewDecision,
  PlanReviewInputOptions,
  TimedChoiceOptions,
} from "../ui/interaction-port.js";
import { displayWidth, truncateToWidth } from "../ui/render/layout.js";
import { ScreenWriter } from "../ui/render/screen-writer.js";
import { renderComposerStatusRegion, renderLiveRegion, renderSessionHeader } from "../ui/render/view.js";
import { applyEvent, createUIState } from "../ui/store.js";
import {
  FULL_SCREEN_EXIT_SEQUENCE,
  clearDisclosureViewTarget,
  createDisclosureViewState,
  scrollDisclosureViewToEnd,
} from "../ui/tui/index.js";
import { AdjustmentRegistry, renderAdjustmentBody, type AdjustmentBlock } from "./adjustment.js";
import { formatUserTranscriptEntry, type DisclosureKind, type TerminalViewOptions } from "./disclosure-render.js";
import { renderFileDiff } from "./file-diff.js";
import { formatToolTranscript, toolTarget } from "./transcript-format.js";
import {
  type ModelSelectorChoice,
  type ProviderSelectorChoice,
  type ThinkingEffortSelectorChoice,
} from "./model-selector.js";
import { ModelStreamRenderer } from "./model-stream-renderer.js";
import {
  PrivateOscInputFilter,
  type PromptInput,
  type PromptInputSession,
  type PromptSubmission,
} from "./prompt-input.js";
import { ReasoningRegistry, renderReasoningBody, renderReasoningMarker, type ReasoningBlock } from "./reasoning.js";
import { renderSubagents } from "./subagents.js";
import { renderTaskGraph } from "./task-graph.js";
import { createVsCodeMenuBridge } from "./vscode-menu-bridge.js";

export type { CurrentRequestOptions, PlanReviewDecision, PlanReviewInputOptions } from "../ui/interaction-port.js";

export class Terminal implements AppInteractionPort {
  private static readonly ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
  // Human-readable elapsed time does not need an 80 ms repaint cadence. This
  // fixed UI cadence reduces ConPTY work without becoming runtime config.
  private static readonly ACTIVITY_INTERVAL_MS = 160;

  private rl?: readline.Interface;
  private closed = false;
  private language: Language = DEFAULT_LANGUAGE;
  private promptActive = false;
  private guardedInputActive = false;
  private secretInputActive = false;
  private activePromptController?: AbortController;
  private externalOperationController?: AbortController;
  private readlineInputFilter?: PrivateOscInputFilter;
  private currentRequestOptions?: Readonly<CurrentRequestOptions>;
  /** Coalesce a Ctrl+C key-repeat burst into one cancellation per request. */
  private currentRequestInterruptSignaled = false;
  private activeApprovalController?: AbortController;
  private busyInputOwner?: BusyInputOwner;
  private busyPromptController?: AbortController;
  private busyPromptSession?: PromptInputSession;
  private busyPromptGeneration = 0;
  private steeringDeliveryQueue: Promise<void> = Promise.resolve();
  private steeringAdmissionPaused = false;
  private readonly reasoning = new ReasoningRegistry();
  private readonly adjustments = new AdjustmentRegistry();
  private readonly streams = new ModelStreamRenderer({
    reasoning: this.reasoning,
    isClosed: () => this.closed,
    canStreamIntoDocument: () => this.inlineShellActive && this.isInteractive() && Boolean(this.disclosureViewer),
    hasDisclosureDocument: () => Boolean(this.disclosureViewer),
    activeActivityId: () => this.activeActivityId,
    showToolArgumentProgress: (text) => this.showToolArgumentProgress(text),
    colorEnabled: () => this.colorEnabled(),
    safeInline: (value, maximum) => this.safeInline(value, maximum),
    safeStreamText: (value) => this.safeStreamText(value),
    commitTranscript: (entry) => this.commitTranscript(entry),
    replaceTranscriptEntry: (id, entry) => this.replaceTranscriptEntry(id, entry),
    retainCurrentTurnDisclosure: (entry, block) => this.retainCurrentTurnDisclosure(entry, block),
    retainReasoningDisclosure: (entryId, block) => {
      this.retainedReasoningDisclosures.set(entryId, block);
    },
    refreshDisclosureViewer: (nodesChanged) => this.refreshDisclosureViewer(nodesChanged),
    failTerminalUi: (stage, value) => this.failTerminalUi(stage, value),
  });
  /** Visible Thinking controls outlive a model turn, but not a display/thread reset.
   * Keep the existing immutable bodies by reference; do not duplicate history. */
  private readonly retainedReasoningDisclosures = new Map<string, Readonly<ReasoningBlock>>();
  /**
   * Ownership metadata for the most recent turn. Thinking interactivity is
   * retained separately across later inputs. Ordinary rows are committed
   * directly to scrollback so a long answer can never be clipped merely to
   * keep these controls interactive.
   */
  private currentTurnDisclosures: CurrentTurnDisclosure[] = [];
  /**
   * First transcript entry owned by the current model turn. The boundary is
   * intentionally retained after completion so its Thinking controls remain
   * useful beside the idle Request editor, then replaced only when a new turn
   * actually starts.
   */
  private currentTurnTranscriptStart?: number;
  /** Exclusive completed-turn boundary; active turns grow to transcript.length. */
  /** User row committed by readPrompt before executePrompt calls setCurrentRequest. */
  private pendingRequestTranscriptStart?: number;
  /** A completed turn remains viewable, but a later direct/resumed request is new. */
  private currentTurnCompleted = false;
  private activityTimer?: NodeJS.Timeout;
  private contextTokensProvider?: () => number;
  private lastContextTokenSampleAt = 0;
  private lastReviewElapsedSecond = -1;
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
  private compactionActivity?: string;
  private compactionPhase?: string;
  /** Re-opens steering after automatic compaction; interjections are not admitted meanwhile. */
  private resumeAfterCompaction?: () => void;
  private agentConcurrencyLimit?: number;
  /** Track DEC cursor visibility while EASY CODE owns the inline shell. */
  private terminalCursorVisible = true;
  private fatalUiFailure?: Error;
  private inputOwnerWatchdog?: NodeJS.Timeout;
  private inputOwnerMissingSince?: number;
  private readonly onOutputError = (error: Error): void => {
    this.failTerminalUi("terminal output", error);
  };
  private readonly onInputError = (error: Error): void => {
    this.failTerminalUi("terminal input", error);
  };
  private readonly vscodeMenuBridge = createVsCodeMenuBridge();
  private readonly onResize = (): void => {
    if (this.disclosureViewer) this.resizeDisclosureViewer();
    else this.refresh();
  };

  constructor(
    private readonly input: PromptInput = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    // VS Code terminal links use the authenticated loopback bridge whenever
    // both sides advertise support. Keeping this event out of the PTY avoids
    // xterm scrolling the primary buffer to the input cursor before opening
    // or closing the alternate-screen disclosure viewer.
    this.vscodeMenuBridge?.onDisclosureToggle((kind, id) => {
      this.handleDisclosureToggle(kind, id);
    });
  }

  setLanguage(language: Language): void {
    this.language = language;
    this.refresh();
  }
  /** Host integration boundary for opening a retained disclosure without injecting terminal input. */
  handleDisclosureToggle(kind: DisclosureKind, id: number): boolean {
    return this.disclosure.handleDisclosureToggle(kind, id);
  }

  isInteractive(): boolean {
    return Boolean(this.input.isTTY && (this.output as NodeJS.WriteStream).isTTY);
  }

  configureStreaming(limits: { streamFlushIntervalMs: number; streamPreviewMaxChars: number }): void {
    this.streams.configure(limits);
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
    this.screen = new ScreenWriter({
      output: this.output as NodeJS.WriteStream,
      columns: () => (this.output as NodeJS.WriteStream).columns,
      onFailure: (error) => this.failTerminalUi("inline renderer", error),
    });
    this.inlineShellActive = true;
    this.output.on("resize", this.onResize);
    this.output.on("error", this.onOutputError);
    this.input.on("error", this.onInputError);
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

  /** Keep the footer's short-term context estimate current during a running turn. */
  setContextTokensProvider(provider: (() => number) | undefined): void {
    this.contextTokensProvider = provider;
    this.lastContextTokenSampleAt = 0;
  }

  showSessionHeader(): void {
    if (!this.inlineShellActive || !this.screen) return;
    if (this.disclosureViewer) {
      this.refreshDisclosureViewer();
      return;
    }
    this.screen.commit(`\n${renderSessionHeader(this.uiState, this.viewOptions())}\n\n`);
    this.refresh();
  }

  setCurrentRequest(
    text: string,
    images: readonly Readonly<ImageAttachment>[] = [],
    options: Readonly<CurrentRequestOptions> = {},
  ): void {
    this.stopReview();
    this.activeApprovalController?.abort();
    this.stopBusyComposer();
    this.stopBusyInputOwner();
    this.steeringAdmissionPaused = false;
    this.currentRequestOptions = options;
    this.currentRequestInterruptSignaled = false;
    if (!this.inlineShellActive) return;
    const pendingStart = this.pendingRequestTranscriptStart;
    // A completed turn remains interactive while its idle Request editor is
    // visible. Starting the next busy turn is the ownership boundary at which
    // the current expansion closes. Retained Thinking can still be reopened.
    if (!this.uiState.composer.busy) this.freezeCurrentTurnDisclosures();
    const pendingEntry = pendingStart === undefined ? undefined : this.uiState.transcript[pendingStart];
    if (pendingEntry?.kind === "user") {
      this.currentTurnTranscriptStart = pendingStart;
    } else if (this.currentTurnTranscriptStart === undefined || this.currentTurnCompleted) {
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
    this.streams.forget();
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
    this.startPersistentViewer();
    if (this.disclosureViewer) {
      // An explicit new request returns the conversation to its live edge.
      // Manual inspection stays stable during streaming, but it must not hide
      // the next user turn above the visible viewport.
      this.disclosureViewer.state = scrollDisclosureViewToEnd(this.disclosureViewer.state);
      this.refreshDisclosureViewer(true);
    } else {
      this.refresh();
    }
    if (options.onSteer) this.startBusyComposer();
    else this.startBusyInputOwner();
    this.startInputOwnerWatchdog();
  }

  clearCurrentRequest(): void {
    this.stopReview();
    this.activeApprovalController?.abort();
    this.currentRequestOptions = undefined;
    this.currentRequestInterruptSignaled = false;
    this.steeringAdmissionPaused = false;
    this.resumeAfterCompaction = undefined;
    this.stopBusyComposer();
    this.stopBusyInputOwner();
    this.stopInputOwnerWatchdog();
    if (!this.inlineShellActive) return;
    this.currentTurnCompleted = true;
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
  async sealCurrentRequestSteering<T>(seal: () => T | undefined | Promise<T | undefined>): Promise<T | undefined> {
    const paused = this.pauseSteeringAdmission();
    if (!paused) return seal();
    try {
      await paused.flush();
      await this.steeringDeliveryQueue.catch(() => undefined);
      const result = await seal();
      if (result !== undefined) paused.resume();
      return result;
    } catch (error) {
      paused.resume();
      throw error;
    }
  }

  /**
   * Freeze the busy editor and own stdin so no new adjustment can be typed or
   * submitted until resume(). Undefined when steering admission is not open.
   * resume() is a no-op once the request that was paused has been cleared.
   */
  private pauseSteeringAdmission(): { flush(): Promise<void>; resume(): void } | undefined {
    const requestOptions = this.currentRequestOptions;
    if (!requestOptions?.onSteer || this.steeringAdmissionPaused) return undefined;

    this.steeringAdmissionPaused = true;
    const session = this.busyPromptSession;
    const editorSuspended = session?.suspendInput() ?? false;
    if (editorSuspended) {
      if (this.activePromptSession === session) this.activePromptSession = undefined;
      const viewer = this.disclosureViewer;
      if (viewer && viewer.suspendedSession === session) {
        delete viewer.suspendedSession;
        viewer.sessionReleased = true;
      }
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
        const viewer = this.disclosureViewer;
        if (viewer) {
          viewer.suspendedSession = session;
          viewer.sessionReleased = false;
          this.refreshDisclosureViewer();
        } else {
          session.resumeInput();
          this.activePromptSession = session;
          this.promptActive = true;
          this.refresh();
        }
        return;
      }
      this.startBusyComposer();
      this.startBusyInputOwner();
    };

    return {
      flush: async () => {
        await session?.flushSubmissions();
      },
      resume,
    };
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
    details?: readonly ToolDisplayDetail[],
  ): void {
    if (!this.inlineShellActive) return;
    // Completion is durable scrollback. Keeping a second completed copy in the
    // redrawable region makes every tool appear twice and lets Progress grow
    // for the lifetime of a request.
    this.removeRunningProgress("tool");
    // The result rows must not become a preview of a longer or multiline
    // summary: scrollback keeps the complete sanitized text.
    const multiline = (value: string | undefined): string =>
      value ? redactSensitiveInformation(sanitizeCommandOutput(value)).trim().replace(/\r\n?/gu, "\n") : "";
    const target = toolTarget(details);
    this.commitTranscript({
      kind: "tool",
      text: `${formatToolTranscript({
        name: this.safeInline(toolName, 80),
        ok,
        summary: multiline(summary),
        error: ok ? "" : multiline(error),
        ...(target ? { target: this.safeInline(target, 160) } : {}),
        color: this.colorEnabled(),
      })}\n`,
      title: toolName,
    });
    this.refresh();
  }

  clearScreen(): void {
    // Only the process-local display is cleared, never Runtime history, tasks,
    // memory, pending input or cancellation ownership. Discard old text before
    // rebuilding the virtual document, so /clear cannot reflow it all again.
    this.uiState = { ...this.uiState, transcript: [], live: { ...this.uiState.live, thinking: null } };
    this.currentTurnDisclosures = [];
    this.retainedReasoningDisclosures.clear();
    this.currentTurnTranscriptStart = this.uiState.composer.busy ? 0 : undefined;
    this.pendingRequestTranscriptStart = undefined;
    this.streams.forget();
    if (!this.inlineShellActive) {
      if ((this.output as NodeJS.WriteStream).isTTY) this.output.write("\u001B[3J\u001B[2J\u001B[H");
      return;
    }
    const viewer = this.disclosureViewer;
    if (viewer && !viewer.closing) {
      // RIS would leave DEC 1049 while FullScreenWriter still believed its
      // alternate buffer and row cache were active. Invalidate and repaint
      // through the owner instead, keeping one coherent fixed-height shell.
      viewer.deferredCommits.length = 0;
      viewer.clearPrimaryOnClose = true;
      viewer.primaryDisplayDirty = true;
      // Do not normalize the previous (possibly very large) document just to
      // clear its selection/scroll offset. Build an empty projection instead.
      viewer.state = createDisclosureViewState({
        nodes: [],
        columns: viewer.state.columns,
        rows: viewer.state.rows,
        headerLines: viewer.state.headerLines,
        composerLines: viewer.state.composerLines,
        footerLines: viewer.state.footerLines,
        preserveAnsi: viewer.state.preserveAnsi,
      });
      delete viewer.kind;
      delete viewer.registryId;
      this.refreshDisclosureViewer(true);
      this.reclaimPersistentViewerInput();
      return;
    }
    this.screen?.clearScreen();
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
    this.clearCurrentTurnDisclosures();
    this.retainedReasoningDisclosures.clear();
    this.currentTurnTranscriptStart = undefined;
    this.pendingRequestTranscriptStart = undefined;
    this.currentTurnCompleted = false;
    this.streams.forget();
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

  async readPrompt(
    prompt: string,
    options: {
      initialImageCount?: number;
      captureImage: (index: number, signal?: AbortSignal) => Promise<ImageAttachment>;
      captureText?: (signal?: AbortSignal) => Promise<string | undefined>;
    },
  ): Promise<PromptSubmission | null> {
    return this.decisionController.readPrompt(prompt, options);
  }
  async selectProvider(
    choices: readonly ProviderSelectorChoice[],
    initialProvider: ProviderSelectorChoice["provider"],
  ): Promise<ProviderSelectorChoice["provider"] | undefined> {
    return this.decisionController.selectProvider(choices, initialProvider);
  }
  async selectModel(
    providerName: string,
    choices: readonly ModelSelectorChoice[],
    initialModel?: string,
  ): Promise<string | undefined> {
    return this.decisionController.selectModel(providerName, choices, initialModel);
  }
  async selectThinkingEffort(
    providerName: string,
    model: string,
    choices: readonly ThinkingEffortSelectorChoice[],
    initialEffort: ThinkingEffort,
  ): Promise<ThinkingEffort | undefined> {
    return this.decisionController.selectThinkingEffort(providerName, model, choices, initialEffort);
  }
  async readSecret(prompt: string): Promise<string> {
    return this.decisionController.readSecret(prompt);
  }

  private recordAcceptedPlanFeedback(feedback: string): void {
    this.decisionController.recordAcceptedPlanFeedback(feedback);
  }
  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    return this.decisionController.approve(request);
  }

  showPlan(plan: Readonly<PlanProposal>): void {
    this.lastPlan = plan;
    this.write(`\n${formatPlanProposal(plan)}\n`);
  }
  async reviewPlan(options: Readonly<PlanReviewInputOptions> = {}): Promise<PlanReviewDecision> {
    return this.decisionController.reviewPlan(options);
  }
  async selectChoice(
    title: string,
    choices: readonly InteractionChoice[],
    initialId?: string,
    timed?: Readonly<TimedChoiceOptions>,
  ): Promise<string | undefined> {
    return this.decisionController.selectChoice(title, choices, initialId, timed);
  }

  /** Keep Ctrl+C meaningful while an idle raw-mode shell awaits an external callback. */
  async withCancellableExternalOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed || this.externalOperationController) throw new Error("A terminal operation is already active.");
    const controller = new AbortController();
    this.externalOperationController = controller;
    const onInterrupt = (): void => {
      if (controller.signal.aborted) return;
      const error = new Error("External authorization canceled by user");
      error.name = "AbortError";
      controller.abort(error);
    };
    process.on("SIGINT", onInterrupt);
    try {
      return await operation(controller.signal);
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      if (this.externalOperationController === controller) this.externalOperationController = undefined;
    }
  }

  compactionProgress(progress: CompactionProgress): void {
    if (compactionRunning(progress)) {
      if (!this.compactionPhase) {
        if (progress.mode === "automatic") this.resumeAfterCompaction = this.pauseSteeringAdmission()?.resume;
        this.compactionActivity = this.startActivity(
          compactionActivityLabel(progress, this.language === "zh_cn"),
          "model",
          undefined,
          progress.startedAt,
        );
        this.compactionPhase = progress.phase;
        if (!this.isInteractive()) this.info(compactionLabel(progress, this.language === "zh_cn"));
      }
      return;
    }
    this.stopActivity(this.compactionActivity);
    this.compactionActivity = undefined;
    this.compactionPhase = undefined;
    const resume = this.resumeAfterCompaction;
    this.resumeAfterCompaction = undefined;
    resume?.();
    this.write(`${compactionLabel(progress, this.language === "zh_cn")}\n`);
  }

  write(text: string): void {
    if (this.closed) return;
    if (this.inlineShellActive) {
      this.commitTranscript({ kind: "raw", text });
      this.refresh();
      return;
    }
    this.stopActivity();
    this.output.write(text);
  }

  /** Begin an independently tracked review without taking over the editor. */
  startReview(): string {
    const id = `review_ui_${Date.now()}_${++this.activitySequence}`;
    this.uiState = applyEvent(this.uiState, {
      type: "review.set",
      review: { id, startedAt: Date.now(), phase: "main_brief" },
    });
    this.lastReviewElapsedSecond = -1;
    this.refresh();
    this.ensureUiTicker();
    return id;
  }

  updateReview(id: string, phase: UIReviewPhase): void {
    const prior = this.uiState.live.review;
    if (!prior || prior.id !== id) return;
    this.uiState = applyEvent(this.uiState, {
      type: "review.set",
      review: { ...prior, phase },
    });
    this.refresh();
  }

  stopReview(id?: string): void {
    if (!this.uiState.live.review || (id && this.uiState.live.review.id !== id)) return;
    this.uiState = applyEvent(this.uiState, { type: "review.clear", ...(id ? { id } : {}) });
    this.lastReviewElapsedSecond = -1;
    if (!this.activeActivityId && this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = undefined;
    }
    this.refresh();
  }

  startActivity(
    text: string,
    kind: UIActivityKind = "model",
    _toolName?: string,
    startedAt = Date.now(),
  ): string | undefined {
    this.stopActivity();
    if (!this.canAnimateActivity()) return undefined;

    const sanitized = this.safeInline(text, 160);
    this.activityText = sanitized || "Waiting for the model response";
    this.activityStartedAt = startedAt;
    this.activityFrameIndex = 0;
    this.activitySequence += 1;
    this.activeActivityId = `activity_${this.activityStartedAt}_${this.activitySequence}`;
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
    } catch (error) {
      if (this.inlineShellActive) {
        this.uiState = applyEvent(this.uiState, {
          type: "activity.stop",
          ...(this.activeActivityId ? { id: this.activeActivityId } : {}),
        });
      }
      this.resetActivityState();
      this.activeActivityId = undefined;
      this.failTerminalUi("activity renderer", error);
      return undefined;
    }

    this.ensureUiTicker();
    return this.activeActivityId;
  }

  /** One refresh clock serves model/tool activity and review elapsed time. */
  private ensureUiTicker(): void {
    if (this.activityTimer || !this.canAnimateActivity()) return;
    this.activityTimer = setInterval(() => {
      try {
        if (!this.canAnimateActivity()) {
          this.stopActivity();
          return;
        }
        if (this.activeActivityId) {
          this.activityFrameIndex = (this.activityFrameIndex + 1) % Terminal.ACTIVITY_FRAMES.length;
          this.renderActivity();
        } else if (this.inlineShellActive && this.uiState.live.review) {
          const elapsed = Math.max(0, Math.floor((Date.now() - this.uiState.live.review.startedAt) / 1_000));
          if (elapsed !== this.lastReviewElapsedSecond) {
            this.lastReviewElapsedSecond = elapsed;
            this.refresh();
          }
        }
      } catch (error) {
        this.failTerminalUi("activity renderer", error);
      }
    }, Terminal.ACTIVITY_INTERVAL_MS);
    this.activityTimer.unref();
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
    this.write(
      renderSubagents(agents, {
        color: this.colorEnabled(),
        ...(taskGraph ? { taskGraph } : {}),
        ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
      }),
    );
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
    const streamedId = this.streams.consumeStreamedReasoning(text);
    if (streamedId !== undefined) return streamedId;
    const block = this.reasoning.add(text);
    if (this.isInteractive()) {
      const entry = {
        kind: "raw",
        id: `thinking_${block.id}`,
        text: renderReasoningMarker(block, { color: this.colorEnabled() }),
        reasoning: block.text,
      } as const;
      if (this.inlineShellActive) {
        this.retainCurrentTurnDisclosure(entry, block);
      } else {
        this.write(entry.text);
      }
    }
    return block.id;
  }

  /** Project transient provider deltas into stable in-place transcript nodes. */
  modelStream(event: Readonly<ProviderStreamEvent>): void {
    this.streams.onEvent(event);
  }

  /** Reconcile the streamed final node with the Runtime's assembled result. */
  finalizeStreamedAnswer(text: string): boolean {
    return this.streams.finalizeAnswer(text);
  }

  /** Show streamed tool-argument progress as the label of the active activity. */
  private showToolArgumentProgress(text: string): void {
    this.activityText = text;
    if (this.inlineShellActive) {
      const current = this.uiState.live.activity;
      if (current && current.id === this.activeActivityId) {
        this.uiState = applyEvent(this.uiState, {
          type: "activity.start",
          activity: { ...current, label: this.activityText },
        });
      }
    }
    this.renderActivity();
  }

  peerMessage(senderThreadId: string, text: string, outgoing = false): void {
    const body = redactSensitiveInformation(
      sanitizeCommandOutput(
        `${outgoing ? "To" : "From"} Thread ${senderThreadId} · ${outgoing ? "queued" : "Agent"}\n${text}`,
      ),
    );
    if (this.inlineShellActive) {
      this.commitTranscript({ kind: "assistant", id: `peer_${Date.now()}_${Math.random()}`, text: body });
      this.refresh();
    } else this.write(`${body}\n\n`);
  }

  /** Retain one durable user adjustment and present it as ordinary user input. */
  addQueuedAdjustment(id: number, text: string, images: readonly Readonly<ImageAttachment>[] = []): number {
    const block = this.adjustments.add(id, text, images);
    if (this.isInteractive()) {
      const entry = {
        kind: "user",
        id: `adjustment_message_${block.id}`,
        text: block.text,
        images: images.map((image) => ({ ...image })),
      } as const;
      if (this.inlineShellActive) {
        // The adjustment registry remains available to the disclosure viewer,
        // while the main transcript shows only the user-authored message. Runtime
        // queue terminology and disclosure controls are implementation detail.
        this.commitTranscript(entry);
        this.refresh();
      } else {
        this.write(`${formatUserTranscriptEntry(entry)}\n\n`);
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

  /** Rebuild retained Thinking history for a resumed Thread without replaying old markers. */
  restoreReasoning(texts: readonly string[]): number {
    this.closeDisclosureViewer();
    this.retainedReasoningDisclosures.clear();
    this.clearCurrentTurnDisclosures();
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
    this.streams.forget();
    this.closeDisclosureViewer();
    this.retainedReasoningDisclosures.clear();
    this.freezeCurrentTurnDisclosures();
    this.reasoning.clear();
    this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
    this.refresh();
  }

  close(): void {
    this.streams.reset();
    this.activeApprovalController?.abort();
    this.vscodeMenuBridge?.close();
    if (this.closed) return;
    // Latch first so viewer/editor cleanup cannot reacquire input while the
    // terminal is being dismantled.
    this.closed = true;
    this.stopInputOwnerWatchdog();
    this.closeDisclosureViewer();
    this.currentRequestOptions = undefined;
    this.stopBusyComposer();
    this.stopBusyInputOwner();
    this.stopReview();
    this.stopActivity();
    if (this.inlineShellActive) {
      this.output.removeListener("resize", this.onResize);
      this.output.removeListener("error", this.onOutputError);
      this.input.removeListener("error", this.onInputError);
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
    this.activePromptController?.abort();
    this.activePromptController = undefined;
    this.externalOperationController?.abort();
    this.externalOperationController = undefined;
    const rl = this.rl;
    rl?.close();
    if (rl) this.releaseReadlineInput(rl);
  }
  private ensureReadline(): readline.Interface {
    return this.inputOwnership.ensureReadline();
  }
  private releaseReadlineInput(rl: readline.Interface): void {
    return this.inputOwnership.releaseReadlineInput(rl);
  }
  private startBusyComposer(): void {
    return this.inputOwnership.startBusyComposer();
  }
  private stopBusyComposer(): void {
    return this.inputOwnership.stopBusyComposer();
  }
  private startBusyInputOwner(): void {
    return this.inputOwnership.startBusyInputOwner();
  }
  private stopBusyInputOwner(): void {
    return this.inputOwnership.stopBusyInputOwner();
  }
  private async withPrivateProtocolFilteredInput<T>(action: (input: PrivateOscInputFilter) => Promise<T>): Promise<T> {
    return this.inputOwnership.withPrivateProtocolFilteredInput(action);
  }
  private openDisclosureViewer(kind: DisclosureKind, id: number): boolean {
    return this.disclosure.openDisclosureViewer(kind, id);
  }
  private startPersistentViewer(
    promptSession?: PromptInputSession,
    initialDisclosure?: Readonly<{ kind: DisclosureKind; id: number }>,
  ): boolean {
    return this.disclosure.startPersistentViewer(promptSession, initialDisclosure);
  }
  private releaseDisclosurePromptSession(session: PromptInputSession | undefined): void {
    return this.disclosure.releaseDisclosurePromptSession(session);
  }
  private reclaimPersistentViewerInput(): void {
    return this.disclosure.reclaimPersistentViewerInput();
  }
  private closeDisclosureViewer(): void {
    return this.disclosure.closeDisclosureViewer();
  }
  private refreshDisclosureViewer(nodesChanged = false): void {
    return this.disclosure.refreshDisclosureViewer(nodesChanged);
  }
  private resizeDisclosureViewer(): void {
    return this.disclosure.resizeDisclosureViewer();
  }
  private signalCurrentRequestInterrupt(): void {
    return this.inputOwnership.signalCurrentRequestInterrupt();
  }
  private startInputOwnerWatchdog(): void {
    return this.inputOwnership.startInputOwnerWatchdog();
  }
  private stopInputOwnerWatchdog(): void {
    return this.inputOwnership.stopInputOwnerWatchdog();
  }

  private physicalColumns(): number {
    return Math.max(12, this.screen?.columns ?? (Number((this.output as NodeJS.WriteStream).columns) || 80));
  }

  private physicalRows(): number {
    const value = Number((this.output as NodeJS.WriteStream).rows);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 24;
  }

  private refresh(): void {
    if (this.secretInputActive) return;
    this.sampleContextTokens();
    if (this.disclosureViewer) {
      this.refreshDisclosureViewer();
      return;
    }
    if (!this.inlineShellActive || !this.screen || this.closed) {
      return;
    }
    if (this.activePromptSession) {
      this.activePromptSession.refreshBelow();
      return;
    }
    if (this.promptActive) return;
    const live = renderLiveRegion(this.uiState, Date.now(), this.viewOptions());
    if (this.uiState.overlay) {
      this.screen.renderLive(live);
      this.syncTerminalCursorVisibility();
      return;
    }
    this.screen.renderLive(live);
    this.syncTerminalCursorVisibility();
  }

  private sampleContextTokens(): void {
    const provider = this.contextTokensProvider;
    const current = this.uiState.header.session;
    if (!provider || !current || !this.inlineShellActive || this.closed) return;
    const now = Date.now();
    if (now - this.lastContextTokenSampleAt < 1_000) return;
    this.lastContextTokenSampleAt = now;
    try {
      const contextTokens = provider();
      if (!Number.isFinite(contextTokens) || contextTokens < 0 || contextTokens === current.contextTokens) return;
      this.uiState = applyEvent(this.uiState, {
        type: "session.set",
        session: { ...current, contextTokens },
      });
    } catch {
      // Context display is observational and must not interrupt input or the agent.
    }
  }

  private viewOptions(): TerminalViewOptions {
    const rows = Number((this.output as NodeJS.WriteStream).rows);
    return {
      language: this.language,
      columns: this.screen?.columns ?? (Number((this.output as NodeJS.WriteStream).columns) || 80),
      ...(Number.isFinite(rows) && rows > 0 ? { rows: Math.floor(rows) } : {}),
      color: this.colorEnabled(),
      ...(this.agentConcurrencyLimit === undefined ? {} : { agentConcurrencyLimit: this.agentConcurrencyLimit }),
      spinnerFrame: this.activityFrameIndex,
    };
  }

  private commitTranscript(entry: Readonly<UITranscriptEntry>): void {
    this.uiState = applyEvent(this.uiState, {
      type: "transcript.append",
      entry,
    });
    const renderedText = entry.kind === "user" ? `${formatUserTranscriptEntry(entry)}\n\n` : entry.text;
    const viewer = this.disclosureViewer;
    if (viewer) {
      viewer.deferredCommits.push({
        ...(entry.id ? { id: entry.id } : {}),
        text: renderedText,
      });
      this.refreshDisclosureViewer(true);
      return;
    }
    // Disclosure metadata is retained separately, but every visible marker is
    // an ordinary stable transcript commit in the same event-time sequence.
    if (this.activePromptSession) {
      this.activePromptSession.writeAbove(renderedText);
    } else {
      this.screen?.commit(renderedText);
    }
  }

  /** Replace a mutable transcript node while preserving its document position. */
  private replaceTranscriptEntry(id: string, entry: Readonly<UITranscriptEntry>): void {
    const existing = this.uiState.transcript.find((candidate) => candidate.id === id);
    if (!existing) return;
    this.uiState = applyEvent(this.uiState, {
      type: "transcript.replace",
      id,
      entry,
    });
    const renderedText = entry.kind === "user" ? `${formatUserTranscriptEntry(entry)}\n\n` : entry.text;
    const viewer = this.disclosureViewer;
    if (viewer) {
      for (let index = viewer.deferredCommits.length - 1; index >= 0; index -= 1) {
        const commit = viewer.deferredCommits[index];
        if (commit?.id === id) {
          commit.text = renderedText;
          break;
        }
      }
      this.refreshDisclosureViewer(true);
    }
  }

  private retainCurrentTurnDisclosure(
    entry: Readonly<UITranscriptEntry>,
    reasoning?: Readonly<ReasoningBlock>,
    adjustment?: Readonly<AdjustmentBlock>,
  ): void {
    // Register the disclosure body before committing its marker. A viewer can
    // be open while the model emits another Thinking block; commitTranscript
    // refreshes that viewer immediately and must be able to resolve the body.
    if (reasoning && entry.id) this.retainedReasoningDisclosures.set(entry.id, reasoning);
    this.currentTurnDisclosures.push({
      entry: { ...entry },
      ...(reasoning ? { reasoning: { ...reasoning } } : {}),
      ...(adjustment ? { adjustment: { ...adjustment } } : {}),
    });
    this.commitTranscript(entry);
  }

  /** Freeze the previous turn only when a new request takes ownership. */
  private freezeCurrentTurnDisclosures(): void {
    if (this.currentTurnDisclosures.length === 0) return;
    // Markers were already committed once at event time. The ownership
    // boundary closes the current expansion, but retained Thinking controls
    // remain usable. Replaying markers would duplicate/reorder scrollback.
    this.clearCurrentTurnDisclosures();
  }

  private clearCurrentTurnDisclosures(): void {
    this.currentTurnDisclosures = [];
    this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
    const viewer = this.disclosureViewer;
    if (viewer && viewer.state.target) {
      viewer.state = clearDisclosureViewTarget(viewer.state);
      delete viewer.kind;
      delete viewer.registryId;
      this.refreshDisclosureViewer(true);
    }
  }

  private removeRunningProgress(kind: UIProgressItem["kind"]): void {
    const retained = this.progressItems.filter((item) => item.kind !== kind || item.status !== "running");
    if (retained.length !== this.progressItems.length) {
      this.progressItems = retained;
      this.uiState = applyEvent(this.uiState, {
        type: "progress.set",
        progress: this.progressItems,
      });
    }
  }

  private writeStableStatus(text: string, kind: StableStatusKind): void {
    const rendered =
      kind === "error"
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

  private syncTerminalCursorVisibility(): void {
    if (!this.inlineShellActive) return;
    // readline owns a real edit caret. Busy/model state and modal overlays do
    // not: their cursor is only ScreenWriter's redraw anchor and must stay
    // hidden. Once an idle composer is about to open, make the caret visible
    // again without repainting or changing stdin ownership.
    const visible =
      this.promptActive || (!this.uiState.overlay && !this.uiState.composer.busy && !this.currentRequestOptions);
    this.setTerminalCursorVisible(visible);
  }

  private setTerminalCursorVisible(visible: boolean): void {
    if (!this.inlineShellActive || this.terminalCursorVisible === visible) return;
    try {
      this.output.write(visible ? "\u001B[?25h" : "\u001B[?25l");
      this.terminalCursorVisible = visible;
    } catch (error) {
      this.failTerminalUi("cursor renderer", error);
    }
  }

  private composerPromptPrefix(): string {
    const columns = Math.max(12, this.screen?.columns ?? 80);
    const label = this.uiState.composer.busy ? " Adjust current task " : " Request ";
    const title = truncateToWidth(label, Math.max(1, columns - 3), {
      preserveAnsi: false,
    });
    const fill = "─".repeat(Math.max(0, columns - 3 - displayWidth(title)));
    const top = chalk.cyan(`╭─${title}${fill}╮`);
    return `${top}\n${chalk.cyan("│")} > `;
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
    return safe.length <= maximum ? safe : `${safe.slice(0, Math.max(0, maximum - 1))}…`;
  }

  private safeStreamText(value: string): string {
    return redactImageDataUrls(redactSensitiveInformation(sanitizeCommandOutput(value)));
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
      this.streams.refreshLiveReasoningProgress();
      this.activityVisible = true;
      this.refresh();
      return;
    }
    const frame = Terminal.ACTIVITY_FRAMES[this.activityFrameIndex] ?? "•";
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.activityStartedAt) / 1_000));
    const elapsed =
      elapsedSeconds < 60
        ? `${elapsedSeconds}s`
        : `${Math.floor(elapsedSeconds / 60)}m ${String(elapsedSeconds % 60).padStart(2, "0")}s`;
    const prefix = `${frame} `;
    const suffix = ` · ${elapsed}`;
    const columns = Number((this.output as NodeJS.WriteStream).columns);
    const maxWidth = Number.isFinite(columns) && columns > 0 ? Math.max(8, Math.floor(columns) - 1) : 120;
    const labelWidth = Math.max(0, maxWidth - prefix.length - suffix.length);
    const label =
      this.activityText.length <= labelWidth
        ? this.activityText
        : labelWidth >= 4
          ? `${this.activityText.slice(0, labelWidth - 3)}...`
          : "";
    const text = label ? `${prefix}${label}${suffix}` : `${frame} ${elapsed}`.slice(0, maxWidth);
    const rendered = this.colorEnabled() ? chalk.gray(text) : text;
    this.output.write(`\r\u001B[2K${rendered}`);
    this.activityVisible = true;
  }

  private resetActivityState(): void {
    if (this.activityTimer && !this.uiState.live.review) {
      clearInterval(this.activityTimer);
      this.activityTimer = undefined;
    }
    this.activityVisible = false;
    this.activityText = "";
    this.activityStartedAt = 0;
    this.activityFrameIndex = 0;
  }

  /**
   * A broken terminal is not a recoverable presentation downgrade: continuing
   * would leave an apparently active task with neither input nor Ctrl+C. Abort
   * the request, restore terminal modes, and let the normal application
   * shutdown persist Runtime/Journal state for a later `/resume`.
   */
  private failTerminalUi(stage: string, value: unknown): void {
    if (this.closed || this.fatalUiFailure) return;
    const cause = value instanceof Error ? value : new Error(String(value));
    const error = new Error(`CLI ${stage} failed: ${cause.message}`);
    this.fatalUiFailure = error;
    process.exitCode = 1;

    if (!this.currentRequestInterruptSignaled) {
      try {
        this.signalCurrentRequestInterrupt();
      } catch {
        // Shutdown must continue even if a request-specific abort hook fails.
      }
    }
    const restoreAlternateScreen = Boolean(this.disclosureViewer?.writer.isActive);
    this.close();

    if (restoreAlternateScreen) {
      try {
        // The writer that reported the failure may have disabled its own
        // output path. Queue one final paired restore directly as a best-effort
        // equivalent of `/exit`.
        this.output.write(FULL_SCREEN_EXIT_SEQUENCE);
      } catch {
        // The stderr diagnostic below is the final available channel.
      }
    }

    const detail = redactSensitiveInformation(sanitizeCommandOutput(error.message))
      .replace(/[\r\n]+/gu, " ")
      .trim();
    try {
      process.stderr.write(
        `\nEASY CODE UI failed and the CLI exited safely. ` +
          `The task state was preserved and can be resumed.\n${detail}\n`,
      );
    } catch {
      // There is no further safe UI channel when stderr is unavailable.
    }
  }

  private disclosureInstance?: TerminalDisclosureViewer;
  private get disclosure(): TerminalDisclosureViewer {
    return (this.disclosureInstance ??= new TerminalDisclosureViewer(this.disclosureContext()));
  }
  private disclosureContext(): TerminalDisclosureViewerContext {
    const host = this;
    return {
      get activePromptController() {
        return host.activePromptController;
      },
      get activePromptSession() {
        return host.activePromptSession;
      },
      set activePromptSession(value) {
        host.activePromptSession = value;
      },
      get adjustments() {
        return host.adjustments;
      },
      get busyInputOwner() {
        return host.busyInputOwner;
      },
      get closed() {
        return host.closed;
      },
      get currentRequestOptions() {
        return host.currentRequestOptions;
      },
      get currentTurnDisclosures() {
        return host.currentTurnDisclosures;
      },
      get disclosureViewer() {
        return host.disclosureViewer;
      },
      set disclosureViewer(value) {
        host.disclosureViewer = value;
      },
      get externalOperationController() {
        return host.externalOperationController;
      },
      failTerminalUi: (...args) => host.failTerminalUi(...args),
      get guardedInputActive() {
        return host.guardedInputActive;
      },
      get inlineShellActive() {
        return host.inlineShellActive;
      },
      get input() {
        return host.input;
      },
      isInteractive: (...args) => host.isInteractive(...args),
      get output() {
        return host.output;
      },
      physicalColumns: (...args) => host.physicalColumns(...args),
      physicalRows: (...args) => host.physicalRows(...args),
      get promptActive() {
        return host.promptActive;
      },
      set promptActive(value) {
        host.promptActive = value;
      },
      get reasoning() {
        return host.reasoning;
      },
      refresh: (...args) => host.refresh(...args),
      get retainedReasoningDisclosures() {
        return host.retainedReasoningDisclosures;
      },
      get screen() {
        return host.screen;
      },
      setTerminalCursorVisible: (...args) => host.setTerminalCursorVisible(...args),
      signalCurrentRequestInterrupt: (...args) => host.signalCurrentRequestInterrupt(...args),
      startBusyInputOwner: (...args) => host.startBusyInputOwner(...args),
      stopBusyInputOwner: (...args) => host.stopBusyInputOwner(...args),
      get streams() {
        return host.streams;
      },
      get terminalCursorVisible() {
        return host.terminalCursorVisible;
      },
      set terminalCursorVisible(value) {
        host.terminalCursorVisible = value;
      },
      get uiState() {
        return host.uiState;
      },
      set uiState(value) {
        host.uiState = value;
      },
      viewOptions: (...args) => host.viewOptions(...args),
      writeStableStatus: (...args) => host.writeStableStatus(...args),
    };
  }

  private inputOwnershipInstance?: TerminalInputOwnership;
  private get inputOwnership(): TerminalInputOwnership {
    return (this.inputOwnershipInstance ??= new TerminalInputOwnership(this.inputOwnershipContext()));
  }
  private inputOwnershipContext(): TerminalInputOwnershipContext {
    const host = this;
    return {
      get activePromptSession() {
        return host.activePromptSession;
      },
      set activePromptSession(value) {
        host.activePromptSession = value;
      },
      get busyInputOwner() {
        return host.busyInputOwner;
      },
      set busyInputOwner(value) {
        host.busyInputOwner = value;
      },
      get busyPromptController() {
        return host.busyPromptController;
      },
      set busyPromptController(value) {
        host.busyPromptController = value;
      },
      get busyPromptGeneration() {
        return host.busyPromptGeneration;
      },
      set busyPromptGeneration(value) {
        host.busyPromptGeneration = value;
      },
      get busyPromptSession() {
        return host.busyPromptSession;
      },
      set busyPromptSession(value) {
        host.busyPromptSession = value;
      },
      get closed() {
        return host.closed;
      },
      composerPromptPrefix: (...args) => host.composerPromptPrefix(...args),
      composerPromptSuffix: (...args) => host.composerPromptSuffix(...args),
      get currentRequestInterruptSignaled() {
        return host.currentRequestInterruptSignaled;
      },
      set currentRequestInterruptSignaled(value) {
        host.currentRequestInterruptSignaled = value;
      },
      get currentRequestOptions() {
        return host.currentRequestOptions;
      },
      get disclosureViewer() {
        return host.disclosureViewer;
      },
      failTerminalUi: (...args) => host.failTerminalUi(...args),
      get guardedInputActive() {
        return host.guardedInputActive;
      },
      set guardedInputActive(value) {
        host.guardedInputActive = value;
      },
      info: (...args) => host.info(...args),
      get inlineShellActive() {
        return host.inlineShellActive;
      },
      get input() {
        return host.input;
      },
      get inputOwnerMissingSince() {
        return host.inputOwnerMissingSince;
      },
      set inputOwnerMissingSince(value) {
        host.inputOwnerMissingSince = value;
      },
      get inputOwnerWatchdog() {
        return host.inputOwnerWatchdog;
      },
      set inputOwnerWatchdog(value) {
        host.inputOwnerWatchdog = value;
      },
      get output() {
        return host.output;
      },
      get promptActive() {
        return host.promptActive;
      },
      set promptActive(value) {
        host.promptActive = value;
      },
      get readlineInputFilter() {
        return host.readlineInputFilter;
      },
      set readlineInputFilter(value) {
        host.readlineInputFilter = value;
      },
      refresh: (...args) => host.refresh(...args),
      releaseDisclosurePromptSession: (...args) => host.releaseDisclosurePromptSession(...args),
      resizeDisclosureViewer: (...args) => host.resizeDisclosureViewer(...args),
      get rl() {
        return host.rl;
      },
      set rl(value) {
        host.rl = value;
      },
      get screen() {
        return host.screen;
      },
      setTerminalCursorVisible: (...args) => host.setTerminalCursorVisible(...args),
      showLatestReasoning: (...args) => host.showLatestReasoning(...args),
      showReasoning: (...args) => host.showReasoning(...args),
      startPersistentViewer: (...args) => host.startPersistentViewer(...args),
      get steeringAdmissionPaused() {
        return host.steeringAdmissionPaused;
      },
      get steeringDeliveryQueue() {
        return host.steeringDeliveryQueue;
      },
      set steeringDeliveryQueue(value) {
        host.steeringDeliveryQueue = value;
      },
      get uiState() {
        return host.uiState;
      },
      set uiState(value) {
        host.uiState = value;
      },
      writeStableStatus: (...args) => host.writeStableStatus(...args),
    };
  }

  private decisionControllerInstance?: TerminalDecisions;
  private get decisionController(): TerminalDecisions {
    return (this.decisionControllerInstance ??= new TerminalDecisions(this.decisionControllerContext()));
  }
  private decisionControllerContext(): TerminalDecisionsContext {
    const host = this;
    return {
      recordAcceptedPlanFeedback: (feedback) => host.recordAcceptedPlanFeedback(feedback),
      get activeApprovalController() {
        return host.activeApprovalController;
      },
      set activeApprovalController(value) {
        host.activeApprovalController = value;
      },
      get activePromptController() {
        return host.activePromptController;
      },
      set activePromptController(value) {
        host.activePromptController = value;
      },
      get activePromptSession() {
        return host.activePromptSession;
      },
      set activePromptSession(value) {
        host.activePromptSession = value;
      },
      get busyPromptSession() {
        return host.busyPromptSession;
      },
      get closed() {
        return host.closed;
      },
      set closed(value) {
        host.closed = value;
      },
      colorEnabled: (...args) => host.colorEnabled(...args),
      composerPromptPrefix: (...args) => host.composerPromptPrefix(...args),
      composerPromptSuffix: (...args) => host.composerPromptSuffix(...args),
      get disclosureViewer() {
        return host.disclosureViewer;
      },
      freezeCurrentTurnDisclosures: (...args) => host.freezeCurrentTurnDisclosures(...args),
      get guardedInputActive() {
        return host.guardedInputActive;
      },
      info: (...args) => host.info(...args),
      get inlineShellActive() {
        return host.inlineShellActive;
      },
      get input() {
        return host.input;
      },
      isInteractive: (...args) => host.isInteractive(...args),
      get lastPlan() {
        return host.lastPlan;
      },
      get output() {
        return host.output;
      },
      get pendingRequestTranscriptStart() {
        return host.pendingRequestTranscriptStart;
      },
      set pendingRequestTranscriptStart(value) {
        host.pendingRequestTranscriptStart = value;
      },
      get promptActive() {
        return host.promptActive;
      },
      set promptActive(value) {
        host.promptActive = value;
      },
      question: (...args) => host.question(...args),
      reclaimPersistentViewerInput: (...args) => host.reclaimPersistentViewerInput(...args),
      refresh: (...args) => host.refresh(...args),
      refreshDisclosureViewer: (...args) => host.refreshDisclosureViewer(...args),
      releaseDisclosurePromptSession: (...args) => host.releaseDisclosurePromptSession(...args),
      get rl() {
        return host.rl;
      },
      get screen() {
        return host.screen;
      },
      get secretInputActive() {
        return host.secretInputActive;
      },
      set secretInputActive(value) {
        host.secretInputActive = value;
      },
      setTerminalCursorVisible: (...args) => host.setTerminalCursorVisible(...args),
      showLatestReasoning: (...args) => host.showLatestReasoning(...args),
      showReasoning: (...args) => host.showReasoning(...args),
      startPersistentViewer: (...args) => host.startPersistentViewer(...args),
      get uiState() {
        return host.uiState;
      },
      set uiState(value) {
        host.uiState = value;
      },
      get vscodeMenuBridge() {
        return host.vscodeMenuBridge;
      },
      withPrivateProtocolFilteredInput: (...args) => host.withPrivateProtocolFilteredInput(...args),
      write: (...args) => host.write(...args),
      warning: (...args) => host.warning(...args),
    };
  }
}

export function printBanner(
  terminal: Pick<AppInteractionPort, "isInlineShell" | "showSessionHeader" | "info" | "write">,
  language: Language = DEFAULT_LANGUAGE,
): void {
  if (terminal.isInlineShell()) {
    terminal.showSessionHeader();
    terminal.info(translate(language, "cli.helpHint"));
    return;
  }
  terminal.write(chalk.bold.cyan("\nEASY CODE") + chalk.gray(` — ${translate(language, "cli.localAgent")}\n`));
  terminal.write(chalk.gray(`${translate(language, "cli.shortHelpHint")}\n\n`));
  terminal.write(
    chalk.gray(
      process.platform === "win32"
        ? `${translate(language, "cli.pasteWindows")}\n\n`
        : process.platform === "darwin"
          ? `${translate(language, "cli.pasteMac")}\n\n`
          : `${translate(language, "cli.pasteLinux")}\n\n`,
    ),
  );
}
