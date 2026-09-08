import { sha256 } from "../utils/hash.js";
import { parseProgressObservation } from "./observation.js";
import {
  MAX_PROGRESS_FAILURE_RUNS,
  MAX_PROGRESS_INCIDENTS,
  MAX_PROGRESS_READ_TARGETS,
  MAX_PROGRESS_SOURCE_EVENTS,
  MAX_PROGRESS_TERMINAL_COMMANDS,
  PROGRESS_FAILURE_THRESHOLD,
  PROGRESS_GUARD_STATE_SCHEMA_VERSION,
  PROGRESS_READ_WARNING_MINIMUM,
  PROGRESS_READ_WARNING_RATIO,
  PROGRESS_READ_WINDOW_RESPONSES,
  type ProgressFailureRun,
  type ProgressFoldReason,
  type ProgressFoldResult,
  type ProgressGuardState,
  type ProgressGuardTrigger,
  type ProgressIncident,
  type ProgressObservation,
  type ProgressReadCoverage,
  type ProgressReadTrigger,
} from "./types.js";

function increment(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function cloneReadCoverage(value: Readonly<ProgressReadCoverage>): ProgressReadCoverage {
  return {
    ...value,
    targets: value.targets.map((target) => ({ ...target })),
  };
}

function cloneFailureRun(value: Readonly<ProgressFailureRun>): ProgressFailureRun {
  return {
    ...value,
    verificationCycleIds: [...value.verificationCycleIds],
    responseOrdinals: [...value.responseOrdinals],
  };
}

function cloneIncident(value: Readonly<ProgressIncident>): ProgressIncident {
  return {
    ...value,
    verificationCycleIds: [...value.verificationCycleIds],
    reviewCachedInputTokens: value.reviewCachedInputTokens ?? 0,
    reviewReasoningTokens: value.reviewReasoningTokens ?? 0,
    reviewDurationMs: value.reviewDurationMs ?? 0,
    reviewStartedRequestOrdinals: [...(value.reviewStartedRequestOrdinals ?? [])],
    reviewFinishedRequestOrdinals: [...(value.reviewFinishedRequestOrdinals ?? [])],
    ...(value.reviewBinding ? { reviewBinding: { ...value.reviewBinding } } : {}),
    ...(value.reviewReport ? { reviewReport: { ...value.reviewReport } } : {}),
    ...(value.experiment ? { experiment: { ...value.experiment } } : {}),
  };
}

export function cloneProgressGuardState(
  state: Readonly<ProgressGuardState>,
): ProgressGuardState {
  return {
    ...state,
    ...(state.investigations ? { investigations: structuredClone(state.investigations) } : {}),
    lastObservedResponseOrdinal: state.lastObservedResponseOrdinal ?? 0,
    seenSourceEventIds: [...state.seenSourceEventIds],
    seenTerminalCommandIds: [...state.seenTerminalCommandIds],
    readCoverage: cloneReadCoverage(state.readCoverage),
    failureRuns: state.failureRuns.map(cloneFailureRun),
    recentReads: state.recentReads.map((entry) => ({ ...entry })),
    recentSearches: (state.recentSearches ?? []).map((entry) => ({ ...entry })),
    ...(state.searchWarning ? { searchWarning: { ...state.searchWarning } } : {}),
    ...(state.readWarning ? { readWarning: { ...state.readWarning } } : {}),
    incidents: state.incidents.map(cloneIncident),
  };
}

function result(
  state: ProgressGuardState,
  accepted: boolean,
  duplicate: boolean,
  reason: ProgressFoldReason,
  trigger?: ProgressGuardTrigger | ProgressReadTrigger,
): ProgressFoldResult {
  return { state, accepted, duplicate, reason, ...(trigger ? { trigger } : {}) };
}

export function createProgressGuardState(): ProgressGuardState {
  return {
    schemaVersion: PROGRESS_GUARD_STATE_SCHEMA_VERSION,
    acceptedObservations: 0,
    duplicateObservations: 0,
    ignoredObservations: 0,
    lastObservedResponseOrdinal: 0,
    seenSourceEventIds: [],
    seenTerminalCommandIds: [],
    readCoverage: {
      totalReads: 0,
      repeatedReads: 0,
      uniqueTargets: 0,
      untrackedReads: 0,
      saturated: false,
      targets: [],
    },
    failureRuns: [],
    recentReads: [],
    incidents: [],
    saturated: false,
  };
}

function stableIncidentId(signature: string, sourceEventId: string): string {
  return `incident_${sha256(`${signature}:${sourceEventId}`).slice(0, 32)}`;
}

function updateReadWindow(
  state: ProgressGuardState,
  observation: Readonly<ProgressObservation>,
): ProgressReadTrigger | undefined {
  if (observation.kind !== "read" || !observation.targetKey) return undefined;
  const identity = `${observation.targetKey}:${observation.outcomeKey ?? "unknown"}`;
  const minimumOrdinal = Math.max(
    0,
    observation.responseOrdinal - PROGRESS_READ_WINDOW_RESPONSES + 1,
  );
  state.recentReads = [
    ...state.recentReads.filter(
      (entry) =>
        entry.scopeKey === observation.scopeKey &&
        entry.responseOrdinal >= minimumOrdinal,
    ),
    {
      sourceEventId: observation.sourceEventId,
      scopeKey: observation.scopeKey,
      responseOrdinal: observation.responseOrdinal,
      identity,
    },
  ].slice(-128);
  if (state.recentReads.length < PROGRESS_READ_WARNING_MINIMUM) {
    if (state.readWarning?.scopeKey === observation.scopeKey) {
      state.readWarning = undefined;
    }
    return undefined;
  }
  const repeatedReads = state.recentReads.length -
    new Set(state.recentReads.map((entry) => entry.identity)).size;
  const repeatedRatio = repeatedReads / state.recentReads.length;
  if (repeatedRatio <= PROGRESS_READ_WARNING_RATIO) {
    if (state.readWarning?.scopeKey === observation.scopeKey) {
      state.readWarning = undefined;
    }
    return undefined;
  }
  if (
    state.readWarning &&
    state.readWarning.scopeKey === observation.scopeKey &&
    state.readWarning.responseOrdinal >= minimumOrdinal
  ) {
    return undefined;
  }
  const warning = {
    id: `read_warning_${sha256(
      `${observation.scopeKey}:${observation.sourceEventId}`,
    ).slice(0, 32)}`,
    sourceEventId: observation.sourceEventId,
    scopeKey: observation.scopeKey,
    responseOrdinal: observation.responseOrdinal,
    totalReads: state.recentReads.length,
    repeatedReads,
    repeatedRatio,
  };
  state.readWarning = warning;
  return { kind: "repeated_reads", warning: { ...warning } };
}

function updateSearchWindow(state: ProgressGuardState, observation: Readonly<ProgressObservation>): void {
  // Keep scopes isolated. Actual file evidence or terminal verification ends this weak discovery warning.
  if (observation.kind === "read" || observation.kind === "verification_terminal") {
    state.recentSearches = (state.recentSearches ?? []).filter((entry) => entry.scopeKey !== observation.scopeKey);
    if (state.searchWarning?.scopeKey === observation.scopeKey) state.searchWarning = undefined;
    return;
  }
  if (observation.tool !== "search_files" || observation.searchRepeatLimit === undefined) return;
  const identity = `${observation.targetKey}:${observation.outcomeKey}`;
  const minimumOrdinal = Math.max(0, observation.responseOrdinal - PROGRESS_READ_WINDOW_RESPONSES + 1);
  const recent = (state.recentSearches ?? []).filter((entry) => entry.responseOrdinal >= minimumOrdinal);
  const previous = recent.filter((entry) => entry.scopeKey === observation.scopeKey);
  // A different result for the same target is new evidence; don't combine stale and current outcomes.
  if (previous.length && previous[previous.length - 1]!.identity !== identity) {
    state.searchWarning = state.searchWarning?.scopeKey === observation.scopeKey ? undefined : state.searchWarning;
  }
  const sameTargetPrefix = `${observation.targetKey}:`;
  state.recentSearches = [...recent.filter((entry) => entry.scopeKey !== observation.scopeKey ||
    !entry.identity.startsWith(sameTargetPrefix) || entry.identity === identity), {
    sourceEventId: observation.sourceEventId, scopeKey: observation.scopeKey,
    responseOrdinal: observation.responseOrdinal, identity,
  }].slice(-128);
  const matching = state.recentSearches.filter((entry) => entry.scopeKey === observation.scopeKey && entry.identity === identity);
  if (matching.length >= observation.searchRepeatLimit) {
    state.searchWarning = { scopeKey: observation.scopeKey, sourceEventId: observation.sourceEventId, count: matching.length };
  } else if (state.searchWarning?.scopeKey === observation.scopeKey) state.searchWarning = undefined;
}

function applyExperimentObservation(
  state: ProgressGuardState,
  observation: Readonly<ProgressObservation>,
): void {
  if (
    observation.kind !== "verification_terminal" ||
    observation.confidence !== "high"
  ) {
    return;
  }
  // Any real terminal verification is new evidence after a weak read-loop hint.
  state.readWarning = undefined;
  const incident = state.incidents.find(
    (candidate) =>
      candidate.scopeKey === observation.scopeKey &&
      candidate.phase === "experiment_required",
  );
  if (!incident) return;
  // Historical reports without a contract may only bind their original target.
  // Modern contracts are matched before execution and carried by commandId.
  if (incident.reviewReport?.experimentProgram
    ? observation.experimentIncidentId !== incident.incidentId
    : observation.targetKey !== incident.targetKey) return;
  const sameVerificationTarget = observation.targetKey === incident.targetKey;
  const verifiedImprovement =
    sameVerificationTarget && observation.outcomeClass === "passed" && comparableStandard(observation, incident.baselineDigest);
  const newEvidence = verifiedImprovement ||
    !sameVerificationTarget ||
    observation.outcomeClass !== incident.outcomeClass ||
    observation.outcomeKey !== incident.outcomeKey;
  incident.experiment = {
    id: `experiment_${sha256(
      `${incident.incidentId}:${observation.sourceEventId}`,
    ).slice(0, 32)}`,
    sourceEventId: observation.sourceEventId,
    sourceCallId: observation.sourceCallId,
    ...(observation.commandId ? { commandId: observation.commandId } : {}),
    outcomeClass: observation.outcomeClass,
    ...(observation.outcomeKey ? { outcomeKey: observation.outcomeKey } : {}),
    newEvidence,
    verifiedImprovement,
    semanticConfirmed: false,
  };
  incident.phase = verifiedImprovement
    ? "resolved"
    : newEvidence
      ? "strategy_adjustment"
      : "review_exhausted";
}

function failureSignature(observation: Readonly<ProgressObservation>): string {
  return `sha256:${sha256(JSON.stringify([
    observation.scopeKey,
    observation.targetKey,
    observation.verificationKind ?? "custom",
    observation.outcomeClass,
    observation.outcomeKey,
    observation.baselineDigest,
  ]))}`;
}

function applyRead(state: ProgressGuardState, observation: Readonly<ProgressObservation>): void {
  if (observation.kind !== "read" || !observation.targetKey) return;
  const coverage = state.readCoverage;
  coverage.totalReads = increment(coverage.totalReads);
  const index = coverage.targets.findIndex(
    (target) => target.targetKey === observation.targetKey,
  );
  if (index >= 0) {
    const previous = coverage.targets[index]!;
    coverage.targets[index] = {
      targetKey: previous.targetKey,
      reads: increment(previous.reads),
      lastResponseOrdinal: observation.responseOrdinal,
    };
    coverage.repeatedReads = increment(coverage.repeatedReads);
    return;
  }
  if (coverage.targets.length >= MAX_PROGRESS_READ_TARGETS) {
    coverage.saturated = true;
    coverage.untrackedReads = increment(coverage.untrackedReads);
    return;
  }
  coverage.targets.push({
    targetKey: observation.targetKey,
    reads: 1,
    lastResponseOrdinal: observation.responseOrdinal,
  });
  coverage.uniqueTargets = increment(coverage.uniqueTargets);
}

function comparableStandard(observation: Readonly<ProgressObservation>, baseline: string | undefined): boolean {
  return observation.standardStatus !== "changed" && observation.standardStatus !== "unknown" && observation.baselineDigest === baseline;
}

function newEvidenceIncident(state: ProgressGuardState, observation: Readonly<ProgressObservation>,
  reason: "investigation_stalled" | "validation_standard_changed"): ProgressIncident | undefined {
  const key = `sha256:${sha256(JSON.stringify([observation.scopeKey, reason, reason === "validation_standard_changed" ? observation.baselineDigest : "investigation"]))}`;
  const previous = state.incidents.find(incident => incident.signature === key);
  if (previous) return previous;
  if (state.incidents.length >= MAX_PROGRESS_INCIDENTS) { state.saturated = true; return undefined; }
  const incident: ProgressIncident = {
    incidentId: stableIncidentId(key, observation.sourceEventId), signature: key, reason,
    scopeKey: observation.scopeKey, targetKey: reason === "investigation_stalled" ? key : observation.targetKey!,
    outcomeKey: observation.outcomeKey ?? key, outcomeClass: "unknown", baselineDigest: observation.baselineDigest,
    triggerSourceEventId: observation.sourceEventId, triggerResponseOrdinal: observation.responseOrdinal,
    verificationCycleIds: [], phase: reason === "investigation_stalled" ? "investigation_suspected" : "review_pending",
    reviewAttempts: 0, validReviews: 0, reviewModelRequests: 0, reviewInputTokens: 0, reviewOutputTokens: 0,
    reviewTotalTokens: 0, reviewCachedInputTokens: 0, reviewReasoningTokens: 0, reviewDurationMs: 0,
    reviewStartedRequestOrdinals: [], reviewFinishedRequestOrdinals: [],
  };
  state.incidents.push(incident);
  return incident;
}

function observeValidationStandard(state: ProgressGuardState, observation: Readonly<ProgressObservation>): void {
  if (observation.kind === "verification_terminal" && observation.standardStatus === "changed") {
    newEvidenceIncident(state, observation, "validation_standard_changed");
  }
}

/** Two non-overlapping response windows. Novel ranges/results interrupt exact
 * repetition, but never certify improvement or reset the incident/review budget. */
function observeInvestigation(state: ProgressGuardState, observation: Readonly<ProgressObservation>): void {
  const policy = observation.investigationPolicy;
  if (!policy) return;
  const isRead = observation.kind === "read" && observation.readRange && observation.outcomeKey;
  const isSearch = observation.tool === "search_files" && observation.searchRepeatLimit !== undefined && observation.outcomeKey;
  const isInspection = observation.kind === "investigation_terminal";
  if (!isRead && !isSearch && !isInspection) {
    if (observation.kind === "verification_terminal" && observation.confidence === "high") {
      const tracker = state.investigations?.find(item => item.scopeKey === observation.scopeKey);
      if (tracker) { tracker.samples = []; tracker.after = observation.responseOrdinal; }
      const incident = state.incidents.find(item => item.scopeKey === observation.scopeKey && item.phase === "investigation_suspected");
      if (incident) incident.phase = "strategy_adjustment"; // An actual experiment, not proof of completion.
    }
    return;
  }
  state.investigations ??= [];
  let tracker = state.investigations.find(item => item.scopeKey === observation.scopeKey);
  if (!tracker) {
    if (state.investigations.length >= 64) return;
    tracker = { scopeKey: observation.scopeKey, after: observation.responseOrdinal - 1, samples: [], sources: [], searches: [] };
    state.investigations.push(tracker);
  }
  if (observation.responseOrdinal <= tracker.after) return;
  let repeated = false;
  if (isRead) {
    const range = observation.readRange!;
    let source = tracker.sources.find(item => item.key === range.fileKey && item.hash === observation.outcomeKey);
    if (!source && tracker.sources.length < 128) {
      source = { key: range.fileKey, hash: observation.outcomeKey!, ranges: [] }; tracker.sources.push(source);
    }
    if (source) {
      repeated = source.ranges.some(([start, end]) => start <= range.start && end >= range.end);
      if (!repeated && source.ranges.length < 64) {
        const ordered = [...source.ranges, [range.start, range.end] as [number, number]].sort((a, b) => a[0] - b[0]);
        source.ranges = [];
        for (const next of ordered) {
          const last = source.ranges.at(-1);
          if (last && next[0] <= last[1] + 1) last[1] = Math.max(last[1], next[1]); else source.ranges.push(next);
        }
      }
    }
  } else {
    repeated = tracker.searches.includes(observation.outcomeKey!);
    if (!repeated && tracker.searches.length < 128) tracker.searches.push(observation.outcomeKey!);
  }
  tracker.samples = [...tracker.samples.filter(item => item.ordinal > observation.responseOrdinal - policy.window),
    { ordinal: observation.responseOrdinal, repeated }].slice(-128);
  if (tracker.samples.length < policy.minimum || observation.responseOrdinal - tracker.after < policy.window ||
      tracker.samples.filter(item => item.repeated).length / tracker.samples.length <= policy.ratio) return;
  const existing = state.incidents.find(item => item.scopeKey === observation.scopeKey && item.reason === "investigation_stalled");
  if (!existing) newEvidenceIncident(state, observation, "investigation_stalled");
  else if (existing.phase === "investigation_suspected" && policy.review) existing.phase = "review_pending";
  tracker.after = observation.responseOrdinal;
  tracker.samples = [];
}

function clearResolvedFailures(
  state: ProgressGuardState,
  observation: Readonly<ProgressObservation>,
): void {
  if (
    observation.kind !== "verification_terminal" ||
    observation.outcomeClass !== "passed" ||
    observation.confidence !== "high" ||
    !observation.targetKey || !comparableStandard(observation, observation.baselineDigest)
  ) {
    return;
  }
  state.failureRuns = state.failureRuns.filter(
    (run) => run.scopeKey !== observation.scopeKey || run.targetKey !== observation.targetKey ||
      !comparableStandard(observation, run.baselineDigest) || state.incidents.some(incident =>
        incident.scopeKey === run.scopeKey && incident.targetKey === run.targetKey &&
        incident.phase === "experiment_required" && incident.reviewReport?.experimentProgram &&
        observation.experimentIncidentId !== incident.incidentId),
  );
  for (const incident of state.incidents) {
    if (
      incident.scopeKey === observation.scopeKey &&
      incident.targetKey === observation.targetKey &&
      incident.phase !== "resolved" && comparableStandard(observation, incident.baselineDigest) &&
      (incident.phase !== "experiment_required" || !incident.reviewReport?.experimentProgram || observation.experimentIncidentId === incident.incidentId) &&
      incident.reason !== "validation_standard_changed"
    ) {
      incident.phase = "resolved";
    }
  }
}

function applyFailure(
  state: ProgressGuardState,
  observation: Readonly<ProgressObservation>,
): { trigger?: ProgressGuardTrigger; duplicateCycle: boolean; saturated: boolean } {
  if (
    observation.kind !== "verification_terminal" ||
    observation.confidence !== "high" ||
    (observation.outcomeClass !== "failed" && observation.outcomeClass !== "timed_out") ||
    !observation.verificationCycleId ||
    !observation.targetKey ||
    !observation.outcomeKey
  ) {
    return { duplicateCycle: false, saturated: false };
  }
  const signature = failureSignature(observation);
  let index = state.failureRuns.findIndex((run) => run.signature === signature);
  if (index < 0) {
    if (state.failureRuns.length >= MAX_PROGRESS_FAILURE_RUNS) {
      return { duplicateCycle: false, saturated: true };
    }
    state.failureRuns.push({
      ...(observation.baselineDigest ? { baselineDigest: observation.baselineDigest } : {}),
      signature,
      scopeKey: observation.scopeKey,
      targetKey: observation.targetKey,
      outcomeKey: observation.outcomeKey,
      outcomeClass: observation.outcomeClass,
      ...(observation.verificationKind
        ? { verificationKind: observation.verificationKind }
        : {}),
      verificationCycleIds: [],
      responseOrdinals: [],
      triggered: false,
    });
    index = state.failureRuns.length - 1;
  }
  const run = state.failureRuns[index]!;
  if (run.verificationCycleIds.includes(observation.verificationCycleId)) {
    return { duplicateCycle: true, saturated: false };
  }
  if (run.triggered) return { duplicateCycle: false, saturated: false };

  const next: ProgressFailureRun = {
    ...run,
    verificationCycleIds: [
      ...run.verificationCycleIds,
      observation.verificationCycleId,
    ].slice(0, PROGRESS_FAILURE_THRESHOLD),
    responseOrdinals: [
      ...run.responseOrdinals,
      observation.responseOrdinal,
    ].slice(0, PROGRESS_FAILURE_THRESHOLD),
    triggered:
      run.verificationCycleIds.length + 1 >= PROGRESS_FAILURE_THRESHOLD,
    ...(run.triggerSourceEventId
      ? { triggerSourceEventId: run.triggerSourceEventId }
      : run.verificationCycleIds.length + 1 >= PROGRESS_FAILURE_THRESHOLD
        ? { triggerSourceEventId: observation.sourceEventId }
        : {}),
  };
  state.failureRuns[index] = next;
  if (!next.triggered) return { duplicateCycle: false, saturated: false };
  if (
    !state.incidents.some((incident) => incident.signature === signature)
  ) {
    if (state.incidents.length >= MAX_PROGRESS_INCIDENTS) {
      return { duplicateCycle: false, saturated: true };
    }
    state.incidents.push({
      reason: "repeated_verified_failure",
      ...(observation.baselineDigest ? { baselineDigest: observation.baselineDigest } : {}),
      incidentId: stableIncidentId(signature, observation.sourceEventId),
      signature,
      scopeKey: observation.scopeKey,
      targetKey: observation.targetKey,
      outcomeKey: observation.outcomeKey,
      outcomeClass: observation.outcomeClass,
      ...(observation.verificationKind
        ? { verificationKind: observation.verificationKind }
        : {}),
      triggerSourceEventId: observation.sourceEventId,
      triggerResponseOrdinal: observation.responseOrdinal,
      verificationCycleIds: [...next.verificationCycleIds],
      phase: "review_pending",
      reviewAttempts: 0,
      validReviews: 0,
      reviewModelRequests: 0,
      reviewInputTokens: 0,
      reviewOutputTokens: 0,
      reviewTotalTokens: 0,
      reviewCachedInputTokens: 0,
      reviewReasoningTokens: 0,
      reviewDurationMs: 0,
      reviewStartedRequestOrdinals: [],
      reviewFinishedRequestOrdinals: [],
    });
  }
  return {
    duplicateCycle: false,
    saturated: false,
    trigger: {
      kind: "repeated_verified_failure",
      signature,
      sourceEventId: observation.sourceEventId,
      scopeKey: observation.scopeKey,
      targetKey: observation.targetKey,
      outcomeKey: observation.outcomeKey,
      outcomeClass: observation.outcomeClass,
      ...(observation.verificationKind
        ? { verificationKind: observation.verificationKind }
        : {}),
      verificationCycleIds: [...next.verificationCycleIds],
    },
  };
}

/**
 * Fold one already-bound observation into a deterministic projection. The
 * function never mutates its input state. Capacity exhaustion fails closed:
 * evidence is ignored instead of evicting de-duplication keys.
 */
export function foldProgressObservation(
  current: Readonly<ProgressGuardState>,
  rawObservation: unknown,
): ProgressFoldResult {
  const observation = parseProgressObservation(rawObservation);
  const state = cloneProgressGuardState(current);

  if (state.seenSourceEventIds.includes(observation.sourceEventId)) {
    state.duplicateObservations = increment(state.duplicateObservations);
    return result(state, false, true, "duplicate_source_event");
  }
  if (state.seenSourceEventIds.length >= MAX_PROGRESS_SOURCE_EVENTS) {
    state.ignoredObservations = increment(state.ignoredObservations);
    state.saturated = true;
    return result(state, false, false, "source_event_capacity");
  }
  state.seenSourceEventIds.push(observation.sourceEventId);
  state.lastObservedResponseOrdinal = Math.max(
    state.lastObservedResponseOrdinal,
    observation.responseOrdinal,
  );

  if (
    observation.commandId &&
    state.seenTerminalCommandIds.includes(observation.commandId)
  ) {
    state.duplicateObservations = increment(state.duplicateObservations);
    return result(state, false, true, "duplicate_terminal_command");
  }
  if (
    observation.commandId &&
    state.seenTerminalCommandIds.length >= MAX_PROGRESS_TERMINAL_COMMANDS
  ) {
    state.ignoredObservations = increment(state.ignoredObservations);
    state.saturated = true;
    return result(state, false, false, "terminal_command_capacity");
  }
  if (observation.commandId) {
    state.seenTerminalCommandIds.push(observation.commandId);
  }

  state.acceptedObservations = increment(state.acceptedObservations);
  observeValidationStandard(state, observation);
  observeInvestigation(state, observation);
  applyRead(state, observation);
  updateSearchWindow(state, observation);
  const readTrigger = updateReadWindow(state, observation);
  applyExperimentObservation(state, observation);
  clearResolvedFailures(state, observation);
  const failure = applyFailure(state, observation);
  if (failure.saturated) {
    state.ignoredObservations = increment(state.ignoredObservations);
    state.saturated = true;
    return result(state, true, false, "failure_run_capacity");
  }
  if (failure.duplicateCycle) {
    return result(state, true, false, "duplicate_verification_cycle");
  }
  return result(state, true, false, "accepted", failure.trigger ?? readTrigger);
}
