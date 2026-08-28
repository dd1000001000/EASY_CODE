import readline from "node:readline";
import chalk from "chalk";
import { sanitizeCommandOutput } from "../command/output-stream.js";
import type {
  ApprovalRequest,
  FileDiffPresentation,
  ImageAttachment,
  PlanProposal,
  ThinkingEffort,
} from "../core/types.js";
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

export type PlanReviewDecision =
  | { action: "approve" }
  | { action: "reject" }
  | { action: "adjust"; feedback: string }
  | { action: "defer" };

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

  question(prompt: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.promptActive || this.guardedInputActive) {
      throw new Error("A terminal prompt is already active.");
    }
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
    const promptController = new AbortController();
    this.activePromptController = promptController;
    try {
      const result = await readPrompt({
        input: this.input as import("./prompt-input.js").PromptInput,
        output: this.output as import("./prompt-input.js").PromptOutput,
        prompt,
        initialImageCount: options.initialImageCount,
        signal: promptController.signal,
        captureImage: options.captureImage,
        captureText: options.captureText,
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
      return result;
    } finally {
      if (this.activePromptController === promptController) {
        this.activePromptController = undefined;
      }
      this.promptActive = false;
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
      }),
    );
  }

  async readSecret(prompt: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Terminal input is closed."));
    if (this.rl || this.promptActive || this.guardedInputActive) throw new Error("Secret input must be read before the prompt is opened.");
    return this.withPrivateProtocolFilteredInput((input) =>
      readSecretInput(
        input as ModelSelectorInput,
        this.output,
        prompt,
      ),
    );
  }

  async approve(request: ApprovalRequest): Promise<boolean> {
    this.write(chalk.yellow(`\nApproval required: ${request.title}\n`));
    this.write(`${request.description}\n`);
    if (request.commandPreview) this.write(chalk.gray(`Command: ${request.commandPreview}\n`));
    if (!this.isInteractive()) return false;
    const response = await this.question("Allow this operation once? [y/N] ");
    if (response === null) return false;
    const answer = response.trim().toLowerCase();
    return answer === "y" || answer === "yes" || answer === "是";
  }

  showPlan(plan: Readonly<PlanProposal>): void {
    this.write(`\n${formatPlanProposal(plan)}\n`);
  }

  async reviewPlan(): Promise<PlanReviewDecision> {
    if (!this.isInteractive()) return { action: "defer" };
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

  write(text: string): void {
    this.stopActivity();
    this.output.write(text);
  }

  /** Show a transient TTY spinner until the pending operation completes. */
  startActivity(text: string): void {
    this.stopActivity();
    if (!this.canAnimateActivity()) return;

    const sanitized = sanitizeCommandOutput(text)
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 160);
    this.activityText = sanitized || "Waiting for the model response";
    this.activityStartedAt = Date.now();
    this.activityFrameIndex = 0;
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
    this.resetActivityState();
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
    this.write(renderTaskGraph(graph, { color: this.colorEnabled() }));
  }

  /** Store provider thinking safely and print only its collapsed marker. */
  addReasoning(text: string): number {
    const block = this.reasoning.add(text);
    if (this.isInteractive()) {
      this.write(renderReasoningMarker(block, { color: this.colorEnabled() }));
    }
    return block.id;
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
