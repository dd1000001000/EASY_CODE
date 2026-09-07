import {
  create,
  insertMultiple,
  search,
  type Orama,
  type WhereCondition,
} from "@orama/orama";

import type {
  ChatMessage,
  PlanReviewState,
  SessionState,
} from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import type { EmbeddingProvider } from "../memory/vector-index.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { sha256 } from "../utils/hash.js";

export type ContextArtifactSource = "user" | "assistant" | "tool";

export interface ContextCheckpointSnapshot {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly indexedMessageCount: number;
  readonly compactedMessageCount: number;
  readonly stateHash: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

export interface ContextCheckpointResult {
  readonly checkpoint: ContextCheckpointSnapshot;
  readonly indexedMessages: number;
  readonly indexedChunks: number;
}

export interface ContextSearchOptions {
  readonly limit?: number;
  /** Only evidence older than this durable message index is eligible. */
  readonly beforeMessageIndex?: number;
  readonly minimumSimilarity?: number;
}

export interface ContextSearchHit {
  readonly id: string;
  readonly source: ContextArtifactSource;
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
  readonly messageIndex: number;
  readonly score: number;
}

interface ContextArtifactRow {
  id: string;
  workspace_id: string;
  thread_id: string;
  source_key: string;
  source_type: ContextArtifactSource;
  title: string;
  content: string;
  content_hash: string;
  message_index: number;
  chunk_index: number;
  importance: number;
  created_at: string;
  updated_at: string;
}

interface ContextCheckpointRow {
  thread_id: string;
  workspace_id: string;
  checkpoint_sequence: number;
  indexed_message_count: number;
  compacted_message_count: number;
  state_hash: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface ContextEmbeddingRow extends ContextArtifactRow {
  model: string | null;
  revision: string | null;
  dimensions: number | null;
  pooling: string | null;
  embedding_version: number | null;
  embedding_content_hash: string | null;
  embedding: unknown;
}

interface CachedIndex {
  readonly generation: number;
  readonly database: Orama<ContextVectorSchema>;
  readonly size: number;
}

type ContextVectorSchema = {
  workspaceId: "enum";
  threadId: "enum";
  messageIndex: "number";
  importance: "number";
  embedding: `vector[${number}]`;
};

interface PendingArtifact {
  readonly id: string;
  readonly sourceKey: string;
  readonly source: ContextArtifactSource;
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
  readonly messageIndex: number;
  readonly chunkIndex: number;
  readonly importance: number;
}

interface PreparedEmbedding {
  readonly contentHash: string;
  readonly bytes: Uint8Array;
}

const MAX_INDEXED_MESSAGE_CHARS = 96_000;
const CHUNK_CHARS = 1_400;
const CHUNK_OVERLAP_CHARS = 160;
const MAX_CHECKPOINT_FILES = 240;
const MAX_CHECKPOINT_CHANGES = 120;
const MAX_CHECKPOINT_COMMANDS = 80;
const DEFAULT_SEARCH_LIMIT = 6;
const MAX_SEARCH_LIMIT = 12;
const DEFAULT_BACKFILL_LIMIT = 32;
const MAX_CACHE_RETRIES = 4;
const MAX_CACHED_VECTOR_THREADS = 4;
const MAX_CACHED_VECTORS = 8_192;
const MAX_THREAD_VECTOR_ROWS = 4_096;
const VECTOR_RETRY_DELAY_MS = 60_000;

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

function cleanIdentifier(value: string, label: string): string {
  const resolved = value.trim();
  if (!resolved || resolved.length > 300 || /[\u0000\r\n]/u.test(resolved)) {
    throw new Error(`${label} is invalid`);
  }
  return resolved;
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
  throw new Error("Stored context embedding is not a SQLite BLOB");
}

function decodeFloat32(value: unknown, dimensions: number): Float32Array {
  const bytes = blobBytes(value);
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("Stored context embedding has the wrong dimensions");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dimensions);
  let magnitudeSquared = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const component = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(component)) {
      throw new Error("Stored context embedding contains a non-finite component");
    }
    vector[index] = component;
    magnitudeSquared += component * component;
  }
  if (!(magnitudeSquared > 0)) {
    throw new Error("Stored context embedding has zero magnitude");
  }
  return vector;
}

function checkedVector(vector: Float32Array, dimensions: number): Float32Array {
  if (!(vector instanceof Float32Array) || vector.length !== dimensions) {
    throw new Error(`Embedding provider must return ${dimensions}-dimension Float32Array values`);
  }
  const copy = new Float32Array(dimensions);
  let magnitudeSquared = 0;
  for (let index = 0; index < dimensions; index += 1) {
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

function ftsExpression(query: string): string | undefined {
  const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const unique = [...new Set(tokens)].slice(0, 12);
  if (unique.length === 0) return undefined;
  return unique
    .map((token) => `"${token.replace(/"/g, "\"\"")}"*`)
    .join(" OR ");
}

function cjkSubstringTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of query.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const characters = [...match[0]];
    for (const width of [3, 2]) {
      if (characters.length < width) continue;
      for (let index = 0; index <= characters.length - width; index += 1) {
        const term = characters.slice(index, index + width).join("");
        if (seen.has(term)) continue;
        seen.add(term);
        terms.push(term);
        if (terms.length >= 12) return terms;
      }
    }
  }
  return terms;
}

function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = "\n...[content omitted from the retrieval index]...\n";
  const available = Math.max(0, maximum - marker.length);
  const head = Math.ceil(available * 0.7);
  return `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`;
}

function artifactText(message: ChatMessage, messageIndex: number): {
  source: ContextArtifactSource;
  title: string;
  content: string;
  importance: number;
} | undefined {
  if (message.role === "user") {
    const imageDetails = message.images?.length
      ? `\nAttachments: ${message.images.map((image) =>
          `${image.label} (${image.mediaType}, ${image.width}x${image.height})`).join(", ")}`
      : "";
    const content = `${message.content}${imageDetails}`.trim();
    return content
      ? { source: "user", title: `User request evidence at message ${messageIndex}`, content, importance: 0.9 }
      : undefined;
  }
  if (message.role === "assistant") {
    const requestedTools = message.tool_calls?.length
      ? `\nRequested tools: ${message.tool_calls.map((call) =>
          call.function.name).join(", ")}`
      : "";
    const content = `${message.content ?? ""}${requestedTools}`.trim();
    return content
      ? { source: "assistant", title: `Assistant work at message ${messageIndex}`, content, importance: 0.65 }
      : undefined;
  }

  // System instructions are runtime configuration rather than conversational
  // evidence. They are versioned in the prompt bundle and must not be recalled
  // as if they were a user request or tool observation.
  if (message.role === "system") return undefined;

  let title = `Tool ${message.name ?? "unknown"} result at message ${messageIndex}`;
  let content = message.content;
  let importance = message.name === "read_file" ||
      message.name === "run_command" ||
      message.name === "start_command" ||
      message.name === "poll_command" ||
      message.name === "cancel_command"
    ? 0.95
    : 0.82;
  try {
    const parsed = JSON.parse(message.content) as {
      summary?: unknown;
      data?: unknown;
      error?: unknown;
    };
    if (typeof parsed.summary === "string" && parsed.summary.trim()) {
      title = parsed.summary.trim();
    }
    if (message.name === "read_file" && parsed.data && typeof parsed.data === "object") {
      const data = parsed.data as Record<string, unknown>;
      if (typeof data.content === "string") {
        const location = typeof data.path === "string"
          ? `${data.path}${Number.isInteger(data.startLine) && Number.isInteger(data.endLine)
              ? `:${String(data.startLine)}-${String(data.endLine)}`
              : ""}`
          : title;
        title = `Read ${location}`;
        content = data.content;
      }
    }
  } catch {
    // Tool messages are already bounded model-visible data; opaque text is valid evidence.
  }
  content = content.trim();
  return content ? { source: "tool", title, content, importance } : undefined;
}

function splitIntoChunks(value: string): string[] {
  const text = boundedText(redactSensitiveInformation(value), MAX_INDEXED_MESSAGE_CHARS).trim();
  if (!text) return [];
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length) {
      const minimumSplit = start + Math.floor(CHUNK_CHARS * 0.6);
      const newline = text.lastIndexOf("\n", end);
      const space = text.lastIndexOf(" ", end);
      const split = Math.max(newline, space);
      if (split >= minimumSplit) end = split;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    const next = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
    start = next;
  }
  return chunks;
}

function artifactsForMessage(
  threadId: string,
  message: ChatMessage,
  messageIndex: number,
): PendingArtifact[] {
  const document = artifactText(message, messageIndex);
  if (!document) return [];
  return splitIntoChunks(document.content).map((content, chunkIndex) => {
    const sourceKey = `message:${String(messageIndex)}:chunk:${String(chunkIndex)}`;
    return {
      id: `context_${sha256(`${threadId}\n${sourceKey}`).slice(0, 48)}`,
      sourceKey,
      source: document.source,
      title: document.title,
      content,
      contentHash: sha256(content),
      messageIndex,
      chunkIndex,
      importance: document.importance,
    };
  });
}

function taskGraphCheckpoint(state: Readonly<SessionState>): object | undefined {
  if (!state.taskGraph) return undefined;
  return {
    id: state.taskGraph.id,
    goal: state.taskGraph.goal,
    status: state.taskGraph.status,
    tasks: state.taskGraph.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: boundedText(task.description, 2_000),
      status: task.status,
      owner: task.owner,
      dependencies: [...task.dependencies],
      inputs: task.inputs.map((input) => boundedText(input, 1_000)),
      expectedArtifacts: task.expectedArtifacts.map((artifact) => boundedText(artifact, 1_000)),
      completionChecks: task.completionChecks.map((check) => boundedText(check, 1_000)),
      failureHandling: boundedText(task.failureHandling, 1_000),
      ...(task.blocker ? { blocker: boundedText(task.blocker, 2_000) } : {}),
      ...(task.completionEvidence?.length
        ? { completionEvidence: task.completionEvidence.slice(-4) }
        : {}),
    })),
  };
}

function planCheckpoint(review: Readonly<PlanReviewState>): object {
  return {
    status: review.status,
    proposal: {
      id: review.proposal.id,
      revision: review.proposal.revision,
      title: review.proposal.title,
      overview: boundedText(review.proposal.overview, 4_000),
      steps: review.proposal.steps.map((step) => ({
        title: boundedText(step.title, 1_000),
        description: boundedText(step.description, 2_000),
        verification: boundedText(step.verification, 2_000),
      })),
      proposedByTurnId: review.proposal.proposedByTurnId,
      proposedAt: review.proposal.proposedAt,
    },
    ...(review.feedback ? { feedback: boundedText(review.feedback, 4_000) } : {}),
    ...(review.approvedAt ? { approvedAt: review.approvedAt } : {}),
  };
}

function latestFailureCheckpoint(
  state: Readonly<SessionState>,
): Readonly<Record<string, unknown>> | undefined {
  let toolFailure: Readonly<Record<string, unknown>> | undefined;
  const observedToolNames = new Set<string>();
  const earliestMessageIndex = Math.max(0, state.messages.length - 64);
  for (
    let index = state.messages.length - 1;
    index >= earliestMessageIndex;
    index -= 1
  ) {
    const message = state.messages[index];
    if (!message || message.role !== "tool") continue;
    const toolName = message.name ?? "unknown";
    if (observedToolNames.has(toolName)) continue;
    // Only the latest result for each tool can be an unresolved failure. A
    // later successful retry prevents an older failure from remaining pinned.
    observedToolNames.add(toolName);
    try {
      const parsed = JSON.parse(message.content) as {
        ok?: unknown;
        summary?: unknown;
        error?: unknown;
        data?: unknown;
      };
      if (parsed.ok !== false && typeof parsed.error !== "string") continue;
      const data = parsed.data && typeof parsed.data === "object"
        ? parsed.data as Record<string, unknown>
        : undefined;
      toolFailure = {
        messageIndex: index,
        tool: toolName,
        ...(typeof parsed.summary === "string"
          ? { summary: boundedText(parsed.summary, 2_000) }
          : {}),
        ...(typeof parsed.error === "string"
          ? { error: boundedText(parsed.error, 2_000) }
          : {}),
        ...(typeof data?.path === "string"
          ? { path: boundedText(data.path, 1_000) }
          : {}),
      };
      break;
    } catch {
      // Opaque tool output is not assumed to be a failure.
    }
  }

  const latestCommand = state.commands.at(-1);
  const command = latestCommand && (
    latestCommand.status !== "exited" || latestCommand.exitCode !== 0
  )
    ? latestCommand
    : undefined;
  const blockedTask = state.taskGraph?.tasks.find((task) => task.status === "blocked");
  if (!toolFailure && !command && !blockedTask) return undefined;
  return {
    ...(toolFailure ? { tool: toolFailure } : {}),
    ...(command
      ? {
          command: {
            id: command.id,
            program: command.program,
            cwd: command.cwd,
            status: command.status,
            exitCode: command.exitCode,
            summary: boundedText(command.summary, 2_000),
            timestamp: command.timestamp,
          },
        }
      : {}),
    ...(blockedTask
      ? {
          task: {
            id: blockedTask.id,
            title: blockedTask.title,
            blocker: boundedText(blockedTask.blocker ?? "Task is blocked.", 2_000),
          },
        }
      : {}),
  };
}

function checkpointPayload(state: Readonly<SessionState>): Readonly<Record<string, unknown>> {
  const graph = taskGraphCheckpoint(state);
  const latestFailure = latestFailureCheckpoint(state);
  return {
    version: 2,
    objective: state.goal ? boundedText(redactSensitiveInformation(state.goal), 12_000) : null,
    constraints: state.constraints.map((constraint) =>
      boundedText(redactSensitiveInformation(constraint), 2_000)),
    execution: {
      mode: state.mode,
      provider: state.provider,
      model: state.model,
      thinkingEffort: state.thinkingEffort,
      activeTurnId: state.activeTurnId ?? null,
    },
    conversation: {
      messageCount: state.messages.length,
      compactedMessageCount: state.compactedMessageCount,
      workingSummaryHash: state.workingSummary ? sha256(state.workingSummary) : null,
    },
    ...(latestFailure ? { latestFailure } : {}),
    currentDiff: {
      kind: "change_manifest",
      order: "newest_first",
      changes: state.changes.slice(-MAX_CHECKPOINT_CHANGES).reverse()
        .map((change) => ({ ...change })),
    },
    filesRead: [...state.filesRead.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(-MAX_CHECKPOINT_FILES)
      .map((file) => ({ path: file.path, hash: file.hash, readAt: file.readAt })),
    commands: state.commands.slice(-MAX_CHECKPOINT_COMMANDS).map((command) => ({
      id: command.id,
      program: command.program,
      cwd: command.cwd,
      status: command.status,
      exitCode: command.exitCode,
      durationMs: command.durationMs,
      summary: boundedText(redactSensitiveInformation(command.summary), 2_000),
      timestamp: command.timestamp,
      ...(command.sourceAgentId ? { sourceAgentId: command.sourceAgentId } : {}),
      ...(command.sourceTaskId ? { sourceTaskId: command.sourceTaskId } : {}),
    })),
    ...(graph ? { taskGraph: graph } : {}),
    ...(state.planReview ? { planReview: planCheckpoint(state.planReview) } : {}),
  };
}

function redactCheckpointValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveInformation(value);
  if (Array.isArray(value)) return value.map(redactCheckpointValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, redactCheckpointValue(entry)]),
    );
  }
  return value;
}

function checkpointSnapshot(row: ContextCheckpointRow): ContextCheckpointSnapshot {
  const parsed = JSON.parse(row.payload_json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored context checkpoint payload is invalid");
  }
  return Object.freeze({
    threadId: row.thread_id,
    workspaceId: row.workspace_id,
    sequence: row.checkpoint_sequence,
    indexedMessageCount: row.indexed_message_count,
    compactedMessageCount: row.compacted_message_count,
    stateHash: row.state_hash,
    payload: Object.freeze(parsed as Record<string, unknown>),
    updatedAt: row.updated_at,
  });
}

/**
 * Durable, Thread-private evidence index for layered context construction.
 * SQLite/FTS5 is authoritative; Orama is a disposable vector projection.
 */
export class ContextArtifactIndex {
  private readonly caches = new Map<string, CachedIndex>();
  private readonly cacheBuilds = new Map<string, Promise<CachedIndex>>();
  private readonly vectorDisabledUntil = new Map<string, number>();

  constructor(
    private readonly storage: EasyCodeStorage,
    private readonly provider: EmbeddingProvider,
    private readonly onVectorError?: (error: unknown) => void,
  ) {
    if (!Number.isInteger(provider.dimension) || provider.dimension <= 0) {
      throw new Error("Context embedding provider dimension is invalid");
    }
  }

  async checkpoint(
    workspaceIdInput: string,
    state: Readonly<SessionState>,
  ): Promise<ContextCheckpointResult> {
    const workspaceId = cleanIdentifier(workspaceIdInput, "workspaceId");
    const threadId = cleanIdentifier(state.threadId, "threadId");
    const previous = this.checkpointRow(threadId);
    const reset = Boolean(
      previous && (
        previous.workspace_id !== workspaceId ||
        previous.indexed_message_count > state.messages.length
      ),
    );
    const start = reset ? 0 : Math.min(previous?.indexed_message_count ?? 0, state.messages.length);
    const pending: PendingArtifact[] = [];
    for (let index = start; index < state.messages.length; index += 1) {
      const message = state.messages[index];
      if (message) pending.push(...artifactsForMessage(threadId, message, index));
    }

    const payload = redactCheckpointValue(checkpointPayload(state)) as Readonly<Record<string, unknown>>;
    const payloadJson = JSON.stringify(payload);
    const stateHash = sha256(payloadJson);
    const checkpointChanged = !previous || reset || previous.state_hash !== stateHash ||
      previous.indexed_message_count !== state.messages.length ||
      previous.compacted_message_count !== state.compactedMessageCount;
    const now = new Date().toISOString();

    if (pending.length > 0 || checkpointChanged || reset) {
      this.storage.db.transaction(() => {
        if (reset) {
          this.storage.db.prepare<[string]>(
            "DELETE FROM context_artifacts WHERE thread_id = ?",
          ).run(threadId);
        }
        const upsert = this.storage.db.prepare<[
          string, string, string, string, string, string, string, string,
          number, number, number, string, string,
        ]>(
          `INSERT INTO context_artifacts(
             id, workspace_id, thread_id, source_key, source_type, title,
             content, content_hash, message_index, chunk_index, importance,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id, source_key) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             source_type = excluded.source_type,
             title = excluded.title,
             content = excluded.content,
             content_hash = excluded.content_hash,
             message_index = excluded.message_index,
             chunk_index = excluded.chunk_index,
             importance = excluded.importance,
             updated_at = excluded.updated_at`,
        );
        for (const artifact of pending) {
          upsert.run(
            artifact.id,
            workspaceId,
            threadId,
            artifact.sourceKey,
            artifact.source,
            artifact.title,
            artifact.content,
            artifact.contentHash,
            artifact.messageIndex,
            artifact.chunkIndex,
            artifact.importance,
            now,
            now,
          );
        }

        if (!previous) {
          this.storage.db.prepare<[
            string, string, number, number, number, string, string, string, string,
          ]>(
            `INSERT INTO context_checkpoints(
               thread_id, workspace_id, checkpoint_sequence,
               indexed_message_count, compacted_message_count, state_hash,
               payload_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            threadId,
            workspaceId,
            1,
            state.messages.length,
            state.compactedMessageCount,
            stateHash,
            payloadJson,
            now,
            now,
          );
        } else if (checkpointChanged || reset) {
          this.storage.db.prepare<[
            string, number, number, string, string, string, string,
          ]>(
            `UPDATE context_checkpoints
                SET workspace_id = ?,
                    checkpoint_sequence = checkpoint_sequence + 1,
                    indexed_message_count = ?,
                    compacted_message_count = ?,
                    state_hash = ?,
                    payload_json = ?,
                    updated_at = ?
              WHERE thread_id = ?`,
          ).run(
            workspaceId,
            state.messages.length,
            state.compactedMessageCount,
            stateHash,
            payloadJson,
            now,
            threadId,
          );
        }
      })();
      this.invalidate(threadId);
    }

    const row = this.checkpointRow(threadId);
    if (!row) throw new Error("Context checkpoint was not persisted");
    return Object.freeze({
      checkpoint: checkpointSnapshot(row),
      indexedMessages: state.messages.length - start,
      indexedChunks: pending.length,
    });
  }

  getCheckpoint(threadIdInput: string): ContextCheckpointSnapshot | undefined {
    const row = this.checkpointRow(cleanIdentifier(threadIdInput, "threadId"));
    return row ? checkpointSnapshot(row) : undefined;
  }

  async search(
    workspaceIdInput: string,
    threadIdInput: string,
    queryInput: string,
    options: ContextSearchOptions = {},
  ): Promise<ReadonlyArray<Readonly<ContextSearchHit>>> {
    const workspaceId = cleanIdentifier(workspaceIdInput, "workspaceId");
    const threadId = cleanIdentifier(threadIdInput, "threadId");
    const query = queryInput.trim().slice(0, 12_000);
    if (!query) return Object.freeze([]);
    const limit = boundedInteger(options.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const beforeMessageIndex = boundedInteger(
      options.beforeMessageIndex,
      Number.MAX_SAFE_INTEGER,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (beforeMessageIndex <= 0) return Object.freeze([]);
    const candidateLimit = Math.max(24, limit * 8);
    const lexical = this.lexicalCandidates(
      workspaceId,
      threadId,
      query,
      beforeMessageIndex,
      candidateLimit,
    );

    let semantic: ReadonlyArray<{ id: string; score: number }> = [];
    if (Date.now() >= (this.vectorDisabledUntil.get(threadId) ?? 0)) {
      try {
        await this.backfill(threadId, beforeMessageIndex, DEFAULT_BACKFILL_LIMIT);
        const index = await this.getCachedIndex(threadId);
        if (index.size > 0) {
          const [queryVector] = await this.prepareEmbeddings([query]);
          if (!queryVector) throw new Error("Embedding provider returned no context query vector");
          const where: Partial<WhereCondition<ContextVectorSchema>> = {
            workspaceId: { eq: workspaceId },
            threadId: { eq: threadId },
            messageIndex: { lt: beforeMessageIndex },
          };
          const result = await search(index.database, {
            mode: "vector",
            vector: { value: decodeFloat32(queryVector.bytes, this.provider.dimension), property: "embedding" },
            similarity: boundedUnit(options.minimumSimilarity, 0.08),
            limit: Math.max(candidateLimit, 80),
            where,
            includeVectors: true,
          });
          semantic = result.hits
            .filter((hit) => {
              const document = hit.document as { messageIndex?: unknown };
              return typeof document.messageIndex === "number" &&
                document.messageIndex < beforeMessageIndex;
            })
            .slice(0, candidateLimit)
            .map((hit) => ({ id: hit.id, score: hit.score }));
        }
        this.vectorDisabledUntil.delete(threadId);
      } catch (error) {
        this.vectorDisabledUntil.set(threadId, Date.now() + VECTOR_RETRY_DELAY_MS);
        try {
          this.onVectorError?.(error);
        } catch {
          // Retrieval always retains its SQLite FTS5 fallback.
        }
      }
    }

    const candidates = new Map<string, {
      row: ContextArtifactRow;
      lexicalRank?: number;
      semanticRank?: number;
      semanticScore?: number;
    }>();
    lexical.forEach((row, rank) => candidates.set(row.id, { row, lexicalRank: rank }));
    semantic.forEach((hit, rank) => {
      const row = candidates.get(hit.id)?.row ?? this.artifactRow(hit.id);
      if (!row || row.workspace_id !== workspaceId || row.thread_id !== threadId ||
          row.message_index >= beforeMessageIndex) return;
      const prior = candidates.get(hit.id);
      candidates.set(hit.id, {
        row,
        ...(prior?.lexicalRank !== undefined ? { lexicalRank: prior.lexicalRank } : {}),
        semanticRank: rank,
        semanticScore: hit.score,
      });
    });

    const ranked = [...candidates.values()]
      .map((candidate) => {
        const lexicalRrf = candidate.lexicalRank === undefined ? 0 : 1 / (60 + candidate.lexicalRank + 1);
        const semanticRrf = candidate.semanticRank === undefined ? 0 : 1 / (60 + candidate.semanticRank + 1);
        const recency = candidate.row.message_index / Math.max(1, beforeMessageIndex);
        const score = lexicalRrf + semanticRrf +
          candidate.row.importance * 0.002 + recency * 0.001 +
          (candidate.semanticScore ?? 0) * 0.0005;
        return { ...candidate, score };
      })
      .sort((left, right) =>
        right.score - left.score ||
        right.row.importance - left.row.importance ||
        right.row.message_index - left.row.message_index,
      );

    const seenHashes = new Set<string>();
    const hits: ContextSearchHit[] = [];
    for (const candidate of ranked) {
      if (seenHashes.has(candidate.row.content_hash)) continue;
      seenHashes.add(candidate.row.content_hash);
      hits.push(Object.freeze({
        id: candidate.row.id,
        source: candidate.row.source_type,
        title: candidate.row.title,
        content: candidate.row.content,
        contentHash: candidate.row.content_hash,
        messageIndex: candidate.row.message_index,
        score: candidate.score,
      }));
      if (hits.length >= limit) break;
    }
    return Object.freeze(hits);
  }

  private checkpointRow(threadId: string): ContextCheckpointRow | undefined {
    return this.storage.db.prepare<[string], ContextCheckpointRow>(
      "SELECT * FROM context_checkpoints WHERE thread_id = ?",
    ).get(threadId);
  }

  private artifactRow(id: string): ContextArtifactRow | undefined {
    return this.storage.db.prepare<[string], ContextArtifactRow>(
      "SELECT * FROM context_artifacts WHERE id = ?",
    ).get(id);
  }

  private lexicalCandidates(
    workspaceId: string,
    threadId: string,
    query: string,
    beforeMessageIndex: number,
    limit: number,
  ): ContextArtifactRow[] {
    const expression = ftsExpression(query);
    let ftsRows: ContextArtifactRow[] = [];
    if (expression) {
      try {
        ftsRows = this.storage.db.prepare<[
          string, string, string, number, number,
        ], ContextArtifactRow>(
          `SELECT a.*
             FROM context_artifacts_fts
             JOIN context_artifacts AS a ON a.rowid = context_artifacts_fts.rowid
            WHERE context_artifacts_fts MATCH ?
              AND a.workspace_id = ?
              AND a.thread_id = ?
              AND a.message_index < ?
            ORDER BY bm25(context_artifacts_fts), a.importance DESC, a.message_index DESC
            LIMIT ?`,
        ).all(expression, workspaceId, threadId, beforeMessageIndex, limit);
      } catch {
        // A repairable FTS projection failure can still use the CJK substring path.
      }
    }
    const cjkTerms = cjkSubstringTerms(query);
    let cjkRows: ContextArtifactRow[] = [];
    if (cjkTerms.length > 0) {
      const document = "lower(a.title || char(10) || a.content)";
      const score = cjkTerms
        .map(() => `CASE WHEN instr(${document}, lower(?)) > 0 THEN 1 ELSE 0 END`)
        .join(" + ");
      const matches = cjkTerms
        .map(() => `instr(${document}, lower(?)) > 0`)
        .join(" OR ");
      cjkRows = this.storage.db.prepare<Array<string | number>, ContextArtifactRow>(
        `SELECT a.*, (${score}) AS substring_score
           FROM context_artifacts AS a
          WHERE a.workspace_id = ?
            AND a.thread_id = ?
            AND a.message_index < ?
            AND (${matches})
          ORDER BY substring_score DESC, a.importance DESC, a.message_index DESC
          LIMIT ?`,
      ).all(
        ...cjkTerms,
        workspaceId,
        threadId,
        beforeMessageIndex,
        ...cjkTerms,
        limit,
      );
    }
    if (ftsRows.length > 0 || cjkRows.length > 0) {
      const merged = new Map<string, ContextArtifactRow>();
      for (const row of [...cjkRows, ...ftsRows]) {
        if (!merged.has(row.id)) merged.set(row.id, row);
        if (merged.size >= limit) break;
      }
      return [...merged.values()];
    }
    if (expression || cjkTerms.length > 0) return [];
    return this.storage.db.prepare<[
      string, string, number, number,
    ], ContextArtifactRow>(
      `SELECT * FROM context_artifacts
        WHERE workspace_id = ? AND thread_id = ? AND message_index < ?
        ORDER BY importance DESC, message_index DESC, chunk_index
        LIMIT ?`,
    ).all(workspaceId, threadId, beforeMessageIndex, limit);
  }

  private async prepareEmbeddings(contents: readonly string[]): Promise<PreparedEmbedding[]> {
    if (contents.length === 0) return [];
    const vectors = await this.provider.embed(contents);
    if (vectors.length !== contents.length) {
      throw new Error("Embedding provider returned the wrong number of context vectors");
    }
    return vectors.map((vector, index) => ({
      contentHash: sha256(contents[index]!),
      bytes: encodeFloat32(checkedVector(vector, this.provider.dimension)),
    }));
  }

  private async backfill(
    threadId: string,
    beforeMessageIndex: number,
    limit: number,
  ): Promise<void> {
    const rows = this.storage.db.prepare<[
      string, number, number, string, string, number, string, number, number, number,
    ], ContextEmbeddingRow>(
      `SELECT a.*,
              e.model, e.revision, e.dimensions, e.pooling,
              e.embedding_version, e.content_hash AS embedding_content_hash,
              e.embedding
         FROM (
           SELECT *
             FROM context_artifacts
            WHERE thread_id = ?
              AND message_index < ?
            ORDER BY message_index DESC, chunk_index DESC
            LIMIT ?
         ) AS a
         LEFT JOIN context_artifact_embeddings AS e ON e.artifact_id = a.id
        WHERE (
            e.artifact_id IS NULL OR
            e.model <> ? OR
            e.revision <> ? OR
            e.dimensions <> ? OR
            e.pooling <> ? OR
            e.embedding_version <> ? OR
            e.content_hash <> a.content_hash OR
            length(e.embedding) <> ?
          )
        ORDER BY a.message_index DESC, a.chunk_index
        LIMIT ?`,
    ).all(
      threadId,
      beforeMessageIndex,
      MAX_THREAD_VECTOR_ROWS,
      this.provider.model,
      this.provider.revision,
      this.provider.dimension,
      this.provider.pooling,
      this.provider.version,
      this.provider.dimension * Float32Array.BYTES_PER_ELEMENT,
      limit,
    );
    const stale = rows.filter((row) => !this.isCurrentEmbedding(row));
    if (stale.length === 0) return;
    const prepared = await this.prepareEmbeddings(stale.map((row) => row.content));
    const now = new Date().toISOString();
    this.storage.db.transaction(() => {
      const upsert = this.storage.db.prepare<[
        string, string, string, string, number, string, number, string,
        Uint8Array, string, string,
      ]>(
        `INSERT INTO context_artifact_embeddings(
           artifact_id, thread_id, model, revision, dimensions, pooling,
           embedding_version, content_hash, embedding, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET
           thread_id = excluded.thread_id,
           model = excluded.model,
           revision = excluded.revision,
           dimensions = excluded.dimensions,
           pooling = excluded.pooling,
           embedding_version = excluded.embedding_version,
           content_hash = excluded.content_hash,
           embedding = excluded.embedding,
           updated_at = excluded.updated_at`,
      );
      for (let index = 0; index < stale.length; index += 1) {
        const row = stale[index]!;
        const embedding = prepared[index]!;
        const current = this.artifactRow(row.id);
        if (!current || current.content_hash !== embedding.contentHash) continue;
        upsert.run(
          current.id,
          current.thread_id,
          this.provider.model,
          this.provider.revision,
          this.provider.dimension,
          this.provider.pooling,
          this.provider.version,
          embedding.contentHash,
          embedding.bytes,
          now,
          now,
        );
      }
    })();
    this.invalidate(threadId);
  }

  private isCurrentEmbedding(row: ContextEmbeddingRow): boolean {
    if (
      row.model !== this.provider.model ||
      row.revision !== this.provider.revision ||
      row.dimensions !== this.provider.dimension ||
      row.pooling !== this.provider.pooling ||
      row.embedding_version !== this.provider.version ||
      row.embedding_content_hash !== row.content_hash
    ) return false;
    try {
      decodeFloat32(row.embedding, this.provider.dimension);
      return true;
    } catch {
      return false;
    }
  }

  private generation(threadId: string): number {
    return this.storage.db.prepare<[string], { generation: number }>(
      "SELECT generation FROM context_vector_state WHERE thread_id = ?",
    ).get(threadId)?.generation ?? 0;
  }

  private invalidate(threadId: string): void {
    this.caches.delete(threadId);
  }

  private async getCachedIndex(threadId: string): Promise<CachedIndex> {
    for (let attempt = 0; attempt < MAX_CACHE_RETRIES; attempt += 1) {
      const generation = this.generation(threadId);
      const cached = this.caches.get(threadId);
      if (cached?.generation === generation) {
        this.caches.delete(threadId);
        this.caches.set(threadId, cached);
        return cached;
      }
      const built = await this.buildSharedIndex(threadId);
      if (this.generation(threadId) === built.generation) {
        this.cacheIndex(threadId, built);
        return built;
      }
      this.invalidate(threadId);
    }
    throw new Error("Context vector index changed continuously while rebuilding");
  }

  private cacheIndex(threadId: string, index: CachedIndex): void {
    this.caches.delete(threadId);
    if (index.size > MAX_CACHED_VECTORS) return;
    this.caches.set(threadId, index);
    let totalVectors = [...this.caches.values()].reduce(
      (total, cached) => total + cached.size,
      0,
    );
    while (
      this.caches.size > MAX_CACHED_VECTOR_THREADS ||
      totalVectors > MAX_CACHED_VECTORS
    ) {
      const oldestThreadId = this.caches.keys().next().value as string | undefined;
      if (oldestThreadId === undefined) break;
      const removed = this.caches.get(oldestThreadId);
      this.caches.delete(oldestThreadId);
      totalVectors -= removed?.size ?? 0;
    }
  }

  private async buildSharedIndex(threadId: string): Promise<CachedIndex> {
    const active = this.cacheBuilds.get(threadId);
    if (active) return active;
    const pending = this.buildIndex(threadId);
    this.cacheBuilds.set(threadId, pending);
    try {
      return await pending;
    } finally {
      if (this.cacheBuilds.get(threadId) === pending) this.cacheBuilds.delete(threadId);
    }
  }

  private async buildIndex(threadId: string): Promise<CachedIndex> {
    const generation = this.generation(threadId);
    const rows = this.storage.db.prepare<[
      string, string, string, number, string, number, number,
    ], ContextEmbeddingRow>(
      `SELECT a.*,
              e.model, e.revision, e.dimensions, e.pooling,
              e.embedding_version, e.content_hash AS embedding_content_hash,
              e.embedding
         FROM context_artifacts AS a
         JOIN context_artifact_embeddings AS e ON e.artifact_id = a.id
        WHERE a.thread_id = ?
          AND e.model = ?
          AND e.revision = ?
          AND e.dimensions = ?
          AND e.pooling = ?
          AND e.embedding_version = ?
        ORDER BY a.message_index DESC, a.chunk_index DESC
        LIMIT ?`,
    ).all(
      threadId,
      this.provider.model,
      this.provider.revision,
      this.provider.dimension,
      this.provider.pooling,
      this.provider.version,
      MAX_THREAD_VECTOR_ROWS,
    );
    const vectorType = `vector[${this.provider.dimension}]` as `vector[${number}]`;
    const database = await create({
      schema: {
        workspaceId: "enum",
        threadId: "enum",
        messageIndex: "number",
        importance: "number",
        embedding: vectorType,
      } satisfies ContextVectorSchema,
    });
    const documents: Array<{
      id: string;
      workspaceId: string;
      threadId: string;
      messageIndex: number;
      importance: number;
      embedding: number[];
    }> = [];
    for (const row of rows) {
      if (!this.isCurrentEmbedding(row)) continue;
      try {
        documents.push({
          id: row.id,
          workspaceId: row.workspace_id,
          threadId: row.thread_id,
          messageIndex: row.message_index,
          importance: row.importance,
          embedding: Array.from(decodeFloat32(row.embedding, this.provider.dimension)),
        });
      } catch {
        // A damaged derived vector is skipped and repaired by a later backfill.
      }
    }
    if (documents.length > 0) await insertMultiple(database, documents, 100);
    return { generation, database, size: documents.length };
  }
}

export function renderContextCheckpoint(
  checkpoint: Readonly<ContextCheckpointSnapshot> | undefined,
): string {
  if (!checkpoint) return "";
  return JSON.stringify({
    checkpointSequence: checkpoint.sequence,
    indexedMessageCount: checkpoint.indexedMessageCount,
    stateHash: checkpoint.stateHash,
    ...checkpoint.payload,
  }, null, 2);
}

/**
 * Render the trusted, current execution layer independently of the derived
 * retrieval index. This remains available when indexing fails and can also
 * retain an approved plan after Runtime consumes the review gate for execution.
 */
export function renderPinnedCurrentState(
  state: Readonly<SessionState>,
  approvedPlanReview?: Readonly<PlanReviewState>,
): string {
  const payload = checkpointPayload(state);
  const pinned = {
    pinnedCurrentState: true,
    ...payload,
    ...(approvedPlanReview
      ? { approvedPlan: planCheckpoint(approvedPlanReview) }
      : {}),
  };
  return JSON.stringify(redactCheckpointValue(pinned), null, 2);
}

export function renderRetrievedContext(
  hits: readonly Readonly<ContextSearchHit>[],
): string {
  return hits.map((hit) => [
    `[evidence_id=${hit.id}] [source=${hit.source}] ` +
      `[message_index=${String(hit.messageIndex)}] [content_hash=${hit.contentHash}]`,
    hit.title,
    hit.content,
  ].join("\n")).join("\n\n");
}
