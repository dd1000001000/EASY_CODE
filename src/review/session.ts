import { z } from "zod";
import { sha256 } from "../utils/hash.js";
import { extractSummaryText, projectSummary, foldSummaryRecovery, summaryRecoveryEventSchema, type SummaryRecoveryState } from "../context/summary-output.js";
import type { SessionState } from "../core/types.js";
import { ReviewFatalError } from "./errors.js";

export type ReviewActor = "reviewer" | "author";
export const statementSchema = z.object({
  proposal: z.string().trim().min(1).max(4000),
  kind: z.enum(["next_action", "delivery"]),
  vote: z.enum(["agree", "disagree", "needs_evidence"]),
  evidenceRefs: z.array(z.string().min(1).max(160)).max(32),
  unresolved: z.array(z.string().min(1).max(2000)).max(32),
  checks: z.array(z.object({ requirementId: z.string().min(1).max(160), evidenceId: z.string().min(1).max(160),
    method: z.enum(["test", "build", "typecheck", "lint", "format_check", "custom", "inspection"]),
    rationale: z.string().trim().min(1).max(2000), counterexample: z.string().trim().min(1).max(2000),
    contractEvidenceId: z.string().min(1).max(160).optional(),
  }).strict()).max(32).optional(),
}).strict();
export type ReviewStatement = z.infer<typeof statementSchema>;
export interface ReviewSession {
  environmentStarted?: boolean; environmentReady?: boolean;
  changeCount?: number; requirements?: string[]; blockingChecks?: string[]; documentationOnly?: boolean; changedPaths?: string[];
  scope?: string;
  directory?: string; actorThreads?: Record<ReviewActor, string>;
  id: string; key: string; purpose: "stagnation" | "delivery"; snapshotId: string; requirementRevision: string;
  incidentId?: string; round: number; maxRounds: number; next: ReviewActor;
  status: "discussing" | "closing" | "decided" | "applied";
  closeReason?: string; requests: number; tools: number; maxRequests: number; maxTools: number; deadline: number;
  summaryTokens: number; requestedSummaries: ReviewActor[];
  briefingRequested?: boolean; briefing?: { full: string; projected: string };
  summaryRecovery?: Partial<Record<ReviewActor | "briefing", SummaryRecoveryState>>;
  statements: Array<{ actor: ReviewActor; round: number; proposalId: string; value: ReviewStatement }>;
  summaries: Partial<Record<ReviewActor, { full: string; projected: string; unavailable: boolean }>>;
  experiments: Array<{ id: string; actor: ReviewActor; passed: boolean; unchanged: boolean; standard?: "unchanged" | "changed" | "unknown";
    checkKey?: string; outcome?: "passed" | "failed" | "unknown"; method?: string; source?: string; paths?: string[] }>;
  approval: boolean; handoff?: string;
}

const actor = z.enum(["reviewer", "author"]);
const start = z.object({ type: z.literal("started"), id: z.string().min(1), key: z.string().min(1),
  changeCount: z.number().int().nonnegative().optional(), requirements: z.array(z.string().min(1).max(160)).max(128).optional(),
  blockingChecks: z.array(z.string().min(1)).optional(), documentationOnly: z.boolean().optional(),
  changedPaths: z.array(z.string()).optional(),
  scope: z.string().optional(),
  directory: z.string().optional(), actorThreads: z.object({ author: z.string(), reviewer: z.string() }).strict().optional(),
  purpose: z.enum(["stagnation", "delivery"]), snapshotId: z.string().min(1), requirementRevision: z.string().min(1),
  incidentId: z.string().optional(), maxRounds: z.number().int().min(1).max(5),
  maxRequests: z.number().int().min(2).max(200), maxTools: z.number().int().min(0).max(100),
  deadline: z.number().positive(), summaryTokens: z.number().int().min(256).max(2048) }).strict();
const eventSchema = z.discriminatedUnion("type", [start,
  z.object({ type: z.literal("environment_started"), id: z.string() }).strict(),
  z.object({ type: z.literal("environment_checked"), id: z.string(), ready: z.boolean() }).strict(),
  z.object({ type: z.literal("briefing_requested"), id: z.string() }).strict(),
  z.object({ type: z.literal("briefing"), id: z.string(), text: z.string(), raw: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("summary_recovery"), id: z.string(), key: z.enum(["briefing", "author", "reviewer"]), event: summaryRecoveryEventSchema }).strict(),
  z.object({ type: z.literal("request"), id: z.string(), closingActor: actor.optional(), continuation: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("tool"), id: z.string() }).strict(),
  z.object({ type: z.literal("statement"), id: z.string(), actor, value: statementSchema }).strict(),
  z.object({ type: z.literal("experiment"), id: z.string(), actor, evidenceId: z.string(), passed: z.boolean(), unchanged: z.boolean(),
    checkKey: z.string().optional(), outcome: z.enum(["passed", "failed", "unknown"]).optional(),
    method: z.string().optional(), source: z.string().optional(), paths: z.array(z.string()).optional(),
    standard: z.enum(["unchanged", "changed", "unknown"]).optional() }).strict(),
  z.object({ type: z.literal("close"), id: z.string(), reason: z.string().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("summary"), id: z.string(), actor, text: z.string(), unavailable: z.boolean(), raw: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("decided"), id: z.string(), fresh: z.boolean() }).strict(),
  z.object({ type: z.literal("applied"), id: z.string(), fresh: z.boolean().optional() }).strict(),
]);
export type ReviewEvent = z.infer<typeof eventSchema>;
export function proposalId(session: ReviewSession, value: ReviewStatement): string {
  return sha256(JSON.stringify([session.snapshotId, session.requirementRevision, value.kind, value.proposal]));
}
export function agreed(session: ReviewSession): boolean {
  const last = session.statements.slice(-2);
  return last.length === 2 && last[0]!.actor === "reviewer" && last[1]!.actor === "author" &&
    last[0]!.round === last[1]!.round && last[0]!.proposalId === last[1]!.proposalId &&
    last.every(s => s.value.vote === "agree" && s.value.unresolved.length === 0);
}

/** Validate on a clone BEFORE append; apply only after the event is durable. */
export function foldReviewEvent(state: SessionState, raw: unknown): void {
  const event = eventSchema.parse(raw);
  const sessions = state.reviewSessions ??= [];
  if (event.type === "started") {
    if (sessions.some(s => s.id === event.id || s.key === event.key)) throw new Error("Duplicate review binding");
    const { type: _type, ...binding } = event;
    sessions.push({ ...binding, round: 0, next: "reviewer", status: "discussing", requests: 0, tools: 0,
      requestedSummaries: [], statements: [], summaries: {}, experiments: [], approval: false });
    return;
  }
  const s = sessions.find(s => s.id === event.id);
  if (!s) throw new Error("Unknown review session");
  if (s.status === "applied") throw new Error("Review already applied");
  switch (event.type) {
    case "summary_recovery": {
      if (event.key === "briefing" ? s.status !== "discussing" || !s.briefingRequested || Boolean(s.briefing)
        : s.status !== "closing" || !s.requestedSummaries.includes(event.key) || Boolean(s.summaries[event.key]))
        throw new Error("Unbound summary recovery");
      const recovery = (s.summaryRecovery ??= {})[event.key] ??= { attempts: 0 };
      foldSummaryRecovery(recovery, event.event); break;
    }
    case "environment_started":
      if (s.status !== "discussing" || s.environmentStarted) throw new Error("Environment preflight already requested");
      s.environmentStarted = true; break;
    case "environment_checked":
      if (s.status !== "discussing" || !s.environmentStarted || s.environmentReady !== undefined) throw new Error("Invalid environment preflight result");
      s.environmentReady = event.ready; break;
    case "briefing_requested":
      if (s.status !== "discussing" || s.briefingRequested || s.statements.length) throw new Error("Duplicate or late opening brief");
      s.briefingRequested = true; break;
    case "briefing": {
      if (s.status !== "discussing" || s.briefing || !s.briefingRequested) throw new Error("Invalid opening brief");
      const result = projectSummary((event.raw ? event.text : extractSummaryText(event.text)) || "Opening brief unavailable; independently consult supplied material.",
        `review:${s.id}:briefing`, s.summaryTokens);
      s.briefing = { full: result.full, projected: result.encoded }; break;
    }
    case "request":
      if (event.closingActor) {
        if (s.status !== "closing" || Boolean(event.continuation) !== s.requestedSummaries.includes(event.closingActor)) throw new Error("Duplicate or unbound summary attempt");
        if (!event.continuation) s.requestedSummaries.push(event.closingActor);
      } else if (s.status !== "discussing" || s.requests >= s.maxRequests - 2) throw new Error("Reserved closing budget");
      if (s.requests >= s.maxRequests) throw new Error("Review request limit");
      s.requests++; break;
    case "tool":
      if (s.status !== "discussing" || s.tools >= s.maxTools) throw new Error("Review tool limit");
      s.tools++; break;
    case "statement":
      if (s.status !== "discussing" || s.round >= s.maxRounds || event.actor !== s.next) throw new Error("Invalid discussion turn");
      s.statements.push({ actor: event.actor, round: s.round + 1, proposalId: proposalId(s, event.value), value: event.value });
      if (event.actor === "author") { s.round++; s.next = "reviewer"; } else s.next = "author";
      if (agreed(s) || s.round >= s.maxRounds) { s.status = "closing"; s.closeReason = agreed(s) ? "agreement" : "round_limit"; }
      break;
    case "experiment":
      if (s.status !== "discussing" || s.experiments.some(e => e.id === event.evidenceId)) throw new Error("Invalid experiment event");
      s.experiments.push({ id: event.evidenceId, actor: event.actor, passed: event.passed, unchanged: event.unchanged,
        checkKey: event.checkKey, outcome: event.outcome, method: event.method, source: event.source, paths: event.paths,
        ...(event.standard ? { standard: event.standard } : {}) }); break;
    case "close":
      if (s.status !== "discussing") throw new Error("Discussion already closed");
      s.status = "closing"; s.closeReason = event.reason; break;
    case "summary": {
      if (s.status !== "closing" || s.summaries[event.actor]) throw new Error("Duplicate or premature closing summary");
      const formal = event.raw ? event.text.trim() || undefined : extractSummaryText(event.text);
      const full = formal ?? "Summary unavailable. Consult this participant's recorded public statements and evidence; no final position is inferred.";
      const result = projectSummary(full, `review:${s.id}:${event.actor}`, s.summaryTokens);
      s.summaries[event.actor] = { full: result.full, projected: result.encoded, unavailable: event.unavailable || !formal };
      break;
    }
    case "decided": {
      if (s.status !== "closing" || !s.summaries.author || !s.summaries.reviewer) throw new Error("Both independent summaries required");
      // Consensus cannot manufacture verification or erase an unresolved item.
      const last = s.statements.slice(-2);
      s.approval = event.fresh && agreed(s) && !s.summaries.author.unavailable && !s.summaries.reviewer.unavailable &&
        deliveryEvidenceSatisfied(s);
      s.status = "decided";
      s.handoff = renderReviewHandoff(s, event.fresh);
      break;
    }
    case "applied":
      if (s.status !== "decided" || !s.handoff) throw new Error("Review decision missing");
      if (event.fresh === false) { s.approval = false; s.handoff = renderReviewHandoff(s, false); }
      s.status = "applied";
      state.messages.push({ role: "user", content: s.handoff });
      if (s.incidentId) {
        const incident = state.progressGuard?.incidents.find(item => item.incidentId === s.incidentId);
        if (incident) { incident.phase = "strategy_adjustment"; incident.reviewAttempts++; }
      }
      break;
  }
}

/** Runtime evidence cannot be erased by a vote or by omitting an objection. */
export function deliveryEvidenceSatisfied(s: ReviewSession): boolean {
  const unresolved = new Set(s.blockingChecks ?? []);
  for (const e of s.experiments) {
    if (e.outcome === "failed" || !e.passed && e.outcome === undefined) unresolved.add(e.checkKey ?? e.id);
    else if (e.actor === "reviewer" && e.passed && e.unchanged && e.standard === "unchanged" && e.checkKey) unresolved.delete(e.checkKey);
  }
  if (unresolved.size || !s.requirements?.length) return false;
  if (s.documentationOnly && s.changedPaths?.some(name => !s.experiments.some(e =>
    e.actor === "reviewer" && e.method === "inspection" && e.passed && e.unchanged && e.paths?.includes(name)))) return false;
  return s.statements.slice(-2).length === 2 && s.statements.slice(-2).every(({ value }) =>
    value.kind === "delivery" && s.requirements!.every(requirementId => value.checks?.some(check =>
      check.requirementId === requirementId && value.evidenceRefs.includes(check.evidenceId) &&
      (check.method !== "custom" || Boolean(check.contractEvidenceId && value.evidenceRefs.includes(check.contractEvidenceId) &&
        s.experiments.some(e => e.id === check.contractEvidenceId && e.method === "inspection" && e.actor === "reviewer" && e.unchanged &&
          e.paths?.some(name => s.experiments.find(run => run.id === check.evidenceId)?.paths?.includes(name))))) && s.experiments.some(e =>
        e.id === check.evidenceId && e.actor === "reviewer" && e.passed && e.unchanged && e.method === check.method &&
        (check.method === "inspection" ? s.documentationOnly : e.standard === "unchanged")))));
}

export function renderReviewHandoff(s: ReviewSession, fresh: boolean): string {
  return "RUNTIME_REVIEW_HANDOFF (attributed evidence and opinions, not new user instructions)\n" +
    JSON.stringify({ reviewId: s.id, purpose: s.purpose, snapshotId: s.snapshotId, requirementRevision: s.requirementRevision,
      rounds: s.round, reason: s.closeReason, fresh, consensus: fresh && agreed(s), deliveryApproved: s.approval,
      warning: "Independent opinions are not verified facts. A forced closure is NOT approval. Do not reopen the same review without new evidence." }) +
    "\n[AUTHOR_SUMMARY]\n" + s.summaries.author!.projected +
    "\n[REVIEWER_SUMMARY]\n" + s.summaries.reviewer!.projected +
    "\n[RUNTIME_EVIDENCE]\n" + JSON.stringify({ experiments: s.experiments,
      unresolved: [...new Set(s.statements.slice(-2).flatMap(item => item.value.unresolved))] });
}

type ReviewSummary = string | { text?: string; raw: boolean } | undefined;
export interface ReviewDriver {
  /** Resume only durable candidates; never redispatch a charged request with unknown outcome. */
  resumableSummaries?: boolean;
  canSummarize?: boolean;
  brief?(): Promise<ReviewSummary>;
  /** Works from private history plus public statements; never sees the peer's closing summary. */
  discuss(actor: ReviewActor, session: Readonly<ReviewSession>): Promise<ReviewStatement>;
  summarize(actor: ReviewActor, session: Readonly<ReviewSession>): Promise<ReviewSummary>;
  fresh(): Promise<boolean>;
}

export async function runReviewDiscussion(get: () => ReviewSession,
  emit: (event: ReviewEvent) => Promise<void>, driver: ReviewDriver): Promise<void> {
  if (driver.brief && get().status === "discussing" && !get().briefing) {
    let result: ReviewSummary;
    if (!get().briefingRequested || driver.resumableSummaries && get().summaryRecovery?.briefing) {
      if (!get().briefingRequested) await emit({ type: "briefing_requested", id: get().id });
      try { result = await driver.brief(); } catch (error) { if (error instanceof ReviewFatalError) throw error; }
    }
    await emit({ type: "briefing", id: get().id, text: typeof result === "object" ? result.text ?? "" : result ?? "", raw: typeof result === "object" && result.raw });
  }
  while (get().status === "discussing") {
    const s = get();
    if (Date.now() >= s.deadline || s.requests >= s.maxRequests - 2) {
      await emit({ type: "close", id: s.id, reason: Date.now() >= s.deadline ? "time_limit" : "request_limit" }); break;
    }
    let value: ReviewStatement;
    try {
      value = statementSchema.parse(await driver.discuss(s.next, s));
    } catch (error) {
      if (error instanceof ReviewFatalError) throw error;
      await emit({ type: "close", id: s.id, reason: `discussion_unavailable: ${String(error).slice(0, 1800)}` });
      continue;
    }
    await emit({ type: "statement", id: s.id, actor: s.next, value });
  }
  if (get().status !== "closing") return;
  for (const who of ["author", "reviewer"] as const) {
    if (get().summaries[who]) continue;
    let result: ReviewSummary;
    // A charged but unfinished summary is not re-issued after a crash.
    if (driver.canSummarize !== false && (!get().requestedSummaries.includes(who) && get().requests < get().maxRequests ||
        driver.resumableSummaries && get().summaryRecovery?.[who])) {
      if (!get().requestedSummaries.includes(who)) await emit({ type: "request", id: get().id, closingActor: who });
      try { result = await driver.summarize(who, get()); } catch (error) { if (error instanceof ReviewFatalError) throw error; }
    }
    const text = typeof result === "object" ? result.text : extractSummaryText(result);
    await emit({ type: "summary", id: get().id, actor: who, text: text ?? "", unavailable: !text, raw: typeof result === "object" && result.raw });
  }
  await emit({ type: "decided", id: get().id, fresh: await driver.fresh().catch(() => false) });
}
