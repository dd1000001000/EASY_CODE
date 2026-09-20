import {
  MAX_MEMORY_MUTATIONS_PER_TURN,
  type AgentRunResult,
  type LongTermMemory,
  type LongTermMemoryScope,
  type MemoryMutationRequest,
  type SessionState,
} from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { createId } from "../utils/ids.js";
import { EvidenceStore } from "../context/evidence-store.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { assertDurableMemory } from "./admission.js";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { projectRootFromWorkspace } from "../workspace/project-root.js";
import { sha256 } from "../utils/hash.js";
import {
  containsSensitiveInformation,
  redactSensitiveInformation,
} from "./sensitive.js";
import type {
  MemoryVectorSearchHit,
  MemoryVectorSearchOptions,
  PreparedMemoryEmbedding,
} from "./vector-index.js";
import { memoryExpiryDays, memoryFreshnessWeight } from "./lifecycle.js";

export interface MemorySearchOptions {
  readonly readOnly?: boolean;
  readonly workspaceRoot?: string;
  readonly limit?: number;
  /** Include inactive audit-history rows. Ordinary retrieval stays active-only. */
  readonly includeInactive?: boolean;
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
  /** Runtime supplied, never a model argument. Internal non-model callers may omit it. */
  readonly sourceState?: Readonly<SessionState>;
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

interface MemoryProvenance {
  version: 1;
  refs: string[];
  files: Array<{ path: string; hash: string }>;
}

type MemoryAuditAction =
  | "remember"
  | "upsert"
  | "revise"
  | "supersede"
  | "forget"
  | "move";

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
  if (
    content.length < MIN_MEMORY_CONTENT_CHARS ||
    content.length > maximum
  ) {
    throw new Error(
      `Memory content must contain ${MIN_MEMORY_CONTENT_CHARS}-${maximum} characters`,
    );
  }
  if (
    containsSensitiveInformation(content) ||
    redactSensitiveInformation(content) !== content
  ) {
    throw new Error("Memory content contains sensitive information and was not stored");
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
  readonly evidenceStore: EvidenceStore;
  readonly limits: Readonly<RuntimeLimits>;
  close(): void { this.vectorIndex?.close?.(); }
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

  listScoped(projectId: string, scope: MemoryScopeFilter = "all", options: MemoryListOptions = {}):
    ReadonlyArray<Readonly<LongTermMemory>> {
    if (scope !== "all") {
      return this.list(scope === "global" ? GLOBAL_MEMORY_WORKSPACE_ID : projectId, options);
    }
    this.expireDueMemories(projectId);
    this.expireDueMemories(GLOBAL_MEMORY_WORKSPACE_ID);
    const limit = safeLimit(options.limit, 100, 500);
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.trunc(options.offset as number)) : 0;
    const status = options.status ?? "active";
    const rows = status === "all"
      ? this.storage.db.prepare<[string, string, number, number], MemoryRow>(
        "SELECT * FROM memories WHERE workspace_id IN (?, ?) ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      ).all(assertWorkspaceId(projectId), GLOBAL_MEMORY_WORKSPACE_ID, limit, offset)
      : this.storage.db.prepare<[string, string, string, number, number], MemoryRow>(
        "SELECT * FROM memories WHERE workspace_id IN (?, ?) AND status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      ).all(assertWorkspaceId(projectId), GLOBAL_MEMORY_WORKSPACE_ID, status, limit, offset);
    return Object.freeze(rows.map(toMemory));
  }

  async searchScoped(
    projectId: string,
    query: string,
    options: MemorySearchOptions & { scope?: MemoryScopeFilter; includeGlobalPreferences?: boolean } = {},
  ): Promise<ReadonlyArray<Readonly<LongTermMemory>>> {
    const limit = safeLimit(options.limit, 6, 50);
    const scope = options.scope ?? "all";
    const hasGlobal = scope !== "project" && !!this.storage.db.prepare<[string, number], { present: number }>(
      "SELECT 1 AS present FROM memories WHERE workspace_id = ? AND (? = 1 OR status IN ('active', 'needs_verification')) LIMIT 1",
    ).get(GLOBAL_MEMORY_WORKSPACE_ID, options.includeInactive ? 1 : 0);
    const project = scope === "global" ? [] : await this.searchHybrid(projectId, query, {
      ...options, limit, workspaceRoot: options.workspaceRoot
        ? projectRootFromWorkspace(options.workspaceRoot) : undefined,
    });
    const global = !hasGlobal ? [] : await this.searchHybrid(GLOBAL_MEMORY_WORKSPACE_ID, query, {
      ...options, limit, workspaceRoot: undefined,
    });
    const preferences = !hasGlobal || !options.includeGlobalPreferences ? []
      : this.storage.db.prepare<[string], MemoryRow>(
        `SELECT * FROM memories WHERE workspace_id = ? AND status = 'active'
           AND category IN ('preference', 'convention')
         ORDER BY COALESCE(last_accessed_at, created_at) DESC LIMIT 3`,
      ).all(GLOBAL_MEMORY_WORKSPACE_ID).map(toMemory);
    const globalCandidates = [...new Map([...preferences, ...global].map((memory) => [memory.id, memory])).values()];
    const reservedGlobal = Math.min(2, globalCandidates.length, limit);
    const seen = new Set<string>();
    return Object.freeze([...project.slice(0, limit - reservedGlobal), ...globalCandidates].filter((memory) => {
      if (seen.has(memory.id)) return false;
      seen.add(memory.id);
      return true;
    }).slice(0, limit));
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
    const boundedQuery = query.slice(0, MAX_MEMORY_SEARCH_CHARS);
    const candidateLimit = Math.min(50, Math.max(limit * 4, 20));
    const lexical = this.searchLexical(
      workspaceId,
      boundedQuery,
      {
        limit: candidateLimit,
        includeInactive,
      },
    );

    if (!this.vectorIndex || !boundedQuery.trim()) {
      const selected = await this.currentCandidates(workspaceId, lexical, resolvedOptions.workspaceRoot, limit, resolvedOptions.readOnly);
      return Object.freeze(selected);
    }

    let semantic: ReadonlyArray<Readonly<MemoryVectorSearchHit>>;
    try {
      semantic = await this.vectorIndex.search(workspaceId, boundedQuery, {
        limit: candidateLimit,
        minimumSimilarity: this.limits.memoryVectorMinSimilarity,
        // The authoritative status filter below excludes expired and
        // superseded memories unless the caller explicitly requests them.
        includeInactive: true,
      });
    } catch (error) {
      this.reportVectorError(error);
      const selected = await this.currentCandidates(workspaceId, lexical, resolvedOptions.workspaceRoot, limit, resolvedOptions.readOnly);
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
        (!includeInactive && memory.status !== "active" && memory.status !== "needs_verification")
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
          (candidate.semanticScore ?? 0) * 0.76 +
          lexicalScore * 0.24;
        return { ...candidate, score: score * this.freshness(candidate.memory) };
      })
      .sort((left, right) =>
        right.score - left.score ||
        right.memory.updatedAt.localeCompare(left.memory.updatedAt),
      )
      .map((candidate) => candidate.memory);
    const selected = await this.currentCandidates(workspaceId, ranked, resolvedOptions.workspaceRoot, limit, resolvedOptions.readOnly);
    return Object.freeze(selected);
  }

  private async currentCandidates(workspaceId: string, candidates: readonly Readonly<LongTermMemory>[],
    root: string | undefined, limit: number, readOnly = false): Promise<Readonly<LongTermMemory>[]> {
    if (!root) return candidates.slice(0, limit);
    const selected: Readonly<LongTermMemory>[] = [];
    for (const memory of candidates) {
      const stored = this.storage.db.prepare<[string], { document_json: string }>(
        "SELECT document_json FROM memory_provenance WHERE memory_id = ?").get(memory.id);
      const document = stored ? JSON.parse(stored.document_json) as MemoryProvenance : undefined;
      let stale = !document && ["architecture", "environment", "decision"].includes(memory.category);
      if (document) for (const file of document.files) {
        try {
          const target = await realpath(path.resolve(root, file.path));
          const relative = path.relative(await realpath(root), target);
          if (relative.startsWith("..") || path.isAbsolute(relative) || sha256(await readFile(target)) !== file.hash) stale = true;
        } catch { stale = true; }
      }
      if (stale) {
        if (memory.status === "active" && !readOnly) {
          this.storage.db.transaction(() => {
            this.storage.db.prepare("UPDATE memories SET status = 'needs_verification', updated_at = ? WHERE id = ? AND workspace_id = ?")
              .run(new Date().toISOString(), memory.id, workspaceId);
            this.appendRevision(memory.id, "runtime", "revalidation");
          })();
          this.vectorIndex?.invalidate?.(workspaceId);
        }
        continue;
      }
      selected.push(memory);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  private appendRevision(memoryId: string, threadId: string, turnId: string): void {
    const row = this.storage.db.prepare<[string], MemoryRow>("SELECT * FROM memories WHERE id = ?").get(memoryId);
    const provenance = this.storage.db.prepare<[string], { document_json: string }>(
      "SELECT document_json FROM memory_provenance WHERE memory_id = ?").get(memoryId);
    if (row) this.storage.db.prepare(
      "INSERT INTO memory_revisions(memory_id, thread_id, turn_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(memoryId, threadId, turnId, JSON.stringify({ memory: row,
      provenance: provenance ? JSON.parse(provenance.document_json) : null }), new Date().toISOString());
  }

  validateSources(input: ApplyModelMemoryMutationsInput): void {
    for (const mutation of input.mutations) this.provenance(input, mutation);
  }

  private provenance(input: ApplyModelMemoryMutationsInput, mutation: MemoryMutationRequest): MemoryProvenance | undefined {
    if (!input.sourceState || mutation.action === "forget" || mutation.action === "move") return undefined;
    assertDurableMemory(mutation.content, this.limits);
    const state = input.sourceState;
    if (state.threadId !== input.threadId) throw new Error("Memory evidence belongs to another thread");
    const refs = [...new Set(mutation.sourceRefs ?? [])];
    const files: MemoryProvenance["files"] = [];
    for (const ref of refs) {
      if (ref === "user") {
        if (!input.userInput?.trim()) throw new Error("Memory source user is not present in this turn");
        continue;
      }
      const workspaceId = input.workspaceId ?? workspaceIdFromRoot(input.workspaceRoot ?? state.workspaceRoot);
      const row = this.storage.db.prepare<[string, string, string], { content: string; truncated: number; tool: string }>(
        "SELECT content, truncated, tool FROM context_evidence WHERE id = ? AND thread_id = ? AND workspace_id = ?"
      ).get(ref, input.threadId, workspaceId);
      if (!row || row.truncated) throw new Error("Memory source reference is unavailable in this turn");
      let observed: any;
      try { observed = JSON.parse(row.content); } catch { throw new Error("Memory source reference is invalid"); }
      if (observed?.ok !== true) continue;
      if (["read_file", "create_file", "update_file"].includes(row.tool) &&
          typeof observed.data?.path === "string" && typeof observed.data?.contentHash === "string") {
        const absolute = path.resolve(state.workspaceRoot, observed.data.path);
        const relativeWorkspace = path.relative(state.workspaceRoot, absolute);
        if (relativeWorkspace.startsWith("..") || path.isAbsolute(relativeWorkspace)) continue;
        const projectRoot = input.workspaceRoot
          ? projectRootFromWorkspace(input.workspaceRoot) : state.workspaceRoot;
        const relativeProject = path.relative(projectRoot, absolute);
        if (relativeProject.startsWith("..") || path.isAbsolute(relativeProject)) continue;
        files.push({ path: relativeProject, hash: observed.data.contentHash });
      }
    }
    return { version: 1, refs, files };
  }

  private searchLexical(
    workspaceId: string,
    query: string,
    options: MemorySearchOptions | number,
  ): ReadonlyArray<Readonly<LongTermMemory>> {
    workspaceId = assertWorkspaceId(workspaceId);
    this.expireDueMemories(workspaceId);
    const resolvedOptions = typeof options === "number" ? { limit: options } : options;
    const limit = safeLimit(resolvedOptions.limit, 6, 50);
    const includeInactive = resolvedOptions.includeInactive === true;
    const boundedQuery = query.slice(0, MAX_MEMORY_SEARCH_CHARS);
    const candidateRows = new Map<string, MemoryRow>();
    const expression = ftsExpression(boundedQuery);

    if (expression) {
      try {
        const rows = this.storage.db
          .prepare<[string, string, number, number], MemoryRow>(
            `SELECT m.*
               FROM memories_fts
               JOIN memories AS m ON m.rowid = memories_fts.rowid
              WHERE memories_fts MATCH ?
                AND m.workspace_id = ?
                AND (? = 1 OR m.status IN ('active', 'needs_verification'))
              ORDER BY bm25(memories_fts)
              LIMIT ?`,
          )
          .all(
            expression,
            workspaceId,
            includeInactive ? 1 : 0,
            Math.max(limit * 4, 20),
          );
        for (const row of rows) candidateRows.set(row.id, row);
      } catch {
        // A malformed or tokenizer-specific FTS query falls back to bounded
        // in-process matching. Persistence and ordinary retrieval remain usable.
      }
    }

    const fallbackRows = this.storage.db
      .prepare<[string, number], MemoryRow>(
        `SELECT * FROM memories
          WHERE workspace_id = ?
            AND (? = 1 OR status IN ('active', 'needs_verification'))
          ORDER BY updated_at DESC
          LIMIT 200`,
      )
      .all(workspaceId, includeInactive ? 1 : 0);
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
        const weight = memoryFreshnessWeight(row.last_accessed_at, row.created_at,
          memoryExpiryDays(row.scope, this.limits));
        return { row, score: relevance * weight, relevance };
      })
      .filter((candidate) => normalizedQuery.length === 0 || candidate.relevance > 0)
      .sort((left, right) => right.score - left.score || right.row.updated_at.localeCompare(left.row.updated_at))
      .slice(0, limit);

    return Object.freeze(scored.map((item) => toMemory(item.row)));
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
      const active = this.storage.db.prepare<[string], { id: string }>(
        "SELECT id FROM memories WHERE id = ? AND status IN ('active', 'needs_verification')",
      ).get(memoryId);
      if (active && insert.run(memoryId, threadId, turnId, now).changes) update.run(now, memoryId);
    }
  }

  private freshness(memory: Readonly<LongTermMemory>): number {
    const row = this.storage.db.prepare<[string], Pick<MemoryRow, "last_accessed_at" | "created_at">>(
      "SELECT last_accessed_at, created_at FROM memories WHERE id = ?",
    ).get(memory.id);
    return row ? memoryFreshnessWeight(row.last_accessed_at, row.created_at,
      memoryExpiryDays(memory.scope, this.limits)) : 0;
  }

  /** Soft expiration is idempotent and preserves content, provenance and revisions. */
  expireDueMemories(workspaceId: string): number {
    workspaceId = assertWorkspaceId(workspaceId);
    const rows = this.storage.db.prepare<[string], MemoryRow>(
      "SELECT * FROM memories WHERE workspace_id = ? AND status IN ('active', 'needs_verification')",
    ).all(workspaceId);
    const due = rows.filter((row) => memoryFreshnessWeight(row.last_accessed_at, row.created_at,
      memoryExpiryDays(row.scope, this.limits)) === 0);
    if (!due.length) return 0;
    this.storage.db.transaction(() => {
      for (const row of due) {
        this.storage.db.prepare("UPDATE memories SET status = 'expired', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), row.id);
        this.appendRevision(row.id, "runtime", "expiry");
      }
    })();
    this.vectorIndex?.invalidate?.(workspaceId);
    return due.length;
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
    this.expireDueMemories(workspaceId);
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
    this.validateSources(input);
    const prepare = this.vectorIndex?.prepareEmbeddings;
    const write = this.vectorIndex?.writePreparedEmbedding;
    if (!prepare || !write || input.mutations.length === 0) {
      return this.commitModelMutations(input);
    }

    const workspaceId = input.workspaceRoot
      ? projectMemoryIdFromRoot(input.workspaceRoot)
      : input.workspaceId ?? "";
    const contents = [...new Set(input.mutations.flatMap((mutation) => {
      if (mutation.action === "forget" || mutation.action === "move") return [];
      const content = memoryContent(mutation.content, this.limits.memoryContentMaxChars);
      if (mutation.action === "remember") {
        const targetId = mutation.scope === "global" ? GLOBAL_MEMORY_WORKSPACE_ID : workspaceId;
        const existing = this.storage.db.prepare<[string, string], { status: string; category: string }>(
          "SELECT status, category FROM memories WHERE workspace_id = ? AND normalized_content = ?"
        ).get(targetId, normalizeContent(content));
        if (existing?.status === "active" && existing.category === mutation.category) return [];
      }
      return [content];
    }))];
    if (!contents.length) return this.commitModelMutations(input);
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
    onCommitted?: () => void,
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
    const evidenceWorkspaceId = assertWorkspaceId(input.workspaceId ?? rootWorkspaceId ?? "");
    const projectId = assertWorkspaceId(input.workspaceRoot
      ? projectMemoryIdFromRoot(input.workspaceRoot) : evidenceWorkspaceId);
    const ownerId = (scope: LongTermMemoryScope): string => scope === "global"
      ? GLOBAL_MEMORY_WORKSPACE_ID : projectId;
    const threadId = assertContextId(input.threadId, "threadId");
    const turnId = assertContextId(input.turnId, "turnId");
    if (input.outcome !== "success" && input.outcome !== "planned") {
      throw new Error("Model memory mutations require a successful or planned turn");
    }
    if (input.mutations.length > MAX_MEMORY_MUTATIONS_PER_TURN) {
      throw new Error(
        `A turn can commit at most ${MAX_MEMORY_MUTATIONS_PER_TURN} memory mutations`,
      );
    }
    if (input.mutations.length === 0) {
      if (onCommitted) this.storage.db.transaction(onCommitted)();
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
         id, workspace_id, scope, category, content, normalized_content,
         status, evidence, source_thread_id, source_turn_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateActive = this.storage.db.prepare(
      `UPDATE memories
          SET category = ?, content = ?, normalized_content = ?,
              status = ?, evidence = ?, source_thread_id = ?,
              source_turn_id = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
    );
    const updateStatus = this.storage.db.prepare(
      `UPDATE memories SET status = ?, evidence = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
    );
    const updateScope = this.storage.db.prepare(
      "UPDATE memories SET workspace_id = ?, scope = ?, evidence = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
    );
    const confirmRevision = this.storage.db.prepare(
      "UPDATE memories SET last_accessed_at = ? WHERE workspace_id = ? AND id = ?",
    );
    const memoryIds: string[] = [];
    const provenanceByMutation = new Map(input.mutations.map((mutation) => [mutation, this.provenance(input, mutation)]));
    let activeProvenance: MemoryProvenance | undefined;
    let applied = 0;
    const affectedScopes = new Set<string>();

    const evidenceSource = (reason: string): ModelMemoryEvidence => ({
      threadId,
      turnId,
      reason,
    });
    const recordId = (memoryId: string): void => {
      if (!memoryIds.includes(memoryId)) memoryIds.push(memoryId);
      if (activeProvenance) this.storage.db.prepare(
        "INSERT INTO memory_provenance(memory_id, document_json) VALUES (?, ?) ON CONFLICT(memory_id) DO UPDATE SET document_json = excluded.document_json"
      ).run(memoryId, JSON.stringify(activeProvenance));
      this.appendRevision(memoryId, threadId, turnId);
    };
    const retainProvenance = (memoryId: string): void => {
      if (!activeProvenance) return;
      const stored = this.storage.db.prepare<[string], { document_json: string }>(
        "SELECT document_json FROM memory_provenance WHERE memory_id = ?",
      ).get(memoryId);
      if (!stored) return;
      try {
        const previous = JSON.parse(stored.document_json) as MemoryProvenance;
        const files = new Map<string, { path: string; hash: string }>();
        for (const file of [...(previous.files ?? []), ...activeProvenance.files]) {
          if (typeof file.path === "string" && typeof file.hash === "string") files.set(file.path, file);
        }
        activeProvenance = { version: 1,
          refs: [...new Set([...(previous.refs ?? []), ...activeProvenance.refs])].slice(-32),
          files: [...files.values()] };
      } catch { /* Preserve the validated current-turn reference if old audit data is damaged. */ }
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
        activeProvenance = provenanceByMutation.get(mutation);
        const now = new Date().toISOString();
        if (mutation.action === "remember") {
          const scope = mutation.scope ?? "project";
          const workspaceId = ownerId(scope);
          const category = assertCategory(mutation.category);
          const content = memoryContent(mutation.content, this.limits.memoryContentMaxChars);
          const normalized = normalizeContent(content);
          const reason = memoryReason(mutation.reason);
          const existing = selectByContent.get(workspaceId, normalized);
          if (existing?.status === "superseded") {
            throw new Error(
              `Memory ${existing.id} is superseded; revise its active replacement instead`,
            );
          }
          if (
            existing?.status === "active" &&
            existing.category === category
          ) {
            // Exact normalized content that is already active is not a durable
            // state change. Do not rewrite its timestamps/audit trail or
            // refresh its embedding merely because a later turn
            // proposed the same fact again.
            if (input.sourceState && mutation.sourceRefs?.includes("user")) {
              this.recordUseInTransaction(threadId, turnId, [existing.id]);
            }
            continue;
          }
          if (existing) {
            affectedScopes.add(workspaceId);
            retainProvenance(existing.id);
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
              "active",
              evidence,
              threadId,
              turnId,
              now,
              workspaceId,
              existing.id,
            );
            confirmRevision.run(now, workspaceId, existing.id);
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
            scope,
            category,
            content,
            normalized,
            "active",
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
          affectedScopes.add(workspaceId);
          applied += 1;
          continue;
        }

        const memoryId = assertMemoryId(mutation.memoryId);
        const sourceScope = mutation.action === "move"
          ? (mutation.scope === "global" ? "project" : "global")
          : mutation.scope ?? "project";
        const workspaceId = ownerId(sourceScope);
        const existing = selectById.get(workspaceId, memoryId);
        if (!existing) {
          throw new Error("Long-term memory was not found in this workspace");
        }
        affectedScopes.add(workspaceId);

        if (mutation.action === "move") {
          const targetId = ownerId(mutation.scope);
          if (selectByContent.get(targetId, existing.normalized_content)) {
            throw new Error("Target scope already contains this memory; revise the existing entry instead");
          }
          const reason = memoryReason(mutation.reason);
          const evidence = appendEvidence(existing.evidence,
            modelEvidence(evidenceSource(reason), "move", now, { previous: snapshot(existing) }));
          updateScope.run(targetId, mutation.scope, evidence, now, workspaceId, memoryId);
          recordId(memoryId);
          affectedScopes.add(workspaceId);
          affectedScopes.add(targetId);
          applied += 1;
          continue;
        }

        if (mutation.action === "forget") {
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
        retainProvenance(existing.id);
        const content = memoryContent(mutation.content, this.limits.memoryContentMaxChars);
        const normalized = normalizeContent(content);
        const reason = memoryReason(mutation.reason);
        const conflict = selectByContent.get(workspaceId, normalized);
        if (conflict && conflict.id !== existing.id) {
          throw new Error(`Replacement content already belongs to memory ${conflict.id}`);
        }

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
            "active",
            evidence,
            threadId,
            turnId,
            now,
            workspaceId,
            existing.id,
          );
          confirmRevision.run(now, workspaceId, existing.id);
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
        this.appendRevision(existing.id, threadId, turnId);
        const newEvidence = appendEvidence(
          null,
          modelEvidence(evidenceSource(reason), "revise", now, {
            relatedMemoryId: existing.id,
          }),
        );
        insert.run(
          replacementId,
          workspaceId,
          existing.scope,
          category,
          content,
          normalized,
          "active",
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
      onCommitted?.();
    })();

    if (applied > 0) {
      for (const scopeId of affectedScopes) this.vectorIndex?.invalidate?.(scopeId);
    }

    return Object.freeze({ applied, memoryIds: [...memoryIds] });
  }
}
