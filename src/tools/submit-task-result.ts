import { z } from "zod";

import type {
  AgentTool,
  TaskNode,
  ToolContext,
  ToolDefinition,
} from "../core/types.js";
import {
  MAX_SUBAGENT_EVIDENCE_CHARS,
  MAX_SUBAGENT_SUMMARY_CHARS,
  sanitizeSubagentText,
  type SubagentTaskReport,
  type SubagentTaskReportExecutionResult,
} from "../subagents/types.js";
import { toolFailure } from "./base.js";

const MAX_SUBAGENT_COMPLETION_EVIDENCE = 16;

function boundedAgentText(maximum: number): z.ZodPipeline<
  z.ZodEffects<z.ZodString, string, string>,
  z.ZodString
> {
  return z
    .string()
    .max(maximum)
    .transform(sanitizeSubagentText)
    .pipe(z.string().min(1).max(maximum));
}

export const submitTaskResultInputSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      summary: boundedAgentText(MAX_SUBAGENT_SUMMARY_CHARS),
      evidence: z
        .array(boundedAgentText(MAX_SUBAGENT_EVIDENCE_CHARS))
        .min(1)
        .max(MAX_SUBAGENT_COMPLETION_EVIDENCE),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("blocked"),
      summary: boundedAgentText(MAX_SUBAGENT_SUMMARY_CHARS),
      blocker: boundedAgentText(MAX_SUBAGENT_EVIDENCE_CHARS),
    })
    .strict(),
]);

export type SubmitTaskResultInput = z.infer<typeof submitTaskResultInputSchema>;

type BoundTask = Pick<TaskNode, "id" | "status" | "completionChecks">;

/**
 * Child-only terminal protocol. Runtime binds the assignment at construction,
 * so the model cannot choose an agent ID or complete different work.
 */
export class SubmitTaskResultTool implements AgentTool {
  readonly name = "submit_task_result" as const;
  readonly mutating = true;
  readonly inputSchema = submitTaskResultInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      description:
        "Submit the terminal result for the single assignment bound to this child agent. " +
        "Use completed only after satisfying every declared completion check with exactly one " +
        "concise evidence item per check, in the same order. Use blocked only for a concrete " +
        "external condition. This tool is child-only, must be called by itself, and does not " +
        "accept a task or agent ID.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          outcome: {
            type: "string",
            enum: ["completed", "blocked"],
          },
          summary: {
            type: "string",
            minLength: 1,
            maxLength: MAX_SUBAGENT_SUMMARY_CHARS,
            description:
              "A bounded, self-contained result for the parent. Do not include hidden reasoning or secrets.",
          },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: MAX_SUBAGENT_COMPLETION_EVIDENCE,
            items: {
              type: "string",
              minLength: 1,
              maxLength: MAX_SUBAGENT_EVIDENCE_CHARS,
            },
            description:
              "Required for completed. Exactly one concrete item per bound completion check, in order.",
          },
          blocker: {
            type: "string",
            minLength: 1,
            maxLength: MAX_SUBAGENT_EVIDENCE_CHARS,
            description: "Required for blocked. The unresolved external condition.",
          },
        },
        required: ["outcome", "summary"],
      },
    },
  };

  private readonly task: BoundTask;

  constructor(task: Readonly<TaskNode>) {
    this.task = {
      id: task.id,
      status: task.status,
      completionChecks: [...task.completionChecks],
    };
  }

  async execute(
    input: unknown,
    context: ToolContext,
  ): Promise<SubagentTaskReportExecutionResult> {
    try {
      if (context.mode === "plan") {
        throw new Error("submit_task_result is unavailable in Plan mode");
      }
      if (this.task.status !== "in_progress") {
        throw new Error(`Bound task ${this.task.id} is not in progress`);
      }
      const parsed = this.inputSchema.parse(input);
      let report: SubagentTaskReport;
      if (parsed.outcome === "completed") {
        if (parsed.evidence.length !== this.task.completionChecks.length) {
          throw new Error(
            `Task ${this.task.id} requires exactly ` +
              `${this.task.completionChecks.length} completion evidence item(s)`,
          );
        }
        report = {
          taskId: this.task.id,
          outcome: "completed",
          summary: parsed.summary,
          completionEvidence: this.task.completionChecks.map((check, index) => ({
            check,
            evidence: parsed.evidence[index] as string,
          })),
        };
      } else {
        report = {
          taskId: this.task.id,
          outcome: "blocked",
          summary: parsed.summary,
          blocker: parsed.blocker,
        };
      }

      return {
        ok: true,
        summary:
          report.outcome === "completed"
            ? `Submitted completion evidence for task ${report.taskId}.`
            : `Submitted a blocker for task ${report.taskId}.`,
        data: {
          taskId: report.taskId,
          outcome: report.outcome,
          ...(report.outcome === "completed"
            ? { evidenceCount: report.completionEvidence.length }
            : {}),
        },
        subagentTaskReport: report,
      };
    } catch (error) {
      return toolFailure(error, "Unable to submit the bound task result");
    }
  }
}
