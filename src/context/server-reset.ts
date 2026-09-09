import { z } from "zod";
import type { ChatMessage, EventRecord, ModelRequest, SessionState } from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import { completeExchange } from "./exchange-boundary.js";
import { userRequirementIndices, requirementScope } from "./user-requirements.js";
import { startReconciliation } from "./reconciliation.js";
import { runtimeContinuityMessage } from "./runtime-state.js";
export { userRequirementIndices } from "./user-requirements.js";

const schema = z.object({ end: z.number().int().nonnegative(), historyHash: z.string(),
  requirementIndices: z.array(z.number().int().nonnegative()), scope: z.string(), incidentKey: z.string().optional() }).strict();
export type ServerContextReset = z.infer<typeof schema>;

export function capacityResetUsed(state: Readonly<SessionState>): boolean {
  const reset = state.pressureRecovery?.serverReset;
  return Boolean(reset && (reset.incidentKey ?? requirementScope({ ...state, userMessageIndices: reset.requirementIndices })) === requirementScope(state));
}

export function foldServerContextReset(state: SessionState, value: unknown): void {
  const event = schema.parse(value);
  if (event.end !== state.messages.length || event.historyHash !== sha256(JSON.stringify(state.messages)) ||
      JSON.stringify(event.requirementIndices) !== JSON.stringify(userRequirementIndices(state)) || !completeExchange(state.messages) ||
      event.incidentKey !== undefined && (event.incidentKey !== requirementScope(state) || capacityResetUsed(state)))
    throw new Error("Invalid or stale server context reset");
  (state.pressureRecovery ??= { toolReferences: [], summaries: {} }).serverReset = event;
  state.pressureRecovery.reconciliation = startReconciliation(state);
  if (state.workingSummary) state.pressureRecovery.summaries[`journal_summary_${sha256(state.workingSummary)}`] = state.workingSummary;
  state.workingSummary = "";
  state.compactedMessageCount = event.end;
  delete state.contextCompactionMetadata;
  delete state.pressureRecovery.maintenance;
  if (state.compactionControl) {
    if (state.compactionControl.transaction?.status === "pending") state.compactionControl.transaction.status = "superseded";
    state.compactionControl.requested = false; state.compactionControl.seed = undefined;
  }
}

export async function resetServerContext(state: SessionState, turnId: string,
  append: (event: Omit<EventRecord, "schemaVersion" | "sequence" | "timestamp" | "eventId">) => Promise<unknown>): Promise<void> {
  if (capacityResetUsed(state)) throw new Error("context_capacity_insufficient: requirements-only reset already consumed for this capacity incident");
  if (state.messages.some(m => m.role === "user") && !userRequirementIndices(state).length)
    throw new Error("context_capacity_insufficient: user requirement provenance is unavailable; preserve history and pause instead of deleting intent");
  const payload: ServerContextReset = { end: state.messages.length, historyHash: sha256(JSON.stringify(state.messages)),
    requirementIndices: userRequirementIndices(state), scope: turnId, incidentKey: requirementScope(state) };
  await append({ threadId: state.threadId, turnId, type: "context.server_reset", phase: "completed", payload });
  foldServerContextReset(state, payload);
}

/** Request reset is a projection, never deletion of files, facts or execution leases. */
export function resetRequestHistory(request: ModelRequest, requirements?: ChatMessage[]): ModelRequest {
  return { ...request, messages: [
    ...request.messages.filter(m => m.role === "system"),
    ...(requirements ?? request.messages.filter(m => m.role === "user" && !m.content.trimStart().startsWith("RUNTIME_"))),
  ] };
}

export function resetStateRequest(request: ModelRequest, state: Readonly<SessionState>): ModelRequest {
  const reduced = resetRequestHistory(request, userRequirementIndices(state).map(i => state.messages[i]!));
  return { ...reduced, messages: [...reduced.messages, { role: "user", content: runtimeContinuityMessage(state) }] };
}
