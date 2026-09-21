import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentTool,
  MemoryMutationRequest,
  ToolContext,
  ToolExecutionResult,
} from "../src/core/types.js";
import { MemoryManager } from "../src/memory/index.js";
import { MEMORY_ID_PATTERN } from "../src/memory/memory-manager.js";
import { createStorage, workspaceIdFromRoot } from "../src/storage/index.js";
import { RecallContextTool } from "../src/tools/context-read.js";
import { describeToolFailure, prepareToolInput } from "../src/tools/errors.js";
import { MemoryToolSession } from "../src/tools/memory-tool-session.js";
import {
  ReadMemoryTool,
  readMemoryInputSchema,
} from "../src/tools/read-memory.js";
import {
  WriteMemoryTool,
  writeMemoryInputSchema,
} from "../src/tools/write-memory.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { describe, it } from "./harness.js";

function context(
  root: string,
  manager?: MemoryManager,
  mode: ToolContext["mode"] = "code",
): ToolContext {
  const workspaceId = workspaceIdFromRoot(root);
  return {
    workspaceRoot: root,
    mode,
    threadId: "thread_model_memory",
    turnId: "turn_model_memory",
    approvalPolicy: "safe",
    requestApproval: async () => false,
    commandTimeoutMs: 2_000,
    maxOutputChars: 4_096,
    ...(manager
      ? {
          searchProjectMemory: async (query: string) => {
            const exact = MEMORY_ID_PATTERN.test(query)
              ? manager.get(workspaceId, query)
              : undefined;
            return exact
              ? [exact]
              : manager.searchHybrid(workspaceId, query, {
                  workspaceRoot: root,
                  readOnly: true,
                  limit: 20,
                });
          },
        }
      : {}),
  };
}

function memoryTools(manager: MemoryManager, workspace: WorkspaceManager) {
  const session = new MemoryToolSession();
  return {
    read: new ReadMemoryTool(workspace, session),
    write: new WriteMemoryTool(manager, workspace, session),
  };
}

describe("split long-term memory tools", () => {
  it("keeps read, write, and historical recall parameters disjoint", () => {
    assert.equal(readMemoryInputSchema.safeParse({ query: "architecture" }).success, true);
    assert.equal(readMemoryInputSchema.safeParse({ query: "preferences", scope: "global" }).success, true);
    assert.equal(readMemoryInputSchema.safeParse({ query: "preferences", scope: "another-project" }).success, false);
    assert.equal(writeMemoryInputSchema.safeParse({ operation: "remember", scope: "global",
      category: "preference", content: "The user prefers brief explanations.",
      reason: "Current user preference" }).success, true);
    assert.equal(
      readMemoryInputSchema.safeParse({ query: "architecture", operation: "remember" }).success,
      false,
    );
    const failedThreadPayload = {
      operation: "remember",
      category: "architecture",
      content: "The service uses the native Node.js HTTP server.",
      reason: "The implementation and tests establish this architecture.",
      sourceRefs: ["evidence_" + "a".repeat(64)],
      evidenceId: "evidence_" + "b".repeat(64),
    };
    const rejected = writeMemoryInputSchema.safeParse(failedThreadPayload);
    assert.equal(rejected.success, false);
    if (!rejected.success) {
      assert.deepEqual(rejected.error.issues[0]?.code, "unrecognized_keys");
      assert.deepEqual(
        "keys" in rejected.error.issues[0]! ? rejected.error.issues[0].keys : [],
        ["sourceRefs", "evidenceId"],
      );
    }
    let diagnostic = "";
    try {
      prepareToolInput(
        {
          name: "write_memory",
          mutating: true,
          inputSchema: writeMemoryInputSchema,
          definition: {
            type: "function",
            function: {
              name: "write_memory",
              description: "test",
              parameters: { type: "object" },
            },
          },
          execute: async () => ({ ok: true, summary: "unused" }),
        } as AgentTool,
        JSON.stringify(failedThreadPayload),
      );
    } catch (error) {
      diagnostic = describeToolFailure(error).issues[0]?.message ?? "";
    }
    assert.match(diagnostic, /sourceRefs/u);
    assert.match(diagnostic, /evidenceId/u);
    assert.doesNotMatch(diagnostic, new RegExp("b".repeat(64), "u"));
    const { evidenceId: _evidenceId, sourceRefs: _sourceRefs, ...valid } = failedThreadPayload;
    assert.equal(writeMemoryInputSchema.safeParse(valid).success, true);
  });

  it("archives an oversized write and retrieves it only through recall_context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-memory-preview-"));
    const storage = createStorage(root);
    try {
      const toolContext = context(root);
      new ThreadStore(storage).create({
        threadId: toolContext.threadId,
        workspaceRoot: root,
        mode: "code",
        provider: "deepseek",
        model: "test",
        thinkingEffort: "none",
      });
      const manager = new MemoryManager(storage);
      const workspace = await WorkspaceManager.create(root);
      const { write } = memoryTools(manager, workspace);
      const content = "The project uses local storage. ".repeat(500);
      const result = await write.execute(
        {
          operation: "remember",
          content,
          category: "architecture",
          reason: "Observed source",
        },
        toolContext,
      );
      assert.equal(result.ok, true, result.error);
      assert.equal(result.memoryMutation, undefined);
      const data = result.data as {
        staged: boolean;
        truncated: boolean;
        content: string;
        sourceRef: string;
      };
      assert.equal(data.staged, false);
      assert.equal(data.truncated, true);
      assert.ok(content.startsWith(data.content));

      const recall = new RecallContextTool();
      const recalled = await recall.execute(
        { evidenceId: data.sourceRef, limit: 16_000 },
        {
          ...toolContext,
          recallContext: async (input): Promise<ToolExecutionResult> => ({
            ok: true,
            summary: "Historical captured evidence",
            data: manager.evidenceStore.read(
              workspaceIdFromRoot(workspace.root),
              toolContext.threadId,
              input.evidenceId,
              input.offset,
              input.limit,
            ),
          }),
        },
      );
      assert.equal(recalled.ok, true, recalled.error);
      assert.match(JSON.stringify(recalled.data), /The project uses local storage/u);
    } finally {
      storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads durable memory and requires a same-turn returned ID for revise or forget", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "easy-code-memory-workspace-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "easy-code-memory-data-"));
    const storage = createStorage(dataDir);
    try {
      const workspace = await WorkspaceManager.create(workspaceRoot);
      const manager = new MemoryManager(storage);
      const tools = memoryTools(manager, workspace);
      const toolContext = context(workspace.root, manager);
      const staged = await tools.write.execute(
        {
          operation: "remember",
          category: "preference",
          content: "The user prefers concise progress messages.",
          reason: "The user explicitly stated this preference.",
        },
        toolContext,
      );
      assert.equal(staged.ok, true);
      const workspaceId = workspaceIdFromRoot(workspace.root);
      const committed = manager.applyModelMutations({
        workspaceId,
        threadId: toolContext.threadId,
        turnId: toolContext.turnId,
        outcome: "success",
        mutations: [staged.memoryMutation as MemoryMutationRequest],
      });
      assert.equal(committed.applied, 1, JSON.stringify(committed));
      const memoryId = committed.memoryIds[0]!;

      const beforeRead = await tools.write.execute(
        { operation: "forget", memoryId, reason: "The preference changed." },
        { ...toolContext, turnId: "turn_next" },
      );
      assert.equal(beforeRead.ok, false);
      assert.match(beforeRead.error ?? "", /read_memory in this turn/iu);

      const nextTurn = { ...toolContext, turnId: "turn_next",
        recordMemoryRecall: (ids: readonly string[]) => manager.recordRecall(toolContext.threadId, "turn_next", ids) };
      const found = await tools.read.execute({ query: memoryId }, nextTurn);
      assert.equal(found.ok, true, found.error);
      const modelMemory = (found.data as { memories: Array<Record<string, unknown>> })
        .memories[0]!;
      assert.equal(modelMemory.id, memoryId);
      assert.equal("workspaceId" in modelMemory, false);
      assert.equal("evidence" in modelMemory, false);
      assert.equal(storage.db.prepare<[string], { access_count: number }>(
        "SELECT access_count FROM memories WHERE id = ?").get(memoryId)?.access_count, 1);
      const forgotten = await tools.write.execute(
        { operation: "forget", memoryId, reason: "The preference changed." },
        nextTurn,
      );
      assert.equal(forgotten.ok, true, forgotten.error);
      assert.equal(forgotten.memoryMutation?.action, "forget");
    } finally {
      storage.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("lets the model stage plan facts while preserving secret, role, and workspace boundaries", async () => {
    const workspaceA = await mkdtemp(path.join(os.tmpdir(), "easy-code-memory-a-"));
    const workspaceB = await mkdtemp(path.join(os.tmpdir(), "easy-code-memory-b-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "easy-code-memory-data-"));
    const storage = createStorage(dataDir);
    try {
      const manager = new MemoryManager(storage);
      const rootA = await WorkspaceManager.create(workspaceA);
      const rootB = await WorkspaceManager.create(workspaceB);
      const toolsA = memoryTools(manager, rootA);
      const toolContext = context(rootA.root, manager);
      const facts = [
        {
          category: "preference" as const,
          content: "The user prefers strict TypeScript.",
          reason: "The user explicitly stated this lasting preference.",
        },
        {
          category: "architecture" as const,
          content: "SQLite is the durable local storage layer.",
          reason: "The completed implementation verifies this architecture.",
        },
      ];
      const mutations: MemoryMutationRequest[] = [];
      for (const fact of facts) {
        const staged = await toolsA.write.execute(
          { operation: "remember", ...fact },
          toolContext,
        );
        assert.equal(staged.ok, true, staged.error);
        mutations.push(staged.memoryMutation as MemoryMutationRequest);
      }
      assert.equal(mutations.length, 2);

      const planFact = await toolsA.write.execute(
        {
          operation: "remember",
          category: "architecture",
          content: "The planned entry point is src/main.ts.",
          reason: "The plan proposes a new entry point.",
        },
        context(rootA.root, manager, "plan"),
      );
      assert.equal(planFact.ok, true, planFact.error);

      const secret = await toolsA.write.execute(
        {
          operation: "remember",
          category: "environment",
          content: "The service uses api_key=sk-abcdefghijklmnop.",
          reason: "The value appeared in a local configuration file.",
        },
        toolContext,
      );
      assert.equal(secret.ok, false);
      assert.match(secret.error ?? "", /Sensitive information/iu);

      const childWrite = await toolsA.write.execute(
        {
          operation: "remember",
          category: "convention",
          content: "The repository uses strict TypeScript.",
          reason: "The child inspected the current configuration.",
        },
        { ...toolContext, agentRole: "subagent" },
      );
      assert.equal(childWrite.ok, false);
      assert.match(childWrite.error ?? "", /Only the main agent/iu);

      const workspaceIdA = workspaceIdFromRoot(rootA.root);
      manager.applyModelMutations({
        workspaceId: workspaceIdA,
        threadId: toolContext.threadId,
        turnId: toolContext.turnId,
        outcome: "success",
        mutations,
      });
      const toolsB = memoryTools(manager, rootB);
      const otherRead = await toolsB.read.execute(
        { query: "SQLite" },
        context(rootB.root, manager),
      );
      assert.equal(otherRead.ok, true, otherRead.error);
      assert.deepEqual(otherRead.data, { memories: [], count: 0 });
      assert.equal(manager.list(workspaceIdA).length, 2);
    } finally {
      storage.close();
      await rm(workspaceA, { recursive: true, force: true });
      await rm(workspaceB, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
