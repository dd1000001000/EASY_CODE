import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  renderFileDiff,
  sanitizeDiffText,
} from "../src/cli/file-diff.js";
import { Terminal } from "../src/cli/terminal.js";
import { describe, it } from "./harness.js";

describe("file diff UI", () => {
  it("renders changed code with old and new line numbers", () => {
    const output = renderFileDiff(
      {
        type: "file_diff",
        path: "src/example.ts",
        before: "const keep = true;\nconst value = 1;\nreturn keep;\n",
        after: "const keep = true;\nconst value = 2;\nreturn keep;\n",
      },
      { color: false },
    );
    const lines = output.split("\n");
    const removed = lines.find((line) => line.includes("- const value = 1;"));
    const added = lines.find((line) => line.includes("+ const value = 2;"));
    const context = lines.find((line) => line.includes("  const keep = true;"));

    assert.ok(removed);
    assert.ok(added);
    assert.ok(context);
    assert.match(removed, /^\s*2\s+│ - const value = 1;$/u);
    assert.match(added, /^\s+2 │ \+ const value = 2;$/u);
    assert.match(context, /^\s*1\s+1 │   const keep = true;$/u);
    assert.doesNotMatch(output, /\u001B\[/u);
  });

  it("colors additions green and removals red when color is enabled", () => {
    const output = renderFileDiff(
      {
        type: "file_diff",
        path: "src/color.ts",
        before: "old\n",
        after: "new\n",
      },
      { color: true },
    );
    assert.match(output, /\u001B\[31m/u);
    assert.match(output, /\u001B\[32m/u);
  });

  it("shows every created line as an addition with a new line number", () => {
    const output = renderFileDiff(
      {
        type: "file_diff",
        path: "src/new.ts",
        before: "",
        after: "first\nsecond\n",
      },
      { color: false },
    );
    const lines = output.split("\n");
    assert.match(lines.find((line) => line.includes("+ first")) ?? "", /^\s+1 │ \+ first$/u);
    assert.match(lines.find((line) => line.includes("+ second")) ?? "", /^\s+2 │ \+ second$/u);
  });

  it("keeps old and new line numbers aligned after a pure deletion", () => {
    const output = renderFileDiff(
      {
        type: "file_diff",
        path: "src/delete.ts",
        before: "one\ntwo\nthree\n",
        after: "one\nthree\n",
      },
      { color: false },
    );
    const lines = output.split("\n");
    const removed = lines.find((line) => line.includes("- two"));
    const shiftedContext = lines.find((line) => line.includes("  three"));

    assert.match(removed ?? "", /^\s*2\s+│ - two$/u);
    assert.match(shiftedContext ?? "", /^\s*3\s+2 │   three$/u);
  });

  it("bounds large previews and reports omitted lines", () => {
    const output = renderFileDiff(
      {
        type: "file_diff",
        path: "src/large.ts",
        before: "",
        after: "one\ntwo\nthree\nfour\n",
      },
      { color: false, maxLines: 2 },
    );
    assert.match(output, /Diff truncated; 2 lines omitted/u);
    assert.match(output, /\+ one/u);
    assert.doesNotMatch(output, /\+ three/u);
  });

  it("falls back without an unbounded diff for very large replacements", () => {
    const after = Array.from({ length: 10_001 }, (_, index) => `line ${index + 1}`).join("\n");
    const output = renderFileDiff(
      {
        type: "file_diff",
        path: "src/generated.ts",
        before: "",
        after,
      },
      { color: false, maxLines: 3 },
    );
    assert.match(output, /Diff exceeds the safe computation limit/u);
    assert.match(output, /9998 lines omitted/u);
  });

  it("escapes terminal controls and bidi markers before rendering", () => {
    const unsafe = "\u001B]8;;https://attacker.invalid\u0007click\u001B[2J\u202Eabc";
    const safe = sanitizeDiffText(unsafe);
    assert.doesNotMatch(safe, /[\u0000-\u001F\u007F-\u009F\u202E]/u);
    assert.match(safe, /\\u\{001b\}/u);
    assert.match(safe, /\\u\{0007\}/u);
    assert.match(safe, /\\u\{202e\}/u);
  });

  it("redacts multi-line private key material without losing line numbers", () => {
    const keyBody = "TOP_SECRET_KEY_BODY_MUST_NOT_RENDER";
    const output = renderFileDiff(
      {
        type: "file_diff",
        path: "private.pem",
        before: `-----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----\n`,
        after: "",
      },
      { color: false },
    );
    assert.doesNotMatch(output, new RegExp(keyBody, "u"));
    assert.match(output, /2\s+│ - \[REDACTED PRIVATE KEY MATERIAL\]/u);
  });

  it("describes an empty file without inventing a code line", () => {
    const output = renderFileDiff(
      { type: "file_diff", path: "empty.txt", before: "", after: "" },
      { color: false },
    );
    assert.match(output, /Empty file created/u);
    assert.doesNotMatch(output, /│ \+/u);
  });

  it("honors NO_COLOR even for a TTY-like output", () => {
    class TtyOutput extends PassThrough {
      readonly isTTY = true;
    }
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    const input = new PassThrough();
    const output = new TtyOutput();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    const terminal = new Terminal(input, output);
    try {
      process.env.NO_COLOR = "1";
      process.env.FORCE_COLOR = "1";
      terminal.fileDiff({
        type: "file_diff",
        path: "no-color.ts",
        before: "old\n",
        after: "new\n",
      });
      assert.doesNotMatch(transcript, /\u001B\[/u);
      assert.match(transcript, /- old/u);
      assert.match(transcript, /\+ new/u);
    } finally {
      terminal.close();
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = previousForceColor;
    }
  });
});
