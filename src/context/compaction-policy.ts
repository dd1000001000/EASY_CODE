import type { ChatMessage, SessionState } from "../core/types.js";
import {
  ContextManager,
  estimateMessagesChars,
} from "./manager.js";
import { projectModelInputMessages } from "./micro-compaction.js";
import type { ToolDefinition } from "../core/types.js";
import { assessCapacity } from "./capacity.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { requestTokens } from "./token-budget.js";

/** A voluntary compaction must represent more than a nearly empty tool round. */
export const COMPACTION_MIN_NEW_PROJECTED_CHARS = 8_192;
/** Avoid paying for a summary that barely reduces the next provider request. */
export const COMPACTION_MIN_SAVED_CHARS = 8_192;
export const COMPACTION_MIN_SAVINGS_RATIO = 0.1;
/** Target enough headroom to avoid another compaction a few tool calls later. */
export const COMPACTION_SAFE_WATERLINE_RATIO = DEFAULT_RUNTIME_LIMITS.contextCompactionTargetRatio;

export type CompactionRejectionReason =
  | "invalid_boundary"
  | "compaction_cooldown_active"
  | "no_compaction_benefit"
  | "insufficient_compaction_benefit"
  | "unsafe_post_compaction_pressure";

export interface CompactionBenefitEvaluation {
  readonly accepted: boolean;
  readonly rejectionReason?: CompactionRejectionReason;
  readonly beforeProjectedChars: number;
  readonly afterProjectedChars: number;
  readonly newProjectedChars: number;
  readonly savedChars: number;
  readonly savingsRatio: number;
  readonly postCompactionUtilization: number;
  readonly safeWaterlineReached: boolean;
  readonly targetRatio?: number;
}

export interface CompactionBenefitInput {
  /** Legacy call-site hint; every mode now uses the same capacity check. */
  readonly allowConservativeHeadroom?: boolean;
  readonly exactRequest?: boolean;
  readonly candidateIntentLedger?: SessionState["contextIntentLedger"];
  /** Next normal request, not the reduced compact-only tool surface. */
  readonly nextRequest?: { systemPrompt: string; runtimeContext: string; tools: readonly ToolDefinition[]; reservedTokens?: number };
  readonly state: Readonly<SessionState>;
  /** Candidate durable messages, including the compact_context result. */
  readonly candidateMessages: readonly ChatMessage[];
  readonly summary: string;
  readonly compactedMessageCount: number;
  readonly maxContextChars: number;
  /** Excludes the assistant compact_context call from useful new history. */
  readonly historyEndExclusive: number;
  /** Mandatory pressure bypasses cooldown, but never integrity or benefit. */
  readonly required: boolean;
}

function rejection(
  base: Omit<CompactionBenefitEvaluation, "accepted" | "rejectionReason">,
  rejectionReason: CompactionRejectionReason,
): CompactionBenefitEvaluation {
  return { ...base, accepted: false, rejectionReason };
}

/**
 * Simulate the exact post-compaction projection before advancing the durable
 * boundary. This is deliberately deterministic and makes no model call.
 */
export function evaluateCompactionBenefit(
  manager: ContextManager,
  input: CompactionBenefitInput,
): CompactionBenefitEvaluation {
  const historyEndExclusive = Math.min(
    Math.max(input.state.compactedMessageCount, input.historyEndExclusive),
    input.state.messages.length,
  );
  const beforeState: SessionState = {
    ...input.state,
    messages: input.state.messages.slice(0, historyEndExclusive),
  };
  const boundaryValid = Number.isInteger(input.compactedMessageCount) &&
    input.compactedMessageCount > input.state.compactedMessageCount &&
    input.compactedMessageCount <= input.candidateMessages.length;
  const candidateState: SessionState = { ...input.state, messages: [...input.candidateMessages],
    workingSummary: input.summary, contextIntentLedger: input.candidateIntentLedger ?? input.state.contextIntentLedger,
    compactedMessageCount: boundaryValid ? input.compactedMessageCount : input.state.compactedMessageCount };
  const envelope = input.nextRequest ?? { systemPrompt: "", runtimeContext: "", tools: [] };
  const before = assessCapacity(manager, beforeState, input.maxContextChars, envelope);
  const after = assessCapacity(manager, candidateState, input.maxContextChars, envelope);
  const beforeProjectedChars = estimateMessagesChars(before.messages);
  const afterProjectedChars = estimateMessagesChars(after.messages);
  const newProjectedChars = estimateMessagesChars(projectModelInputMessages(
    beforeState.messages.slice(input.state.compactedMessageCount)));
  const savedChars = beforeProjectedChars - afterProjectedChars;
  const saved = before.usage - after.usage;
  const savingsRatio = before.usage > 0 ? Math.max(0, saved / before.usage) : 0;
  const limits = manager.runtimeLimits;
  const newTokens = requestTokens(projectModelInputMessages(beforeState.messages.slice(input.state.compactedMessageCount)));
  const base = { beforeProjectedChars, afterProjectedChars, newProjectedChars, savedChars, savingsRatio,
    postCompactionUtilization: after.utilization, safeWaterlineReached: after.targetReached,
    targetRatio: manager.runtimeLimits.contextCompactionTargetRatio };
  if (!boundaryValid) return rejection(base, "invalid_boundary");
  if (!after.fits) return rejection(base, "unsafe_post_compaction_pressure");
  if (!input.required && newTokens < limits.contextCompactionMinNewTokens) {
    return rejection(base, "compaction_cooldown_active");
  }
  if (saved <= 0) return rejection(base, "no_compaction_benefit");
  if (
    !input.required &&
    (saved < limits.contextCompactionMinSavedTokens * (manager.tokenCapacity ? 1 : 4) ||
      savingsRatio < limits.contextCompactionMinSavingsRatio)
  ) {
    return rejection(base, "insufficient_compaction_benefit");
  }
  return { ...base, accepted: true };
}

export function compactionCooldownSatisfied(
  state: Readonly<SessionState>,
  historyEndExclusive: number,
  limits = DEFAULT_RUNTIME_LIMITS,
): boolean {
  const end = Math.min(Math.max(0, historyEndExclusive), state.messages.length);
  const projected = projectModelInputMessages(
    state.messages.slice(state.compactedMessageCount, end),
  );
  return requestTokens(projected) >= limits.contextCompactionMinNewTokens;
}
