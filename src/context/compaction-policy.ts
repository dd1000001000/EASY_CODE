import type { ChatMessage, SessionState } from "../core/types.js";
import {
  activeWorkingSetCharBudget,
  ContextManager,
  estimateMessagesChars,
} from "./manager.js";
import { projectModelInputMessages } from "./micro-compaction.js";
import { runtimeContinuityMessage } from "./runtime-state.js";

/** A voluntary compaction must represent more than a nearly empty tool round. */
export const COMPACTION_MIN_NEW_PROJECTED_CHARS = 8_192;
/** Avoid paying for a summary that barely reduces the next provider request. */
export const COMPACTION_MIN_SAVED_CHARS = 8_192;
export const COMPACTION_MIN_SAVINGS_RATIO = 0.1;
/** Target enough headroom to avoid another compaction a few tool calls later. */
export const COMPACTION_SAFE_WATERLINE_RATIO = 0.55;

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
}

export interface CompactionBenefitInput {
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
  const continuityChars = runtimeContinuityMessage(input.state);
  const protectedChars = continuityChars ? continuityChars.length + 32 : 0;
  const beforeProjectedChars = manager.estimateShortTermChars(beforeState) + protectedChars;
  const newProjectedChars = estimateMessagesChars(projectModelInputMessages(
    beforeState.messages.slice(input.state.compactedMessageCount),
  ));

  const boundaryValid = Number.isInteger(input.compactedMessageCount) &&
    input.compactedMessageCount > input.state.compactedMessageCount &&
    input.compactedMessageCount <= input.candidateMessages.length;
  const candidateState: SessionState = {
    ...input.state,
    messages: [...input.candidateMessages],
    workingSummary: input.summary,
    compactedMessageCount: boundaryValid
      ? input.compactedMessageCount
      : input.state.compactedMessageCount,
  };
  const afterProjectedChars = manager.estimateShortTermChars(candidateState) + protectedChars;
  const savedChars = beforeProjectedChars - afterProjectedChars;
  const savingsRatio = beforeProjectedChars > 0
    ? Math.max(0, savedChars / beforeProjectedChars)
    : 0;
  const budgetChars = activeWorkingSetCharBudget(input.maxContextChars);
  const postCompactionUtilization = afterProjectedChars / budgetChars;
  const safeWaterlineReached =
    postCompactionUtilization <= COMPACTION_SAFE_WATERLINE_RATIO;
  const base = {
    beforeProjectedChars,
    afterProjectedChars,
    newProjectedChars,
    savedChars,
    savingsRatio,
    postCompactionUtilization,
    safeWaterlineReached,
  };

  if (!boundaryValid) return rejection(base, "invalid_boundary");
  if (!input.required && newProjectedChars < COMPACTION_MIN_NEW_PROJECTED_CHARS) {
    return rejection(base, "compaction_cooldown_active");
  }
  if (savedChars <= 0) return rejection(base, "no_compaction_benefit");
  if (
    !input.required &&
    (savedChars < COMPACTION_MIN_SAVED_CHARS ||
      savingsRatio < COMPACTION_MIN_SAVINGS_RATIO)
  ) {
    return rejection(base, "insufficient_compaction_benefit");
  }
  // A candidate that immediately leaves Runtime in the mandatory band would
  // cause a compaction loop. The 55% target remains diagnostic between bands.
  if (postCompactionUtilization >= 0.8) {
    return rejection(base, "unsafe_post_compaction_pressure");
  }
  return { ...base, accepted: true };
}

export function compactionCooldownSatisfied(
  state: Readonly<SessionState>,
  historyEndExclusive: number,
): boolean {
  const end = Math.min(Math.max(0, historyEndExclusive), state.messages.length);
  const projected = projectModelInputMessages(
    state.messages.slice(state.compactedMessageCount, end),
  );
  return estimateMessagesChars(projected) >= COMPACTION_MIN_NEW_PROJECTED_CHARS;
}
