import readline from "node:readline";
import chalk from "chalk";
import type { ApprovalRequest } from "../core/types.js";

export class Terminal {
  private readonly rl: readline.Interface;
  private closed = false;

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout
  ) {
    this.rl = readline.createInterface({ input, output, terminal: Boolean(process.stdout.isTTY) });
    this.rl.once("close", () => {
      this.closed = true;
    });
  }

  isInteractive(): boolean {
    return Boolean((this.input as NodeJS.ReadStream).isTTY);
  }

  question(prompt: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const onClose = (): void => {
        if (settled) return;
        settled = true;
        resolve(null);
      };
      this.rl.once("close", onClose);
      this.rl.question(prompt, (answer) => {
        if (settled) return;
        settled = true;
        this.rl.removeListener("close", onClose);
        resolve(answer);
      });
    });
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

  close(): void {
    if (!this.closed) this.rl.close();
  }
}

export function printBanner(terminal: Terminal): void {
  terminal.write(chalk.bold.cyan("\nEASY CODE") + chalk.gray(" — local CLI coding agent\n"));
  terminal.write(chalk.gray("输入 /help 查看命令，/exit 退出。\n\n"));
}
