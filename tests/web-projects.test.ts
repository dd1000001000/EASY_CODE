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
      assert.match(project.id, /^project_[0-9a-f-]{36}$/u);
      assert.equal(project.ready, true);
      assert.equal(project.folders.length, 1);
      assert.equal(project.folders[0]?.path, realpathSync.native(projectRoot));
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

  it("creates empty projects and revisions a stable multi-folder membership", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-multi-project-test-"));
    const first = path.join(root, "frontend");
    const second = path.join(root, "backend");
    const nested = path.join(first, "nested");
    mkdirSync(first); mkdirSync(second); mkdirSync(nested);
    const storage = createStorage(path.join(root, "data"));
    try {
      const index = new ProjectIndex(storage);
      const empty = index.create("Application");
      assert.equal(empty.ready, false);
      assert.equal(empty.root, "");
      assert.equal(empty.workspaceRevision, 1);
      const firstFolder = index.addFolder(empty.id, first);
      const secondFolder = index.addFolder(empty.id, second);
      let project = index.get(empty.id);
      assert.equal(project.workspaceRevision, 3);
      assert.equal(project.primaryFolderId, firstFolder.id);
      assert.deepEqual(project.folders.filter(folder => folder.active).map(folder => folder.key), ["frontend", "backend"]);
      assert.throws(() => index.addFolder(empty.id, nested), /cannot contain one another/iu);
      const other = index.add(first);
      assert.notEqual(other.id, empty.id, "the same physical folder may belong to another logical project");

      index.setPrimaryFolder(empty.id, secondFolder.id);
      index.removeFolder(empty.id, firstFolder.id);
      project = index.get(empty.id);
      assert.equal(project.primaryFolderId, secondFolder.id);
      assert.equal(project.folders.find(folder => folder.id === firstFolder.id)?.active, false);
      const restored = index.addFolder(empty.id, first);
      assert.equal(restored.id, firstFolder.id);
      assert.equal(restored.key, firstFolder.key);
      assert.equal(index.workspace(empty.id).revision, 6);
    } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("atomically edits a project name, folder set, order, and primary folder", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-project-edit-test-"));
    const first = path.join(root, "frontend");
    const second = path.join(root, "backend");
    const third = path.join(root, "docs");
    const nested = path.join(second, "nested");
    mkdirSync(first); mkdirSync(second); mkdirSync(third); mkdirSync(nested);
    const storage = createStorage(path.join(root, "data"));
    try {
      const index = new ProjectIndex(storage);
      const project = index.create("Application");
      const firstFolder = index.addFolder(project.id, first);
      const secondFolder = index.addFolder(project.id, second);
      const before = index.get(project.id).workspaceRevision;
      const edited = index.editProject(project.id, {
        name: "Product suite",
        retainedFolderIds: [secondFolder.id],
        addedFolderPaths: [third],
        primaryFolderPath: third,
      });
      assert.equal(edited.name, "Product suite");
      assert.equal(edited.workspaceRevision, before + 1, "a multi-change save uses one workspace revision");
      assert.deepEqual(edited.folders.filter(folder => folder.active).map(folder => folder.path),
        [realpathSync.native(second), realpathSync.native(third)]);
      assert.equal(edited.folders.find(folder => folder.id === firstFolder.id)?.active, false);
      assert.equal(edited.folders.find(folder => folder.id === edited.primaryFolderId)?.path, realpathSync.native(third));
      assert.throws(() => index.editProject(project.id, {
        name: "Invalid", retainedFolderIds: [secondFolder.id], addedFolderPaths: [nested],
      }), /cannot contain one another/iu);
      assert.equal(index.get(project.id).name, "Product suite", "a rejected edit is not partially applied");
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
