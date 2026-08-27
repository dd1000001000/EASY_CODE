import type {
  AgentRunResult,
  LongTermMemory,
  MemoryMutationRequest,
} from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { createId } from "../utils/ids.js";
import {
  containsSensitiveInformation,
  redactSensitiveInformation,
} from "./sensitive.js";
import type {
  MemoryVectorSearchHit,
  MemoryVectorSearchOptions,
  PreparedMemoryEmbedding,
} from "./vector-index.js";

export interface MemorySearchOptions {
  readonly limit?: number;
  readonly minimumConfidence?: number;
  /** Include inactive audit-history rows. Ordinary retrieval stays active-only. */
  readonly includeInactive?: boolean;
}

export interface MemoryListOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly status?: LongTermMemory["status"] | "all";
}

export interface MemorySemanticSearchIndex {
  search(
    workspaceId: string,
    query: string,
    options?: MemoryVectorSearchOptions,
  ): Promise<ReadonlyArray<Readonly<MemoryVectorSearchHit>>>;
  prepareEmbeddings?(
    contents: readonly string[],
  ): Promise<readonly PreparedMemoryEmbedding[]>;
  writePreparedEmbedding?(
    memoryId: string,
    prepared: PreparedMemoryEmbedding,
    updatedAt?: string,
  ): void;
  invalidate?(workspaceId: string): void;
}

export interface MemoryManagerOptions {
  readonly vectorIndex?: MemorySemanticSearchIndex;
  readonly onVectorError?: (error: unknown) => void;
}

export const MEMORY_CATEGORIES = [
  "preference",
  "convention",
  "architecture",
  "decision",
  "environment",
] as const satisfies readonly LongTermMemory["category"][];

export const MIN_MEMORY_CONTENT_CHARS = 8;
export const MAX_MEMORY_CONTENT_CHARS = 1_000;
export const MAX_MEMORY_REASON_CHARS = 500;
export const MAX_MEMORY_SEARCH_CHARS = 500;

export interface ApplyModelMemoryMutationsInput {
  readonly workspaceId?: string;
  readonly workspaceRoot?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly outcome: AgentRunResult["reason"];
  readonly userInput?: string;
  readonly mutations: readonly MemoryMutationRequest[];
}

export interface ApplyModelMemoryMutationsResult {
  readonly applied: number;
  readonly memoryIds: string[];
}

interface ModelMemoryEvidence {
  readonly threadId: string;
  readonly turnId: string;
  readonly reason: string;
}

interface MemoryRow {
  id: string;
  workspace_id: string;
  category: LongTermMemory["category"];
  content: string;
  normalized_content: string;
  confidence: number;
  status: LongTermMemory["status"];
  evidence: string | null;
  created_at: string;
  updated_at: string;
}

type MemoryAuditAction =
  | "remember"
  | "upsert"
  | "revise"
  | "supersede"
  | "forget";

interface MemorySnapshot {
  readonly category: LongTermMemory["category"];
  readonly content: string;
  readonly confidence: number;
  readonly status: LongTermMemory["status"];
}

interface MemoryAuditEntry {
  readonly action: MemoryAuditAction;
  readonly threadId: string;
  readonly turnId: string;
  readonly timestamp: string;
  readonly reason: string;
  readonly relatedMemoryId?: string;
  readonly previous?: MemorySnapshot;
}

interface MemoryEvidenceDocument {
  readonly version: 1;
  readonly history: readonly MemoryAuditEntry[];
  readonly legacy?: string;
  readonly compacted?: {
    readonly count: number;
    readonly firstTimestamp?: string;
    readonly lastTimestamp?: string;
    readonly actions: Readonly<Partial<Record<MemoryAuditAction, number>>>;
  };
}

export const MEMORY_ID_PATTERN = /^memory_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const SAFE_CONTEXT_ID = /^[\p{L}\p{N}._:-]{1,160}$/u;
const MAX_LEGACY_EVIDENCE_CHARS = 8_000;
const MAX_MEMORY_MUTATIONS_PER_TURN = 8;
const MAX_EVIDENCE_HISTORY_ENTRIES = 24;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const TENTATIVE_MEMORY = /(?:可能|也许|猜测|未验证|perhaps|maybe|might|unverified)/iu;
const EXPLICIT_DURABLE_USER_CUE = /(?:以后|今后|始终|总是|统一|默认|偏好|约定|规范|prefer|always|by default|from now on|convention)/iu;

function normalizeContent(value: string): string {
  return value
    .replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。.!！]+$/u, "")
    .toLocaleLowerCase();
}

function cleanSentence(value: string): string {
  return value
    .replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function assertWorkspaceId(workspaceId: string): string {
  const resolved = workspaceId.trim();
  if (!SAFE_CONTEXT_ID.test(resolved)) {
    throw new Error("workspaceId is invalid");
  }
  return resolved;
}

function assertMemoryId(memoryId: string): string {
  const resolved = memoryId.trim();
  if (!MEMORY_ID_PATTERN.test(resolved)) {
    throw new Error("memoryId is invalid");
  }
  return resolved;
}

function assertContextId(value: string, label: "threadId" | "turnId"): string {
  const resolved = value.trim();
  if (!SAFE_CONTEXT_ID.test(resolved)) {
    throw new Error(`${label} is invalid`);
  }
  return resolved;
}

function assertCategory(category: LongTermMemory["category"]): LongTermMemory["category"] {
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`Unsupported memory category: ${String(category)}`);
  }
  return category;
}

function memoryContent(value: string): string {
  const content = cleanSentence(value);
  if (
    content.length < MIN_MEMORY_CONTENT_CHARS ||
    content.length > MAX_MEMORY_CONTENT_CHARS
  ) {
    throw new Error(
      `Memory content must contain ${MIN_MEMORY_CONTENT_CHARS}-${MAX_MEMORY_CONTENT_CHARS} characters`,
    );
  }
  if (
    containsSensitiveInformation(content) ||
    redactSensitiveInformation(content) !== content
  ) {
    throw new Error("Memory content contains sensitive information and was not stored");
  }
  if (TENTATIVE_MEMORY.test(content)) {
    throw new Error("Tentative or unverified statements cannot be stored as long-term memory");
  }
  return content;
}

function memoryReason(value: string): string {
  const reason = cleanSentence(value);
  if (reason.length === 0 || reason.length > MAX_MEMORY_REASON_CHARS) {
    throw new Error(`Memory reason must contain 1-${MAX_MEMORY_REASON_CHARS} characters`);
  }
  if (
    containsSensitiveInformation(reason) ||
    redactSensitiveInformation(reason) !== reason
  ) {
    throw new Error("Memory evidence contains sensitive information and was not stored");
  }
  if (TENTATIVE_MEMORY.test(reason)) {
    throw new Error("Tentative or unverified evidence cannot support long-term memory");
  }
  return reason;
}

function snapshot(row: MemoryRow): MemorySnapshot {
  return {
    category: row.category,
    content: redactSensitiveInformation(row.content),
    confidence: row.confidence,
    status: row.status,
  };
}

function evidenceDocument(value: string | null): MemoryEvidenceDocument {
  if (!value) return { version: 1, history: [] };
  try {
    const parsed = JSON.parse(value) as {
      version?: unknown;
      history?: unknown;
      legacy?: unknown;
      compacted?: MemoryEvidenceDocument["compacted"];
    };
    if (parsed.version === 1 && Array.isArray(parsed.history)) {
      return {
        version: 1,
        // Evidence emitted by this module is immutable audit data. Newer
        // detailed events are retained and older ones are compacted below.
        history: parsed.history as MemoryAuditEntry[],
        ...(typeof parsed.legacy === "string"
          ? { legacy: redactSensitiveInformation(parsed.legacy) }
          : {}),
        ...(parsed.compacted ? { compacted: parsed.compacted } : {}),
      };
    }
  } catch {
    // Legacy or damaged evidence is retained below as inert, redacted text.
  }
  return {
    version: 1,
    history: [],
    legacy: redactSensitiveInformation(value).slice(0, MAX_LEGACY_EVIDENCE_CHARS),
  };
}

function appendEvidence(
  existing: string | null,
  entry: MemoryAuditEntry,
): string {
  const previous = evidenceDocument(existing);
  const history = [...previous.history, entry];
  const compacted = {
    count: previous.compacted?.count ?? 0,
    firstTimestamp: previous.compacted?.firstTimestamp,
    lastTimestamp: previous.compacted?.lastTimestamp,
    actions: { ...(previous.compacted?.actions ?? {}) },
  };
  const compactOldest = (): void => {
    const removed = history.shift();
    if (!removed) return;
    compacted.count += 1;
    compacted.firstTimestamp ??= removed.timestamp;
    compacted.lastTimestamp = removed.timestamp;
    compacted.actions[removed.action] = (compacted.actions[removed.action] ?? 0) + 1;
  };
  while (history.length > MAX_EVIDENCE_HISTORY_ENTRIES) compactOldest();

  const document = (): MemoryEvidenceDocument => ({
    version: 1,
    history,
    ...(previous.legacy ? { legacy: previous.legacy } : {}),
    ...(compacted.count > 0 ? { compacted } : {}),
  });
  while (
    history.length > 1 &&
    Buffer.byteLength(JSON.stringify(document()), "utf8") > MAX_EVIDENCE_BYTES
  ) {
    compactOldest();
  }
  const serialized = JSON.stringify(document());
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVIDENCE_BYTES) {
    throw new Error("Memory audit evidence exceeds its storage limit");
  }
  return serialized;
}

function modelEvidence(
  source: { readonly threadId: string; readonly turnId: string; readonly reason: string },
  action: MemoryAuditAction,
  timestamp: string,
  options: {
    readonly relatedMemoryId?: string;
    readonly previous?: MemorySnapshot;
  } = {},
): MemoryAuditEntry {
  return {
    action,
    threadId: assertContextId(source.threadId, "threadId"),
    turnId: assertContextId(source.turnId, "turnId"),
    timestamp,
    reason: memoryReason(source.reason),
    ...options,
  };
}

function safeLimit(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value !== undefined && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(Math.trunc(resolved), maximum));
}

function toMemory(row: MemoryRow): Readonly<LongTermMemory> {
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    category: row.category,
    content: redactSensitiveInformation(row.content),
    confidence: row.confidence,
    status: row.status,
    evidence: row.evidence ? redactSensitiveInformation(row.evidence) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function ftsExpression(query: string): string | undefined {
  const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const unique = [...new Set(tokens)].slice(0, 8);
  if (unique.length === 0) return undefined;
  return unique
    .map((token) => `"${token.replace(/"/g, "\"\"")}"*`)
    .join(" OR ");
}

/**
 * Workspace-scoped long-term memory. Durable mutations are explicit model
 * decisions with thread/turn evidence; revision and forgetting retain history.
 */
export class MemoryManager {
  private readonly vectorIndex: MemorySemanticSearchIndex | undefined;
  private readonly onVectorError: ((error: unknown) => void) | undefined;

  constructor(
    private readonly storage: EasyCodeStorage,
    options: MemoryManagerOptions = {},
  ) {
    this.vectorIndex = options.vectorIndex;
    this.onVectorError = options.onVectorError;
  }

  private reportVectorError(error: unknown): void {
    try {
      this.onVectorError?.(error);
    } catch {
      // Error reporting is best-effort. A diagnostic callback must never turn
      // a rebuildable vector-index failure into a durable-memory failure.
    }
  }

  search(
    workspaceId: string,
    query: string,
    options: MemorySearchOptions | number = {},
  ): ReadonlyArray<Readonly<LongTermMemory>> {
    return this.searchLexical(workspaceId, query, options, true);
  }

  /**
   * Hybrid semantic + lexical retrieval. SQLite remains authoritative and the
   * vector index is derived, so any embedding/runtime failure safely falls
   * back to the existing FTS5/token search path.
   */
  async searchHybrid(
    workspaceId: string,
    query: string,
    options: MemorySearchOptions | number = {},
  ): Promise<ReadonlyArray<Readonly<LongTermMemory>>> {
    workspaceId = assertWorkspaceId(workspaceId);
    const resolvedOptions = typeof options === "number" ? { limit: options } : options;
    const limit = safeLimit(resolvedOptions.limit, 6, 50);
    const requestedConfidence = resolvedOptions.minimumConfidence;
    const minimumConfidence = Number.isFinite(requestedConfidence)
      ? Math.max(0, Math.min(requestedConfidence as number, 1))
      : 0.55;
    const includeInactive = resolvedOptions.includeInactive === true;
    const boundedQuery = query.slice(0, MAX_MEMORY_SEARCH_CHARS);
    const candidateLimit = Math.min(50, Math.max(limit * 4, 20));
    const lexical = this.searchLexical(
      workspaceId,
      boundedQuery,
      {
        limit: candidateLimit,
        minimumConfidence,
        includeInactive,
      },
      false,
    );

    if (!this.vectorIndex || !boundedQuery.trim()) {
      const selected = lexical.slice(0, limit);
      this.touch(workspaceId, selected.map((memory) => memory.id));
      return Object.freeze(selected);
    }

    let semantic: ReadonlyArray<Readonly<MemoryVectorSearchHit>>;
    try {
      semantic = await this.vectorIndex.search(workspaceId, boundedQuery, {
        limit: candidateLimit,
        minimumSimilarity: 0.1,
        minimumConfidence,
        includeInactive,
      });
    } catch (error) {
      this.reportVectorError(error);
      const selected = lexical.slice(0, limit);
      this.touch(workspaceId, selected.map((memory) => memory.id));
      return Object.freeze(selected);
    }

    interface HybridCandidate {
      memory: Readonly<LongTermMemory>;
      lexicalRank?: number;
      semanticScore?: number;
    }
    const candidates = new Map<string, HybridCandidate>();
    lexical.forEach((memory, lexicalRank) => {
      candidates.set(memory.id, { memory, lexicalRank });
    });
    for (const hit of semantic) {
      if (!MEMORY_ID_PATTERN.test(hit.id)) continue;
      const memory = this.get(workspaceId, hit.id);
      if (
        !memory ||
        (!includeInactive && memory.status !== "active") ||
        memory.confidence < minimumConfidence
      ) {
        continue;
      }
      const existing = candidates.get(memory.id);
      candidates.set(memory.id, {
        memory,
        ...(existing?.lexicalRank !== undefined
          ? { lexicalRank: existing.lexicalRank }
          : {}),
        semanticScore: Math.max(0, Math.min(hit.score, 1)),
      });
    }

    const ranked = [...candidates.values()]
      .map((candidate) => {
        const lexicalScore = candidate.lexicalRank === undefined
          ? 0
          : 1 - candidate.lexicalRank / (lexical.length + 1);
        const score =
          (candidate.semanticScore ?? 0) * 0.72 +
          lexicalScore * 0.23 +
          candidate.memory.confidence * 0.05;
        return { ...candidate, score };
      })
      .sort((left, right) =>
        right.score - left.score ||
        right.memory.confidence - left.memory.confidence ||
        right.memory.updatedAt.localeCompare(left.memory.updatedAt),
      )
      .slice(0, limit)
      .map((candidate) => candidate.memory);

    this.touch(workspaceId, ranked.map((memory) => memory.id));
    return Object.freeze(ranked);
  }

  private searchLexical(
    workspaceId: string,
    query: string,
    options: MemorySearchOptions | number,
    trackAccess: boolean,
  ): ReadonlyArray<Readonly<LongTermMemory>> {
    workspaceId = assertWorkspaceId(workspaceId);
    const resolvedOptions = typeof options === "number" ? { limit: options } : options;
    const limit = safeLimit(resolvedOptions.limit, 6, 50);
    const requestedConfidence = resolvedOptions.minimumConfidence;
    const minimumConfidence = Number.isFinite(requestedConfidence)
      ? Math.max(0, Math.min(requestedConfidence as number, 1))
      : 0.55;
    const includeInactive = resolvedOptions.includeInactive === true;
    const boundedQuery = query.slice(0, MAX_MEMORY_SEARCH_CHARS);
    const candidateRows = new Map<string, MemoryRow>();
    const expression = ftsExpression(boundedQuery);

    if (expression) {
      try {
        const rows = this.storage.db
          .prepare<[string, string, number, number, number], MemoryRow>(
            `SELECT m.*
               FROM memories_fts
               JOIN memories AS m ON m.rowid = memories_fts.rowid
              WHERE memories_fts MATCH ?
                AND m.workspace_id = ?
                AND (? = 1 OR m.status = 'active')
                AND m.confidence >= ?
              ORDER BY bm25(memories_fts), m.confidence DESC
              LIMIT ?`,
          )
          .all(
            expression,
            workspaceId,
            includeInactive ? 1 : 0,
            minimumConfidence,
            Math.max(limit * 4, 20),
          );
        for (const row of rows) candidateRows.set(row.id, row);
      } catch {
        // A malformed or tokenizer-specific FTS query falls back to bounded
        // in-process matching. Persistence and ordinary retrieval remain usable.
      }
    }

    const fallbackRows = this.storage.db
      .prepare<[string, number, number], MemoryRow>(
        `SELECT * FROM memories
          WHERE workspace_id = ?
            AND (? = 1 OR status = 'active')
            AND confidence >= ?
          ORDER BY confidence DESC, updated_at DESC
          LIMIT 200`,
      )
      .all(workspaceId, includeInactive ? 1 : 0, minimumConfidence);
    for (const row of fallbackRows) candidateRows.set(row.id, row);

    const normalizedQuery = normalizeContent(boundedQuery);
    const queryTokens = normalizedQuery.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
    const scored = [...candidateRows.values()]
      .map((row) => {
        const content = row.normalized_content;
        let relevance = normalizedQuery.length === 0 ? 1 : 0;
        if (normalizedQuery.length > 0 && content.includes(normalizedQuery)) relevance += 4;
        for (const token of queryTokens) {
          if (content.includes(token)) relevance += 1;
        }
        return { row, score: relevance + row.confidence };
      })
      .filter((candidate) => normalizedQuery.length === 0 || candidate.score > candidate.row.confidence)
      .sort((left, right) => right.score - left.score || right.row.confidence - left.row.confidence)
      .slice(0, limit);

    if (trackAccess) this.touch(workspaceId, scored.map((item) => item.row.id));

    return Object.freeze(scored.map((item) => toMemory(item.row)));
  }

  private touch(workspaceId: string, memoryIds: readonly string[]): void {
    if (memoryIds.length === 0) return;
    const now = new Date().toISOString();
    const update = this.storage.db.prepare(
      `UPDATE memories
          SET last_accessed_at = ?, access_count = access_count + 1
        WHERE workspace_id = ? AND id = ?`,
    );
    this.storage.db.transaction(() => {
      for (const memoryId of new Set(memoryIds)) {
        update.run(now, workspaceId, memoryId);
      }
    })();
  }

  get(
    workspaceId: string,
    memoryId: string,
  ): Readonly<LongTermMemory> | undefined {
    const row = this.storage.db
      .prepare<[string, string], MemoryRow>(
        "SELECT * FROM memories WHERE workspace_id = ? AND id = ?",
      )
      .get(assertWorkspaceId(workspaceId), assertMemoryId(memoryId));
    return row ? toMemory(row) : undefined;
  }

  list(
    workspaceId: string,
    options: MemoryListOptions = {},
  ): ReadonlyArray<Readonly<LongTermMemory>> {
    workspaceId = assertWorkspaceId(workspaceId);
    const limit = safeLimit(options.limit, 100, 500);
    const offset = Number.isFinite(options.offset)
      ? Math.max(0, Math.trunc(options.offset as number))
      : 0;
    const status = options.status ?? "active";
    let rows: MemoryRow[];

    if (status !== "all") {
      rows = this.storage.db
        .prepare<[string, string, number, number], MemoryRow>(
          `SELECT * FROM memories
            WHERE workspace_id = ? AND status = ?
            ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(workspaceId, status, limit, offset);
    } else {
      rows = this.storage.db
        .prepare<[string, number, number], MemoryRow>(
          `SELECT * FROM memories
            WHERE workspace_id = ?
            ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(workspaceId, limit, offset);
    }
    return Object.freeze(rows.map(toMemory));
  }

  /**
   * Atomically commit model-proposed mutations after a successful turn. A
   * failed validation rolls back the entire batch, so no partial memory state
   * can survive. Planned turns may maintain user preferences/conventions only;
   * repository facts require a successful implementation turn.
   */
  applyModelMutations(
    input: ApplyModelMemoryMutationsInput,
  ): ApplyModelMemoryMutationsResult {
    return this.commitModelMutations(input);
  }

  /**
   * Precompute embeddings outside SQLite's synchronous transaction, then store
   * each available vector alongside its memory mutation in that transaction.
   * If local inference is unavailable, memory remains usable through lexical
   * retrieval and will be lazily backfilled by the vector index later.
   */
  async applyModelMutationsWithEmbeddings(
    input: ApplyModelMemoryMutationsInput,
  ): Promise<ApplyModelMemoryMutationsResult> {
    const prepare = this.vectorIndex?.prepareEmbeddings;
    const write = this.vectorIndex?.writePreparedEmbedding;
    if (!prepare || !write || input.mutations.length === 0) {
      return this.commitModelMutations(input);
    }

    const contents = [...new Set(input.mutations.flatMap((mutation) =>
      mutation.action === "forget" ? [] : [memoryContent(mutation.content)],
    ))];
    let preparedByContent: ReadonlyMap<string, PreparedMemoryEmbedding> | undefined;
    try {
      const prepared = await prepare.call(this.vectorIndex, contents);
      if (prepared.length !== contents.length) {
        throw new Error("Memory vector index prepared the wrong number of embeddings");
      }
      preparedByContent = new Map(
        contents.map((content, index) => [content, prepared[index]!] as const),
      );
    } catch (error) {
      this.reportVectorError(error);
    }
    return this.commitModelMutations(input, preparedByContent);
  }

  private commitModelMutations(
    input: ApplyModelMemoryMutationsInput,
    preparedByContent?: ReadonlyMap<string, PreparedMemoryEmbedding>,
  ): ApplyModelMemoryMutationsResult {
    const rootWorkspaceId = input.workspaceRoot
      ? workspaceIdFromRoot(input.workspaceRoot)
      : undefined;
    if (
      input.workspaceId &&
      rootWorkspaceId &&
      assertWorkspaceId(input.workspaceId) !== rootWorkspaceId
    ) {
      throw new Error("workspaceId does not match workspaceRoot");
    }
    const workspaceId = assertWorkspaceId(input.workspaceId ?? rootWorkspaceId ?? "");
    const threadId = assertContextId(input.threadId, "threadId");
    const turnId = assertContextId(input.turnId, "turnId");
    if (input.outcome !== "success" && input.outcome !== "planned") {
      throw new Error("Model memory mutations require a successful or planned turn");
    }
    if (
      input.outcome === "planned" &&
      !EXPLICIT_DURABLE_USER_CUE.test(input.userInput ?? "")
    ) {
      throw new Error(
        "Planned turns may commit memory only when the current user message explicitly states a durable preference or convention",
      );
    }
    if (input.mutations.length > MAX_MEMORY_MUTATIONS_PER_TURN) {
      throw new Error(
        `A turn can commit at most ${MAX_MEMORY_MUTATIONS_PER_TURN} memory mutations`,
      );
    }
    if (input.mutations.length === 0) {
      return Object.freeze({ applied: 0, memoryIds: [] });
    }

    const selectById = this.storage.db.prepare<[string, string], MemoryRow>(
      "SELECT * FROM memories WHERE workspace_id = ? AND id = ?",
    );
    const selectByContent = this.storage.db.prepare<[string, string], MemoryRow>(
      "SELECT * FROM memories WHERE workspace_id = ? AND normalized_content = ?",
    );
    const insert = this.storage.db.prepare(
      `INSERT INTO memories(
         id, workspace_id, category, content, normalized_content, confidence,
         status, evidence, source_thread_id, source_turn_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    );
    const updateActive = this.storage.db.prepare(
      `UPDATE memories
          SET category = ?, content = ?, normalized_content = ?, confidence = ?,
              status = 'active', evidence = ?, source_thread_id = ?,
              source_turn_id = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
    );
    const updateStatus = this.storage.db.prepare(
      `UPDATE memories SET status = ?, evidence = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
    );
    const memoryIds: string[] = [];
    let applied = 0;

    const assertOutcomeCategory = (
      category: LongTermMemory["category"],
    ): void => {
      if (
        input.outcome === "planned" &&
        category !== "preference" &&
        category !== "convention"
      ) {
        throw new Error(
          `Planned turns cannot commit ${category} memories; only preference and convention are allowed`,
        );
      }
    };
    const evidenceSource = (reason: string): ModelMemoryEvidence => ({
      threadId,
      turnId,
      reason,
    });
    const recordId = (memoryId: string): void => {
      if (!memoryIds.includes(memoryId)) memoryIds.push(memoryId);
    };
    const storeEmbedding = (
      memoryId: string,
      content: string,
      updatedAt: string,
    ): void => {
      const prepared = preparedByContent?.get(content);
      const writePrepared = this.vectorIndex?.writePreparedEmbedding;
      if (!prepared || !writePrepared) return;
      try {
        writePrepared.call(this.vectorIndex, memoryId, prepared, updatedAt);
      } catch (error) {
        // Embeddings are a rebuildable projection. A derived-index failure
        // must not roll back a validated durable memory mutation.
        this.reportVectorError(error);
      }
    };

    this.storage.db.transaction(() => {
      for (const mutation of input.mutations) {
        const now = new Date().toISOString();
        if (mutation.action === "remember") {
          const category = assertCategory(mutation.category);
          assertOutcomeCategory(category);
          const content = memoryContent(mutation.content);
          const normalized = normalizeContent(content);
          const reason = memoryReason(mutation.reason);
          const existing = selectByContent.get(workspaceId, normalized);
          if (existing?.status === "superseded") {
            throw new Error(
              `Memory ${existing.id} is superseded; revise its active replacement instead`,
            );
          }
          if (existing) {
            const confidence = Math.min(
              0.95,
              Math.max(existing.confidence, 0.8) + 0.03,
            );
            const evidence = appendEvidence(
              existing.evidence,
              modelEvidence(evidenceSource(reason), "upsert", now, {
                previous: snapshot(existing),
              }),
            );
            updateActive.run(
              category,
              content,
              normalized,
              confidence,
              evidence,
              threadId,
              turnId,
              now,
              workspaceId,
              existing.id,
            );
            storeEmbedding(existing.id, content, now);
            if (!selectById.get(workspaceId, existing.id)) {
              throw new Error("Memory upsert verification failed");
            }
            recordId(existing.id);
            applied += 1;
            continue;
          }

          const memoryId = createId("memory");
          const evidence = appendEvidence(
            null,
            modelEvidence(evidenceSource(reason), "remember", now),
          );
          insert.run(
            memoryId,
            workspaceId,
            category,
            content,
            normalized,
            0.8,
            evidence,
            threadId,
            turnId,
            now,
            now,
          );
          storeEmbedding(memoryId, content, now);
          if (!selectById.get(workspaceId, memoryId)) {
            throw new Error("Memory creation verification failed");
          }
          recordId(memoryId);
          applied += 1;
          continue;
        }

        const memoryId = assertMemoryId(mutation.memoryId);
        const existing = selectById.get(workspaceId, memoryId);
        if (!existing) {
          throw new Error("Long-term memory was not found in this workspace");
        }

        if (mutation.action === "forget") {
          assertOutcomeCategory(existing.category);
          if (existing.status === "expired" || existing.status === "superseded") {
            continue;
          }
          const reason = memoryReason(mutation.reason);
          const evidence = appendEvidence(
            existing.evidence,
            modelEvidence(evidenceSource(reason), "forget", now, {
              previous: snapshot(existing),
            }),
          );
          updateStatus.run("expired", evidence, now, workspaceId, existing.id);
          const expired = selectById.get(workspaceId, existing.id);
          if (expired?.status !== "expired") {
            throw new Error("Memory expiration verification failed");
          }
          recordId(existing.id);
          applied += 1;
          continue;
        }

        if (existing.status !== "active" && existing.status !== "needs_verification") {
          throw new Error(
            `Only active memories can be revised; current status is ${existing.status}`,
          );
        }
        const category = assertCategory(mutation.category);
        assertOutcomeCategory(category);
        const content = memoryContent(mutation.content);
        const normalized = normalizeContent(content);
        const reason = memoryReason(mutation.reason);
        const conflict = selectByContent.get(workspaceId, normalized);
        if (conflict && conflict.id !== existing.id) {
          throw new Error(`Replacement content already belongs to memory ${conflict.id}`);
        }
        const confidence = Math.max(existing.confidence, 0.8);

        if (normalized === existing.normalized_content) {
          const evidence = appendEvidence(
            existing.evidence,
            modelEvidence(evidenceSource(reason), "revise", now, {
              previous: snapshot(existing),
            }),
          );
          updateActive.run(
            category,
            content,
            normalized,
            confidence,
            evidence,
            threadId,
            turnId,
            now,
            workspaceId,
            existing.id,
          );
          storeEmbedding(existing.id, content, now);
          if (!selectById.get(workspaceId, existing.id)) {
            throw new Error("Memory revision verification failed");
          }
          recordId(existing.id);
          applied += 1;
          continue;
        }

        const replacementId = createId("memory");
        const oldEvidence = appendEvidence(
          existing.evidence,
          modelEvidence(evidenceSource(reason), "supersede", now, {
            relatedMemoryId: replacementId,
            previous: snapshot(existing),
          }),
        );
        updateStatus.run(
          "superseded",
          oldEvidence,
          now,
          workspaceId,
          existing.id,
        );
        const newEvidence = appendEvidence(
          null,
          modelEvidence(evidenceSource(reason), "revise", now, {
            relatedMemoryId: existing.id,
          }),
        );
        insert.run(
          replacementId,
          workspaceId,
          category,
          content,
          normalized,
          confidence,
          newEvidence,
          threadId,
          turnId,
          now,
          now,
        );
        storeEmbedding(replacementId, content, now);
        const superseded = selectById.get(workspaceId, existing.id);
        const replacement = selectById.get(workspaceId, replacementId);
        if (superseded?.status !== "superseded" || !replacement) {
          throw new Error("Memory supersession verification failed");
        }
        recordId(replacementId);
        applied += 1;
      }
    })();

    if (preparedByContent?.size) this.vectorIndex?.invalidate?.(workspaceId);

    return Object.freeze({ applied, memoryIds: [...memoryIds] });
  }
}
