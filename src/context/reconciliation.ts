import { z } from "zod";
import type { SessionState, ToolExecutionResult } from "../core/types.js";
import { legacyRunningCommands } from "./pending-operations.js";

export interface ContextReconciliation { workspace: boolean; commands: string[]; children: string[]; dag: boolean }
export function startReconciliation(state: Readonly<SessionState>): ContextReconciliation {
  return { workspace: false, commands: Object.keys({ ...legacyRunningCommands(state), ...state.contextOperations?.commands }),
    children: Object.keys(state.contextOperations?.children ?? {}), dag: !state.taskGraph };
}
export function reconciliationPending(state: Readonly<SessionState>): boolean {
  const r = state.pressureRecovery?.reconciliation;
  return Boolean(r && (!r.workspace || r.commands.length || r.children.length || !r.dag));
}
export function reconciliationGate(state: Readonly<SessionState>, tool: string, input: unknown): ToolExecutionResult | undefined {
  if (!reconciliationPending(state)) return;
  const args = input as Record<string, unknown> | undefined;
  if (["read_file", "search_files", "read_image", "recall_context", "search_context"].includes(tool) ||
      tool === "poll_command" && state.pressureRecovery!.reconciliation!.commands.includes(String(args?.commandId)) ||
      tool === "manage_subagents" && ["status", "wait"].includes(String(args?.action)) ||
      tool === "manage_tasks" && args?.action === "list") return;
  const instruction = "Context reset reconciliation is required before new commands, edits or completion. Inspect current workspace with read_file/search_files, " +
    "poll the original pending command IDs, query child status and list the DAG. Nothing was executed. Remaining checks: " + JSON.stringify(state.pressureRecovery!.reconciliation);
  return { ok: false, summary: instruction, failure: { version: 1, kind: "protocol", code: "context_reconciliation_required",
    execution: "not_started", recovery: "inspect_state", issues: [], instruction } };
}
const observationSchema = z.object({ workspace: z.boolean().optional(), command: z.string().optional(),
  children: z.array(z.string()).optional(), dag: z.boolean().optional() }).strict();
export function reconciliationObservation(state: Readonly<SessionState>, tool: string, result: ToolExecutionResult) {
  if (!reconciliationPending(state)) return;
  const data = result.data as { commandId?: string; status?: string; agents?: { id?: string; agentId?: string }[] } | undefined;
  if (result.ok && ["read_file", "search_files", "read_image"].includes(tool)) return { workspace: true };
  if (tool === "poll_command" && typeof data?.commandId === "string" &&
      ["running", "exited", "timed_out", "canceled", "spawn_failed"].includes(data.status ?? "")) return { command: data.commandId };
  if (result.ok && tool === "manage_subagents" && Array.isArray(data?.agents)) return { children: data.agents.flatMap(a => typeof (a.agentId ?? a.id) === "string" ? [String(a.agentId ?? a.id)] : []) };
  if (result.ok && tool === "manage_tasks") return { dag: true };
}
/** Fold only Runtime-issued observations recorded with the original raw tool result. */
export function foldReconciliation(state: SessionState, tool: string, value: unknown): void {
  if (value === undefined) return;
  const p = observationSchema.parse(value), r = state.pressureRecovery?.reconciliation;
  if (!r) throw new Error("Unbound context reconciliation");
  if (p.workspace && !["read_file", "search_files", "read_image"].includes(tool) || p.command && tool !== "poll_command" ||
      p.children && tool !== "manage_subagents" || p.dag && tool !== "manage_tasks") throw new Error("Invalid reconciliation source");
  if (p.workspace) r.workspace = true;
  if (p.command) r.commands = r.commands.filter(id => id !== p.command);
  if (p.children) r.children = r.children.filter(id => !p.children!.includes(id));
  if (p.dag) r.dag = true;
}
