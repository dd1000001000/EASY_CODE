import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { EasyCodeApp } from "../src/app.js";
import { Terminal } from "../src/cli/terminal.js";
import { createDefaultEasyCodeConfig } from "../src/config/index.js";
import type { SessionState } from "../src/core/types.js";
import {
  assertPrimaryFolderAvailable,
  checkProjectFolders,
  PrimaryFolderUnavailableError,
} from "../src/projects/availability.js";
import { EASY_CODE_RUNTIME_VERSION, PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH } from "../src/prompt-bundle/generated.js";
import { ensurePromptBundleForTesting } from "../src/prompt-bundle/manager.js";
import { buildSystemPrompt } from "../src/prompts/index.js";
import { createStorage } from "../src/storage/database.js";
import { ProjectIndex } from "../src/web-server/projects.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { MultiRootPathGuard, workspaceRootProblem } from "../src/workspace/path-guard.js";
import { describe, it } from "./harness.js";

const TEST_ENVIRONMENT = [
  "EASY_CODE_CONFIG_DIR",
  "EASY_CODE_DATA_DIR",
  "EASY_CODE_CACHE_DIR",
  "EASY_CODE_PROVIDER",
  "EASY_CODE_WORKSPACE_ROOT",
  "QWEN_API_KEY",
];

class InteractiveOutputTerminal extends Terminal {
  override isInteractive(): boolean {
    return true;
  }
}

/** A project with a primary `web` folder and a second `api` folder. */
function twoFolderProject(root: string) {
  const web = path.join(root, "web");
  const api = path.join(root, "api");
  mkdirSync(web);
  mkdirSync(api);
  const storage = createStorage(path.join(root, "data"));
  const index = new ProjectIndex(storage);
  const project = index.add(web, "App");
  const apiFolder = index.addFolder(project.id, api);
  return { web, api, storage, index, projectId: project.id, apiFolder };
}

describe("project folder availability", () => {
  it("tells why a folder cannot be a workspace root", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-folder-problem-"));
    try {
      const folder = path.join(root, "folder");
      const file = path.join(root, "file.txt");
      mkdirSync(folder);
      writeFileSync(file, "x");
      assert.equal(workspaceRootProblem(folder), undefined);
      assert.equal(workspaceRootProblem(path.join(root, "gone")), "missing");
      assert.equal(workspaceRootProblem(path.join(file, "child")), "missing");
      assert.equal(workspaceRootProblem(file), "not_directory");
      const link = path.join(root, "link");
      symlinkSync(folder, link, process.platform === "win32" ? "junction" : "dir");
      assert.equal(workspaceRootProblem(link), "link");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses paths into a folder that cannot be found instead of using the primary folder", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-folder-guard-"));
    try {
      const web = path.join(root, "web");
      const docs = path.join(root, "docs");
      mkdirSync(path.join(web, "api"), { recursive: true });
      mkdirSync(docs);
      const single = new MultiRootPathGuard([{ key: "web", path: web }], "web", ["api"]);
      assert.throws(() => single.normalizeRelative("api/src/x.ts"), /api cannot be found/u);
      assert.throws(() => single.resolveLexical("./api/x.ts"), /api cannot be found/u);
      assert.equal(single.normalizeRelative("src/x.ts"), "src/x.ts");
      const multi = new MultiRootPathGuard(
        [
          { key: "web", path: web },
          { key: "docs", path: docs },
        ],
        "web",
        ["api"],
      );
      assert.throws(() => multi.normalizeRelative("api/x.ts"), /api cannot be found/u);
      assert.equal(multi.normalizeRelative("docs/a.md"), "docs/a.md");
      assert.equal(multi.normalizeRelative("src/x.ts"), "web/src/x.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("opens a workspace without a missing folder and keeps that folder's history", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-folder-workspace-"));
    const { api, storage, index, projectId, apiFolder } = twoFolderProject(root);
    try {
      rmSync(api, { recursive: true });
      const workspace = await WorkspaceManager.create(index.workspace(projectId));
      assert.deepEqual(
        workspace.folders.map((folder) => folder.key),
        ["web"],
      );
      assert.deepEqual(
        workspace.unavailableFolders.map((folder) => [folder.id, folder.key, folder.problem]),
        [[apiFolder.id, "api", "missing"]],
      );
      assert.deepEqual(
        workspace.memberFolders.map((folder) => folder.key),
        ["web", "api"],
      );
      assert.deepEqual(workspace.writableRoots, [workspace.root]);
      const change = {
        path: "api/server.ts",
        operation: "update" as const,
        beforeHash: "a",
        afterHash: "b",
        source: "file_tool" as const,
        status: "verified" as const,
        timestamp: "2026-10-01T00:00:00.000Z",
      };
      const restored = workspace.restorePersistedState(
        new Map([["api/server.ts", { path: "api/server.ts", hash: "b", readAt: change.timestamp }]]),
        [change],
      );
      assert.equal(restored.restoredChanges, 1);
      assert.equal(restored.staleReadVersions, 1);
      assert.deepEqual(workspace.getChangeSet(), [change]);
    } finally {
      storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a project whose primary folder cannot be found", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-folder-primary-"));
    const { web, storage, index, projectId } = twoFolderProject(root);
    try {
      renameSync(web, `${web}-renamed`);
      const workspace = index.workspace(projectId);
      await assert.rejects(WorkspaceManager.create(workspace), PrimaryFolderUnavailableError);
      assert.throws(
        () => assertPrimaryFolderAvailable(workspace, "zh_cn"),
        (error: unknown) =>
          error instanceof PrimaryFolderUnavailableError &&
          /找不到这个项目的主文件夹 web/u.test(error.message) &&
          /网页的项目编辑/u.test(error.message),
      );
      assert.throws(() => assertPrimaryFolderAvailable(workspace, "en_us", "cli"), /\/workspace primary/u);
    } finally {
      storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks folders that cannot be found in the project list and keeps them out of the primary role", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-folder-index-"));
    const { web, api, storage, index, projectId, apiFolder } = twoFolderProject(root);
    try {
      rmSync(api, { recursive: true });
      let project = index.get(projectId);
      assert.equal(project.ready, true);
      assert.equal(project.primaryUnavailable, false);
      assert.equal(project.folders.find((folder) => folder.id === apiFolder.id)?.unavailable, "missing");
      assert.equal(project.folders.find((folder) => folder.key === "web")?.unavailable, undefined);
      assert.throws(() => index.setPrimaryFolder(projectId, apiFolder.id), /cannot be the primary folder/u);
      const webId = project.primaryFolderId!;
      assert.throws(
        () =>
          index.editProject(projectId, {
            name: "App",
            retainedFolderIds: [apiFolder.id, webId],
            addedFolderPaths: [],
            primaryFolderId: apiFolder.id,
          }),
        /cannot be the primary folder/u,
      );
      // Without an explicit choice, the first folder that can be found becomes primary.
      project = index.editProject(projectId, {
        name: "App",
        retainedFolderIds: [apiFolder.id, webId],
        addedFolderPaths: [],
      });
      assert.equal(project.primaryFolderId, webId);

      rmSync(web, { recursive: true });
      mkdirSync(api);
      project = index.get(projectId);
      assert.equal(project.primaryUnavailable, true);
      assert.equal(project.ready, false);
      index.setPrimaryFolder(projectId, apiFolder.id);
      project = index.get(projectId);
      assert.equal(project.primaryUnavailable, false);
      assert.equal(project.ready, true);
      assert.equal(checkProjectFolders(project.folders).unavailable.length, 1);
    } finally {
      storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tells the model which project folders cannot be found", async () => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), "easy-folder-prompt-"));
    try {
      await ensurePromptBundleForTesting({
        homeDirectory: path.join(temporary, "prompt-home"),
        packagedBundleDirectory: path.resolve("resources", "prompt-bundle"),
        expectedManifestHash: PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH,
        runtimeVersion: EASY_CODE_RUNTIME_VERSION,
      });
      const workspace = path.join(temporary, "workspace");
      await mkdir(workspace, { recursive: true });
      const config = createDefaultEasyCodeConfig(workspace, {
        configDir: path.join(temporary, "config"),
        dataDir: path.join(temporary, "data"),
        cacheDir: path.join(temporary, "cache"),
      });
      const options = {
        config,
        mode: "code" as const,
        workspaceFolders: [{ key: "web", path: workspace }],
        cwd: workspace,
        env: {},
      };
      const prompt = await buildSystemPrompt({
        ...options,
        unavailableWorkspaceFolders: [{ key: "api", path: "D:\\work\\api" }],
      });
      assert.match(prompt, /UNAVAILABLE PROJECT FOLDERS/u);
      assert.match(prompt, /api: D:\\work\\api/u);
      assert.doesNotMatch(await buildSystemPrompt(options), /UNAVAILABLE PROJECT FOLDERS/u);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("leaves a missing folder out before a request and uses it again once it is back", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-folder-app-"));
    const previous = new Map(TEST_ENVIRONMENT.map((name) => [name, process.env[name]]));
    process.env.EASY_CODE_CONFIG_DIR = path.join(root, "config");
    process.env.EASY_CODE_DATA_DIR = path.join(root, "data");
    process.env.EASY_CODE_CACHE_DIR = path.join(root, "cache");
    process.env.EASY_CODE_PROVIDER = "qwen";
    delete process.env.EASY_CODE_WORKSPACE_ROOT;
    process.env.QWEN_API_KEY = "folder-test-key";
    const { web, api, storage, index, projectId } = twoFolderProject(root);
    const workspace = index.workspace(projectId);
    storage.close();
    const output = new PassThrough();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    const terminal = new InteractiveOutputTerminal(new PassThrough(), output);
    let folderNotices = 0;
    Object.assign(terminal, { projectFoldersChanged: () => (folderNotices += 1) });
    let app: EasyCodeApp | undefined;
    try {
      app = await EasyCodeApp.create({
        workspaceRoot: web,
        projectWorkspace: workspace,
        terminal,
        credentialStore: false,
      });
      const internal = app as unknown as {
        workspace: WorkspaceManager;
        state: SessionState;
        threadSessions: { refreshFolderAvailability(): Promise<void> };
      };
      const before = internal.workspace;
      renameSync(api, `${api}-moved`);
      await internal.threadSessions.refreshFolderAvailability();
      assert.notEqual(internal.workspace, before);
      assert.deepEqual(
        internal.workspace.folders.map((folder) => folder.key),
        ["web"],
      );
      assert.throws(() => internal.workspace.pathGuard.normalizeRelative("api/x.ts"), /api cannot be found/u);
      // The project keeps the folder; only this request's workspace leaves it out.
      assert.deepEqual(
        internal.state.workspaceFolders?.map((folder) => folder.key),
        ["web", "api"],
      );
      assert.match(transcript, /Project folder api .* cannot be found: missing or renamed/u);

      const leftOut = internal.workspace;
      await internal.threadSessions.refreshFolderAvailability();
      assert.equal(internal.workspace, leftOut);
      assert.equal(transcript.match(/cannot be found: missing/gu)?.length, 1);
      assert.equal(folderNotices, 1);

      renameSync(`${api}-moved`, api);
      await internal.threadSessions.refreshFolderAvailability();
      assert.deepEqual(
        internal.workspace.folders.map((folder) => folder.key),
        ["web", "api"],
      );
      assert.match(transcript, /Project folder api .* is back in the workspace/u);
      assert.equal(folderNotices, 2);

      renameSync(web, `${web}-moved`);
      await assert.rejects(
        internal.threadSessions.refreshFolderAvailability(),
        /primary folder web .* cannot be found[\s\S]*\/workspace primary/u,
      );
      assert.equal(folderNotices, 3);
      renameSync(`${web}-moved`, web);
    } finally {
      app?.close();
      terminal.close();
      for (const name of TEST_ENVIRONMENT) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
