import { z } from "zod";
import type { SessionState, ToolExecutionResult } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { foldReconciliation } from "./reconciliation.js";

const commandSchema = z.object({ commandId: z.string().min(1),
  status: z.enum(["running", "exited", "timed_out", "canceled", "spawn_failed", "policy_denied", "sandbox_unavailable"]),
  exitCode: z.number().nullable(), program: z.string(), args: z.array(z.string()), cwd: z.string(),
  taskId: z.string().optional(),
}).strict();
const assignmentSchema = z.object({ agentId: z.string(), childThreadId: z.string().optional(),
  kind: z.enum(["dag", "standalone"]), taskId: z.string(), taskGraphId: z.string().optional(),
  taskTitle: z.string(), taskDescription: z.string(), completionChecks: z.array(z.string()),
});
export interface PendingOperations {
  commands: Record<string, z.infer<typeof commandSchema>>;
  /** Includes observed terminals so legacy message scans cannot resurrect them. */
  knownCommandIds?: string[];
  children: Record<string, { assignment: z.infer<typeof assignmentSchema>; followUps: string[]; stopRequested?: string }>;
}

/** Older journals kept the returned handle in the model message rather than a
 * dedicated field. Read only actual command-tool results and their paired argv. */
export function legacyRunningCommands(state: Readonly<SessionState>): PendingOperations["commands"] {
  const calls = new Map<string, { name: string; arguments: string }>();
  const running: PendingOperations["commands"] = {};
  for (const message of state.messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) calls.set(call.id, call.function);
      continue;
    }
    if (message.role !== "tool") continue;
    const call = calls.get(message.tool_call_id);
    if (!call || !["start_command", "poll_command", "cancel_command"].includes(call.name)) continue;
    try {
      const data = JSON.parse(message.content)?.data;
      if (typeof data?.commandId !== "string" || typeof data.status !== "string") continue;
      if (["exited", "timed_out", "canceled", "spawn_failed", "policy_denied", "sandbox_unavailable"].includes(data.status)) {
        delete running[data.commandId]; continue;
      }
      if (data.status !== "running") continue;
      const previous = running[data.commandId];
      const args = JSON.parse(call.arguments);
      const parsed = commandSchema.safeParse({ commandId: data.commandId, status: "running", exitCode: null,
        program: data.executed?.program ?? previous?.program ?? args.program,
        args: data.executed?.args ?? previous?.args ?? args.args ?? [],
        cwd: data.executed?.cwd ?? previous?.cwd ?? args.cwd ?? state.workspaceRoot });
      if (parsed.success) running[data.commandId] = parsed.data;
    } catch { /* An opaque tool message is not evidence of a running command. */ }
  }
  for (const id of state.contextOperations?.knownCommandIds ?? []) delete running[id];
  return running;
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
    // Legacy activations without bindings remain represented by the DAG.
    if (payload.subagentAssignment === undefined) return;
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
