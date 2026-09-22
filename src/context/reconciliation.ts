import { z } from "zod";
import type { SessionState, ToolExecutionResult } from "../core/types.js";

/**
 * Only process-local operations can become uncertain after a provider-side
 * context reset. Workspace and DAG state are already durable projections, so
 * rereading them is useful investigation rather than a Runtime admission gate.
 */
export interface ContextReconciliation { commands: string[]; children: string[] }
export function startReconciliation(state: Readonly<SessionState>): ContextReconciliation {
  return { commands: Object.keys(state.contextOperations?.commands ?? {}),
    children: Object.keys(state.contextOperations?.children ?? {}) };
}
export function reconciliationPending(state: Readonly<SessionState>): boolean {
  const r = state.pressureRecovery?.reconciliation;
  return Boolean(r && (r.commands.length || r.children.length));
}
export function reconciliationGate(state: Readonly<SessionState>, tool: string, input: unknown): ToolExecutionResult | undefined {
  if (!reconciliationPending(state)) return;
  const args = input as Record<string, unknown> | undefined;
  if (tool === "poll_command" && state.pressureRecovery!.reconciliation!.commands.includes(String(args?.commandId)) ||
      tool === "manage_subagents" && ["status", "wait"].includes(String(args?.action)) ||
      ["read_file", "read_document", "search_files", "read_image", "recall_context", "search_context"].includes(tool)) return;
  const instruction = "Observe the original pending command IDs and child assignments before starting new side effects. " +
    "Durable workspace and DAG state do not need mechanical reinspection. Nothing was executed. Remaining checks: " +
    JSON.stringify(state.pressureRecovery!.reconciliation);
  return { ok: false, summary: instruction, failure: { version: 1, kind: "protocol", code: "context_reconciliation_required",
    execution: "not_started", recovery: "inspect_state", issues: [], instruction } };
}
const observationSchema = z.object({ command: z.string().optional(),
  children: z.array(z.string()).optional() }).strict();
export function reconciliationObservation(state: Readonly<SessionState>, tool: string, result: ToolExecutionResult) {
  if (!reconciliationPending(state)) return;
  const data = result.data as { commandId?: string; status?: string; agents?: { id?: string; agentId?: string }[] } | undefined;
  if (tool === "poll_command" && typeof data?.commandId === "string" &&
      ["running", "exited", "timed_out", "canceled", "spawn_failed"].includes(data.status ?? "")) return { command: data.commandId };
  if (result.ok && tool === "manage_subagents" && Array.isArray(data?.agents)) return { children: data.agents.flatMap(a => typeof (a.agentId ?? a.id) === "string" ? [String(a.agentId ?? a.id)] : []) };
}
/** Fold only Runtime-issued observations recorded with the original raw tool result. */
export function foldReconciliation(state: SessionState, tool: string, value: unknown): void {
  if (value === undefined) return;
  const p = observationSchema.parse(value), r = state.pressureRecovery?.reconciliation;
  if (!r) throw new Error("Unbound context reconciliation");
  if (p.command && tool !== "poll_command" || p.children && tool !== "manage_subagents")
    throw new Error("Invalid reconciliation source");
  if (p.command) r.commands = r.commands.filter(id => id !== p.command);
  if (p.children) r.children = r.children.filter(id => !p.children!.includes(id));
}
