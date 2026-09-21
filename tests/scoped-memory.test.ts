import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { selectMemoryContext } from "../src/context/memory-controller.js";
import { MemoryManager, GLOBAL_MEMORY_WORKSPACE_ID, projectMemoryIdFromRoot } from "../src/memory/memory-manager.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-scoped-memory-"));
  const a = path.join(root, "alpha");
  const nested = path.join(a, "src");
  const b = path.join(root, "beta");
  mkdirSync(path.join(a, ".git"), { recursive: true });
  mkdirSync(nested);
  mkdirSync(path.join(b, ".git"), { recursive: true });
  const storage = createStorage(path.join(root, "data"));
  const manager = new MemoryManager(storage);
  return { root, a, b, nested, storage, manager,
    dispose() { storage.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("global and project long-term memory", () => {
  it("shares a project across nested workspaces while isolating different project directories", async () => {
    const f = fixture();
    try {
      const aId = projectMemoryIdFromRoot(f.a);
      assert.equal(projectMemoryIdFromRoot(f.nested), aId);
      assert.notEqual(projectMemoryIdFromRoot(f.b), aId);
      f.manager.applyModelMutations({ workspaceRoot: f.nested, threadId: "thread_alpha", turnId: "turn_alpha",
        outcome: "success", mutations: [{ action: "remember", category: "convention",
          content: "Alpha uses the native HTTP server.", reason: "Project convention." }] });
      f.manager.applyModelMutations({ workspaceRoot: f.b, threadId: "thread_beta", turnId: "turn_beta",
        outcome: "success", mutations: [{ action: "remember", category: "convention",
          content: "Beta uses a separate worker queue.", reason: "Project convention." }] });
      f.manager.applyModelMutations({ workspaceRoot: f.a, threadId: "thread_alpha", turnId: "turn_global",
        outcome: "success", mutations: [{ action: "remember", scope: "global", category: "preference",
          content: "The user prefers concise Chinese explanations.", reason: "Explicit user preference." }] });

      const alpha = await f.manager.searchScoped(aId, "native HTTP server", { workspaceRoot: f.a });
      assert.equal(alpha[0]?.scope, "project");
      assert.match(alpha[0]?.content ?? "", /Alpha/u);
      const beta = await f.manager.searchScoped(projectMemoryIdFromRoot(f.b), "native HTTP server", { workspaceRoot: f.b });
      assert.equal(beta.some(item => item.content.includes("Alpha")), false);
      assert.equal(f.manager.listScoped(aId, "global").length, 1);
      assert.equal(f.manager.listScoped(projectMemoryIdFromRoot(f.b), "global").length, 1);
      assert.equal(f.manager.listScoped(aId, "project").length, 1);
      assert.equal(f.manager.listScoped(projectMemoryIdFromRoot(f.b), "project").length, 1);
      assert.equal(f.manager.list(GLOBAL_MEMORY_WORKSPACE_ID)[0]?.scope, "global");
    } finally { f.dispose(); }
  });

  it("keeps a small global preference available when the current query has no matching terms", async () => {
    const f = fixture();
    try {
      f.manager.applyModelMutations({ workspaceRoot: f.a, threadId: "thread_alpha", turnId: "turn_global",
        outcome: "success", mutations: [{ action: "remember", scope: "global", category: "preference",
          content: "The user prefers concise Chinese explanations.", reason: "Explicit user preference." }] });
      const found = await f.manager.searchScoped(projectMemoryIdFromRoot(f.a), "database migration", {
        workspaceRoot: f.a, includeGlobalPreferences: true,
      });
      const state = new ThreadStore(f.storage).create({ threadId: "thread_scoped", workspaceRoot: f.a,
        mode: "code", provider: "deepseek", model: "test", thinkingEffort: "low" });
      const selected = selectMemoryContext({ state, memories: found, evidence: [],
        tokenBudget: 1000 });
      assert.equal(selected.memories.length, 1);
      assert.equal(selected.memories[0]?.scope, "global");
    } finally { f.dispose(); }
  });

  it("moves only the named memory, preserves its ID, and can expire it without affecting other projects", async () => {
    const f = fixture();
    try {
      const created = f.manager.applyModelMutations({ workspaceRoot: f.a, threadId: "thread_alpha", turnId: "turn_1",
        outcome: "success", mutations: [{ action: "remember", category: "preference",
          content: "The user prefers short commit messages.", reason: "User preference." }] });
      const id = created.memoryIds[0]!;
      const moved = f.manager.applyModelMutations({ workspaceRoot: f.a, threadId: "thread_alpha", turnId: "turn_2",
        outcome: "success", mutations: [{ action: "move", memoryId: id, scope: "global", reason: "Explicit scope change." }] });
      assert.equal(moved.applied, 1);
      assert.equal(f.manager.getAccessible(projectMemoryIdFromRoot(f.b), id)?.scope, "global");
      assert.equal(f.manager.get(projectMemoryIdFromRoot(f.a), id), undefined);
      assert.equal((await f.manager.searchScoped(projectMemoryIdFromRoot(f.a), "short commit messages",
        { scope: "project" })).length, 0);
      assert.equal((await f.manager.searchScoped(projectMemoryIdFromRoot(f.b), "short commit messages",
        { scope: "global" }))[0]?.id, id);
      const forgotten = f.manager.applyModelMutations({ workspaceRoot: f.b, threadId: "thread_beta", turnId: "turn_3",
        outcome: "success", mutations: [{ action: "forget", memoryId: id, scope: "global",
          reason: "Explicitly forgotten." }] });
      assert.equal(forgotten.applied, 1);
      assert.equal(f.manager.listScoped(projectMemoryIdFromRoot(f.a), "global").length, 0);
      assert.equal(f.manager.get(GLOBAL_MEMORY_WORKSPACE_ID, id)?.status, "expired");
      assert.equal((await f.manager.searchScoped(projectMemoryIdFromRoot(f.b), "short commit messages",
        { scope: "global" })).length, 0);
    } finally { f.dispose(); }
  });

  it("uses the model-selected global scope without a keyword gate", () => {
    const f = fixture();
    try {
      const state = new ThreadStore(f.storage).create({ threadId: "thread_global_source", workspaceRoot: f.a,
        mode: "code", provider: "deepseek", model: "test", thinkingEffort: "low" });
      const base = { workspaceRoot: f.a, threadId: state.threadId,
        turnId: "turn_global_source", outcome: "success" as const };
      const selected = f.manager.applyModelMutations({ ...base, mutations: [{ action: "remember",
        scope: "global", category: "preference", content: "The user prefers concise answers.",
        reason: "Model-selected global memory." }] });
      assert.equal(selected.applied, 1);
      const accepted = f.manager.applyModelMutations({ ...base,
        mutations: [{ action: "remember", scope: "global", category: "preference",
          content: "The user prefers concise answers in every project.",
          reason: "Current user preference." }] });
      assert.equal(accepted.applied, 1);
      assert.equal(f.manager.get(GLOBAL_MEMORY_WORKSPACE_ID, accepted.memoryIds[0]!)?.scope, "global");
    } finally { f.dispose(); }
  });
});
