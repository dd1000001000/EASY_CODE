import type { SessionState } from "../core/types.js";
import { sha256 } from "../utils/hash.js";

/** Called only for real user/steering events, or an explicitly bound child/review assignment. */
export function recordUserRequirement(state: SessionState, index: number): void {
  if (state.messages[index]?.role !== "user") throw new Error("Requirement must bind a user message");
  state.userMessageIndices = [...new Set([...(state.userMessageIndices ?? userRequirementIndices(state)), index])].sort((a, b) => a - b);
}
export function userRequirementIndices(state: Readonly<SessionState>): number[] {
  const ledger = state.contextIntentLedger;
  // Legacy in-memory states use the independently recorded intent ledger. New journals
  // initialize an empty provenance list, so synthetic user-role messages never enter it.
  const indices = state.userMessageIndices ?? (ledger ? [ledger.latestRequest, ...ledger.activeConstraints,
    ...ledger.userCorrections, ...ledger.supersededRequests].map(q => q.sourceMessageIndex)
    : state.messages.flatMap((m, i) => m.role === "user" && !m.content.trimStart().startsWith("RUNTIME_") ? [i] : []));
  return [...new Set(indices)].filter(i => state.messages[i]?.role === "user").sort((a, b) => a - b);
}
export function requirementScope(state: Readonly<SessionState>): string {
  // Re-entering with the identical requirement is not a fresh capacity incident.
  return sha256(JSON.stringify([...new Set(userRequirementIndices(state).map(i => JSON.stringify(state.messages[i])))]));
}
