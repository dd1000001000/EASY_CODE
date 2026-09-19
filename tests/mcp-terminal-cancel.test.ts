import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Terminal } from "../src/cli/terminal.js";
import type { UISessionInfo } from "../src/ui/contracts.js";
import { describe, it } from "./harness.js";

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this { this.isRaw = value; return this; }
}
class TtyOutput extends PassThrough {
  readonly isTTY = true;
  columns = 100;
  rows = 30;
}

const session: UISessionInfo = { threadId: "thread_mcp_cancel", workspaceRoot: process.cwd(),
  mode: "auto", provider: "deepseek", model: "deepseek-v4-flash",
  thinkingEffort: "low", contextTokens: 0 };

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("MCP authorization terminal cancellation", () => {
  it("routes raw-mode Ctrl+C to the external operation and restores the input owner", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const terminal = new Terminal(input, output);
    const previousCI = process.env.CI;
    const previousTerm = process.env.TERM;
    process.env.CI = "";
    process.env.TERM = "xterm-256color";
    try {
      assert.equal(terminal.beginShell(session), true);
      const prompt = terminal.readPrompt("> ", { captureImage: async () => { throw new Error("No image expected"); } });
      input.write("/mcp\r");
      assert.equal((await prompt)?.text, "/mcp");
      assert.equal(input.isRaw, true);
      const before = process.listenerCount("SIGINT");
      const pending = terminal.withCancellableExternalOperation(waitForAbort);
      input.write(Buffer.from([0x03]));
      await Promise.race([assert.rejects(pending, /canceled by user/u),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Raw Ctrl+C was not delivered")), 1_000))]);
      assert.equal(process.listenerCount("SIGINT"), before);
      assert.equal(input.isRaw, true);
    } finally {
      terminal.close();
      if (previousCI === undefined) delete process.env.CI; else process.env.CI = previousCI;
      if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm;
    }
  });

  it("also handles cooked-mode SIGINT while an authorization is pending", async () => {
    const terminal = new Terminal(new PassThrough(), new PassThrough());
    try {
      const before = process.listenerCount("SIGINT");
      const pending = terminal.withCancellableExternalOperation(waitForAbort);
      process.emit("SIGINT");
      await assert.rejects(pending, /canceled by user/u);
      assert.equal(process.listenerCount("SIGINT"), before);
    } finally { terminal.close(); }
  });
});
