import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { MemoryManager } from "../src/memory/index.js";
import { createStorage } from "../src/storage/index.js";

function temporaryDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "easy-code-memory-"));
}

describe("MemoryManager", () => {
  it("captures conservative stable memories and retrieves only the workspace scope", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const manager = new MemoryManager(storage);
      const captured = manager.captureFromTurn({
        workspaceId: "workspace_a",
        threadId: "thread_a",
        turnId: "turn_a",
        completed: true,
        outcome: "success",
        assistantEvidence: true,
        userMessage: "以后统一使用 TypeScript strict 模式，并默认使用 npm。",
        assistantMessage: "项目架构入口模块位于 src/index.ts。",
      });
      assert.ok(captured.length >= 2);
      assert.equal(Object.isFrozen(captured), true);
      assert.equal(Object.isFrozen(captured[0]), true);

      const results = manager.search("workspace_a", "TypeScript", 5);
      assert.ok(results.some((memory) => memory.content.includes("TypeScript")));
      assert.equal(manager.search("workspace_b", "TypeScript").length, 0);
      assert.equal(manager.list("workspace_a").length, captured.length);

      manager.captureFromTurn({
        workspaceId: "workspace_a",
        threadId: "thread_a",
        turnId: "turn_b",
        userMessage: "以后统一使用 TypeScript strict 模式，并默认使用 npm。",
        assistantMessage: "完成。",
      });
      assert.equal(manager.list("workspace_a").length, captured.length);
      assert.ok(manager.search("workspace_a", "TypeScript")[0]!.confidence > 0.84);

      const ftsCount = storage.db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM memories_fts",
        )
        .get()?.count;
      assert.equal(ftsCount, captured.length);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not capture incomplete, uncertain, one-off, or sensitive text", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const manager = new MemoryManager(storage);
      assert.equal(
        manager.captureFromTurn({
          workspaceId: "workspace_a",
          threadId: "thread_a",
          turnId: "turn_a",
          completed: false,
          userMessage: "以后总是使用 npm。",
          assistantMessage: "done",
        }).length,
        0,
      );
      assert.equal(
        manager.captureFromTurn({
          workspaceId: "workspace_a",
          threadId: "thread_a",
          turnId: "turn_b",
          userMessage: "以后使用 api_key=sk-abcdefghijklmnop。",
          assistantMessage: "可能项目架构入口位于 src/index.ts。",
        }).length,
        0,
      );
      assert.equal(manager.list("workspace_a").length, 0);

      const withoutEvidence = manager.captureFromTurn({
        workspaceId: "workspace_a",
        threadId: "thread_a",
        turnId: "turn_c",
        completed: true,
        outcome: "success",
        userMessage: "请检查项目。",
        assistantMessage: "项目架构入口模块位于 src/index.ts。",
      });
      assert.equal(withoutEvidence.length, 0);

      const publicSurface = manager as unknown as Record<string, unknown>;
      assert.equal(publicSurface.create, undefined);
      assert.equal(publicSurface.update, undefined);
      assert.equal(publicSurface.delete, undefined);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
