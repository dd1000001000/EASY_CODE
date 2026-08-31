import type {
  PlanDraft,
  PlanProposal,
  PlanReviewState,
} from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { loadPromptBundleCatalog } from "../prompt-bundle/index.js";
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

export function sanitizePlanText(value: string): string {
  return redactSensitiveInformation(value)
    .replace(/\r\n?/gu, "\n")
    .replace(UNSAFE_PLAN_CONTROLS, " ")
    .trim();
}

export function normalizePlanDraft(draft: Readonly<PlanDraft>): PlanDraft {
  const title = sanitizePlanText(draft.title);
  const overview = sanitizePlanText(draft.overview);
  if (
    title.length > MAX_PLAN_TITLE_CHARS ||
    overview.length > MAX_PLAN_OVERVIEW_CHARS ||
    draft.steps.length > MAX_PLAN_STEPS
  ) {
    throw new Error("The proposed plan exceeds its documented field limits");
  }
  const steps = draft.steps.map((step) => ({
    title: sanitizePlanText(step.title),
    description: sanitizePlanText(step.description),
    verification: sanitizePlanText(step.verification),
  }));
  if (steps.some((step) =>
    step.title.length > MAX_PLAN_TITLE_CHARS ||
    step.description.length > MAX_PLAN_STEP_DESCRIPTION_CHARS ||
    step.verification.length > MAX_PLAN_STEP_VERIFICATION_CHARS
  )) {
    throw new Error("A proposed plan step exceeds its documented field limits");
  }
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
    feedback: loadPromptBundleCatalog().render(
      "runtime/plan-execution-return.md",
      { outcome: outcomeText },
    ).trimEnd(),
  };
}

export function formatPlanProposal(plan: Readonly<PlanProposal>): string {
  const catalog = loadPromptBundleCatalog();
  const sections = [
    catalog.render("runtime/plan-proposal-header.md", {
      title: plan.title,
      planId: plan.id,
      revision: plan.revision,
      overview: plan.overview,
    }).trimEnd(),
    ...plan.steps.map((step, index) =>
      catalog.render("runtime/plan-proposal-step.md", {
        index: index + 1,
        title: step.title,
        description: step.description,
        verification: step.verification,
      }).trimEnd()
    ),
  ];
  return sections.join("\n\n");
}
