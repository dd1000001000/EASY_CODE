import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/core/types.js";
import { DeleteFileTool } from "../src/tools/delete-file.js";
import { ReadFileTool } from "../src/tools/read-file.js";
import { sha256 } from "../src/utils/hash.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { describe, it } from "./harness.js";

async function withWorkspace(
  run: (root: string, manager: WorkspaceManager) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-delete-file-"));
  try {
    const manager = await WorkspaceManager.create(root);
    await run(root, manager);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function context(root: string, mode: ToolContext["mode"] = "code"): ToolContext {
  return {
    workspaceRoot: root,
    mode,
    threadId: "thread-delete-test",
    turnId: "turn-delete-test",
    approvalPolicy: "safe",
    requestApproval: async () => false,
    commandTimeoutMs: 2_000,
    maxOutputChars: 4_096,
  };
}

async function doesNotExist(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

describe("delete_file tool", () => {
  it("deletes the exact previously read version and presents a removal diff", async () => {
    await withWorkspace(async (root, manager) => {
      const filename = path.join(root, "src", "obsolete.ts");
      await mkdir(path.dirname(filename), { recursive: true });
      const original = "export const obsolete = true;\n";
      await writeFile(filename, original, "utf8");

      const readResult = await new ReadFileTool(manager).execute(
        { path: "src/obsolete.ts" },
        context(root),
      );
      const expectedHash = (readResult.data as { contentHash: string }).contentHash;
      const result = await new DeleteFileTool(manager).execute(
        { path: "src/obsolete.ts", expectedHash },
        context(root),
      );

      assert.equal(result.ok, true);
      assert.equal(await doesNotExist(filename), true);
      assert.equal(manager.getReadVersion("src/obsolete.ts"), undefined);
      assert.deepEqual(result.presentation, {
        type: "file_diff",
        operation: "delete",
        path: "src/obsolete.ts",
        before: original,
        after: "",
      });
      assert.deepEqual(result.data, {
        path: "src/obsolete.ts",
        beforeHash: expectedHash,
        bytesDeleted: Buffer.byteLength(original),
      });
      assert.deepEqual(manager.getChangeSet().at(-1), {
        path: "src/obsolete.ts",
        operation: "delete",
        beforeHash: expectedHash,
        source: "file_tool",
        status: "verified",
        timestamp: manager.getChangeSet().at(-1)?.timestamp,
      });
      assert.equal(manager.getManifestSummary().paths.includes("src/obsolete.ts"), false);
    });
  });

  it("requires a prior read and the matching read hash", async () => {
    await withWorkspace(async (root, manager) => {
      const filename = path.join(root, "keep.txt");
      await writeFile(filename, "keep\n", "utf8");
      const tool = new DeleteFileTool(manager);

      const unread = await tool.execute(
        { path: "keep.txt", expectedHash: sha256("keep\n") },
        context(root),
      );
      assert.equal(unread.ok, false);
      assert.match(unread.error ?? "", /must be successfully read/iu);

      await new ReadFileTool(manager).execute({ path: "keep.txt" }, context(root));
      const mismatched = await tool.execute(
        { path: "keep.txt", expectedHash: "0".repeat(64) },
        context(root),
      );
      assert.equal(mismatched.ok, false);
      assert.match(mismatched.error ?? "", /does not match/iu);
      assert.equal(await readFile(filename, "utf8"), "keep\n");
    });
  });

  it("rejects a concurrent edit and records the conflict", async () => {
    await withWorkspace(async (root, manager) => {
      const filename = path.join(root, "changed.txt");
      await writeFile(filename, "before\n", "utf8");
      const readResult = await new ReadFileTool(manager).execute(
        { path: "changed.txt" },
        context(root),
      );
      const expectedHash = (readResult.data as { contentHash: string }).contentHash;
      await writeFile(filename, "user changed this\n", "utf8");

      const result = await new DeleteFileTool(manager).execute(
        { path: "changed.txt", expectedHash },
        context(root),
      );

      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /changed after it was read/iu);
      assert.equal(result.presentation, undefined);
      assert.equal(await readFile(filename, "utf8"), "user changed this\n");
      assert.equal(manager.getChangeSet().at(-1)?.operation, "delete");
      assert.equal(manager.getChangeSet().at(-1)?.status, "conflict");
      assert.equal(manager.getChangeSet().at(-1)?.afterHash, sha256("user changed this\n"));
    });
  });

  it("denies deletion in plan mode before changing the file", async () => {
    await withWorkspace(async (root, manager) => {
      const filename = path.join(root, "planned.txt");
      await writeFile(filename, "plan only\n", "utf8");
      const readResult = await new ReadFileTool(manager).execute(
        { path: "planned.txt" },
        context(root, "plan"),
      );
      const expectedHash = (readResult.data as { contentHash: string }).contentHash;

      const result = await new DeleteFileTool(manager).execute(
        { path: "planned.txt", expectedHash },
        context(root, "plan"),
      );

      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /disabled in plan mode/iu);
      assert.equal(await readFile(filename, "utf8"), "plan only\n");
      assert.equal(manager.getChangeSet().length, 0);
    });
  });

  it("rejects traversal, directories, final symlinks, and escaping junctions", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "easy-code-delete-outside-"));
    try {
      const outsideFile = path.join(outside, "outside.txt");
      await writeFile(outsideFile, "outside\n", "utf8");
      await withWorkspace(async (root, manager) => {
        const insideFile = path.join(root, "inside.txt");
        await writeFile(insideFile, "inside\n", "utf8");
        await mkdir(path.join(root, "directory"));
        if (process.platform !== "win32") {
          await symlink("inside.txt", path.join(root, "inside-link.txt"), "file");
        }
        await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");

        const insideHash = sha256("inside\n");
        const outsideHash = sha256("outside\n");
        if (process.platform !== "win32") {
          manager.recordRead("inside-link.txt", insideHash);
        }
        manager.recordRead("directory", insideHash);
        manager.recordRead("escape/outside.txt", outsideHash);
        const tool = new DeleteFileTool(manager);

        const traversal = await tool.execute(
          { path: "../outside.txt", expectedHash: outsideHash },
          context(root),
        );
        const directory = await tool.execute(
          { path: "directory", expectedHash: insideHash },
          context(root),
        );
        const finalSymlink = process.platform === "win32"
          ? undefined
          : await tool.execute(
              { path: "inside-link.txt", expectedHash: insideHash },
              context(root),
            );
        const escapedJunction = await tool.execute(
          { path: "escape/outside.txt", expectedHash: outsideHash },
          context(root),
        );

        assert.equal(traversal.ok, false);
        assert.match(traversal.error ?? "", /traversal/iu);
        assert.equal(directory.ok, false);
        assert.match(directory.error ?? "", /regular file/iu);
        if (finalSymlink) {
          assert.equal(finalSymlink.ok, false);
          assert.match(finalSymlink.error ?? "", /symbolic link/iu);
        }
        assert.equal(escapedJunction.ok, false);
        assert.match(escapedJunction.error ?? "", /workspace boundary/iu);
        assert.equal(await readFile(insideFile, "utf8"), "inside\n");
        assert.equal(await readFile(outsideFile, "utf8"), "outside\n");
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
