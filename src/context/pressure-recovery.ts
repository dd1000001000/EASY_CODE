import { z } from "zod";
import type { EventRecord, SessionState } from "../core/types.js";
import type { ContextManager } from "./manager.js";
import type { NormalRequestEnvelope } from "./context-request.js";
import { completeExchange, retirementBoundaries } from "./exchange-boundary.js";
import { runtimeIntent } from "./semantic-compaction.js";
import { runtimeContinuityMessage } from "./runtime-state.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { sha256 } from "../utils/hash.js";
import { assessCapacity, contextHistoryHash, recoveryScope } from "./capacity.js";
import { estimatedTokens } from "./token-budget.js";
import { pressureProjectedMessages, toolOutputReference } from "./pressure-projection.js";

const schema = z.object({ version: z.union([z.literal(1), z.literal(2)]), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
  historyHash: z.string(), factsHash: z.string(), previousSummary: z.string(), toolReferences: z.array(z.number().int().nonnegative()),
  summary: z.string(), reason: z.string().max(2000),
  mode: z.enum(["tool_references", "history_evicted", "minimal_rebase"]).optional(),
  scope: z.string().optional(),
}).strict();
type Eviction = z.infer<typeof schema>;

function evictionSummary(end: number, previousSummary: string, mode?: Eviction["mode"], state?: Readonly<SessionState>, version = 1): string {
  if (mode === "tool_references") return previousSummary;
  const latest = mode === "minimal_rebase" ? state?.commands.at(-1) : undefined;
  const lastExchangeStart = state?.messages.map((message, index) => message.role === "assistant" ? index : -1)
    .filter((index) => index >= 0 && index < end).at(-1) ?? Math.max(0, end - 1);
  return JSON.stringify({ formatVersion: 3, mode: mode ?? "history_evicted",
    warning: "Older context was moved out WITHOUT a complete semantic summary. Investigation and conclusions are NOT verified. Do not assume absent errors were resolved or repeat earlier work without checking evidence.",
    retiredHistory: { start: 0, end, evidenceIdPattern: "journal_message_<index>" },
    ...(previousSummary ? { previousSummaryRef: `journal_summary_${sha256(previousSummary)}` } : {}),
    ...(mode === "minimal_rebase" ? { nextStep: "Continue the SAME task from pinned Runtime state. Recall the last exchange before repeating work. Prior thinking was archived whole, not rewritten.",
      lastExchangeRef: `journal_message_${lastExchangeStart}`,
      ...(latest ? { lastObservedCommand: { id: latest.id, status: latest.status, exitCode: latest.exitCode } } : {}) } : {}),
    recovery: version === 1
      ? "Use manage_memory action=recall with evidenceId, offset and limit to recover historical messages or the previous summary. User requirements, pending operations and experiments remain separately pinned. Raw logs were not deleted."
      : "Use recall_context with evidenceId, offset and limit to recover historical messages or the previous summary. User requirements, pending operations and experiments remain separately pinned. Raw logs were not deleted.",
  });
}

/** Atomic reducer shared by preview, live execution and Journal replay. */
export function foldPressureRecovery(state: SessionState, raw: unknown): void {
  const event = schema.parse(raw);
  const latestAssistant = state.messages.map((m, index) => m.role === "assistant" ? index : -1).filter((i) => i >= 0).at(-1) ?? -1;
  const rebase = event.mode === "minimal_rebase";
  const referencesOnly = event.mode === "tool_references";
  if (event.start !== state.compactedMessageCount || event.end < event.start ||
      event.end > (rebase ? state.messages.length : latestAssistant) ||
      (referencesOnly && (event.end !== event.start || event.summary !== state.workingSummary)) ||
      (rebase && (event.end !== state.messages.length || event.end === event.start ||
        event.scope !== recoveryScope(state) || (state.pressureRecovery?.rebase?.scope === event.scope &&
          state.pressureRecovery.rebase.count >= 1))) ||
      !completeExchange(state.messages) || !completeExchange(state.messages, event.end) ||
      event.historyHash !== contextHistoryHash(state) || event.previousSummary !== state.workingSummary ||
      event.factsHash !== sha256(runtimeContinuityMessage(state)) ||
      event.summary !== evictionSummary(event.end, event.previousSummary, event.mode, state, event.version) ||
      event.toolReferences.some((index) => index < event.end || state.messages[index]?.role !== "tool"))
    throw new Error("Invalid or stale context eviction event");
  const recovery = state.pressureRecovery ??= { toolReferences: [], summaries: {} };
  if (!referencesOnly && event.previousSummary)
    recovery.summaries[`journal_summary_${sha256(event.previousSummary)}`] = event.previousSummary;
  recovery.toolReferences = [...new Set([...recovery.toolReferences, ...event.toolReferences])].sort((a, b) => a - b);
  if (rebase) recovery.rebase = { scope: event.scope!, count: 1 };
  if (referencesOnly) return;
  state.contextIntentLedger = runtimeIntent(state);
  state.compactedMessageCount = event.end;
  state.workingSummary = event.summary;
  delete state.contextCompactionMetadata;
  const tx = state.compactionControl?.transaction;
  if (tx?.status === "pending") tx.status = "superseded";
  if (state.compactionControl) { state.compactionControl.requested = false; state.compactionControl.seed = undefined; }
}

export interface RecoveryInput {
  state: SessionState; manager: ContextManager; maxContextChars: number; nextRequest: NormalRequestEnvelope;
  turnId: string; reason: string; limits?: Readonly<RuntimeLimits>;
  append: (event: Omit<EventRecord, "schemaVersion" | "sequence" | "timestamp" | "eventId">) => Promise<unknown>;
}

/** Persist the hysteresis gate independently of maintenance/retry counters. */
export function foldMemoryGate(state: SessionState, raw: unknown): void {
  const event = z.object({ suppressed: z.boolean() }).strict().parse(raw);
  (state.pressureRecovery ??= { toolReferences: [], summaries: {} }).optionalMemorySuppressed = event.suppressed;
}

/** Records the decision, so re-entering the loop/Resume cannot compact the same input again. */
export function foldContextMaintenance(state: SessionState, raw: unknown): void {
  const event = z.object({ historyHash: z.string(), requestKey: z.string(), usage: z.number().nonnegative().optional(),
    capacity: z.number().positive().optional(), paused: z.object({
    code: z.literal("context_capacity_exhausted"), reason: z.string().max(2000),
    usage: z.number().nonnegative(), capacity: z.number().positive(), unit: z.enum(["tokens", "characters"]),
  }).strict().optional() }).strict().parse(raw);
  if (event.historyHash !== contextHistoryHash(state)) throw new Error("Stale context maintenance decision");
  (state.pressureRecovery ??= { toolReferences: [], summaries: {} }).maintenance = event;
  // A safe no-op also consumes an explicit request. Otherwise its stale seed
  // bypasses hysteresis forever even when no eligible prefix exists.
  if (!event.paused && state.compactionControl?.transaction?.status !== "pending" && state.compactionControl) {
    state.compactionControl.requested = false;
    state.compactionControl.seed = undefined;
  }
}

function preview(input: RecoveryInput, end: number, references: number[], mode: NonNullable<Eviction["mode"]>) {
  const { state } = input;
  const event: Eviction = { version: 2, start: state.compactedMessageCount, end,
    historyHash: contextHistoryHash(state), factsHash: sha256(runtimeContinuityMessage(state)),
    previousSummary: state.workingSummary, toolReferences: references, mode,
    ...(mode === "minimal_rebase" ? { scope: recoveryScope(state) } : {}),
    summary: evictionSummary(end, state.workingSummary, mode, state, 2), reason: input.reason.slice(0, 2000) };
  const candidate = structuredClone(state);
  foldPressureRecovery(candidate, event);
  return { event, capacity: assessCapacity(input.manager, candidate, input.maxContextChars, input.nextRequest, input.limits) };
}

async function commit(input: RecoveryInput, event: Eviction): Promise<void> {
  await input.append({ threadId: input.state.threadId, turnId: input.turnId, type: "context.history.evicted",
    phase: "completed", payload: event });
  foldPressureRecovery(input.state, event);
}

/** Cheap first pass. A batch of parallel tools shares ONE output allowance. */
export async function referenceToolOutputs(input: RecoveryInput, underPressure: boolean): Promise<boolean> {
  const { state } = input;
  if (!completeExchange(state.messages)) return false;
  const limits = input.limits ?? DEFAULT_RUNTIME_LIMITS;
  // Neutral command polls do not age useful evidence out of the protected tail.
  const starts = state.messages.flatMap((message, index) => message.role === "assistant" &&
    index >= state.compactedMessageCount && !(message.tool_calls?.length &&
      message.tool_calls.every(call => call.function.name === "poll_command")) ? [index] : []);
  const protectedStart = starts.length > limits.compactionRetainRecentExchanges
    ? starts.at(-limits.compactionRetainRecentExchanges)! : state.compactedMessageCount;
  const recalledStart = starts.at(-limits.contextRecallProtectionExchanges) ?? state.compactedMessageCount;
  const recalled = new Set<string>();
  for (const message of state.messages.slice(recalledStart)) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) if (call.function.name === "recall_context" || call.function.name === "manage_memory") {
      try { const value = JSON.parse(call.function.arguments); if (typeof value.evidenceId === "string") recalled.add(value.evidenceId); } catch { /* not a recall */ }
    }
  }
  const projected = pressureProjectedMessages(state);
  const initialCapacity = assessCapacity(input.manager, state, input.maxContextChars, input.nextRequest, limits);
  let projectedUsage = initialCapacity.usage;
  const references = new Set<number>();
  let batch: number[] = [];
  const flush = () => {
    let tokens = batch.reduce((sum, index) => sum + estimatedTokens(projected[index]!.content ?? ""), 0);
    for (const index of batch) {
      const message = projected[index]!;
      const size = estimatedTokens(message.content ?? "");
      const protectedRecall = recalled.has(`journal_message_${index}`) || [...recalled].some(id =>
        id.startsWith("artifact:") && sha256(message.content ?? "").startsWith(id.slice(9)));
      const sourceTool = message.role === "tool" ? message.name : undefined;
      const recovering = index >= recalledStart && (sourceTool === "recall_context" || sourceTool === "search_context");
      const oldLarge = underPressure && index < protectedStart && !protectedRecall && !recovering &&
        (message.content?.length ?? 0) >= limits.contextToolReferenceMinChars;
      const referenceTokens = message.role === "tool" ? estimatedTokens(toolOutputReference(message, index).content ?? "") : size;
      if ((oldLarge || tokens > limits.contextToolBatchTokens) && size > referenceTokens &&
          !state.pressureRecovery?.toolReferences.includes(index)) {
        if (oldLarge && tokens <= limits.contextToolBatchTokens && references.size &&
            projectedUsage / initialCapacity.capacity <= limits.contextReferenceTargetRatio) continue;
        references.add(index);
        tokens -= size - referenceTokens;
        projectedUsage -= input.manager.tokenCapacity ? size - referenceTokens
          : (message.content?.length ?? 0) - toolOutputReference(message as Extract<typeof message, { role: "tool" }>, index).content!.length;
      }
    }
    batch = [];
  };
  for (let index = state.compactedMessageCount; index < state.messages.length; index++) {
    if (state.messages[index]?.role === "tool") batch.push(index);
    else flush();
  }
  flush();
  if (!references.size) return false;
  const candidate = preview(input, state.compactedMessageCount, [...references], "tool_references");
  const before = assessCapacity(input.manager, state, input.maxContextChars, input.nextRequest, limits);
  if (candidate.capacity.usage >= before.usage) return false;
  await commit(input, candidate.event);
  return true;
}

/** One deterministic search; model calls and recursive summaries are unnecessary. */
export async function recoverContextPressure(input: RecoveryInput): Promise<boolean> {
  const { state } = input;
  if (!completeExchange(state.messages)) return false;
  const limits = input.limits ?? DEFAULT_RUNTIME_LIMITS;
  const before = assessCapacity(input.manager, state, input.maxContextChars, input.nextRequest, limits);
  const references = state.messages.flatMap((m, index) => m.role === "tool" && index >= state.compactedMessageCount &&
    m.content.length >= limits.contextToolReferenceMinChars && !state.pressureRecovery?.toolReferences.includes(index) ? [index] : []);
  const ends = [...new Set([state.compactedMessageCount, ...retirementBoundaries(state, limits.compactionRetainRecentExchanges)])];
  const latestAssistant = state.messages.map((m, index) => m.role === "assistant" ? index : -1).filter((i) => i >= 0).at(-1) ?? -1;
  for (const end of ends) {
    if (end > latestAssistant) continue;
    // Old summaries may also be replaced by a reference without moving a boundary.
    if (end === state.compactedMessageCount && !references.length && state.workingSummary.length < 2000) continue;
    const candidate = preview(input, end, references.filter((i) => i >= end), "history_evicted");
    if (candidate.capacity.fits && candidate.capacity.usage < before.usage) {
      await commit(input, candidate.event);
      return true;
    }
  }
  const scope = recoveryScope(state);
  if (!limits.contextMaxRebasesPerRequest || state.pressureRecovery?.rebase?.scope === scope ||
      state.compactedMessageCount === state.messages.length) return false;
  const candidate = preview(input, state.messages.length, [], "minimal_rebase");
  if (!candidate.capacity.fits || candidate.capacity.usage >= before.usage) return false;
  await commit(input, candidate.event);
  return true;
}
