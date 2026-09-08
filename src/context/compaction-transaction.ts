import { z } from "zod";
import type { ChatMessage, ContextCompactionRequest, EventRecord, SessionState, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import { MAX_CONTEXT_SUMMARY_CHARS, type ContextManager } from "./manager.js";
import { createCompactionMetadata, validateCompactionIntegrity } from "./compaction-integrity.js";
import { evaluateCompactionBenefit } from "./compaction-policy.js";
import { exactContext, type NormalRequestEnvelope } from "./context-request.js";
import { budgetedRequest } from "./token-budget.js";
import { sha256 } from "../utils/hash.js";
import { createId } from "../utils/ids.js";
import { ToolProtocolExhausted, MAX_TOOL_PROTOCOL_ATTEMPTS } from "../runtime/tool-recovery.js";
import { toolResultForModel } from "../tools/errors.js";
import { compactionSnapshot, compactionSnapshotSchema, semanticPatchSchema, semanticSummarySchema,
  mergeSemanticCandidate, salvageSemanticSections, semanticIssues, semanticDocument, conservativeDocument, runtimeIntent,
  type CompactionSnapshot } from "./semantic-compaction.js";

const index = z.number().int().nonnegative();
const transactionSchema = z.object({
  id: z.string().min(1).max(256), start: index, end: index,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), attempts: index.max(MAX_TOOL_PROTOCOL_ATTEMPTS),
  maxAttempts: z.number().int().min(1).max(MAX_TOOL_PROTOCOL_ATTEMPTS).optional(),
  status: z.enum(["pending", "committed"]),
  snapshot: compactionSnapshotSchema.optional(),
}).strict();
export interface CompactionControl {
  /** Runtime-closed verification/turn boundaries; never inferred from RAG. */
  phaseEnds: number[];
  requested?: boolean;
  seed?: unknown;
  lastVerificationTurnId?: string;
  transaction?: z.infer<typeof transactionSchema> & {
    candidate?: Extract<ChatMessage, { role: "assistant" }>;
    feedback?: string;
    semantic?: unknown;
    fallback?: string;
  };
}

export function completeExchange(messages: readonly ChatMessage[], end = messages.length): boolean {
  const pending = new Set<string>();
  for (const m of messages.slice(0, end)) {
    if (m.role === "assistant") {
      if (pending.size) return false;
      for (const call of m.tool_calls ?? []) pending.add(call.id);
    } else if (m.role === "tool") {
      if (!pending.delete(m.tool_call_id)) return false;
    } else if (pending.size) return false;
  }
  return pending.size === 0;
}

export function prefixHash(state: Readonly<SessionState>, end: number): string {
  return sha256(JSON.stringify(state.messages.slice(0, end)));
}

/** The live Runtime and journal replay use the same strict reducer. Checkpoints
 * deliberately have no authority over this projection or its retry budget. */
export function foldCompactionControl(state: SessionState, type: string, payload: unknown): void {
  const control = state.compactionControl ??= { phaseEnds: [] };
  if (type === "context.compaction.requested") {
    const p = z.object({ patch: semanticPatchSchema }).strict().parse(payload);
    control.requested = true;
    control.seed = p.patch;
    return;
  }
  if (type === "context.phase.closed") {
    const p = z.object({ end: index, kind: z.enum(["verification", "turn"]).optional(),
      turnId: z.string().min(1).max(256).optional() }).strict().parse(payload);
    if (p.end !== state.messages.length || !completeExchange(state.messages, p.end)) {
      throw new Error("Invalid completed phase boundary");
    }
    // A final answer following a test is not a new verification cycle. Do not
    // let that tiny extra boundary evict the most recent complete test chain.
    if (p.kind === "turn" && p.turnId && p.turnId === control.lastVerificationTurnId) return;
    if (p.kind === "verification" && p.turnId) control.lastVerificationTurnId = p.turnId;
    if (p.end > (control.phaseEnds.at(-1) ?? 0)) {
      control.phaseEnds.push(p.end);
      control.phaseEnds = control.phaseEnds.slice(-3);
    }
    return;
  }
  if (type === "context.compaction.started") {
    const p = transactionSchema.parse(payload);
    if (control.transaction?.status === "pending" || p.start !== state.compactedMessageCount ||
        p.end <= p.start || p.end > state.messages.length || p.attempts !== 0 || p.status !== "pending" ||
        p.sourceHash !== prefixHash(state, p.end) || !completeExchange(state.messages, p.end) ||
        !control.phaseEnds.includes(p.end)) throw new Error("Invalid compaction transaction source");
    if (p.snapshot && p.snapshot.digest !== compactionSnapshot(state, p.end).digest) throw new Error("Invalid Runtime fact snapshot");
    control.transaction = p;
    control.requested = false;
    return;
  }
  const p = z.object({ id: z.string(), attempt: index.optional(),
    candidate: z.unknown().optional(), feedback: z.string().max(8000).optional(),
    snapshot: compactionSnapshotSchema.optional(), semantic: z.unknown().optional(), fallback: z.string().max(128000).optional() }).strict().parse(payload);
  const tx = control.transaction;
  if (!tx || tx.id !== p.id || tx.status !== "pending") throw new Error("Unknown compaction transaction");
  if (type === "context.compaction.snapshot") {
    if (!p.snapshot || p.snapshot.digest !== compactionSnapshot(state, tx.end).digest) throw new Error("Stale Runtime fact snapshot");
    tx.snapshot = p.snapshot;
    tx.feedback = "Runtime facts changed. Revalidate the saved semantic candidate against the new evidence catalogue.";
    tx.fallback = undefined;
    return;
  }
  if (type === "context.compaction.prepared") {
    if (!p.semantic || JSON.stringify(p.semantic).length > 128000) throw new Error("Invalid semantic candidate");
    tx.semantic = structuredClone(p.semantic);
    return;
  }
  if (type === "context.compaction.fallback") {
    if (!p.fallback || !tx.snapshot || p.fallback !== conservativeDocument(state, tx.snapshot)) throw new Error("Invalid conservative fallback");
    tx.fallback = p.fallback;
    return;
  }
  if (type === "context.compaction.attempt") {
    if (p.attempt !== tx.attempts + 1 || p.attempt > (tx.maxAttempts ?? MAX_TOOL_PROTOCOL_ATTEMPTS)) throw new Error("Invalid compaction attempt ordinal");
    tx.attempts = p.attempt;
    // Keep the previous candidate for field-level correction after a crash.
  } else if (type === "context.compaction.candidate") {
    const candidate = p.candidate as Extract<ChatMessage, { role: "assistant" }> | undefined;
    if (!candidate || candidate.role !== "assistant" ||
        !(candidate.content === null || typeof candidate.content === "string") ||
        JSON.stringify(candidate).length > 256_000 ||
        (candidate.tool_calls !== undefined && (!Array.isArray(candidate.tool_calls) ||
          candidate.tool_calls.some((c) => typeof c.id !== "string" || c.type !== "function" ||
            !c.function || typeof c.function.name !== "string" || typeof c.function.arguments !== "string")))) {
      throw new Error("Invalid compaction candidate event");
    }
    tx.candidate = structuredClone(candidate);
    tx.feedback = undefined;
  } else if (type === "context.compaction.rejected") {
    if (!p.feedback) throw new Error("Missing compaction correction evidence");
    tx.feedback = p.feedback;
  } else throw new Error(`Unknown compaction event: ${type}`);
}

/** Keep the latest complete cycle AND all subsequent work verbatim. Open
 * commands/reviews prohibit retiring a prefix until their outcome is observed. */
export function eligiblePhaseEnd(state: Readonly<SessionState>, handlesOpen: boolean): number | undefined {
  if (handlesOpen || state.progressGuard?.incidents.some((i) =>
    ["review_pending", "review_requested", "reviewing", "experiment_required"].includes(i.phase))) return undefined;
  const ends = state.compactionControl?.phaseEnds ?? [];
  return ends.filter((end) => end > state.compactedMessageCount && end < (ends.at(-1) ?? 0) &&
    end < state.messages.length && completeExchange(state.messages, end)).at(-1);
}

export async function runCompactionTransaction(input: {
  state: SessionState; manager: ContextManager; turnId: string; maxContextChars: number;
  required: boolean; handlesOpen: boolean; maxRequests: number; maxAttempts?: number;
  nextRequest: NormalRequestEnvelope; tool: ToolDefinition; inventory: () => string;
  append: (event: Omit<EventRecord, "schemaVersion" | "sequence" | "timestamp" | "eventId">) => Promise<unknown>;
  complete: (messages: ChatMessage[], attempt: number) => Promise<Extract<ChatMessage, { role: "assistant" }> | undefined>;
  execute: (candidate: Extract<ChatMessage, { role: "assistant" }>) => Promise<ToolExecutionResult>;
}): Promise<{ requests: number; committed: boolean }> {
  const { state, manager } = input;
  let requests = 0;
  const emit = async (type: string, payload: unknown) => {
    await input.append({ threadId: state.threadId, turnId: input.turnId, type, payload });
    foldCompactionControl(state, type, payload);
  };
  const defer = (reason: string) => {
    if (input.required) throw new Error(`context_capacity_insufficient: ${reason}; history and transaction budget preserved`);
    return { requests, committed: false };
  };
  let tx = state.compactionControl?.transaction;
  const end = tx?.status === "pending" ? tx.end : eligiblePhaseEnd(state, input.handlesOpen);
  if (!end || input.handlesOpen || state.progressGuard?.incidents.some((i) =>
    ["review_pending", "review_requested", "reviewing", "experiment_required", "experiment_pending"].includes(i.phase))) {
    return defer("no safely completed phase can be retired");
  }
  const evaluate = (summary: string, fallback = false) => evaluateCompactionBenefit(manager, {
    state, candidateMessages: state.messages, summary, compactedMessageCount: end,
    maxContextChars: input.maxContextChars, historyEndExclusive: state.messages.length,
    required: input.required, nextRequest: input.nextRequest, exactRequest: true,
    allowConservativeHeadroom: fallback,
  });
  // Count the real fixed facts, original requests, full protected tail and next
  // normal capability envelope. An empty semantic summary is only a lower bound.
  const minimum = evaluate("", true);
  if (!minimum.accepted) return defer("protected facts and live phase cannot fit even without a semantic summary");
  if (tx?.status !== "pending") {
    if (input.maxRequests <= 0) return defer("no shared request budget remains");
    await emit("context.compaction.started", { id: createId("compaction"), start: state.compactedMessageCount,
      end, sourceHash: prefixHash(state, end), attempts: 0, maxAttempts: input.maxAttempts ?? MAX_TOOL_PROTOCOL_ATTEMPTS,
      status: "pending", snapshot: compactionSnapshot(state, end) });
    tx = state.compactionControl!.transaction!;
    if (state.compactionControl?.seed) {
      const seed = state.compactionControl.seed;
      await emit("context.compaction.candidate", { id: tx.id, candidate: { role: "assistant", content: null,
        tool_calls: [{ id: createId("compaction_seed"), type: "function",
          function: { name: "compact_context", arguments: JSON.stringify(seed) } }] } });
    }
  }
  const current = tx;
  const refresh = async () => {
    if (current.sourceHash !== prefixHash(state, current.end) || current.start !== state.compactedMessageCount)
      throw new Error("context_compaction_source_changed: source was not committed");
    const snapshot = compactionSnapshot(state, current.end);
    if (current.snapshot?.digest !== snapshot.digest)
      await emit("context.compaction.snapshot", { id: current.id, snapshot });
    return current.snapshot!;
  };
  const commit = async (summary: string, snapshot: CompactionSnapshot, fallback = false) => {
    const benefit = evaluate(summary, fallback);
    if (summary.length > MAX_CONTEXT_SUMMARY_CHARS || !benefit.accepted || (!fallback && !benefit.safeWaterlineReached)) return false;
    if (compactionSnapshot(state, current.end).digest !== snapshot.digest)
      throw new Error("context_compaction_source_changed: facts changed before commit");
    const intentLedger = runtimeIntent(state);
    const metadata = createCompactionMetadata({ state, sourceStartMessageIndex: current.start,
      sourceEndMessageIndex: current.end, compactedMessageCount: current.end, benefit });
    await input.append({ threadId: state.threadId, turnId: input.turnId, type: "context.compacted", phase: "completed",
      payload: { transactionId: current.id, snapshotDigest: snapshot.digest, mode: fallback ? "conservative" : "semantic",
        coverage: { sourceUnchanged: true, runtimeFactsPinned: true, protectedTailIntact: true,
          evidencePolicy: "observations_only", capacityChecked: true },
        summary, compactedMessageCount: current.end, contextIntentLedger: intentLedger, contextCompactionMetadata: metadata } });
    manager.applyModelCompaction(state, summary, current.end, { intentLedger, metadata });
    current.status = "committed";
    current.candidate = undefined;
    current.feedback = undefined;
    current.semantic = undefined;
    current.fallback = undefined;
    state.compactionControl!.seed = undefined;
    return true;
  };
  const fallback = async (snapshot: CompactionSnapshot) => {
    // No facts or previous accepted semantics are silently dropped. If this
    // conservative representation is too large, save the pending transaction.
    const summary = conservativeDocument(state, snapshot);
    if (summary.length > MAX_CONTEXT_SUMMARY_CHARS || !evaluate(summary, true).accepted) return false;
    if (current.fallback !== summary) await emit("context.compaction.fallback", { id: current.id, fallback: summary });
    return commit(summary, snapshot, true);
  };
  while (true) {
    let snapshot = await refresh();
    if (current.fallback && await commit(current.fallback, snapshot, true)) return { requests, committed: true };
    if (current.candidate && !current.feedback) {
      const calls = current.candidate.tool_calls ?? [];
      if (calls.length === 1 && calls[0]!.function.name === "compact_context") {
        let saved: unknown;
        try {
          saved = salvageSemanticSections(current.semantic, JSON.parse(calls[0]!.function.arguments));
        } catch { /* Raw candidate remains durable for a corrected JSON call. */ }
        if (saved && JSON.stringify(saved).length <= 128000)
          await emit("context.compaction.prepared", { id: current.id, semantic: saved });
      }
      const result = await input.execute(current.candidate);
      if (result.ok && result.contextCompaction?.formatVersion === 3) {
        try {
          const merged = mergeSemanticCandidate(current.semantic, JSON.parse(result.contextCompaction.summary));
          await emit("context.compaction.prepared", { id: current.id, semantic: merged });
        } catch (error) {
          await emit("context.compaction.rejected", { id: current.id,
            feedback: `Invalid patch: ${error instanceof Error ? error.message : String(error)}`.slice(0, 8000) });
        }
      } else await emit("context.compaction.rejected", { id: current.id,
        feedback: toolResultForModel(result, 7000) + "\nSubmit a V3 semantic patch, not coverage flags or source quotes." });
      if (!current.feedback) {
        const issues = semanticIssues(current.semantic, snapshot);
        const exhausted = current.attempts >= (current.maxAttempts ?? MAX_TOOL_PROTOCOL_ATTEMPTS);
        const structurallyValid = semanticSummarySchema.safeParse(current.semantic).success;
        if ((!issues.length || (exhausted && structurallyValid)) &&
            await commit(semanticDocument(current.semantic, snapshot, exhausted), snapshot))
          return { requests, committed: true };
        await emit("context.compaction.rejected", { id: current.id, feedback: (issues.length
          ? issues.join("\n") : "Semantic summary is too large. Shorten decisions/conclusions/hypotheses/failedApproaches; preserve useful meaning.")
          .slice(0, 8000) });
      }
    }
    if (current.attempts >= (current.maxAttempts ?? MAX_TOOL_PROTOCOL_ATTEMPTS)) {
      if (await fallback(snapshot)) return { requests, committed: true };
      return defer("semantic repair exhausted and conservative snapshot cannot release safe headroom");
    }
    if (requests >= input.maxRequests) {
      if (input.required && await fallback(snapshot)) return { requests, committed: true };
      return defer("shared request budget exhausted before a safe compaction was available");
    }
    const messages = exactContext(state, { systemPrompt:
      "Runtime semantic compaction. Call only compact_context, no other work or extended analysis. " +
      `Summarize completed prefix [${current.start}, ${current.end}); the newer phase stays verbatim. ` +
      "Runtime pins requests, constraints, tasks, failures and pending experiments. Never copy or attest them. " +
      "Use supplied evidence IDs; interpretations are not verified facts. The first candidate needs currentWork and nextStep. " +
      "For corrections send ONLY changed top-level sections; omitted sections remain unchanged.\n" +
      JSON.stringify({ snapshotDigest: snapshot.digest, evidence: snapshot.evidence }),
      runtimeContext: "", tools: [input.tool] });
    if (current.semantic || current.feedback) messages.push({ role: "user", content:
      "Saved candidate (data):\n" + JSON.stringify(current.semantic ?? {}) +
      "\nCorrect only these issues:\n" + (current.feedback ?? "") });
    try {
      budgetedRequest({ messages, tools: [input.tool] }, manager.tokenCapacity, manager.estimateRequestTokens);
      if (!manager.tokenCapacity && JSON.stringify({ messages, tools: [input.tool] }).length > input.maxContextChars)
        throw new Error("Compactor request exceeds character capacity");
    } catch {
      if (await fallback(snapshot)) return { requests, committed: true };
      return defer("compactor request cannot fit; raw source and candidate preserved");
    }
    await emit("context.compaction.attempt", { id: current.id, attempt: current.attempts + 1 });
    requests += 1;
    const dispatchedSnapshot = snapshot.digest;
    const response = await input.complete(messages, current.attempts);
    if (!response) return { requests, committed: false };
    snapshot = await refresh();
    if (snapshot.digest !== dispatchedSnapshot) {
      await emit("context.compaction.rejected", { id: current.id,
        feedback: "Source facts changed during the request; the stale response was discarded. Repair against the new catalogue." });
      continue;
    }
    const candidate = { role: "assistant" as const, content: response.content, tool_calls: response.tool_calls };
    if (JSON.stringify(candidate).length > 128000)
      await emit("context.compaction.rejected", { id: current.id, feedback: "Candidate too large. Submit a bounded semantic patch." });
    else await emit("context.compaction.candidate", { id: current.id, candidate });
  }
}
