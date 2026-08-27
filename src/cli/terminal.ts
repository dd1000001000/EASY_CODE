import readline from "node:readline";
import chalk from "chalk";
import type { ApprovalRequest, FileDiffPresentation } from "../core/types.js";
import { readSecretInput } from "../config/secret-input.js";
import { renderFileDiff } from "./file-diff.js";
import {
  selectStartupModel,
  type ModelSelectorInput,
  type ModelSelectorOutput,
  type StartupModelChoice,
} from "./model-selector.js";

export class Terminal {
  private rl?: readline.Interface;
  private closed = false;

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout
  ) {}

  isInteractive(): boolean {
    return Boolean((this.input as NodeJS.ReadStream).isTTY);
  }

  question(prompt: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    const rl = this.ensureReadline();
    return new Promise((resolve) => {
      let settled = false;
      const onClose = (): void => {
        if (settled) return;
        settled = true;
        resolve(null);
      };
      rl.once("close", onClose);
      rl.question(prompt, (answer) => {
        if (settled) return;
        settled = true;
        rl.removeListener("close", onClose);
        resolve(answer);
      });
    });
  }

  selectStartupModel(
    choices: readonly StartupModelChoice[],
    initialProvider: StartupModelChoice["provider"],
  ): Promise<StartupModelChoice["provider"] | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    if (this.rl) throw new Error("The startup model must be selected before the prompt is opened.");
    return selectStartupModel(choices, {
      input: this.input as ModelSelectorInput,
      output: this.output as ModelSelectorOutput,
      initialProvider,
      color: this.colorEnabled(),
    });
  }

  readSecret(prompt: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Terminal input is closed."));
    if (this.rl) throw new Error("Secret input must be read before the prompt is opened.");
    return readSecretInput(
      this.input as ModelSelectorInput,
      this.output,
      prompt,
    );
  }

  async approve(request: ApprovalRequest): Promise<boolean> {
    this.write(chalk.yellow(`\n需要确认：${request.title}\n`));
    this.write(`${request.description}\n`);
    if (request.commandPreview) this.write(chalk.gray(`命令：${request.commandPreview}\n`));
    if (!this.isInteractive()) return false;
    const response = await this.question("允许这一次操作？[y/N] ");
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
    if (this.rl) this.rl.close();
    else this.closed = true;
  }

  private ensureReadline(): readline.Interface {
    if (this.closed) throw new Error("Terminal input is closed.");
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: this.input,
        output: this.output,
        terminal:
          Boolean((this.input as NodeJS.ReadStream).isTTY) &&
          Boolean((this.output as NodeJS.WriteStream).isTTY),
      });
      this.rl.once("close", () => {
        this.closed = true;
      });
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
  terminal.write(chalk.gray("输入 /help 查看命令，/exit 退出。\n\n"));
}
