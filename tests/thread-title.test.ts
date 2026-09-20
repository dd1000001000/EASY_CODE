import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/core/types.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadTitleStore } from "../src/threads/thread-title.js";
import { NameThreadTool } from "../src/tools/name-thread.js";
import { bindBuiltinToolMetadata, evaluateToolPolicy } from "../src/tools/capabilities.js";
import { describe, it } from "./harness.js";

describe("one-time Thread naming", () => {
  it("allows exactly one claim across independent database connections", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-thread-title-"));
    const first = createStorage(root);
    const second = createStorage(root);
    try {
      first.db.prepare(
        `INSERT INTO threads(id, workspace_root, workspace_id, mode, provider, model, created_at, updated_at)
         VALUES (?, ?, ?, 'code', 'glm', 'test', ?, ?)`,
      ).run("thread_named", root, "workspace_test", "2026-09-20T00:00:00Z", "2026-09-20T00:00:00Z");
      const user = new ThreadTitleStore(first);
      const agent = new ThreadTitleStore(second);
      assert.equal(user.isUnclaimed("thread_named"), true);
      assert.throws(() => user.claim("thread_named", "api_key=super-secret-token"), /credentials/iu);
      assert.equal(user.isUnclaimed("thread_named"), true);
      assert.equal(user.claim("thread_named", "Inspect backend"), true);
      assert.equal(agent.claim("thread_named", "Overwrite"), false);
      assert.equal(agent.isUnclaimed("thread_named"), false);
      assert.equal(first.db.prepare<[string], { title: string }>(
        "SELECT title FROM threads WHERE id = ?").get("thread_named")?.title, "Inspect backend");
    } finally { second.close(); first.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("binds the tool to the current main-agent Thread in all three modes without approval", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-thread-tool-"));
    const storage = createStorage(root);
    try {
      storage.db.prepare(
        `INSERT INTO threads(id, workspace_root, workspace_id, mode, provider, model, created_at, updated_at)
         VALUES (?, ?, ?, 'code', 'glm', 'test', ?, ?)`,
      ).run("thread_agent", root, "workspace_test", "2026-09-20T00:00:00Z", "2026-09-20T00:00:00Z");
      const tool = bindBuiltinToolMetadata(new NameThreadTool(new ThreadTitleStore(storage)));
      for (const mode of ["plan", "auto", "code"] as const) {
        assert.deepEqual(evaluateToolPolicy(tool, { mode, role: "main_agent", orchestrationAvailable: false }),
          { available: true, requiresApproval: false });
      }
      assert.equal(evaluateToolPolicy(tool, { mode: "code", role: "subagent", orchestrationAvailable: false }).available, false);
      const context = { threadId: "thread_agent", agentRole: "main_agent" } as ToolContext;
      const first = await tool.execute({ title: "Summarize the repository" }, context);
      assert.equal(first.ok, true);
      assert.equal((await tool.execute({ title: "Another title" }, context)).ok, false);
      assert.equal(storage.db.prepare<[string], { title: string }>(
        "SELECT title FROM threads WHERE id = ?").get("thread_agent")?.title, "Summarize the repository");
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
