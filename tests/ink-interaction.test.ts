import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import type { ApprovalRequest, ImageAttachment } from "../src/core/types.js";
import type { UISessionInfo } from "../src/ui/contracts.js";
import { InkInteraction } from "../src/ui/ink/ink-interaction.js";
import { stripAnsi } from "../src/ui/render/layout.js";
import { describe, it } from "./harness.js";

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }

  /** Ink reads keystrokes through its own stdin reader; these are no-ops on a test stream. */
  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

class TtyOutput extends PassThrough {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
}

const wait = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function session(overrides: Partial<UISessionInfo> = {}): UISessionInfo {
  return {
    threadId: "thread_ink_ui",
    workspaceRoot: "F:\\projects\\course-system",
    mode: "auto",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    thinkingEffort: "medium",
    contextTokens: 82_400,
    ...overrides,
  };
}

function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval_ink",
    title: "Run tests",
    description: "Run the project test suite.",
    risk: "workspace",
    commandPrefix: "npm",
    commandPreview: "npm test",
    ...overrides,
  };
}

function openMenuTitle(ink: InkInteraction): string | undefined {
  const modal = ink.store.getSnapshot().modal;
  return modal?.kind === "menu" ? modal.title : undefined;
}

const IMAGE: ImageAttachment = {
  id: "image_1",
  label: "Image #1",
  mediaType: "image/png",
  storageKey: "image_1.png",
  sha256: "0".repeat(64),
  byteSize: 4,
  width: 1,
  height: 1,
};

interface Harness {
  readonly ink: InkInteraction;
  readonly input: TtyInput;
  readonly output: TtyOutput;
  /** Everything written so far, ANSI removed. */
  text(): string;
  /** Type one chunk and let Ink process it. */
  type(chunk: string): Promise<void>;
}

async function withInk(run: (harness: Harness) => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  process.env.CI = "";
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  const input = new TtyInput();
  const output = new TtyOutput();
  let written = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    written += chunk;
  });
  const ink = new InkInteraction(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
  try {
    assert.equal(ink.beginShell(session()), true);
    await run({
      ink,
      input,
      output,
      text: () => stripAnsi(written),
      type: async (chunk) => {
        input.write(chunk);
        await wait();
      },
    });
  } finally {
    ink.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

describe("Ink interaction", () => {
  it("falls back to the classic terminal when no TTY is available", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ink = new InkInteraction(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
    assert.equal(ink.isInteractive(), false);
    assert.equal(ink.beginShell(session()), false);
    assert.equal(ink.isInlineShell(), false);
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    ink.write("plain output\n");
    assert.match(written, /plain output/u);
    ink.close();
  });

  it("prints the session header and a status footer once the shell starts", async () => {
    await withInk(async ({ ink, text }) => {
      ink.showSessionHeader();
      await wait();
      const rendered = text();
      assert.match(rendered, /EASY CODE/u);
      assert.match(rendered, /thread_ink_ui/u);
      assert.match(rendered, /v4-pro/u);
      assert.match(rendered, /ctx 82\.4k/u);
    });
  });

  it("writes finished rows once and keeps live rows out of scrollback", async () => {
    await withInk(async ({ ink, text }) => {
      ink.info("first notice");
      ink.toolCompleted("read_file", true, "120 lines", undefined, [{ label: "path", value: "src/app.ts" }]);
      ink.startActivity("Thinking about it");
      await wait(120);
      const rendered = text();
      assert.equal((rendered.match(/first notice/gu) ?? []).length, 1);
      assert.match(rendered, /● read_file\(src\/app\.ts\)/u);
      assert.match(rendered, /⎿ {2}120 lines/u);
      assert.match(rendered, /Thinking about it/u);
      assert.equal(ink.store.getSnapshot().settled, ink.store.ui.transcript.length);
    });
  });

  it("holds a streaming answer in the live region and settles it when reconciled", async () => {
    await withInk(async ({ ink, text }) => {
      ink.configureStreaming({ streamFlushIntervalMs: 1, streamPreviewMaxChars: 4_000 });
      ink.modelStream({ kind: "started", streamId: "s1", sequence: 1 });
      ink.modelStream({ kind: "text_delta", streamId: "s1", sequence: 2, text: "Partial answer " });
      await wait(120);
      assert.equal(ink.store.getSnapshot().settled, 0);
      assert.match(text(), /Partial answer/u);

      ink.modelStream({ kind: "text_delta", streamId: "s1", sequence: 3, text: "and the rest." });
      ink.modelStream({ kind: "completed", streamId: "s1", sequence: 4, finishReason: "stop" });
      // The runtime may still reconcile the streamed answer, so it stays replaceable.
      assert.equal(ink.store.getSnapshot().settled, 0);
      assert.equal(ink.finalizeStreamedAnswer("Partial answer and the rest."), true);
      assert.equal(ink.store.getSnapshot().settled, ink.store.ui.transcript.length);
      await wait(120);
      assert.equal((text().match(/Partial answer and the rest\./gu) ?? []).length >= 1, true);
    });
  });

  it("settles an answer that turned into a tool call without waiting for reconciliation", async () => {
    await withInk(async ({ ink }) => {
      ink.configureStreaming({ streamFlushIntervalMs: 1, streamPreviewMaxChars: 4_000 });
      ink.modelStream({ kind: "started", streamId: "s2", sequence: 1 });
      ink.modelStream({ kind: "text_delta", streamId: "s2", sequence: 2, text: "Let me look." });
      ink.modelStream({ kind: "tool_call_delta", streamId: "s2", sequence: 3, index: 0, name: "read_file" });
      ink.modelStream({ kind: "completed", streamId: "s2", sequence: 4, finishReason: "tool_calls" });
      assert.equal(ink.store.getSnapshot().settled, ink.store.ui.transcript.length);
    });
  });

  it("reads a multiline request with CJK text, editing keys and history", async () => {
    await withInk(async ({ ink, type }) => {
      const first = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("你好");
      await type("\u007F");
      await type("a");
      await type("\n");
      await type("line two");
      await type("\r");
      const submission = await first;
      assert.deepEqual(submission, { text: "你a\nline two", images: [], pasteErrors: [] });

      const second = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("\u001B[A");
      await type("\r");
      assert.equal((await second)?.text, "你a\nline two");
    });
  });

  it("collapses a large bracketed paste and submits its full text", async () => {
    await withInk(async ({ ink, type, text }) => {
      const pending = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      const pasted = Array.from({ length: 12 }, (_, index) => `row ${index + 1}`).join("\n");
      await type(`\u001B[200~${pasted}\u001B[201~`);
      assert.match(text(), /\[Pasted text #1 · 12 lines/u);
      await type("\r");
      assert.equal((await pending)?.text.trim(), pasted);
    });
  });

  it("captures a clipboard image for the Ctrl+V key and the VS Code paste sequence", async () => {
    await withInk(async ({ ink, type }) => {
      const captured: number[] = [];
      const pending = ink.readPrompt("> ", {
        initialImageCount: 0,
        captureImage: async (index) => {
          captured.push(index);
          return { ...IMAGE, id: `image_${index}`, label: `Image #${index}` };
        },
      });
      await wait();
      await type("see ");
      await type("\u0016");
      await wait(80);
      await type("\u001B]6973;easy-code;paste-image\u0007");
      await wait(80);
      await type("\r");
      const submission = await pending;
      assert.deepEqual(captured, [1, 2]);
      assert.match(submission?.text ?? "", /^see +\[Image #1\] +\[Image #2\]/u);
      assert.deepEqual(
        submission?.images.map((image) => image.label),
        ["Image #1", "Image #2"],
      );
    });
  });

  it("clears a draft on Ctrl+C and ends the session only on a confirmed second Ctrl+C", async () => {
    await withInk(async ({ ink, type, text }) => {
      const pending = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("draft");
      await type("\u0003");
      assert.notEqual(ink.store.getSnapshot().prompt, null);
      await type("\u0003");
      assert.notEqual(ink.store.getSnapshot().prompt, null, "one stray Ctrl+C must not exit");
      assert.match(text(), /Press Ctrl\+C again to exit/u);
      await type("\u0003");
      assert.equal(await pending, null);
    });
  });

  it("submits text and Enter that arrive in one chunk, but keeps an unbracketed multi-line paste", async () => {
    await withInk(async ({ ink, type }) => {
      const first = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("fast typist\r");
      assert.equal((await first)?.text, "fast typist");

      const second = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("one\rtwo\r");
      assert.notEqual(ink.store.getSnapshot().prompt, null);
      await type("\r");
      assert.equal((await second)?.text, "one\ntwo\n");
    });
  });

  it("keeps the draft when a width change reprints the transcript", async () => {
    await withInk(async ({ ink, type, output }) => {
      const pending = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("keep me");
      output.columns = 60;
      output.emit("resize");
      await wait(300);
      assert.equal(ink.store.getSnapshot().epoch, 1);
      await type("\r");
      assert.equal((await pending)?.text, "keep me");
    });
  });

  it("shows an answer that was not streamed in assistant format", async () => {
    await withInk(async ({ ink }) => {
      assert.equal(ink.finalizeStreamedAnswer("Plain final answer."), true);
      const last = ink.store.ui.transcript.at(-1);
      assert.equal(last?.kind, "assistant");
      assert.match(stripAnsi(last?.text ?? ""), /● Plain final answer\./u);
    });
  });

  it("forwards typed adjustments to the running request and Ctrl+C to its interrupt hook", async () => {
    await withInk(async ({ ink, type }) => {
      const steered: string[] = [];
      let interrupts = 0;
      ink.setCurrentRequest("build it", [], {
        onSteer: (submission) => {
          steered.push(submission.text);
        },
        onInterrupt: () => {
          interrupts += 1;
        },
      });
      await wait();
      await type("use tabs");
      await type("\r");
      await type("\u0003");
      assert.deepEqual(steered, ["use tabs"]);
      assert.equal(interrupts, 1);

      // Sealing the final answer freezes admission until the seal decides.
      const sealed = ink.sealCurrentRequestSteering(async () => {
        await wait(20);
        return "done";
      });
      assert.equal(
        ink.steer({ text: "too late", images: [], pasteErrors: [] }),
        false,
        "admission closes while the barrier is open",
      );
      assert.equal(await sealed, "done");
      ink.clearCurrentRequest();
      assert.equal(ink.store.getSnapshot().busy, null);
    });
  });

  it("resolves approvals from the keyboard and rejects when cancelled", async () => {
    await withInk(async ({ ink, type, text }) => {
      const allowed = ink.approve(approvalRequest());
      await wait(250);
      assert.match(text(), /Approve command execution/u);
      assert.match(text(), /npm test/u);
      await type("\r");
      assert.equal(await allowed, "allow_once");

      const denied = ink.approve(approvalRequest({ id: "approval_down" }));
      await wait(250);
      await type("\u001B[B");
      await type("\r");
      assert.equal(await denied, "reject");

      const rejected = ink.approve(approvalRequest({ id: "approval_cancel" }));
      await wait(250);
      await type("\u0003");
      assert.equal(await rejected, "reject");

      const aborted = new AbortController();
      const cancelled = ink.approve(approvalRequest({ id: "approval_abort", signal: aborted.signal }));
      await wait(100);
      aborted.abort();
      assert.equal(await cancelled, "reject");
      assert.equal(ink.store.getSnapshot().modal, null);
    });
  });

  it("queues overlapping dialogs instead of replacing the open one", async () => {
    await withInk(async ({ ink, type }) => {
      const first = ink.selectChoice("First", [{ id: "a", label: "Alpha" }]);
      const second = ink.selectChoice("Second", [{ id: "b", label: "Beta" }]);
      await wait(250);
      assert.equal(openMenuTitle(ink), "First");
      await type("\r");
      assert.equal(await first, "a");
      await wait(250);
      assert.equal(openMenuTitle(ink), "Second");
      await type("\r");
      assert.equal(await second, "b");
    });
  });

  it("reads a secret without echoing it", async () => {
    await withInk(async ({ ink, type, text }) => {
      const secret = ink.readSecret("API key");
      await wait();
      await type("sk-test-123");
      await type("\r");
      assert.equal(await secret, "sk-test-123");
      assert.equal(text().includes("sk-test-123"), false);
    });
  });

  it("restarts with a fresh scrollback when the display is cleared", async () => {
    await withInk(async ({ ink, text }) => {
      ink.info("old notice");
      await wait();
      ink.clearScreen();
      await wait(120);
      assert.equal(
        ink.store.ui.transcript.some((entry) => entry.text.includes("old notice")),
        false,
      );
      assert.match(text(), /EASY CODE/u);
      assert.equal(ink.store.getSnapshot().epoch, 1);
    });
  });
});
