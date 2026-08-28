import type {
  PlanDraft,
  PlanProposal,
  PlanReviewState,
} from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { createId } from "../utils/ids.js";

export const MAX_PLAN_TITLE_CHARS = 200;
export const MAX_PLAN_OVERVIEW_CHARS = 4_000;
export const MAX_PLAN_STEPS = 24;
export const MAX_PLAN_STEP_DESCRIPTION_CHARS = 2_000;
export const MAX_PLAN_STEP_VERIFICATION_CHARS = 1_000;
export const MAX_PLAN_FEEDBACK_CHARS = 4_000;

export type PlanExecutionReturnOutcome =
  | "failed"
  | "interrupted"
  | "limit_reached";

const UNSAFE_PLAN_CONTROLS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu;

export function sanitizePlanText(value: string, maxChars: number): string {
  return redactSensitiveInformation(value)
    .replace(/\r\n?/gu, "\n")
    .replace(UNSAFE_PLAN_CONTROLS, " ")
    .trim()
    .slice(0, maxChars);
}

export function normalizePlanDraft(draft: Readonly<PlanDraft>): PlanDraft {
  const title = sanitizePlanText(draft.title, MAX_PLAN_TITLE_CHARS);
  const overview = sanitizePlanText(draft.overview, MAX_PLAN_OVERVIEW_CHARS);
  const steps = draft.steps.slice(0, MAX_PLAN_STEPS).map((step) => ({
    title: sanitizePlanText(step.title, MAX_PLAN_TITLE_CHARS),
    description: sanitizePlanText(
      step.description,
      MAX_PLAN_STEP_DESCRIPTION_CHARS,
    ),
    verification: sanitizePlanText(
      step.verification,
      MAX_PLAN_STEP_VERIFICATION_CHARS,
    ),
  }));
  if (!title || !overview || steps.length === 0) {
    throw new Error("A plan requires a title, overview, and at least one step");
  }
  if (steps.some((step) => !step.title || !step.description || !step.verification)) {
    throw new Error("Every plan step requires a title, description, and verification");
  }
  return { title, overview, steps };
}

export function createPlanReviewState(
  draft: Readonly<PlanDraft>,
  turnId: string,
  previous?: Readonly<PlanReviewState>,
  now = new Date(),
): PlanReviewState {
  if (previous?.status === "approved_pending_execution") {
    throw new Error("An approved plan cannot be revised");
  }
  const normalized = normalizePlanDraft(draft);
  const proposal: PlanProposal = {
    ...normalized,
    id: previous?.proposal.id ?? createId("plan"),
    revision: (previous?.proposal.revision ?? 0) + 1,
    proposedByTurnId: turnId,
    proposedAt: now.toISOString(),
  };
  return {
    status: "awaiting_review",
    proposal,
  };
}

export function clonePlanReviewState(value: Readonly<PlanReviewState>): PlanReviewState {
  return {
    ...value,
    proposal: {
      ...value.proposal,
      steps: value.proposal.steps.map((step) => ({ ...step })),
    },
  };
}

/**
 * Return an approved execution to an explicit user review without changing the
 * immutable proposal identity. Executions may have committed partial workspace
 * mutations before ending, so a retry must never be presented as a clean start.
 */
export function returnPlanExecutionToReview(
  value: Readonly<PlanReviewState>,
  outcome: PlanExecutionReturnOutcome,
): PlanReviewState {
  const outcomeText = outcome === "failed"
    ? "failed"
    : outcome === "interrupted"
      ? "was interrupted"
      : "reached its step limit";
  return {
    status: "awaiting_review",
    proposal: clonePlanReviewState(value).proposal,
    feedback:
      `The previously approved execution ${outcomeText}. It may have partially modified ` +
      "the workspace; inspect the current workspace state before approving this plan again.",
  };
}

export function formatPlanProposal(plan: Readonly<PlanProposal>): string {
  const lines = [
    `Plan: ${plan.title}`,
    `Plan ID: ${plan.id} (revision ${plan.revision})`,
    "",
    plan.overview,
    "",
  ];
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    if (!step) continue;
    lines.push(
      `${index + 1}. ${step.title}`,
      `   ${step.description}`,
      `   Verification: ${step.verification}`,
      "",
    );
  }
  return lines.join("\n").trimEnd();
}
