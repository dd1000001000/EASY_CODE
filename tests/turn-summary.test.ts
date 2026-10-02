import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { displayWidth, stripAnsi } from "../src/ui/render/layout.js";
import { formatDuration, renderTurnSummary } from "../src/ui/render/turn-summary.js";
import type { TurnChangedFile, TurnLineCounts, TurnSummary } from "../src/ui/contracts.js";
import { describe, it } from "./harness.js";

const ROOT = path.resolve("workspace-root");

function file(relative: string, options: { deleted?: boolean; lines?: TurnLineCounts } = {}): TurnChangedFile {
  return {
    path: relative,
    absolutePath: path.join(ROOT, relative),
    change: options.deleted ? "deleted" : "modified",
    ...(options.lines ? { lines: options.lines } : {}),
  };
}

const SUMMARY: TurnSummary = {
  durationMs: 72_400,
  inputTokens: 12_345,
  outputTokens: 1_230,
  changedFiles: [
    file("src/app.ts", { lines: { added: 12, removed: 3 } }),
    file("src/old.ts", { deleted: true, lines: { added: 0, removed: 40 } }),
    file("dist/out.js"),
  ],
};

const OSC8 = /\u001B\]8;;([^\u0007]*)\u0007/gu;

describe("turn summary", () => {
  it("formats elapsed time compactly", () => {
    assert.equal(formatDuration(8_400), "8s");
    assert.equal(formatDuration(72_400), "1m 12s");
    assert.equal(formatDuration(3_725_000), "1h 02m");
  });

  it("lists each changed file with its line counts in both languages", () => {
    const options = { color: false, columns: 120, links: false } as const;
    assert.equal(
      renderTurnSummary(SUMMARY, { ...options, language: "en_us" }),
      [
        "  took 1m 12s · ↑ 12.3k ↓ 1.2k tokens · 3 files changed +12 -43",
        "    src/app.ts            +12 -3",
        "    src/old.ts (deleted)  +0 -40",
        "    dist/out.js",
      ].join("\n"),
    );
    assert.equal(
      renderTurnSummary(SUMMARY, { ...options, language: "zh_cn" }),
      [
        "  用时 1m 12s · ↑ 12.3k ↓ 1.2k tokens · 改动 3 个文件 +12 -43",
        "    src/app.ts           +12 -3",
        "    src/old.ts (已删除)  +0 -40",
        "    dist/out.js",
      ].join("\n"),
    );
    assert.equal(
      renderTurnSummary({ durationMs: 3_000, changedFiles: [] }, { ...options, language: "en_us" }),
      "  took 3s",
    );
    assert.equal(
      renderTurnSummary({ durationMs: 3_000, changedFiles: [file("dist/out.js")] }, { ...options, language: "en_us" }),
      "  took 3s · 1 file changed\n    dist/out.js",
    );
  });

  it("links existing files with OSC 8, leaves deleted ones plain and colors the counts", () => {
    const rendered = renderTurnSummary(SUMMARY, { language: "en_us", color: true, columns: 120, links: true });
    const targets = [...rendered.matchAll(OSC8)].map((match) => match[1]).filter(Boolean);
    assert.deepEqual(targets, [
      pathToFileURL(path.join(ROOT, "src/app.ts")).href,
      pathToFileURL(path.join(ROOT, "dist/out.js")).href,
    ]);
    assert.match(rendered, /\u001B\[90m/u);
    assert.match(rendered, /\u001B\[32m\+12\u001B\[39m \u001B\[31m-3\u001B\[39m/u);
    assert.equal(stripAnsi(rendered.replace(OSC8, "")).includes("src/old.ts (deleted)"), true);
  });

  it("lists up to eight files, counts the rest and never wraps a row", () => {
    const many: TurnSummary = {
      durationMs: 1_000,
      changedFiles: Array.from({ length: 12 }, (_, index) =>
        file(`src/features/very/deeply/nested/module-${index}.ts`, { lines: { added: index, removed: 1 } }),
      ),
    };
    const rows = renderTurnSummary(many, { language: "en_us", color: false, columns: 40, links: false }).split("\n");
    assert.equal(rows.length, 9);
    for (const row of rows) assert.ok(displayWidth(row) <= 40, row);
    assert.match(rows[1]!, /^ {4}….*module-0\.ts +\+0 -1$/u);
    assert.equal(rows[8], "    +5 more");
  });
});
