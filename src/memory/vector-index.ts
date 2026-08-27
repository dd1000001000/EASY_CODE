import {
  create,
  insertMultiple,
  search,
  type Orama,
  type WhereCondition,
} from "@orama/orama";

import type { EasyCodeStorage } from "../storage/database.js";
import { sha256 } from "../utils/hash.js";

export interface EmbeddingProvider {
  readonly dimension: number;
  readonly model: string;
  readonly revision: string;
  readonly pooling: string;
  readonly version: number;
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

export interface PreparedMemoryEmbedding {
  readonly model: string;
  readonly revision: string;
  readonly dimensions: number;
  readonly pooling: string;
  readonly version: number;
  readonly contentHash: string;
  /** Portable little-endian float32 representation persisted in SQLite. */
  readonly embedding: Uint8Array;
}

export interface MemoryVectorSearchOptions {
  readonly limit?: number;
  readonly minimumSimilarity?: number;
  readonly minimumConfidence?: number;
  readonly includeInactive?: boolean;
}

export interface MemoryVectorSearchHit {
  readonly id: string;
  readonly score: number;
}

export interface MemoryEmbeddingBackfillOptions {
  readonly batchSize?: number;
}

export interface MemoryEmbeddingBackfillResult {
  readonly scanned: number;
  readonly embedded: number;
  readonly current: number;
  readonly skipped: number;
}

interface MemoryContentRow {
  id: string;
  content: string;
}

interface BackfillRow extends MemoryContentRow {
  model: string | null;
  revision: string | null;
  dimensions: number | null;
  pooling: string | null;
  embedding_version: number | null;
  content_hash: string | null;
  embedding: unknown;
}

interface IndexRow extends MemoryContentRow {
  workspace_id: string;
  status: string;
  confidence: number;
  content_hash: string;
  embedding: unknown;
}

interface IndexSnapshot {
  readonly generation: number;
  readonly rows: IndexRow[];
}

interface CachedIndex {
  readonly generation: number;
  readonly database: Orama<MemoryVectorSchema>;
  readonly size: number;
}

type MemoryVectorSchema = {
  workspaceId: "enum";
  status: "enum";
  confidence: "number";
  embedding: `vector[${number}]`;
};

const MAX_CACHE_RETRIES = 4;
const DEFAULT_BACKFILL_BATCH_SIZE = 16;
const MAX_BACKFILL_BATCH_SIZE = 64;
const DEFAULT_SEARCH_LIMIT = 6;
const MAX_SEARCH_LIMIT = 50;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value !== undefined && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(Math.trunc(resolved), maximum));
}

function boundedUnit(value: number | undefined, fallback: number): number {
  const resolved = value !== undefined && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(resolved, 1));
}

function workspaceKey(value: string): string {
  const resolved = value.trim();
  if (!resolved || resolved.length > 200 || /[\u0000\r\n]/u.test(resolved)) {
    throw new Error("workspaceId is invalid");
  }
  return resolved;
}

function providerText(value: string, label: string): string {
  const resolved = value.trim();
  if (!resolved || resolved.length > 500 || /[\u0000\r\n]/u.test(resolved)) {
    throw new Error(`Embedding provider ${label} is invalid`);
  }
  return resolved;
}

function assertProvider(provider: EmbeddingProvider): void {
  if (!Number.isInteger(provider.dimension) || provider.dimension <= 0 || provider.dimension > 8_192) {
    throw new Error("Embedding provider dimension is invalid");
  }
  if (!Number.isInteger(provider.version) || provider.version <= 0) {
    throw new Error("Embedding provider version is invalid");
  }
  providerText(provider.model, "model");
  providerText(provider.revision, "revision");
  providerText(provider.pooling, "pooling");
}

function encodeFloat32(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index += 1) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, vector[index]!, true);
  }
  return bytes;
}

function blobBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Stored memory embedding is not a SQLite BLOB");
}

function decodeFloat32(value: unknown, dimensions: number): Float32Array {
  const bytes = blobBytes(value);
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("Stored memory embedding has the wrong dimensions");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dimensions);
  let magnitudeSquared = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const component = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(component)) {
      throw new Error("Stored memory embedding contains a non-finite component");
    }
    vector[index] = component;
    magnitudeSquared += component * component;
  }
  if (!(magnitudeSquared > 0)) {
    throw new Error("Stored memory embedding has zero magnitude");
  }
  return vector;
}

function checkedVector(vector: Float32Array, dimensions: number): Float32Array {
  if (!(vector instanceof Float32Array) || vector.length !== dimensions) {
    throw new Error(`Embedding provider must return ${dimensions}-dimension Float32Array values`);
  }
  const copy = new Float32Array(vector.length);
  let magnitudeSquared = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const component = vector[index]!;
    if (!Number.isFinite(component)) {
      throw new Error("Embedding provider returned a non-finite component");
    }
    copy[index] = component;
    magnitudeSquared += component * component;
  }
  if (!(magnitudeSquared > 0)) {
    throw new Error("Embedding provider returned a zero-magnitude vector");
  }
  return copy;
}

export function embeddingModelKey(provider: EmbeddingProvider): string {
  assertProvider(provider);
  return sha256(JSON.stringify([
    provider.model,
    provider.revision,
    provider.dimension,
    provider.pooling,
    provider.version,
  ]));
}

/**
 * SQLite-backed memory embeddings with a generation-versioned Orama cache.
 * SQLite remains authoritative; every Orama index can be discarded and rebuilt.
 */
export class MemoryVectorIndex {
  private readonly caches = new Map<string, CachedIndex>();
  private readonly cacheBuilds = new Map<string, Promise<CachedIndex>>();
  private readonly backfills = new Map<string, Promise<MemoryEmbeddingBackfillResult>>();
  private readonly backfilledGenerations = new Map<string, number>();

  readonly modelKey: string;

  constructor(
    private readonly storage: EasyCodeStorage,
    private readonly provider: EmbeddingProvider,
  ) {
    assertProvider(provider);
    this.modelKey = embeddingModelKey(provider);
  }

  async prepareEmbeddings(
    contents: readonly string[],
  ): Promise<readonly PreparedMemoryEmbedding[]> {
    if (contents.length === 0) return [];
    const cleaned = contents.map((content) => {
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("Memory embedding content must be a non-empty string");
      }
      return content;
    });
    const vectors = await this.provider.embed(cleaned);
    if (vectors.length !== cleaned.length) {
      throw new Error("Embedding provider returned the wrong number of vectors");
    }
    return vectors.map((vector, index) => {
      const checked = checkedVector(vector, this.provider.dimension);
      return {
        model: this.provider.model,
        revision: this.provider.revision,
        dimensions: this.provider.dimension,
        pooling: this.provider.pooling,
        version: this.provider.version,
        contentHash: sha256(cleaned[index]!),
        embedding: encodeFloat32(checked),
      };
    });
  }

  /**
   * Persist an already-computed embedding. This method intentionally does not
   * start a transaction, so MemoryManager can call it inside its atomic memory
   * mutation transaction after inference has completed.
   */
  writePreparedEmbedding(
    memoryId: string,
    prepared: PreparedMemoryEmbedding,
    updatedAt = new Date().toISOString(),
  ): void {
    this.assertPreparedForCurrentModel(prepared);
    const memory = this.storage.db
      .prepare<[string], MemoryContentRow>(
        "SELECT id, content FROM memories WHERE id = ?",
      )
      .get(memoryId);
    if (!memory) throw new Error("Cannot store an embedding for a missing memory");
    if (sha256(memory.content) !== prepared.contentHash) {
      throw new Error("Memory content changed after its embedding was prepared");
    }

    this.storage.db.prepare(
      `INSERT INTO memory_embeddings(
         memory_id, model, revision, dimensions, pooling, embedding_version,
         content_hash, embedding, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET
         model = excluded.model,
         revision = excluded.revision,
         dimensions = excluded.dimensions,
         pooling = excluded.pooling,
         embedding_version = excluded.embedding_version,
         content_hash = excluded.content_hash,
         embedding = excluded.embedding,
         updated_at = excluded.updated_at`,
    ).run(
      memory.id,
      prepared.model,
      prepared.revision,
      prepared.dimensions,
      prepared.pooling,
      prepared.version,
      prepared.contentHash,
      prepared.embedding,
      updatedAt,
      updatedAt,
    );
  }

  deleteEmbedding(memoryId: string): boolean {
    return this.storage.db
      .prepare<[string]>("DELETE FROM memory_embeddings WHERE memory_id = ?")
      .run(memoryId).changes > 0;
  }

  getGeneration(workspaceId: string): number {
    const row = this.storage.db
      .prepare<[string], { generation: number }>(
        "SELECT generation FROM memory_vector_state WHERE workspace_id = ?",
      )
      .get(workspaceKey(workspaceId));
    return row?.generation ?? 0;
  }

  invalidate(workspaceId: string): void {
    const key = workspaceKey(workspaceId);
    this.caches.delete(key);
    this.backfilledGenerations.delete(key);
  }

  async backfill(
    workspaceId: string,
    options: MemoryEmbeddingBackfillOptions = {},
  ): Promise<MemoryEmbeddingBackfillResult> {
    workspaceId = workspaceKey(workspaceId);
    const active = this.backfills.get(workspaceId);
    if (active) return active;
    if (this.backfilledGenerations.get(workspaceId) === this.getGeneration(workspaceId)) {
      return Object.freeze({ scanned: 0, embedded: 0, current: 0, skipped: 0 });
    }

    const pending = this.runBackfillUntilStable(workspaceId, options);
    this.backfills.set(workspaceId, pending);
    try {
      return await pending;
    } finally {
      if (this.backfills.get(workspaceId) === pending) {
        this.backfills.delete(workspaceId);
      }
    }
  }

  private async runBackfillUntilStable(
    workspaceId: string,
    options: MemoryEmbeddingBackfillOptions,
  ): Promise<MemoryEmbeddingBackfillResult> {
    let firstResult: MemoryEmbeddingBackfillResult | undefined;
    for (let attempt = 0; attempt < MAX_CACHE_RETRIES; attempt += 1) {
      const generationBefore = this.getGeneration(workspaceId);
      const result = await this.runBackfill(workspaceId, options);
      firstResult ??= result;
      const generationAfter = this.getGeneration(workspaceId);
      if (
        result.embedded === 0 &&
        result.skipped === 0 &&
        generationBefore === generationAfter
      ) {
        this.backfilledGenerations.set(workspaceId, generationAfter);
        return firstResult;
      }
    }
    return firstResult ?? Object.freeze({
      scanned: 0,
      embedded: 0,
      current: 0,
      skipped: 0,
    });
  }

  async search(
    workspaceId: string,
    query: string,
    options: MemoryVectorSearchOptions = {},
  ): Promise<ReadonlyArray<Readonly<MemoryVectorSearchHit>>> {
    workspaceId = workspaceKey(workspaceId);
    if (!query.trim()) return Object.freeze([]);
    const limit = boundedInteger(options.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const minimumSimilarity = boundedUnit(options.minimumSimilarity, 0);
    const minimumConfidence = boundedUnit(options.minimumConfidence, 0);
    let queryVector: Float32Array | undefined;

    for (let attempt = 0; attempt < MAX_CACHE_RETRIES; attempt += 1) {
      await this.backfill(workspaceId);
      const index = await this.getCachedIndex(workspaceId);
      if (index.size === 0) {
        if (this.getGeneration(workspaceId) === index.generation) {
          return Object.freeze([]);
        }
        this.invalidate(workspaceId);
        continue;
      }

      if (!queryVector) {
        const [queryPrepared] = await this.prepareEmbeddings([query]);
        if (!queryPrepared) throw new Error("Embedding provider returned no query vector");
        queryVector = decodeFloat32(queryPrepared.embedding, this.provider.dimension);
      }

      const where: Partial<WhereCondition<MemoryVectorSchema>> = {
        workspaceId: { eq: workspaceId },
        confidence: { gte: minimumConfidence },
        ...(options.includeInactive === true ? {} : { status: { eq: "active" } }),
      };
      const result = await search(index.database, {
        mode: "vector",
        vector: { value: queryVector, property: "embedding" },
        similarity: minimumSimilarity,
        limit,
        where,
        // Orama 2.1.1 mutates its document store by replacing vectors with
        // null when this is false. Always retain them and discard from output.
        includeVectors: true,
      });
      if (this.getGeneration(workspaceId) !== index.generation) {
        this.invalidate(workspaceId);
        continue;
      }
      return Object.freeze(result.hits.map((hit) => Object.freeze({
        id: hit.id,
        score: hit.score,
      })));
    }
    throw new Error("Memory vector index changed continuously during search");
  }

  private async runBackfill(
    workspaceId: string,
    options: MemoryEmbeddingBackfillOptions,
  ): Promise<MemoryEmbeddingBackfillResult> {
    const rows = this.storage.db
      .prepare<[string], BackfillRow>(
        `SELECT m.id, m.content,
                e.model, e.revision, e.dimensions, e.pooling,
                e.embedding_version, e.content_hash, e.embedding
           FROM memories AS m
           LEFT JOIN memory_embeddings AS e ON e.memory_id = m.id
          WHERE m.workspace_id = ?
          ORDER BY m.id`,
      )
      .all(workspaceId);
    const stale = rows.filter((row) => !this.isCurrentEmbedding(row));
    const batchSize = boundedInteger(
      options.batchSize,
      DEFAULT_BACKFILL_BATCH_SIZE,
      1,
      MAX_BACKFILL_BATCH_SIZE,
    );
    let embedded = 0;
    let skipped = 0;

    for (let offset = 0; offset < stale.length; offset += batchSize) {
      const batch = stale.slice(offset, offset + batchSize);
      const prepared = await this.prepareEmbeddings(batch.map((row) => row.content));
      this.storage.db.transaction(() => {
        for (let index = 0; index < batch.length; index += 1) {
          const candidate = batch[index]!;
          const value = prepared[index]!;
          const current = this.storage.db
            .prepare<[string], MemoryContentRow>(
              "SELECT id, content FROM memories WHERE id = ?",
            )
            .get(candidate.id);
          if (!current || sha256(current.content) !== value.contentHash) {
            skipped += 1;
            continue;
          }
          this.writePreparedEmbedding(current.id, value);
          embedded += 1;
        }
      })();
    }

    if (embedded > 0) this.invalidate(workspaceId);
    return Object.freeze({
      scanned: rows.length,
      embedded,
      current: rows.length - stale.length,
      skipped,
    });
  }

  private isCurrentEmbedding(row: BackfillRow): boolean {
    if (
      row.model !== this.provider.model ||
      row.revision !== this.provider.revision ||
      row.dimensions !== this.provider.dimension ||
      row.pooling !== this.provider.pooling ||
      row.embedding_version !== this.provider.version ||
      row.content_hash !== sha256(row.content)
    ) {
      return false;
    }
    try {
      decodeFloat32(row.embedding, this.provider.dimension);
      return true;
    } catch {
      return false;
    }
  }

  private assertPreparedForCurrentModel(prepared: PreparedMemoryEmbedding): void {
    if (
      prepared.model !== this.provider.model ||
      prepared.revision !== this.provider.revision ||
      prepared.dimensions !== this.provider.dimension ||
      prepared.pooling !== this.provider.pooling ||
      prepared.version !== this.provider.version ||
      !/^[0-9a-f]{64}$/u.test(prepared.contentHash)
    ) {
      throw new Error("Prepared memory embedding does not match the active model");
    }
    decodeFloat32(prepared.embedding, this.provider.dimension);
  }

  private async getCachedIndex(workspaceId: string): Promise<CachedIndex> {
    for (let attempt = 0; attempt < MAX_CACHE_RETRIES; attempt += 1) {
      const generation = this.getGeneration(workspaceId);
      const cached = this.caches.get(workspaceId);
      if (cached?.generation === generation) return cached;

      const built = await this.buildSharedIndex(workspaceId);
      if (this.getGeneration(workspaceId) === built.generation) {
        this.caches.set(workspaceId, built);
        return built;
      }
      this.invalidate(workspaceId);
    }
    throw new Error("Memory vector index changed continuously while rebuilding");
  }

  private async buildSharedIndex(workspaceId: string): Promise<CachedIndex> {
    const active = this.cacheBuilds.get(workspaceId);
    if (active) return active;

    const pending = this.buildIndex(workspaceId);
    this.cacheBuilds.set(workspaceId, pending);
    try {
      return await pending;
    } finally {
      if (this.cacheBuilds.get(workspaceId) === pending) {
        this.cacheBuilds.delete(workspaceId);
      }
    }
  }

  private async buildIndex(workspaceId: string): Promise<CachedIndex> {
    const snapshot = this.readIndexSnapshot(workspaceId);
    const vectorType = `vector[${this.provider.dimension}]` as `vector[${number}]`;
    const schema: MemoryVectorSchema = {
      workspaceId: "enum",
      status: "enum",
      confidence: "number",
      embedding: vectorType,
    };
    const database = await create({
      schema,
    });
    const documents: Array<{
      id: string;
      workspaceId: string;
      status: string;
      confidence: number;
      embedding: number[];
    }> = [];
    for (const row of snapshot.rows) {
      if (row.content_hash !== sha256(row.content)) continue;
      try {
        documents.push({
          id: row.id,
          workspaceId: row.workspace_id,
          status: row.status,
          confidence: row.confidence,
          embedding: Array.from(decodeFloat32(row.embedding, this.provider.dimension)),
        });
      } catch {
        // A damaged derived row is omitted. The next backfill will replace it.
      }
    }
    if (documents.length > 0) await insertMultiple(database, documents, 100);
    return {
      generation: snapshot.generation,
      database,
      size: documents.length,
    };
  }

  private readIndexSnapshot(workspaceId: string): IndexSnapshot {
    return this.storage.db.transaction(() => {
      const generation = this.getGeneration(workspaceId);
      const rows = this.storage.db
        .prepare<[
          string,
          string,
          string,
          number,
          string,
          number,
        ], IndexRow>(
          `SELECT m.id, m.workspace_id, m.content, m.status, m.confidence,
                  e.content_hash, e.embedding
             FROM memories AS m
             JOIN memory_embeddings AS e ON e.memory_id = m.id
            WHERE m.workspace_id = ?
              AND e.model = ?
              AND e.revision = ?
              AND e.dimensions = ?
              AND e.pooling = ?
              AND e.embedding_version = ?
            ORDER BY m.id`,
        )
        .all(
          workspaceId,
          this.provider.model,
          this.provider.revision,
          this.provider.dimension,
          this.provider.pooling,
          this.provider.version,
        );
      return { generation, rows };
    })();
  }
}
