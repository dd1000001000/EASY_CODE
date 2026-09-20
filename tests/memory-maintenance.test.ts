import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import type { ModelProvider } from "../src/core/types.js";
import { MemoryMaintenance } from "../src/memory/maintenance.js";
import { MemoryManager, GLOBAL_MEMORY_WORKSPACE_ID, projectMemoryIdFromRoot } from "../src/memory/memory-manager.js";
import { defaultRuntimeLimits, type RuntimeLimits } from "../src/config/runtime-limits.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";

function fixture(userInput = "Inspect the project", limits: Readonly<RuntimeLimits> = defaultRuntimeLimits()) {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-memory-maint-"));
  const storage = createStorage(path.join(root, "data"));
  const store = new ThreadStore(storage);
  const state = store.create({ threadId: "thread_memory_maintenance", workspaceRoot: root,
    mode: "code", provider: "deepseek", model: "test", thinkingEffort: "low" });
  const { turnId } = store.startTurn(state.threadId, userInput);
  store.completeTurn(state.threadId, turnId, { role: "assistant", content: "Done." }, "success");
  const manager = new MemoryManager(storage, { limits });
  const maintenance = new MemoryMaintenance(storage, manager, root);
  const write = (content: string, turn = turnId, scope: "project" | "global" = "project") => manager.applyModelMutations({
    workspaceRoot: root, threadId: state.threadId, turnId: turn, outcome: "success",
    mutations: [{ action: "remember", scope, category: "convention", content, reason: "Agent-selected durable memory" }],
  }).memoryIds[0]!;
  const enqueue = () => maintenance.enqueueCompleted(state.threadId, new Date(Date.now() + 3 * 60_000));
  return { root, storage, state, turnId, manager, maintenance, write, enqueue,
    dispose() { storage.close(); rmSync(root, { recursive: true, force: true }); } };
}

function model(...answers: string[]): ModelProvider & { calls: number } {
  let calls = 0;
  return {
    name: "deepseek", model: "test", get calls() { return calls; },
    async complete() {
      const answer = answers[calls++];
      if (answer === undefined) throw new Error("Unexpected maintenance model call");
      return { message: { role: "assistant", content: answer } };
    },
  };
}

describe("idle memory maintenance", () => {
  it("never creates memory from a completed turn without a write_memory proposal", async () => {
    const f = fixture("以后所有项目的回答都要简洁，用中文说明。");
    try {
      const provider = model();
      assert.equal(f.enqueue(), 0);
      assert.equal(await f.maintenance.processNext(f.state.threadId, f.state, provider), false);
      assert.equal(provider.calls, 0);
      assert.equal(f.manager.list(GLOBAL_MEMORY_WORKSPACE_ID).length, 0);
    } finally { f.dispose(); }
  });

  it("keeps a single agent-written memory without another model request", async () => {
    const f = fixture("Please use concise explanations.");
    try {
      const id = f.write("Use concise explanations across projects.", f.turnId, "global");
      const provider = model();
      assert.equal(f.enqueue(), 1);
      assert.equal(await f.maintenance.processNext(f.state.threadId, f.state, provider), true);
      assert.equal(provider.calls, 0);
      assert.equal(f.manager.get(GLOBAL_MEMORY_WORKSPACE_ID, id)?.status, "active");
      assert.deepEqual(f.storage.db.prepare<[string], { status: string; model_requests: number }>(
        "SELECT status, model_requests FROM memory_maintenance_jobs WHERE turn_id = ?").get(f.turnId),
        { status: "done", model_requests: 0 });
    } finally { f.dispose(); }
  });

  it("merges compatible memories only within the chosen scope", async () => {
    const f = fixture("Inspect the project", {
      ...defaultRuntimeLimits(), memoryConsolidationMatchLimit: 2,
    });
    try {
      const search = f.manager.searchHybrid.bind(f.manager);
      const observedLimits: number[] = [];
      f.manager.searchHybrid = async (workspaceId, query, options = {}) => {
        observedLimits.push(typeof options === "number" ? options : options.limit ?? 0);
        return search(workspaceId, query, options);
      };
      const oldId = f.write("This project uses strict TypeScript.", "turn_seed");
      f.write("This project uses ESLint and strict TypeScript.");
      const provider = model(JSON.stringify({ decisions: [{ index: 0, action: "merge", memoryId: oldId,
        content: "This project uses strict TypeScript and ESLint." }] }));
      f.enqueue();
      assert.equal(await f.maintenance.processNext(f.state.threadId, f.state, provider), true);
      assert.equal(provider.calls, 1);
      assert.deepEqual(observedLimits, [2]);
      assert.equal(f.manager.get(projectMemoryIdFromRoot(f.root), oldId)?.status, "superseded");
      const active = f.manager.list(projectMemoryIdFromRoot(f.root));
      assert.equal(active.length, 1);
      assert.match(active[0]!.content, /ESLint/u);
    } finally { f.dispose(); }
  });

  it("does not merge the same statement across project and global scope", async () => {
    const f = fixture();
    try {
      f.write("Use strict TypeScript across projects.", "turn_seed", "global");
      f.write("Use strict TypeScript across projects.");
      const provider = model();
      f.enqueue();
      await f.maintenance.processNext(f.state.threadId, f.state, provider);
      assert.equal(provider.calls, 0);
      assert.equal(f.manager.list(projectMemoryIdFromRoot(f.root)).length, 1);
      assert.equal(f.manager.list(GLOBAL_MEMORY_WORKSPACE_ID).length, 1);
    } finally { f.dispose(); }
  });

  it("requeues a failed consolidation without adding new memories", async () => {
    const f = fixture();
    try {
      const oldId = f.write("This project uses strict TypeScript.", "turn_seed");
      f.write("This project uses ESLint and strict TypeScript.");
      f.enqueue();
      await f.maintenance.processNext(f.state.threadId, f.state, model("not-json"));
      assert.equal(f.manager.list(projectMemoryIdFromRoot(f.root)).length, 2);
      assert.equal(f.storage.db.prepare<[string], { status: string }>(
        "SELECT status FROM memory_maintenance_jobs WHERE turn_id = ?").get(f.turnId)?.status, "queued");
      await f.maintenance.processNext(f.state.threadId, f.state,
        model(JSON.stringify({ decisions: [{ index: 0, action: "merge", memoryId: oldId,
          content: "This project uses strict TypeScript and ESLint." }] })));
      assert.equal(f.manager.list(projectMemoryIdFromRoot(f.root)).length, 1);
    } finally { f.dispose(); }
  });
});
