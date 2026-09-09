import { estimatedTokens } from "./token-budget.js";
import { projectText } from "../utils/bounded-text.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { canSalvageAuxiliaryFailure } from "../runtime/failure-policy.js";
import { z } from "zod";

/** Require a unique outer envelope; tags in code examples or scratch are not summaries. */
export function extractSummaryEnvelope(content: string | null | undefined): string | undefined {
  const text = (content ?? "").trim();
  const fences = [...text.matchAll(/```[^\n]*\n[\s\S]*?```|`[^`\n]*`/gu)].map(m => [m.index!, m.index! + m[0].length]);
  const stack: string[] = [];
  const results: string[] = [];
  let start = -1;
  for (const match of text.matchAll(/<(\/?)(analysis|summary)>/gu)) {
    if (fences.some(([a, b]) => match.index! >= a! && match.index! < b!)) continue;
    const name = match[2]!;
    if (!match[1]) {
      if (name === "summary" && stack.length === 0) start = match.index! + match[0].length;
      else if (stack.includes("summary")) return undefined;
      stack.push(name);
    } else {
      if (stack.pop() !== name) return undefined;
      if (name === "summary" && stack.length === 0 && start >= 0) {
        results.push(text.slice(start, match.index).trim()); start = -1;
      }
    }
  }
  return !stack.length && results.length === 1 && results[0] ? results[0] : undefined;
}

/** Auxiliary summaries only. Never filter ordinary conversation or executable JSON. */
export function extractSummaryText(content: string | null | undefined): string | undefined {
  const envelope = extractSummaryEnvelope(content);
  if (envelope) return envelope;
  let text = (content ?? "").trim();
  let removedScratch = false;
  if (!text) return undefined;
  // Accept one outer scratch block and/or one outer summary, not arbitrary
  // regex deletion inside source examples. Ambiguous envelopes fail locally.
  if (text.startsWith("<analysis>")) {
    const end = text.indexOf("</analysis>");
    if (end < 0 || text.slice(10, end).includes("<analysis>")) return undefined;
    text = text.slice(end + 11).trim();
    removedScratch = true;
  }
  if (text.startsWith("<summary>")) {
    if (!text.endsWith("</summary>")) return undefined;
    const body = text.slice(9, -10).trim();
    if (/<\/?(?:analysis|summary)>/u.test(body)) return undefined;
    return body || undefined;
  }
  if (/<\/?(?:analysis|summary)>/u.test(text)) return undefined;
  return text ? (removedScratch ? text : content!) : undefined;
}

export interface SummaryRecoveryState {
  attempts: number; pending?: boolean; lastBody?: string; formal?: string; error?: string;
  result?: { text?: string; raw: boolean; attempts: number };
}
export const summaryRecoveryEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attempt"), attempt: z.number().int().min(1).max(3) }).strict(),
  z.object({ type: z.literal("candidate"), attempt: z.number().int().min(1).max(3), body: z.string() }).strict(),
  z.object({ type: z.literal("failed"), reason: z.string().max(2000) }).strict(),
  z.object({ type: z.literal("completed"), raw: z.boolean() }).strict(),
]);
export type SummaryRecoveryEvent = z.infer<typeof summaryRecoveryEventSchema>;
export function foldSummaryRecovery(state: SummaryRecoveryState, raw: unknown): void {
  const event = summaryRecoveryEventSchema.parse(raw);
  if (state.result) throw new Error("Summary recovery already completed");
  if (event.type === "attempt") {
    if (state.pending || event.attempt !== state.attempts + 1) throw new Error("Invalid summary attempt");
    state.attempts = event.attempt; state.pending = true;
  } else if (event.type === "candidate") {
    if (!state.pending || event.attempt !== state.attempts) throw new Error("Unbound summary response");
    state.pending = false;
    if (event.body.trim()) state.lastBody = event.body;
    state.formal = extractSummaryEnvelope(event.body);
    state.error = state.formal ? undefined : "No unique complete outer <summary> was found";
  } else if (event.type === "failed") {
    state.error = event.reason; // pending stays true: never redispatch an unknown request.
  } else {
    if (!event.raw && !state.formal) throw new Error("Missing formal summary");
    state.result = { text: event.raw ? state.lastBody : state.formal, raw: event.raw, attempts: state.attempts };
  }
}

/** Native reasoning never enters this API. Durable hooks are outside the API catch. */
export async function requestSummaryWithCorrections(
  complete: (attempt: number, feedback?: string) => Promise<string | null | undefined>,
  limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS,
  durable?: { get(): SummaryRecoveryState; append(event: SummaryRecoveryEvent): Promise<void>; signal?: AbortSignal },
): Promise<{ text?: string; raw: boolean; attempts: number }> {
  const local: SummaryRecoveryState = { attempts: 0 };
  const get = durable?.get ?? (() => local);
  const emit = durable?.append ?? (async (event: SummaryRecoveryEvent) => { foldSummaryRecovery(local, event); });
  if (get().result) return get().result!;
  while (!get().formal && !get().pending && get().attempts < limits.modelContentRetries + 1) {
    durable?.signal?.throwIfAborted();
    const attempt = get().attempts + 1;
    await emit({ type: "attempt", attempt });
    let body: string | null | undefined;
    try { body = await complete(attempt, attempt > 1
      ? "RUNTIME_SUMMARY_FORMAT: No unique complete outer <summary> was found. Return optional <analysis> scratch followed by exactly one complete <summary>formal handoff</summary>. Length overflow is clipped locally; do not repeat tools." : undefined); }
    catch (error) {
      if (!canSalvageAuxiliaryFailure(error, durable?.signal)) throw error;
      await emit({ type: "failed", reason: "Transient API recovery exhausted; retaining the last durable body without another content attempt." });
      break;
    }
    // Normal extraction deletes disposable scratch before archiving.
    const formal = extractSummaryEnvelope(body);
    await emit({ type: "candidate", attempt, body: formal ? `<summary>${formal}</summary>` : body ?? "" });
  }
  await emit({ type: "completed", raw: !get().formal });
  return get().result!;
}

/** Only formal prose is archived; scratchpad and native thinking are excluded. */
export function projectSummary(content: string, sourceRef: string, maxTokens = DEFAULT_RUNTIME_LIMITS.contextSummaryMaxTokens) {
  const full = redactSensitiveInformation(content.trim());
  const wrap = (text: string, truncated: boolean) => JSON.stringify({
    kind: "historical_summary", unverified: true, truncated, sourceRef, content: text,
  });
  const projected = projectText(full, maxTokens, text => estimatedTokens(wrap(text, text !== full)));
  const encoded = wrap(projected.text, projected.truncated);
  if (estimatedTokens(encoded) > maxTokens) throw new Error("Summary metadata does not fit the local budget");
  return { full, text: projected.text, encoded, truncated: projected.truncated };
}

export function summaryInstructions(compactContextAvailable = false, maxTokens = DEFAULT_RUNTIME_LIMITS.contextSummaryMaxTokens): string {
  return "Produce a concise formal handoff. Optional <analysis> is disposable scratch, never retained; " +
  "do not duplicate native thinking. Put the final handoff in one complete outer <summary> block" +
  (compactContextAvailable ? ", OR submit one valid compact_context tool call instead of XML. " : ". No tool calls are permitted for this summary. ") +
  "Cover relevant sections only: user intent, technical concepts, files/changes, errors/fixes, solved/open problems, " +
  "user corrections, pending tasks, current work, next step. Cite evidence instead of copying large source/output. " +
  "Distinguish observations, unverified hypotheses and rejected approaches. Do not self-certify completion. " +
  `Runtime retains original user requirements and unresolved operations separately. Keep the final handoff within ${maxTokens} estimated tokens including metadata. Length overflow is clipped locally; no rewrite is needed.`;
}
export const SUMMARY_INSTRUCTIONS = summaryInstructions();
