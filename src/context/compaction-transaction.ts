import { z } from "zod";
import type { ChatMessage, EventRecord, SessionState, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import { MAX_CONTEXT_SUMMARY_CHARS, type ContextManager } from "./manager.js";
import { createCompactionMetadata } from "./compaction-integrity.js";
import { evaluateCompactionBenefit } from "./compaction-policy.js";
import { exactContext, type NormalRequestEnvelope } from "./context-request.js";
import { budgetedRequest, estimatedTokens } from "./token-budget.js";
import { sha256 } from "../utils/hash.js";
import { createId } from "../utils/ids.js";
import { MAX_TOOL_PROTOCOL_ATTEMPTS } from "../runtime/tool-recovery.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import { recoverContextPressure, referenceToolOutputs, foldContextMaintenance } from "./pressure-recovery.js";
import { completeExchange, retirementBoundaries } from "./exchange-boundary.js";
export { completeExchange } from "./exchange-boundary.js";
import { assessCapacity, contextHistoryHash, contextRequestKey, type CapacityPause } from "./capacity.js";
import { compactionSnapshot, compactionSnapshotSchema, semanticPatchSchema, semanticSummarySchema,
  inspectSemanticPatch, parseSemanticRequestPatch, parseSemanticCandidatePatch, clipSemanticFields, semanticDocument, conservativeDocument, boundedSummaryDocument, runtimeIntent } from "./semantic-compaction.js";

const index = z.number().int().nonnegative();
const transactionSchema = z.object({
  id: z.string().min(1).max(256), start: index, end: index,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), attempts: index.max(MAX_TOOL_PROTOCOL_ATTEMPTS),
  maxAttempts: z.number().int().min(1).max(MAX_TOOL_PROTOCOL_ATTEMPTS).optional(),
  status: z.enum(["pending", "committed", "superseded"]),
  snapshot: compactionSnapshotSchema.optional(),
}).strict();
export interface CompactionControl {
  /** Runtime-closed verification/turn boundaries; never inferred from RAG. */
  phaseEnds: number[];
  /** Read-only exchange boundaries, NOT verification/task completion. */
  investigationEnds?: number[];
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

export function prefixHash(state: Readonly<SessionState>, end: number): string {
  return sha256(JSON.stringify(state.messages.slice(0, end)));
}

/** Only the built-in source-inspection surface can close an investigation chunk.
 * A mixed read/write batch, missing result or unfinished command is not eligible. */
export function investigationExchangeStart(messages: readonly ChatMessage[], end = messages.length): number | undefined {
  if (end < 2 || end > messages.length || messages[end - 1]?.role !== "tool") return undefined;
  let start = end - 1;
  while (start >= 0 && messages[start]?.role === "tool") start -= 1;
  const assistant = messages[start];
  if (!assistant || assistant.role !== "assistant" || !assistant.tool_calls?.length ||
      !assistant.tool_calls.every((call) => ["read_file", "search_files", "read_image"].includes(call.function.name)) ||
      !completeExchange(messages, end)) return undefined;
  return start;
}

/** The live Runtime and journal replay use the same strict reducer. Checkpoints
 * deliberately have no authority over this projection or its retry budget. */
export function foldCompactionControl(state: SessionState, type: string, payload: unknown): void {
  const control = state.compactionControl ??= { phaseEnds: [] };
  if (type === "context.compaction.requested") {
    const p = z.object({ patch: z.unknown().transform(parseSemanticRequestPatch) }).strict().parse(payload);
    control.requested = true;
    control.seed = p.patch;
    return;
  }
  if (type === "context.phase.closed") {
    const p = z.object({ end: index, kind: z.enum(["verification", "turn", "investigation"]).optional(),
      turnId: z.string().min(1).max(256).optional() }).strict().parse(payload);
    if ((p.kind === "investigation" ? p.end > state.messages.length : p.end !== state.messages.length) ||
        !completeExchange(state.messages, p.end)) {
      throw new Error("Invalid completed phase boundary");
    }
    if (p.kind === "investigation") {
      if (investigationExchangeStart(state.messages, p.end) === undefined)
        throw new Error("Invalid investigation exchange boundary");
      // Resume may discover historical read-only boundaries from raw Journal
      // messages. They are structural cuts, not backdated verification events.
      control.investigationEnds = [...new Set([...(control.investigationEnds ?? []), p.end])]
        .sort((a, b) => a - b).slice(-65);
      return;
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
        p.sourceHash !== prefixHash(state, p.end) || !completeExchange(state.messages, p.end)) throw new Error("Invalid compaction transaction source");
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
    if (!p.semantic) throw new Error("Invalid semantic candidate");
    tx.semantic = structuredClone(p.semantic);
    return;
  }
  if (type === "context.compaction.accepted") {
    if (!tx.semantic || !p.semantic || JSON.stringify(p.semantic) !== JSON.stringify(clipSemanticFields(tx.semantic).patch))
      throw new Error("Invalid deterministic semantic repair");
    semanticSummarySchema.parse(p.semantic);
    tx.semantic = structuredClone(p.semantic);
    tx.feedback = undefined;
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
  } else if (type === "context.compaction.abandoned") {
    tx.status = "superseded";
    control.requested = false;
    control.seed = undefined;
  } else throw new Error(`Unknown compaction event: ${type}`);
}

/** Compatibility name: semantic phases no longer control eligibility. */
export function eligiblePhaseEnd(state: Readonly<SessionState>, _handlesOpen: boolean,
  retainRecentExchanges = DEFAULT_RUNTIME_LIMITS.compactionRetainRecentExchanges): number | undefined {
  return retirementBoundaries(state, retainRecentExchanges)[0];
}

export interface CompactionResult { requests: number; committed: boolean; paused?: CapacityPause }

export async function runCompactionTransaction(input: {
  state: SessionState; manager: ContextManager; turnId: string; maxContextChars: number;
  required: boolean; maxRequests: number; retainRecentExchanges?: number;
  /** Legacy caller hints; recovery is now bounded by request budget and structural exchanges. */
  handlesOpen?: boolean; maxAttempts?: number;
  limits?: Readonly<RuntimeLimits>; signal?: AbortSignal; skipSummary?: boolean; forceRecovery?: boolean;
  nextRequest: NormalRequestEnvelope; tool?: ToolDefinition; inventory?: () => string;
  append: (event: Omit<EventRecord, "schemaVersion" | "sequence" | "timestamp" | "eventId">) => Promise<unknown>;
  complete: (messages: ChatMessage[], attempt: number) => Promise<Extract<ChatMessage, { role: "assistant" }> | undefined>;
  /** Durable steering application must remain outside the auxiliary-provider catch. */
  afterComplete?: () => Promise<void>;
  /** Legacy adapter, never invoked: isolated candidates cannot execute tools. */
  execute?: (candidate: Extract<ChatMessage, { role: "assistant" }>) => Promise<ToolExecutionResult>;
}): Promise<CompactionResult> {
  const { state, manager } = input;
  if (input.signal?.aborted) throw input.signal.reason ?? new Error("Request aborted");
  const limits = input.limits ?? manager.runtimeLimits;
  let requests = 0;
  let committed = false;
  const assess = () => assessCapacity(manager, state, input.maxContextChars, input.nextRequest, limits);
  const requestKey = contextRequestKey(manager, input.maxContextChars, input.nextRequest, limits);
  const emit = async (type: string, payload: unknown) => {
    await input.append({ threadId: state.threadId, turnId: input.turnId, type, payload });
    foldCompactionControl(state, type, payload);
  };
  const finish = async (paused?: CapacityPause): Promise<CompactionResult> => {
    const capacity = assess();
    const payload = { historyHash: contextHistoryHash(state), requestKey, usage: capacity.usage, capacity: capacity.capacity,
      ...(paused ? { paused } : {}) };
    await input.append({ threadId: state.threadId, turnId: input.turnId, type: "context.maintenance.checked",
      phase: "completed", payload });
    foldContextMaintenance(state, payload);
    return { requests, committed, ...(paused ? { paused } : {}) };
  };
  const recover = async (reason: string): Promise<CompactionResult> => {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Request aborted");
    if ((input.forceRecovery || assess().utilization >= limits.contextCompactionTriggerRatio) &&
        await recoverContextPressure({ ...input, reason })) { committed = true; return finish(); }
    // A missed soft target must not interrupt an otherwise safe request.
    if (assess().fits && !input.forceRecovery) {
      const pending = state.compactionControl?.transaction;
      if (pending?.status === "pending") await emit("context.compaction.abandoned", { id: pending.id });
      return finish();
    }
    const capacity = assess();
    return finish({ code: "context_capacity_exhausted", reason: reason.slice(0, 2000),
      usage: capacity.usage, capacity: capacity.capacity, unit: capacity.unit });
  };
  if (!completeExchange(state.messages)) {
    const capacity = assess();
    return finish({ code: "context_capacity_exhausted", reason: "A tool call has no matching result; wait for its result before rebuilding context.",
      usage: capacity.usage, capacity: capacity.capacity, unit: capacity.unit });
  }
  const previous = state.pressureRecovery?.maintenance;
  if (!input.skipSummary && previous?.historyHash === contextHistoryHash(state) &&
      !state.compactionControl?.requested && state.compactionControl?.transaction?.status !== "pending") {
    if (assess().fits) return { requests, committed };
    if (previous.paused && previous.requestKey === requestKey) return { requests, committed, paused: previous.paused };
    return recover("The same history no longer fits the current request envelope; recover without resummarizing it.");
  }
  const underPressure = assess().utilization >= limits.contextCompactionTriggerRatio;
  committed = await referenceToolOutputs({ ...input, reason: "Bounded tool-output projection before summarization" }, underPressure);
  let tx = state.compactionControl?.transaction;
  const requested = state.compactionControl?.requested || tx?.status === "pending";
  const capacity = assess();
  // Growth-based hysteresis, not response counts: a missed soft target must not
  // cause another paid summary after one tiny read. Hard overflow bypasses it.
  if (!input.forceRecovery && !requested && capacity.fits && previous?.usage !== undefined &&
      previous.capacity === capacity.capacity && capacity.usage - previous.usage < capacity.capacity * limits.contextCompactionMinGrowthRatio)
    return committed ? finish() : { requests, committed };
  if (!input.forceRecovery && !requested && !input.required && assess().utilization < limits.contextCompactionTriggerRatio)
    return committed ? finish() : { requests, committed };
  if (committed && assess().targetReached && !requested) return finish();
  if (input.skipSummary) return recover("Summary bypassed after capacity rejection; deterministic recovery required.");

  // Pick a boundary BEFORE asking the model. An impossible empty-summary lower
  // bound advances locally; no model request is spent chasing an impossible target.
  const boundaries = tx?.status === "pending" ? [tx.end] :
    retirementBoundaries(state, input.retainRecentExchanges ?? limits.compactionRetainRecentExchanges);
  const end = boundaries.find((end) => assessCapacity(manager, {
    ...state, compactedMessageCount: end, workingSummary: "", contextIntentLedger: runtimeIntent(state),
  }, input.maxContextChars, input.nextRequest, limits).fits);
  if (!end) return recover("No retained complete-exchange tail fits the input budget.");
  if (tx?.status !== "pending") {
    if (!state.compactionControl?.seed && (input.maxRequests <= 0 || !input.tool)) return recover("No summary request budget or summary tool is available.");
    await emit("context.compaction.started", { id: createId("compaction"), start: state.compactedMessageCount,
      end, sourceHash: prefixHash(state, end), attempts: 0, maxAttempts: Math.min(2, limits.compactionAttempts, input.maxAttempts ?? 2),
      status: "pending", snapshot: compactionSnapshot(state, end) });
    tx = state.compactionControl!.transaction!;
    if (state.compactionControl?.seed) {
      // The parent already paid for this submission. It consumes attempt one,
      // but is not charged again against this invocation's provider budget.
      await emit("context.compaction.attempt", { id: tx.id, attempt: 1 });
      await emit("context.compaction.candidate", { id: tx.id,
      candidate: { role: "assistant", content: null, tool_calls: [{ id: createId("compaction_seed"), type: "function",
        function: { name: "compact_context", arguments: JSON.stringify(state.compactionControl.seed) } }] } });
    }
  }
  const current = tx;
  if (current.sourceHash !== prefixHash(state, end) || current.start !== state.compactedMessageCount)
    return recover("Compaction source changed; stale summary was discarded.");
  let snapshot = compactionSnapshot(state, end);
  if (current.snapshot?.digest !== snapshot.digest)
    await emit("context.compaction.snapshot", { id: current.id, snapshot });

  let summary: string | undefined;
  const clippingDiagnostics: string[] = [];
  // Includes restored length-only failures: repair locally, never spend a correction request.
  if (!current.candidate && current.attempts === 0 && requests < input.maxRequests && input.tool) {
    const messages = exactContext(state, { systemPrompt:
      "Runtime context handoff. Call only compact_context once, with currentWork and nextStep; optional hypotheses/decisions/conclusions. " +
      "Each text field/item must be at most 1200 characters. Keep it brief. No extended analysis, no coverage flags, no self-certification. " +
      `Summarize the closed prefix [${current.start}, ${end}); newer exchanges remain verbatim. ` +
      "An investigation boundary is NOT task completion. Unfinished work and unverified conclusions must stay explicit. " +
      "Runtime pins user requirements, pending commands/children, errors and experiments. " +
      "Evidence IDs are observations, not proof of arbitrary conclusions.\n" + JSON.stringify(snapshot.evidence),
      runtimeContext: "", tools: [input.tool] });
    try {
      budgetedRequest({ messages, tools: [input.tool] }, manager.tokenCapacity, manager.estimateRequestTokens);
      if (!manager.tokenCapacity && manager.inspectProviderRequest({ state, messages, tools: [input.tool],
        maxContextChars: input.maxContextChars }).utilization > 1) throw new Error("request too large");
    } catch {
      return recover("The summary request itself cannot fit.");
    }
    await emit("context.compaction.attempt", { id: current.id, attempt: current.attempts + 1 });
    requests++;
    let response: Extract<ChatMessage, { role: "assistant" }> | undefined;
    try { response = await input.complete(messages, current.attempts); }
    catch (error) {
      if (input.signal?.aborted) throw error;
      // Provider/auth/network failures during an auxiliary summary are NOT code failures.
      // Do not swallow Journal/commit failures: only the actual summary call is caught.
      await emit("context.compaction.rejected", { id: current.id, feedback: "Summary request failed; use deterministic recovery." });
      return recover("Summary request failed; no further summary calls will be made for this transaction.");
    }
    await input.afterComplete?.();
    if (!response) return { requests, committed }; // Steering/cancellation boundary.
    snapshot = compactionSnapshot(state, end);
    if (current.snapshot?.digest !== snapshot.digest) {
      await emit("context.compaction.rejected", { id: current.id, feedback: "Runtime facts changed during summary; response discarded." });
      return recover("Runtime facts changed during summary.");
    }
    const candidate = { role: "assistant" as const, content: response.content, tool_calls: response.tool_calls };
    await emit("context.compaction.candidate", { id: current.id, candidate });
  }
  if (current.candidate) {
    const calls = current.candidate.tool_calls ?? [];
    if (calls.length === 1 && calls[0]!.function.name === "compact_context") {
      let semantic: unknown;
      try {
        const patch = parseSemanticCandidatePatch(JSON.parse(calls[0]!.function.arguments));
        semantic = { ...(current.semantic as object ?? {}), ...(patch as object) };
        // Check missing fields/types too. Length repair must never hide these.
        semanticSummarySchema.parse(clipSemanticFields(semantic).patch);
      } catch (error) {
        await emit("context.compaction.rejected", { id: current.id,
          feedback: `Invalid semantic candidate: ${String(error).slice(0, 7000)}` });
        return recover("Semantic structure is invalid; deterministic recovery used.");
      }
      await emit("context.compaction.prepared", { id: current.id, semantic });
    } else if (calls.length === 0 && current.candidate.content?.trim()) {
      // Auxiliary prose is an unverified handoff, never a substitute executable tool call.
      const prose = current.candidate.content.trim();
      await emit("context.compaction.prepared", { id: current.id,
        semantic: { currentWork: prose, nextStep: "Recover original Journal and validate unfinished work before claiming completion." } });
      summary = boundedSummaryDocument(prose, snapshot, limits.contextSummaryMaxTokens, MAX_CONTEXT_SUMMARY_CHARS, true);
    }
  }
  if (current.semantic) {
    const repaired = clipSemanticFields(current.semantic);
    clippingDiagnostics.push(...repaired.diagnostics);
    // The original candidate remains in Journal. Clipping never certifies claims.
    summary ??= boundedSummaryDocument(semanticDocument(semanticSummarySchema.parse(repaired.patch), snapshot, true, clippingDiagnostics),
      snapshot, limits.contextSummaryMaxTokens, MAX_CONTEXT_SUMMARY_CHARS);
  }
  if (summary && summary.length <= MAX_CONTEXT_SUMMARY_CHARS && estimatedTokens(summary) <= limits.contextSummaryMaxTokens) {
    const intentLedger = runtimeIntent(state);
    const benefit = evaluateCompactionBenefit(manager, { state, candidateMessages: state.messages, summary,
      compactedMessageCount: end, maxContextChars: input.maxContextChars, historyEndExclusive: state.messages.length,
      required: true, nextRequest: input.nextRequest, candidateIntentLedger: intentLedger });
    if (benefit.accepted && assessCapacity(manager, { ...state, workingSummary: summary, compactedMessageCount: end,
      contextIntentLedger: intentLedger }, input.maxContextChars, input.nextRequest, limits).fits) {
      await emit("context.compaction.accepted", { id: current.id, semantic: clipSemanticFields(current.semantic).patch });
      const metadata = createCompactionMetadata({ state, sourceStartMessageIndex: current.start,
        sourceEndMessageIndex: end, compactedMessageCount: end, benefit });
      await input.append({ threadId: state.threadId, turnId: input.turnId, type: "context.compacted", phase: "completed",
        payload: { transactionId: current.id, snapshotDigest: snapshot.digest, mode: "semantic",
          coverage: { sourceUnchanged: true, runtimeFactsPinned: true, protectedTailIntact: true,
            evidencePolicy: "observations_only", capacityChecked: true },
          summary, clippingDiagnostics, compactedMessageCount: end, contextIntentLedger: intentLedger, contextCompactionMetadata: metadata } });
      manager.applyModelCompaction(state, summary, end, { intentLedger, metadata });
      current.status = "committed";
      current.candidate = undefined; current.feedback = undefined; current.semantic = undefined; current.fallback = undefined;
      state.compactionControl!.seed = undefined;
      committed = true;
      return finish();
    }
  }
  if (!current.feedback) await emit("context.compaction.rejected", { id: current.id,
    feedback: summary ? "Semantic candidate exceeds capacity budget; use deterministic recovery." : "empty_or_invalid_non_reasoning_output: No usable compact_context candidate or non-thinking prose was submitted; use deterministic recovery." });
  return recover("Bounded summary submissions did not provide a usable handoff.");
}
