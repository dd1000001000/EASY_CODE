import {
  MAX_MEMORY_MUTATIONS_PER_TURN,
  type AgentRunResult,
  type LongTermMemory,
  type LongTermMemoryScope,
  type MemoryMutationRequest,
} from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { createId } from "../utils/ids.js";
import { EvidenceStore } from "../context/evidence-store.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { projectRootFromWorkspace } from "../workspace/project-root.js";
import { containsSensitiveInformation, redactSensitiveInformation } from "./sensitive.js";
import type { MemoryVectorSearchHit, MemoryVectorSearchOptions, PreparedMemoryEmbedding } from "./vector-index.js";
import { memoryExpiryDays, memoryFreshnessWeight } from "./lifecycle.js";
import { memorySearchTerms, memorySearchText } from "./search-terms.js";

export interface MemorySearchOptions {
  readonly workspaceRoot?: string;
  readonly limit?: number;
  /** Include inactive audit-history rows. Ordinary retrieval stays active-only. */
  readonly includeInactive?: boolean;
  /** Ordinary recall favors fresh memories; consolidation ranks by similarity alone. */
  readonly ranking?: "recall" | "consolidation";
  /** Apply authoritative memory metadata filters before truncating candidates. */
  readonly filter?: Readonly<{
    scope?: LongTermMemoryScope;
    category?: LongTermMemory["category"];
    status?: LongTermMemory["status"];
    excludeMemoryId?: string;
  }>;
}

export const GLOBAL_MEMORY_WORKSPACE_ID = "memory_global";

export function projectMemoryIdFromRoot(workspaceRoot: string): string {
  return workspaceIdFromRoot(projectRootFromWorkspace(workspaceRoot));
}

export type MemoryScopeFilter = LongTermMemoryScope | "all";

export interface MemoryListOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly status?: LongTermMemory["status"] | "all";
}

export interface MemorySemanticSearchIndex {
  close?(): void;
  search(
    workspaceId: string,
    query: string,
    options?: MemoryVectorSearchOptions,
  ): Promise<ReadonlyArray<Readonly<MemoryVectorSearchHit>>>;
  prepareEmbeddings?(contents: readonly string[]): Promise<readonly PreparedMemoryEmbedding[]>;
  writePreparedEmbedding?(memoryId: string, prepared: PreparedMemoryEmbedding, updatedAt?: string): void;
  invalidate?(workspaceId: string): void;
}

export interface MemoryManagerOptions {
  readonly limits?: Readonly<RuntimeLimits>;
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
/** Keep one memory small enough to represent one independently retrievable fact. */
export const MAX_MEMORY_CONTENT_CHARS = DEFAULT_RUNTIME_LIMITS.memoryContentMaxChars;
export const MAX_MEMORY_REASON_CHARS = 500;
export const MAX_MEMORY_SEARCH_CHARS = 500;

export interface ApplyModelMemoryMutationsInput {
  readonly workspaceId?: string;
  readonly workspaceRoot?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly outcome: AgentRunResult["reason"];
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
  scope: LongTermMemoryScope;
  category: LongTermMemory["category"];
  content: string;
  normalized_content: string;
  status: LongTermMemory["status"];
  evidence: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
}

type MemoryAuditAction = "remember" | "upsert" | "revise" | "supersede" | "forget" | "move" | "flag";

interface MemorySnapshot {
  readonly category: LongTermMemory["category"];
  readonly content: string;
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
  readonly compacted?: {
    readonly count: number;
    readonly firstTimestamp?: string;
    readonly lastTimestamp?: string;
    readonly actions: Readonly<Partial<Record<MemoryAuditAction, number>>>;
  };
}

export const MEMORY_ID_PATTERN = /^memory_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const SAFE_CONTEXT_ID = /^[\p{L}\p{N}._:-]{1,160}$/u;
const MAX_EVIDENCE_HISTORY_ENTRIES = 24;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_FTS_TERMS = 16;
/** Thread recorded for the user's own edits, so deleting a conversation never reverts them. */
const USER_MEMORY_SOURCE = "user";
/** Measured with the bundled multilingual MiniLM: related memory/query pairs
 * scored 0.48-0.67 and unrelated ones up to 0.29. */
const CONFIDENT_SEMANTIC_SCORE = 0.45;
/** At least half of the query's terms appear in the memory. */
const CONFIDENT_LEXICAL_COVERAGE = 0.5;

interface LexicalMatch {
  readonly memory: Readonly<LongTermMemory>;
  /** Share of the query's terms found in the memory; the whole query as a phrase counts fully. */
  readonly coverage: number;
  readonly freshness: number;
  readonly confident: boolean;
}

/** Only a confident match counts as use when delivered; weaker ones are offered without deferring expiry. */
function recalled(memory: Readonly<LongTermMemory>, confident: boolean): Readonly<LongTermMemory> {
  return confident ? Object.freeze({ ...memory, countsAsUse: true }) : memory;
}

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

function memoryContent(value: string, maximum = MAX_MEMORY_CONTENT_CHARS): string {
  const content = cleanSentence(value);
  if (content.length < MIN_MEMORY_CONTENT_CHARS || content.length > maximum) {
    throw new Error(`Memory content must contain ${MIN_MEMORY_CONTENT_CHARS}-${maximum} characters`);
  }
  if (containsSensitiveInformation(content) || redactSensitiveInformation(content) !== content) {
    throw new Error("Memory content contains sensitive information and was not stored");
  }
  return content;
}

function memoryReason(value: string): string {
  const reason = cleanSentence(value);
  if (reason.length === 0 || reason.length > MAX_MEMORY_REASON_CHARS) {
    throw new Error(`Memory reason must contain 1-${MAX_MEMORY_REASON_CHARS} characters`);
  }
  if (containsSensitiveInformation(reason) || redactSensitiveInformation(reason) !== reason) {
    throw new Error("Memory evidence contains sensitive information and was not stored");
  }
  return reason;
}

function snapshot(row: MemoryRow): MemorySnapshot {
  return {
    category: row.category,
    content: redactSensitiveInformation(row.content),
    status: row.status,
  };
}

function evidenceDocument(value: string | null): MemoryEvidenceDocument {
  if (!value) return { version: 1, history: [] };
  try {
    const parsed = JSON.parse(value) as {
      version?: unknown;
      history?: unknown;
      compacted?: MemoryEvidenceDocument["compacted"];
    };
    if (parsed.version === 1 && Array.isArray(parsed.history)) {
      return {
        version: 1,
        // Evidence emitted by this module is immutable audit data. Newer
        // detailed events are retained and older ones are compacted below.
        history: parsed.history as MemoryAuditEntry[],
        ...(parsed.compacted ? { compacted: parsed.compacted } : {}),
      };
    }
  } catch {
    // Unsupported development data remains untouched in SQLite until a current
    // mutation replaces it; it never enters current prompts or audit history.
  }
  return { version: 1, history: [] };
}

function appendEvidence(existing: string | null, entry: MemoryAuditEntry): string {
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
    ...(compacted.count > 0 ? { compacted } : {}),
  });
  while (history.length > 1 && Buffer.byteLength(JSON.stringify(document()), "utf8") > MAX_EVIDENCE_BYTES) {
    compactOldest();
  }
  const serialized = JSON.stringify(document());
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVIDENCE_BYTES) {
    throw new Error("Memory audit evidence exceeds its storage limit");
  }
  return serialized;
}

function modelEvidence(
  source: ModelMemoryEvidence,
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
    scope: row.scope,
    category: row.category,
    content: redactSensitiveInformation(row.content),
    status: row.status,
    evidence: row.evidence ? redactSensitiveInformation(row.evidence) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function ftsExpression(query: string): string | undefined {
  // Terms hold only letters and digits; quoting keeps words such as OR literal.
  const terms = memorySearchTerms(query).slice(0, MAX_FTS_TERMS);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term}"*`).join(" OR ");
}

/**
 * Workspace-scoped long-term memory. Durable mutations are explicit model
 * decisions with thread/turn evidence; revision and forgetting retain history.
 */
/** One transaction of model memory mutations: the turn it belongs to, its prepared statements and what it changed. */
interface ModelMutationBatch {
  readonly threadId: string;
  readonly turnId: string;
  readonly ownerId: (scope: LongTermMemoryScope) => string;
  readonly statements: ReturnType<typeof prepareMutationStatements>;
  readonly preparedByContent: ReadonlyMap<string, PreparedMemoryEmbedding> | undefined;
  readonly memoryIds: string[];
  readonly affectedScopes: Set<string>;
  applied: number;
}

/** The statements commitModelMutations runs inside its transaction. */
function prepareMutationStatements(db: EasyCodeStorage["db"]) {
  return {
    selectById: db.prepare<[string, string], MemoryRow>("SELECT * FROM memories WHERE workspace_id = ? AND id = ?"),
    selectByContent: db.prepare<[string, string], MemoryRow>(
      "SELECT * FROM memories WHERE workspace_id = ? AND normalized_content = ?",
    ),
    insert: db.prepare(
      `INSERT INTO memories(
         id, workspace_id, scope, category, content, normalized_content, search_text,
         status, evidence, source_thread_id, source_turn_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateActive: db.prepare(
      `UPDATE memories
          SET category = ?, content = ?, normalized_content = ?, search_text = ?,
              status = ?, evidence = ?, source_thread_id = ?,
              source_turn_id = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
    ),
    updateStatus: db.prepare(
      `UPDATE memories SET status = ?, evidence = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
    ),
    updateScope: db.prepare(
      "UPDATE memories SET workspace_id = ?, scope = ?, evidence = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    ),
    confirmRevision: db.prepare("UPDATE memories SET last_accessed_at = ? WHERE workspace_id = ? AND id = ?"),
  };
}

export class MemoryManager {
  readonly evidenceStore: EvidenceStore;
  readonly limits: Readonly<RuntimeLimits>;
  close(): void {
    this.vectorIndex?.close?.();
  }
  private readonly vectorIndex: MemorySemanticSearchIndex | undefined;
  private readonly onVectorError: ((error: unknown) => void) | undefined;

  constructor(
    private readonly storage: EasyCodeStorage,
    options: MemoryManagerOptions = {},
  ) {
    this.limits = options.limits ?? DEFAULT_RUNTIME_LIMITS;
    this.evidenceStore = new EvidenceStore(storage, this.limits);
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
    return this.searchLexical(workspaceId, query, options);
  }

  scopeGenerationKey(projectId: string): string {
    const read = this.storage.db.prepare<[string], { generation: number }>(
      "SELECT generation FROM memory_vector_state WHERE workspace_id = ?",
    );
    return `${read.get(projectId)?.generation ?? 0}:${read.get(GLOBAL_MEMORY_WORKSPACE_ID)?.generation ?? 0}`;
  }

  getAccessible(projectId: string, memoryId: string): Readonly<LongTermMemory> | undefined {
    this.expireDueMemories(projectId);
    this.expireDueMemories(GLOBAL_MEMORY_WORKSPACE_ID);
    return this.get(projectId, memoryId) ?? this.get(GLOBAL_MEMORY_WORKSPACE_ID, memoryId);
  }

  listScoped(
    projectId: string,
    scope: MemoryScopeFilter = "all",
    options: MemoryListOptions = {},
  ): ReadonlyArray<Readonly<LongTermMemory>> {
    if (scope !== "all") {
      return this.list(scope === "global" ? GLOBAL_MEMORY_WORKSPACE_ID : projectId, options);
    }
    this.expireDueMemories(projectId);
    this.expireDueMemories(GLOBAL_MEMORY_WORKSPACE_ID);
    const limit = safeLimit(options.limit, 100, 500);
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.trunc(options.offset as number)) : 0;
    const status = options.status ?? "active";
    const rows =
      status === "all"
        ? this.storage.db
            .prepare<[string, string, number, number], MemoryRow>(
              "SELECT * FROM memories WHERE workspace_id IN (?, ?) ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            )
            .all(assertWorkspaceId(projectId), GLOBAL_MEMORY_WORKSPACE_ID, limit, offset)
        : this.storage.db
            .prepare<[string, string, string, number, number], MemoryRow>(
              "SELECT * FROM memories WHERE workspace_id IN (?, ?) AND status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            )
            .all(assertWorkspaceId(projectId), GLOBAL_MEMORY_WORKSPACE_ID, status, limit, offset);
    return Object.freeze(rows.map(toMemory));
  }

  async searchScoped(
    projectId: string,
    query: string,
    options: MemorySearchOptions & { scope?: MemoryScopeFilter; includeGlobalPreferences?: boolean } = {},
  ): Promise<ReadonlyArray<Readonly<LongTermMemory>>> {
    const limit = safeLimit(options.limit, 6, 50);
    const scope = options.scope ?? "all";
    const hasGlobal =
      scope !== "project" &&
      !!this.storage.db
        .prepare<[string, number], { present: number }>(
          "SELECT 1 AS present FROM memories WHERE workspace_id = ? AND (? = 1 OR status IN ('active', 'needs_verification')) LIMIT 1",
        )
        .get(GLOBAL_MEMORY_WORKSPACE_ID, options.includeInactive ? 1 : 0);
    const project =
      scope === "global"
        ? []
        : await this.searchHybrid(projectId, query, {
            ...options,
            limit,
            workspaceRoot: options.workspaceRoot ? projectRootFromWorkspace(options.workspaceRoot) : undefined,
          });
    const global = !hasGlobal
      ? []
      : await this.searchHybrid(GLOBAL_MEMORY_WORKSPACE_ID, query, {
          ...options,
          limit,
          workspaceRoot: undefined,
        });
    const preferences =
      !hasGlobal || !options.includeGlobalPreferences
        ? []
        : this.storage.db
            // Standing preferences apply to every request, so delivering one is
            // a use. Choosing them by last use would let the same three renew
            // each other forever; the most recently stated ones lead instead.
            .prepare<[string], MemoryRow>(
              `SELECT * FROM memories WHERE workspace_id = ? AND status = 'active'
           AND category IN ('preference', 'convention')
         ORDER BY updated_at DESC LIMIT 3`,
            )
            .all(GLOBAL_MEMORY_WORKSPACE_ID)
            .map((row) => recalled(toMemory(row), true));
    const globalCandidates = [...new Map([...preferences, ...global].map((memory) => [memory.id, memory])).values()];
    const reservedGlobal = Math.min(2, globalCandidates.length, limit);
    const seen = new Set<string>();
    return Object.freeze(
      [...project.slice(0, limit - reservedGlobal), ...globalCandidates]
        .filter((memory) => {
          if (seen.has(memory.id)) return false;
          seen.add(memory.id);
          return true;
        })
        .slice(0, limit),
    );
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
    const includeInactive = resolvedOptions.includeInactive === true;
    const ranking = resolvedOptions.ranking ?? "recall";
    const boundedQuery = query.slice(0, MAX_MEMORY_SEARCH_CHARS);
    const candidateLimit = Math.min(50, Math.max(limit * 4, 20));
    const lexical = this.lexicalMatches(workspaceId, boundedQuery, {
      limit: candidateLimit,
      includeInactive,
      ranking,
      filter: resolvedOptions.filter,
    });
    const lexicalOnly = (): readonly Readonly<LongTermMemory>[] =>
      Object.freeze(lexical.slice(0, limit).map((match) => recalled(match.memory, match.confident)));

    if (!this.vectorIndex || !boundedQuery.trim()) return lexicalOnly();

    let semantic: ReadonlyArray<Readonly<MemoryVectorSearchHit>>;
    try {
      semantic = await this.vectorIndex.search(workspaceId, boundedQuery, {
        limit: candidateLimit,
        minimumSimilarity: this.limits.memoryVectorMinSimilarity,
        // The authoritative status filter below excludes expired and
        // superseded memories unless the caller explicitly requests them.
        includeInactive: true,
        scope: resolvedOptions.filter?.scope,
        category: resolvedOptions.filter?.category,
        status: resolvedOptions.filter?.status,
        excludeMemoryId: resolvedOptions.filter?.excludeMemoryId,
      });
    } catch (error) {
      this.reportVectorError(error);
      return lexicalOnly();
    }

    interface HybridCandidate {
      memory: Readonly<LongTermMemory>;
      freshness: number;
      lexical?: LexicalMatch;
      semanticScore?: number;
    }
    const candidates = new Map<string, HybridCandidate>();
    for (const match of lexical) {
      candidates.set(match.memory.id, { memory: match.memory, freshness: match.freshness, lexical: match });
    }
    // Load every memory found only by the vector index in one query.
    const semanticOnly = semantic
      .map((hit) => hit.id)
      .filter((id) => MEMORY_ID_PATTERN.test(id) && !candidates.has(id));
    const semanticRows = new Map(
      (semanticOnly.length
        ? this.storage.db
            .prepare<unknown[], MemoryRow>(
              `SELECT * FROM memories WHERE workspace_id = ? AND id IN (${semanticOnly.map(() => "?").join(", ")})`,
            )
            .all(workspaceId, ...semanticOnly)
        : []
      ).map((row) => [row.id, row] as const),
    );
    for (const hit of semantic) {
      const semanticScore = Math.max(0, Math.min(hit.score, 1));
      const existing = candidates.get(hit.id);
      if (existing) {
        existing.semanticScore = semanticScore;
        continue;
      }
      const row = semanticRows.get(hit.id);
      if (!row || (!includeInactive && row.status !== "active" && row.status !== "needs_verification")) continue;
      const memory = toMemory(row);
      if (!this.matchesSearchFilter(memory, resolvedOptions.filter)) continue;
      const freshness = this.rowFreshness(row);
      if (ranking === "recall" && !includeInactive && freshness === 0) continue;
      candidates.set(hit.id, { memory, freshness, semanticScore });
    }

    const ranked = [...candidates.values()]
      .map((candidate) => {
        const semanticScore = candidate.semanticScore ?? 0;
        const score = semanticScore * 0.76 + (candidate.lexical?.coverage ?? 0) * 0.24;
        const confident = semanticScore >= CONFIDENT_SEMANTIC_SCORE || candidate.lexical?.confident === true;
        return {
          memory: recalled(candidate.memory, confident),
          score: ranking === "consolidation" ? score : score * candidate.freshness,
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          (ranking === "consolidation"
            ? left.memory.createdAt.localeCompare(right.memory.createdAt) ||
              left.memory.id.localeCompare(right.memory.id)
            : right.memory.updatedAt.localeCompare(left.memory.updatedAt)),
      )
      .map((candidate) => candidate.memory);
    return Object.freeze(ranked.slice(0, limit));
  }

  private rowFreshness(row: MemoryRow): number {
    return memoryFreshnessWeight(row.last_accessed_at, row.created_at, memoryExpiryDays(row.scope, this.limits));
  }

  private appendRevision(memoryId: string, threadId: string, turnId: string): void {
    const row = this.storage.db.prepare<[string], MemoryRow>("SELECT * FROM memories WHERE id = ?").get(memoryId);
    if (row)
      this.storage.db
        .prepare(
          "INSERT INTO memory_revisions(memory_id, thread_id, turn_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(memoryId, threadId, turnId, JSON.stringify({ memory: row }), new Date().toISOString());
  }

  private searchLexical(
    workspaceId: string,
    query: string,
    options: MemorySearchOptions | number,
  ): ReadonlyArray<Readonly<LongTermMemory>> {
    return Object.freeze(
      this.lexicalMatches(workspaceId, query, options).map((match) => recalled(match.memory, match.confident)),
    );
  }

  private lexicalMatches(workspaceId: string, query: string, options: MemorySearchOptions | number): LexicalMatch[] {
    // Searching never writes: a memory past its expiry is left out of recall
    // here and marked expired by idle maintenance.
    workspaceId = assertWorkspaceId(workspaceId);
    const resolvedOptions = typeof options === "number" ? { limit: options } : options;
    const limit = safeLimit(resolvedOptions.limit, 6, 50);
    const includeInactive = resolvedOptions.includeInactive === true;
    const ranking = resolvedOptions.ranking ?? "recall";
    const boundedQuery = query.slice(0, MAX_MEMORY_SEARCH_CHARS);
    const candidateRows = new Map<string, MemoryRow>();
    const expression = ftsExpression(boundedQuery);
    const filter = resolvedOptions.filter;
    const sqlFilter = (alias: string): { clause: string; values: unknown[] } => {
      const clauses: string[] = [];
      const values: unknown[] = [];
      if (filter?.scope) {
        clauses.push(`AND ${alias}scope = ?`);
        values.push(filter.scope);
      }
      if (filter?.category) {
        clauses.push(`AND ${alias}category = ?`);
        values.push(filter.category);
      }
      if (filter?.status) {
        clauses.push(`AND ${alias}status = ?`);
        values.push(filter.status);
      }
      if (filter?.excludeMemoryId) {
        clauses.push(`AND ${alias}id <> ?`);
        values.push(filter.excludeMemoryId);
      }
      return { clause: clauses.join("\n                "), values };
    };

    if (expression) {
      try {
        const ftsFilter = sqlFilter("m.");
        const rows = this.storage.db
          .prepare<unknown[], MemoryRow>(
            `SELECT m.*
               FROM memories_fts
               JOIN memories AS m ON m.rowid = memories_fts.rowid
              WHERE memories_fts MATCH ?
                AND m.workspace_id = ?
                AND (? = 1 OR m.status IN ('active', 'needs_verification'))
                ${ftsFilter.clause}
              ORDER BY bm25(memories_fts)
              LIMIT ?`,
          )
          .all(expression, workspaceId, includeInactive ? 1 : 0, ...ftsFilter.values, Math.max(limit * 4, 20));
        for (const row of rows) candidateRows.set(row.id, row);
      } catch {
        // A malformed or tokenizer-specific FTS query falls back to bounded
        // in-process matching. Persistence and ordinary retrieval remain usable.
      }
    }

    const fallbackFilter = sqlFilter("");
    const fallbackRows = this.storage.db
      .prepare<unknown[], MemoryRow>(
        `SELECT * FROM memories
          WHERE workspace_id = ?
            AND (? = 1 OR status IN ('active', 'needs_verification'))
            ${fallbackFilter.clause}
          ORDER BY updated_at DESC
          LIMIT 200`,
      )
      .all(workspaceId, includeInactive ? 1 : 0, ...fallbackFilter.values);
    for (const row of fallbackRows) candidateRows.set(row.id, row);

    const normalizedQuery = normalizeContent(boundedQuery);
    const queryTerms = memorySearchTerms(normalizedQuery);
    const scored = [...candidateRows.values()]
      .map((row) => {
        const content = row.normalized_content;
        const coverage =
          normalizedQuery.length === 0 || content.includes(normalizedQuery)
            ? 1
            : queryTerms.length === 0
              ? 0
              : queryTerms.filter((term) => content.includes(term)).length / queryTerms.length;
        const freshness = this.rowFreshness(row);
        return { row, score: ranking === "consolidation" ? coverage : coverage * freshness, coverage, freshness };
      })
      .filter(
        (candidate) =>
          candidate.coverage > 0 && (ranking === "consolidation" || includeInactive || candidate.freshness > 0),
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          (ranking === "consolidation"
            ? left.row.created_at.localeCompare(right.row.created_at) || left.row.id.localeCompare(right.row.id)
            : right.row.updated_at.localeCompare(left.row.updated_at)),
      )
      .slice(0, limit);

    return scored.map(({ row, coverage, freshness }) => ({
      memory: toMemory(row),
      coverage,
      freshness,
      confident: queryTerms.length > 0 && coverage >= CONFIDENT_LEXICAL_COVERAGE,
    }));
  }

  private matchesSearchFilter(memory: Readonly<LongTermMemory>, filter: MemorySearchOptions["filter"]): boolean {
    return (
      !filter ||
      ((!filter.scope || memory.scope === filter.scope) &&
        (!filter.category || memory.category === filter.category) &&
        (!filter.status || memory.status === filter.status) &&
        (!filter.excludeMemoryId || memory.id !== filter.excludeMemoryId))
    );
  }

  /** Call only after the record is actually delivered to a model request or read_memory. */
  recordRecall(threadId: string, turnId: string, memoryIds: readonly string[]): void {
    if (memoryIds.length === 0) return;
    this.storage.db.transaction(() => this.recordUseInTransaction(threadId, turnId, memoryIds))();
  }

  /** Also used by an explicit user confirmation while a memory write transaction is open. */
  private recordUseInTransaction(threadId: string, turnId: string, memoryIds: readonly string[]): void {
    const now = new Date().toISOString();
    const insert = this.storage.db.prepare(
      "INSERT OR IGNORE INTO memory_recall_events(memory_id, thread_id, turn_id, recalled_at) VALUES (?, ?, ?, ?)",
    );
    const update = this.storage.db.prepare(
      `UPDATE memories
          SET last_accessed_at = ?, access_count = access_count + 1
        WHERE id = ? AND status IN ('active', 'needs_verification')`,
    );
    for (const memoryId of new Set(memoryIds)) {
      if (!MEMORY_ID_PATTERN.test(memoryId)) continue;
      const active = this.storage.db
        .prepare<[string], { id: string }>(
          "SELECT id FROM memories WHERE id = ? AND status IN ('active', 'needs_verification')",
        )
        .get(memoryId);
      if (active && insert.run(memoryId, threadId, turnId, now).changes) update.run(now, memoryId);
    }
  }

  /** Soft expiration is idempotent and preserves content and revisions. */
  expireDueMemories(workspaceId: string): number {
    workspaceId = assertWorkspaceId(workspaceId);
    const rows = this.storage.db
      .prepare<[string], MemoryRow>(
        "SELECT * FROM memories WHERE workspace_id = ? AND status IN ('active', 'needs_verification')",
      )
      .all(workspaceId);
    const due = rows.filter((row) => this.rowFreshness(row) === 0);
    if (!due.length) return 0;
    this.storage.db.transaction(() => {
      for (const row of due) {
        this.storage.db
          .prepare("UPDATE memories SET status = 'expired', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), row.id);
        this.appendRevision(row.id, "runtime", "expiry");
      }
    })();
    this.vectorIndex?.invalidate?.(workspaceId);
    return due.length;
  }

  get(workspaceId: string, memoryId: string): Readonly<LongTermMemory> | undefined {
    const row = this.storage.db
      .prepare<[string, string], MemoryRow>("SELECT * FROM memories WHERE workspace_id = ? AND id = ?")
      .get(assertWorkspaceId(workspaceId), assertMemoryId(memoryId));
    return row ? toMemory(row) : undefined;
  }

  list(workspaceId: string, options: MemoryListOptions = {}): ReadonlyArray<Readonly<LongTermMemory>> {
    workspaceId = assertWorkspaceId(workspaceId);
    this.expireDueMemories(workspaceId);
    const limit = safeLimit(options.limit, 100, 500);
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.trunc(options.offset as number)) : 0;
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

  /** The user's own correction is authoritative: it rewrites the memory in place, reactivates it and counts as use. */
  editByUser(projectId: string, memoryId: string, content: string): Readonly<LongTermMemory> {
    return this.changeByUser(projectId, memoryId, (row, statements, evidence, now) => {
      if (row.status === "superseded") throw new Error(`Memory ${row.id} is superseded; edit its replacement instead`);
      const cleaned = memoryContent(content, this.limits.memoryContentMaxChars);
      const normalized = normalizeContent(cleaned);
      const conflict = statements.selectByContent.get(row.workspace_id, normalized);
      if (conflict && conflict.id !== row.id) throw new Error(`Memory ${conflict.id} already holds this content`);
      statements.updateActive.run(
        row.category,
        cleaned,
        normalized,
        memorySearchText(cleaned),
        "active",
        evidence("revise", "Edited by the user"),
        USER_MEMORY_SOURCE,
        USER_MEMORY_SOURCE,
        now,
        row.workspace_id,
        row.id,
      );
      statements.confirmRevision.run(now, row.workspace_id, row.id);
    });
  }

  forgetByUser(projectId: string, memoryId: string): Readonly<LongTermMemory> {
    return this.changeByUser(projectId, memoryId, (row, statements, evidence, now) => {
      if (row.status === "expired" || row.status === "superseded") {
        throw new Error(`Memory ${row.id} is already ${row.status}`);
      }
      statements.updateStatus.run(
        "expired",
        evidence("forget", "Forgotten by the user"),
        now,
        row.workspace_id,
        row.id,
      );
    });
  }

  private changeByUser(
    projectId: string,
    memoryId: string,
    change: (
      row: MemoryRow,
      statements: ReturnType<typeof prepareMutationStatements>,
      evidence: (action: MemoryAuditAction, reason: string) => string,
      now: string,
    ) => void,
  ): Readonly<LongTermMemory> {
    const id = assertMemoryId(memoryId);
    const statements = prepareMutationStatements(this.storage.db);
    const row =
      statements.selectById.get(assertWorkspaceId(projectId), id) ??
      statements.selectById.get(GLOBAL_MEMORY_WORKSPACE_ID, id);
    if (!row) throw new Error(`Long-term memory not found: ${id}`);
    const now = new Date().toISOString();
    const turnId = createId("edit");
    this.storage.db.transaction(() => {
      change(
        row,
        statements,
        (action, reason) =>
          appendEvidence(
            row.evidence,
            modelEvidence({ threadId: USER_MEMORY_SOURCE, turnId, reason }, action, now, { previous: snapshot(row) }),
          ),
        now,
      );
      this.appendRevision(row.id, USER_MEMORY_SOURCE, turnId);
    })();
    this.vectorIndex?.invalidate?.(row.workspace_id);
    return this.get(row.workspace_id, row.id)!;
  }

  /**
   * Atomically commit model-proposed mutations after a successful turn. A
   * failed validation rolls back the entire batch, so no partial memory state
   * can survive. Planned turns may maintain user preferences/conventions only;
   * repository facts require a successful implementation turn.
   */
  applyModelMutations(
    input: ApplyModelMemoryMutationsInput,
    onCommitted?: () => void,
  ): ApplyModelMemoryMutationsResult {
    return this.commitModelMutations(input, undefined, onCommitted);
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

    const workspaceId = input.workspaceId ?? (input.workspaceRoot ? projectMemoryIdFromRoot(input.workspaceRoot) : "");
    const contents = [
      ...new Set(
        input.mutations.flatMap((mutation) => {
          if (mutation.action === "forget" || mutation.action === "move" || mutation.action === "flag") return [];
          const content = memoryContent(mutation.content, this.limits.memoryContentMaxChars);
          if (mutation.action === "remember") {
            const targetId = mutation.scope === "global" ? GLOBAL_MEMORY_WORKSPACE_ID : workspaceId;
            const existing = this.storage.db
              .prepare<[string, string], { status: string; category: string }>(
                "SELECT status, category FROM memories WHERE workspace_id = ? AND normalized_content = ?",
              )
              .get(targetId, normalizeContent(content));
            if (existing?.status === "active" && existing.category === mutation.category) return [];
          }
          return [content];
        }),
      ),
    ];
    if (!contents.length) return this.commitModelMutations(input);
    let preparedByContent: ReadonlyMap<string, PreparedMemoryEmbedding> | undefined;
    try {
      const prepared = await prepare.call(this.vectorIndex, contents);
      if (prepared.length !== contents.length) {
        throw new Error("Memory vector index prepared the wrong number of embeddings");
      }
      preparedByContent = new Map(contents.map((content, index) => [content, prepared[index]!] as const));
    } catch (error) {
      this.reportVectorError(error);
    }
    return this.commitModelMutations(input, preparedByContent);
  }

  private commitModelMutations(
    input: ApplyModelMemoryMutationsInput,
    preparedByContent?: ReadonlyMap<string, PreparedMemoryEmbedding>,
    onCommitted?: () => void,
  ): ApplyModelMemoryMutationsResult {
    // Logical projects own memory independently from any one attached folder.
    // Legacy/root-only callers still derive an identity from workspaceRoot,
    // while project-aware callers provide the durable project ID explicitly.
    const rootWorkspaceId = input.workspaceRoot ? workspaceIdFromRoot(input.workspaceRoot) : undefined;
    const evidenceWorkspaceId = assertWorkspaceId(input.workspaceId ?? rootWorkspaceId ?? "");
    const projectId = assertWorkspaceId(
      input.workspaceId ?? (input.workspaceRoot ? projectMemoryIdFromRoot(input.workspaceRoot) : evidenceWorkspaceId),
    );
    const threadId = assertContextId(input.threadId, "threadId");
    const turnId = assertContextId(input.turnId, "turnId");
    if (input.outcome !== "success" && input.outcome !== "planned") {
      throw new Error("Model memory mutations require a successful or planned turn");
    }
    if (input.mutations.length > MAX_MEMORY_MUTATIONS_PER_TURN) {
      throw new Error(`A turn can commit at most ${MAX_MEMORY_MUTATIONS_PER_TURN} memory mutations`);
    }
    if (input.mutations.length === 0) {
      if (onCommitted) this.storage.db.transaction(onCommitted)();
      return Object.freeze({ applied: 0, memoryIds: [] });
    }

    const batch: ModelMutationBatch = {
      threadId,
      turnId,
      ownerId: (scope) => (scope === "global" ? GLOBAL_MEMORY_WORKSPACE_ID : projectId),
      statements: prepareMutationStatements(this.storage.db),
      preparedByContent,
      memoryIds: [],
      affectedScopes: new Set<string>(),
      applied: 0,
    };
    this.storage.db.transaction(() => {
      for (const mutation of input.mutations) {
        const now = new Date().toISOString();
        if (mutation.action === "remember") this.rememberMemory(batch, mutation, now);
        else this.changeMemory(batch, mutation, now);
      }
      onCommitted?.();
    })();

    if (batch.applied > 0) {
      for (const scopeId of batch.affectedScopes) this.vectorIndex?.invalidate?.(scopeId);
    }

    return Object.freeze({ applied: batch.applied, memoryIds: [...batch.memoryIds] });
  }

  /** Count a mutation of this memory and record the revision for the turn. */
  private recordMutation(batch: ModelMutationBatch, memoryId: string): void {
    if (!batch.memoryIds.includes(memoryId)) batch.memoryIds.push(memoryId);
    this.appendRevision(memoryId, batch.threadId, batch.turnId);
    batch.applied += 1;
  }

  private storeMutationEmbedding(
    batch: ModelMutationBatch,
    memoryId: string,
    content: string,
    updatedAt: string,
  ): void {
    const prepared = batch.preparedByContent?.get(content);
    const writePrepared = this.vectorIndex?.writePreparedEmbedding;
    if (!prepared || !writePrepared) return;
    try {
      writePrepared.call(this.vectorIndex, memoryId, prepared, updatedAt);
    } catch (error) {
      // Embeddings are a rebuildable projection. A derived-index failure
      // must not roll back a validated durable memory mutation.
      this.reportVectorError(error);
    }
  }

  /** Remember new content, or reactivate the memory that already holds it. */
  private rememberMemory(
    batch: ModelMutationBatch,
    mutation: Extract<MemoryMutationRequest, { action: "remember" }>,
    now: string,
  ): void {
    const { statements, threadId, turnId } = batch;
    const scope = mutation.scope ?? "project";
    const workspaceId = batch.ownerId(scope);
    const category = assertCategory(mutation.category);
    const content = memoryContent(mutation.content, this.limits.memoryContentMaxChars);
    const normalized = normalizeContent(content);
    const reason = memoryReason(mutation.reason);
    const existing = statements.selectByContent.get(workspaceId, normalized);
    if (existing?.status === "superseded") {
      throw new Error(`Memory ${existing.id} is superseded; revise its active replacement instead`);
    }
    if (existing?.status === "active" && existing.category === category) {
      // Exact normalized content that is already active is not a durable
      // state change. Record its use without rewriting the memory,
      // audit trail, or embedding.
      this.recordUseInTransaction(threadId, turnId, [existing.id]);
      return;
    }
    if (existing) {
      batch.affectedScopes.add(workspaceId);
      const evidence = appendEvidence(
        existing.evidence,
        modelEvidence({ threadId, turnId, reason }, "upsert", now, {
          previous: snapshot(existing),
        }),
      );
      statements.updateActive.run(
        category,
        content,
        normalized,
        memorySearchText(content),
        "active",
        evidence,
        threadId,
        turnId,
        now,
        workspaceId,
        existing.id,
      );
      statements.confirmRevision.run(now, workspaceId, existing.id);
      this.storeMutationEmbedding(batch, existing.id, content, now);
      if (!statements.selectById.get(workspaceId, existing.id)) {
        throw new Error("Memory upsert verification failed");
      }
      this.recordMutation(batch, existing.id);
      return;
    }

    const memoryId = createId("memory");
    const evidence = appendEvidence(null, modelEvidence({ threadId, turnId, reason }, "remember", now));
    statements.insert.run(
      memoryId,
      workspaceId,
      scope,
      category,
      content,
      normalized,
      memorySearchText(content),
      "active",
      evidence,
      threadId,
      turnId,
      now,
      now,
    );
    this.storeMutationEmbedding(batch, memoryId, content, now);
    if (!statements.selectById.get(workspaceId, memoryId)) {
      throw new Error("Memory creation verification failed");
    }
    batch.affectedScopes.add(workspaceId);
    this.recordMutation(batch, memoryId);
  }

  /** Move, flag, forget or revise an existing memory found in its source scope. */
  private changeMemory(
    batch: ModelMutationBatch,
    mutation: Exclude<MemoryMutationRequest, { action: "remember" }>,
    now: string,
  ): void {
    const { statements, threadId, turnId } = batch;
    const memoryId = assertMemoryId(mutation.memoryId);
    const sourceScope =
      mutation.action === "move" ? (mutation.scope === "global" ? "project" : "global") : (mutation.scope ?? "project");
    const workspaceId = batch.ownerId(sourceScope);
    const existing = statements.selectById.get(workspaceId, memoryId);
    if (!existing) {
      throw new Error("Long-term memory was not found in this workspace");
    }
    batch.affectedScopes.add(workspaceId);

    if (mutation.action === "move") {
      const targetId = batch.ownerId(mutation.scope);
      if (statements.selectByContent.get(targetId, existing.normalized_content)) {
        throw new Error("Target scope already contains this memory; revise the existing entry instead");
      }
      const reason = memoryReason(mutation.reason);
      const evidence = appendEvidence(
        existing.evidence,
        modelEvidence({ threadId, turnId, reason }, "move", now, { previous: snapshot(existing) }),
      );
      statements.updateScope.run(targetId, mutation.scope, evidence, now, workspaceId, memoryId);
      batch.affectedScopes.add(workspaceId);
      batch.affectedScopes.add(targetId);
      this.recordMutation(batch, memoryId);
      return;
    }

    if (mutation.action === "flag") {
      if (existing.status !== "active") return;
      const reason = memoryReason(mutation.reason);
      const evidence = appendEvidence(
        existing.evidence,
        modelEvidence({ threadId, turnId, reason }, "flag", now, { previous: snapshot(existing) }),
      );
      statements.updateStatus.run("needs_verification", evidence, now, workspaceId, existing.id);
      this.recordMutation(batch, existing.id);
      return;
    }

    if (mutation.action === "forget") {
      if (existing.status === "expired" || existing.status === "superseded") return;
      const reason = memoryReason(mutation.reason);
      const evidence = appendEvidence(
        existing.evidence,
        modelEvidence({ threadId, turnId, reason }, "forget", now, {
          previous: snapshot(existing),
        }),
      );
      statements.updateStatus.run("expired", evidence, now, workspaceId, existing.id);
      const expired = statements.selectById.get(workspaceId, existing.id);
      if (expired?.status !== "expired") {
        throw new Error("Memory expiration verification failed");
      }
      this.recordMutation(batch, existing.id);
      return;
    }
    this.reviseMemory(batch, mutation, existing, workspaceId, now);
  }

  /** Revise an active memory in place when its normalized content is unchanged; otherwise supersede it with a replacement. */
  private reviseMemory(
    batch: ModelMutationBatch,
    mutation: Extract<MemoryMutationRequest, { action: "revise" }>,
    existing: MemoryRow,
    workspaceId: string,
    now: string,
  ): void {
    const { statements, threadId, turnId } = batch;
    if (existing.status !== "active" && existing.status !== "needs_verification") {
      throw new Error(`Only active memories can be revised; current status is ${existing.status}`);
    }
    const category = assertCategory(mutation.category);
    const content = memoryContent(mutation.content, this.limits.memoryContentMaxChars);
    const normalized = normalizeContent(content);
    const reason = memoryReason(mutation.reason);
    const conflict = statements.selectByContent.get(workspaceId, normalized);
    if (conflict && conflict.id !== existing.id) {
      throw new Error(`Replacement content already belongs to memory ${conflict.id}`);
    }

    if (normalized === existing.normalized_content) {
      const evidence = appendEvidence(
        existing.evidence,
        modelEvidence({ threadId, turnId, reason }, "revise", now, {
          previous: snapshot(existing),
        }),
      );
      statements.updateActive.run(
        category,
        content,
        normalized,
        memorySearchText(content),
        "active",
        evidence,
        threadId,
        turnId,
        now,
        workspaceId,
        existing.id,
      );
      statements.confirmRevision.run(now, workspaceId, existing.id);
      this.storeMutationEmbedding(batch, existing.id, content, now);
      if (!statements.selectById.get(workspaceId, existing.id)) {
        throw new Error("Memory revision verification failed");
      }
      this.recordMutation(batch, existing.id);
      return;
    }

    const replacementId = createId("memory");
    const oldEvidence = appendEvidence(
      existing.evidence,
      modelEvidence({ threadId, turnId, reason }, "supersede", now, {
        relatedMemoryId: replacementId,
        previous: snapshot(existing),
      }),
    );
    statements.updateStatus.run("superseded", oldEvidence, now, workspaceId, existing.id);
    this.appendRevision(existing.id, threadId, turnId);
    const newEvidence = appendEvidence(
      null,
      modelEvidence({ threadId, turnId, reason }, "revise", now, {
        relatedMemoryId: existing.id,
      }),
    );
    statements.insert.run(
      replacementId,
      workspaceId,
      existing.scope,
      category,
      content,
      normalized,
      memorySearchText(content),
      "active",
      newEvidence,
      threadId,
      turnId,
      now,
      now,
    );
    this.storeMutationEmbedding(batch, replacementId, content, now);
    const superseded = statements.selectById.get(workspaceId, existing.id);
    const replacement = statements.selectById.get(workspaceId, replacementId);
    if (superseded?.status !== "superseded" || !replacement) {
      throw new Error("Memory supersession verification failed");
    }
    this.recordMutation(batch, replacementId);
  }
}
