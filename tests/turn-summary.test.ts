import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { displayWidth, stripAnsi } from "../src/ui/render/layout.js";
import { formatDuration, renderTurnSummary } from "../src/ui/render/turn-summary.js";
import type { TurnSummary } from "../src/ui/contracts.js";
import { describe, it } from "./harness.js";

const ROOT = path.resolve("workspace-root");

function file(relative: string, deleted = false) {
  const change = deleted ? ("deleted" as const) : ("modified" as const);
  return { path: relative, absolutePath: path.join(ROOT, relative), change };
}

const SUMMARY: TurnSummary = {
  durationMs: 72_400,
  inputTokens: 12_345,
  outputTokens: 1_230,
  changedFiles: [file("src/app.ts"), file("src/old.ts", true)],
};

const OSC8 = /\u001B\]8;;([^\u0007]*)\u0007/gu;

describe("turn summary line", () => {
  it("formats elapsed time compactly", () => {
    assert.equal(formatDuration(8_400), "8s");
    assert.equal(formatDuration(72_400), "1m 12s");
    assert.equal(formatDuration(3_725_000), "1h 02m");
  });

  it("shows duration, tokens and changed files in both languages", () => {
    const options = { color: false, columns: 120, links: false } as const;
    assert.equal(
      renderTurnSummary(SUMMARY, { ...options, language: "en_us" }),
      "  took 1m 12s · ↑ 12.3k ↓ 1.2k tokens · 2 files changed: src/app.ts, src/old.ts (deleted)",
    );
    assert.equal(
      renderTurnSummary(SUMMARY, { ...options, language: "zh_cn" }),
      "  用时 1m 12s · ↑ 12.3k ↓ 1.2k tokens · 改动 2 个文件：src/app.ts、src/old.ts (已删除)",
    );
    assert.equal(
      renderTurnSummary({ durationMs: 3_000, changedFiles: [] }, { ...options, language: "en_us" }),
      "  took 3s",
    );
  });

  it("links existing files with OSC 8 and leaves deleted ones plain", () => {
    const rendered = renderTurnSummary(SUMMARY, { language: "en_us", color: true, columns: 120, links: true });
    const targets = [...rendered.matchAll(OSC8)].map((match) => match[1]).filter(Boolean);
    assert.deepEqual(targets, [pathToFileURL(path.join(ROOT, "src/app.ts")).href]);
    assert.match(rendered, /\u001B\[90m/u);
    assert.equal(stripAnsi(rendered.replace(OSC8, "")).includes("src/old.ts (deleted)"), true);
  });

  it("names as many files as fit and counts the rest", () => {
    const many: TurnSummary = {
      durationMs: 1_000,
      changedFiles: Array.from({ length: 12 }, (_, index) => file(`src/module-${index}.ts`)),
    };
    const line = renderTurnSummary(many, { language: "en_us", color: false, columns: 80, links: false });
    assert.ok(displayWidth(line) <= 80, line);
    assert.match(line, /^ {2}took 1s · 12 files changed: src\/module-0\.ts, /u);
    assert.match(line, /\+\d+ more$/u);
  });
});
