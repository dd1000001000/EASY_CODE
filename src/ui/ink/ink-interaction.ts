import chalk from "chalk";

import { Terminal } from "../../cli/terminal.js";
import { AdjustmentRegistry, renderAdjustmentBody } from "../../cli/adjustment.js";
import { renderFileDiff } from "../../cli/file-diff.js";
import { ModelStreamRenderer, type ModelStreamHost } from "../../cli/model-stream-renderer.js";
import { ReasoningRegistry, renderReasoningBody, renderReasoningMarker } from "../../cli/reasoning.js";
import type { ReasoningBlock } from "../../cli/reasoning.js";
import { classifyStatus } from "../../cli/terminal-status.js";
import { renderSubagents } from "../../cli/subagents.js";
import { renderTaskGraph } from "../../cli/task-graph.js";
import { formatAssistantText, formatToolTranscript, toolTarget } from "../../cli/transcript-format.js";
import {
  formatCommandApprovalPrefix,
  canGrantCommandPrefix,
  commandPrefixApprovalLabel,
} from "../../command/approval.js";
import { sanitizeCommandOutput } from "../../command/output-stream.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  FileDiffPresentation,
  ImageAttachment,
  PlanProposal,
  ProviderStreamEvent,
  ThinkingEffort,
  ToolDisplayDetail,
} from "../../core/types.js";
import { DEFAULT_LANGUAGE, type Language } from "../../i18n/language.js";
import { redactSensitiveInformation } from "../../memory/sensitive.js";
import { formatPlanProposal, sanitizePlanText } from "../../plans/plan.js";
import { redactImageDataUrls } from "../../providers/errors.js";
import type { SubagentView } from "../../subagents/types.js";
import type { TaskGraphView } from "../../tasks/task-graph.js";
import { compactionActivityLabel, compactionLabel, compactionRunning, type CompactionProgress } from "../compaction.js";
import type { UIActivityKind, UIProgressItem, UIReviewPhase, UISessionInfo, UITranscriptEntry } from "../contracts.js";
import { DECISION_TIMEOUT_MS } from "../decision-timeout.js";
import type {
  AppInteractionPort,
  CurrentRequestOptions,
  InteractionChoice,
  ModelSelectorChoice,
  PlanReviewDecision,
  PlanReviewInputOptions,
  ProviderSelectorChoice,
  RequestInputOptions,
  ThinkingEffortSelectorChoice,
  TimedChoiceOptions,
  UserSubmission,
} from "../interaction-port.js";
import { applyEvent, createUIState } from "../store.js";
import type { ComposerDraft } from "./composer.js";
import { EditorHistory } from "./composer-editor.js";
import type { InkActions } from "./ink-actions.js";
import { SESSION_HEADER_ID_PREFIX, mountInkApp, type MountedInkApp } from "./ink-app.js";
import { InputTranslator } from "./input-translator.js";
import { InkStore, type MenuModal } from "./ink-store.js";

const CLEAR_DISPLAY = "\u001B[3J\u001B[2J\u001B[H";
const RESET_TERMINAL = "\u001Bc";
const MAX_PROGRESS_ITEMS = 12;
const INTERRUPT_REPEAT_MS = 1_500;
const MAX_TYPE_AHEAD_CHARS = 4_096;
const THINKING_HINT = "Ctrl+T shows the latest Thinking";
/** Wait for a window drag to settle before reprinting the transcript at the new width. */
const RESIZE_SETTLE_MS = 120;

interface MenuOptions {
  readonly variant: MenuModal["variant"];
  readonly id: string;
  readonly title: string;
  readonly rows: MenuModal["rows"];
  readonly initialIndex: number;
  readonly request?: Readonly<ApprovalRequest>;
  readonly proposal?: Readonly<PlanProposal>;
  readonly idle?: MenuModal["idle"];
  readonly signal?: AbortSignal;
}

/**
 * Ink front end for the shared interaction port. It renders the same UI state
 * and pure formatters as the classic Terminal, but React owns the redraw: finished
 * transcript rows are written once into terminal scrollback (`<Static>`), and a
 * small live region holds streaming output, progress, the composer, and status.
 *
 * Without an interactive TTY every call is delegated to the classic Terminal, so
 * piped and non-interactive runs behave exactly as before.
 */
export class InkInteraction implements AppInteractionPort, InkActions {
  readonly store: InkStore;
  readonly history = new EditorHistory();
  private readonly drafts = new WeakMap<object, ComposerDraft>();
  private typeAhead = "";

  /** Classic Terminal for runs without an interactive TTY; created only when needed. */
  private legacyInstance: Terminal | undefined;
  private streamingLimits: { streamFlushIntervalMs: number; streamPreviewMaxChars: number } | undefined;
  private app: MountedInkApp | undefined;
  private inputProxy: InputTranslator | undefined;
  private resizeTimer: NodeJS.Timeout | undefined;
  private printedColumns = 0;
  private headerSequence = 0;
  /** Input ended (EOF or exit request); output may still be written until close(). */
  private closed = false;
  private disposed = false;
  private language: Language = DEFAULT_LANGUAGE;
  private readonly reasoning = new ReasoningRegistry();
  private readonly adjustments = new AdjustmentRegistry();
  private readonly retainedReasoning = new Map<string, Readonly<ReasoningBlock>>();
  /** Transcript entries a stream may still replace; they stay out of scrollback until settled. */
  private readonly openEntryIds = new Set<string>();
  private readonly streamToolCalls = new Set<string>();
  private readonly streams: ModelStreamRenderer;
  private contextTokensProvider: (() => number) | undefined;
  private contextTimer: NodeJS.Timeout | undefined;
  private progressItems: UIProgressItem[] = [];
  private progressSequence = 0;
  private activitySequence = 0;
  private activeActivityId: string | undefined;
  private compactionActivity: string | undefined;
  private compactionPhase: string | undefined;
  private resumeAfterCompaction: (() => void) | undefined;
  private steeringQueue: Promise<void> = Promise.resolve();
  private interruptSignaledAt = 0;
  private modalChain: Promise<unknown> = Promise.resolve();
  private externalOperation: AbortController | undefined;
  private lastPlan: Readonly<PlanProposal> | undefined;
  private fatalFailure = false;

  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {
    this.store = new InkStore(this.language);
    this.streams = new ModelStreamRenderer(this.streamHost());
  }

  /**
   * The classic Terminal is only reached when Ink cannot own the terminal (pipes,
   * CI, TERM=dumb). Creating it lazily keeps its VS Code bridge and readline state
   * out of interactive sessions.
   */
  private get legacy(): Terminal {
    if (!this.legacyInstance) {
      const terminal = new Terminal(this.input, this.output);
      terminal.setLanguage(this.language);
      if (this.streamingLimits) terminal.configureStreaming(this.streamingLimits);
      terminal.setContextTokensProvider(this.contextTokensProvider);
      this.legacyInstance = terminal;
    }
    return this.legacyInstance;
  }

  // ---------------------------------------------------------------- session

  setLanguage(language: Language): void {
    this.language = language;
    this.legacyInstance?.setLanguage(language);
    this.store.set({ language });
  }

  isInteractive(): boolean {
    return Boolean(this.input.isTTY && this.output.isTTY);
  }

  configureStreaming(limits: { streamFlushIntervalMs: number; streamPreviewMaxChars: number }): void {
    this.streams.configure(limits);
    this.streamingLimits = limits;
    this.legacyInstance?.configureStreaming(limits);
  }

  setContextTokensProvider(provider: (() => number) | undefined): void {
    this.contextTokensProvider = provider;
    this.legacyInstance?.setContextTokensProvider(provider);
    if (this.contextTimer) clearInterval(this.contextTimer);
    this.contextTimer = undefined;
    if (!provider || !this.app) return;
    this.contextTimer = setInterval(() => this.sampleContextTokens(), 1_000);
    this.contextTimer.unref();
  }

  beginShell(session: Readonly<UISessionInfo>): boolean {
    if (this.app) {
      this.setSessionInfo(session);
      return true;
    }
    if (!this.canUseInkShell()) return this.legacy.beginShell(session);
    this.store.dispatch({ type: "session.set", session });
    this.app = this.mount();
    if (this.contextTokensProvider) this.setContextTokensProvider(this.contextTokensProvider);
    return true;
  }

  isInlineShell(): boolean {
    return this.app !== undefined || (this.legacyInstance?.isInlineShell() ?? false);
  }

  setSessionInfo(session: Readonly<UISessionInfo>, announce = false): void {
    if (!this.app) return this.legacy.setSessionInfo(session, announce);
    this.store.dispatch({ type: "session.set", session });
    if (announce) this.showSessionHeader();
  }

  showSessionHeader(): void {
    if (!this.app) return this.legacy.showSessionHeader();
    this.headerSequence += 1;
    this.commit({
      kind: "raw",
      id: `${SESSION_HEADER_ID_PREFIX}${this.headerSequence}`,
      text: `\n${this.app.renderHeader(this.store.ui)}\n\n`,
    });
  }

  resetForNewThread(session: Readonly<UISessionInfo>): void {
    if (!this.app) return this.legacy.resetForNewThread(session);
    this.store.set({ prompt: null, busy: null, modal: null });
    this.progressItems = [];
    this.progressSequence = 0;
    this.activeActivityId = undefined;
    this.openEntryIds.clear();
    this.retainedReasoning.clear();
    this.streams.forget();
    this.reasoning.clear();
    this.adjustments.clear();
    this.lastPlan = undefined;
    this.store.replaceUi(createUIState({ header: { title: this.store.ui.header.title, session } }));
    this.remount(RESET_TERMINAL);
    this.showSessionHeader();
  }

  clearScreen(): void {
    if (!this.app) return this.legacy.clearScreen();
    const ui = this.store.ui;
    this.openEntryIds.clear();
    this.retainedReasoning.clear();
    this.streams.forget();
    this.store.replaceUi({ ...ui, transcript: [], live: { ...ui.live, thinking: null } });
    this.remount(CLEAR_DISPLAY);
    this.showSessionHeader();
  }

  emergencyRestore(): void {
    this.legacyInstance?.emergencyRestore();
    this.teardownApp();
  }

  close(): void {
    this.streams.reset();
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    this.cancelPending();
    this.externalOperation?.abort();
    this.externalOperation = undefined;
    this.teardownApp();
    this.legacyInstance?.close();
  }

  // ------------------------------------------------------------ presentation

  write(text: string): void {
    if (!this.app) return this.legacy.write(text);
    if (this.closed) return;
    this.commit({ kind: "raw", text });
  }

  info(text: string): void {
    this.write(`${chalk.cyan(text)}\n`);
  }

  success(text: string): void {
    this.write(`${chalk.green(text)}\n`);
  }

  warning(text: string): void {
    this.write(`${chalk.yellow(text)}\n`);
  }

  error(text: string): void {
    this.write(`${chalk.red(text)}\n`);
  }

  status(text: string): void {
    if (!this.app) return this.legacy.status(text);
    const complete = redactSensitiveInformation(sanitizeCommandOutput(text)).trim();
    if (!complete) return;
    const presentation = classifyStatus(complete);
    if (presentation.destination === "stable") {
      this.removeRunningProgress("status");
      this.commitStable(complete, presentation.kind);
      return;
    }
    this.removeRunningProgress(presentation.kind);
    this.progressSequence += 1;
    this.progressItems.push({
      id: `progress_${this.progressSequence}`,
      kind: presentation.kind,
      label: this.safeInline(complete, 240),
      status: "running",
      startedAt: Date.now(),
    });
    this.progressItems = this.progressItems.slice(-MAX_PROGRESS_ITEMS);
    this.store.dispatch({ type: "progress.set", progress: this.progressItems });
  }

  toolCompleted(
    toolName: string,
    ok: boolean,
    summary?: string,
    error?: string,
    details?: readonly ToolDisplayDetail[],
  ): void {
    if (!this.app) return this.legacy.toolCompleted(toolName, ok, summary, error, details);
    this.removeRunningProgress("tool");
    const multiline = (value: string | undefined): string =>
      value ? redactSensitiveInformation(sanitizeCommandOutput(value)).trim().replace(/\r\n?/gu, "\n") : "";
    const target = toolTarget(details);
    this.commit({
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
  }

  fileDiff(presentation: FileDiffPresentation): void {
    this.write(renderFileDiff(presentation, { color: this.colorEnabled() }));
  }

  taskGraph(graph: Readonly<TaskGraphView>): void {
    if (!this.app) return this.legacy.taskGraph(graph);
    this.store.dispatch({ type: "tasks.set", tasks: graph });
  }

  showTaskGraphSnapshot(graph: Readonly<TaskGraphView>): void {
    if (!this.app) return this.legacy.showTaskGraphSnapshot(graph);
    this.store.dispatch({ type: "tasks.set", tasks: graph });
    this.commit({ kind: "raw", text: renderTaskGraph(graph, { color: this.colorEnabled() }) });
  }

  clearTaskGraph(): void {
    if (!this.app) return this.legacy.clearTaskGraph();
    this.store.dispatch({ type: "tasks.clear" });
  }

  subagents(
    agents: readonly Readonly<SubagentView>[],
    taskGraph?: Readonly<TaskGraphView>,
    concurrencyLimit?: number,
  ): void {
    if (!this.app) return this.legacy.subagents(agents, taskGraph, concurrencyLimit);
    this.store.set({ agentConcurrencyLimit: concurrencyLimit });
    this.store.dispatch({ type: "subagents.set", subagents: agents });
    if (taskGraph) this.store.dispatch({ type: "tasks.set", tasks: taskGraph });
  }

  showSubagentsSnapshot(
    agents: readonly Readonly<SubagentView>[],
    taskGraph?: Readonly<TaskGraphView>,
    concurrencyLimit?: number,
  ): void {
    if (!this.app) return this.legacy.showSubagentsSnapshot(agents, taskGraph, concurrencyLimit);
    this.subagents(agents, taskGraph, concurrencyLimit);
    this.commit({
      kind: "raw",
      text: renderSubagents(agents, {
        color: this.colorEnabled(),
        ...(taskGraph ? { taskGraph } : {}),
        ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
      }),
    });
  }

  compactionProgress(progress: CompactionProgress): void {
    if (!this.app) return this.legacy.compactionProgress(progress);
    const chinese = this.language === "zh_cn";
    if (compactionRunning(progress)) {
      if (!this.compactionPhase) {
        if (progress.mode === "automatic") this.resumeAfterCompaction = this.pauseSteering();
        this.compactionActivity = this.startActivity(
          compactionActivityLabel(progress, chinese),
          "model",
          undefined,
          progress.startedAt,
        );
        this.compactionPhase = progress.phase;
      }
      return;
    }
    this.stopActivity(this.compactionActivity);
    this.compactionActivity = undefined;
    this.compactionPhase = undefined;
    const resume = this.resumeAfterCompaction;
    this.resumeAfterCompaction = undefined;
    resume?.();
    this.write(`${compactionLabel(progress, chinese)}\n`);
  }

  startActivity(
    text: string,
    kind: UIActivityKind = "model",
    _toolName?: string,
    startedAt = Date.now(),
  ): string | undefined {
    if (!this.app) return this.legacy.startActivity(text, kind, _toolName, startedAt);
    this.stopActivity();
    this.activitySequence += 1;
    const id = `activity_${startedAt}_${this.activitySequence}`;
    this.activeActivityId = id;
    this.store.dispatch({
      type: "activity.start",
      activity: { id, kind, label: this.safeInline(text, 160) || "Waiting for the model response", startedAt },
    });
    return id;
  }

  stopActivity(activityId?: string): void {
    if (!this.app) return this.legacy.stopActivity(activityId);
    if (activityId !== undefined && activityId !== this.activeActivityId) return;
    const kind = this.store.ui.live.activity?.kind;
    const id = this.activeActivityId;
    this.activeActivityId = undefined;
    this.store.dispatch({ type: "activity.stop", ...(id ? { id } : {}) });
    if (kind === "model") this.removeRunningProgress("step");
  }

  startReview(): string {
    if (!this.app) return this.legacy.startReview();
    const id = `review_ui_${Date.now()}_${++this.activitySequence}`;
    this.store.dispatch({ type: "review.set", review: { id, startedAt: Date.now(), phase: "main_brief" } });
    return id;
  }

  updateReview(id: string, phase: UIReviewPhase): void {
    if (!this.app) return this.legacy.updateReview(id, phase);
    const prior = this.store.ui.live.review;
    if (prior?.id === id) this.store.dispatch({ type: "review.set", review: { ...prior, phase } });
  }

  stopReview(id?: string): void {
    if (!this.app) return this.legacy.stopReview(id);
    const review = this.store.ui.live.review;
    if (!review || (id && review.id !== id)) return;
    this.store.dispatch({ type: "review.clear", ...(id ? { id } : {}) });
  }

  peerMessage(senderThreadId: string, text: string, outgoing = false): void {
    if (!this.app) return this.legacy.peerMessage(senderThreadId, text, outgoing);
    const body = redactSensitiveInformation(
      sanitizeCommandOutput(
        `${outgoing ? "To" : "From"} Thread ${senderThreadId} · ${outgoing ? "queued" : "Agent"}\n${text}`,
      ),
    );
    this.commit({ kind: "assistant", id: `peer_${Date.now()}_${Math.random()}`, text: body });
  }

  // ---------------------------------------------------------------- thinking

  addReasoning(text: string): number {
    if (!this.app) return this.legacy.addReasoning(text);
    const streamedId = this.streams.consumeStreamedReasoning(text);
    if (streamedId !== undefined) return streamedId;
    const block = this.reasoning.add(text);
    const id = `thinking_${block.id}`;
    this.retainedReasoning.set(id, block);
    this.commit({
      kind: "raw",
      id,
      text: renderReasoningMarker(block, { color: this.colorEnabled(), toggleHint: THINKING_HINT }),
      reasoning: block.text,
    });
    return block.id;
  }

  restoreReasoning(texts: readonly string[]): number {
    if (!this.app) return this.legacy.restoreReasoning(texts);
    this.retainedReasoning.clear();
    return this.reasoning.rebuild(texts);
  }

  showReasoning(id: number | "last"): boolean {
    if (!this.app) return this.legacy.showReasoning(id);
    const block = this.reasoning.get(id);
    if (!block) return false;
    this.write(renderReasoningBody(block, { color: this.colorEnabled() }));
    return true;
  }

  showAdjustment(id: number | "last"): boolean {
    if (!this.app) return this.legacy.showAdjustment(id);
    const block = this.adjustments.get(id);
    if (!block) return false;
    this.write(renderAdjustmentBody(block, { color: this.colorEnabled() }));
    return true;
  }

  addQueuedAdjustment(id: number, text: string, images: readonly Readonly<ImageAttachment>[] = []): number {
    if (!this.app) return this.legacy.addQueuedAdjustment(id, text, images);
    const block = this.adjustments.add(id, text, images);
    this.commit({
      kind: "user",
      id: `adjustment_message_${block.id}`,
      text: block.text,
      images: images.map((image) => ({ ...image })),
    });
    return block.id;
  }

  modelStream(event: Readonly<ProviderStreamEvent>): void {
    if (!this.app) return this.legacy.modelStream(event);
    if (event.kind === "tool_call_delta") this.streamToolCalls.add(event.streamId);
    this.streams.onEvent(event);
    if (event.kind === "completed" || event.kind === "interrupted") this.settleStream(event.streamId, event.kind);
  }

  finalizeStreamedAnswer(text: string): boolean {
    if (!this.app) return this.legacy.finalizeStreamedAnswer(text);
    const replaced = this.streams.finalizeAnswer(text);
    this.settleAllEntries();
    if (replaced) return true;
    // Nothing was streamed (or it cannot be reconciled): show the answer here so it
    // gets the same assistant formatting as a streamed one.
    const complete = this.safeStreamText(text).trim();
    if (!complete) return false;
    this.commit({ kind: "assistant", text: formatAssistantText(complete, this.colorEnabled()) });
    return true;
  }

  // --------------------------------------------------------------- requests

  async readPrompt(prompt: string, options: RequestInputOptions): Promise<UserSubmission | null> {
    if (!this.app) return this.legacy.readPrompt(prompt, options);
    if (this.closed) return null;
    if (this.store.getSnapshot().prompt || this.store.getSnapshot().busy) {
      throw new Error("A terminal prompt is already active.");
    }
    this.settleAllEntries();
    this.store.dispatch({
      type: "composer.patch",
      patch: { busy: false, text: "", cursor: 0, placeholder: "Type your request…", images: [], pendingSubmissions: 0 },
    });
    const submission = await new Promise<UserSubmission | null>((resolve) => {
      this.store.set({
        prompt: {
          initialImageCount: options.initialImageCount ?? 0,
          captureImage: options.captureImage,
          ...(options.captureText ? { captureText: options.captureText } : {}),
          resolve,
        },
      });
    });
    this.store.set({ prompt: null });
    if (submission === null) {
      this.closed = true;
    } else {
      this.commit({ kind: "user", text: submission.text, images: submission.images });
    }
    return submission;
  }

  setCurrentRequest(
    text: string,
    images: readonly Readonly<ImageAttachment>[] = [],
    options: Readonly<CurrentRequestOptions> = {},
  ): void {
    if (!this.app) return this.legacy.setCurrentRequest(text, images, options);
    this.stopReview();
    this.settleAllEntries();
    this.streams.forget();
    this.streamToolCalls.clear();
    this.interruptSignaledAt = 0;
    this.progressItems = [];
    this.progressSequence = 0;
    this.store.dispatch({ type: "progress.clear" });
    const summary = this.safeInline(text, 120);
    this.store.dispatch({
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
    this.store.set({ busy: { options, paused: false } });
  }

  clearCurrentRequest(): void {
    if (!this.app) return this.legacy.clearCurrentRequest();
    this.stopReview();
    this.resumeAfterCompaction = undefined;
    this.progressItems = [];
    this.progressSequence = 0;
    this.settleAllEntries();
    this.store.dispatch({ type: "progress.clear" });
    this.store.dispatch({ type: "composer.reset" });
    this.store.set({ busy: null });
  }

  async sealCurrentRequestSteering<T>(seal: () => T | undefined | Promise<T | undefined>): Promise<T | undefined> {
    if (!this.app) return this.legacy.sealCurrentRequestSteering(seal);
    const resume = this.pauseSteering();
    if (!resume) return seal();
    try {
      await this.steeringQueue.catch(() => undefined);
      const result = await seal();
      if (result !== undefined) resume();
      return result;
    } catch (error) {
      resume();
      throw error;
    }
  }

  async withCancellableExternalOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.app) return this.legacy.withCancellableExternalOperation(operation);
    if (this.closed || this.externalOperation) throw new Error("A terminal operation is already active.");
    const controller = new AbortController();
    this.externalOperation = controller;
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
      if (this.externalOperation === controller) this.externalOperation = undefined;
    }
  }

  // --------------------------------------------------------------- decisions

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!this.app) return this.legacy.approve(request);
    if (this.closed || request.signal?.aborted) return "reject";
    const title = redactSensitiveInformation(sanitizeCommandOutput(request.title)).replace(/\s+/gu, " ").trim();
    const description = redactSensitiveInformation(sanitizeCommandOutput(request.description));
    const preview = request.commandPreview
      ? redactSensitiveInformation(sanitizeCommandOutput(request.commandPreview)).replace(/[\r\n]+/gu, " ")
      : undefined;
    // The bounded selector card is only a navigation aid; the complete request
    // is durable scrollback so a security decision never rests on a clipped copy.
    this.write(
      chalk.yellow(`\nApproval required: ${title}\n`) +
        `${description}\n` +
        (request.network
          ? `Network effect: ${request.network.effect}; destination: ${sanitizeCommandOutput(request.network.destination ?? "resolved when the command connects")}\n` +
            `Optional saved grant scope: ${sanitizeCommandOutput(formatCommandApprovalPrefix(request.commandPrefix))}\n`
          : "") +
        (preview ? chalk.gray(`Command: ${preview}\n`) : ""),
    );
    const grantable = canGrantCommandPrefix(request.commandPrefix);
    const decisions: readonly ApprovalDecision[] = grantable
      ? ["allow_once", "allow_prefix", "reject"]
      : ["allow_once", "reject"];
    const labels: Record<ApprovalDecision, string> = {
      allow_once: "Yes, allow execute one time",
      allow_prefix: grantable ? commandPrefixApprovalLabel(request.commandPrefix) : "",
      reject: "Reject",
    };
    try {
      const index = await this.menu({
        variant: "approval",
        id: request.id,
        title: "Approve command execution",
        rows: decisions.map((decision) => ({ label: labels[decision] })),
        initialIndex: 0,
        request,
        idle: { timeoutMs: DECISION_TIMEOUT_MS, index: 0 },
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return index === undefined ? "reject" : (decisions[index] ?? "reject");
    } catch {
      return "reject";
    }
  }

  async selectChoice(
    title: string,
    choices: readonly InteractionChoice[],
    initialId?: string,
    timed?: Readonly<TimedChoiceOptions>,
  ): Promise<string | undefined> {
    if (!this.app) return this.legacy.selectChoice(title, choices, initialId, timed);
    if (this.closed || choices.length === 0) return undefined;
    const idleIndex = timed ? choices.findIndex((choice) => choice.id === timed.idleChoiceId && !choice.disabled) : -1;
    const index = await this.menu({
      variant: "picker",
      id: `choice-${Date.now()}`,
      title,
      rows: choices.map((choice) => ({
        label: choice.label,
        ...(choice.detail ? { detail: choice.detail } : {}),
        ...(choice.disabled ? { disabled: true } : {}),
      })),
      initialIndex: Math.max(
        0,
        choices.findIndex((choice) => choice.id === initialId),
      ),
      ...(timed && idleIndex >= 0 ? { idle: { timeoutMs: timed.idleTimeoutMs, index: idleIndex } } : {}),
      ...(timed?.signal ? { signal: timed.signal } : {}),
    });
    const choice = index === undefined ? undefined : choices[index];
    return choice?.disabled ? undefined : choice?.id;
  }

  async selectProvider(
    choices: readonly ProviderSelectorChoice[],
    initialProvider: ProviderSelectorChoice["provider"],
  ): Promise<ProviderSelectorChoice["provider"] | undefined> {
    if (!this.app) return this.legacy.selectProvider(choices, initialProvider);
    const index = await this.menu({
      variant: "picker",
      id: "provider-picker",
      title: "Select a provider for EASY CODE",
      rows: choices.map((choice) => ({
        label: `${choice.label}  [${choice.apiKeyConfigured ? "API key configured" : "API key required"}]`,
      })),
      initialIndex: Math.max(
        0,
        choices.findIndex((choice) => choice.provider === initialProvider),
      ),
    });
    return index === undefined ? undefined : choices[index]?.provider;
  }

  async selectModel(
    providerName: string,
    choices: readonly ModelSelectorChoice[],
    initialModel?: string,
  ): Promise<string | undefined> {
    if (!this.app) return this.legacy.selectModel(providerName, choices, initialModel);
    const initial = initialModel?.toLowerCase();
    const index = await this.menu({
      variant: "picker",
      id: "model-picker",
      title: `Select a model from ${providerName}`,
      rows: choices.map((choice) => {
        const name = choice.label === choice.id ? choice.label : `${choice.label}  [${choice.id}]`;
        return {
          label:
            choice.vision === "supported"
              ? `${name}  [vision]`
              : choice.vision === "unknown"
                ? `${name}  [vision unverified]`
                : name,
        };
      }),
      initialIndex: Math.max(
        0,
        choices.findIndex((choice) => choice.id.toLowerCase() === initial),
      ),
    });
    return index === undefined ? undefined : choices[index]?.id;
  }

  async selectThinkingEffort(
    providerName: string,
    model: string,
    choices: readonly ThinkingEffortSelectorChoice[],
    initialEffort: ThinkingEffort,
  ): Promise<ThinkingEffort | undefined> {
    if (!this.app) return this.legacy.selectThinkingEffort(providerName, model, choices, initialEffort);
    const index = await this.menu({
      variant: "picker",
      id: "thinking-picker",
      title: `Select thinking effort for ${providerName} / ${model}`,
      rows: choices.map((choice) => ({
        label: choice.applied ? choice.label : `${choice.label}  [saved but not applied]`,
      })),
      initialIndex: Math.max(
        0,
        choices.findIndex((choice) => choice.id === initialEffort),
      ),
    });
    return index === undefined ? undefined : choices[index]?.id;
  }

  async readSecret(prompt: string): Promise<string> {
    if (!this.app) return this.legacy.readSecret(prompt);
    if (this.closed) throw new Error("Terminal input is closed.");
    const value = await this.enqueueModal<string>((resolve) => ({ kind: "secret", prompt, resolve }) as const);
    if (value === undefined) throw new Error("Secret input was canceled.");
    return value;
  }

  showPlan(plan: Readonly<PlanProposal>): void {
    this.lastPlan = plan;
    this.write(`\n${formatPlanProposal(plan)}\n`);
  }

  async reviewPlan(options: Readonly<PlanReviewInputOptions> = {}): Promise<PlanReviewDecision> {
    if (!this.app) return this.legacy.reviewPlan(options);
    const plan = options.plan ?? this.lastPlan;
    if (!plan || this.closed) return { action: "defer" };
    const index = await this.menu({
      variant: "plan-review",
      id: plan.id,
      title: "Review proposed plan",
      rows: [{ label: "Yes, use Auto mode" }, { label: "No, reject plan" }, { label: "Adjust plan with feedback" }],
      initialIndex: 0,
      proposal: plan,
      idle: { timeoutMs: options.idleTimeoutMs ?? DECISION_TIMEOUT_MS, index: 0 },
    });
    if (index === undefined) return { action: "defer" };
    if (index === 0) return { action: "approve" };
    if (index === 1) return { action: "reject" };
    const feedback = await this.enqueueModal<string>(
      (resolve) => ({ kind: "text", prompt: "Plan feedback", resolve }) as const,
    );
    const sanitized = feedback === undefined ? "" : sanitizePlanText(feedback);
    if (!sanitized) return { action: "defer" };
    this.commit({ kind: "user", text: sanitized, images: [] });
    return { action: "adjust", feedback: sanitized };
  }

  // ------------------------------------------------------------- InkActions

  colorEnabled(): boolean {
    const forceColor = process.env.FORCE_COLOR;
    return (
      !Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR") &&
      forceColor !== "0" &&
      (Boolean(this.output.isTTY) || Boolean(forceColor))
    );
  }

  draftFor(owner: object): ComposerDraft {
    let draft = this.drafts.get(owner);
    if (!draft) {
      draft = {};
      this.drafts.set(owner, draft);
    }
    return draft;
  }

  bufferTypeAhead(text: string): void {
    this.typeAhead = text === "\b" ? Array.from(this.typeAhead).slice(0, -1).join("") : `${this.typeAhead}${text}`;
    this.typeAhead = this.typeAhead.slice(-MAX_TYPE_AHEAD_CHARS);
  }

  takeTypeAhead(): string {
    const text = this.typeAhead;
    this.typeAhead = "";
    return text;
  }

  showLatestThinking(): void {
    if (!this.showReasoning("last")) this.info("No Thinking content is available in this thread.");
  }

  submitPrompt(submission: UserSubmission): void {
    this.store.getSnapshot().prompt?.resolve(submission);
  }

  closePrompt(): void {
    this.store.getSnapshot().prompt?.resolve(null);
  }

  steer(submission: UserSubmission): boolean {
    const busy = this.store.getSnapshot().busy;
    const onSteer = busy?.options.onSteer;
    if (!busy || busy.paused || !onSteer) return false;
    const pending = (): number => this.store.ui.composer.pendingSubmissions;
    this.store.dispatch({ type: "composer.patch", patch: { pendingSubmissions: pending() + 1 } });
    this.steeringQueue = this.steeringQueue
      .then(() => onSteer(submission))
      .catch((error: unknown) => {
        this.warning(`Adjustment was not delivered: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.store.dispatch({ type: "composer.patch", patch: { pendingSubmissions: Math.max(0, pending() - 1) } });
      });
    return true;
  }

  interrupt(): void {
    const options = this.store.getSnapshot().busy?.options;
    const now = Date.now();
    if (options?.onInterrupt) {
      // A held key repeats Ctrl+C; one request still sees one interrupt per burst.
      if (this.interruptSignaledAt && now - this.interruptSignaledAt < INTERRUPT_REPEAT_MS) return;
      this.interruptSignaledAt = now;
      options.onInterrupt();
      return;
    }
    // Raw mode swallows the terminal's own SIGINT; forward it to pending operations.
    process.emit("SIGINT");
  }

  cancelModal(): void {
    const modal = this.store.getSnapshot().modal;
    if (!modal) return;
    modal.resolve(undefined);
  }

  // ----------------------------------------------------------------- helpers

  private canUseInkShell(): boolean {
    const ci = process.env.CI?.trim().toLowerCase();
    return Boolean(
      !this.closed &&
      this.input.isTTY &&
      this.output.isTTY &&
      typeof this.input.setRawMode === "function" &&
      !this.output.destroyed &&
      !this.output.writableEnded &&
      process.env.TERM !== "dumb" &&
      ci !== "1" &&
      ci !== "true",
    );
  }

  private safeInline(value: string, maximum: number): string {
    const safe = redactSensitiveInformation(sanitizeCommandOutput(value))
      .replace(/[\r\n\t]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return safe.length <= maximum ? safe : `${safe.slice(0, Math.max(0, maximum - 1))}…`;
  }

  private safeStreamText(value: string): string {
    return redactImageDataUrls(redactSensitiveInformation(sanitizeCommandOutput(value)));
  }

  /** Append one transcript row; it reaches scrollback as soon as nothing before it can still change. */
  private commit(entry: Readonly<UITranscriptEntry>, options: { open?: boolean } = {}): void {
    if (options.open && entry.id) this.openEntryIds.add(entry.id);
    this.applyTranscript({ type: "transcript.append", entry });
  }

  private replaceEntry(id: string, entry: Readonly<UITranscriptEntry>): void {
    if (!this.store.ui.transcript.some((candidate) => candidate.id === id)) return;
    this.applyTranscript({ type: "transcript.replace", id, entry });
  }

  private applyTranscript(event: Parameters<typeof applyEvent>[1]): void {
    const ui = applyEvent(this.store.ui, event);
    this.store.set({ ui, settled: this.settledCount(ui.transcript, this.store.getSnapshot().settled) });
  }

  private settledCount(transcript: readonly Readonly<UITranscriptEntry>[], from: number): number {
    let settled = from;
    while (settled < transcript.length) {
      const id = transcript[settled]?.id;
      if (id && this.openEntryIds.has(id)) break;
      settled += 1;
    }
    return settled;
  }

  private settleAllEntries(): void {
    if (this.openEntryIds.size === 0 && this.store.getSnapshot().settled >= this.store.ui.transcript.length) return;
    this.openEntryIds.clear();
    this.store.set({ settled: this.store.ui.transcript.length });
  }

  /** A finished stream can no longer replace its rows, except an answer still awaiting reconciliation. */
  private settleStream(streamId: string, kind: "completed" | "interrupted"): void {
    const keepAnswer = kind === "completed" && !this.streamToolCalls.has(streamId);
    for (const id of [...this.openEntryIds]) {
      if (id.startsWith("thinking_") || (id.includes(streamId) && !(keepAnswer && id.endsWith("_answer")))) {
        this.openEntryIds.delete(id);
      }
    }
    this.streamToolCalls.delete(streamId);
    this.store.set({ settled: this.settledCount(this.store.ui.transcript, this.store.getSnapshot().settled) });
  }

  private commitStable(text: string, kind: "info" | "success" | "warning" | "error"): void {
    const rendered =
      kind === "error"
        ? chalk.red(text)
        : kind === "warning"
          ? chalk.yellow(text)
          : kind === "success"
            ? chalk.green(text)
            : chalk.cyan(text);
    this.commit({ kind, text: `${rendered}\n` });
  }

  private removeRunningProgress(kind: UIProgressItem["kind"]): void {
    const retained = this.progressItems.filter((item) => item.kind !== kind || item.status !== "running");
    if (retained.length === this.progressItems.length) return;
    this.progressItems = retained;
    this.store.dispatch({ type: "progress.set", progress: retained });
  }

  /** Freeze the steering editor; the returned callback reopens it for the same request. */
  private pauseSteering(): (() => void) | undefined {
    const busy = this.store.getSnapshot().busy;
    if (!busy?.options.onSteer || busy.paused) return undefined;
    this.store.set({ busy: { ...busy, paused: true } });
    return () => {
      const current = this.store.getSnapshot().busy;
      if (current?.options === busy.options) this.store.set({ busy: { ...current, paused: false } });
    };
  }

  private sampleContextTokens(): void {
    const provider = this.contextTokensProvider;
    const session = this.store.ui.header.session;
    if (!provider || !session || this.closed) return;
    try {
      const contextTokens = provider();
      if (!Number.isFinite(contextTokens) || contextTokens < 0 || contextTokens === session.contextTokens) return;
      this.store.dispatch({ type: "session.set", session: { ...session, contextTokens } });
    } catch {
      // Context display is observational and must not interrupt input or the agent.
    }
  }

  /** Serialize modals: background approvals queue behind whichever dialog is open. */
  private enqueueModal<T>(
    build: (resolve: (value: T | undefined) => void) => NonNullable<ReturnType<InkStore["getSnapshot"]>["modal"]>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const run = async (): Promise<T | undefined> => {
      if (this.closed || signal?.aborted) return undefined;
      return new Promise<T | undefined>((resolve) => {
        let settled = false;
        const finish = (value: T | undefined): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          this.store.set({ modal: null });
          resolve(value);
        };
        const onAbort = (): void => finish(undefined);
        signal?.addEventListener("abort", onAbort, { once: true });
        this.store.set({ modal: build(finish as (value: unknown) => void) });
      });
    };
    const result = this.modalChain.then(run, run);
    this.modalChain = result.catch(() => undefined);
    return result;
  }

  private menu(options: MenuOptions): Promise<number | undefined> {
    if (options.rows.length === 0) throw new Error(`No choices are available for ${options.title}.`);
    return this.enqueueModal<number>(
      (resolve) => ({
        kind: "menu",
        id: options.id,
        variant: options.variant,
        title: options.title,
        rows: options.rows,
        initialIndex: options.initialIndex,
        hint: "Use ↑/↓ to move, Enter to confirm, or Esc to cancel",
        ...(options.request ? { request: options.request } : {}),
        ...(options.proposal ? { proposal: options.proposal } : {}),
        ...(options.idle ? { idle: options.idle } : {}),
        resolve,
      }),
      options.signal,
    );
  }

  private cancelPending(): void {
    const { prompt, modal } = this.store.getSnapshot();
    prompt?.resolve(null);
    if (modal) this.cancelModal();
  }

  /** Restart the Ink tree on a freshly cleared terminal (clear, new thread). */
  private remount(sequence: string): void {
    this.store.set({ closing: true });
    this.app?.unmount();
    this.output.write(sequence);
    this.store.set({ epoch: this.store.getSnapshot().epoch + 1, closing: false });
    this.app = this.mount();
  }

  /**
   * A width change makes the terminal reflow everything already printed, which
   * Ink cannot erase precisely. Clear the screen and scrollback once the resize
   * settles and reprint the whole transcript at the new width instead.
   */
  private readonly onResize = (): void => {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      if (!this.app || this.closed || this.output.columns === this.printedColumns) return;
      this.remount(CLEAR_DISPLAY);
    }, RESIZE_SETTLE_MS);
    this.resizeTimer.unref();
  };

  private mount(): MountedInkApp {
    this.inputProxy ??= new InputTranslator(this.input);
    this.printedColumns = this.output.columns;
    this.output.removeListener("resize", this.onResize);
    this.output.on("resize", this.onResize);
    return mountInkApp(this, {
      stdin: this.inputProxy as unknown as NodeJS.ReadStream,
      stdout: this.output,
    });
  }

  private teardownApp(): void {
    if (this.contextTimer) clearInterval(this.contextTimer);
    this.contextTimer = undefined;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
    this.output.removeListener("resize", this.onResize);
    const app = this.app;
    this.app = undefined;
    try {
      this.store.set({ closing: true });
      app?.unmount();
      this.inputProxy?.release();
      this.inputProxy = undefined;
      if (app) this.output.write("\u001B[?25h");
      this.input.setRawMode?.(false);
    } catch {
      // Cleanup is best effort; the terminal may already be gone.
    }
  }

  private failUi(stage: string, value: unknown): void {
    if (this.fatalFailure) return;
    this.fatalFailure = true;
    const message = value instanceof Error ? value.message : String(value);
    try {
      this.interrupt();
    } catch {
      // Shutdown must continue even if a request-specific abort hook fails.
    }
    this.close();
    process.stderr.write(`Terminal UI failed (${stage}): ${message}\n`);
  }

  private streamHost(): ModelStreamHost {
    return {
      reasoning: this.reasoning,
      isClosed: () => this.closed,
      canStreamIntoDocument: () => this.app !== undefined,
      hasDisclosureDocument: () => this.app !== undefined,
      activeActivityId: () => this.activeActivityId,
      showToolArgumentProgress: (text) => {
        const current = this.store.ui.live.activity;
        if (current && current.id === this.activeActivityId) {
          this.store.dispatch({ type: "activity.start", activity: { ...current, label: text } });
        }
      },
      colorEnabled: () => this.colorEnabled(),
      reasoningToggleHint: THINKING_HINT,
      safeInline: (value, maximum) => this.safeInline(value, maximum),
      safeStreamText: (value) => this.safeStreamText(value),
      commitTranscript: (entry) => this.commit(entry, { open: true }),
      replaceTranscriptEntry: (id, entry) => this.replaceEntry(id, entry),
      retainCurrentTurnDisclosure: (entry, block) => {
        if (entry.id) this.retainedReasoning.set(entry.id, block);
        this.commit(entry, { open: true });
      },
      retainReasoningDisclosure: (entryId, block) => {
        this.retainedReasoning.set(entryId, block);
      },
      refreshDisclosureViewer: () => undefined,
      failTerminalUi: (stage, value) => this.failUi(stage, value),
    };
  }
}
