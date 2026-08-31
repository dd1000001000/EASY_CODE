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
  readonly rawModeAtPipe: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModeTransitions.push(mode);
    return this;
  }

  override pipe<T extends NodeJS.WritableStream>(
    destination: T,
    options?: { end?: boolean },
  ): T {
    this.rawModeAtPipe.push(this.isRaw);
    return super.pipe(destination, options);
  }
}

class TtyOutput extends PassThrough {
  readonly isTTY = true;
  rows = 24;
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

  it("accepts CSI-u arrows and Enter from enhanced terminal keyboards", async () => {
    const prefixInput = new TtyInput();
    const prefixOutput = new TtyOutput();
    const prefix = selectApproval("python", {
      input: prefixInput,
      output: prefixOutput,
      color: false,
    });
    prefixInput.write("\u001B[57353u\u001B[13u");
    assert.equal(await prefix, "allow_prefix");

    const rejectInput = new TtyInput();
    const rejectOutput = new TtyOutput();
    const reject = selectApproval("python", {
      input: rejectInput,
      output: rejectOutput,
      color: false,
    });
    rejectInput.write("\u001B[");
    rejectInput.write("57352;1:3u"); // A release event must not move.
    rejectInput.write("\u001B[57352;1:1u");
    rejectInput.write("\u001B[13;1:1u");
    assert.equal(await reject, "reject");
  });

  it("ignores enhanced-key releases and malformed confirmation sequences", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const decision = selectApproval("python", {
      input,
      output,
      color: false,
    });

    input.write("\u001B[1;1:3B"); // Kitty Down release: ignore.
    input.write("\u001B[13;;;;u"); // Malformed CSI-u Enter: ignore.
    input.write("\u001B[13;1:3u"); // CSI-u Enter release: ignore.
    input.write("\u001B[27;13~"); // Malformed modifyOtherKeys: ignore.
    input.write("\u001B[1;1:1B"); // Down press.
    input.write("\u001B[13u");

    assert.equal(await decision, "allow_prefix");
  });

  it("supports enhanced keypad Enter and Esc cancellation", async () => {
    const enterInput = new TtyInput();
    const enter = selectApproval("python", {
      input: enterInput,
      output: new TtyOutput(),
      color: false,
    });
    enterInput.write("\u001B[57414u");
    assert.equal(await enter, "allow_once");

    const escapeInput = new TtyInput();
    const escape = selectApproval("python", {
      input: escapeInput,
      output: new TtyOutput(),
      color: false,
    });
    escapeInput.write("\u001B[27u");
    assert.equal(await escape, "reject");
  });

  it("accepts strict CSI-u associated text and rejects unsafe modifiers", async () => {
    const textInput = new TtyInput();
    const textSelection = selectApproval("python", {
      input: textInput,
      output: new TtyOutput(),
      color: false,
    });
    textInput.write("\u001B[13;1:1;13u");
    assert.equal(await textSelection, "allow_once");

    const unsafeInput = new TtyInput();
    const unsafeSelection = selectApproval("python", {
      input: unsafeInput,
      output: new TtyOutput(),
      color: false,
    });
    unsafeInput.write("\u001B[27;999999999999999999999;13~");
    unsafeInput.write("\u001B[B\r");
    assert.equal(await unsafeSelection, "allow_prefix");
  });

  it("accepts keypad and modifyOtherKeys Enter encodings", async () => {
    const keypadInput = new TtyInput();
    const keypadOutput = new TtyOutput();
    const keypad = selectApproval("python", {
      input: keypadInput,
      output: keypadOutput,
      color: false,
    });
    keypadInput.write("\u001BOM");
    assert.equal(await keypad, "allow_once");

    const modifiedInput = new TtyInput();
    const modifiedOutput = new TtyOutput();
    const modified = selectApproval("python", {
      input: modifiedInput,
      output: modifiedOutput,
      color: false,
    });
    modifiedInput.write("\u001B[27;2;13~");
    assert.equal(await modified, "allow_once");
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

  it("preserves an already-raw owner and cleans up when overlay redraw fails", async () => {
    const rawInput = new TtyInput();
    rawInput.isRaw = true;
    const rawSelection = selectApproval("python", {
      input: rawInput,
      output: new TtyOutput(),
      color: false,
    });
    rawInput.write("\r");
    assert.equal(await rawSelection, "allow_once");
    assert.equal(rawInput.isRaw, true);
    // Even an already-raw stream is reasserted to repair Windows ConPTY's
    // occasional OS-mode drift after a focus/input-owner transition.
    assert.deepEqual(rawInput.rawModeTransitions, [true]);

    const failingInput = new TtyInput();
    let renders = 0;
    let cleared = false;
    const failingSelection = selectApproval("python", {
      input: failingInput,
      output: new TtyOutput(),
      color: false,
      overlay: {
        render: () => {
          renders += 1;
          if (renders > 1) throw new Error("terminal disappeared");
        },
        clear: () => {
          cleared = true;
        },
      },
    });
    failingInput.write("\u001B[B");
    await assert.rejects(failingSelection, /Unable to process/u);
    assert.equal(failingInput.isRaw, false);
    assert.equal(failingInput.readableFlowing, false);
    assert.equal(cleared, true);
  });

  it("fails closed if the terminal is too short to review an approval", async () => {
    const output = new TtyOutput();
    const input = new TtyInput();
    const selection = selectApproval("python", {
      input,
      output,
      color: false,
    });
    output.rows = 3;
    input.write("\r");

    assert.equal(await selection, "reject");
  });

  it("Terminal.approve uses the selector and fails closed without a TTY", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    const terminal = new Terminal(input, output);
    const approval = terminal.approve(approvalRequest());
    input.write("\u001B[B\r");
    assert.equal(await approval, "allow_prefix");
    assert.deepEqual(input.rawModeAtPipe, [true]);
    terminal.close();

    const nonTtyOutput = new PassThrough();
    nonTtyOutput.resume();
    const nonTtyTerminal = new Terminal(new PassThrough(), nonTtyOutput);
    assert.equal(await nonTtyTerminal.approve(approvalRequest()), "reject");
    nonTtyTerminal.close();
  });
});
