import { z } from "zod";

import type {
  AgentTool,
  PlanDraft,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import {
  MAX_PLAN_OVERVIEW_CHARS,
  MAX_PLAN_STEPS,
  MAX_PLAN_STEP_DESCRIPTION_CHARS,
  MAX_PLAN_STEP_VERIFICATION_CHARS,
  MAX_PLAN_TITLE_CHARS,
  normalizePlanDraft,
} from "../plans/plan.js";
import { toolFailure } from "./base.js";

const boundedPlanText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

export const planStepDraftInputSchema = z
  .object({
    title: boundedPlanText(MAX_PLAN_TITLE_CHARS),
    description: boundedPlanText(MAX_PLAN_STEP_DESCRIPTION_CHARS),
    verification: boundedPlanText(MAX_PLAN_STEP_VERIFICATION_CHARS),
  })
  .strict();

export const proposePlanInputSchema = z
  .object({
    title: boundedPlanText(MAX_PLAN_TITLE_CHARS),
    overview: boundedPlanText(MAX_PLAN_OVERVIEW_CHARS),
    steps: z.array(planStepDraftInputSchema).min(1).max(MAX_PLAN_STEPS),
  })
  .strict();

export type ProposePlanInput = z.infer<typeof proposePlanInputSchema>;

/**
 * Submit a bounded structured plan for Runtime-owned user review.
 * Runtime assigns durable identity and revision metadata after this tool succeeds.
 */
export class ProposePlanTool implements AgentTool {
  readonly name = "propose_plan" as const;
  readonly mutating = false;
  readonly inputSchema = proposePlanInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      description:
        "Submit the complete implementation plan for user review. Use this only in Plan mode and call it by itself. " +
        "Keep every step concrete and ordered, and give each step a verification method. A successful call ends the " +
        "planning turn; Runtime assigns the proposal ID and revision and waits for the user to approve, reject, or adjust it.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PLAN_TITLE_CHARS,
          },
          overview: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PLAN_OVERVIEW_CHARS,
          },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: MAX_PLAN_STEPS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_PLAN_TITLE_CHARS,
                },
                description: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_PLAN_STEP_DESCRIPTION_CHARS,
                },
                verification: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_PLAN_STEP_VERIFICATION_CHARS,
                },
              },
              required: ["title", "description", "verification"],
            },
          },
        },
        required: ["title", "overview", "steps"],
      },
    },
  };

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      if (context.mode !== "plan") {
        throw new Error("propose_plan is available only in Plan mode");
      }
      const parsed: PlanDraft = this.inputSchema.parse(input);
      const planProposal = normalizePlanDraft(parsed);
      return {
        ok: true,
        summary: "Submitted the structured plan for user review.",
        data: {
          title: planProposal.title,
          stepCount: planProposal.steps.length,
        },
        planProposal,
      };
    } catch (error) {
      return toolFailure(error, "Unable to propose the plan");
    }
  }
}
