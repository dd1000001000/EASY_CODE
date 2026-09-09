import type { ChatMessage, LongTermMemory, SessionState } from "../core/types.js";
import type { ContextSearchHit } from "./artifact-index.js";
import { estimateTextTokens } from "./manager.js";
import { sha256 } from "../utils/hash.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { isTransientMemory } from "../memory/admission.js";
import { unresolvedCommands } from "./runtime-state.js";

/** Separate bounded intents; never feed the entire conversation to embedding. */
export function memoryQueries(state: Readonly<SessionState>, userInput: string): string[] {
  const task = state.taskGraph?.tasks.find((item) => item.status === "in_progress")
    ?? state.taskGraph?.tasks.find((item) => item.status === "blocked");
  const failure = unresolvedCommands(state).at(-1);
  const paths = state.changes.slice(-3).map((item) => item.path).join(" ");
  return [...new Set([
    task ? `${task.title} ${task.description}` : state.goal ?? userInput,
    failure ? `${failure.program} ${failure.summary}` : "",
    paths,
    userInput,
  ].map((value) => redactSensitiveInformation(value.trim()).slice(0, 320)).filter(Boolean))].slice(0, 4);
}

export function memoryQueryKey(state: Readonly<SessionState>, queries: readonly string[]): string {
  return sha256(JSON.stringify([state.threadId, queries, state.compactedMessageCount,
    state.constraints, state.contextIntentLedger,
    state.taskGraph?.tasks.map((task) => [task.id, task.status]),
    state.changes.slice(-12).map((entry) => [entry.path, entry.afterHash, entry.status])]));
}

export interface MemorySelection {
  readonly memories: readonly Readonly<LongTermMemory>[];
  readonly evidence: readonly Readonly<ContextSearchHit>[];
  readonly estimatedTokens: number;
  readonly dropped: { duplicate: number; stale: number; budget: number };
}

/** One shared, bounded allowance for OPTIONAL memory. It never evicts current
 * reasoning, user requirements or unresolved Runtime state. Counts are estimates. */
export function selectMemoryContext(input: {
  state: Readonly<SessionState>;
  memories: readonly Readonly<LongTermMemory>[];
  evidence: readonly Readonly<ContextSearchHit>[];
  tokenBudget: number;
  queries?: readonly string[];
  presentText?: readonly string[];
  limits?: Readonly<RuntimeLimits>;
}): MemorySelection {
  const memories: Readonly<LongTermMemory>[] = [];
  const evidence: Readonly<ContextSearchHit>[] = [];
  const dropped = { duplicate: 0, stale: 0, budget: 0 };
  const seen = new Set<string>();
  const limits = input.limits ?? DEFAULT_RUNTIME_LIMITS;
  const terms = relevantTerms((input.queries ?? []).join(" "));
  const present = input.presentText ?? [];
  let estimatedTokens = 0;
  const take = (key: string, content: string): boolean => {
    if (seen.has(key)) { dropped.duplicate += 1; return false; }
    seen.add(key);
    const cost = estimateTextTokens(content) + 32;
    if (memories.length + evidence.length >= limits.memoryMaxItems || estimatedTokens + cost > input.tokenBudget) { dropped.budget += 1; return false; }
    estimatedTokens += cost;
    return true;
  };
  const ranges = new Map<string, Array<[number, number]>>();
  // Compare reciprocal ranks, not unrelated vector/confidence score scales.
  // A shared lexical signal favors evidence about the actual current target.
  const candidates = [
    ...input.memories.map((memory, rank) => ({ memory, hit: undefined, rank, content: memory.content })),
    ...input.evidence.map((hit, rank) => ({ memory: undefined, hit, rank, content: hit.content })),
  ].map((candidate) => ({ ...candidate, relevance: terms.filter((term) => candidate.content.toLowerCase().includes(term)).length }))
    .sort((a, b) => (b.relevance + 1 / (60 + b.rank + 1)) - (a.relevance + 1 / (60 + a.rank + 1)) ||
      (a.memory?.id ?? a.hit!.id).localeCompare(b.memory?.id ?? b.hit!.id));
  for (const candidate of candidates) {
    const { memory, hit } = candidate;
    if (memory && (memory.status !== "active" || isTransientMemory(memory.content))) { dropped.stale += 1; continue; }
    // Exact evidence is deduplicated; near-matches/negations/version changes are not merged.
    if (input.queries && candidate.relevance < limits.memoryMinRelevantTerms) { dropped.budget += 1; continue; }
    if (!hit?.metadata?.fileHash && candidate.content.length >= 16 && present.some((text) => text.includes(candidate.content))) {
      dropped.duplicate += 1; continue;
    }
    if (memory) {
      if (take(`text:${sha256(memory.content)}`, JSON.stringify({ id: memory.id, category: memory.category,
        content: memory.content, status: memory.status }))) memories.push(memory);
      continue;
    }
    if (!hit) continue;
    const meta = hit.metadata;
    if (meta?.filePath && meta.fileHash) {
      const latestChange = [...input.state.changes].reverse().find((change) => change.path === meta.filePath);
      const currentHash = latestChange?.afterHash ?? input.state.filesRead.get(meta.filePath)?.hash;
      if (latestChange?.operation === "delete" || latestChange?.operation === "deleted_by_command" || (currentHash && currentHash !== meta.fileHash)) {
        dropped.stale += 1;
        continue;
      }
    }
    const rangeKey = `${hit.messageIndex}:${meta?.filePath ?? ""}:${meta?.fileHash ?? ""}`;
    const covered = ranges.get(rangeKey) ?? [];
    if (meta && covered.some(([start, end]) => start <= meta.startOffset && end >= meta.endOffset)) {
      dropped.duplicate += 1;
      continue;
    }
    // Versioned file excerpts only deduplicate within their version; generic
    // prose can deduplicate across the memory/evidence sources by exact text.
    const key = meta?.fileHash ? `file:${meta.filePath}:${meta.fileHash}:${hit.contentHash}` : `text:${sha256(hit.content)}`;
    if (take(key, JSON.stringify(hit))) {
      evidence.push(hit);
      if (meta) { covered.push([meta.startOffset, meta.endOffset]); ranges.set(rangeKey, covered); }
    }
  }
  return { memories, evidence, estimatedTokens, dropped };
}

export function optionalMemoryTokenBudget(maxContextChars: number, maxContextTokens?: number,
  limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS, expanded = false): number {
  // This is an optional-data allowance, NOT a conversion of chars to a model window.
  const maximum = expanded ? limits.memoryRecallTokens : limits.memoryAutoTokens;
  return Math.max(0, Math.min(maximum, Math.floor(maxContextChars / 24),
    !maxContextTokens ? maximum : Math.floor(maxContextTokens * 0.08)));
}

function relevantTerms(text: string): string[] {
  const stop = new Set(["the", "and", "this", "that", "with", "from", "please", "code", "task", "inspect", "file", "fix", "修改", "代码", "一下", "任务"]);
  const words = text.toLowerCase().match(/[a-z0-9_./-]{2,}|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(words.flatMap((word) => /\p{Script=Han}/u.test(word)
    ? Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2)) : [word]))]
    .filter((word) => !stop.has(word)).slice(0, 64);
}

/** Bounded expansion after an observed failure, not after neutral status polls. */
export function expandedMemoryRecall(state: Readonly<SessionState>): boolean {
  return unresolvedCommands(state).length > 0;
}

/** Only text actually present in this request, never old journal/RAG or hidden thinking. */
export function visibleMemoryText(messages: readonly ChatMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role === "user") return [message.content];
    if (message.role !== "tool") return [];
    try {
      const payload = JSON.parse(message.content);
      return typeof payload?.data?.content === "string" ? [payload.data.content] : [];
    } catch { return []; }
  });
}
