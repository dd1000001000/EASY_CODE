import assert from "node:assert/strict";
import path from "node:path";

import { TurnFileText, turnChangedFiles, turnFileText } from "../src/app/turn-changes.js";
import type { FileChangeRecord } from "../src/core/types.js";
import { describe, it } from "./harness.js";

const ROOT = path.resolve("workspace");
const resolve = (relative: string) => {
  if (relative.startsWith("../")) throw new Error("outside the workspace");
  return path.join(ROOT, relative);
};

function change(
  file: string,
  operation: FileChangeRecord["operation"],
  extra: Partial<FileChangeRecord> = {},
): FileChangeRecord {
  return {
    path: file,
    operation,
    source: operation === "generated" || operation === "deleted_by_command" ? "command" : "file_tool",
    status: "applied",
    timestamp: "2026-10-02T00:00:00.000Z",
    ...extra,
  };
}

describe("files changed by one request", () => {
  it("classifies each file once as added, modified or deleted", () => {
    const files = turnChangedFiles(
      [
        change("src/new.ts", "create"),
        change("src/app.ts", "update", { beforeHash: "a" }),
        change("src/new.ts", "update", { beforeHash: "b" }),
        change("dist/out.js", "generated"),
        change("package-lock.json", "generated", { beforeHash: "c" }),
        change("old.ts", "delete", { beforeHash: "d" }),
      ],
      resolve,
    );
    assert.deepEqual(
      files.map(({ path: file, change: kind }) => [file, kind]),
      [
        ["src/new.ts", "created"],
        ["src/app.ts", "modified"],
        ["dist/out.js", "created"],
        ["package-lock.json", "modified"],
        ["old.ts", "deleted"],
      ],
    );
    assert.equal(files[0]?.absolutePath, path.join(ROOT, "src/new.ts"));
  });

  it("leaves out failed changes, files created and removed again, and paths outside the workspace", () => {
    const files = turnChangedFiles(
      [
        change("scratch.txt", "create"),
        change("scratch.txt", "delete"),
        change("blocked.ts", "update", { status: "policy_violation" }),
        change("../escape.ts", "update"),
        change("kept.ts", "update", { status: "verified" }),
      ],
      resolve,
    );
    assert.deepEqual(
      files.map((file) => file.path),
      ["kept.ts"],
    );
  });

  it("counts net lines from the first text to the latest across several edits", () => {
    const text = new TurnFileText();
    const diff = (file: string, before: string, after: string) =>
      text.record({ type: "file_diff", path: file, before, after });
    diff("src/app.ts", "a\nb\nc\n", "a\nB\nc\n");
    // A second edit puts the first change back and adds a line: net one line added.
    diff("src\\app.ts", "a\nB\nc\n", "a\nb\nc\nd\n");
    diff("src/new.ts", "", "one\ntwo\n");
    diff("old.ts", "x\ny\nz\n", "");
    assert.deepEqual(text.change("src/app.ts")?.lines, { added: 1, removed: 0 });
    assert.deepEqual(text.change("src/app.ts")?.hunks, [{ oldStart: 1, newStart: 1, lines: [" a", " b", " c", "+d"] }]);
    assert.deepEqual(text.change("./src/new.ts")?.lines, { added: 2, removed: 0 });
    assert.deepEqual(text.change("old.ts")?.lines, { added: 0, removed: 3 });
    assert.equal(text.change("never-edited.ts"), undefined);
    text.clear();
    assert.equal(text.change("src/app.ts"), undefined);
  });

  it("keeps diffs within the per-file and per-request line budgets", () => {
    const text = new TurnFileText();
    const many = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => `${prefix}${index}`).join("\n") + "\n";
    text.record({ type: "file_diff", path: "big.ts", before: "", after: many(500, "line ") });
    text.record({ type: "file_diff", path: "long.ts", before: "", after: `${"x".repeat(1_000)}\n` });
    const files = turnChangedFiles([change("big.ts", "create"), change("long.ts", "create")], resolve, text);
    const [big, long] = files;
    // The counts cover the whole file; the saved diff stops at 400 lines.
    assert.deepEqual(big?.lines, { added: 500, removed: 0 });
    assert.equal(big?.diff?.truncated, true);
    assert.equal(big?.diff?.hunks.flatMap((hunk) => hunk.lines).length, 400);
    const [line] = long?.diff?.hunks[0]?.lines ?? [];
    assert.equal(line?.length, 401);
    assert.ok(line?.startsWith("+x") && line.endsWith("…"));
  });

  it("gives line counts only to files no command changed, one collector per workspace", () => {
    const workspace = {};
    const text = turnFileText(workspace);
    assert.equal(turnFileText(workspace), text);
    assert.notEqual(turnFileText({}), text);
    text.record({ type: "file_diff", path: "src/app.ts", before: "a\n", after: "a\nb\n" });
    text.record({ type: "file_diff", path: "build.ts", before: "a\n", after: "b\n" });
    const files = turnChangedFiles(
      [
        change("src/app.ts", "update", { beforeHash: "a" }),
        change("build.ts", "update", { beforeHash: "b" }),
        change("build.ts", "generated", { beforeHash: "c" }),
        change("notes.md", "update", { beforeHash: "d" }),
      ],
      resolve,
      text,
    );
    assert.deepEqual(
      files.map((file) => [file.path, file.lines]),
      [
        ["src/app.ts", { added: 1, removed: 0 }],
        ["build.ts", undefined],
        ["notes.md", undefined],
      ],
    );
  });
});
