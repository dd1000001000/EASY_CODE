import type { SessionState } from "../core/types.js";
import { sha256 } from "../utils/hash.js";

/** Called only for real user/steering events, or an explicitly bound child/review assignment. */
export function recordUserRequirement(state: SessionState, index: number): void {
  if (state.messages[index]?.role !== "user") throw new Error("Requirement must bind a user message");
  state.userMessageIndices = [...new Set([...state.userMessageIndices, index])].sort((a, b) => a - b);
}
export function userRequirementIndices(state: Readonly<SessionState>): number[] {
  return [...new Set(state.userMessageIndices)]
    .filter(i => state.messages[i]?.role === "user")
    .sort((a, b) => a - b);
}
export function requirementScope(state: Readonly<SessionState>): string {
  // Re-entering with the identical requirement is not a fresh capacity incident.
  return sha256(JSON.stringify([...new Set(userRequirementIndices(state).map(i => JSON.stringify(state.messages[i])))]));
}
