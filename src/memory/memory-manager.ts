import type {
  AgentRunResult,
  ChatMessage,
  LongTermMemory,
} from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { createId } from "../utils/ids.js";
import {
  containsSensitiveInformation,
  redactSensitiveInformation,
} from "./sensitive.js";

export interface CaptureFromTurnInput {
  readonly workspaceId?: string;
  readonly workspaceRoot?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly userMessage: string | ChatMessage;
  readonly assistantMessage: string | ChatMessage;
  /** Runtime-confirmed file/command/change evidence exists for assistant facts. */
  readonly assistantEvidence?: boolean;
  readonly completed?: boolean;
  readonly outcome?: AgentRunResult["reason"];
}

export interface MemorySearchOptions {
  readonly limit?: number;
  readonly minimumConfidence?: number;
}

export interface MemoryListOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly status?: LongTermMemory["status"] | "all";
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

interface Candidate {
  readonly category: LongTermMemory["category"];
  readonly content: string;
  readonly normalized: string;
  readonly confidence: number;
}

const UNCERTAIN = /(?:可能|也许|猜测|未验证|暂时|临时|perhaps|maybe|might|unverified|temporary)/i;
const ONE_OFF_TASK = /(?:修复|新增|添加|删除|升级|安装|这次|当前任务|fix|add|remove|upgrade|install|this task)/i;
const STABLE_CUE = /(?:以后|今后|始终|总是|统一|默认|偏好|约定|规范|决定|采用|项目(?:使用|采用|基于)|prefer|always|by default|from now on|convention|decided|project uses|built with)/i;

function messageText(message: string | ChatMessage): string {
  if (typeof message === "string") return message;
  return typeof message.content === "string" ? message.content : "";
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

function classify(
  sentence: string,
): LongTermMemory["category"] | undefined {
  if (/(?:偏好|更喜欢|以后|今后|始终|总是|prefer|always|from now on)/i.test(sentence)) {
    return "preference";
  }
  if (/(?:约定|规范|命名|格式|代码风格|统一|convention|naming|formatting|style guide)/i.test(sentence)) {
    return "convention";
  }
  if (/(?:决定|采用|选用|技术决策|不再使用|decided|chosen|we use)/i.test(sentence)) {
    return "decision";
  }
  if (/(?:架构|入口|模块|目录.+负责|位于|依赖于|architecture|entry point|module|located in)/i.test(sentence)) {
    return "architecture";
  }
  if (/(?:node(?:\.js)?\s*v?\d+|typescript|javascript|windows|macos|linux|npm|pnpm|yarn|运行环境|环境要求|project uses|built with)/i.test(sentence)) {
    return "environment";
  }
  return undefined;
}

function extractCandidates(text: string, source: "user" | "assistant"): Candidate[] {
  const chunks = text.split(/[\n\r。！？；]+/u);
  const candidates: Candidate[] = [];
  for (const chunk of chunks) {
    const content = cleanSentence(chunk);
    if (content.length < 8 || content.length > 360) continue;
    if (containsSensitiveInformation(content) || UNCERTAIN.test(content)) continue;
    const category = classify(content);
    if (!category) continue;

    const hasStableCue = STABLE_CUE.test(content);
    if (source === "user" && !hasStableCue) continue;
    if (ONE_OFF_TASK.test(content) && !hasStableCue) continue;

    const confidence = source === "user"
      ? category === "preference" || category === "convention"
        ? 0.84
        : 0.78
      : category === "architecture" || category === "decision"
        ? 0.76
        : 0.7;
    candidates.push({
      category,
      content,
      normalized: normalizeContent(content),
      confidence,
    });
  }
  return candidates;
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
    evidence: row.evidence ?? undefined,
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
 * Automatic long-term memory. Deliberately exposes retrieval and completed-turn
 * capture only: there is no public create, update, pin, or delete operation.
 */
export class MemoryManager {
  constructor(private readonly storage: EasyCodeStorage) {}

  search(
    workspaceId: string,
    query: string,
    options: MemorySearchOptions | number = {},
  ): ReadonlyArray<Readonly<LongTermMemory>> {
    const resolvedOptions = typeof options === "number" ? { limit: options } : options;
    const limit = safeLimit(resolvedOptions.limit, 6, 50);
    const requestedConfidence = resolvedOptions.minimumConfidence;
    const minimumConfidence = Number.isFinite(requestedConfidence)
      ? Math.max(0, Math.min(requestedConfidence as number, 1))
      : 0.55;
    const candidateRows = new Map<string, MemoryRow>();
    const expression = ftsExpression(query);

    if (expression) {
      try {
        const rows = this.storage.db
          .prepare<[string, string, number, number], MemoryRow>(
            `SELECT m.*
               FROM memories_fts
               JOIN memories AS m ON m.rowid = memories_fts.rowid
              WHERE memories_fts MATCH ?
                AND m.workspace_id = ?
                AND m.status = 'active'
                AND m.confidence >= ?
              ORDER BY bm25(memories_fts), m.confidence DESC
              LIMIT ?`,
          )
          .all(expression, workspaceId, minimumConfidence, Math.max(limit * 4, 20));
        for (const row of rows) candidateRows.set(row.id, row);
      } catch {
        // A malformed or tokenizer-specific FTS query falls back to bounded
        // in-process matching. Persistence and ordinary retrieval remain usable.
      }
    }

    const fallbackRows = this.storage.db
      .prepare<[string, number], MemoryRow>(
        `SELECT * FROM memories
          WHERE workspace_id = ? AND status = 'active' AND confidence >= ?
          ORDER BY confidence DESC, updated_at DESC
          LIMIT 200`,
      )
      .all(workspaceId, minimumConfidence);
    for (const row of fallbackRows) candidateRows.set(row.id, row);

    const normalizedQuery = normalizeContent(query);
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

    if (scored.length > 0) {
      const now = new Date().toISOString();
      const update = this.storage.db.prepare(
        `UPDATE memories
            SET last_accessed_at = ?, access_count = access_count + 1
          WHERE id = ?`,
      );
      this.storage.db.transaction(() => {
        for (const item of scored) update.run(now, item.row.id);
      })();
    }

    return Object.freeze(scored.map((item) => toMemory(item.row)));
  }

  list(
    workspaceId?: string,
    options: MemoryListOptions = {},
  ): ReadonlyArray<Readonly<LongTermMemory>> {
    const limit = safeLimit(options.limit, 100, 500);
    const offset = Number.isFinite(options.offset)
      ? Math.max(0, Math.trunc(options.offset as number))
      : 0;
    const status = options.status ?? "active";
    let rows: MemoryRow[];

    if (workspaceId && status !== "all") {
      rows = this.storage.db
        .prepare<[string, string, number, number], MemoryRow>(
          `SELECT * FROM memories
            WHERE workspace_id = ? AND status = ?
            ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(workspaceId, status, limit, offset);
    } else if (workspaceId) {
      rows = this.storage.db
        .prepare<[string, number, number], MemoryRow>(
          `SELECT * FROM memories
            WHERE workspace_id = ?
            ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(workspaceId, limit, offset);
    } else if (status !== "all") {
      rows = this.storage.db
        .prepare<[string, number, number], MemoryRow>(
          `SELECT * FROM memories
            WHERE status = ?
            ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(status, limit, offset);
    } else {
      rows = this.storage.db
        .prepare<[number, number], MemoryRow>(
          "SELECT * FROM memories ORDER BY updated_at DESC LIMIT ? OFFSET ?",
        )
        .all(limit, offset);
    }
    return Object.freeze(rows.map(toMemory));
  }

  captureFromTurn(
    input: CaptureFromTurnInput,
  ): ReadonlyArray<Readonly<LongTermMemory>> {
    if (input.completed === false) return Object.freeze([]);
    if (
      input.outcome &&
      input.outcome !== "success" &&
      input.outcome !== "planned"
    ) {
      return Object.freeze([]);
    }
    const workspaceId = input.workspaceId ?? (
      input.workspaceRoot ? workspaceIdFromRoot(input.workspaceRoot) : undefined
    );
    if (!workspaceId) {
      throw new Error("captureFromTurn requires workspaceId or workspaceRoot");
    }

    const combined = extractCandidates(messageText(input.userMessage), "user");
    // A plan can preserve an explicit user preference, but its architectural
    // statements have not been verified by completed work and are not durable.
    if (input.outcome !== "planned" && input.assistantEvidence === true) {
      combined.push(
        ...extractCandidates(messageText(input.assistantMessage), "assistant"),
      );
    }
    const deduplicated = new Map<string, Candidate>();
    for (const candidate of combined) {
      const previous = deduplicated.get(candidate.normalized);
      if (!previous || candidate.confidence > previous.confidence) {
        deduplicated.set(candidate.normalized, candidate);
      }
    }
    const candidates = [...deduplicated.values()].slice(0, 8);
    if (candidates.length === 0) return Object.freeze([]);

    const now = new Date().toISOString();
    const evidence = JSON.stringify({
      threadId: input.threadId,
      turnId: input.turnId,
      type: "completed_turn",
    });
    const upsert = this.storage.db.prepare(
      `INSERT INTO memories(
         id, workspace_id, category, content, normalized_content, confidence,
         status, evidence, source_thread_id, source_turn_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, normalized_content) DO UPDATE SET
         confidence = MIN(0.95, MAX(memories.confidence, excluded.confidence) + 0.03),
         status = 'active',
         evidence = excluded.evidence,
         source_thread_id = excluded.source_thread_id,
         source_turn_id = excluded.source_turn_id,
         updated_at = excluded.updated_at`,
    );
    const select = this.storage.db.prepare<[string, string], MemoryRow>(
      `SELECT * FROM memories
        WHERE workspace_id = ? AND normalized_content = ?`,
    );
    const captured: MemoryRow[] = [];

    this.storage.db.transaction(() => {
      for (const candidate of candidates) {
        upsert.run(
          createId("memory"),
          workspaceId,
          candidate.category,
          candidate.content,
          candidate.normalized,
          candidate.confidence,
          evidence,
          input.threadId,
          input.turnId,
          now,
          now,
        );
        const row = select.get(workspaceId, candidate.normalized);
        if (row) captured.push(row);
      }
    })();
    return Object.freeze(captured.map(toMemory));
  }
}
