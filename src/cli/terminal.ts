import chalk from "chalk";
import readline from "node:readline";
import { formatCommandApprovalPrefix } from "../command/approval.js";
import { sanitizeCommandOutput } from "../command/output-stream.js";
import { readSecretInput } from "../config/secret-input.js";
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
import { formatPlanProposal, sanitizePlanText } from "../plans/plan.js";
import type { SubagentView } from "../subagents/types.js";
import type { TaskGraphView } from "../tasks/task-graph.js";
import {
  compactionActivityLabel,
  compactionLabel,
  compactionRunning,
  type CompactionProgress,
} from "../ui/compaction.js";
import type { TurnSummary, UIActivityKind, UIReviewPhase, UISessionInfo } from "../ui/contracts.js";
import { DECISION_TIMEOUT_MS } from "../ui/decision-timeout.js";
import { renderTurnSummary } from "../ui/render/turn-summary.js";
import type {
  AppInteractionPort,
  CurrentRequestOptions,
  InteractionChoice,
  PlanReviewDecision,
  PlanReviewInputOptions,
  TimedChoiceOptions,
} from "../ui/interaction-port.js";
import { AdjustmentRegistry, renderAdjustmentBody } from "./adjustment.js";
import { selectApproval } from "./approval-selector.js";
import { renderFileDiff } from "./file-diff.js";
import { renderMenu, selectMenuIndex } from "./menu-selector.js";
import {
  selectModel,
  selectProvider,
  selectThinkingEffort,
  type ModelSelectorChoice,
  type ModelSelectorInput,
  type ModelSelectorOutput,
  type ProviderSelectorChoice,
  type ThinkingEffortSelectorChoice,
} from "./model-selector.js";
import {
  PrivateOscInputFilter,
  readPrompt,
  type PromptInput,
  type PromptInputSession,
  type PromptOutput,
  type PromptSubmission,
} from "./prompt-input.js";
import { ReasoningRegistry, renderReasoningBody, renderReasoningMarker } from "./reasoning.js";
import { completeSlashCommandPrefix } from "./slash-command.js";
import { renderSubagents } from "./subagents.js";
import { renderTaskGraph } from "./task-graph.js";
import { classifyStatus, type StableStatusKind } from "./terminal-status.js";
import { formatUserTranscriptEntry } from "./transcript-format.js";

export type { CurrentRequestOptions, PlanReviewDecision, PlanReviewInputOptions } from "../ui/interaction-port.js";

/**
 * Line-oriented fallback for runs the Ink front end cannot own: pipes, CI,
 * TERM=dumb, `easy-code run`, and prompts shown before the shell starts.
 * Output is appended to the stream; there is no redrawable region. A real TTY
 * still gets a one-line spinner and the raw-mode editor and menus.
 */
export class Terminal implements AppInteractionPort {
  private static readonly ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
  // Human-readable elapsed time does not need an 80 ms repaint cadence.
  private static readonly ACTIVITY_INTERVAL_MS = 160;

  private rl?: readline.Interface;
  private readlineInputFilter?: PrivateOscInputFilter;
  private closed = false;
  private language: Language = DEFAULT_LANGUAGE;
  private promptActive = false;
  private guardedInputActive = false;
  private secretInputActive = false;
  private activePromptController?: AbortController;
  private activePromptSession?: PromptInputSession;
  private activeApprovalController?: AbortController;
  private externalOperationController?: AbortController;
  private currentRequestOptions?: Readonly<CurrentRequestOptions>;
  /** Coalesce repeated interrupts into one cancellation per request. */
  private currentRequestInterruptSignaled = false;
  private readonly reasoning = new ReasoningRegistry();
  private readonly adjustments = new AdjustmentRegistry();
  private lastPlan?: Readonly<PlanProposal>;
  private activityTimer?: NodeJS.Timeout;
  private activityStartedAt = 0;
  private activityFrameIndex = 0;
  private activityText = "";
  private activityVisible = false;
  private activeActivityId?: string;
  private activitySequence = 0;
  private compactionActivity?: string;
  private compactionPhase?: string;
  private fatalUiFailure?: Error;

  constructor(
    private readonly input: PromptInput = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  // ---------------------------------------------------------------- session

  setLanguage(language: Language): void {
    this.language = language;
  }

  isInteractive(): boolean {
    return Boolean(this.input.isTTY && (this.output as NodeJS.WriteStream).isTTY);
  }

  /** Answers are printed once complete, so there is no streaming preview to configure. */
  configureStreaming(_limits: { streamFlushIntervalMs: number; streamPreviewMaxChars: number }): void {}

  /** The context estimate is shown only by the Ink status bar. */
  setContextTokensProvider(_provider: (() => number) | undefined): void {}

  /** The interactive shell belongs to Ink; this fallback never takes over the screen. */
  beginShell(_session: Readonly<UISessionInfo>): boolean {
    return false;
  }

  isInlineShell(): boolean {
    return false;
  }

  setSessionInfo(_session: Readonly<UISessionInfo>, _announce?: boolean): void {}

  showSessionHeader(): void {}

  setCurrentRequest(
    _text: string,
    _images?: readonly Readonly<ImageAttachment>[],
    options: Readonly<CurrentRequestOptions> = {},
  ): void {
    this.stopReview();
    this.activeApprovalController?.abort();
    this.currentRequestOptions = options;
    this.currentRequestInterruptSignaled = false;
  }

  clearCurrentRequest(): void {
    this.stopReview();
    this.activeApprovalController?.abort();
    this.currentRequestOptions = undefined;
    this.currentRequestInterruptSignaled = false;
  }

  /** There is no steering editor here, so nothing can race the seal. */
  async sealCurrentRequestSteering<T>(seal: () => T | undefined | Promise<T | undefined>): Promise<T | undefined> {
    return seal();
  }

  clearScreen(): void {
    if ((this.output as NodeJS.WriteStream).isTTY) this.output.write("\u001B[3J\u001B[2J\u001B[H");
  }

  /** Clear every process-local projection when a new Thread becomes active. */
  resetForNewThread(_session: Readonly<UISessionInfo>): void {
    this.currentRequestOptions = undefined;
    this.resetActivityState();
    this.activeActivityId = undefined;
    this.lastPlan = undefined;
    this.reasoning.clear();
    this.adjustments.clear();
    if ((this.output as NodeJS.WriteStream).isTTY) this.output.write("\u001Bc");
  }

  emergencyRestore(): void {
    this.currentRequestOptions = undefined;
    try {
      this.output.write("\u001B[?25h");
      this.input.setRawMode?.(false);
    } catch {
      // Emergency cleanup must never mask the original interrupt.
    }
  }

  close(): void {
    this.activeApprovalController?.abort();
    if (this.closed) return;
    this.closed = true;
    this.currentRequestOptions = undefined;
    this.stopActivity();
    this.activePromptController?.abort();
    this.activePromptController = undefined;
    this.externalOperationController?.abort();
    this.externalOperationController = undefined;
    const rl = this.rl;
    rl?.close();
    if (rl) this.releaseReadlineInput(rl);
  }

  // ----------------------------------------------------------------- output

  write(text: string): void {
    if (this.closed) return;
    this.stopActivity();
    this.output.write(text);
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

  /** Durable notices are printed; in-flight progress is reduced to an info line. */
  status(text: string): void {
    const complete = redactSensitiveInformation(sanitizeCommandOutput(text)).trim();
    if (!complete) return;
    const presentation = classifyStatus(complete);
    if (presentation.destination === "stable") this.writeStableStatus(complete, presentation.kind);
    else this.writeStableStatus(this.safeInline(complete, 240), "info");
  }

  /** Tool results already reach the transcript through the Runtime's own output. */
  toolCompleted(
    _toolName: string,
    _ok: boolean,
    _summary?: string,
    _error?: string,
    _details?: readonly ToolDisplayDetail[],
  ): void {}

  fileDiff(presentation: FileDiffPresentation): void {
    this.write(renderFileDiff(presentation, { color: this.colorEnabled() }));
  }

  taskGraph(graph: Readonly<TaskGraphView>): void {
    this.write(renderTaskGraph(graph, { color: this.colorEnabled() }));
  }

  showTaskGraphSnapshot(graph: Readonly<TaskGraphView>): void {
    this.taskGraph(graph);
  }

  clearTaskGraph(): void {}

  subagents(
    agents: readonly Readonly<SubagentView>[],
    taskGraph?: Readonly<TaskGraphView>,
    concurrencyLimit?: number,
  ): void {
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
    this.subagents(agents, taskGraph, concurrencyLimit);
  }

  compactionProgress(progress: CompactionProgress): void {
    const zh = this.language === "zh_cn";
    if (compactionRunning(progress)) {
      if (!this.compactionPhase) {
        this.compactionActivity = this.startActivity(
          compactionActivityLabel(progress, zh),
          "model",
          undefined,
          progress.startedAt,
        );
        this.compactionPhase = progress.phase;
        if (!this.isInteractive()) this.info(compactionLabel(progress, zh));
      }
      return;
    }
    this.stopActivity(this.compactionActivity);
    this.compactionActivity = undefined;
    this.compactionPhase = undefined;
    this.write(`${compactionLabel(progress, zh)}\n`);
  }

  peerMessage(senderThreadId: string, text: string, outgoing = false): void {
    const body = redactSensitiveInformation(
      sanitizeCommandOutput(
        `${outgoing ? "To" : "From"} Thread ${senderThreadId} · ${outgoing ? "queued" : "Agent"}\n${text}`,
      ),
    );
    this.write(`${body}\n\n`);
  }

  /** One plain line after each request; line mode has no hyperlinks. */
  turnCompleted(summary: Readonly<TurnSummary>): void {
    const columns = Number((this.output as NodeJS.WriteStream).columns) || 120;
    this.write(
      `${renderTurnSummary(summary, { language: this.language, color: this.colorEnabled(), columns, links: false })}\n`,
    );
  }

  showPlan(plan: Readonly<PlanProposal>): void {
    this.lastPlan = plan;
    this.write(`\n${formatPlanProposal(plan)}\n`);
  }

  // ------------------------------------------------------- streamed answers

  /** Provider deltas are not previewed; the Runtime prints the assembled answer. */
  modelStream(_event: Readonly<ProviderStreamEvent>): void {}

  finalizeStreamedAnswer(_text: string): boolean {
    return false;
  }

  /** Store provider thinking and print only its collapsed marker. */
  addReasoning(text: string): number {
    const block = this.reasoning.add(text);
    if (this.isInteractive()) this.write(renderReasoningMarker(block, { color: this.colorEnabled() }));
    return block.id;
  }

  restoreReasoning(texts: readonly string[]): number {
    return this.reasoning.rebuild(texts);
  }

  /** Append one complete sanitized Thinking block. Missing IDs are silent. */
  showReasoning(id: number | "last"): boolean {
    if (!this.isInteractive()) return false;
    const block = this.reasoning.get(id);
    if (!block) return false;
    this.write(renderReasoningBody(block, { color: this.colorEnabled() }));
    return true;
  }

  /** Retain one durable user adjustment and present it as ordinary user input. */
  addQueuedAdjustment(id: number, text: string, images: readonly Readonly<ImageAttachment>[] = []): number {
    const block = this.adjustments.add(id, text, images);
    if (this.isInteractive()) {
      this.write(
        `${formatUserTranscriptEntry({ text: block.text, images: images.map((image) => ({ ...image })) })}\n\n`,
      );
    }
    return block.id;
  }

  showAdjustment(id: number | "last"): boolean {
    if (!this.isInteractive()) return false;
    const block = this.adjustments.get(id);
    if (!block) return false;
    this.write(renderAdjustmentBody(block, { color: this.colorEnabled() }));
    return true;
  }

  // --------------------------------------------------------------- activity

  /** Reviews have no line-mode presentation; the id only pairs update/stop calls. */
  startReview(): string {
    return `review_ui_${Date.now()}_${++this.activitySequence}`;
  }

  updateReview(_id: string, _phase: UIReviewPhase): void {}

  stopReview(_id?: string): void {}

  startActivity(
    text: string,
    _kind: UIActivityKind = "model",
    _toolName?: string,
    startedAt = Date.now(),
  ): string | undefined {
    this.stopActivity();
    if (!this.canAnimateActivity()) return undefined;
    this.activityText = this.safeInline(text, 160) || "Waiting for the model response";
    this.activityStartedAt = startedAt;
    this.activityFrameIndex = 0;
    this.activitySequence += 1;
    this.activeActivityId = `activity_${this.activityStartedAt}_${this.activitySequence}`;
    try {
      this.renderActivity();
    } catch (error) {
      this.resetActivityState();
      this.activeActivityId = undefined;
      this.failTerminalUi("activity renderer", error);
      return undefined;
    }
    this.activityTimer = setInterval(() => {
      try {
        if (!this.canAnimateActivity()) {
          this.stopActivity();
          return;
        }
        this.activityFrameIndex = (this.activityFrameIndex + 1) % Terminal.ACTIVITY_FRAMES.length;
        this.renderActivity();
      } catch (error) {
        this.failTerminalUi("activity renderer", error);
      }
    }, Terminal.ACTIVITY_INTERVAL_MS);
    this.activityTimer.unref();
    return this.activeActivityId;
  }

  /** Clear the transient spinner without adding a blank line. */
  stopActivity(activityId?: string): void {
    if (activityId !== undefined && activityId !== this.activeActivityId) return;
    const wasVisible = this.activityVisible;
    this.resetActivityState();
    this.activeActivityId = undefined;
    if (wasVisible) this.output.write("\r\u001B[2K");
  }

  // -------------------------------------------------------------- decisions

  async readPrompt(
    prompt: string,
    options: {
      initialImageCount?: number;
      captureImage: (index: number, signal?: AbortSignal) => Promise<ImageAttachment>;
      captureText?: (signal?: AbortSignal) => Promise<string | undefined>;
    },
  ): Promise<PromptSubmission | null> {
    if (this.closed) return null;
    if (this.rl || this.promptActive || this.guardedInputActive) {
      throw new Error("A terminal prompt is already active.");
    }
    if (!this.canUseRawEditor()) {
      const text = await this.question(prompt);
      return text === null ? null : { text, images: [], pasteErrors: [] };
    }
    this.promptActive = true;
    const promptController = new AbortController();
    this.activePromptController = promptController;
    try {
      const result = await readPrompt({
        input: this.input,
        output: this.output as PromptOutput,
        prompt,
        initialImageCount: options.initialImageCount,
        signal: promptController.signal,
        captureImage: options.captureImage,
        captureText: options.captureText,
        completionProvider: (draft) => completeSlashCommandPrefix(draft.text, draft.cursor),
        onSessionReady: (session) => this.trackPromptSession(session),
        onShowThinking: (id) => {
          const shown = this.showReasoning(id);
          if (!shown) {
            this.info(
              id === "last"
                ? "No Thinking content is available in this thread."
                : `Thinking block #${id} is not available in this thread.`,
            );
          }
        },
      });
      if (result === null) this.closed = true;
      return result;
    } finally {
      this.activePromptSession = undefined;
      if (this.activePromptController === promptController) this.activePromptController = undefined;
      this.promptActive = false;
    }
  }

  async selectProvider(
    choices: readonly ProviderSelectorChoice[],
    initialProvider: ProviderSelectorChoice["provider"],
  ): Promise<ProviderSelectorChoice["provider"] | undefined> {
    if (this.closed) return undefined;
    if (this.rl || this.promptActive || this.guardedInputActive)
      throw new Error("Provider selection cannot start while a prompt is active.");
    return this.withPrivateProtocolFilteredInput((input) =>
      selectProvider(choices, {
        input: input as ModelSelectorInput,
        output: this.output as ModelSelectorOutput,
        initialProvider,
        color: this.colorEnabled(),
      }),
    );
  }

  async selectModel(
    providerName: string,
    choices: readonly ModelSelectorChoice[],
    initialModel?: string,
  ): Promise<string | undefined> {
    if (this.closed) return undefined;
    if (this.rl || this.promptActive || this.guardedInputActive)
      throw new Error("Model selection cannot start while a prompt is active.");
    return this.withPrivateProtocolFilteredInput((input) =>
      selectModel(providerName, choices, {
        input: input as ModelSelectorInput,
        output: this.output as ModelSelectorOutput,
        initialModel,
        color: this.colorEnabled(),
      }),
    );
  }

  async selectThinkingEffort(
    providerName: string,
    model: string,
    choices: readonly ThinkingEffortSelectorChoice[],
    initialEffort: ThinkingEffort,
  ): Promise<ThinkingEffort | undefined> {
    if (this.closed) return undefined;
    if (this.rl || this.promptActive || this.guardedInputActive)
      throw new Error("Thinking effort selection cannot start while a prompt is active.");
    return this.withPrivateProtocolFilteredInput((input) =>
      selectThinkingEffort(providerName, model, choices, {
        input: input as ModelSelectorInput,
        output: this.output as ModelSelectorOutput,
        initialEffort,
        color: this.colorEnabled(),
      }),
    );
  }

  async readSecret(prompt: string): Promise<string> {
    if (this.closed) throw new Error("Terminal input is closed.");
    if (this.rl || this.promptActive || this.guardedInputActive || this.secretInputActive)
      throw new Error("Secret input must be read before the prompt is opened.");
    this.secretInputActive = true;
    try {
      return await this.withPrivateProtocolFilteredInput((input) =>
        readSecretInput(input as ModelSelectorInput, this.output, prompt),
      );
    } finally {
      this.secretInputActive = false;
    }
  }

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (request.signal?.aborted) return "reject";
    // Background approvals may arrive while the main prompt is open. Wait for
    // any other modal, then borrow stdin from the idle editor and restore it.
    while (!this.closed && this.guardedInputActive && !request.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.closed || request.signal?.aborted) return "reject";
    const idleSession = request.source ? this.activePromptSession : undefined;
    if (idleSession && idleSession.suspendInput()) {
      this.activePromptSession = undefined;
      this.promptActive = false;
      try {
        return await this.approve(request);
      } finally {
        if (!this.closed) {
          this.activePromptSession = idleSession;
          this.promptActive = true;
          idleSession.resumeInput({ discardLeadingModalControls: true });
        }
      }
    }
    const title = redactSensitiveInformation(sanitizeCommandOutput(request.title)).replace(/\s+/gu, " ").trim();
    const description = redactSensitiveInformation(sanitizeCommandOutput(request.description));
    const preview = request.commandPreview
      ? redactSensitiveInformation(sanitizeCommandOutput(request.commandPreview)).replace(/[\r\n]+/gu, " ")
      : undefined;
    // Approval is a security decision: its complete description and resolved
    // command are printed before the selector, never only inside it.
    this.write(
      chalk.yellow(`\nApproval required: ${title}\n`) +
        `${description}\n` +
        (request.network
          ? `Network effect: ${request.network.effect}; destination: ${sanitizeCommandOutput(request.network.destination ?? "resolved when the command connects")}\n`
          : "") +
        (request.network
          ? `Optional saved grant scope: ${sanitizeCommandOutput(formatCommandApprovalPrefix(request.commandPrefix))}\n`
          : "") +
        (preview ? chalk.gray(`Command: ${preview}\n`) : ""),
    );

    if (this.closed || !this.isInteractive() || this.rl || this.promptActive || this.guardedInputActive) {
      return "reject";
    }
    const controller = new AbortController();
    this.activeApprovalController = controller;
    const onRequestAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onRequestAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    try {
      return await this.withPrivateProtocolFilteredInput((input) =>
        selectApproval(request.commandPrefix, {
          signal: controller.signal,
          input: input as ModelSelectorInput,
          output: this.output as ModelSelectorOutput,
          color: this.colorEnabled(),
        }),
      );
    } catch {
      return "reject";
    } finally {
      request.signal?.removeEventListener("abort", onRequestAbort);
      if (this.activeApprovalController === controller) this.activeApprovalController = undefined;
    }
  }

  async reviewPlan(options: Readonly<PlanReviewInputOptions> = {}): Promise<PlanReviewDecision> {
    if (!this.isInteractive()) return { action: "defer" };
    const plan = options.plan ?? this.lastPlan;
    if (plan && this.canUseRawEditor()) {
      const choices = ["Yes, use Auto mode", "No, reject plan", "Adjust plan with feedback"];
      const selection = await this.withPrivateProtocolFilteredInput((input) =>
        selectMenuIndex(
          choices.length,
          0,
          (selectedIndex) => renderMenu("Review proposed plan", choices, selectedIndex, this.colorEnabled()),
          {
            input,
            output: this.output as ModelSelectorOutput,
            color: this.colorEnabled(),
            idleTimeoutMs: options.idleTimeoutMs ?? DECISION_TIMEOUT_MS,
            idleSelectionIndex: 0,
          },
          "No plan review choices are available.",
        ),
      );
      if (selection === undefined) return { action: "defer" };
      if (selection === 0) return { action: "approve" };
      if (selection === 1) return { action: "reject" };
      const feedback = await this.planTextQuestion("Plan feedback > ", options.captureText);
      if (feedback === null) return { action: "defer" };
      const sanitized = sanitizePlanText(feedback);
      return sanitized ? { action: "adjust", feedback: sanitized } : { action: "defer" };
    }
    while (!this.closed) {
      this.write("\nWhat would you like to do?\n\n");
      this.write("1. Yes, use Auto mode\n");
      this.write("2. No, reject plan\n");
      this.write("3. Type feedback and press Enter to adjust the plan\n\n");
      const response = await this.planTextQuestion("Choose 1/2, or type feedback to adjust > ", options.captureText);
      if (response === null) return { action: "defer" };
      const answer = sanitizePlanText(response);
      if (!answer) continue;
      const normalized = answer.toLowerCase();
      if (normalized === "1" || normalized === "y" || normalized === "yes") return { action: "approve" };
      if (normalized === "2" || normalized === "n" || normalized === "no") return { action: "reject" };
      if (normalized === "3") {
        const feedback = await this.planTextQuestion("Plan feedback > ", options.captureText);
        if (feedback === null) return { action: "defer" };
        const sanitized = sanitizePlanText(feedback);
        if (!sanitized) continue;
        return { action: "adjust", feedback: sanitized };
      }
      return { action: "adjust", feedback: answer };
    }
    return { action: "defer" };
  }

  async selectChoice(
    title: string,
    choices: readonly InteractionChoice[],
    initialId?: string,
    timed?: Readonly<TimedChoiceOptions>,
  ): Promise<string | undefined> {
    if (this.closed || choices.length === 0) return undefined;
    if (!this.isInteractive() || this.promptActive || this.guardedInputActive) return undefined;
    const initialIndex = Math.max(
      0,
      choices.findIndex((choice) => choice.id === initialId),
    );
    const selection = await this.withPrivateProtocolFilteredInput((input) =>
      selectMenuIndex(
        choices.length,
        initialIndex,
        (selectedIndex) =>
          renderMenu(
            title,
            choices.map((choice) => `${choice.label}${choice.detail ? `  [${choice.detail}]` : ""}`),
            selectedIndex,
            this.colorEnabled(),
            512,
          ),
        {
          input,
          output: this.output as ModelSelectorOutput,
          color: this.colorEnabled(),
          ...(timed?.signal ? { signal: timed.signal } : {}),
          ...(timed
            ? {
                idleTimeoutMs: timed.idleTimeoutMs,
                idleSelectionIndex: choices.findIndex((choice) => choice.id === timed.idleChoiceId && !choice.disabled),
              }
            : {}),
        },
        `No choices are available for ${title}.`,
      ),
    );
    const choice = selection === undefined ? undefined : choices[selection];
    return choice?.disabled ? undefined : choice?.id;
  }

  /** Keep Ctrl+C meaningful while the CLI awaits an external callback. */
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

  // ---------------------------------------------------------------- private

  question(prompt: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.promptActive || this.guardedInputActive) throw new Error("A terminal prompt is already active.");
    const rl = this.ensureReadline();
    return new Promise((resolve) => {
      let settled = false;
      rl.once("close", () => {
        this.releaseReadlineInput(rl);
        if (settled) return;
        settled = true;
        this.closed = true;
        resolve(null);
      });
      rl.question(prompt, (answer) => {
        if (settled) return;
        settled = true;
        rl.close();
        this.releaseReadlineInput(rl);
        resolve(answer);
      });
    });
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
          terminal: this.streamsAreTty(),
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

  private trackPromptSession(session: PromptInputSession | undefined): void {
    if (session) this.activePromptSession = session;
    else this.activePromptSession = undefined;
  }

  /** Run one modal reader on a filtered copy of stdin, restoring Raw Mode and flow afterwards. */
  private async withPrivateProtocolFilteredInput<T>(action: (input: PrivateOscInputFilter) => Promise<T>): Promise<T> {
    if (this.guardedInputActive) throw new Error("A terminal input operation is already active.");
    this.guardedInputActive = true;
    const wasRaw = Boolean(this.input.isRaw);
    const wasFlowing = this.input.readableFlowing === true;
    const inputFilter = new PrivateOscInputFilter(this.input);
    try {
      // A Windows console read inherits cooked/raw behavior when the read is
      // first issued. Piping before Raw Mode therefore makes the first menu
      // ignore arrows until Enter completes that cooked read. Acquire Raw Mode
      // first, synchronously let the modal install its data listener, and only
      // then start source flow into the filter.
      this.input.pause();
      if (!wasRaw) this.input.setRawMode?.(true);
      const pending = action(inputFilter);
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
    }
  }

  /**
   * Read text that may contain a bracketed multiline paste. Plain readline
   * treats every pasted newline as an immediate submission, so plan feedback
   * uses the same atomic paste transport as the request editor.
   */
  private async multilineTextQuestion(
    prompt: string,
    captureText?: PlanReviewInputOptions["captureText"],
  ): Promise<Pick<PromptSubmission, "text" | "pasteErrors"> | null> {
    if (this.closed) return null;
    if (this.rl || this.promptActive || this.guardedInputActive) {
      throw new Error("A terminal prompt is already active.");
    }
    if (!this.streamsAreTty()) {
      const text = await this.question(prompt);
      return text === null ? null : { text, pasteErrors: [] };
    }
    if (typeof this.input.setRawMode !== "function") {
      this.warning("Multiline plan feedback requires terminal Raw Mode support.");
      return null;
    }
    this.promptActive = true;
    const promptController = new AbortController();
    this.activePromptController = promptController;
    try {
      const result = await readPrompt({
        input: this.input,
        output: this.output as PromptOutput,
        prompt,
        signal: promptController.signal,
        captureImage: async () => {
          throw new Error("Images are not supported in plan feedback.");
        },
        captureText,
        textOnlyPaste: true,
        onSessionReady: (session) => this.trackPromptSession(session),
      });
      if (result === null) {
        this.closed = true;
        return null;
      }
      return { text: result.text, pasteErrors: result.pasteErrors };
    } finally {
      this.activePromptSession = undefined;
      if (this.activePromptController === promptController) this.activePromptController = undefined;
      this.promptActive = false;
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
      this.warning(`Plan feedback paste failed: ${submission.pasteErrors.join("; ")}`);
    }
    return null;
  }

  private writeStableStatus(text: string, kind: StableStatusKind): void {
    const paint =
      kind === "error" ? chalk.red : kind === "warning" ? chalk.yellow : kind === "success" ? chalk.green : chalk.cyan;
    this.write(`${paint(text)}\n`);
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

  /** Editors read the real streams, independent of how a host reports interactivity. */
  private streamsAreTty(): boolean {
    return Boolean(this.input.isTTY && (this.output as NodeJS.WriteStream).isTTY);
  }

  private canUseRawEditor(): boolean {
    return this.streamsAreTty() && typeof this.input.setRawMode === "function";
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
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = undefined;
    this.activityVisible = false;
    this.activityText = "";
    this.activityStartedAt = 0;
    this.activityFrameIndex = 0;
  }

  /**
   * A broken terminal is not a recoverable presentation downgrade: abort the
   * request, restore terminal modes, and let the normal application shutdown
   * persist Runtime state for a later `/resume`.
   */
  private failTerminalUi(stage: string, value: unknown): void {
    if (this.closed || this.fatalUiFailure) return;
    const cause = value instanceof Error ? value : new Error(String(value));
    const error = new Error(`CLI ${stage} failed: ${cause.message}`);
    this.fatalUiFailure = error;
    process.exitCode = 1;
    const interrupt = this.currentRequestOptions?.onInterrupt;
    if (interrupt && !this.currentRequestInterruptSignaled) {
      this.currentRequestInterruptSignaled = true;
      try {
        interrupt();
      } catch {
        // Shutdown must continue even if a request-specific abort hook fails.
      }
    }
    this.close();
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
