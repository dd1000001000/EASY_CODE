import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import type { ImageAttachment } from "../src/core/types.js";
import {
  readPrompt,
  type PromptInputSession,
  VSCODE_IMAGE_PASTE_SEQUENCE,
  vscodeShowThinkingSequence,
  vscodeToggleThinkingSequence,
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
  constructor(public columns = 80) {
    super();
  }
  readonly rows = 24;
}

async function withInteractiveTerm<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.TERM;
  process.env.TERM = "xterm-256color";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TERM;
    else process.env.TERM = previous;
  }
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
  it("keeps one busy editor open for repeated steering text, paste, and images", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const controller = new AbortController();
    const submissions: Array<{ text: string; labels: string[] }> = [];
    const drafts: string[] = [];
    let session: PromptInputSession | undefined;
    let interrupts = 0;
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      signal: controller.signal,
      keepOpen: true,
      clearOnSubmit: true,
      captureImage: async (index) => attachment(index),
      onSubmit: (submission) => {
        submissions.push({
          text: submission.text,
          labels: submission.images.map((image) => image.label),
        });
      },
      onInterrupt: () => {
        interrupts += 1;
      },
      onDraftChange: (draft) => drafts.push(draft.text),
      onSessionReady: (value) => {
        session = value;
      },
    });

    input.write("\u001B[200~first\nsecond\u001B[201~\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write(Buffer.concat([
      Buffer.from("image "),
      Buffer.from([0x16]),
      Buffer.from("\r"),
    ]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("third\r");
    input.write(Buffer.from([0x03]));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(submissions, [
      { text: "first\nsecond", labels: [] },
      { text: "image  [Image #1] ", labels: ["Image #1"] },
      { text: "third", labels: [] },
    ]);
    assert.equal(interrupts, 1);
    assert.equal(session !== undefined, true);
    assert.ok(drafts.includes(""));

    controller.abort();
    assert.equal(await prompt, null);
    assert.equal(session, undefined);
  });

  it("flushes an entered image submission through its durable callback", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const controller = new AbortController();
    let session: PromptInputSession | undefined;
    let releaseCapture!: (value: ImageAttachment) => void;
    const capture = new Promise<ImageAttachment>((resolve) => {
      releaseCapture = resolve;
    });
    let releaseDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const submissions: string[] = [];
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      signal: controller.signal,
      keepOpen: true,
      clearOnSubmit: true,
      captureImage: async () => capture,
      onSubmit: async (submission) => {
        submissions.push(submission.images[0]?.label ?? "missing");
        await delivery;
      },
      onSessionReady: (value) => {
        session = value;
      },
    });

    input.write(Buffer.concat([Buffer.from([0x16]), Buffer.from("\r")]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(session);
    const flushed = session.flushSubmissions();
    let didFlush = false;
    void flushed.then(() => {
      didFlush = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(didFlush, false);

    releaseCapture(attachment(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(submissions, ["Image #1"]);
    assert.equal(didFlush, false);
    releaseDelivery();
    await flushed;
    assert.equal(didFlush, true);

    controller.abort();
    await prompt;
  });

  it("suspends a persistent editor for a modal and discards its leading key-repeat burst", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const controller = new AbortController();
    const submissions: string[] = [];
    let session: PromptInputSession | undefined;
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      signal: controller.signal,
      keepOpen: true,
      clearOnSubmit: true,
      captureImage: async (index) => attachment(index),
      onSubmit: (submission) => {
        submissions.push(submission.text);
      },
      onSessionReady: (value) => {
        session = value;
      },
    });

    input.write("preserved draft");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(session?.suspendInput(), true);
    session?.resumeInput({ discardLeadingModalControls: true });
    input.write("\u001B[B\r\u001B[57353u\u001B[13u");
    input.write(" plus\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(submissions, ["preserved draft plus"]);

    controller.abort();
    await prompt;
  });

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

  it("keeps a bracketed multiline paste intact until an explicit Enter", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    const source = [
      "You are given an array $a_1, a_2, \\ldots, a_n$.",
      "Let $f(l,r)$ be the smallest positive integer.",
      "Determine every possible value.",
    ].join("\n");
    let settled = false;
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
    }).then((result) => {
      settled = true;
      return result;
    });

    input.write(`\u001B[200~${source}\u001B[201~`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.match(transcript, /\[Pasted text #1 · 3 lines\]/u);

    input.write("\r");
    const result = await promise;
    assert.equal(result?.text, source);
    assert.match(transcript, /\u001B\[\?2004h/u);
    assert.match(transcript, /\u001B\[\?2004l/u);
  });

  it("handles fragmented bracketed-paste boundaries and a trailing Enter in order", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
    });
    const pasted = "第一行\r\n\tsecond line\rthird line\n";
    const packet = Buffer.from(`before:\u001B[200~${pasted}\u001B[201~:after\r`);
    const cuts = [2, 9, 15, 20, 23, 31, 38, packet.length];
    let start = 0;
    for (const end of cuts) {
      input.write(packet.subarray(start, end));
      start = end;
    }

    const result = await promise;
    assert.equal(result?.text, "before:第一行\n\tsecond line\nthird line\n:after");
    assert.deepEqual(result?.pasteErrors, []);
  });

  it("expands multiple pasted text blocks without exposing their internal newlines to readline", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
    });

    input.write("A\u001B[200~one\ntwo\u001B[201~B");
    input.write("\u001B[200~three\nfour\u001B[201~C\r");

    assert.equal((await promise)?.text, "Aone\ntwoBthree\nfourC");
  });

  it("does not expand visible pasted-text labels that the user typed themselves", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
    });
    const visibleLabel = " [Pasted text #1 · 2 lines] ";

    input.write(`${visibleLabel}\u001B[200~real\ntext\u001B[201~\r`);

    assert.equal((await promise)?.text, `${visibleLabel}real\ntext`);
  });

  it("rejects an oversized bracketed paste even when both boundaries share one chunk", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
    });
    const oversized = "x".repeat((256 * 1024 * 4) + 65);

    input.write(`\u001B[200~${oversized}\u001B[201~\r`);
    const result = await promise;

    assert.match(result?.text ?? "", /Text paste failed/u);
    assert.deepEqual(result?.pasteErrors, [
      "Pasted text exceeds the 256 KiB input limit.",
    ]);
  });

  it("deletes one intact multiline-paste marker with a single Backspace", async () => {
    await withInteractiveTerm(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const prompt = readPrompt({
        input,
        output,
        prompt: "> ",
        captureImage: async (index) => attachment(index),
      });

      input.write("before");
      input.write("\u001B[200~first line\nsecond line\u001B[201~");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write(Buffer.from([0x7f]));
      input.write("after\r");

      assert.equal((await prompt)?.text, "beforeafter");
    });
  });

  it("submits a partially edited multiline-paste marker as ordinary text", async () => {
    await withInteractiveTerm(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const prompt = readPrompt({
        input,
        output,
        prompt: "> ",
        captureImage: async (index) => attachment(index),
      });

      input.write("\u001B[200~first line\nsecond line\u001B[201~");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write(Buffer.alloc(17, 0x02)); // Move before the visible closing bracket.
      input.write(Buffer.from([0x7f, 0x05, 0x0d]));
      const result = await prompt;

      assert.match(result?.text ?? "", /Pasted text #1 · 2 lines/u);
      assert.equal(result?.text.includes("first line\nsecond line"), false);
      assert.deepEqual(result?.images, []);
    });
  });

  it("deletes an intact image marker with one Backspace and detaches its image", async () => {
    await withInteractiveTerm(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const prompt = readPrompt({
        input,
        output,
        prompt: "> ",
        captureImage: async (index) => attachment(index),
      });

      input.write(Buffer.from([0x16]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write(Buffer.from([0x7f]));
      input.write("plain text\r");
      const result = await prompt;

      assert.equal(result?.text, "plain text");
      assert.deepEqual(result?.images, []);
    });
  });

  it("submits a partially edited image marker as ordinary text without its image", async () => {
    await withInteractiveTerm(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const prompt = readPrompt({
        input,
        output,
        prompt: "> ",
        captureImage: async (index) => attachment(index),
      });

      input.write(Buffer.from([0x16]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write(Buffer.alloc(17, 0x02)); // Move before the visible closing bracket.
      input.write(Buffer.from([0x7f, 0x05, 0x0d]));
      const result = await prompt;

      assert.match(result?.text ?? "", /\[Image #1/u);
      assert.equal(result?.text.includes("[Image #1]"), false);
      assert.deepEqual(result?.images, []);
    });
  });

  it("never binds a manually typed image label to a captured image", async () => {
    await withInteractiveTerm(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const prompt = readPrompt({
        input,
        output,
        prompt: "> ",
        captureImage: async (index) => attachment(index),
      });

      input.write("[Image #1]");
      input.write(Buffer.from([0x16]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write(Buffer.from([0x7f, 0x0d]));
      const result = await prompt;

      assert.equal(result?.text, "[Image #1]");
      assert.deepEqual(result?.images, []);
    });
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

  it("handles a fragmented legacy VS Code Thinking link as a toggle without leaking protocol bytes", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const shown: Array<number | "last"> = [];
    const toggled: number[] = [];
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
      onShowThinking: (id) => {
        shown.push(id);
      },
      onToggleThinking: (id) => {
        toggled.push(id);
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
    assert.deepEqual(shown, []);
    assert.deepEqual(toggled, [42]);
  });

  it("keeps Ctrl+T expansion separate from new and legacy mouse toggles", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const shown: Array<number | "last"> = [];
    const toggled: number[] = [];
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
      onShowThinking: (id) => {
        shown.push(id);
      },
      onToggleThinking: (id) => {
        toggled.push(id);
      },
    });

    input.write("draft");
    input.write(Buffer.from([0x14]));
    input.write(vscodeToggleThinkingSequence(7));
    input.write(vscodeShowThinkingSequence(8));
    input.write("!\r");
    const result = await promise;

    assert.equal(result?.text, "draft!");
    assert.deepEqual(shown, ["last"]);
    assert.deepEqual(toggled, [7, 8]);
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

  it("writes stable output above typed input without changing its submission", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    let activeSession: PromptInputSession | undefined;
    const lifecycle: Array<PromptInputSession | undefined> = [];
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
      onSessionReady: (session) => {
        activeSession = session;
        lifecycle.push(session);
      },
    });

    assert.ok(activeSession);
    input.write("draft");
    await new Promise<void>((resolve) => setImmediate(resolve));
    activeSession.writeAbove("stable update");

    const afterUpdate = transcript.slice(transcript.indexOf("stable update"));
    assert.match(afterUpdate, /^stable update\n> draft/u);
    input.write("!\r");
    const result = await promise;

    assert.equal(result?.text, "draft!");
    assert.equal(activeSession, undefined);
    assert.equal(lifecycle.length, 2);
    assert.ok(lifecycle[0]);
    assert.equal(lifecycle[1], undefined);
    assert.equal(input.rawModeTransitions.at(-1), false);
  });

  it("keeps live rows below wrapped input through writes, resize, and image paste", async () => {
    const input = new TtyInput();
    const output = new TtyOutput(12);
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    let activeSession: PromptInputSession | undefined;
    let footerVersion = 1;
    let renderCount = 0;
    const promise = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
      renderBelow: () => {
        renderCount += 1;
        return `╰──────────╯\nfooter ${footerVersion}`;
      },
      onSessionReady: (session) => {
        activeSession = session;
      },
    });

    assert.ok(activeSession);
    assert.match(transcript, /╰──────────╯\r\nfooter 1/u);
    input.write("abcdefghijklmno");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(renderCount > 1);

    activeSession.writeAbove("stable notice");
    const afterNotice = transcript.slice(transcript.indexOf("stable notice"));
    assert.match(afterNotice, /stable notice\n> abcdefghijklmno/u);
    assert.match(afterNotice, /footer 1/u);

    footerVersion = 2;
    output.columns = 16;
    output.emit("resize");
    assert.match(transcript, /footer 2/u);
    footerVersion = 3;
    activeSession.refreshBelow();
    assert.match(transcript, /footer 3/u);

    input.write(Buffer.from([0x16, 0x0d]));
    const result = await promise;
    assert.match(result?.text ?? "", /^abcdefghijklmno \[Image #1\] /u);
    assert.deepEqual(result?.images.map((image) => image.label), ["Image #1"]);
    assert.equal(activeSession, undefined);
    assert.equal(input.rawModeTransitions.at(-1), false);

    const lastFooter = transcript.lastIndexOf("footer 3");
    assert.ok(lastFooter >= 0);
    assert.match(transcript.slice(lastFooter), /\u001B\[0J/u);
  });

  it("redraws dynamic Thinking content above Request without losing the draft", async () => {
    const input = new TtyInput();
    const output = new TtyOutput(80);
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    let expanded = false;
    const request = "╭─ Request ─╮\n│ > ";
    const prompt = readPrompt({
      input,
      output,
      prompt: request,
      renderPrompt: () => expanded
        ? `╭─ Thinking #1 ─╮\nreasoning body\n╰────────────────╯\n${request}`
        : request,
      renderBelow: () => "╰─ Request ─╯\nfooter",
      captureImage: async (index) => attachment(index),
      onToggleThinking: (id) => {
        assert.equal(id, 1);
        expanded = !expanded;
      },
    });

    input.write("draft");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const openOffset = transcript.length;
    input.write(vscodeToggleThinkingSequence(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const openFrame = transcript.slice(openOffset);
    assert.ok(openFrame.indexOf("reasoning body") >= 0);
    assert.ok(openFrame.indexOf("reasoning body") < openFrame.indexOf("╭─ Request"));
    assert.match(openFrame, /╭─ Request ─╮\n│ > draft/u);

    const closeOffset = transcript.length;
    input.write(vscodeToggleThinkingSequence(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closeFrame = transcript.slice(closeOffset);
    assert.equal(closeFrame.includes("reasoning body"), false);
    assert.match(closeFrame, /╭─ Request ─╮\n│ > draft/u);

    input.write("!\r");
    assert.equal((await prompt)?.text, "draft!");
  });

  it("defers a resize redraw while an asynchronous Thinking toggle owns the prompt", async () => {
    const input = new TtyInput();
    const output = new TtyOutput(80);
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    let expanded = false;
    let renderCalls = 0;
    let toggleStarted!: () => void;
    let releaseToggle!: () => void;
    const started = new Promise<void>((resolve) => {
      toggleStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseToggle = resolve;
    });
    const request = "╭─ Request ─╮\n│ > ";
    const prompt = readPrompt({
      input,
      output,
      prompt: request,
      renderPrompt: () => {
        renderCalls += 1;
        return expanded ? `THINKING\n${request}` : request;
      },
      renderBelow: () => "╰─ Request ─╯\nfooter",
      captureImage: async (index) => attachment(index),
      onToggleThinking: async () => {
        expanded = true;
        toggleStarted();
        await release;
      },
    });

    input.write("draft");
    input.write(vscodeToggleThinkingSequence(1));
    await started;
    const callsBeforeResize = renderCalls;
    const resizeOffset = transcript.length;
    output.columns = 48;
    output.emit("resize");
    assert.equal(renderCalls, callsBeforeResize);
    assert.match(transcript.slice(resizeOffset), /\u001B\[0J/u);
    const secondResizeOffset = transcript.length;
    output.columns = 64;
    output.emit("resize");
    assert.equal(renderCalls, callsBeforeResize);
    assert.match(transcript.slice(secondResizeOffset), /\u001B\[0J/u);

    const resumeOffset = transcript.length;
    releaseToggle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const resumeFrame = transcript.slice(resumeOffset);
    assert.equal((resumeFrame.match(/THINKING/gu) ?? []).length, 1);
    assert.equal((resumeFrame.match(/╭─ Request/gu) ?? []).length, 1);
    assert.ok(resumeFrame.indexOf("THINKING") < resumeFrame.indexOf("╭─ Request"));
    assert.match(resumeFrame, /│ > draft/u);

    input.write("!\r");
    assert.equal((await prompt)?.text, "draft!");
  });

  it("clears live rows below the prompt when Ctrl+C cancels input", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    let activeSession: PromptInputSession | undefined;
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
      renderBelow: () => "bottom border\nactive footer",
      onSessionReady: (session) => {
        activeSession = session;
      },
    });

    assert.ok(activeSession);
    assert.match(transcript, /active footer/u);
    input.write(Buffer.from([0x03]));

    assert.equal(await prompt, null);
    assert.equal(activeSession, undefined);
    assert.equal(input.isRaw, false);
    assert.match(transcript.slice(transcript.indexOf("active footer")), /\u001B\[0J/u);
    assert.match(transcript, /\u001B\[\?2004h/u);
    assert.match(transcript, /\u001B\[\?2004l/u);
  });

  it("swallows private Thinking OSC during approval and secret input", async () => {
    const approvalInput = new TtyInput();
    const approvalOutput = new TtyOutput();
    approvalOutput.resume();
    const approvalTerminal = new Terminal(approvalInput, approvalOutput);
    const approval = approvalTerminal.question("Approve? ");
    approvalInput.write(`${vscodeToggleThinkingSequence(7)}y\r`);
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

  it("accepts more typing while an asynchronous image paste is still being captured", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    let markCaptureStarted: (() => void) | undefined;
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    let finishCapture: ((image: ImageAttachment) => void) | undefined;
    const captureFinished = new Promise<ImageAttachment>((resolve) => {
      finishCapture = resolve;
    });
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async () => {
        markCaptureStarted?.();
        return captureFinished;
      },
    });

    input.write("before:");
    input.write(Buffer.from([0x16]));
    await captureStarted;
    input.write(":after\r");
    finishCapture?.(attachment(1));

    const result = await prompt;
    assert.equal(result?.text, "before: [Image #1] :after");
    assert.deepEqual(result?.images.map((image) => image.label), ["Image #1"]);
    assert.deepEqual(result?.pasteErrors, []);
  });

  it("keeps a second image paste and ordinary typing live while captures settle serially", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    let startFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve;
    });
    let startSecond: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      startSecond = resolve;
    });
    let finishFirst: ((image: ImageAttachment) => void) | undefined;
    const firstFinished = new Promise<ImageAttachment>((resolve) => {
      finishFirst = resolve;
    });
    let finishSecond: ((image: ImageAttachment) => void) | undefined;
    const secondFinished = new Promise<ImageAttachment>((resolve) => {
      finishSecond = resolve;
    });
    let captureCount = 0;
    let settled = false;
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async () => {
        captureCount += 1;
        if (captureCount === 1) {
          startFirst?.();
          return firstFinished;
        }
        startSecond?.();
        return secondFinished;
      },
    }).then((result) => {
      settled = true;
      return result;
    });

    input.write(VSCODE_IMAGE_PASTE_SEQUENCE);
    await firstStarted;
    input.write(VSCODE_IMAGE_PASTE_SEQUENCE);
    input.write("typed while pending");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(captureCount, 1, "native clipboard reads must remain serialized");
    assert.match(transcript, /Pasting clipboard #2/u);
    assert.match(transcript, /typed while pending/u);

    input.write("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "Enter must wait for every pending capture");

    finishFirst?.(attachment(1));
    await secondStarted;
    finishSecond?.(attachment(2));
    const result = await prompt;

    assert.match(result?.text ?? "", /\[Image #1\].*\[Image #2\].*typed while pending/u);
    assert.deepEqual(result?.images.map((image) => image.label), ["Image #1", "Image #2"]);
  });

  it("accepts a multiline paste and typing while an earlier image capture is pending", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    let markCaptureStarted: (() => void) | undefined;
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    let finishCapture: ((image: ImageAttachment) => void) | undefined;
    const captureFinished = new Promise<ImageAttachment>((resolve) => {
      finishCapture = resolve;
    });
    let settled = false;
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async () => {
        markCaptureStarted?.();
        return captureFinished;
      },
    }).then((result) => {
      settled = true;
      return result;
    });

    input.write(VSCODE_IMAGE_PASTE_SEQUENCE);
    await captureStarted;
    input.write("\u001B[200~first line\nsecond line\u001B[201~");
    input.write("tail");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.match(transcript, /Pasted text #1 · 2 lines/u);
    assert.match(transcript, /tail/u);
    input.write("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    finishCapture?.(attachment(1));
    const result = await prompt;
    assert.match(result?.text ?? "", /\[Image #1\].*first line\nsecond linetail/u);
    assert.deepEqual(result?.images.map((image) => image.label), ["Image #1"]);
  });

  it("accepts another paste after a pending clipboard capture times out", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    let captureCount = 0;
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => {
        captureCount += 1;
        if (captureCount === 1) {
          return new Promise<ImageAttachment>(() => undefined);
        }
        return attachment(index);
      },
      clipboardCaptureTimeoutMs: 20,
    });

    input.write(VSCODE_IMAGE_PASTE_SEQUENCE);
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    input.write(VSCODE_IMAGE_PASTE_SEQUENCE);
    input.write("after timeout\r");

    const result = await prompt;
    assert.equal(captureCount, 2);
    assert.match(result?.text ?? "", /\[Image paste failed\].*\[Image #1\].*after timeout/u);
    assert.deepEqual(result?.images.map((image) => image.label), ["Image #1"]);
    assert.deepEqual(result?.pasteErrors, [
      "Clipboard image capture timed out after 20ms.",
    ]);
  });

  it("does not reattach a pending image marker deleted before capture finishes", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    let markCaptureStarted: (() => void) | undefined;
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    let finishCapture: ((image: ImageAttachment) => void) | undefined;
    const captureFinished = new Promise<ImageAttachment>((resolve) => {
      finishCapture = resolve;
    });
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async () => {
        markCaptureStarted?.();
        return captureFinished;
      },
    });

    input.write(VSCODE_IMAGE_PASTE_SEQUENCE);
    await captureStarted;
    input.write(Buffer.from([0x7f]));
    input.write("plain text\r");
    finishCapture?.(attachment(1));

    const result = await prompt;
    assert.equal(result?.text, "plain text");
    assert.deepEqual(result?.images, []);
  });

  it("keeps a partially edited pending image marker as ordinary text", async () => {
    await withInteractiveTerm(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      let markCaptureStarted: (() => void) | undefined;
      const captureStarted = new Promise<void>((resolve) => {
        markCaptureStarted = resolve;
      });
      let finishCapture: ((image: ImageAttachment) => void) | undefined;
      const captureFinished = new Promise<ImageAttachment>((resolve) => {
        finishCapture = resolve;
      });
      const prompt = readPrompt({
        input,
        output,
        prompt: "> ",
        captureImage: async () => {
          markCaptureStarted?.();
          return captureFinished;
        },
      });

      input.write(VSCODE_IMAGE_PASTE_SEQUENCE);
      await captureStarted;
      input.write(Buffer.from([0x01, 0x06, 0x06, 0x06, 0x06, 0x06]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write(Buffer.from([0x7f]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write(Buffer.from([0x05, 0x0d]));
      finishCapture?.(attachment(1));

      const result = await prompt;
      assert.match(result?.text ?? "", /Pating clipboard #1/u);
      assert.equal(result?.text.includes("[Image #1]"), false);
      assert.deepEqual(result?.images, []);
    });
  });

  it("accepts more typing while asynchronous clipboard text fallback is still being captured", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    let markTextCaptureStarted: (() => void) | undefined;
    const textCaptureStarted = new Promise<void>((resolve) => {
      markTextCaptureStarted = resolve;
    });
    let finishTextCapture: ((text: string) => void) | undefined;
    const textCaptureFinished = new Promise<string>((resolve) => {
      finishTextCapture = resolve;
    });
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async () => {
        throw new Error("clipboard does not contain an image");
      },
      captureText: async () => {
        markTextCaptureStarted?.();
        return textCaptureFinished;
      },
    });

    input.write("before:");
    input.write(Buffer.from([0x16]));
    await textCaptureStarted;
    input.write(":after\r");
    finishTextCapture?.("A\nB");

    const result = await prompt;
    assert.equal(result?.text, "before:A\nB:after");
    assert.deepEqual(result?.images, []);
    assert.deepEqual(result?.pasteErrors, []);
  });

  it("keeps the Request editor live while a second image paste is still loading", async () => {
    await withInteractiveTerm(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.setEncoding("utf8");
      let transcript = "";
      output.on("data", (chunk: string) => {
        transcript += chunk;
      });
      output.resume();

      let markSecondStarted!: () => void;
      const secondStarted = new Promise<void>((resolve) => {
        markSecondStarted = resolve;
      });
      let finishSecond!: (image: ImageAttachment) => void;
      const secondFinished = new Promise<ImageAttachment>((resolve) => {
        finishSecond = resolve;
      });
      let settled = false;
      const prompt = readPrompt({
        input,
        output,
        prompt: "> ",
        captureImage: async (index) => {
          if (index === 1) return attachment(index);
          markSecondStarted();
          return secondFinished;
        },
      }).then((result) => {
        settled = true;
        return result;
      });

      input.write(Buffer.from([0x16]));
      input.write(Buffer.from([0x16]));
      await secondStarted;
      const liveOffset = transcript.length;
      input.write("tail");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.match(transcript.slice(liveOffset), /tail/u);
      input.write("\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);

      finishSecond(attachment(2));
      const result = await prompt;
      assert.equal(result?.text, " [Image #1]  [Image #2] tail");
      assert.deepEqual(result?.images.map((image) => image.label), [
        "Image #1",
        "Image #2",
      ]);
      assert.deepEqual(result?.pasteErrors, []);
    });
  });

  it("accepts multiline text and typing while an earlier image paste is pending", async () => {
    await withInteractiveTerm(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.setEncoding("utf8");
      let transcript = "";
      output.on("data", (chunk: string) => {
        transcript += chunk;
      });
      output.resume();

      let markCaptureStarted!: () => void;
      const captureStarted = new Promise<void>((resolve) => {
        markCaptureStarted = resolve;
      });
      let finishCapture!: (image: ImageAttachment) => void;
      const captureFinished = new Promise<ImageAttachment>((resolve) => {
        finishCapture = resolve;
      });
      let settled = false;
      const prompt = readPrompt({
        input,
        output,
        prompt: "> ",
        captureImage: async () => {
          markCaptureStarted();
          return captureFinished;
        },
      }).then((result) => {
        settled = true;
        return result;
      });

      input.write(Buffer.from([0x16]));
      await captureStarted;
      const liveOffset = transcript.length;
      input.write("\u001B[200~A\nB\u001B[201~tail");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.match(transcript.slice(liveOffset), /Pasted text #1/u);
      assert.match(transcript.slice(liveOffset), /tail/u);
      input.write("\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);

      finishCapture(attachment(1));
      const result = await prompt;
      assert.equal(result?.text, " [Image #1] A\nBtail");
      assert.deepEqual(result?.images.map((image) => image.label), ["Image #1"]);
      assert.deepEqual(result?.pasteErrors, []);
    });
  });

  it("keeps a second clipboard text fallback responsive and ordered", async () => {
    await withInteractiveTerm(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.setEncoding("utf8");
      let transcript = "";
      output.on("data", (chunk: string) => {
        transcript += chunk;
      });
      output.resume();

      let textCaptureCount = 0;
      let markSecondStarted!: () => void;
      const secondStarted = new Promise<void>((resolve) => {
        markSecondStarted = resolve;
      });
      let finishSecond!: (value: string) => void;
      const secondFinished = new Promise<string>((resolve) => {
        finishSecond = resolve;
      });
      let settled = false;
      const prompt = readPrompt({
        input,
        output,
        prompt: "> ",
        captureImage: async () => {
          throw new Error("clipboard does not contain an image");
        },
        captureText: async () => {
          textCaptureCount += 1;
          if (textCaptureCount === 1) return "A\nB";
          markSecondStarted();
          return secondFinished;
        },
      }).then((result) => {
        settled = true;
        return result;
      });

      input.write(Buffer.from([0x16]));
      input.write(Buffer.from([0x16]));
      await secondStarted;
      const liveOffset = transcript.length;
      input.write("tail\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.match(transcript.slice(liveOffset), /tail/u);
      assert.equal(settled, false);
      finishSecond("C\nD");

      const result = await prompt;
      assert.equal(result?.text, "A\nBC\nDtail");
      assert.deepEqual(result?.images, []);
      assert.deepEqual(result?.pasteErrors, []);
    });
  });

  it("releases queued input when clipboard capture never settles", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async () => new Promise<ImageAttachment>(() => undefined),
      clipboardCaptureTimeoutMs: 20,
    });

    input.write("before:");
    input.write(Buffer.from([0x16]));
    input.write(":after\r");

    const result = await prompt;
    assert.match(result?.text ?? "", /^before: \[Image paste failed\] :after$/u);
    assert.deepEqual(result?.images, []);
    assert.deepEqual(result?.pasteErrors, [
      "Clipboard image capture timed out after 20ms.",
    ]);
  });

  it("allows another paste after a prior clipboard capture times out", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    let captureCount = 0;
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => {
        captureCount += 1;
        if (captureCount === 2) {
          return new Promise<ImageAttachment>(() => undefined);
        }
        return attachment(index);
      },
      clipboardCaptureTimeoutMs: 20,
    });

    input.write(Buffer.from([0x16]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write(Buffer.from([0x16]));
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    input.write(Buffer.from([0x16]));
    input.write("tail\r");

    const result = await prompt;
    assert.equal(captureCount, 3);
    assert.match(
      result?.text ?? "",
      /\[Image #1\].*\[Image paste failed\].*\[Image #2\].*tail/u,
    );
    assert.deepEqual(result?.images.map((image) => image.label), [
      "Image #1",
      "Image #2",
    ]);
    assert.deepEqual(result?.pasteErrors, [
      "Clipboard image capture timed out after 20ms.",
    ]);
  });

  it("recovers when a terminal omits the bracketed-paste closing marker", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.resume();
    const prompt = readPrompt({
      input,
      output,
      prompt: "> ",
      captureImage: async (index) => attachment(index),
      bracketedPasteIdleTimeoutMs: 20,
    });

    input.write("before:\u001B[200~A\nB");
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    input.write(":after\r");

    const result = await prompt;
    assert.match(result?.text ?? "", /^before: \[Text paste failed\] :after$/u);
    assert.deepEqual(result?.pasteErrors, [
      "Pasted text was incomplete because the terminal did not send its closing marker.",
    ]);
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

    assert.equal(result?.text, "const value = 1;\nconsole.log(value);");
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
