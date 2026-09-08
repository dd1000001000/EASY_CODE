import { z } from "zod";
import type { ChatMessage, ContextCompactionRequest, EventRecord, SessionState, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import type { ContextManager } from "./manager.js";
import { createCompactionMetadata, validateCompactionIntegrity } from "./compaction-integrity.js";
import { evaluateCompactionBenefit } from "./compaction-policy.js";
import { exactContext, type NormalRequestEnvelope } from "./context-request.js";
import { budgetedRequest } from "./token-budget.js";
import { sha256 } from "../utils/hash.js";
import { createId } from "../utils/ids.js";
import { ToolProtocolExhausted, MAX_TOOL_PROTOCOL_ATTEMPTS } from "../runtime/tool-recovery.js";
import { protocolToolFailure, toolResultForModel } from "../tools/errors.js";

const index = z.number().int().nonnegative();
const transactionSchema = z.object({
  id: z.string().min(1).max(256), start: index, end: index,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), attempts: index.max(MAX_TOOL_PROTOCOL_ATTEMPTS),
  maxAttempts: z.number().int().min(1).max(MAX_TOOL_PROTOCOL_ATTEMPTS).optional(),
  status: z.enum(["pending", "committed"]),
}).strict();
export interface CompactionControl {
  /** Runtime-closed verification/turn boundaries; never inferred from RAG. */
  phaseEnds: number[];
  lastVerificationTurnId?: string;
  transaction?: z.infer<typeof transactionSchema> & {
    candidate?: Extract<ChatMessage, { role: "assistant" }>;
    feedback?: string;
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
    control.transaction = p;
    return;
  }
  const p = z.object({ id: z.string(), attempt: index.optional(),
    candidate: z.unknown().optional(), feedback: z.string().max(8000).optional() }).strict().parse(payload);
  const tx = control.transaction;
  if (!tx || tx.id !== p.id || tx.status !== "pending") throw new Error("Unknown compaction transaction");
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
  required: boolean; handlesOpen: boolean; maxRequests: number;
  maxAttempts?: number;
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
  let tx = state.compactionControl?.transaction;
  const end = tx?.status === "pending" ? tx.end : eligiblePhaseEnd(state, input.handlesOpen);
  const defer = (reason: string): { requests: number; committed: boolean } => {
    if (input.required) throw new Error(`context_capacity_insufficient: ${reason}; history and compaction budget preserved`);
    return { requests, committed: false };
  };
  if (!end || input.handlesOpen || state.progressGuard?.incidents.some((i) =>
    ["review_pending", "review_requested", "reviewing", "experiment_required"].includes(i.phase))) {
    return defer("no safely completed phase can be retired");
  }
  // A zero-length summary is a lower bound, not a candidate to commit. Detect
  // impossible targets before paying for three futile smaller summaries.
  const lower = { ...state, workingSummary: "", compactedMessageCount: end };
  const minimum = evaluateCompactionBenefit(manager, { state, candidateMessages: state.messages,
    summary: "", compactedMessageCount: end, maxContextChars: input.maxContextChars,
    historyEndExclusive: state.messages.length, required: true, nextRequest: input.nextRequest, exactRequest: true });
  if (!minimum.accepted || !minimum.safeWaterlineReached) return defer("protected tail and normal tool envelope cannot reach 55% headroom");
  if (manager.tokenCapacity && manager.estimateRequestTokens(exactContext(lower, input.nextRequest), input.nextRequest.tools) >
      manager.tokenCapacity.inputCapacity * 0.55) return defer("protected token lower bound exceeds target");
  if (tx?.status !== "pending") {
    if (input.maxRequests <= 0) return { requests, committed: false };
    await emit("context.compaction.started", { id: createId("compaction"), start: state.compactedMessageCount,
      end, sourceHash: prefixHash(state, end), attempts: 0,
      maxAttempts: input.maxAttempts ?? MAX_TOOL_PROTOCOL_ATTEMPTS, status: "pending" });
    tx = state.compactionControl!.transaction!;
  }
  if (tx.sourceHash !== prefixHash(state, tx.end) || tx.start !== state.compactedMessageCount) {
    throw new Error("context_compaction_source_changed: transaction was not committed");
  }
  while (true) {
    // A durable candidate is revalidated after a crash without repeating a
    // model request. Rejected candidates remain available for schema repair.
    if (tx.candidate && !tx.feedback) {
      let result = await input.execute(tx.candidate);
      const proposal: ContextCompactionRequest | undefined = result.contextCompaction;
      if (result.ok && proposal) {
        const integrity = validateCompactionIntegrity({ state, request: proposal, sourceEndMessageIndex: state.messages.length });
        const benefit = evaluateCompactionBenefit(manager, { state, candidateMessages: state.messages,
          summary: proposal.summary, compactedMessageCount: tx.end, maxContextChars: input.maxContextChars,
          historyEndExclusive: state.messages.length, required: input.required, nextRequest: input.nextRequest,
          exactRequest: true, candidateIntentLedger: integrity.intentLedger });
        if (integrity.ok && benefit.accepted && benefit.safeWaterlineReached) {
          if (tx.sourceHash !== prefixHash(state, tx.end) || tx.start !== state.compactedMessageCount) {
            throw new Error("context_compaction_source_changed: candidate was not committed");
          }
          const metadata = createCompactionMetadata({ state, sourceStartMessageIndex: tx.start,
            sourceEndMessageIndex: tx.end, compactedMessageCount: tx.end, benefit });
          // One journal fact commits boundary + summary + intent + transaction
          // identity. Nothing mutates canonical messages or their raw thinking.
          await input.append({ threadId: state.threadId, turnId: input.turnId, type: "context.compacted", phase: "completed",
            payload: { transactionId: tx.id, summary: proposal.summary, compactedMessageCount: tx.end,
              contextIntentLedger: integrity.intentLedger, contextCompactionMetadata: metadata } });
          manager.applyModelCompaction(state, proposal.summary, tx.end, { intentLedger: integrity.intentLedger!, metadata });
          tx.status = "committed";
          tx.candidate = undefined;
          tx.feedback = undefined;
          return { requests, committed: true };
        }
        result = { ok: false, summary: "Compaction candidate was not committed.",
          failure: protocolToolFailure("context_compaction_rejected", integrity.ok
            ? `Reduce the cumulative summary; ${benefit.rejectionReason ?? "55% target not reached"}. Preserve all required evidence.`
            : `Repair these evidence/coverage fields: ${integrity.errors.join(", ")}. Never invent coverage flags.`) };
      }
      await emit("context.compaction.rejected", { id: tx.id, feedback: toolResultForModel(result, 8000) });
    }
    if (tx.attempts >= (tx.maxAttempts ?? MAX_TOOL_PROTOCOL_ATTEMPTS)) throw new ToolProtocolExhausted("compact_context", tx.attempts, requests, true);
    if (requests >= input.maxRequests) return { requests, committed: false };
    const system = "Runtime control-plane compaction transaction. Call only compact_context; no other work. " +
      `Retire the completed prefix [${tx.start}, ${tx.end}) into a cumulative summary. ` +
      "The newer tail remains verbatim. Keep current user intent and constraints globally, distinguish verified evidence " +
      "from unverified hypotheses, and preserve the next experiment. Do not rewrite the retained thinking chain.\n" + input.inventory();
    const messages = exactContext(state, { systemPrompt: system, runtimeContext: "", tools: [input.tool] });
    // The candidate is data, not executable conversation history. A compact
    // correction packet avoids accumulating failed control-plane transcripts.
    if (tx.candidate) messages.push({ role: "user", content: "Previous candidate (data):\n" +
      JSON.stringify(tx.candidate.tool_calls ?? tx.candidate.content) + "\nRuntime validation:\n" + tx.feedback });
    budgetedRequest({ messages, tools: [input.tool] }, manager.tokenCapacity, manager.estimateRequestTokens);
    await emit("context.compaction.attempt", { id: tx.id, attempt: tx.attempts + 1 });
    requests += 1;
    const response = await input.complete(messages, tx.attempts);
    if (!response) return { requests, committed: false };
    // Compactor reasoning is not part of the work chain and is not required to
    // execute a correction; persist the full bounded candidate, never a slice.
    const candidate = { role: "assistant" as const, content: response.content, tool_calls: response.tool_calls };
    if (JSON.stringify(candidate).length > 256_000) {
      await emit("context.compaction.rejected", { id: tx.id, feedback: "Candidate exceeded 256000 characters; submit a bounded structured summary." });
    } else await emit("context.compaction.candidate", { id: tx.id, candidate });
  }
}
