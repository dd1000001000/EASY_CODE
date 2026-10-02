import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

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
  /** Everything written so far, as written. */
  raw(): string;
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
      raw: () => written,
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

  it("moves each finished Markdown block of a streaming answer into scrollback", async () => {
    await withInk(async ({ ink, text }) => {
      ink.configureStreaming({ streamFlushIntervalMs: 1, streamPreviewMaxChars: 4_000 });
      ink.modelStream({ kind: "started", streamId: "blocks", sequence: 1 });
      ink.modelStream({ kind: "reasoning_delta", streamId: "blocks", sequence: 2, text: "Plan the answer." });
      ink.modelStream({ kind: "text_delta", streamId: "blocks", sequence: 3, text: "First paragraph." });
      await wait(60);
      // A single unfinished block stays redrawable, and so does the Thinking above it.
      assert.equal(ink.store.getSnapshot().settled, 0);

      ink.modelStream({
        kind: "text_delta",
        streamId: "blocks",
        sequence: 4,
        text: "\n\n- one\n- two\n\nTail first line\n",
      });
      await wait(60);
      // The paragraph and list are final; only the last paragraph may still change.
      const { ui, settled } = ink.store.getSnapshot();
      const answers = ui.transcript.filter((entry) => entry.kind === "assistant");
      assert.equal(answers.length, 2);
      assert.match(answers[0]!.text, /First paragraph\.\s+- one\n- two/u);
      assert.equal(answers[0]!.continuation, undefined);
      assert.equal(answers[1]!.continuation, true);
      assert.equal(settled, ui.transcript.indexOf(answers[1]!));

      ink.modelStream({ kind: "text_delta", streamId: "blocks", sequence: 5, text: "second line." });
      ink.modelStream({ kind: "completed", streamId: "blocks", sequence: 6, finishReason: "stop" });
      assert.equal(
        ink.finalizeStreamedAnswer("First paragraph.\n\n- one\n- two\n\nTail first line\nsecond line."),
        true,
      );
      await wait(120);
      const final = ink.store.ui.transcript.filter((entry) => entry.kind === "assistant");
      assert.equal(final.length, 2);
      assert.equal(final[1]!.text.trim(), "Tail first line\nsecond line.");
      assert.equal(ink.store.getSnapshot().settled, ink.store.ui.transcript.length);
      // One bullet for the whole answer, and each block printed once.
      assert.equal((text().match(/● First paragraph\./gu) ?? []).length, 1);
      assert.doesNotMatch(text(), /● Tail first line/u);
      assert.match(text(), /second line\./u);
    });
  });

  it("keeps settled blocks when the assembled answer differs from the stream", async () => {
    await withInk(async ({ ink }) => {
      ink.configureStreaming({ streamFlushIntervalMs: 1, streamPreviewMaxChars: 4_000 });
      ink.modelStream({ kind: "started", streamId: "drift", sequence: 1 });
      ink.modelStream({ kind: "text_delta", streamId: "drift", sequence: 2, text: "Intro.\n\nBody\n" });
      await wait(60);
      ink.modelStream({ kind: "completed", streamId: "drift", sequence: 3, finishReason: "stop" });
      assert.equal(ink.finalizeStreamedAnswer("Different intro.\n\nBody"), true);
      const answers = ink.store.ui.transcript.filter((entry) => entry.kind === "assistant");
      assert.deepEqual(
        answers.map((entry) => entry.text.trim()),
        ["Intro.", "Body"],
      );
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

  it("keeps keys and pastes typed before the prompt opens, submitting only on a typed Enter", async () => {
    await withInk(async ({ ink, type }) => {
      await wait();
      await type("\u001B[200~first line\nsecond line\nthird line\u001B[201~");
      await type(" tail");
      const pending = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      assert.notEqual(ink.store.getSnapshot().prompt, null, "a pasted line break is not Enter");
      await type("\r");
      assert.equal((await pending)?.text, "first line\nsecond line\nthird line tail");

      await type("queued\r");
      const next = await ink.readPrompt("> ", { captureImage: async () => IMAGE });
      assert.equal(next?.text, "queued");
    });
  });

  it("clears the screen and scrollback when the shell starts", async () => {
    await withInk(async ({ raw }) => {
      assert.ok(raw().startsWith("\u001B[3J\u001B[2J\u001B[H"));
    });
  });

  it("links Thinking markers for VS Code and expands them in a full-screen viewer", async () => {
    await withInk(async ({ ink, type, text, raw }) => {
      ink.addReasoning("First, inspect the repository layout.\nThen answer the greeting.");
      const marker = stripAnsi(ink.store.ui.transcript.at(-1)?.text ?? "");
      // The extension only links a title whose id is repeated after `/thinking`.
      assert.match(marker, /▶ Thinking #1 · [^\n]*? · \/thinking 1 /u);

      const pending = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("draft");
      await type("\u0014");
      await wait(150);
      assert.ok(raw().includes("\u001B[?1049h"), "the viewer uses the alternate screen");
      assert.match(text(), /↕ Thinking #1 · Ctrl\/Cmd\+click to close · \/thinking 1/u);
      assert.match(text(), /Then answer the greeting\./u);

      // Output arriving while the viewer is open waits for it to close.
      ink.info("finished while viewing");
      assert.equal(ink.store.getSnapshot().settled, ink.store.ui.transcript.length - 1);

      await type("\u001B");
      await wait(150);
      assert.ok(raw().includes("\u001B[?1049l"), "closing returns to the primary screen");
      assert.equal(ink.store.getSnapshot().settled, ink.store.ui.transcript.length);
      await type("\r");
      assert.equal((await pending)?.text, "draft");
    });
  });

  it("clips a streaming answer taller than the window to its newest rows", async () => {
    await withInk(async ({ ink, text, raw }) => {
      ink.configureStreaming({ streamFlushIntervalMs: 1, streamPreviewMaxChars: 40_000 });
      const lines = Array.from({ length: 60 }, (_, index) => `- item ${index + 1}`).join("\n");
      ink.modelStream({ kind: "started", streamId: "tall", sequence: 1 });
      ink.modelStream({ kind: "text_delta", streamId: "tall", sequence: 2, text: `${lines}\n` });
      await wait(200);
      const startClears = raw().split("\u001B[2J").length - 1;
      assert.match(text(), /item 60/u);
      assert.match(text(), /earlier rows of this block are shown when it completes/u);
      ink.modelStream({ kind: "text_delta", streamId: "tall", sequence: 3, text: "- item 61\n" });
      await wait(200);
      // Staying shorter than the window means Ink never falls back to clearing the screen.
      assert.equal(raw().split("\u001B[2J").length - 1, startClears);
    });
  });

  it("shows an answer that was not streamed as a styled Markdown assistant row", async () => {
    await withInk(async ({ ink, text }) => {
      assert.equal(ink.finalizeStreamedAnswer("## Plain final answer\n| a | b |\n|---|---|\n| 1 | 2 |"), true);
      assert.equal(ink.store.ui.transcript.at(-1)?.kind, "assistant");
      await wait(120);
      assert.match(text(), /● Plain final answer/u);
      assert.match(text(), /a {2}b\n {2}─+\n {2}1 {2}2/u);
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

  it("opens a slash-command menu, fills in arguments, and runs the chosen command", async () => {
    await withInk(async ({ ink, type, text }) => {
      const pending = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("/mo");
      assert.match(text(), /› \/mode\s+Switch working mode/u);
      assert.match(text(), /\/model\s+Pick a model/u);

      // /mode needs an argument: Enter fills it in and shows the argument menu.
      await type("\r");
      assert.equal(ink.store.getSnapshot().prompt !== null, true);
      assert.match(text(), /› plan\s+Propose a plan/u);
      await type("\u001B[B");
      await type("\r");
      assert.equal((await pending)?.text, "/mode auto");
    });
  });

  it("browses history with arrows and labels the entry instead of opening the command menu", async () => {
    await withInk(async ({ ink, type, text }) => {
      const first = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("/help");
      await type("\r");
      assert.equal((await first)?.text, "/help");

      const second = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("\u001B[A");
      assert.match(text(), /History 1\/1/u);
      // ↓ returns to the empty draft rather than moving through a command menu.
      await type("\u001B[B");
      await type("\u001B[A");
      await type("\r");
      assert.equal((await second)?.text, "/help");
    });
  });

  it("clears a draft only on a second Escape", async () => {
    await withInk(async ({ ink, type, text }) => {
      const pending = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("keep this draft");
      await type("\u001B");
      await wait(80);
      assert.match(text(), /Press Esc again to clear/u);
      await type(" too");
      await type("\u001B");
      await wait(80);
      await type("\u001B");
      await wait(80);
      await type("fresh");
      await type("\r");
      assert.equal((await pending)?.text, "fresh");
    });
  });

  it("completes @ file references from the workspace listing", async () => {
    await withInk(async ({ ink, type, text }) => {
      const pending = ink.readPrompt("> ", {
        captureImage: async () => IMAGE,
        mentionPaths: () => ["src/app.ts", "src/store.ts", "README.md"],
      });
      await wait();
      await type("@sr");
      assert.match(text(), /› src\//u);
      await type("\r");
      assert.match(text(), /› src\/app\.ts/u);
      await type("\u001B[B");
      await type("\r");
      await type("check it");
      await type("\r");
      assert.equal((await pending)?.text, "@src/store.ts check it");
    });
  });

  it("prints a turn summary with linked file names", async () => {
    await withInk(async ({ ink, text, raw }) => {
      const absolutePath = path.resolve("project", "src", "app.ts");
      ink.turnCompleted({
        durationMs: 72_000,
        inputTokens: 1_500,
        outputTokens: 300,
        changedFiles: [{ path: "src/app.ts", absolutePath, change: "modified" }],
      });
      await wait(120);
      assert.match(text(), /took 1m 12s · ↑ 1\.5k ↓ 300 tokens · 1 file changed: src\/app\.ts/u);
      assert.ok(
        raw().includes(`\u001B]8;;${pathToFileURL(absolutePath).href}\u0007src/app.ts\u001B]8;;\u0007`),
        "the file name links to its absolute file URL",
      );
    });
  });

  it("closes the slash menu on Escape without clearing the draft, and offers host threads", async () => {
    await withInk(async ({ ink, type, text }) => {
      const first = ink.readPrompt("> ", { captureImage: async () => IMAGE });
      await wait();
      await type("/he");
      await type("\u001B");
      await wait(80);
      await type("\r");
      // Escape dismissed the menu, so Enter submits exactly what was typed.
      assert.equal((await first)?.text, "/he");

      const second = ink.readPrompt("> ", {
        captureImage: async () => IMAGE,
        slashArguments: (command) =>
          command === "resume" ? [{ value: "thread_old", description: "Add authentication" }] : undefined,
      });
      await wait();
      await type("/resume ");
      assert.match(text(), /› thread_old\s+Add authentication/u);
      await type("\t");
      await type("\r");
      assert.equal((await second)?.text, "/resume thread_old");
    });
  });
});
