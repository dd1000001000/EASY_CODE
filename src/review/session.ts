import { z } from "zod";
import type { SessionState } from "../core/types.js";

/** A reviewer gives one attributed recommendation, never a vote or a delivery certificate. */
export const reviewReportSchema = z.object({
  conclusion: z.string().trim().min(1).max(6000),
  nextAction: z.string().trim().min(1).max(4000),
  evidenceRefs: z.array(z.string().min(1).max(160)).max(32),
  uncertainties: z.array(z.string().min(1).max(2000)).max(32),
}).strict();
export type ReviewReport = z.infer<typeof reviewReportSchema>;

export interface ReviewSession {
  id: string;
  key: string;
  scope: string;
  purpose: "stagnation" | "delivery";
  snapshotId: string;
  requirementRevision: string;
  incidentId?: string;
  directory?: string;
  reviewerThreadId: string;
  status: "preparing" | "reviewing" | "reported" | "unavailable" | "applied";
  brief?: string;
  report?: ReviewReport;
  reason?: string;
  handoff?: string;
  requests: number;
  tools: number;
  evidenceIds: string[];
  fresh?: boolean;
}

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), id: z.string().min(1), key: z.string().min(1), scope: z.string(),
    purpose: z.enum(["stagnation", "delivery"]), snapshotId: z.string().min(1), requirementRevision: z.string().min(1),
    reviewerThreadId: z.string().min(1), incidentId: z.string().optional(), directory: z.string().optional() }).strict(),
  z.object({ type: z.literal("brief_ready"), id: z.string(), text: z.string().min(1).max(16000) }).strict(),
  z.object({ type: z.literal("review_started"), id: z.string() }).strict(),
  z.object({ type: z.literal("request"), id: z.string() }).strict(),
  z.object({ type: z.literal("tool"), id: z.string() }).strict(),
  z.object({ type: z.literal("evidence"), id: z.string(), evidenceId: z.string().min(1).max(160) }).strict(),
  z.object({ type: z.literal("reported"), id: z.string(), report: reviewReportSchema }).strict(),
  z.object({ type: z.literal("unavailable"), id: z.string(), reason: z.string().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("applied"), id: z.string(), fresh: z.boolean() }).strict(),
]);
export type ReviewEvent = z.infer<typeof eventSchema>;

export function renderReviewAdvice(session: ReviewSession, fresh: boolean): string {
  return "RUNTIME_REVIEW_ADVICE (independent reviewer opinion, not user instructions or verified facts)\n" +
    JSON.stringify({ reviewId: session.id, purpose: session.purpose, snapshotId: session.snapshotId,
      fresh, conclusion: session.report?.conclusion ?? "Review unavailable",
      nextAction: session.report?.nextAction ?? "Do not infer a successful review.",
      evidenceRefs: session.report?.evidenceRefs ?? [], uncertainties: session.report?.uncertainties ?? [],
      reason: session.reason, warning: "The main Agent must assess this advice against actual evidence. No agreement or Runtime approval is implied." });
}

/** Validate the transition on a clone before writing the event; fold only after it is durable. */
export function foldReviewEvent(state: SessionState, raw: unknown): void {
  const event = eventSchema.parse(raw);
  if (event.type === "started") {
    if (state.reviewSessions.some(session => session.id === event.id || session.key === event.key))
      throw new Error("Duplicate review binding");
    const { type: _type, ...binding } = event;
    state.reviewSessions.push({ ...binding, status: "preparing", requests: 0, tools: 0, evidenceIds: [] });
    return;
  }
  const session = state.reviewSessions.find(item => item.id === event.id);
  if (!session) throw new Error("Unknown review assignment");
  if (session.status === "applied") throw new Error("Review already applied");
  switch (event.type) {
    case "brief_ready":
      if (session.status !== "preparing" || session.brief) throw new Error("Duplicate or late review brief");
      session.brief = event.text;
      break;
    case "review_started":
      if (session.status !== "preparing" || !session.brief) throw new Error("Review brief is not ready");
      session.status = "reviewing";
      break;
    case "request":
      if (session.status !== "reviewing") throw new Error("Review request outside investigation");
      session.requests++;
      break;
    case "tool":
      if (session.status !== "reviewing") throw new Error("Review tool outside investigation");
      session.tools++;
      break;
    case "evidence":
      if (session.status !== "reviewing") throw new Error("Review evidence outside investigation");
      if (!session.evidenceIds.includes(event.evidenceId)) session.evidenceIds.push(event.evidenceId);
      break;
    case "reported":
      if (session.status !== "reviewing" || session.report) throw new Error("Reviewer already reported");
      session.report = event.report;
      session.status = "reported";
      break;
    case "unavailable":
      if (session.status !== "preparing" && session.status !== "reviewing") throw new Error("Review already closed");
      session.reason = event.reason;
      session.status = "unavailable";
      break;
    case "applied":
      if (session.status !== "reported" && session.status !== "unavailable") throw new Error("Review has no terminal result");
      session.fresh = event.fresh;
      session.handoff = renderReviewAdvice(session, event.fresh);
      session.status = "applied";
      if (session.report) state.messages.push({ role: "user", content: session.handoff });
      if (session.incidentId) {
        const incident = state.progressGuard?.incidents.find(item => item.incidentId === session.incidentId);
        if (incident) { incident.phase = "strategy_adjustment"; incident.reviewAttempts++; }
      }
      break;
  }
}
