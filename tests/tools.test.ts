import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/core/types.js";
import {
  CreateFileTool,
  ReadFileTool,
  UpdateFileTool,
  createDefaultTools,
} from "../src/tools/index.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

async function withWorkspace(run: (root: string, manager: WorkspaceManager) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-tools-"));
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
    threadId: "thread-test",
    turnId: "turn-test",
    approvalPolicy: "safe",
    requestApproval: async () => false,
    commandTimeoutMs: 2_000,
    maxOutputChars: 4_096,
  };
}

describe("workspace file tools", () => {
  it("exports exactly the four default tools", async () => {
    await withWorkspace(async (_root, manager) => {
      assert.deepEqual(
        createDefaultTools(manager).map((tool) => tool.name),
        ["read_file", "create_file", "update_file", "run_command"],
      );
    });
  });

  it("reads a line range and tracks the full-file SHA-256 version", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "sample.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");
      const tool = new ReadFileTool(manager);
      const result = await tool.execute(
        { path: "sample.txt", startLine: 2, endLine: 3 },
        context(root),
      );

      assert.equal(result.ok, true);
      const data = result.data as {
        content: string;
        contentHash: string;
        newline: string;
        startLine: number;
        endLine: number;
      };
      assert.equal(data.content, "two\nthree");
      assert.equal(data.newline, "crlf");
      assert.equal(data.startLine, 2);
      assert.equal(data.endLine, 3);
      assert.match(data.contentHash, /^[a-f0-9]{64}$/u);
      assert.equal(manager.getReadVersion("sample.txt")?.hash, data.contentHash);
    });
  });

  it("creates nested files but never overwrites an existing target", async () => {
    await withWorkspace(async (root, manager) => {
      const tool = new CreateFileTool(manager);
      const first = await tool.execute({ path: "src/new.ts", content: "export {};\n" }, context(root));
      const second = await tool.execute({ path: "src/new.ts", content: "overwritten" }, context(root));

      assert.equal(first.ok, true);
      assert.equal(second.ok, false);
      assert.equal(await readFile(path.join(root, "src", "new.ts"), "utf8"), "export {};\n");
      assert.equal(manager.getChangeSet().filter((change) => change.operation === "create").length, 1);
    });
  });

  it("requires a matching read hash and applies unique exact edits atomically", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "code.ts"), "const value = 1;\n", "utf8");
      const reader = new ReadFileTool(manager);
      const updater = new UpdateFileTool(manager);
      const read = await reader.execute({ path: "code.ts" }, context(root));
      const hash = (read.data as { contentHash: string }).contentHash;

      const updated = await updater.execute(
        {
          path: "code.ts",
          expectedHash: hash,
          edits: [{ oldText: "value = 1", newText: "value = 2" }],
        },
        context(root),
      );
      assert.equal(updated.ok, true);
      assert.equal(await readFile(path.join(root, "code.ts"), "utf8"), "const value = 2;\n");
      assert.notEqual((updated.data as { contentHash: string }).contentHash, hash);
      assert.equal(manager.getChangeSet().at(-1)?.status, "verified");
    });
  });

  it("detects concurrent edits and refuses ambiguous replacements", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "code.ts"), "same same\n", "utf8");
      const reader = new ReadFileTool(manager);
      const updater = new UpdateFileTool(manager);
      const read = await reader.execute({ path: "code.ts" }, context(root));
      const hash = (read.data as { contentHash: string }).contentHash;

      const ambiguous = await updater.execute(
        {
          path: "code.ts",
          expectedHash: hash,
          edits: [{ oldText: "same", newText: "changed" }],
        },
        context(root),
      );
      assert.equal(ambiguous.ok, false);

      await writeFile(path.join(root, "code.ts"), "user changed this\n", "utf8");
      const conflict = await updater.execute(
        {
          path: "code.ts",
          expectedHash: hash,
          edits: [{ oldText: "same same", newText: "changed" }],
        },
        context(root),
      );
      assert.equal(conflict.ok, false);
      assert.match(conflict.error ?? "", /changed after it was read/iu);
      assert.equal(await readFile(path.join(root, "code.ts"), "utf8"), "user changed this\n");
      assert.equal(manager.getChangeSet().at(-1)?.status, "conflict");
    });
  });

  it("enforces plan mode mutations and path traversal in code", async () => {
    await withWorkspace(async (root, manager) => {
      const create = new CreateFileTool(manager);
      const planResult = await create.execute({ path: "blocked.txt", content: "no" }, context(root, "plan"));
      const traversal = await create.execute({ path: "../escape.txt", content: "no" }, context(root));
      assert.equal(planResult.ok, false);
      assert.equal(traversal.ok, false);
    });
  });

  it("rejects a directory symlink or junction that escapes the workspace", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "easy-code-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
      await withWorkspace(async (root, manager) => {
        const link = path.join(root, "escape");
        await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
        const reader = new ReadFileTool(manager);
        const result = await reader.execute({ path: "escape/secret.txt" }, context(root));
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /workspace boundary/iu);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

