import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

import { toResultArtifactRef } from "../src/subagents/coordinator.js";
import { ExecutionEnvironmentManager } from "../src/workspace/execution-environment.js";
import { describe, it } from "./harness.js";

interface GitFixture {
  readonly root: string;
  readonly dataDir: string;
}

describe("ExecutionEnvironmentManager", () => {
  it("falls back to a shared environment for auto isolation outside Git", async () => {
    await withTemporaryDirectory(async (root) => {
      const workspaceRoot = path.join(root, "workspace");
      const dataDir = path.join(root, "data");
      await mkdir(workspaceRoot, { recursive: true });
      await writeFile(path.join(workspaceRoot, "note.txt"), "local\n", "utf8");
      const manager = new ExecutionEnvironmentManager({
        logicalWorkspaceRoot: workspaceRoot,
        dataDir,
        defaultIsolation: "auto",
      });

      const active = await manager.provision({
        agentId: "subagent_auto",
        environmentId: "environment_auto",
      });

      assert.equal(active.descriptor.kind, "shared");
      assert.equal(active.descriptor.requestedIsolation, "auto");
      const canonicalWorkspaceRoot = path.normalize(await realpath(workspaceRoot));
      assert.equal(active.descriptor.executionRoot, path.resolve(workspaceRoot));
      assert.equal(active.workspace.root, canonicalWorkspaceRoot);
      assert.equal(
        (await manager.loadEnvironment("environment_auto")).kind,
        "shared",
      );
    });
  });

  it("rejects explicit worktree isolation outside Git", async () => {
    await withTemporaryDirectory(async (root) => {
      const workspaceRoot = path.join(root, "workspace");
      await mkdir(workspaceRoot, { recursive: true });
      const manager = new ExecutionEnvironmentManager({
        logicalWorkspaceRoot: workspaceRoot,
        dataDir: path.join(root, "data"),
      });

      await assert.rejects(
        manager.provision({
          agentId: "subagent_required",
          environmentId: "environment_required",
          requestedIsolation: "worktree",
        }),
        /requires the workspace to be inside a Git repository/u,
      );
    });
  });

  it("rejects managed Worktree storage anywhere inside the parent Git repository", async () => {
    await withGitFixture(async ({ root, dataDir }) => {
      const nestedWorkspace = path.join(root, "packages", "app");
      await mkdir(nestedWorkspace, { recursive: true });
      const manager = new ExecutionEnvironmentManager({
        logicalWorkspaceRoot: nestedWorkspace,
        dataDir,
        worktreeRoot: path.join(root, ".easy-code-worktrees"),
      });

      await assert.rejects(
        manager.provision({
          agentId: "subagent_nested_storage",
          environmentId: "environment_nested_storage",
          requestedIsolation: "worktree",
        }),
        /outside the complete Git repository/u,
      );
    });
  });

  it("disables repository checkout hooks during Runtime-managed Git operations", async () => {
    await withGitFixture(async ({ root, dataDir }) => {
      const hook = path.join(root, ".git", "hooks", "post-checkout");
      await writeFile(
        hook,
        "#!/bin/sh\nprintf 'hook ran' > \"$PWD/easy-code-hook-ran.txt\"\n",
        "utf8",
      );
      await chmod(hook, 0o755);
      const manager = createManager(root, dataDir);

      const active = await manager.provision({
        agentId: "subagent_no_hooks",
        environmentId: "environment_no_hooks",
        requestedIsolation: "worktree",
      });

      assert.equal(await fileExists(path.join(root, "easy-code-hook-ran.txt")), false);
      assert.equal(
        await fileExists(path.join(active.workspace.root, "easy-code-hook-ran.txt")),
        false,
      );
    });
  });

  it("captures dirty tracked and untracked parent files in the managed worktree baseline", async () => {
    await withGitFixture(async ({ root, dataDir }) => {
      await writeFile(path.join(root, "tracked.txt"), "parent dirty tracked\n", "utf8");
      await writeFile(path.join(root, "untracked.txt"), "parent untracked\n", "utf8");
      const manager = createManager(root, dataDir);

      const active = await manager.provision({
        agentId: "subagent_snapshot",
        environmentId: "environment_snapshot",
        requestedIsolation: "worktree",
      });

      assert.equal(active.descriptor.kind, "worktree");
      assert.notEqual(active.workspace.root, path.resolve(root));
      assert.equal(
        await readFile(path.join(active.workspace.root, "tracked.txt"), "utf8"),
        "parent dirty tracked\n",
      );
      assert.equal(
        await readFile(path.join(active.workspace.root, "untracked.txt"), "utf8"),
        "parent untracked\n",
      );
      assert.ok(active.descriptor.baseCommit);
      assert.ok(active.descriptor.baselineCommit);
      assert.notEqual(active.descriptor.baselineCommit, active.descriptor.baseCommit);
      assert.equal(await git(root, ["status", "--porcelain"]), " M tracked.txt\n?? untracked.txt");
    });
  });

  it("finalizes child-only changes as a durable result artifact", async () => {
    await withGitFixture(async ({ root, dataDir }) => {
      await writeFile(path.join(root, "tracked.txt"), "parent baseline change\n", "utf8");
      await writeFile(path.join(root, "parent-only.txt"), "included baseline\n", "utf8");
      const manager = createManager(root, dataDir);
      const active = await manager.provision({
        agentId: "subagent_finalize",
        environmentId: "environment_finalize",
        requestedIsolation: "worktree",
      });
      await writeFile(
        path.join(active.workspace.root, "tracked.txt"),
        "child result\n",
        "utf8",
      );
      await writeFile(
        path.join(active.workspace.root, "child-only.txt"),
        "new result\n",
        "utf8",
      );

      const artifact = await manager.finalize(active, {
        agentId: "subagent_finalize",
        taskId: "task_finalize",
        accepted: true,
      });
      const saved = await manager.loadArtifact(artifact.id);
      const environment = await manager.loadEnvironment("environment_finalize");

      assert.equal(artifact.environmentKind, "worktree");
      assert.equal(artifact.status, "ready");
      assert.ok(artifact.baseCommit);
      assert.ok(artifact.resultCommit);
      assert.notEqual(artifact.resultCommit, artifact.baseCommit);
      assert.deepEqual(artifact.changedFiles, ["child-only.txt", "tracked.txt"]);
      assert.deepEqual(saved, artifact);
      assert.equal(environment.status, "result_ready");
      assert.equal(environment.resultCommit, artifact.resultCommit);
      assert.equal(
        await readFile(path.join(root, "tracked.txt"), "utf8"),
        "parent baseline change\n",
      );
      assert.equal(await fileExists(path.join(root, "child-only.txt")), false);
    });
  });

  it("restores exact in-progress bytes from a checkpoint after managed cleanup", async () => {
    await withGitFixture(async ({ root, dataDir }) => {
      const manager = createManager(root, dataDir);
      const active = await manager.provision({
        agentId: "subagent_resume",
        environmentId: "environment_resume",
        requestedIsolation: "worktree",
      });
      const expectedTracked = Buffer.from("checkpointed \u2603\r\nsecond line\r\n", "utf8");
      const expectedBinary = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
      await writeFile(path.join(active.workspace.root, "tracked.txt"), expectedTracked);
      await writeFile(path.join(active.workspace.root, "in-progress.bin"), expectedBinary);

      const checkpoint = await manager.checkpoint(active);
      assert.equal(checkpoint.status, "ready");
      assert.ok(checkpoint.resultCommit);
      assert.equal(checkpoint.snapshotRef, "refs/easy-code/environments/environment_resume/result");

      const removed = await manager.cleanup("environment_resume");
      assert.equal(removed.status, "removed");
      assert.equal(await fileExists(active.workspace.root), false);

      const restored = await manager.restore("environment_resume");
      assert.equal(restored.descriptor.status, "result_ready");
      assert.equal(restored.descriptor.resultCommit, checkpoint.resultCommit);
      assert.deepEqual(
        await readFile(path.join(restored.workspace.root, "tracked.txt")),
        expectedTracked,
      );
      assert.deepEqual(
        await readFile(path.join(restored.workspace.root, "in-progress.bin")),
        expectedBinary,
      );
    });
  });

  it("fails closed when a persisted Worktree root is redirected to the main checkout", async () => {
    await withGitFixture(async ({ root, dataDir }) => {
      const manager = createManager(root, dataDir);
      const active = await manager.provision({
        agentId: "subagent_tampered_root",
        environmentId: "environment_tampered_root",
        requestedIsolation: "worktree",
      });
      const saved = await readEnvironmentRecord(dataDir, "environment_tampered_root");
      const tampered = JSON.parse(JSON.stringify(saved)) as EnvironmentRecordFixture;
      tampered.environment.worktreeRoot = root;
      tampered.environment.executionRoot = root;
      await writeEnvironmentRecord(dataDir, "environment_tampered_root", tampered);

      await assert.rejects(
        manager.restore("environment_tampered_root"),
        /managed Worktree root|Runtime-managed environment path/iu,
      );
      await assert.rejects(
        manager.cleanup("environment_tampered_root", true),
        /managed Worktree root|Runtime-managed environment path/iu,
      );
      assert.equal(
        await readFile(path.join(root, "tracked.txt"), "utf8"),
        "committed tracked\n",
      );
      assert.equal(
        path.normalize(await realpath(active.workspace.root)),
        path.normalize(active.workspace.root),
      );

      await writeEnvironmentRecord(dataDir, "environment_tampered_root", saved);
      assert.equal((await manager.cleanup("environment_tampered_root", true)).status, "removed");
    });
  });

  it("rejects arbitrary execution roots in persisted and live descriptors", async () => {
    await withGitFixture(async ({ root, dataDir }) => {
      const manager = createManager(root, dataDir);
      const active = await manager.provision({
        agentId: "subagent_tampered_execution",
        environmentId: "environment_tampered_execution",
        requestedIsolation: "worktree",
      });
      const saved = await readEnvironmentRecord(dataDir, "environment_tampered_execution");
      const tampered = JSON.parse(JSON.stringify(saved)) as EnvironmentRecordFixture;
      tampered.environment.executionRoot = dataDir;
      await writeEnvironmentRecord(dataDir, "environment_tampered_execution", tampered);

      await assert.rejects(
        manager.restore("environment_tampered_execution"),
        /execution root/iu,
      );
      await assert.rejects(
        manager.cleanup("environment_tampered_execution", true),
        /execution root/iu,
      );
      await assert.rejects(
        manager.checkpoint({
          workspace: active.workspace,
          descriptor: {
            ...active.descriptor,
            worktreeRoot: root,
            executionRoot: root,
          },
        }),
        /managed Worktree root|Runtime-managed environment path/iu,
      );

      await writeEnvironmentRecord(dataDir, "environment_tampered_execution", saved);
      assert.equal(
        (await manager.cleanup("environment_tampered_execution", true)).status,
        "removed",
      );
    });
  });

  it("hands a child result to the local workspace without overwriting unrelated user changes", async () => {
    await withGitFixture(async ({ root, dataDir }) => {
      const manager = createManager(root, dataDir);
      const active = await manager.provision({
        agentId: "subagent_handoff",
        environmentId: "environment_handoff",
        requestedIsolation: "worktree",
      });
      await writeFile(
        path.join(active.workspace.root, "tracked.txt"),
        "child delivered result\n",
        "utf8",
      );
      await writeFile(
        path.join(active.workspace.root, "child-created.txt"),
        "created by child\n",
        "utf8",
      );
      const artifact = await manager.finalize(active, {
        agentId: "subagent_handoff",
        taskId: "task_handoff",
        accepted: true,
      });

      await writeFile(
        path.join(root, "unrelated.txt"),
        "user changed this after the child started\n",
        "utf8",
      );
      await writeFile(
        path.join(root, "local-untracked.txt"),
        "keep this local file\n",
        "utf8",
      );
      const delivered = await manager.handoff(artifact, { type: "local" });

      assert.equal(delivered.status, "delivered");
      assert.equal(delivered.delivery, "local");
      assert.ok(delivered.deliveredAt);
      assert.equal(
        await readFile(path.join(root, "tracked.txt"), "utf8"),
        "child delivered result\n",
      );
      assert.equal(
        await readFile(path.join(root, "child-created.txt"), "utf8"),
        "created by child\n",
      );
      assert.equal(
        await readFile(path.join(root, "unrelated.txt"), "utf8"),
        "user changed this after the child started\n",
      );
      assert.equal(
        await readFile(path.join(root, "local-untracked.txt"), "utf8"),
        "keep this local file\n",
      );
      assert.equal(
        (await manager.loadEnvironment("environment_handoff")).status,
        "handed_off",
      );
    });
  });

  it("hands off the complete accumulated DAG result chain from the terminal artifact", async () => {
    await withGitFixture(async ({ root, dataDir }) => {
      const manager = createManager(root, dataDir);
      const upstream = await manager.provision({
        agentId: "subagent_dag_upstream",
        environmentId: "environment_dag_upstream",
        taskId: "task_dag_upstream",
        requestedIsolation: "worktree",
      });
      await writeFile(
        path.join(upstream.workspace.root, "tracked.txt"),
        "changed by the upstream DAG node\n",
        "utf8",
      );
      const upstreamArtifact = await manager.finalize(upstream, {
        agentId: "subagent_dag_upstream",
        taskId: "task_dag_upstream",
        accepted: true,
      });

      const downstream = await manager.provision({
        agentId: "subagent_dag_downstream",
        environmentId: "environment_dag_downstream",
        taskId: "task_dag_downstream",
        requestedIsolation: "worktree",
        dependencyArtifacts: [toResultArtifactRef(upstreamArtifact)],
      });
      assert.equal(
        await readFile(path.join(downstream.workspace.root, "tracked.txt"), "utf8"),
        "changed by the upstream DAG node\n",
      );
      await writeFile(
        path.join(downstream.workspace.root, "dag-downstream.txt"),
        "created by the downstream DAG node\n",
        "utf8",
      );
      const downstreamArtifact = await manager.finalize(downstream, {
        agentId: "subagent_dag_downstream",
        taskId: "task_dag_downstream",
        accepted: true,
        parentArtifactIds: [upstreamArtifact.id],
      });

      assert.equal(downstreamArtifact.baseCommit, upstreamArtifact.baseCommit);
      assert.deepEqual(downstreamArtifact.parentArtifactIds, [upstreamArtifact.id]);
      assert.deepEqual(downstreamArtifact.changedFiles, [
        "dag-downstream.txt",
        "tracked.txt",
      ]);

      const delivered = await manager.handoff(downstreamArtifact, { type: "local" });
      assert.equal(delivered.status, "delivered");
      assert.equal(
        await readFile(path.join(root, "tracked.txt"), "utf8"),
        "changed by the upstream DAG node\n",
      );
      assert.equal(
        await readFile(path.join(root, "dag-downstream.txt"), "utf8"),
        "created by the downstream DAG node\n",
      );
    });
  });
});

function createManager(root: string, dataDir: string): ExecutionEnvironmentManager {
  return new ExecutionEnvironmentManager({
    logicalWorkspaceRoot: root,
    dataDir,
    defaultIsolation: "auto",
    baseMode: "current-snapshot",
    worktreeRoot: path.join(dataDir, "worktrees"),
  });
}

async function withGitFixture(run: (fixture: GitFixture) => Promise<void>): Promise<void> {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const root = path.join(temporaryRoot, "repository");
    const dataDir = path.join(temporaryRoot, "runtime-data");
    await mkdir(root, { recursive: true });
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "EASY CODE Test"]);
    await git(root, ["config", "user.email", "easy-code-test@example.invalid"]);
    await git(root, ["config", "core.autocrlf", "false"]);
    await writeFile(path.join(root, "tracked.txt"), "committed tracked\n", "utf8");
    await writeFile(path.join(root, "unrelated.txt"), "committed unrelated\n", "utf8");
    await git(root, ["add", "--", "."]);
    await git(root, ["commit", "--no-gpg-sign", "-m", "fixture baseline"]);
    await run({ root, dataDir });
  });
}

async function withTemporaryDirectory(run: (root: string) => Promise<void>): Promise<void> {
  const createdRoot = await mkdtemp(path.join(os.tmpdir(), "easy-code-env-test-"));
  const temporaryRoot = path.normalize(await realpath(createdRoot));
  try {
    await run(temporaryRoot);
  } finally {
    const canonicalTemporaryBase = path.normalize(await realpath(os.tmpdir()));
    const relative = path.relative(canonicalTemporaryBase, temporaryRoot);
    assert.ok(
      relative &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        path.basename(temporaryRoot).startsWith("easy-code-env-test-"),
      `Refusing to remove unexpected test path: ${temporaryRoot}`,
    );
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", [...args], {
    cwd,
    reject: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? "command"} failed: ${String(result.stderr || result.stdout)}`,
    );
  }
  return String(result.stdout ?? "").replace(/\r\n/gu, "\n");
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await readFile(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface EnvironmentRecordFixture {
  schemaVersion: number;
  environment: {
    worktreeRoot?: string;
    executionRoot: string;
    [key: string]: unknown;
  };
}

async function readEnvironmentRecord(
  dataDir: string,
  environmentId: string,
): Promise<EnvironmentRecordFixture> {
  return JSON.parse(
    await readFile(
      path.join(dataDir, "subagent-environments", `${environmentId}.json`),
      "utf8",
    ),
  ) as EnvironmentRecordFixture;
}

async function writeEnvironmentRecord(
  dataDir: string,
  environmentId: string,
  record: EnvironmentRecordFixture,
): Promise<void> {
  await writeFile(
    path.join(dataDir, "subagent-environments", `${environmentId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}
