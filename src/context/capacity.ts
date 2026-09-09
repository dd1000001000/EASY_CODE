import type { SessionState } from "../core/types.js";
import type { ContextManager } from "./manager.js";
import { exactContext, type NormalRequestEnvelope } from "./context-request.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { sha256 } from "../utils/hash.js";
import { requirementScope } from "./user-requirements.js";

/** All recovery paths assess the NEXT NORMAL request, including its tools. */
export function assessCapacity(manager: ContextManager, state: SessionState, maxContextChars: number,
  envelope: NormalRequestEnvelope, limits: Readonly<RuntimeLimits> = manager.runtimeLimits) {
  const messages = exactContext(state, envelope);
  const inspection = manager.inspectProviderRequest({ state, maxContextChars, messages, tools: envelope.tools });
  const usage = manager.tokenCapacity
    ? (inspection.estimatedInputTokens ?? 0) + (envelope.reservedTokens ?? 0)
    : inspection.providerInputChars;
  // In character-only mode leave room for growth too. This is an estimate,
  // never a claim that maxContextChars describes a model's native token window.
  const capacity = manager.tokenCapacity?.inputCapacity ??
    Math.floor(manager.activeCharBudget(maxContextChars) * (1 - limits.contextToolReserveRatio - limits.contextSafetyReserveRatio));
  const utilization = usage / capacity;
  return { messages, usage, capacity, utilization, fits: utilization <= 1,
    targetReached: utilization <= limits.contextCompactionTargetRatio,
    unit: manager.tokenCapacity ? "tokens" as const : "characters" as const };
}

export function contextHistoryHash(state: Readonly<SessionState>): string {
  return sha256(JSON.stringify(state.messages));
}

export function contextRequestKey(manager: ContextManager, maxContextChars: number, envelope: NormalRequestEnvelope,
  limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS): string {
  return sha256(JSON.stringify([envelope, manager.tokenCapacity, maxContextChars,
    limits.contextCompactionTriggerRatio, limits.contextCompactionTargetRatio, limits.contextMaxRebasesPerRequest,
    limits.contextReferenceTriggerRatio, limits.contextReferenceTargetRatio, limits.contextRecallProtectionExchanges,
    limits.compactionRetainRecentExchanges, limits.contextToolReferenceMinChars, limits.contextToolBatchTokens]));
}

/** Stable across Resume and synthetic status messages; new user instructions reset it. */
export function recoveryScope(state: Readonly<SessionState>): string {
  return requirementScope(state);
}

export interface CapacityPause {
  code: "context_capacity_exhausted";
  reason: string;
  usage: number;
  capacity: number;
  unit: "tokens" | "characters";
}
