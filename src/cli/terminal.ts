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
  renderReasoningMarker,
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
} from "../ui/render/layout.js";
import {
  renderComposerFooter,
  renderLiveRegion,
  renderSessionHeader,
} from "../ui/render/view.js";

export type PlanReviewDecision =
  | { action: "approve" }
  | { action: "reject" }
  | { action: "adjust"; feedback: string }
  | { action: "defer" };

export interface TerminalChoice {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly disabled?: boolean;
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
  private readonly reasoning = new ReasoningRegistry();
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
  private agentConcurrencyLimit?: number;
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
  ): void {
    if (!this.inlineShellActive) return;
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
  }

  clearCurrentRequest(): void {
    if (!this.inlineShellActive) return;
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
      this.completeRunningProgress("status");
      this.writeStableStatus(label, presentation.kind);
      this.refresh();
      return;
    }

    const kind = presentation.kind;
    this.completeRunningProgress(kind);
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
    for (let index = this.progressItems.length - 1; index >= 0; index -= 1) {
      const item = this.progressItems[index];
      if (item?.kind !== "tool" || item.status !== "running") continue;
      this.progressItems[index] = {
        ...item,
        status: ok ? "completed" : "failed",
        ...(summary ? { detail: this.safeInline(summary, 160) } : {}),
      };
      break;
    }
    this.uiState = applyEvent(this.uiState, {
      type: "progress.set",
      progress: this.progressItems,
    });
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
          ? { renderBelow: () => this.composerPromptSuffix() }
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
      });
      if (result === null) this.closed = true;
      if (this.inlineShellActive && result !== null) {
        this.uiState = applyEvent(this.uiState, {
          type: "transcript.append",
          entry: {
            kind: "user",
            text: result.text,
            images: result.images,
          },
        });
        this.screen?.commit(`${this.composerBottomBorder()}\n`);
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

  async reviewPlan(): Promise<PlanReviewDecision> {
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
      const feedback = await this.question("Plan feedback > ");
      if (feedback === null) return { action: "defer" };
      const sanitized = sanitizePlanText(feedback, MAX_PLAN_FEEDBACK_CHARS);
      return sanitized
        ? { action: "adjust", feedback: sanitized }
        : { action: "defer" };
    }
    while (!this.closed) {
      this.write("\nWhat would you like to do?\n\n");
      this.write("1. Yes, use Auto mode\n");
      this.write("2. No, reject plan\n");
      this.write("3. Type feedback and press Enter to adjust the plan\n\n");
      const response = await this.question(
        "Choose 1/2, or type feedback to adjust > ",
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
        const feedback = await this.question("Plan feedback > ");
        if (feedback === null) return { action: "defer" };
        const sanitized = sanitizePlanText(feedback, MAX_PLAN_FEEDBACK_CHARS);
        if (!sanitized) continue;
        return { action: "adjust", feedback: sanitized };
      }
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
      this.uiState = applyEvent(this.uiState, {
        type: "transcript.append",
        entry: { kind: "raw", text },
      });
      if (this.activePromptSession) {
        this.activePromptSession.writeAbove(text);
        return;
      }
      this.screen?.commit(text);
      this.refresh();
      return;
    }
    this.stopActivity();
    this.output.write(text);
  }

  /** Show a transient TTY spinner until the pending operation completes. */
  startActivity(text: string): void {
    this.stopActivity();
    if (!this.canAnimateActivity()) return;

    const sanitized = this.safeInline(text, 160);
    this.activityText = sanitized || "Waiting for the model response";
    this.activityStartedAt = Date.now();
    this.activityFrameIndex = 0;
    if (this.inlineShellActive) {
      this.activeActivityId = `activity_${this.activityStartedAt}`;
      this.uiState = applyEvent(this.uiState, {
        type: "activity.start",
        activity: {
          id: this.activeActivityId,
          kind: "model",
          label: this.activityText,
          startedAt: this.activityStartedAt,
        },
      });
    }
    try {
      this.renderActivity();
    } catch {
      this.resetActivityState();
      return;
    }

    this.activityTimer = setInterval(() => {
      try {
        if (!this.canAnimateActivity()) {
          this.stopActivity();
          return;
        }
        this.activityFrameIndex =
          (this.activityFrameIndex + 1) % Terminal.ACTIVITY_FRAMES.length;
        this.renderActivity();
      } catch {
        this.resetActivityState();
      }
    }, Terminal.ACTIVITY_INTERVAL_MS);
    this.activityTimer.unref();
  }

  /** Clear the transient spinner without adding a blank line. */
  stopActivity(): void {
    const wasVisible = this.activityVisible;
    const activityId = this.activeActivityId;
    this.resetActivityState();
    this.activeActivityId = undefined;
    if (this.inlineShellActive) {
      this.uiState = applyEvent(this.uiState, {
        type: "activity.stop",
        ...(activityId ? { id: activityId } : {}),
      });
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
      this.write(renderReasoningMarker(block, { color: this.colorEnabled() }));
    }
    return block.id;
  }

  /** Rebuild `/thinking` history for a resumed Thread without replaying old markers. */
  restoreReasoning(texts: readonly string[]): number {
    return this.reasoning.rebuild(texts);
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

  /** Drop the current Thread's blocks without reusing IDs from old markers. */
  clearReasoning(): void {
    this.reasoning.clear();
  }

  close(): void {
    if (this.closed) return;
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
      this.input.pipe(inputFilter);
      try {
        const rl = readline.createInterface({
          input: inputFilter,
          output: this.output,
          terminal:
            Boolean(this.input.isTTY) &&
            Boolean((this.output as NodeJS.WriteStream).isTTY),
        });
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

  private async withPrivateProtocolFilteredInput<T>(
    action: (input: PrivateOscInputFilter) => Promise<T>,
  ): Promise<T> {
    if (this.guardedInputActive) {
      throw new Error("A terminal input operation is already active.");
    }
    this.guardedInputActive = true;
    const inputFilter = new PrivateOscInputFilter(this.input);
    this.input.pipe(inputFilter);
    try {
      return await action(inputFilter);
    } finally {
      this.input.unpipe(inputFilter);
      if (!inputFilter.destroyed) inputFilter.destroy();
      this.guardedInputActive = false;
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
    this.screen.renderLive(
      renderLiveRegion(this.uiState, Date.now(), this.viewOptions()),
    );
  }

  private viewOptions(): {
    columns: number;
    color: boolean;
    agentConcurrencyLimit?: number;
    spinnerFrame: number;
  } {
    return {
      columns: this.screen?.columns ??
        (Number((this.output as NodeJS.WriteStream).columns) || 80),
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
    if (this.activePromptSession) {
      this.activePromptSession.writeAbove(entry.text);
    } else {
      this.screen?.commit(entry.text);
    }
  }

  private completeRunningProgress(kind: UIProgressItem["kind"]): void {
    let changed = false;
    this.progressItems = this.progressItems.map((item) => {
      if (item.kind !== kind || item.status !== "running") return item;
      changed = true;
      return { ...item, status: "completed" as const };
    });
    if (changed) {
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

  private composerPromptPrefix(): string {
    const columns = Math.max(12, this.screen?.columns ?? 80);
    const title = truncateToWidth(" Request ", Math.max(1, columns - 3), {
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
    return `${this.composerBottomBorder()}\n${
      renderComposerFooter(this.uiState, this.viewOptions())
    }`;
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
