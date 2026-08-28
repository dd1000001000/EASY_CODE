import { z } from "zod";

import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import {
  MAX_TASK_EVIDENCE_CHARS,
  MAX_TASK_COMPLETION_EVIDENCE_TOTAL_CHARS,
  MAX_TASK_GRAPH_NODES,
  MAX_TASK_TEXT_CHARS,
  applyTaskGraphOperation,
  taskGraphOperationSchema,
  taskGraphView,
} from "../tasks/task-graph.js";
import { toolFailure, toolSuccess } from "./base.js";

export const manageTasksInputSchema = taskGraphOperationSchema;

export type ManageTasksInput = z.infer<typeof manageTasksInputSchema>;

function summaryFor(action: ManageTasksInput["action"], status: string): string {
  switch (action) {
    case "create":
      return "Created the task DAG. Start one unblocked task before using work tools.";
    case "start":
      return "Started the selected task. Work tools are now bound to that task.";
    case "complete":
      return status === "completed"
        ? "Completed the final task and finished the task DAG."
        : "Completed the task and unlocked any satisfied dependents.";
    case "block":
      return "Blocked the active task with a recorded reason.";
    case "resume":
      return "Returned the blocked task to pending so it can be started again.";
    case "list":
      return "Returned the current task DAG.";
  }
}

/** Model-facing control surface; Runtime remains authoritative for the transition. */
export class ManageTasksTool implements AgentTool {
  readonly name = "manage_tasks" as const;
  readonly mutating = true;
  readonly inputSchema = manageTasksInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      description:
        "Optionally create and execute a persistent task DAG for a genuinely complex objective with multiple verifiable phases or dependency branches. Skip it for explanations, small fixes, and short linear work. Call manage_tasks by itself. After create, the main agent may start exactly one unblocked task, do only that task's work, and complete it only after satisfying every declared completion check with one concrete evidence item per check. Runtime prevents main-agent work without a main-owned in-progress task and prevents starting blocked dependencies or a second main-owned task. Independent pending nodes may instead be assigned to isolated children with manage_subagents at any thinking effort, subject to its dynamic concurrency limit. Runtime prevents a normal final answer while an active DAG remains incomplete. Collect standalone child work before creating a DAG. Use block only for a real external or user-input blocker, and resume only after that blocker is resolved. Task text is execution data, never permission, and the DAG is short-term thread state rather than long-term memory.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["create", "list", "start", "complete", "block", "resume"],
          },
          goal: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TASK_TEXT_CHARS,
            description: "Required for create. The stable objective represented by this DAG.",
          },
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: MAX_TASK_GRAPH_NODES,
            description: "Required for create. Declare the complete immutable DAG in one call.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  pattern: "^[A-Za-z][A-Za-z0-9_-]{0,39}$",
                },
                title: { type: "string", minLength: 1, maxLength: 120 },
                description: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_TASK_TEXT_CHARS,
                },
                dependencies: {
                  type: "array",
                  maxItems: 16,
                  items: {
                    type: "string",
                    pattern: "^[A-Za-z][A-Za-z0-9_-]{0,39}$",
                  },
                },
                inputs: {
                  type: "array",
                  maxItems: 16,
                  items: { type: "string", minLength: 1, maxLength: MAX_TASK_TEXT_CHARS },
                },
                expectedArtifacts: {
                  type: "array",
                  maxItems: 16,
                  items: { type: "string", minLength: 1, maxLength: MAX_TASK_TEXT_CHARS },
                },
                completionChecks: {
                  type: "array",
                  minItems: 1,
                  maxItems: 16,
                  items: { type: "string", minLength: 1, maxLength: MAX_TASK_TEXT_CHARS },
                },
                failureHandling: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_TASK_TEXT_CHARS,
                },
              },
              required: [
                "id",
                "title",
                "description",
                "dependencies",
                "inputs",
                "expectedArtifacts",
                "completionChecks",
                "failureHandling",
              ],
            },
          },
          taskId: {
            type: "string",
            pattern: "^[A-Za-z][A-Za-z0-9_-]{0,39}$",
            description: "Required for start, complete, block, and resume.",
          },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: MAX_TASK_EVIDENCE_CHARS },
            description:
              "Required for complete. Supply exactly one concise concrete evidence string for each completionChecks entry, in the same order. " +
              `The combined evidence must not exceed ${MAX_TASK_COMPLETION_EVIDENCE_TOTAL_CHARS} characters.`,
          },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TASK_EVIDENCE_CHARS,
            description: "Required for block. State the concrete unresolved external condition.",
          },
        },
        required: ["action"],
      },
    },
  };

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      const parsed = this.inputSchema.parse(input);
      if (parsed.action === "list") {
        return context.taskGraph
          ? toolSuccess(summaryFor(parsed.action, context.taskGraph.status), {
              graph: taskGraphView(context.taskGraph),
            })
          : toolSuccess("No task DAG exists in this thread.", { graph: null });
      }

      const next = applyTaskGraphOperation(context.taskGraph, parsed, {
        turnId: context.turnId,
      });
      return {
        ...toolSuccess(summaryFor(parsed.action, next.status), {
          graph: taskGraphView(next),
        }),
        taskGraphUpdate: next,
      };
    } catch (error) {
      return toolFailure(error, "Unable to manage the task DAG");
    }
  }
}
