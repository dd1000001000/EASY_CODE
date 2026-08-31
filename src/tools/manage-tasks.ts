import { z } from "zod";

import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import {
  MAX_TASK_EVIDENCE_CHARS,
  MAX_TASK_GRAPH_NODES,
  MAX_TASK_TEXT_CHARS,
  applyTaskGraphOperation,
  taskGraphOperationSchema,
  taskGraphView,
} from "../tasks/task-graph.js";
import { toolFailure, toolSuccess } from "./base.js";
import { documentToolSchema } from "./metadata.js";

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
      strict: true,
      ...documentToolSchema(this.name, {
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
          },
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: MAX_TASK_GRAPH_NODES,
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
          },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: MAX_TASK_EVIDENCE_CHARS },
          },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TASK_EVIDENCE_CHARS,
          },
        },
        required: ["action"],
      }),
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
