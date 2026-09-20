import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLastModel, writeLastModel } from "../src/config/last-model.js";
import { createStorage, workspaceIdFromRoot } from "../src/storage/database.js";
import { deleteStoredThreads } from "../src/threads/delete-thread.js";
import type { ThreadSummary } from "../src/threads/thread-store.js";
import { ProjectIndex } from "../src/web-server/projects.js";
import { describe, it } from "./harness.js";

describe("Web project library", () => {
  it("stores project, conversation, and model preferences in the existing database", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-project-test-"));
    const projectRoot = path.join(root, "workspace");
    mkdirSync(projectRoot);
    const storage = createStorage(path.join(root, "data"));
    try {
      const index = new ProjectIndex(storage);
      const project = index.add(projectRoot);
      assert.equal(project.id, workspaceIdFromRoot(realpathSync.native(projectRoot)));
      index.renameProject(project.id, "My project");
      storage.db.prepare(
        `INSERT INTO threads(id, workspace_root, workspace_id, mode, provider, model, created_at, updated_at)
         VALUES (?, ?, ?, 'code', 'glm', 'glm-5.3-flash', ?, ?)`,
      ).run("thread_project_test", projectRoot, project.id, "2026-09-20T00:00:00Z", "2026-09-20T00:00:00Z");
      const thread: ThreadSummary = { id: "thread_project_test", threadId: "thread_project_test",
        workspaceRoot: projectRoot, workspaceId: project.id, mode: "code", provider: "glm",
        model: "glm-5.3-flash", status: "active", createdAt: "2026-09-20T00:00:00Z",
        updatedAt: "2026-09-20T00:00:00Z" };
      index.renameThread(thread, "Custom conversation");
      assert.throws(() => index.renameThread(thread, "Another name"), /already named/iu);
      writeLastModel(storage, { provider: "glm", model: "glm-5.3-flash", thinkingEffort: "high" });
      assert.equal(index.list([thread]).projects[0]?.name, "My project");
      assert.equal(index.list([thread]).threads[0]?.title, "Custom conversation");
      assert.equal(index.list([thread]).threads[0]?.canRename, false);
      assert.equal(readLastModel(storage)?.thinkingEffort, "high");
      assert.equal(existsSync(path.join(root, "data", "projects.json")), false);
      assert.equal(existsSync(path.join(root, "data", "last-model.json")), false);
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("deletes a conversation and its memory without deleting source files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-delete-test-"));
    const projectRoot = path.join(root, "workspace");
    mkdirSync(projectRoot);
    const source = path.join(projectRoot, "keep.txt");
    writeFileSync(source, "keep");
    const storage = createStorage(path.join(root, "data"));
    try {
      const id = "thread_delete_test";
      const workspaceId = workspaceIdFromRoot(projectRoot);
      storage.db.prepare(
        `INSERT INTO threads(id, workspace_root, workspace_id, mode, provider, model, created_at, updated_at)
         VALUES (?, ?, ?, 'code', 'glm', 'glm-5.3-flash', ?, ?)`,
      ).run(id, projectRoot, workspaceId, "2026-09-20T00:00:00Z", "2026-09-20T00:00:00Z");
      storage.db.prepare(
        `INSERT INTO memories(id, workspace_id, scope, category, content, normalized_content,
          source_thread_id, created_at, updated_at) VALUES (?, ?, 'project', 'fact', ?, ?, ?, ?, ?)`,
      ).run("memory_delete_test", workspaceId, "specific memory", "specific memory", id,
        "2026-09-20T00:00:00Z", "2026-09-20T00:00:00Z");
      deleteStoredThreads(storage, [{ threadId: id, workspaceId }]);
      assert.equal(storage.db.prepare<[string], { id: string }>("SELECT id FROM threads WHERE id = ?").get(id), undefined);
      assert.equal(storage.db.prepare<[string], { id: string }>("SELECT id FROM memories WHERE id = ?").get("memory_delete_test"), undefined);
      assert.equal(existsSync(source), true);
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
