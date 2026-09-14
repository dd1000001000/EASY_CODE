import { CURRENT_PROTOCOL } from "../protocol/versions.js";
import type { ContextCompactionMetadata, SessionState } from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import type { CompactionBenefitEvaluation } from "./compaction-policy.js";

/**
 * Build the Runtime-owned receipt for an accepted compaction. Model-authored
 * semantic content and Runtime evidence deliberately use separate protocols.
 */
export function createCompactionMetadata(input: {
  readonly state: Readonly<SessionState>;
  readonly sourceStartMessageIndex: number;
  readonly sourceEndMessageIndex: number;
  readonly compactedMessageCount: number;
  readonly benefit: Readonly<CompactionBenefitEvaluation>;
  readonly acceptedAt?: string;
}): ContextCompactionMetadata {
  const source = JSON.stringify(
    input.state.messages.slice(0, input.sourceEndMessageIndex),
  );
  return {
    formatVersion: CURRENT_PROTOCOL.compactionMetadata,
    sourceStartMessageIndex: input.sourceStartMessageIndex,
    sourceEndMessageIndex: input.sourceEndMessageIndex,
    compactedMessageCount: input.compactedMessageCount,
    sourceHistoryHash: `sha256:${sha256(source)}`,
    acceptedAt: input.acceptedAt ?? new Date().toISOString(),
    beforeProjectedChars: input.benefit.beforeProjectedChars,
    afterProjectedChars: input.benefit.afterProjectedChars,
    savedChars: input.benefit.savedChars,
    savingsRatio: input.benefit.savingsRatio,
    postCompactionUtilization: input.benefit.postCompactionUtilization,
    safeWaterlineReached: input.benefit.safeWaterlineReached,
    targetRatio: input.benefit.targetRatio,
  };
}
