import { z } from "zod";
import type { ContextIntentLedger, SessionState, ToolExecutionResult } from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import { runtimeContinuityMessage } from "./runtime-state.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { projectText } from "../utils/bounded-text.js";
import { estimatedTokens } from "./token-budget.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";

export const SEMANTIC_FIELD_MAX_CHARS = DEFAULT_RUNTIME_LIMITS.contextSemanticFieldMaxChars;
export function createSemanticSummarySchema(maxChars = SEMANTIC_FIELD_MAX_CHARS) {
const text = z.string().trim().min(1).max(maxChars);
const strings = z.array(text).max(32);
return z.object({
  currentWork: text,
  decisions: strings.default([]),
  conclusions: z.array(z.object({ text,
    evidenceIds: z.array(z.string().regex(/^ev_[a-f0-9]{24}$/u)).max(12).default([]),
  }).strict()).max(32).default([]),
  hypotheses: strings.default([]),
  failedApproaches: strings.default([]),
  nextStep: text,
}).strict();
}
export const semanticSummarySchema = createSemanticSummarySchema();
// The same provider-neutral tool accepts a complete candidate or a field patch.
// Omitted fields preserve the saved candidate; [] explicitly clears a section.
export const semanticPatchSchema = semanticSummarySchema.partial();
export type SemanticSummary = z.infer<typeof semanticSummarySchema>;

/** Only length violations are repairable by clipping; types/evidence IDs stay strict. */
export function inspectSemanticPatch(value: unknown, maxChars = SEMANTIC_FIELD_MAX_CHARS): { issues: string[]; overflows: Array<{ path: (string | number)[]; actual: number; maximum: number }>; lengthOnly: boolean } {
  const parsed = createSemanticSummarySchema(maxChars).partial().safeParse(value);
  if (parsed.success) return { issues: [], overflows: [], lengthOnly: false };
  const overflows: Array<{ path: (string | number)[]; actual: number; maximum: number }> = [];
  const issues = parsed.error.issues.map(issue => {
    if (issue.code === "too_big" && ((issue.type === "string" && issue.maximum === maxChars) ||
      (issue.type === "array" && issue.maximum === 32 && issue.path.length === 1 &&
        ["decisions", "conclusions", "hypotheses", "failedApproaches"].includes(String(issue.path[0]))))) {
      let field: any = value;
      for (const key of issue.path) field = field?.[key];
      const actual = typeof field === "string" ? field.trim().length : Array.isArray(field) ? field.length : 0;
      const maximum = Number(issue.maximum);
      overflows.push({ path: issue.path, actual, maximum });
      return `${issue.path.join(".")}: ${actual} ${issue.type === "array" ? "items" : "chars"} exceeds maximum ${maximum}`;
    }
    return `${issue.path.join(".") || "input"}: ${issue.message}`;
  });
  return { issues, overflows, lengthOnly: overflows.length === issues.length };
}

/** Stage overlong text for the isolated transaction, never discard required fields. */
export function parseSemanticRequestPatch(value: unknown, maxChars = SEMANTIC_FIELD_MAX_CHARS): unknown {
  const parsed = createSemanticSummarySchema(maxChars).partial().safeParse(value);
  if (parsed.success) return parsed.data;
  if (inspectSemanticPatch(value, maxChars).lengthOnly) return value;
  throw parsed.error;
}

/** Auxiliary historical handoffs only. The public tool continues to reject V2. */
export function parseSemanticCandidatePatch(value: unknown, maxChars = SEMANTIC_FIELD_MAX_CHARS): unknown {
  // Historical V2 responses carried Runtime-owned coverage/intent declarations.
  // Preserve only their semantic fields; never promote those old declarations.
  if (value && typeof value === "object" && !Array.isArray(value) && (value as { formatVersion?: unknown }).formatVersion === 2) {
    value = Object.fromEntries(Object.entries(value).filter(([key]) => Object.prototype.hasOwnProperty.call(semanticPatchSchema.shape, key)));
  }
  return parseSemanticRequestPatch(value, maxChars);
}

export function clipSemanticFields(value: unknown, maxChars = SEMANTIC_FIELD_MAX_CHARS): { patch: unknown; diagnostics: string[] } {
  const inspection = inspectSemanticPatch(value, maxChars);
  const patch: any = structuredClone(value);
  // Repair items before dropping array tails, so nested paths remain addressable.
  for (const overflow of [...inspection.overflows].sort((a, b) => b.path.length - a.path.length)) {
    let parent = patch;
    for (const key of overflow.path.slice(0, -1)) parent = parent[key];
    const key = overflow.path.at(-1)!;
    if (Array.isArray(parent[key])) {
      parent[key] = parent[key].slice(0, overflow.maximum);
      continue;
    }
    let prefix = parent[key].trim().slice(0, overflow.maximum);
    // Do not leave half a UTF-16 surrogate at the prefix boundary.
    if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
    parent[key] = prefix;
  }
  return { patch, diagnostics: inspection.overflows.map(item =>
    `${item.path.join(".")}: ${item.actual} units; retained first ${item.maximum} (remainder is in Journal)`) };
}

export const evidenceSchema = z.object({
  id: z.string(), locator: z.string(), digest: z.string(), kind: z.enum(["tool", "command"]),
  tool: z.string().optional(), status: z.string().optional(), exitCode: z.number().nullable().optional(),
  ok: z.boolean().optional(),
}).strict();
export const compactionSnapshotSchema = z.object({
  version: z.literal(3), end: z.number().int().nonnegative(), sourceHash: z.string(),
  historyHash: z.string(), facts: z.string(), previousSummaryHash: z.string(),
  evidence: z.array(evidenceSchema), digest: z.string(),
  investigation: z.literal("unfinished_investigation_not_verified").optional(),
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
    previousSummaryHash: sha256(state.workingSummary), evidence,
    ...(state.compactionControl?.investigationEnds?.includes(end)
      ? { investigation: "unfinished_investigation_not_verified" as const } : {}) };
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
export function semanticDocument(candidate: unknown, snapshot: CompactionSnapshot, degrade = false, truncatedFields: readonly string[] = [], maxChars = SEMANTIC_FIELD_MAX_CHARS): string {
  const parsed = createSemanticSummarySchema(maxChars).parse(candidate);
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
    ...(truncatedFields.length ? { truncatedFields, lossy: true } : {}),
    ...(snapshot.investigation ? { investigation: snapshot.investigation,
      investigationPolicy: "This boundary closes source-inspection exchanges only. Investigation remains unfinished; conclusions are unverified interpretations, not task completion. Preserve hypotheses and perform the next validation." } : {}),
    semantic: { ...parsed, conclusions, hypotheses },
    observations: [...used].map((id) => catalogue.get(id)),
    evidencePolicy: "Observation outcomes concern recorded invocations, not the current checkout. Interpretations and hypotheses are not proven facts." }));
}

export function conservativeDocument(state: Readonly<SessionState>, snapshot: CompactionSnapshot): string {
  return redactSensitiveInformation(JSON.stringify({ formatVersion: 3, mode: "conservative",
    ...(snapshot.investigation ? { investigation: snapshot.investigation,
      investigationPolicy: "Investigation remains unfinished. Recover hypotheses and pending validation from retired history; reads/searches do not verify conclusions or complete the task." } : {}),
    snapshotDigest: snapshot.digest, previousAcceptedSummary: state.workingSummary,
    retiredHistory: { start: state.compactedMessageCount, end: snapshot.end, hash: snapshot.sourceHash },
    nextStep: "Semantic compaction was unavailable. Recover retired messages using manage_memory recall with evidenceId journal_message_<index> in the retiredHistory range before changing strategy. Do not infer unobserved success.",
    evidenceCatalogueRef: snapshot.digest,
    note: snapshot.investigation
      ? "Runtime facts and user requests remain pinned outside this summary; protected recent exchanges and the live tool chain remain verbatim. Raw retired history is preserved, not deleted."
      : "Runtime facts and user requests remain pinned outside this summary; the newest full phase and live tool chain remain verbatim. Raw retired history is preserved, not deleted." }));
}

/** Preserve valid JSON at the storage boundary, never an executable partial object. */
export function boundedSummaryDocument(document: string, snapshot: CompactionSnapshot,
  maxTokens: number, maxChars: number, prose = false, sourceRef = "context.compaction.candidate"): string {
  if (!prose && document.length <= maxChars && estimatedTokens(document) <= maxTokens) return document;
  const wrap = (content: string) => JSON.stringify({ formatVersion: 3, mode: "text_prefix",
    lossy: true, unverified: true, snapshotDigest: snapshot.digest,
    sourceRef, content,
    note: "Incomplete handoff. Recover original Journal before relying on omitted qualifications. Runtime facts remain pinned." });
  const clean = redactSensitiveInformation(document);
  const result = projectText(clean, maxTokens, text => {
    const encoded = wrap(text);
    return encoded.length > maxChars ? maxTokens + 1 : estimatedTokens(encoded);
  });
  return wrap(result.text);
}

/** Exact current-thread Journal projection; never RAG, subprocesses or file reads. */
export function recallCompactionEvidence(state: Readonly<SessionState>, raw: string, limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS): ToolExecutionResult | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  const object = value as { action?: string; evidenceId?: string } | null;
  if (object?.action !== "recall" || typeof object.evidenceId !== "string" ||
      !/^(ev_|journal_message_|journal_summary_)/u.test(object.evidenceId)) return undefined;
  const parsed = z.object({ action: z.literal("recall"),
    evidenceId: z.string().regex(/^(?:ev_[a-f0-9]{24}|journal_message_\d+|journal_summary_[a-f0-9]{64})$/u),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(limits.evidenceRecallMaxChars).default(limits.evidenceRecallDefaultChars),
  }).strict().safeParse(value);
  if (!parsed.success) return { ok: false, summary: "Invalid Journal recall parameters." };
  const { evidenceId, offset, limit } = parsed.data;
  let source: unknown;
  const index = /^journal_message_(\d+)$/u.exec(evidenceId);
  if (index) source = state.messages[Number(index[1])];
  else if (evidenceId.startsWith("journal_summary_")) source = state.pressureRecovery?.summaries[evidenceId];
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
