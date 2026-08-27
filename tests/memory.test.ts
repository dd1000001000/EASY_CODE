import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { MemoryManager, MemoryVectorIndex } from "../src/memory/index.js";
import { createStorage } from "../src/storage/index.js";

function temporaryDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "easy-code-memory-"));
}

function mutationContext(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace_a",
    threadId: "thread_a",
    turnId: "turn_a",
    outcome: "success" as const,
    ...overrides,
  };
}

describe("model-managed long-term memory", () => {
  it("commits explicit memories, upserts exact content, and isolates workspaces", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const manager = new MemoryManager(storage);
      const committed = manager.applyModelMutations({
        ...mutationContext(),
        mutations: [
          {
            action: "remember",
            category: "convention",
            content: "All TypeScript modules use strict compiler settings.",
            reason: "The user established this repository-wide convention.",
          },
          {
            action: "remember",
            category: "environment",
            content: "The project supports Node.js 16.20 and newer.",
            reason: "The package engine requirement verifies this environment fact.",
          },
        ],
      });

      assert.equal(committed.applied, 2);
      assert.equal(committed.memoryIds.length, 2);
      assert.equal(manager.list("workspace_a").length, 2);
      assert.equal(manager.list("workspace_b").length, 0);
      assert.equal(manager.search("workspace_b", "TypeScript").length, 0);
      assert.equal(manager.search("workspace_a", "TypeScript")[0]?.confidence, 0.8);

      const upserted = manager.applyModelMutations({
        ...mutationContext({ turnId: "turn_b" }),
        mutations: [{
          action: "remember",
          category: "convention",
          content: "All TypeScript modules use strict compiler settings.",
          reason: "The same convention was confirmed again by the user.",
        }],
      });
      assert.equal(upserted.memoryIds[0], committed.memoryIds[0]);
      assert.equal(manager.list("workspace_a").length, 2);
      const strictMemory = manager.get("workspace_a", committed.memoryIds[0]!);
      assert.ok(Math.abs((strictMemory?.confidence ?? 0) - 0.83) < 1e-9);
      const evidence = JSON.parse(strictMemory?.evidence ?? "{}") as {
        history?: Array<{ threadId: string; turnId: string; action: string }>;
      };
      assert.deepEqual(
        evidence.history?.map(({ threadId, turnId, action }) => ({ threadId, turnId, action })),
        [
          { threadId: "thread_a", turnId: "turn_a", action: "remember" },
          { threadId: "thread_a", turnId: "turn_b", action: "upsert" },
        ],
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("combines semantic top-k with lexical retrieval and falls back safely", async () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const seedManager = new MemoryManager(storage);
      const seeded = seedManager.applyModelMutations({
        ...mutationContext(),
        mutations: [
          {
            action: "remember",
            category: "architecture",
            content: "Production deployments use blue-green environments.",
            reason: "The deployment implementation verifies this architecture.",
          },
          {
            action: "remember",
            category: "convention",
            content: "Repository documentation uses American English spelling.",
            reason: "The user established this documentation convention.",
          },
        ],
      });
      const deploymentId = seeded.memoryIds[0]!;
      let vectorOptions: { minimumConfidence?: number; includeInactive?: boolean } | undefined;
      const hybridManager = new MemoryManager(storage, {
        vectorIndex: {
          search: async (_workspaceId, _query, options) => {
            vectorOptions = options;
            return [{ id: deploymentId, score: 0.92 }];
          },
        },
      });

      const semantic = await hybridManager.searchHybrid(
        "workspace_a",
        "release without downtime",
      );
      assert.equal(semantic[0]?.id, deploymentId);
      assert.equal(vectorOptions?.minimumConfidence, 0.55);
      assert.equal(vectorOptions?.includeInactive, false);

      let reportedError = false;
      const fallbackManager = new MemoryManager(storage, {
        vectorIndex: {
          search: async () => {
            throw new Error("embedding fixture unavailable");
          },
        },
        onVectorError: () => {
          reportedError = true;
          throw new Error("diagnostic callback failure");
        },
      });
      const lexical = await fallbackManager.searchHybrid(
        "workspace_a",
        "documentation spelling",
      );
      assert.match(lexical[0]?.content ?? "", /documentation/iu);
      assert.equal(reportedError, true);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("stores new memory embeddings in the mutation transaction", async () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const vectorIndex = new MemoryVectorIndex(storage, {
        dimension: 2,
        model: "test/manager-embedding",
        revision: "revision-one",
        pooling: "masked-mean",
        version: 1,
        embed: async (texts) => texts.map((text) =>
          Float32Array.from(
            /blue-green|downtime/iu.test(text) ? [1, 0] : [0, 1],
          )),
      });
      const manager = new MemoryManager(storage, { vectorIndex });
      const committed = await manager.applyModelMutationsWithEmbeddings({
        ...mutationContext(),
        mutations: [{
          action: "remember",
          category: "architecture",
          content: "Production deployments use blue-green environments.",
          reason: "The deployment implementation verifies this architecture.",
        }],
      });

      const stored = storage.db
        .prepare<[string], { dimensions: number; bytes: number }>(
          `SELECT dimensions, length(embedding) AS bytes
             FROM memory_embeddings WHERE memory_id = ?`,
        )
        .get(committed.memoryIds[0]!);
      assert.deepEqual(stored, { dimensions: 2, bytes: 8 });
      assert.equal(
        (await manager.searchHybrid("workspace_a", "release without downtime"))[0]?.id,
        committed.memoryIds[0],
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rolls back a batch on invalid, sensitive, cross-workspace, or planned repository facts", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const manager = new MemoryManager(storage);
      assert.throws(
        () => manager.applyModelMutations({
          ...mutationContext(),
          mutations: [
            {
              action: "remember",
              category: "preference",
              content: "The user prefers concise terminal status updates.",
              reason: "The user explicitly stated this durable preference.",
            },
            {
              action: "remember",
              category: "environment",
              content: "The deployment uses api_key=sk-abcdefghijklmnop.",
              reason: "A credential appeared in command output.",
            },
          ],
        }),
        /sensitive information/iu,
      );
      assert.equal(manager.list("workspace_a").length, 0);

      assert.throws(
        () => manager.applyModelMutations({
          ...mutationContext({ workspaceId: "workspace_plan_no_cue", outcome: "planned" }),
          userInput: "Please inspect the dependency setup.",
          mutations: [{
            action: "remember",
            category: "preference",
            content: "The user prefers npm for dependency installation.",
            reason: "The model inferred a preference that the user did not state.",
          }],
        }),
        /explicitly states a durable preference or convention/iu,
      );
      assert.equal(manager.list("workspace_plan_no_cue").length, 0);

      const plannedPreference = manager.applyModelMutations({
        ...mutationContext({ workspaceId: "workspace_plan_preference", outcome: "planned" }),
        userInput: "From now on, always use npm for dependency installation.",
        mutations: [{
          action: "remember",
          category: "preference",
          content: "The user prefers npm for dependency installation.",
          reason: "The current user message explicitly establishes this preference.",
        }],
      });
      assert.equal(plannedPreference.applied, 1);
      assert.equal(manager.list("workspace_plan_preference").length, 1);

      assert.throws(
        () => manager.applyModelMutations({
          ...mutationContext({ workspaceId: "workspace_plan", outcome: "planned" }),
          userInput: "From now on, always use npm and keep this as a project convention.",
          mutations: [
            {
              action: "remember",
              category: "preference",
              content: "The user prefers npm for dependency installation.",
              reason: "The current request explicitly states this preference.",
            },
            {
              action: "remember",
              category: "architecture",
              content: "The application entry point is located in src/index.ts.",
              reason: "The plan proposes this repository structure.",
            },
          ],
        }),
        /Planned turns cannot commit architecture/iu,
      );
      assert.equal(manager.list("workspace_plan").length, 0);

      const seeded = manager.applyModelMutations({
        ...mutationContext(),
        mutations: [{
          action: "remember",
          category: "decision",
          content: "The project uses SQLite for durable local metadata.",
          reason: "The implementation and schema verify this project decision.",
        }],
      });
      assert.throws(
        () => manager.applyModelMutations({
          ...mutationContext({ workspaceId: "workspace_b", turnId: "turn_b" }),
          mutations: [{
            action: "forget",
            memoryId: seeded.memoryIds[0]!,
            reason: "Attempt to modify a memory from another workspace.",
          }],
        }),
        /not found in this workspace/iu,
      );
      assert.equal(manager.get("workspace_a", seeded.memoryIds[0]!)?.status, "active");
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("supersedes revisions, expires forgotten memories, and retains bounded audit history", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const manager = new MemoryManager(storage);
      const initial = manager.applyModelMutations({
        ...mutationContext(),
        mutations: [{
          action: "remember",
          category: "environment",
          content: "The minimum supported runtime is Node.js 16.20.",
          reason: "The package metadata verifies the minimum runtime.",
        }],
      });
      const originalId = initial.memoryIds[0]!;
      const revised = manager.applyModelMutations({
        ...mutationContext({ turnId: "turn_revision" }),
        mutations: [{
          action: "revise",
          memoryId: originalId,
          category: "environment",
          content: "The minimum supported runtime is Node.js 18.0.",
          reason: "The package engine requirement was deliberately raised.",
        }],
      });
      const replacementId = revised.memoryIds[0]!;

      assert.notEqual(replacementId, originalId);
      assert.equal(manager.get("workspace_a", originalId)?.status, "superseded");
      assert.equal(manager.get("workspace_a", replacementId)?.status, "active");
      assert.equal(manager.search("workspace_a", "16.20").length, 0);
      assert.equal(
        manager.search("workspace_a", "16.20", { includeInactive: true })[0]?.id,
        originalId,
      );

      const forgotten = manager.applyModelMutations({
        ...mutationContext({ turnId: "turn_forget" }),
        mutations: [{
          action: "forget",
          memoryId: replacementId,
          reason: "The runtime requirement no longer applies to this workspace.",
        }],
      });
      assert.equal(forgotten.applied, 1);
      assert.equal(manager.get("workspace_a", replacementId)?.status, "expired");
      assert.equal(manager.list("workspace_a").length, 0);
      assert.equal(manager.list("workspace_a", { status: "all" }).length, 2);

      const auditSeed = manager.applyModelMutations({
        ...mutationContext({ workspaceId: "workspace_audit", turnId: "turn_seed" }),
        mutations: [{
          action: "remember",
          category: "convention",
          content: "Repository documentation uses American English spelling.",
          reason: "The user established the documentation convention.",
        }],
      });
      for (let index = 0; index < 30; index += 1) {
        manager.applyModelMutations({
          ...mutationContext({
            workspaceId: "workspace_audit",
            turnId: `turn_confirm_${index}`,
          }),
          mutations: [{
            action: "remember",
            category: "convention",
            content: "Repository documentation uses American English spelling.",
            reason: `The convention was reconfirmed during completed turn ${index}.`,
          }],
        });
      }
      const audited = manager.get("workspace_audit", auditSeed.memoryIds[0]!);
      assert.ok(Buffer.byteLength(audited?.evidence ?? "", "utf8") <= 64 * 1024);
      const evidence = JSON.parse(audited?.evidence ?? "{}") as {
        history?: unknown[];
        compacted?: { count: number };
      };
      assert.ok((evidence.history?.length ?? 0) <= 24);
      assert.ok((evidence.compacted?.count ?? 0) > 0);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
