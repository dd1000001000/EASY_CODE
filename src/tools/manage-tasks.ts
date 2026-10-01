import { z } from "zod";

import type { AgentTool, ToolContext, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import {
  MAX_TASK_EVIDENCE_CHARS,
  MAX_TASK_GRAPH_NODES,
  MAX_TASK_REVISION_EDITS,
  MAX_TASK_TEXT_CHARS,
  applyTaskGraphOperation,
  taskGraphRevisionChanges,
  taskGraphOperationSchema,
  taskGraphView,
  type TaskGraphRevisionChanges,
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
    case "revise":
      return "Revised the task DAG.";
    case "list":
      return "Returned the current task DAG.";
  }
}

function revisionSummary(changes: TaskGraphRevisionChanges): string {
  const parts = [
    changes.added.length ? `added ${changes.added.join(", ")}` : "",
    changes.removed.length ? `removed ${changes.removed.join(", ")}` : "",
    changes.updated.length ? `updated ${changes.updated.join(", ")}` : "",
    changes.goalChanged ? "changed the goal" : "",
  ].filter(Boolean);
  const restart = changes.returnedToPending.length
    ? ` Returned ${changes.returnedToPending.join(", ")} to pending; start a task again before using work tools.`
    : "";
  return `Revised the task DAG: ${parts.join("; ") || "no structural change"}.${restart}`;
}

const TASK_ID_JSON_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,39}$";

const taskDefinitionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      pattern: TASK_ID_JSON_PATTERN,
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
        pattern: TASK_ID_JSON_PATTERN,
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
};

const { id: _taskIdJsonSchema, ...taskPatchJsonProperties } = taskDefinitionJsonSchema.properties;

const taskEditJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    op: { type: "string", enum: ["add_task", "update_task", "remove_task", "set_goal"] },
    task: taskDefinitionJsonSchema,
    taskId: { type: "string", pattern: TASK_ID_JSON_PATTERN },
    patch: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: taskPatchJsonProperties,
    },
    rewire: { type: "string", enum: ["inherit"] },
    goal: { type: "string", minLength: 1, maxLength: MAX_TASK_TEXT_CHARS },
  },
  required: ["op"],
};

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
            enum: ["create", "list", "start", "complete", "block", "resume", "revise"],
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
            items: taskDefinitionJsonSchema,
          },
          taskId: {
            type: "string",
            pattern: TASK_ID_JSON_PATTERN,
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
          edits: {
            type: "array",
            minItems: 1,
            maxItems: MAX_TASK_REVISION_EDITS,
            items: taskEditJsonSchema,
          },
          kind: {
            type: "string",
            enum: ["dependency", "user_input", "environment", "review", "implementation"],
          },
          recoverable: { type: "boolean" },
          evidenceRefs: {
            type: "array",
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: MAX_TASK_EVIDENCE_CHARS },
          },
        },
        required: ["action"],
      }),
    },
  };

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      const parsed = this.inputSchema.parse(input);
      if (context.selectedMode === "auto") {
        throw new Error("Task DAG operations require an explicitly selected Plan or Code mode");
      }
      if (
        context.taskGraph &&
        context.taskGraph.status !== "completed" &&
        context.selectedMode &&
        context.selectedMode !== context.mode
      ) {
        throw new Error("Finish the current task DAG before switching modes");
      }
      if (parsed.action === "create") {
        if (
          context.commandExecutionMode === "manual" ||
          (context.isOrchestrationEnabled?.() ?? context.orchestrationEnabled) === false
        )
          throw new Error(
            "DAG creation requires orchestration and at least independent approval. Enable with /orchestration.",
          );
        if (context.limits && parsed.tasks.length > context.limits.maxDagNodes) {
          throw new Error(`DAG exceeds the configured ${context.limits.maxDagNodes}-node limit`);
        }
      }
      if (parsed.action === "list") {
        return context.taskGraph
          ? toolSuccess(summaryFor(parsed.action, context.taskGraph.status), {
              graph: taskGraphView(context.taskGraph),
            })
          : toolSuccess("No task DAG exists in this thread.", { graph: null });
      }

      if (parsed.action === "revise" && context.limits && parsed.edits.length > context.limits.maxDagRevisionEdits) {
        throw new Error(
          `A revise exceeds the configured ${context.limits.maxDagRevisionEdits}-edit limit; split it into smaller revisions`,
        );
      }
      const next = applyTaskGraphOperation(context.taskGraph, parsed, {
        turnId: context.turnId,
      });
      if (parsed.action === "revise" && context.limits && next.tasks.length > context.limits.maxDagNodes) {
        throw new Error(`DAG exceeds the configured ${context.limits.maxDagNodes}-node limit`);
      }
      const changes =
        parsed.action === "revise" && context.taskGraph ? taskGraphRevisionChanges(context.taskGraph, next) : undefined;
      return {
        ...toolSuccess(changes ? revisionSummary(changes) : summaryFor(parsed.action, next.status), {
          graph: taskGraphView(next),
          ...(changes ? { changes } : {}),
        }),
        taskGraphUpdate: next,
      };
    } catch (error) {
      return toolFailure(error, "Unable to manage the task DAG");
    }
  }
}
