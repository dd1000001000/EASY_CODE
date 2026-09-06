import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureWorkspaceSnapshot, WorkspacePathGuard } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-snapshot-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("workspace snapshot", () => {
  it("hashes files concurrently while retaining deterministic traversal order", async () => {
    await withWorkspace(async (root) => {
      await mkdir(path.join(root, "nested"));
      await Promise.all([
        writeFile(path.join(root, "z.txt"), "root-z", "utf8"),
        writeFile(path.join(root, "a.txt"), "root-a", "utf8"),
        writeFile(path.join(root, "nested", "z.txt"), "nested-z", "utf8"),
        writeFile(path.join(root, "nested", "a.txt"), "nested-a", "utf8"),
      ]);

      let active = 0;
      let peak = 0;
      const snapshot = await captureWorkspaceSnapshot(
        new WorkspacePathGuard(root),
        { ioConcurrency: 3 },
        {
          hashFile: async (filename) => {
            active += 1;
            peak = Math.max(peak, active);
            try {
              await delay(path.basename(filename) === "a.txt" ? 25 : 1);
              return sha256(await readFile(filename));
            } finally {
              active -= 1;
            }
          },
        },
      );

      assert.equal(peak, 3);
      assert.deepEqual(
        [...snapshot.files.keys()],
        ["a.txt", "nested/a.txt", "nested/z.txt", "z.txt"],
      );
      assert.equal(snapshot.files.get("a.txt")?.hash, sha256("root-a"));
      assert.equal(snapshot.files.get("nested/z.txt")?.hash, sha256("nested-z"));
    });
  });

  it("keeps maxFiles truncation deterministic with concurrent batches", async () => {
    await withWorkspace(async (root) => {
      await Promise.all([
        writeFile(path.join(root, "c.txt"), "c", "utf8"),
        writeFile(path.join(root, "a.txt"), "a", "utf8"),
        writeFile(path.join(root, "b.txt"), "b", "utf8"),
      ]);

      const snapshot = await captureWorkspaceSnapshot(
        new WorkspacePathGuard(root),
        { maxFiles: 2, ioConcurrency: 8 },
      );

      assert.equal(snapshot.truncated, true);
      assert.deepEqual([...snapshot.files.keys()], ["a.txt", "b.txt"]);
    });
  });

  it("does not let a file removed between lstat and hashing consume maxFiles", async () => {
    await withWorkspace(async (root) => {
      await Promise.all([
        writeFile(path.join(root, "a.txt"), "a", "utf8"),
        writeFile(path.join(root, "b.txt"), "b", "utf8"),
        writeFile(path.join(root, "c.txt"), "c", "utf8"),
      ]);

      const snapshot = await captureWorkspaceSnapshot(
        new WorkspacePathGuard(root),
        { maxFiles: 2, ioConcurrency: 2 },
        {
          hashFile: async (filename) => {
            if (path.basename(filename) === "a.txt") await rm(filename);
            return sha256(await readFile(filename));
          },
        },
      );

      assert.equal(snapshot.truncated, false);
      assert.deepEqual([...snapshot.files.keys()], ["b.txt", "c.txt"]);
    });
  });

  it("records a directory symlink without traversing it", async () => {
    await withWorkspace(async (root) => {
      const target = path.join(root, "target");
      const shortcut = path.join(root, "shortcut");
      await mkdir(target);
      await writeFile(path.join(target, "payload.txt"), "payload", "utf8");
      await symlink(target, shortcut, process.platform === "win32" ? "junction" : "dir");

      const snapshot = await captureWorkspaceSnapshot(new WorkspacePathGuard(root));
      const targetText = await readlink(shortcut);

      assert.equal(snapshot.files.get("shortcut")?.kind, "symlink");
      assert.equal(snapshot.files.get("shortcut")?.hash, sha256(`symlink:${targetText}`));
      assert.equal(snapshot.files.has("shortcut/payload.txt"), false);
      assert.equal(snapshot.files.get("target/payload.txt")?.hash, sha256("payload"));
    });
  });

  it("rejects a file replaced between metadata inspection and handle hashing", async () => {
    await withWorkspace(async (root) => {
      const victim = path.join(root, "victim.txt");
      await writeFile(victim, "trusted", "utf8");

      const snapshot = await captureWorkspaceSnapshot(
        new WorkspacePathGuard(root),
        undefined,
        {
          beforeHash: async (filename) => {
            if (path.basename(filename) !== "victim.txt") return;
            await rename(filename, path.join(path.dirname(filename), "original.txt"));
            await writeFile(filename, "replacement with different identity", "utf8");
          },
        },
      );

      assert.equal(snapshot.files.has("victim.txt"), false);
      assert.equal(snapshot.files.has("original.txt"), false);
    });
  });

  it("cancels an in-progress snapshot instead of returning partial state", async () => {
    await withWorkspace(async (root) => {
      await writeFile(path.join(root, "a.txt"), "a", "utf8");
      const controller = new AbortController();

      await assert.rejects(
        captureWorkspaceSnapshot(
          new WorkspacePathGuard(root),
          { signal: controller.signal },
          {
            beforeHash: async () => controller.abort(),
          },
        ),
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
    });
  });
});
