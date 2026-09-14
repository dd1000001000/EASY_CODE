import { z } from "zod";
import type { SessionState, ToolExecutionResult } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { foldReconciliation } from "./reconciliation.js";

const commandSchema = z.object({ commandId: z.string().min(1),
  status: z.enum(["running", "exited", "timed_out", "canceled", "spawn_failed", "policy_denied", "sandbox_unavailable"]),
  exitCode: z.number().nullable(), program: z.string(), args: z.array(z.string()), cwd: z.string(),
  taskId: z.string().optional(),
}).strict();
const assignmentBase = z.object({ agentId: z.string(), childThreadId: z.string(), environmentId: z.string(),
  taskId: z.string(), taskTitle: z.string(), taskDescription: z.string(), completionChecks: z.array(z.string()),
  provider: z.string(), model: z.string(), thinkingEffort: z.enum(["none", "low", "medium", "high"]),
  requestedIsolation: z.enum(["auto", "shared", "worktree"]), createdAt: z.string(),
});
const assignmentSchema = z.discriminatedUnion("kind", [
  assignmentBase.extend({ kind: z.literal("dag"), taskGraphId: z.string() }).strict(),
  assignmentBase.extend({ kind: z.literal("standalone") }).strict(),
]);
export interface PendingOperations {
  commands: Record<string, z.infer<typeof commandSchema>>;
  /** Includes terminal handles already observed by the Runtime. */
  knownCommandIds?: string[];
  children: Record<string, { assignment: z.infer<typeof assignmentSchema>; followUps: string[]; stopRequested?: string }>;
}

/** Take identity from raw Runtime output, before model-facing truncation. */
export function pendingCommandObservation(tool: string, result: ToolExecutionResult, taskId?: string) {
  if (!["run_command", "start_command", "poll_command", "cancel_command"].includes(tool)) return undefined;
  const data = result.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return undefined;
  const executed = data.executed as Record<string, unknown> | undefined;
  const parsed = commandSchema.safeParse({ commandId: data.commandId, status: data.status, exitCode: data.exitCode,
    program: executed?.program, args: executed?.args, cwd: executed?.cwd, ...(taskId ? { taskId } : {}) });
  return parsed.success ? JSON.parse(redactSensitiveInformation(JSON.stringify(parsed.data))) as z.infer<typeof commandSchema> : undefined;
}

/** Called after tool-result commit in the live loop and from the same Journal event on Resume. */
export function foldPendingOperations(state: SessionState, payload: Record<string, unknown>): void {
  foldReconciliation(state, String(payload.tool), payload.contextReconciliation);
  if (payload.contextCommand !== undefined) {
    if (!["run_command", "start_command", "poll_command", "cancel_command"].includes(String(payload.tool)))
      throw new Error("Invalid command continuity source");
    const command = commandSchema.parse(payload.contextCommand);
    const operations = state.contextOperations ??= { commands: {}, children: {} };
    operations.knownCommandIds = [...new Set([...(operations.knownCommandIds ?? []), command.commandId])];
    if (command.status === "running") operations.commands[command.commandId] = command;
    else delete operations.commands[command.commandId]; // Terminal result was observed, not inferred.
  }
  if (payload.tool !== "manage_subagents" || !payload.subagentLifecycle) return;
  const lifecycle = z.object({ action: z.enum(["activate", "observe", "deliver_follow_up", "request_stop"]),
    agentId: z.string(), message: z.string().optional(), reason: z.string().optional() }).parse(payload.subagentLifecycle);
  const operations = state.contextOperations ??= { commands: {}, children: {} };
  if (lifecycle.action === "activate") {
    if (payload.subagentAssignment === undefined) throw new Error("Sub-agent activation is missing its durable assignment binding");
    const assignment = assignmentSchema.parse(payload.subagentAssignment);
    if (assignment.agentId !== lifecycle.agentId) throw new Error("Invalid child continuity binding");
    operations.children[lifecycle.agentId] = { assignment, followUps: [] };
  } else if (lifecycle.action === "observe") delete operations.children[lifecycle.agentId];
  else {
    const child = operations.children[lifecycle.agentId];
    if (!child) return;
    if (lifecycle.action === "deliver_follow_up" && lifecycle.message) child.followUps.push(lifecycle.message);
    if (lifecycle.action === "request_stop") child.stopRequested = lifecycle.reason ?? "requested";
  }
}
