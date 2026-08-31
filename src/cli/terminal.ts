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
  MAX_PLAN_FEEDBACK_CHARS,
  formatPlanProposal,
  sanitizePlanText,
} from "../plans/plan.js";
import { readSecretInput } from "../config/secret-input.js";
import { renderFileDiff } from "./file-diff.js";
import {
  PrivateOscInputFilter,
  readPrompt,
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
  displayWidth,
  stripAnsi,
  truncateToWidth,
  wrapToWidth,
} from "../ui/render/layout.js";
import {
  renderComposerStatusRegion,
  renderLiveRegion,
  renderSessionHeader,
  renderThinkingPanel,
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
  private readonly reasoning = new ReasoningRegistry();
  /**
   * The most recent turn remains redrawable until the next request is
   * submitted. This is the only terminal region where a Thinking preview can
   * be replaced in place; committed scrollback is intentionally immutable.
   */
  private mutableTurnTail: MutableTurnSegment[] = [];
  private expandedReasoningId?: number;
  private activityTimer?: NodeJS.Timeout;
  private activityStartedAt = 0;
  private activityFrameIndex = 0;
  private activityText = "";
  private activityVisible = false;
  private screen?: ScreenWriter;
  private uiState = createUIState();
  private inlineShellActive = false;
  private activePromptSession?: PromptInputSession;
  private lastPlan?: Readonly<PlanProposal>;
  private progressItems: UIProgressItem[] = [];
  private progressSequence = 0;
  private activeActivityId?: string;
  private activitySequence = 0;
  private agentConcurrencyLimit?: number;
  /** Track DEC cursor visibility while EASY CODE owns the inline shell. */
  private terminalCursorVisible = true;
  private readonly onResize = (): void => this.refresh();

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
    this.stopBusyInputOwner();
    this.currentRequestOptions = options;
    if (!this.inlineShellActive) return;
    // A completed turn remains interactive while its idle Request editor is
    // visible. Starting the next busy turn is the ownership boundary at which
    // that prior tail becomes immutable scrollback.
    if (!this.uiState.composer.busy) this.flushMutableTurnTail();
    this.progressItems = [];
    this.progressSequence = 0;
    this.uiState = applyEvent(this.uiState, { type: "progress.clear" });
    const summary = this.safeInline(text, 120);
    this.uiState = applyEvent(this.uiState, {
      type: "composer.patch",
      patch: {
        busy: true,
        text: "",
        placeholder: summary ? `Working on: ${summary}` : "Working…",
        images,
      },
    });
    this.refresh();
    this.startBusyInputOwner();
  }

  clearCurrentRequest(): void {
    this.currentRequestOptions = undefined;
    this.stopBusyInputOwner();
    if (!this.inlineShellActive) return;
    this.progressItems = [];
    this.progressSequence = 0;
    this.uiState = applyEvent(this.uiState, { type: "progress.clear" });
    this.uiState = applyEvent(this.uiState, { type: "composer.reset" });
    this.refresh();
  }

  /** Route audited runtime progress to live UI and retain all other notices. */
  status(text: string): void {
    const label = this.safeInline(text, 240);
    if (!label) return;
    const presentation = classifyStatus(label);
    if (!this.inlineShellActive) {
      this.writeStableStatus(
        label,
        presentation.destination === "stable" ? presentation.kind : "info",
      );
      return;
    }
    if (presentation.destination === "stable") {
      this.removeRunningProgress("status");
      this.writeStableStatus(label, presentation.kind);
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

  toolCompleted(toolName: string, ok: boolean, summary?: string): void {
    if (!this.inlineShellActive) return;
    // Completion is durable scrollback. Keeping a second completed copy in the
    // redrawable region makes every tool appear twice and lets Progress grow
    // for the lifetime of a request.
    this.removeRunningProgress("tool");
    const detail = summary ? ` — ${this.safeInline(summary, 160)}` : "";
    this.commitTranscript({
      kind: "tool",
      text: `${ok ? "✓" : "✗"} Tool: ${this.safeInline(toolName, 80)}${detail}\n`,
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
    this.currentRequestOptions = undefined;
    this.stopBusyInputOwner();
    this.resetActivityState();
    this.activeActivityId = undefined;
    this.lastPlan = undefined;
    this.progressItems = [];
    this.progressSequence = 0;
    this.agentConcurrencyLimit = undefined;
    this.clearMutableTurnTail();
    this.reasoning.clear();
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
          this.activePromptSession = session;
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
          this.toggleReasoning(id);
        },
      });
      if (result === null) this.closed = true;
      if (this.inlineShellActive && result !== null) {
        // readPrompt has erased its dynamic prefix at this point. Freeze the
        // previous completed turn before printing the newly submitted request,
        // so the old Thinking marker cannot move below the new user message.
        this.flushMutableTurnTail();
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
          ? { overlay: this.menuOverlay("provider-picker", "picker") }
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
          ? { overlay: this.menuOverlay("model-picker", "picker") }
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
          ? { overlay: this.menuOverlay("thinking-picker", "picker") }
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
    if (!this.inlineShellActive) {
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
      this.write(chalk.yellow(`\nApproval required: ${title}\n`));
      this.write(`${description}\n`);
      if (preview) this.write(chalk.gray(`Command: ${preview}\n`));
    }

    if (
      this.closed ||
      !this.isInteractive() ||
      this.rl ||
      this.promptActive ||
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
      const sanitized = sanitizePlanText(feedback, MAX_PLAN_FEEDBACK_CHARS);
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
      const answer = sanitizePlanText(response, MAX_PLAN_FEEDBACK_CHARS);
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
        const sanitized = sanitizePlanText(feedback, MAX_PLAN_FEEDBACK_CHARS);
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
    if (!this.isInteractive() || this.promptActive || this.guardedInputActive) {
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
            ? { overlay: this.menuOverlay(`choice-${Date.now()}`, "picker") }
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
    this.currentRequestOptions = undefined;
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

  /** Rebuild `/thinking` history for a resumed Thread without replaying old markers. */
  restoreReasoning(texts: readonly string[]): number {
    this.clearMutableTurnTail();
    const count = this.reasoning.rebuild(texts);
    this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
    this.refresh();
    return count;
  }

  /** Append one bounded, sanitized thinking block. Missing IDs are silent. */
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

  /** Toggle one Thinking block in the redrawable panel without adding scrollback. */
  toggleReasoning(id: number): boolean {
    if (!this.isInteractive()) return false;
    const block = this.reasoning.get(id);
    if (!block) {
      // A stale marker must not leave an unrelated block looking selected.
      this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
      this.expandedReasoningId = undefined;
      this.writeStableStatus(
        `Thinking block #${id} is not available in this thread.`,
        "info",
      );
      this.refresh();
      return false;
    }
    if (!this.inlineShellActive) return false;
    if (!this.mutableTurnTail.some((segment) => segment.reasoning?.id === id)) {
      // Scrollback is immutable in an ordinary terminal. Current-version
      // historical markers are intentionally non-clickable; this fallback is
      // only for stale markers printed by an older EASY CODE process.
      this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
      this.expandedReasoningId = undefined;
      this.writeStableStatus(
        `Thinking block #${id} is historical; use /thinking ${id} to view it.`,
        "info",
      );
      this.refresh();
      return false;
    }
    this.uiState = applyEvent(this.uiState, {
      type: "thinking.toggle",
      panel: block,
    });
    this.expandedReasoningId = this.uiState.live.thinking?.id;
    this.refresh();
    return true;
  }

  /** Drop the current Thread's blocks without reusing IDs from old markers. */
  clearReasoning(): void {
    this.flushMutableTurnTail();
    this.reasoning.clear();
    this.uiState = applyEvent(this.uiState, { type: "thinking.hide" });
    this.refresh();
  }

  close(): void {
    if (this.closed) return;
    this.currentRequestOptions = undefined;
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
        this.toggleReasoning(id);
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
    if (this.guardedInputActive) {
      throw new Error("A terminal input operation is already active.");
    }
    this.guardedInputActive = true;

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
      this.startBusyInputOwner();
    }
  }

  private refresh(): void {
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
    if (this.mutableTurnTail.length > 0) {
      this.mutableTurnTail.push({ entry: { ...entry } });
      this.refresh();
      return;
    }
    if (this.activePromptSession) {
      this.activePromptSession.writeAbove(entry.text);
    } else {
      this.screen?.commit(entry.text);
    }
  }

  private appendMutableTurnSegment(
    entry: Readonly<UITranscriptEntry>,
    reasoning?: Readonly<ReasoningBlock>,
  ): void {
    this.uiState = applyEvent(this.uiState, {
      type: "transcript.append",
      entry,
    });
    this.mutableTurnTail.push({
      entry: { ...entry },
      ...(reasoning ? { reasoning: { ...reasoning } } : {}),
    });
  }

  private renderMutableTurnTail(
    historical = false,
    maximumRows?: number,
  ): string {
    if (this.mutableTurnTail.length === 0) return "";
    const rendered = this.mutableTurnTail.map((segment) => {
      const block = segment.reasoning;
      if (!block) return segment.entry.text;
      if (historical) {
        return renderReasoningHistoryMarker(block, {
          color: this.colorEnabled(),
        });
      }
      if (this.expandedReasoningId === block.id) {
        const expanded = renderThinkingPanel(block, {
          ...this.viewOptions(),
          maxThinkingRows: maximumRows === undefined
            ? 40
            : Math.max(1, Math.min(40, maximumRows)),
        });
        return expanded.endsWith("\n") ? expanded : `${expanded}\n`;
      }
      return renderReasoningMarker(block, { color: this.colorEnabled() });
    }).join("");
    if (historical || maximumRows === undefined) return rendered;
    const focusedReasoningId = this.expandedReasoningId ??
      [...this.mutableTurnTail].reverse().find((segment) => segment.reasoning)
        ?.reasoning?.id;
    return this.fitMutableTailRows(
      rendered,
      maximumRows,
      focusedReasoningId,
      this.expandedReasoningId !== undefined,
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
    this.expandedReasoningId = undefined;
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
    focusedReasoningId?: number,
    expanded = false,
  ): string {
    const limit = Number.isFinite(maximumRows)
      ? Math.max(0, Math.floor(maximumRows))
      : Number.MAX_SAFE_INTEGER;
    if (limit === 0 || !text) return "";
    const columns = Math.max(1, this.screen?.columns ?? 80);
    const lines = wrapToWidth(text, columns, { preserveAnsi: true });
    if (lines.length <= limit) return lines.join("\n");
    if (limit === 1) return lines[0] ?? "";

    if (focusedReasoningId !== undefined) {
      const anchorText = expanded
        ? `↕ Thinking #${focusedReasoningId} · /thinking ${focusedReasoningId}`
        : `▶ Thinking #${focusedReasoningId}`;
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
    const title = truncateToWidth(" Request ", Math.max(1, columns - 3), {
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
