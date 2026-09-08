import type { ToolExecutionResult } from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { sha256 } from "../utils/hash.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";

const MAX_EVIDENCE_CHARS = 1_000_000;
export function toolEvidenceId(threadId: string, callId: string): string {
  return `evidence_${sha256(JSON.stringify([threadId, callId]))}`;
}

/** Captured before model-facing clipping, immutable and scope checked. This
 * stores captured tool data, not unlimited process output or private thinking. */
export class EvidenceStore {
  constructor(private readonly storage: EasyCodeStorage) {}

  capture(workspaceId: string, threadId: string, callId: string, tool: string,
    result: ToolExecutionResult): string {
    const full = redactSensitiveInformation(JSON.stringify({ ok: result.ok, summary: result.summary,
      error: result.error, data: result.data }));
    const content = full.slice(0, MAX_EVIDENCE_CHARS);
    const contentHash = sha256(full);
    const id = toolEvidenceId(threadId, callId);
    const existing = this.storage.db.prepare<[string], { content_hash: string; workspace_id: string; tool: string }>(
      "SELECT content_hash, workspace_id, tool FROM context_evidence WHERE id = ?").get(id);
    if (existing && (existing.content_hash !== contentHash || existing.workspace_id !== workspaceId || existing.tool !== tool)) {
      throw new Error("Evidence identity collision");
    }
    if (!existing) this.storage.db.prepare(
      `INSERT INTO context_evidence(id, workspace_id, thread_id, call_id, tool, content,
       content_hash, truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, workspaceId, threadId, callId, tool, content, contentHash,
      full.length > content.length ? 1 : 0, new Date().toISOString());
    return id;
  }

  read(workspaceId: string, threadId: string, id: string, offset = 0, limit = 8000): object {
    if (!/^(?:evidence_[a-f0-9]{64}|context_[a-f0-9]{48})$/u.test(id)) throw new Error("Invalid evidence ID");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) {
      throw new Error("Invalid evidence page");
    }
    const row = id.startsWith("context_") ? this.storage.db.prepare<[string, string, string], {
      tool: string; content: string; content_hash: string; truncated: number;
    }>("SELECT source_type AS tool, content, content_hash, COALESCE(json_extract(metadata_json, '$.sourceTruncated'), 0) AS truncated FROM context_artifacts WHERE id = ? AND workspace_id = ? AND thread_id = ?")
      .get(id, workspaceId, threadId) : this.storage.db.prepare<[string, string, string], {
      tool: string; content: string; content_hash: string; truncated: number;
    }>("SELECT tool, content, content_hash, truncated FROM context_evidence WHERE id = ? AND workspace_id = ? AND thread_id = ?")
      .get(id, workspaceId, threadId);
    if (!row) throw new Error("Evidence not found in the current workspace and thread");
    if (offset > row.content.length) throw new Error("Evidence offset exceeds captured content");
    const end = Math.min(row.content.length, offset + limit);
    return { id, tool: row.tool, content: row.content.slice(offset, end), offset,
      nextOffset: end < row.content.length ? end : null, capturedChars: row.content.length,
      sourceTruncated: row.truncated === 1, capturedSourceHash: row.content_hash,
      historical: true };
  }
}
