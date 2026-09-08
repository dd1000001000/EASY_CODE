import { z } from "zod";
import type { ContextIntentLedger, SessionState, ToolExecutionResult } from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import { runtimeContinuityMessage } from "./runtime-state.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";

const text = z.string().trim().min(1).max(1200);
const strings = z.array(text).max(32);
export const semanticSummarySchema = z.object({
  currentWork: text,
  decisions: strings.default([]),
  conclusions: z.array(z.object({ text,
    evidenceIds: z.array(z.string().regex(/^ev_[a-f0-9]{24}$/u)).max(12).default([]),
  }).strict()).max(32).default([]),
  hypotheses: strings.default([]),
  failedApproaches: strings.default([]),
  nextStep: text,
}).strict();
// The same provider-neutral tool accepts a complete candidate or a field patch.
// Omitted fields preserve the saved candidate; [] explicitly clears a section.
export const semanticPatchSchema = semanticSummarySchema.partial();
export type SemanticSummary = z.infer<typeof semanticSummarySchema>;

export const evidenceSchema = z.object({
  id: z.string(), locator: z.string(), digest: z.string(), kind: z.enum(["tool", "command"]),
  tool: z.string().optional(), status: z.string().optional(), exitCode: z.number().nullable().optional(),
  ok: z.boolean().optional(),
}).strict();
export const compactionSnapshotSchema = z.object({
  version: z.literal(3), end: z.number().int().nonnegative(), sourceHash: z.string(),
  historyHash: z.string(), facts: z.string(), previousSummaryHash: z.string(),
  evidence: z.array(evidenceSchema), digest: z.string(),
}).strict();
export type CompactionSnapshot = z.infer<typeof compactionSnapshotSchema>;

/** A bounded catalogue of observations, not a certificate that arbitrary prose is true. */
export function compactionSnapshot(state: Readonly<SessionState>, end: number): CompactionSnapshot {
  const evidence: CompactionSnapshot["evidence"] = [];
  const add = (entry: Omit<CompactionSnapshot["evidence"][number], "id">) => {
    evidence.push({ id: `ev_${sha256(entry.locator + entry.digest).slice(0, 24)}`, ...entry });
  };
  state.messages.map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "tool").slice(-128).forEach(({ message, index }) => {
      if (message.role !== "tool") return;
      let ok: boolean | undefined;
      try { const result = JSON.parse(message.content); if (typeof result?.ok === "boolean") ok = result.ok; } catch { /* Raw evidence remains addressable. */ }
      add({ locator: `message:${index}`, digest: sha256(message.content), kind: "tool", tool: message.name, ok });
    });
  for (const command of state.commands.slice(-128)) add({ locator: `command:${command.id}`,
    digest: sha256(JSON.stringify(command)), kind: "command", status: command.status, exitCode: command.exitCode });
  const body = { version: 3 as const, end, sourceHash: sha256(JSON.stringify(state.messages.slice(0, end))),
    historyHash: sha256(JSON.stringify(state.messages)),
    facts: runtimeContinuityMessage({ ...state, compactedMessageCount: end }),
    previousSummaryHash: sha256(state.workingSummary), evidence };
  return { ...body, digest: sha256(JSON.stringify(body)) };
}

export function runtimeIntent(state: Readonly<SessionState>): ContextIntentLedger {
  if (state.contextIntentLedger) return structuredClone(state.contextIntentLedger);
  let index = state.messages.length - 1;
  while (index >= 0) {
    const m = state.messages[index]!;
    if (m.role === "user" && !m.content.trimStart().startsWith("RUNTIME_")) break;
    index -= 1;
  }
  if (index < 0) throw new Error("context_capacity_insufficient: durable user request is missing");
  return { latestRequest: { sourceMessageIndex: index,
    text: redactSensitiveInformation(state.messages[index]!.content ?? "").slice(0, 400) || "[Attachments only]" },
    activeConstraints: [], userCorrections: [], supersededRequests: [] };
}

export function mergeSemanticCandidate(previous: unknown, patch: unknown): unknown {
  const base = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
  const changes = semanticPatchSchema.parse(patch);
  return { ...base, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) };
}

/** Retain valid sections even if a sibling section makes the tool call invalid. */
export function salvageSemanticSections(previous: unknown, patch: unknown): unknown {
  const base = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const source = patch as Record<string, unknown>;
  const valid: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(semanticPatchSchema.shape)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const result = schema.safeParse(source[key]);
    if (result.success && result.data !== undefined) valid[key] = result.data;
  }
  return { ...base, ...valid };
}

export function semanticIssues(candidate: unknown, snapshot: CompactionSnapshot): string[] {
  const parsed = semanticSummarySchema.safeParse(candidate);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  const known = new Set(snapshot.evidence.map((e) => e.id));
  return parsed.data.conclusions.flatMap((item, index) => item.evidenceIds
    .filter((id) => !known.has(id)).map((id) => `conclusions.${index}.evidenceIds: unknown ${id}; choose a supplied ID or move the claim to hypotheses`));
}

/** Existence is not entailment: only Runtime observation fields are verified.
 * Model conclusions remain interpretations even when they cite successful tests. */
export function semanticDocument(candidate: unknown, snapshot: CompactionSnapshot, degrade = false): string {
  const parsed = semanticSummarySchema.parse(candidate);
  const catalogue = new Map(snapshot.evidence.map((entry) => [entry.id, entry]));
  const used = new Set<string>();
  const hypotheses = [...parsed.hypotheses];
  const conclusions = parsed.conclusions.filter((item) => {
    if (!item.evidenceIds.length || item.evidenceIds.some((id) => !catalogue.has(id))) {
      if (!degrade && item.evidenceIds.some((id) => !catalogue.has(id))) throw new Error("Unknown evidence ID");
      hypotheses.push(item.text + " [unverified: evidence unavailable]");
      return false;
    }
    item.evidenceIds.forEach((id) => used.add(id));
    return true;
  }).map((item) => ({ ...item, verification: "model_interpretation_not_runtime_verified" }));
  return redactSensitiveInformation(JSON.stringify({ formatVersion: 3, snapshotDigest: snapshot.digest,
    semantic: { ...parsed, conclusions, hypotheses },
    observations: [...used].map((id) => catalogue.get(id)),
    evidencePolicy: "Observation outcomes concern recorded invocations, not the current checkout. Interpretations and hypotheses are not proven facts." }));
}

export function conservativeDocument(state: Readonly<SessionState>, snapshot: CompactionSnapshot): string {
  return redactSensitiveInformation(JSON.stringify({ formatVersion: 3, mode: "conservative",
    snapshotDigest: snapshot.digest, previousAcceptedSummary: state.workingSummary,
    retiredHistory: { start: state.compactedMessageCount, end: snapshot.end, hash: snapshot.sourceHash },
    nextStep: "Semantic compaction was unavailable. Recover retired messages using manage_memory recall with evidenceId journal_message_<index> in the retiredHistory range before changing strategy. Do not infer unobserved success.",
    evidenceCatalogueRef: snapshot.digest,
    note: "Runtime facts and user requests remain pinned outside this summary; the newest full phase and live tool chain remain verbatim. Raw retired history is preserved, not deleted." }));
}

/** Exact current-thread Journal projection; never RAG, subprocesses or file reads. */
export function recallCompactionEvidence(state: Readonly<SessionState>, raw: string): ToolExecutionResult | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  const object = value as { action?: string; evidenceId?: string } | null;
  if (object?.action !== "recall" || typeof object.evidenceId !== "string" ||
      !/^(ev_|journal_message_)/u.test(object.evidenceId)) return undefined;
  const parsed = z.object({ action: z.literal("recall"),
    evidenceId: z.string().regex(/^(?:ev_[a-f0-9]{24}|journal_message_\d+)$/u),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(16000).default(8000),
  }).strict().safeParse(value);
  if (!parsed.success) return { ok: false, summary: "Invalid Journal recall parameters." };
  const { evidenceId, offset, limit } = parsed.data;
  let source: unknown;
  const index = /^journal_message_(\d+)$/u.exec(evidenceId);
  if (index) source = state.messages[Number(index[1])];
  else {
    for (const [n, message] of state.messages.entries()) if (message.role === "tool" &&
      `ev_${sha256(`message:${n}` + sha256(message.content)).slice(0, 24)}` === evidenceId) { source = message; break; }
    if (source === undefined) for (const command of state.commands) if (
      `ev_${sha256(`command:${command.id}` + sha256(JSON.stringify(command))).slice(0, 24)}` === evidenceId) { source = command; break; }
  }
  if (source === undefined) return { ok: false, summary: "Evidence does not exist in the current thread; no external lookup was performed." };
  const content = redactSensitiveInformation(JSON.stringify(source));
  return { ok: true, summary: "Historical Journal evidence, not proof about the current checkout.", data: {
    evidenceId, offset, text: content.slice(offset, offset + limit), totalChars: content.length,
    nextOffset: offset + limit < content.length ? offset + limit : null,
  } };
}
