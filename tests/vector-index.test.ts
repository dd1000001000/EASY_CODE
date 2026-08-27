import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MemoryVectorIndex,
  type EmbeddingProvider,
} from "../src/memory/vector-index.js";
import type { EasyCodeStorage } from "../src/storage/database.js";
import { createStorage } from "../src/storage/database.js";
import { describe, it } from "./harness.js";

const WORKSPACE_ID = "workspace_vector_test";

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = 3;
  readonly model = "test/memory-embedding";
  readonly pooling = "mean";
  readonly version = 1;
  readonly calls: string[][] = [];

  constructor(
    readonly revision: string,
    private readonly vectors: Readonly<Record<string, readonly number[]>>,
  ) {}

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      const vector = this.vectors[text];
      if (!vector) throw new Error(`Missing fake embedding for: ${text}`);
      return Float32Array.from(vector);
    });
  }
}

function temporaryDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "easy-code-vector-index-"));
}

function insertMemory(
  storage: EasyCodeStorage,
  input: {
    readonly id: string;
    readonly content: string;
    readonly status?: string;
    readonly workspaceId?: string;
    readonly confidence?: number;
  },
): void {
  const now = new Date().toISOString();
  storage.db.prepare(
    `INSERT INTO memories(
       id, workspace_id, category, content, normalized_content, confidence,
       status, evidence, source_thread_id, source_turn_id, created_at, updated_at
     ) VALUES (?, ?, 'decision', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    input.id,
    input.workspaceId ?? WORKSPACE_ID,
    input.content,
    input.content.toLocaleLowerCase(),
    input.confidence ?? 0.8,
    input.status ?? "active",
    now,
    now,
  );
}

const commonVectors = {
  "Active fruit memory": [0.9, 0.1, 0],
  "Expired fruit memory": [1, 0, 0],
  "Ocean memory": [0, 1, 0],
  "fruit query": [1, 0, 0],
  "ocean query": [0, 1, 0],
};

describe("memory vector index", () => {
  it("does not initialize the embedding model for an empty workspace", async () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      let called = false;
      const vectors = new MemoryVectorIndex(storage, {
        dimension: 2,
        model: "test/empty-workspace",
        revision: "revision-one",
        pooling: "mean",
        version: 1,
        embed: async () => {
          called = true;
          throw new Error("an empty workspace must not load the model");
        },
      });
      assert.deepEqual(await vectors.search(WORKSPACE_ID, "first prompt"), []);
      assert.equal(called, false);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("backfills SQLite BLOBs and returns repeatable active or audit top-k results", async () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      insertMemory(storage, {
        id: "memory_active_fruit",
        content: "Active fruit memory",
      });
      insertMemory(storage, {
        id: "memory_expired_fruit",
        content: "Expired fruit memory",
        status: "expired",
      });
      insertMemory(storage, {
        id: "memory_ocean",
        content: "Ocean memory",
      });

      const provider = new FakeEmbeddingProvider("revision-one", commonVectors);
      const vectors = new MemoryVectorIndex(storage, provider);
      const beforeBackfill = vectors.getGeneration(WORKSPACE_ID);
      const backfilled = await vectors.backfill(WORKSPACE_ID, { batchSize: 2 });
      assert.deepEqual(backfilled, {
        scanned: 3,
        embedded: 3,
        current: 0,
        skipped: 0,
      });
      assert.ok(vectors.getGeneration(WORKSPACE_ID) > beforeBackfill);
      const providerCallsAfterBackfill = provider.calls.length;
      assert.deepEqual(await vectors.backfill(WORKSPACE_ID), {
        scanned: 0,
        embedded: 0,
        current: 0,
        skipped: 0,
      });
      assert.equal(provider.calls.length, providerCallsAfterBackfill);

      const stored = storage.db
        .prepare<[], {
          model: string;
          revision: string;
          dimensions: number;
          pooling: string;
          embedding_version: number;
          hash_length: number;
          blob_length: number;
        }>(
          `SELECT model, revision, dimensions, pooling, embedding_version,
                  length(content_hash) AS hash_length,
                  length(embedding) AS blob_length
             FROM memory_embeddings
            WHERE memory_id = 'memory_active_fruit'`,
        )
        .get();
      assert.deepEqual(stored, {
        model: provider.model,
        revision: provider.revision,
        dimensions: 3,
        pooling: provider.pooling,
        embedding_version: provider.version,
        hash_length: 64,
        blob_length: 12,
      });

      const active = await vectors.search(WORKSPACE_ID, "fruit query", { limit: 3 });
      assert.equal(active[0]?.id, "memory_active_fruit");
      assert.equal(active.some((hit) => hit.id === "memory_expired_fruit"), false);

      const audit = await vectors.search(WORKSPACE_ID, "fruit query", {
        limit: 3,
        includeInactive: true,
      });
      assert.equal(audit[0]?.id, "memory_expired_fruit");

      // A second vector search catches Orama 2.1.1's destructive
      // includeVectors:false behavior. The wrapper must keep vectors intact.
      const repeated = await vectors.search(WORKSPACE_ID, "ocean query", { limit: 3 });
      assert.equal(repeated[0]?.id, "memory_ocean");

      storage.db.prepare("DELETE FROM memories WHERE id = ?").run("memory_ocean");
      assert.equal(
        storage.db
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = 'memory_ocean'",
          )
          .get()?.count,
        0,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("detects another SQLite connection's generation and rebuilds its cache", async () => {
    const dataDir = temporaryDataDir();
    const storageA = createStorage(dataDir);
    const storageB = createStorage(dataDir);
    try {
      const vectorsByText = {
        "Older fruit memory": [0.6, 0.8, 0],
        "New exact fruit memory": [1, 0, 0],
        "fruit query": [1, 0, 0],
      };
      insertMemory(storageA, {
        id: "memory_older",
        content: "Older fruit memory",
      });
      const indexA = new MemoryVectorIndex(
        storageA,
        new FakeEmbeddingProvider("shared-revision", vectorsByText),
      );
      assert.equal(
        (await indexA.search(WORKSPACE_ID, "fruit query", { limit: 2 }))[0]?.id,
        "memory_older",
      );
      const cachedGeneration = indexA.getGeneration(WORKSPACE_ID);

      insertMemory(storageB, {
        id: "memory_newer",
        content: "New exact fruit memory",
      });
      assert.ok(
        new MemoryVectorIndex(
          storageB,
          new FakeEmbeddingProvider("shared-revision", vectorsByText),
        ).getGeneration(WORKSPACE_ID) > cachedGeneration,
      );
      assert.equal(
        (await indexA.search(WORKSPACE_ID, "fruit query", { limit: 2 }))[0]?.id,
        "memory_newer",
      );

      storageB.db
        .prepare("UPDATE memories SET status = 'expired' WHERE id = ?")
        .run("memory_newer");
      assert.equal(
        (await indexA.search(WORKSPACE_ID, "fruit query", { limit: 2 }))[0]?.id,
        "memory_older",
      );
    } finally {
      storageB.close();
      storageA.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("re-embeds rows when model metadata changes and rejects stale prepared content", async () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      insertMemory(storage, {
        id: "memory_revision",
        content: "Active fruit memory",
      });
      const first = new MemoryVectorIndex(
        storage,
        new FakeEmbeddingProvider("revision-one", commonVectors),
      );
      assert.equal((await first.backfill(WORKSPACE_ID)).embedded, 1);

      const second = new MemoryVectorIndex(
        storage,
        new FakeEmbeddingProvider("revision-two", commonVectors),
      );
      assert.equal((await second.backfill(WORKSPACE_ID)).embedded, 1);
      assert.equal(
        storage.db
          .prepare<[], { revision: string }>(
            "SELECT revision FROM memory_embeddings WHERE memory_id = 'memory_revision'",
          )
          .get()?.revision,
        "revision-two",
      );

      const [prepared] = await second.prepareEmbeddings(["Active fruit memory"]);
      assert.ok(prepared);
      storage.db
        .prepare("UPDATE memories SET content = ?, normalized_content = ? WHERE id = ?")
        .run("Changed after inference", "changed after inference", "memory_revision");
      assert.throws(
        () => second.writePreparedEmbedding("memory_revision", prepared!),
        /changed after its embedding was prepared/iu,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
