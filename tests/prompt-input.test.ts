import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import type { ImageAttachment } from "../src/core/types.js";
import {
  readPrompt,
  VSCODE_IMAGE_PASTE_SEQUENCE,
  vscodeShowThinkingSequence,
} from "../src/cli/prompt-input.js";
import { Terminal } from "../src/cli/terminal.js";
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
  constructor(readonly columns = 80) {
    super();
  }
  readonly rows = 24;
}

function attachment(index: number): ImageAttachment {
  const id = `image_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    label: `Image #${index}`,
    mediaType: "image/png",
    storageKey: `attachments/00000000000000000000000000000000/${id}.png`,
    sha256: String(index % 10).repeat(64),
    byteSize: 68,
    width: 1,
    height: 1,
  };
}

async function submitWithSequence(
  sequence: Buffer | string,
  initialImageCount = 0,
): Promise<{
  text: string;
  labels: string[];
  transitions: boolean[];
}> {
  const input = new TtyInput();
  const output = new TtyOutput();
  output.resume();
  const promise = readPrompt({
    input,
    output,
    prompt: "EASY CODE > ",
    initialImageCount,
    captureImage: async (index) => attachment(index),
  });
  input.write(Buffer.concat([
    Buffer.from("inspect"),
    Buffer.isBuffer(sequence) ? sequence : Buffer.from(sequence),
    Buffer.from("\r"),
  ]));
  const result = await promise;
  assert.ok(result);
  return {
    text: result.text,
    labels: result.images.map((image) => image.label),
    transitions: input.rawModeTransitions,
  };
}

describe("image-aware CLI prompt", () => {
  it("recognizes Windows Ctrl+V and numbers after queued images", async () => {
    const result = await submitWithSequence(Buffer.from([0x16]), 1);
    assert.match(result.text, /inspect \[Image #2\]/u);
    assert.deepEqual(result.labels, ["Image #2"]);
    assert.equal(result.transitions[0], true);
    assert.equal(result.transitions.at(-1), false);
  });

  it("recognizes Linux Ctrl+Shift+V and macOS Command+V enhanced key sequences", async () => {
    const linux = await submitWithSequence("\u001B[118;6u");
    const mac = await submitWithSequence("\u001B[118;9u");
    assert.match(linux.text, /\[Image #1\]/u);
    assert.match(mac.text, /\[Image #1\]/u);
    assert.deepEqual(linux.labels, ["Image #1"]);
    assert.deepEqual(mac.labels, ["Image #1"]);
  });

  it("recognizes the private VS Code image-paste sequence", async () => {
    const result = await submitWithSequence(VSCODE_IMAGE_PASTE_SEQUENCE);
    assert.match(result.text, /inspect \[Image #1\]/u);
    assert.deepEqual(result.labels, ["Image #1"]);
  });

  it("recognizes a fragmented private VS Code image-paste sequence", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
    });
    const sequence = Buffer.from(VSCODE_IMAGE_PASTE_SEQUENCE);
    input.write(sequence.subarray(0, 7));
    input.write(sequence.subarray(7));
    input.write("\r");
    const result = await promise;
    assert.ok(result);
    assert.match(result.text, /\[Image #1\]/u);
    assert.deepEqual(result.images.map((image) => image.label), ["Image #1"]);
  });

  it("uses Ctrl+T to show the latest thinking without changing typed input", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    const shown: Array<number | "last"> = [];
    let markExpanded: (() => void) | undefined;
    const expanded = new Promise<void>((resolve) => {
      markExpanded = resolve;
    });
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
      onShowThinking: (id) => {
        shown.push(id);
        output.write("expanded thinking\n");
        markExpanded?.();
      },
    });

    input.write(Buffer.from("draft"));
    input.write(Buffer.from([0x14]));
    await expanded;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const afterExpansion = transcript.slice(transcript.indexOf("expanded thinking"));
    assert.match(afterExpansion, /> draft/u);
    input.write(Buffer.from("!\r"));
    const result = await promise;

    assert.equal(result?.text, "draft!");
    assert.deepEqual(shown, ["last"]);
    assert.equal(input.rawModeTransitions.at(-1), false);
  });

  it("handles a fragmented VS Code thinking link without leaking protocol bytes", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const shown: Array<number | "last"> = [];
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
      onShowThinking: (id) => {
        shown.push(id);
      },
    });
    const sequence = Buffer.from(vscodeShowThinkingSequence(42));

    input.write("keep");
    input.write(sequence.subarray(0, 9));
    input.write(sequence.subarray(9, 24));
    input.write(sequence.subarray(24));
    input.write(" me\r");
    const result = await promise;

    assert.equal(result?.text, "keep me");
    assert.deepEqual(shown, [42]);
  });

  it("redraws a wrapped input buffer after expansion", async () => {
    const input = new TtyInput();
    const output = new TtyOutput(10);
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    let markExpanded: (() => void) | undefined;
    const expanded = new Promise<void>((resolve) => {
      markExpanded = resolve;
    });
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
      onShowThinking: () => {
        output.write("wrapped expansion\n");
        markExpanded?.();
      },
    });

    input.write("abcdefghijk");
    input.write(Buffer.from([0x14]));
    await expanded;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(transcript, /wrapped expansion\n> abcdefghijk/u);
    input.write("X\r");

    assert.equal((await promise)?.text, "abcdefghijkX");
  });

  it("swallows private Thinking OSC during approval and secret input", async () => {
    const approvalInput = new TtyInput();
    const approvalOutput = new TtyOutput();
    approvalOutput.resume();
    const approvalTerminal = new Terminal(approvalInput, approvalOutput);
    const approval = approvalTerminal.question("Approve? ");
    approvalInput.write(`${vscodeShowThinkingSequence(7)}y\r`);
    assert.equal(await approval, "y");
    approvalTerminal.close();

    const secretInput = new TtyInput();
    const secretOutput = new TtyOutput();
    secretOutput.resume();
    const secretTerminal = new Terminal(secretInput, secretOutput);
    const secret = secretTerminal.readSecret("Key: ");
    secretInput.write(`${vscodeShowThinkingSequence(8)}actual-secret\r`);
    assert.equal(await secret, "actual-secret");
    assert.equal(secretInput.rawModeTransitions.at(-1), false);
    secretTerminal.close();
  });

  it("does not render interactive Thinking UI when either stream is not a TTY", () => {
    const input = new TtyInput();
    const output = new PassThrough();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    const terminal = new Terminal(input, output);

    assert.equal(terminal.isInteractive(), false);
    assert.equal(terminal.addReasoning("must remain hidden"), 1);
    assert.equal(terminal.showReasoning("last"), false);
    assert.equal(transcript, "");
    terminal.close();
  });

  it("does not treat Alt+V as an image paste shortcut", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    let captureCount = 0;
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => {
        captureCount += 1;
        return attachment(index);
      },
    });
    input.write(Buffer.from("\u001Bv\r"));
    const result = await promise;
    assert.ok(result);
    assert.equal(captureCount, 0);
    assert.deepEqual(result.images, []);
  });

  it("waits for an asynchronous clipboard read before accepting Enter", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    let captured = false;
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        captured = true;
        return attachment(index);
      },
    });
    input.write(Buffer.from([0x16, 0x0d]));
    const result = await promise;
    assert.equal(captured, true);
    assert.equal(result?.images.length, 1);
    assert.match(result?.text ?? "", /\[Image #1\]/u);
  });

  it("reports clipboard failures without attaching a phantom image", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async () => {
        throw new Error("clipboard has text only");
      },
    });
    input.write(Buffer.from([0x16, 0x0d]));
    const result = await promise;
    assert.deepEqual(result?.images, []);
    assert.deepEqual(result?.pasteErrors, ["clipboard has text only"]);
    assert.match(result?.text ?? "", /Image paste failed/u);
  });

  it("falls back to ordinary clipboard text instead of showing an image error", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async () => {
        throw new Error("clipboard has text only");
      },
      captureText: async () => "const value = 1;\r\nconsole.log(value);",
    });
    input.write(Buffer.from([0x16, 0x0d]));

    const result = await promise;

    assert.equal(result?.text, "const value = 1; console.log(value);");
    assert.deepEqual(result?.images, []);
    assert.deepEqual(result?.pasteErrors, []);
  });

  it("keeps the image error when clipboard text cannot be read", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async () => {
        throw new Error("clipboard image is unavailable");
      },
      captureText: async () => {
        throw new Error("text helper is unavailable");
      },
    });
    input.write(Buffer.from([0x16, 0x0d]));

    const result = await promise;

    assert.deepEqual(result?.pasteErrors, ["clipboard image is unavailable"]);
    assert.match(result?.text ?? "", /Image paste failed/u);
  });

  it("keeps text-only prompts usable after Image #99", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    let captureCount = 0;
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      initialImageCount: 99,
      captureImage: async (index) => {
        captureCount += 1;
        return attachment(index);
      },
    });

    input.write("continue with text\r");
    const result = await prompt;

    assert.equal(result?.text, "continue with text");
    assert.equal(captureCount, 0);
    assert.deepEqual(result?.images, []);
  });

  it("lets Terminal.close cancel an active clipboard capture and restore raw mode", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const terminal = new Terminal(input, output);
    let markCaptureStarted: (() => void) | undefined;
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    const neverFinishes = new Promise<ImageAttachment>(() => undefined);
    const prompt = terminal.readPrompt("> ", {
      captureImage: async () => {
        markCaptureStarted?.();
        return neverFinishes;
      },
    });

    input.write(Buffer.from([0x16]));
    await captureStarted;
    terminal.close();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      prompt,
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), 100);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    assert.notEqual(result, "timeout");
    assert.equal(result, null);
    assert.equal(input.isRaw, false);
    assert.equal(input.rawModeTransitions.at(-1), false);
  });

  it("lets Ctrl+C promptly cancel an in-flight clipboard capture", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    let markCaptureStarted: (() => void) | undefined;
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    let captureAborted = false;
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (_index, signal) => new Promise<ImageAttachment>((_resolve, reject) => {
        markCaptureStarted?.();
        signal?.addEventListener("abort", () => {
          captureAborted = true;
          reject(new Error("clipboard capture canceled"));
        }, { once: true });
      }),
    });

    input.write(Buffer.from([0x16]));
    await captureStarted;
    input.write(Buffer.from([0x03]));

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      prompt,
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), 100);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    assert.notEqual(result, "timeout");
    assert.equal(result, null);
    assert.equal(captureAborted, true);
    assert.equal(input.isRaw, false);
    assert.equal(input.rawModeTransitions.at(-1), false);
  });
});
