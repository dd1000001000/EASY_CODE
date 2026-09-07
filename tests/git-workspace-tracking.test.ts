import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(root: string, args: readonly string[]): Promise<void> {
  const result = await execa("git", args, { cwd: root, reject: false });
  assert.equal(result.exitCode, 0, result.stderr || `git ${args.join(" ")} failed`);
}

async function withWorkspace(
  gitRepository: boolean,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-git-tracking-"));
  try {
    if (gitRepository) {
      await git(root, ["init", "--quiet"]);
      await git(root, ["config", "user.name", "EASY CODE Test"]);
      await git(root, ["config", "user.email", "easy-code@example.invalid"]);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Git-aware workspace change tracking", () => {
  it("hashes only Git-relevant command candidates and preserves real source deltas", async () => {
    await withWorkspace(true, async (root) => {
      await mkdir(path.join(root, "src"));
      await Promise.all([
        writeFile(path.join(root, ".gitignore"), "__pycache__/\n", "utf8"),
        writeFile(path.join(root, "src", "clean.ts"), "clean before\n", "utf8"),
        writeFile(path.join(root, "src", "dirty.ts"), "committed\n", "utf8"),
        writeFile(path.join(root, "src", "deleted.ts"), "delete me\n", "utf8"),
      ]);
      await git(root, ["add", "."]);
      await git(root, ["commit", "--quiet", "-m", "initial"]);

      const manager = await WorkspaceManager.create(root);
      await writeFile(path.join(root, "src", "dirty.ts"), "dirty before command\n", "utf8");
      const baseline = await manager.beginCommandChangeTracking();
      assert.equal(baseline.kind, "git");

      await Promise.all([
        writeFile(path.join(root, "src", "clean.ts"), "clean after\n", "utf8"),
        writeFile(path.join(root, "src", "dirty.ts"), "dirty after command\n", "utf8"),
        rm(path.join(root, "src", "deleted.ts")),
        writeFile(path.join(root, "src", "created.ts"), "created\n", "utf8"),
      ]);
      await mkdir(path.join(root, "__pycache__"));
      await writeFile(path.join(root, "__pycache__", "cache.pyc"), "cache", "utf8");

      const delta = await manager.completeCommandChangeTracking(baseline);
      assert.deepEqual(delta.created.map((entry) => entry.path), ["src/created.ts"]);
      assert.deepEqual(delta.updated.map((entry) => entry.after.path), [
        "src/clean.ts",
        "src/dirty.ts",
      ]);
      assert.deepEqual(delta.deleted.map((entry) => entry.path), ["src/deleted.ts"]);
      assert.equal(delta.truncated, false);

      const clean = delta.updated.find((entry) => entry.after.path === "src/clean.ts");
      const dirty = delta.updated.find((entry) => entry.after.path === "src/dirty.ts");
      assert.equal(clean?.before.hash, hash("clean before\n"));
      assert.equal(clean?.after.hash, hash("clean after\n"));
      assert.equal(dirty?.before.hash, hash("dirty before command\n"));
      assert.equal(dirty?.after.hash, hash("dirty after command\n"));
      assert.match(clean?.before.hash ?? "", /^[a-f0-9]{64}$/u);
      assert.equal(manager.getManifestSnapshot()?.files.has("__pycache__/cache.pyc"), false);
    });
  });

  it("captures meaningful ignored local config but prunes ignored transient trees", async () => {
    await withWorkspace(true, async (root) => {
      await writeFile(
        path.join(root, ".gitignore"),
        [".env", ".local/", "node_modules/", "__pycache__/", "dist/", ""].join("\n"),
        "utf8",
      );
      await writeFile(path.join(root, "tracked.ts"), "tracked\n", "utf8");
      await git(root, ["add", "."]);
      await git(root, ["commit", "--quiet", "-m", "initial"]);
      await Promise.all([
        mkdir(path.join(root, ".local")),
        mkdir(path.join(root, "node_modules")),
        mkdir(path.join(root, "__pycache__")),
        mkdir(path.join(root, "dist")),
      ]);
      await Promise.all([
        writeFile(path.join(root, ".env"), "TOKEN=before\n", "utf8"),
        writeFile(path.join(root, ".local", "delete.json"), "delete\n", "utf8"),
        writeFile(path.join(root, "node_modules", "dependency.js"), "before\n", "utf8"),
      ]);
      const manager = await WorkspaceManager.create(root);
      const baseline = await manager.beginCommandChangeTracking();

      await Promise.all([
        writeFile(path.join(root, ".env"), "TOKEN=after\n", "utf8"),
        rm(path.join(root, ".local", "delete.json")),
        writeFile(path.join(root, ".local", "created.json"), "created\n", "utf8"),
        writeFile(path.join(root, "node_modules", "dependency.js"), "after\n", "utf8"),
        writeFile(path.join(root, "__pycache__", "cache.pyc"), "cache\n", "utf8"),
        writeFile(path.join(root, "dist", "bundle.js"), "bundle\n", "utf8"),
      ]);
      const delta = await manager.completeCommandChangeTracking(baseline);

      assert.deepEqual(delta.created.map((entry) => entry.path), [".local/created.json"]);
      assert.deepEqual(delta.updated.map((entry) => entry.after.path), [".env"]);
      assert.deepEqual(delta.deleted.map((entry) => entry.path), [".local/delete.json"]);
      assert.equal(delta.updated[0]?.before.hash, hash("TOKEN=before\n"));
      assert.equal(delta.updated[0]?.after.hash, hash("TOKEN=after\n"));
      for (const transient of [
        "node_modules/dependency.js",
        "__pycache__/cache.pyc",
        "dist/bundle.js",
      ]) {
        assert.equal(manager.getManifestSnapshot()?.files.has(transient), false);
      }

      await Promise.all([
        writeFile(path.join(root, ".env"), "TOKEN=checkpoint\n", "utf8"),
        rm(path.join(root, ".local", "created.json")),
        writeFile(path.join(root, ".local", "checkpoint.json"), "checkpoint\n", "utf8"),
        writeFile(path.join(root, "dist", "late-bundle.js"), "late\n", "utf8"),
      ]);
      const consistency = await manager.fullConsistencyCheck();
      assert.deepEqual(consistency.created.map((entry) => entry.path), [
        ".local/checkpoint.json",
      ]);
      assert.deepEqual(consistency.updated.map((entry) => entry.after.path), [".env"]);
      assert.deepEqual(consistency.deleted.map((entry) => entry.path), [
        ".local/created.json",
      ]);
      assert.equal(manager.getManifestSnapshot()?.files.has("dist/late-bundle.js"), false);
    });
  });

  it("detects source bytes committed during a command even when Git status is clean", async () => {
    await withWorkspace(true, async (root) => {
      const filename = path.join(root, "source.ts");
      await writeFile(filename, "before\n", "utf8");
      await git(root, ["add", "."]);
      await git(root, ["commit", "--quiet", "-m", "initial"]);
      const manager = await WorkspaceManager.create(root);

      const baseline = await manager.beginCommandChangeTracking();
      await writeFile(filename, "after\n", "utf8");
      await git(root, ["add", "source.ts"]);
      await git(root, ["commit", "--quiet", "-m", "command commit"]);
      const delta = await manager.completeCommandChangeTracking(baseline);

      assert.deepEqual(delta.updated.map((entry) => entry.after.path), ["source.ts"]);
      assert.equal(delta.updated[0]?.before.hash, hash("before\n"));
      assert.equal(delta.updated[0]?.after.hash, hash("after\n"));
      assert.equal((await readFile(filename, "utf8")), "after\n");
    });
  });

  it("performs a full Git-relevant reconciliation only at the explicit consistency boundary", async () => {
    await withWorkspace(true, async (root) => {
      await writeFile(path.join(root, ".gitignore"), "dist/\n", "utf8");
      await writeFile(path.join(root, "tracked.ts"), "tracked\n", "utf8");
      await git(root, ["add", "."]);
      await git(root, ["commit", "--quiet", "-m", "initial"]);
      const manager = await WorkspaceManager.create(root);

      manager.updateManifestForVerifiedFile("tool-created.ts", {
        hash: hash("tool\n"),
        size: Buffer.byteLength("tool\n"),
      });
      manager.updateManifestForVerifiedFile("dist/explicit.txt", {
        hash: hash("explicit\n"),
        size: Buffer.byteLength("explicit\n"),
      });
      await mkdir(path.join(root, "dist"));
      await Promise.all([
        writeFile(path.join(root, "tool-created.ts"), "tool\n", "utf8"),
        writeFile(path.join(root, "dist", "explicit.txt"), "explicit\n", "utf8"),
        writeFile(path.join(root, "missed.ts"), "missed\n", "utf8"),
        writeFile(path.join(root, "dist", "late.txt"), "ignored\n", "utf8"),
      ]);

      const delta = await manager.fullConsistencyCheck();
      assert.deepEqual(delta.created.map((entry) => entry.path), ["missed.ts"]);
      assert.equal(manager.getManifestSnapshot()?.files.has("tool-created.ts"), true);
      assert.equal(manager.getManifestSnapshot()?.files.has("dist/explicit.txt"), true);
      assert.equal(manager.getManifestSnapshot()?.files.has("dist/late.txt"), false);
    });
  });

  it("retains the complete filesystem fallback for non-Git workspaces", async () => {
    await withWorkspace(false, async (root) => {
      const manager = await WorkspaceManager.create(root);
      const baseline = await manager.beginCommandChangeTracking();
      assert.equal(baseline.kind, "filesystem");

      await mkdir(path.join(root, "__pycache__"));
      await Promise.all([
        writeFile(path.join(root, "source.ts"), "source\n", "utf8"),
        writeFile(path.join(root, "__pycache__", "cache.pyc"), "cache", "utf8"),
      ]);
      const delta = await manager.completeCommandChangeTracking(baseline);

      assert.deepEqual(delta.created.map((entry) => entry.path), [
        "__pycache__/cache.pyc",
        "source.ts",
      ]);
    });
  });
});
