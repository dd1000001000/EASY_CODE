import { CommandEnvironmentQuarantined } from "../sandbox/environment-fault.js";
import { isSubagentTaskGraphSource, subagentLifecycleSource } from "../subagents/tool-names.js";
import type {
  AgentTool,
  FunctionToolCall,
  SessionState,
  SubagentAssignmentSnapshot,
  SubagentLifecycleUpdate,
  TaskGraph,
  ToolExecutionResult,
  ToolName,
} from "../core/types.js";
import {
  subagentTaskOperationSchema,
  validateSubagentTaskTransition,
  validateTaskGraphTransition,
  type SubagentTaskOperation,
  type TaskGraphTransitionOperation,
} from "../tasks/task-graph.js";
import { toolFailure } from "../tools/base.js";
import { normalizeToolFailure, protocolToolFailure } from "../tools/errors.js";
import type { ToolRecoveryBudget } from "./tool-recovery.js";

// The stages of AgentRuntime.executeToolCall that decide what a tool call may do without touching
// Runtime dependencies: gating before execution, and validating the effects a result claims.

/** What invoking (or refusing) one tool call produced, before its claimed effects are validated. */
export interface ToolInvocationOutcome {
  result: ToolExecutionResult;
  displayName: string;
  taskGraphOperation?: TaskGraphTransitionOperation;
  /** A child reservation made during invocation; rolled back if the call ultimately fails. */
  preparedSubagentLifecycle?: SubagentLifecycleUpdate;
}

/** A validated tool result and the session changes it is allowed to apply. */
export interface ToolEffects {
  result: ToolExecutionResult;
  taskGraphUpdate?: TaskGraph;
  subagentTaskOperation?: SubagentTaskOperation;
  planReviewUpdate?: SessionState["planReview"];
}

/** Reject a call without executing it when the environment, batching rules or tool exposure forbid it. */
export function gateToolCall(
  gate: { environmentFault: string | undefined; proposePlanBatched: boolean; submitTaskResultBatched: boolean },
  call: FunctionToolCall,
  tool: AgentTool | undefined,
): ToolInvocationOutcome | undefined {
  const gated = (result: ToolExecutionResult): ToolInvocationOutcome => ({
    result,
    displayName: call.function.name,
  });
  if (gate.environmentFault && tool?.mutating) {
    return gated(
      toolFailure(
        new CommandEnvironmentQuarantined(gate.environmentFault),
        "Tool skipped: environment quarantined; task paused.",
      ),
    );
  }
  if (gate.proposePlanBatched) {
    return gated({
      ok: false,
      summary: "propose_plan must be the only tool call in a model response.",
      error: "propose_plan_must_be_exclusive",
    });
  }
  if (gate.submitTaskResultBatched) {
    return gated({
      ok: false,
      summary: "submit_task_result must be the only tool call in a model response.",
      error: "submit_task_result_must_be_exclusive",
    });
  }
  if (!tool) {
    return gated({
      ok: false,
      summary: `Tool ${call.function.name} is not available in the current mode.`,
      error: "tool_not_available",
      failure: protocolToolFailure(
        "tool_not_available",
        "Use only currently exposed tools. This call was not executed; permissions have not changed.",
      ),
    });
  }
  return undefined;
}

/** Only an authorized manage_tasks, spawn_subagent or observe_subagents call may update the task DAG, and manage_tasks must. */
export function validateTaskGraphEffect(
  state: SessionState,
  turnId: string,
  toolName: ToolName,
  taskGraphOperation: TaskGraphTransitionOperation | undefined,
  result: ToolExecutionResult,
): { result: ToolExecutionResult; taskGraphUpdate?: TaskGraph; subagentTaskOperation?: SubagentTaskOperation } {
  let subagentTaskOperation: SubagentTaskOperation | undefined;
  if (result.ok && result.taskGraphUpdate) {
    try {
      if (toolName === "manage_tasks" && taskGraphOperation) {
        return {
          result,
          taskGraphUpdate: validateTaskGraphTransition(
            state.taskGraph,
            taskGraphOperation,
            result.taskGraphUpdate,
            turnId,
          ),
        };
      }
      if (isSubagentTaskGraphSource(toolName) && result.subagentTaskOperation) {
        subagentTaskOperation = subagentTaskOperationSchema.parse(result.subagentTaskOperation);
        return {
          result,
          subagentTaskOperation,
          taskGraphUpdate: validateSubagentTaskTransition(
            state.taskGraph,
            subagentTaskOperation,
            result.taskGraphUpdate,
            turnId,
          ),
        };
      }
      throw new Error(
        "Only an authorized manage_tasks, spawn_subagent or observe_subagents call may update the task DAG",
      );
    } catch (error) {
      return {
        result: {
          ok: false,
          summary: "Runtime rejected an invalid task DAG transition.",
          error: error instanceof Error ? error.message : String(error),
        },
        subagentTaskOperation,
      };
    }
  }
  if (result.ok && taskGraphOperation) {
    return {
      result: {
        ok: false,
        summary: "Runtime rejected a missing task DAG transition.",
        error: "manage_tasks did not return an authoritative task DAG update",
      },
    };
  }
  return { result };
}

function isSubagentAssignmentSnapshot(value: unknown): value is SubagentAssignmentSnapshot {
  if (!value || typeof value !== "object") return false;
  const assignment = value as Partial<SubagentAssignmentSnapshot>;
  return (
    (assignment.kind === "dag" || assignment.kind === "standalone") &&
    typeof assignment.agentId === "string" &&
    assignment.agentId.length > 0 &&
    (assignment.displayName === undefined ||
      (typeof assignment.displayName === "string" && assignment.displayName.length > 0)) &&
    typeof assignment.taskId === "string" &&
    assignment.taskId.length > 0 &&
    typeof assignment.taskTitle === "string" &&
    assignment.taskTitle.length > 0 &&
    typeof assignment.taskDescription === "string" &&
    assignment.taskDescription.length > 0 &&
    Array.isArray(assignment.completionChecks) &&
    assignment.completionChecks.length > 0 &&
    assignment.completionChecks.every((check) => typeof check === "string" && check.length > 0) &&
    typeof assignment.provider === "string" &&
    typeof assignment.model === "string" &&
    (assignment.thinkingEffort === "none" ||
      assignment.thinkingEffort === "low" ||
      assignment.thinkingEffort === "medium" ||
      assignment.thinkingEffort === "high") &&
    typeof assignment.createdAt === "string" &&
    (assignment.kind === "standalone" ||
      (typeof assignment.taskGraphId === "string" && assignment.taskGraphId.length > 0))
  );
}

/** Why a child lifecycle transition does not match its Runtime binding and task-DAG transition, if it does not. */
export function subagentLifecycleError(
  toolName: ToolName,
  lifecycle: SubagentLifecycleUpdate,
  assignment: ToolExecutionResult["subagentAssignment"],
  taskGraphUpdate: TaskGraph | undefined,
  subagentTaskOperation: SubagentTaskOperation | undefined,
): string | undefined {
  const source = subagentLifecycleSource(lifecycle.action);
  if (toolName !== source) return `Only ${source} may record the ${lifecycle.action} child lifecycle transition`;
  if (lifecycle.action !== "activate" && lifecycle.action !== "observe") {
    return taskGraphUpdate || subagentTaskOperation || assignment
      ? "Follow-up and stop lifecycle transitions must not alter the child binding or task DAG"
      : undefined;
  }
  if (!isSubagentAssignmentSnapshot(assignment) || assignment.agentId !== lifecycle.agentId) {
    return "The child lifecycle transition is missing its exact Runtime binding";
  }
  if (assignment.kind === "dag") {
    if (
      !taskGraphUpdate ||
      !subagentTaskOperation ||
      assignment.taskGraphId !== taskGraphUpdate.id ||
      assignment.taskId !== subagentTaskOperation.taskId ||
      assignment.agentId !== subagentTaskOperation.agentId ||
      (lifecycle.action === "activate" && subagentTaskOperation.action !== "claim") ||
      (lifecycle.action === "observe" && subagentTaskOperation.action === "claim")
    ) {
      return "A DAG child lifecycle transition requires its matching authoritative task-DAG transition";
    }
    return undefined;
  }
  return taskGraphUpdate || subagentTaskOperation
    ? "A standalone child lifecycle transition must not update the task DAG"
    : undefined;
}

/**
 * Normalize a failure and charge the shared correction budget. Reports an environment fault that
 * quarantines later mutations, and the tool whose correction budget ran out.
 */
export function recoverToolFailure(
  toolRecovery: ToolRecoveryBudget,
  toolName: ToolName,
  validated: ToolExecutionResult,
): {
  result: ToolExecutionResult;
  environmentFault?: string;
  exhaustion?: { tool: string; attempt: number };
} {
  let result = normalizeToolFailure(validated);
  let environmentFault: string | undefined;
  let exhaustion: { tool: string; attempt: number } | undefined;
  if (toolName === "write_memory" && !result.ok && result.failure) {
    // Long-term memory is a best-effort projection of completed work. A
    // malformed or unsupported proposal must never consume the shared
    // tool-protocol budget or turn a successfully completed coding task
    // into a paused task. Keep the per-call failure visible, skip only
    // that proposal, and let the model deliver its result.
    result = {
      ...result,
      failure: {
        ...result.failure,
        recovery: "none",
        instruction:
          `${result.failure.instruction} This memory proposal was skipped. ` +
          "Do not retry it solely for memory maintenance; continue the task or provide the final answer.",
      },
    };
    toolRecovery.succeed(toolName);
  }
  if (result.failure?.code === "command_environment_quarantined") {
    environmentFault = result.error ?? result.failure.instruction;
  }
  if (result.ok) toolRecovery.succeed(toolName);
  // Ordinary tools share field-level repair guidance; mutations are never auto-replayed.
  // Internal context maintenance owns its own durable correction budget.
  if (result.failure?.recovery === "correct_arguments") {
    const recovery = toolRecovery.fail(toolName);
    result = {
      ...result,
      failure: {
        ...result.failure,
        instruction: `${result.failure.instruction} Correction attempts remaining: ${recovery.remaining}.`,
        ...(recovery.remaining === 0 ? { recovery: "none" as const } : {}),
      },
    };
    if (recovery.remaining === 0) exhaustion = { tool: toolName, attempt: recovery.attempt };
  }
  return { result, environmentFault, exhaustion };
}
