import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  renderApprovalSelector,
  selectApproval,
} from "../src/cli/approval-selector.js";
import { Terminal } from "../src/cli/terminal.js";
import type { ApprovalRequest } from "../src/core/types.js";
import { describe, it } from "./harness.js";

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawModeTransitions: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModeTransitions.push(mode);
    return this;
  }
}

class TtyOutput extends PassThrough {
  readonly isTTY = true;
}

function captureOutput(output: PassThrough): () => string {
  let transcript = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    transcript += chunk;
  });
  return () => transcript;
}

function approvalRequest(commandPrefix = "E:\\miniconda3\\python.exe"): ApprovalRequest {
  return {
    id: "approval_test",
    title: "Run python",
    description: "This command requires approval.",
    risk: "workspace",
    commandPrefix,
    commandPreview: JSON.stringify([commandPrefix, "_check_main.py"]),
  };
}

describe("command approval selector", () => {
  it("renders the selected choice in white, the others in gray, and escapes controls", () => {
    const lines = renderApprovalSelector(
      "E:\\safe\u001B[31m\u202Ehidden.exe",
      1,
      true,
    );

    assert.equal(lines.length, 5);
    assert.match(lines[1] ?? "", /\u001B\[90m/u);
    assert.match(lines[2] ?? "", /\u001B\[37m/u);
    assert.match(lines[3] ?? "", /\u001B\[90m/u);
    assert.match(lines[1] ?? "", /Yes, allow execute one time/u);
    assert.match(lines[2] ?? "", /Yes, don't ask me again with prefix/u);
    assert.match(lines[3] ?? "", /Reject/u);

    const plain = renderApprovalSelector(
      "E:\\safe\u001B[31m\u202Ehidden.exe",
      1,
      false,
    ).join("\n");
    assert.doesNotMatch(plain, /\u001B/u);
    assert.doesNotMatch(plain, /\u202E/u);
    // JSON array formatting escapes ESC before the shared label sanitizer sees
    // it; either representation is inert text rather than a terminal control.
    assert.match(plain, /\\u001b/u);
    assert.match(plain, /\\u\{202e\}/u);
  });

  it("returns all three structured decisions with arrow-key navigation", async () => {
    const onceInput = new TtyInput();
    const onceOutput = new TtyOutput();
    const once = selectApproval("python", {
      input: onceInput,
      output: onceOutput,
      color: false,
    });
    onceInput.write("\r");
    assert.equal(await once, "allow_once");

    const prefixInput = new TtyInput();
    const prefixOutput = new TtyOutput();
    const prefix = selectApproval("python", {
      input: prefixInput,
      output: prefixOutput,
      color: false,
    });
    prefixInput.write("\u001B[B\r");
    assert.equal(await prefix, "allow_prefix");

    const rejectInput = new TtyInput();
    const rejectOutput = new TtyOutput();
    const reject = selectApproval("python", {
      input: rejectInput,
      output: rejectOutput,
      color: false,
    });
    rejectInput.write("\u001B[A\r");
    assert.equal(await reject, "reject");
  });

  it("fails closed on Ctrl+C, Esc, and EOF", async () => {
    const ctrlInput = new TtyInput();
    const ctrlOutput = new TtyOutput();
    const ctrlSelection = selectApproval("python", {
      input: ctrlInput,
      output: ctrlOutput,
      color: false,
    });
    ctrlInput.write("\u0003");
    assert.equal(await ctrlSelection, "reject");

    const escapeInput = new TtyInput();
    const escapeOutput = new TtyOutput();
    const escapeSelection = selectApproval("python", {
      input: escapeInput,
      output: escapeOutput,
      color: false,
    });
    escapeInput.write("\u001B");
    const [escapeDecision] = await Promise.all([
      escapeSelection,
      new Promise<void>((resolve) => setTimeout(resolve, 80)),
    ]);
    assert.equal(escapeDecision, "reject");

    const eofInput = new TtyInput();
    const eofOutput = new TtyOutput();
    const eofSelection = selectApproval("python", {
      input: eofInput,
      output: eofOutput,
      color: false,
    });
    eofInput.end();
    assert.equal(await eofSelection, "reject");
  });

  it("restores Raw Mode, flow state, and the cursor after selection", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const transcript = captureOutput(output);
    const selection = selectApproval("python", {
      input,
      output,
      color: false,
    });
    input.write("\u001B[B\r");

    assert.equal(await selection, "allow_prefix");
    assert.deepEqual(input.rawModeTransitions, [true, false]);
    assert.equal(input.readableFlowing, false);
    assert.match(transcript(), /\u001B\[\?25l/u);
    assert.match(transcript(), /\u001B\[\?25h/u);
  });

  it("Terminal.approve uses the selector and fails closed without a TTY", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const terminal = new Terminal(input, output);
    const approval = terminal.approve(approvalRequest());
    input.write("\u001B[B\r");
    assert.equal(await approval, "allow_prefix");
    terminal.close();

    const nonTtyOutput = new PassThrough();
    nonTtyOutput.resume();
    const nonTtyTerminal = new Terminal(new PassThrough(), nonTtyOutput);
    assert.equal(await nonTtyTerminal.approve(approvalRequest()), "reject");
    nonTtyTerminal.close();
  });
});
