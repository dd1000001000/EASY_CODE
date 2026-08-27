import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryMutationRequest, ToolContext } from "../src/core/types.js";
import { MemoryManager } from "../src/memory/index.js";
import { createStorage, workspaceIdFromRoot } from "../src/storage/index.js";
import { ManageMemoryTool } from "../src/tools/manage-memory.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

function context(root: string, mode: ToolContext["mode"] = "code"): ToolContext {
  return {
    workspaceRoot: root,
    mode,
    threadId: "thread_model_memory",
    turnId: "turn_model_memory",
    approvalPolicy: "safe",
    requestApproval: async () => false,
    commandTimeoutMs: 2_000,
    maxOutputChars: 4_096,
  };
}

describe("manage_memory model tool", () => {
  it("searches immediately but stages writes until a successful commit", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "easy-code-memory-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "easy-code-memory-data-"));
    const storage = createStorage(dataDir);
    try {
      const workspace = await WorkspaceManager.create(workspaceRoot);
      const manager = new MemoryManager(storage);
      const tool = new ManageMemoryTool(manager, workspace);
      const beforeSearch = await tool.execute(
        {
          action: "remember",
          category: "preference",
          content: "The user prefers concise progress messages.",
          reason: "The user explicitly stated this preference.",
        },
        context(workspaceRoot),
      );
      assert.equal(beforeSearch.ok, false);
      assert.match(beforeSearch.error ?? "", /Search long-term memory (?:first|before)/iu);

      const searched = await tool.execute(
        { action: "search", query: "progress messages" },
        context(workspaceRoot),
      );
      assert.equal(searched.ok, true);

      const staged = await tool.execute(
        {
          action: "remember",
          category: "preference",
          content: "The user prefers concise progress messages.",
          reason: "The user explicitly stated this preference.",
        },
        context(workspaceRoot),
      );
      assert.equal(staged.ok, true);
      assert.equal((staged.data as { staged: boolean }).staged, true);
      assert.deepEqual(staged.memoryMutation, {
        action: "remember",
        category: "preference",
        content: "The user prefers concise progress messages.",
        reason: "The user explicitly stated this preference.",
      });

      const workspaceId = workspaceIdFromRoot(workspace.root);
      assert.equal(manager.list(workspaceId).length, 0);
      const committed = manager.applyModelMutations({
        workspaceId,
        threadId: "thread_model_memory",
        turnId: "turn_model_memory",
        outcome: "success",
        mutations: [staged.memoryMutation as MemoryMutationRequest],
      });
      assert.equal(committed.applied, 1);
      assert.equal(manager.list(workspaceId).length, 1);

      const nextTurnForget = await tool.execute(
        {
          action: "forget",
          memoryId: committed.memoryIds[0],
          reason: "A later turn must search before changing this memory.",
        },
        { ...context(workspaceRoot), turnId: "turn_model_memory_next" },
      );
      assert.equal(nextTurnForget.ok, false);
      assert.match(
        nextTurnForget.error ?? "",
        /Search long-term memory (?:first|before)/iu,
      );
    } finally {
      storage.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("requires searched IDs, enforces plan categories, secrets, and workspace isolation", async () => {
    const workspaceA = await mkdtemp(path.join(os.tmpdir(), "easy-code-memory-a-"));
    const workspaceB = await mkdtemp(path.join(os.tmpdir(), "easy-code-memory-b-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "easy-code-memory-data-"));
    const storage = createStorage(dataDir);
    try {
      const managerA = await WorkspaceManager.create(workspaceA);
      const managerB = await WorkspaceManager.create(workspaceB);
      const memoryManager = new MemoryManager(storage);
      const workspaceIdA = workspaceIdFromRoot(managerA.root);
      const seeded = memoryManager.applyModelMutations({
        workspaceId: workspaceIdA,
        threadId: "thread_seed",
        turnId: "turn_seed",
        outcome: "success",
        mutations: [{
          action: "remember",
          category: "architecture",
          content: "The application entry point is located in src/index.ts.",
          reason: "The source tree and package metadata verify this entry point.",
        }],
      });
      const memoryId = seeded.memoryIds[0]!;

      const directTool = new ManageMemoryTool(memoryManager, managerA);
      const directForget = await directTool.execute(
        { action: "forget", memoryId, reason: "The architecture changed." },
        context(workspaceA),
      );
      assert.equal(directForget.ok, false);
      assert.match(directForget.error ?? "", /Search long-term memory (?:first|before)/iu);

      const planTool = new ManageMemoryTool(memoryManager, managerA);
      const search = await planTool.execute(
        { action: "search", query: memoryId },
        context(workspaceA, "plan"),
      );
      assert.equal(search.ok, true);
      const searchedMemory = (search.data as {
        memories: Array<Record<string, unknown>>;
      }).memories[0]!;
      assert.equal(searchedMemory.id, memoryId);
      assert.equal("workspaceId" in searchedMemory, false);
      assert.equal("evidence" in searchedMemory, false);
      const plannedRevision = await planTool.execute(
        {
          action: "revise",
          memoryId,
          category: "architecture",
          content: "The application entry point is located in src/main.ts.",
          reason: "The plan proposes a new entry point.",
        },
        context(workspaceA, "plan"),
      );
      assert.equal(plannedRevision.ok, false);
      assert.match(plannedRevision.error ?? "", /Plan mode may maintain/iu);

      const secretTool = new ManageMemoryTool(memoryManager, managerA);
      await secretTool.execute(
        { action: "search", query: "credentials" },
        context(workspaceA),
      );
      const secret = await secretTool.execute(
        {
          action: "remember",
          category: "environment",
          content: "The service uses api_key=sk-abcdefghijklmnop.",
          reason: "The value appeared in a local configuration file.",
        },
        context(workspaceA),
      );
      assert.equal(secret.ok, false);
      assert.match(secret.error ?? "", /Sensitive information/iu);

      const otherWorkspaceTool = new ManageMemoryTool(memoryManager, managerB);
      const otherSearch = await otherWorkspaceTool.execute(
        { action: "search", query: memoryId, includeInactive: true },
        context(workspaceB),
      );
      assert.deepEqual(otherSearch.data, { memories: [], count: 0 });
      const crossWorkspaceForget = await otherWorkspaceTool.execute(
        { action: "forget", memoryId, reason: "Attempted cross-workspace change." },
        context(workspaceB),
      );
      assert.equal(crossWorkspaceForget.ok, false);
      assert.match(crossWorkspaceForget.error ?? "", /returned by manage_memory search/iu);
      assert.equal(memoryManager.get(workspaceIdA, memoryId)?.status, "active");
    } finally {
      storage.close();
      await rm(workspaceA, { recursive: true, force: true });
      await rm(workspaceB, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
