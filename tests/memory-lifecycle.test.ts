import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { memoryFreshnessWeight } from "../src/memory/lifecycle.js";
import { MemoryManager, GLOBAL_MEMORY_WORKSPACE_ID, projectMemoryIdFromRoot } from "../src/memory/memory-manager.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";

const DAY_MS = 86_400_000;

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-memory-life-"));
  const storage = createStorage(path.join(root, "data"));
  const limits = { ...defaultRuntimeLimits(), memoryProjectExpiryDays: 90, memoryGlobalExpiryDays: 180 };
  const manager = new MemoryManager(storage, { limits });
  return { root, storage, manager, limits, dispose() {
    storage.close(); rmSync(root, { recursive: true, force: true });
  } };
}

describe("long-term memory lifecycle", () => {
  it("uses quadratic decay, slow first and faster later", () => {
    const now = Date.UTC(2026, 8, 19);
    const at = (days: number) => new Date(now - days * DAY_MS).toISOString();
    assert.equal(memoryFreshnessWeight(null, at(0), 90, now), 1);
    assert.equal(memoryFreshnessWeight(null, at(30), 90, now), 1 - (1 / 3) ** 2);
    assert.equal(memoryFreshnessWeight(null, at(60), 90, now), 1 - (2 / 3) ** 2);
    assert.equal(memoryFreshnessWeight(null, at(90), 90, now), 0);
    assert.equal(memoryFreshnessWeight(null, at(180), 180, now), 0);
  });

  it("does not renew search candidates; genuine recall is once per turn", () => {
    const f = fixture();
    try {
      const created = f.manager.applyModelMutations({ workspaceId: "workspace_project", threadId: "thread_1",
        turnId: "turn_1", outcome: "success", mutations: [{ action: "remember", category: "convention",
          content: "Use strict TypeScript settings in this repository.", reason: "User convention" }] });
      const id = created.memoryIds[0]!;
      assert.equal(f.manager.search("workspace_project", "strict TypeScript").length, 1);
      assert.equal(f.storage.db.prepare<[string], { access_count: number }>(
        "SELECT access_count FROM memories WHERE id = ?").get(id)?.access_count, 0);
      f.manager.recordRecall("thread_1", "turn_2", [id, id]);
      f.manager.recordRecall("thread_1", "turn_2", [id]);
      assert.equal(f.storage.db.prepare<[string], { access_count: number }>(
        "SELECT access_count FROM memories WHERE id = ?").get(id)?.access_count, 1);
      f.manager.recordRecall("thread_1", "turn_3", [id]);
      assert.equal(f.storage.db.prepare<[string], { access_count: number }>(
        "SELECT access_count FROM memories WHERE id = ?").get(id)?.access_count, 2);
    } finally { f.dispose(); }
  });

  it("renews an exact existing memory on user confirmation without rewriting the record", () => {
    const f = fixture();
    try {
      const state = new ThreadStore(f.storage).create({ threadId: "thread_confirmation",
        workspaceRoot: f.root, mode: "code", provider: "deepseek", model: "test", thinkingEffort: "low" });
      const content = "The user prefers concise Chinese explanations.";
      const first = f.manager.applyModelMutations({ workspaceRoot: f.root,
        threadId: state.threadId, turnId: "turn_initial", outcome: "success",
        mutations: [{ action: "remember", category: "preference", content,
          reason: "Explicit user preference" }] });
      const id = first.memoryIds[0]!;
      const confirmed = f.manager.applyModelMutations({ workspaceRoot: f.root,
        threadId: state.threadId, turnId: "turn_confirmed", outcome: "success",
        mutations: [{ action: "remember", category: "preference", content,
          reason: "User confirmed the same preference" }] });
      assert.equal(confirmed.applied, 0);
      assert.equal(f.manager.get(projectMemoryIdFromRoot(f.root), id)?.status, "active");
      assert.equal(f.storage.db.prepare<[string], { access_count: number }>(
        "SELECT access_count FROM memories WHERE id = ?").get(id)?.access_count, 1);
    } finally { f.dispose(); }
  });

  it("ranks a fresh equally relevant record ahead of an old one", async () => {
    const f = fixture();
    try {
      const created = f.manager.applyModelMutations({ workspaceId: "workspace_project", threadId: "thread_rank",
        turnId: "turn_rank", outcome: "success", mutations: [
          { action: "remember", category: "convention", content: "TypeScript files use a strict compiler.", reason: "Rule A" },
          { action: "remember", category: "convention", content: "TypeScript files use a strict linter.", reason: "Rule B" },
        ] });
      f.storage.db.prepare("UPDATE memories SET created_at = ?, last_accessed_at = NULL WHERE id = ?")
        .run(new Date(Date.now() - 80 * DAY_MS).toISOString(), created.memoryIds[0]!);
      const lexical = f.manager.search("workspace_project", "TypeScript files use strict");
      assert.equal(lexical[0]?.id, created.memoryIds[1]);
      const consolidationLexical = f.manager.search(
        "workspace_project",
        "TypeScript files use strict",
        { ranking: "consolidation" },
      );
      assert.equal(consolidationLexical[0]?.id, created.memoryIds[0]);
      const consolidationFallback = await f.manager.searchHybrid(
        "workspace_project",
        "TypeScript files use strict",
        { ranking: "consolidation" },
      );
      assert.equal(consolidationFallback[0]?.id, created.memoryIds[0]);
      const hybridManager = new MemoryManager(f.storage, { limits: f.limits,
        vectorIndex: { async search() { return [
          { id: created.memoryIds[0]!, score: 1 },
          { id: created.memoryIds[1]!, score: 0.35 },
        ]; } } });
      const hybrid = await hybridManager.searchHybrid("workspace_project", "TypeScript files use strict");
      assert.equal(hybrid[0]?.id, created.memoryIds[1]);
      const consolidationHybrid = await hybridManager.searchHybrid(
        "workspace_project",
        "TypeScript files use strict",
        { ranking: "consolidation" },
      );
      assert.equal(consolidationHybrid[0]?.id, created.memoryIds[0]);
    } finally { f.dispose(); }
  });

  it("soft-expires project at 90 days and global at 180 without deleting evidence or revival", async () => {
    const f = fixture();
    try {
      const created = f.manager.applyModelMutations({ workspaceId: "workspace_project", threadId: "thread_1",
        turnId: "turn_1", outcome: "success", mutations: [
          { action: "remember", category: "convention", content: "Project uses strict TypeScript.", reason: "Project rule" },
          { action: "remember", scope: "global", category: "preference",
            content: "The user prefers concise explanations.", reason: "Global preference" },
        ] });
      const old = new Date(Date.now() - 91 * DAY_MS).toISOString();
      for (const id of created.memoryIds) f.storage.db.prepare(
        "UPDATE memories SET created_at = ?, last_accessed_at = NULL WHERE id = ?").run(old, id);
      assert.equal(f.manager.expireDueMemories("workspace_project"), 1);
      assert.equal(f.manager.get("workspace_project", created.memoryIds[0]!)?.status, "expired");
      assert.equal(f.manager.get(GLOBAL_MEMORY_WORKSPACE_ID, created.memoryIds[1]!)?.status, "active");
      assert.equal((await f.manager.searchScoped("workspace_project", "strict TypeScript")).length, 0);
      assert.equal(f.manager.list("workspace_project", { status: "all" }).length, 1);
      assert.ok(f.storage.db.prepare<[string], { sequence: number }>(
        "SELECT sequence FROM memory_revisions WHERE memory_id = ? ORDER BY sequence DESC LIMIT 1")
        .get(created.memoryIds[0]!)?.sequence);
      f.limits.memoryProjectExpiryDays = 365;
      assert.equal(f.manager.expireDueMemories("workspace_project"), 0);
      assert.equal(f.manager.get("workspace_project", created.memoryIds[0]!)?.status, "expired");
    } finally { f.dispose(); }
  });
});
