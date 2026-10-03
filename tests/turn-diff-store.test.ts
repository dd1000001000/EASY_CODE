import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ToolDiffStore, TurnDiffStore } from "../src/threads/turn-diff-store.js";
import type { TurnFileDiff } from "../src/ui/contracts.js";
import { describe, it } from "./harness.js";

const DIFF: TurnFileDiff = { truncated: false, hunks: [{ oldStart: 1, newStart: 1, lines: [" a", "-b", "+B"] }] };

async function withStore(run: (store: TurnDiffStore, dataDir: string) => Promise<void> | void) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "easy-code-turn-diffs-"));
  try {
    await run(new TurnDiffStore(dataDir), dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe("turn diff store", () => {
  it("saves each file's diff beside the thread and reads one file back", () =>
    withStore((store, dataDir) => {
      store.write("thread_a", "turn_1", new Map([["src/app.ts", DIFF]]));
      assert.ok(existsSync(path.join(dataDir, "threads", "thread_a", "turn-diffs", "turn_1.json")));
      assert.deepEqual(store.read("thread_a", "turn_1", "src/app.ts"), DIFF);
      assert.equal(store.read("thread_a", "turn_1", "src/other.ts"), undefined);
      assert.equal(store.read("thread_a", "turn_1", "__proto__"), undefined);
      assert.equal(store.read("thread_a", "turn_2", "src/app.ts"), undefined);
      assert.equal(store.read("thread_b", "turn_1", "src/app.ts"), undefined);
    }));

  it("removes a request's file when it has no diffs left", () =>
    withStore((store, dataDir) => {
      store.write("thread_a", "turn_1", new Map([["src/app.ts", DIFF]]));
      store.write("thread_a", "turn_1", new Map());
      assert.equal(existsSync(path.join(dataDir, "threads", "thread_a", "turn-diffs", "turn_1.json")), false);
    }));

  it("keeps one file per tool call, whatever characters the provider put in its id", () =>
    withStore((_store, dataDir) => {
      const calls = new ToolDiffStore(dataDir);
      const odd = "call/../../etc:passwd\u0000漢字";
      calls.write("thread_a", "turn_1", odd, DIFF);
      calls.write("thread_a", "turn_1", "call_2", { truncated: true, hunks: [] });
      assert.equal(calls.has("thread_a", "turn_1", odd), true);
      assert.deepEqual(calls.read("thread_a", "turn_1", odd), DIFF);
      assert.deepEqual(calls.read("thread_a", "turn_1", "call_2"), { truncated: true, hunks: [] });
      assert.equal(calls.has("thread_a", "turn_2", odd), false);
      assert.equal(calls.read("thread_a", "turn_1", "call_3"), undefined);
      // Every file stays inside the thread's own tool-diffs folder.
      const folder = path.join(dataDir, "threads", "thread_a", "tool-diffs", "turn_1");
      assert.equal(readdirSync(folder).length, 2);
      assert.throws(() => calls.write("..", "turn_1", "call", DIFF), /thread id/u);
      assert.throws(() => calls.read("thread_a", "../turn", "call"), /turn id/u);
      assert.throws(() => calls.read("thread_a", "turn_1", ""), /tool call id/u);
      assert.equal(calls.has("thread_a", "turn_1", ""), false);
    }));

  it("refuses ids that could leave the thread directory and ignores malformed files", () =>
    withStore(async (store, dataDir) => {
      assert.throws(() => store.read("..", "turn_1", "a"), /thread id/u);
      assert.throws(() => store.read("thread_a", "../turn", "a"), /turn id/u);
      assert.throws(() => store.write("thread_a", "turn/1", new Map([["a", DIFF]])), /turn id/u);
      store.write("thread_a", "turn_1", new Map([["a", DIFF]]));
      const file = path.join(dataDir, "threads", "thread_a", "turn-diffs", "turn_1.json");
      await writeFile(file, JSON.stringify({ version: 1, files: { a: { hunks: [{ lines: ["not a line"] }] } } }));
      assert.equal(store.read("thread_a", "turn_1", "a"), undefined);
      await writeFile(file, JSON.stringify({ version: 99, files: { a: DIFF } }));
      assert.equal(store.read("thread_a", "turn_1", "a"), undefined);
    }));
});
