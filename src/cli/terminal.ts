import readline from "node:readline";
import chalk from "chalk";
import type {
  ApprovalRequest,
  FileDiffPresentation,
  ImageAttachment,
} from "../core/types.js";
import { readSecretInput } from "../config/secret-input.js";
import { renderFileDiff } from "./file-diff.js";
import {
  readPrompt,
  type PromptSubmission,
} from "./prompt-input.js";
import {
  selectModel,
  selectProvider,
  type ModelSelectorInput,
  type ModelSelectorOutput,
  type ModelSelectorChoice,
  type ProviderSelectorChoice,
} from "./model-selector.js";

export class Terminal {
  private rl?: readline.Interface;
  private closed = false;
  private promptActive = false;
  private activePromptController?: AbortController;

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout
  ) {}

  isInteractive(): boolean {
    return Boolean((this.input as NodeJS.ReadStream).isTTY);
  }

  question(prompt: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.promptActive) throw new Error("A terminal prompt is already active.");
    const rl = this.ensureReadline();
    return new Promise((resolve) => {
      let settled = false;
      const onClose = (): void => {
        if (this.rl === rl) this.rl = undefined;
        if (settled) return;
        settled = true;
        this.closed = true;
        resolve(null);
      };
      rl.once("close", onClose);
      rl.question(prompt, (answer) => {
        if (settled) return;
        settled = true;
        if (this.rl === rl) this.rl = undefined;
        rl.close();
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
    },
  ): Promise<PromptSubmission | null> {
    if (this.closed) return null;
    if (this.rl || this.promptActive) {
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

  selectProvider(
    choices: readonly ProviderSelectorChoice[],
    initialProvider: ProviderSelectorChoice["provider"],
  ): Promise<ProviderSelectorChoice["provider"] | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    if (this.rl || this.promptActive) throw new Error("Provider selection cannot start while a prompt is active.");
    return selectProvider(choices, {
      input: this.input as ModelSelectorInput,
      output: this.output as ModelSelectorOutput,
      initialProvider,
      color: this.colorEnabled(),
    });
  }

  selectModel(
    providerName: string,
    choices: readonly ModelSelectorChoice[],
    initialModel?: string,
  ): Promise<string | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    if (this.rl || this.promptActive) throw new Error("Model selection cannot start while a prompt is active.");
    return selectModel(providerName, choices, {
      input: this.input as ModelSelectorInput,
      output: this.output as ModelSelectorOutput,
      initialModel,
      color: this.colorEnabled(),
    });
  }

  readSecret(prompt: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Terminal input is closed."));
    if (this.rl || this.promptActive) throw new Error("Secret input must be read before the prompt is opened.");
    return readSecretInput(
      this.input as ModelSelectorInput,
      this.output,
      prompt,
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

  write(text: string): void {
    this.output.write(text);
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.activePromptController?.abort();
    this.activePromptController = undefined;
    this.rl?.close();
    this.rl = undefined;
  }

  private ensureReadline(): readline.Interface {
    if (this.closed) throw new Error("Terminal input is closed.");
    if (!this.rl) {
      const rl = readline.createInterface({
        input: this.input,
        output: this.output,
        terminal:
          Boolean((this.input as NodeJS.ReadStream).isTTY) &&
          Boolean((this.output as NodeJS.WriteStream).isTTY),
      });
      this.rl = rl;
    }
    return this.rl;
  }

  private colorEnabled(): boolean {
    const forceColor = process.env.FORCE_COLOR;
    return (
      !Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR") &&
      forceColor !== "0" &&
      (Boolean((this.output as NodeJS.WriteStream).isTTY) || Boolean(forceColor))
    );
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
