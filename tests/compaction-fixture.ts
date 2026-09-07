export interface CompactionFixtureInput {
  readonly primaryRequestIndex: number;
  readonly primaryRequestText: string;
  /** Latest durable user message may be a steering correction, not the primary request. */
  readonly latestMessageIndex?: number;
  readonly activeConstraints?: Array<{ sourceMessageIndex: number; text: string }>;
  readonly userCorrections?: Array<{ sourceMessageIndex: number; text: string }>;
  readonly supersededRequests?: Array<{ sourceMessageIndex: number; text: string }>;
  readonly currentWork?: string;
  readonly nextStep?: string;
  readonly pendingWork?: string[];
  readonly errorsAndBlockers?: Array<{
    kind: "error" | "blocker";
    message: string;
    evidenceRefIds: string[];
  }>;
}

export function compactionV2Input(input: CompactionFixtureInput) {
  const activeConstraints = input.activeConstraints ?? [];
  const userCorrections = input.userCorrections ?? [];
  const supersededRequests = input.supersededRequests ?? [];
  const coveredMessageIndices = [...new Set([
    input.primaryRequestIndex,
    ...activeConstraints.map((item) => item.sourceMessageIndex),
    ...userCorrections.map((item) => item.sourceMessageIndex),
    ...supersededRequests.map((item) => item.sourceMessageIndex),
  ])].sort((left, right) => left - right);
  return {
    formatVersion: 2,
    primaryRequest: {
      sourceMessageIndex: input.primaryRequestIndex,
      text: input.primaryRequestText,
    },
    activeConstraints,
    technicalDecisions: [],
    filesAndChanges: [],
    verifiedResults: [],
    errorsAndBlockers: input.errorsAndBlockers ?? [],
    pendingWork: input.pendingWork ?? ["Continue the active request."],
    currentWork: input.currentWork ?? "Compacting completed context safely.",
    nextStep: input.nextStep ?? "Continue the active request from the checkpoint.",
    evidenceRefs: [],
    intentLedger: { userCorrections, supersededRequests },
    coverageCheck: {
      coveredMessageIndices,
      latestMessageIndex: input.latestMessageIndex ?? input.primaryRequestIndex,
      latestRequestPreserved: true,
      activeConstraintsPreserved: true,
      activePlanOrTaskPreserved: true,
      unresolvedErrorsPreserved: true,
      currentWorkPreserved: true,
      nextStepPreserved: true,
      note: "Runtime source anchors were checked.",
    },
  };
}

export function persistedCompactionV2Summary(
  input: ReturnType<typeof compactionV2Input>,
): string {
  const { coverageCheck: _coverageCheck, intentLedger: _intentLedger, ...summary } = input;
  return JSON.stringify(summary);
}
