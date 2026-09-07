import type { VerificationKind } from "../command/types.js";

/** Durable schema version for evidence extracted from one tool result. */
export const PROGRESS_OBSERVATION_SCHEMA_VERSION = 1 as const;

/** Durable schema version for the in-memory projection folded from observations. */
export const PROGRESS_GUARD_STATE_SCHEMA_VERSION = 1 as const;

export const PROGRESS_FAILURE_THRESHOLD = 3 as const;
export const MAX_PROGRESS_SOURCE_EVENTS = 4_096;
export const MAX_PROGRESS_TERMINAL_COMMANDS = 4_096;
export const MAX_PROGRESS_READ_TARGETS = 128;
export const MAX_PROGRESS_FAILURE_RUNS = 128;
export const MAX_PROGRESS_INCIDENTS = 64;
export const PROGRESS_READ_WINDOW_RESPONSES = 12;
export const PROGRESS_READ_WARNING_MINIMUM = 5;
export const PROGRESS_READ_WARNING_RATIO = 0.7;

export type ProgressObservationKind =
  | "read"
  | "verification_terminal"
  | "infrastructure_failure"
  | "neutral";

export type ProgressOutcomeClass =
  | "passed"
  | "failed"
  | "timed_out"
  | "unknown";

/**
 * A small, self-contained fact derived while the full ToolExecutionResult is
 * still available. The containing tool.result event is its atomic durability
 * boundary; sourceEventId must equal that event's ID.
 */
export interface ProgressObservation {
  readonly schemaVersion: typeof PROGRESS_OBSERVATION_SCHEMA_VERSION;
  readonly sourceEventId: string;
  readonly sourceCallId: string;
  readonly scopeKey: string;
  /** Monotonic response/step ordinal supplied by Runtime. */
  readonly responseOrdinal: number;
  readonly tool: string;
  readonly kind: ProgressObservationKind;
  readonly confidence: "high" | "low";
  readonly outcomeClass: ProgressOutcomeClass;
  /** Runtime-normalized category for terminal verification evidence. */
  readonly verificationKind?: VerificationKind;
  /** Stable identity for a verification cycle; required for verified outcomes. */
  readonly verificationCycleId?: string;
  /** Runtime command handle. Running snapshots deliberately omit it. */
  readonly commandId?: string;
  readonly targetKey?: string;
  readonly outcomeKey?: string;
  readonly evidenceDigest?: string;
}

export interface ProgressObservationBinding {
  readonly sourceEventId: string;
  readonly sourceCallId: string;
  readonly tool?: string;
  /** Supply only when the authoritative untrimmed result is available. */
  readonly commandId?: string;
}

export interface ProgressReadTargetCoverage {
  targetKey: string;
  reads: number;
  lastResponseOrdinal: number;
}

export interface ProgressReadCoverage {
  totalReads: number;
  repeatedReads: number;
  uniqueTargets: number;
  untrackedReads: number;
  saturated: boolean;
  targets: ProgressReadTargetCoverage[];
}

export interface ProgressFailureRun {
  signature: string;
  scopeKey: string;
  targetKey: string;
  outcomeKey: string;
  outcomeClass: Extract<ProgressOutcomeClass, "failed" | "timed_out">;
  verificationKind?: VerificationKind;
  /** At most PROGRESS_FAILURE_THRESHOLD distinct cycles are retained. */
  verificationCycleIds: string[];
  responseOrdinals: number[];
  triggered: boolean;
  triggerSourceEventId?: string;
}

export interface ProgressRecentRead {
  sourceEventId: string;
  scopeKey: string;
  responseOrdinal: number;
  /** Range and content version, so a changed file is new evidence. */
  identity: string;
}

export interface ProgressReadWarning {
  id: string;
  sourceEventId: string;
  scopeKey: string;
  responseOrdinal: number;
  totalReads: number;
  repeatedReads: number;
  repeatedRatio: number;
}

export type ProgressIncidentPhase =
  | "review_pending"
  | "review_requested"
  | "reviewing"
  | "experiment_required"
  | "strategy_adjustment"
  | "review_exhausted"
  | "resolved"
  | "review_unavailable"
  | "review_stale";

export interface ProgressReviewBindingSnapshot {
  reviewId: string;
  incidentId: string;
  intentRevision: number;
  workspaceFingerprint: string;
  progressWatermark: number;
  packetDigest: string;
}

export interface ProgressReviewReportSnapshot {
  recommendation: "run_experiment" | "insufficient_evidence";
  summary: string;
  diagnosis: string;
  evidence: string;
  experiment: string;
  expectedSignal: string;
  falsifyingSignal: string;
}

export interface ProgressExperimentSnapshot {
  id: string;
  sourceEventId: string;
  sourceCallId: string;
  commandId?: string;
  outcomeClass: ProgressOutcomeClass;
  outcomeKey?: string;
  newEvidence: boolean;
  verifiedImprovement: boolean;
  semanticConfirmed: false;
}

export interface ProgressIncident {
  incidentId: string;
  signature: string;
  scopeKey: string;
  targetKey: string;
  outcomeKey: string;
  outcomeClass: Extract<ProgressOutcomeClass, "failed" | "timed_out">;
  verificationKind?: VerificationKind;
  triggerSourceEventId: string;
  triggerResponseOrdinal: number;
  verificationCycleIds: string[];
  phase: ProgressIncidentPhase;
  reviewAttempts: number;
  validReviews: number;
  reviewModelRequests: number;
  reviewInputTokens: number;
  reviewOutputTokens: number;
  reviewTotalTokens: number;
  reviewCachedInputTokens: number;
  reviewReasoningTokens: number;
  reviewDurationMs: number;
  /** Provider requests are journaled before dispatch and finished at most once. */
  reviewStartedRequestOrdinals: number[];
  reviewFinishedRequestOrdinals: number[];
  reviewBinding?: ProgressReviewBindingSnapshot;
  reviewPacket?: string;
  reviewReport?: ProgressReviewReportSnapshot;
  reviewUnavailableReason?: string;
  experiment?: ProgressExperimentSnapshot;
}

export interface ProgressGuardState {
  schemaVersion: typeof PROGRESS_GUARD_STATE_SCHEMA_VERSION;
  acceptedObservations: number;
  duplicateObservations: number;
  ignoredObservations: number;
  /** Monotonic across turns; multiple tool calls in one model response may share it. */
  lastObservedResponseOrdinal: number;
  /** Exact bounded registries. Saturation fails closed instead of evicting IDs. */
  seenSourceEventIds: string[];
  seenTerminalCommandIds: string[];
  readCoverage: ProgressReadCoverage;
  failureRuns: ProgressFailureRun[];
  /** Bounded, response-window evidence used only for a weak read-loop hint. */
  recentReads: ProgressRecentRead[];
  readWarning?: ProgressReadWarning;
  /** Durable intervention state. Reviewer attempts never enter the task DAG. */
  incidents: ProgressIncident[];
  saturated: boolean;
}

export interface ProgressGuardTrigger {
  readonly kind: "repeated_verified_failure";
  readonly signature: string;
  readonly sourceEventId: string;
  readonly scopeKey: string;
  readonly targetKey: string;
  readonly outcomeKey: string;
  readonly outcomeClass: Extract<ProgressOutcomeClass, "failed" | "timed_out">;
  readonly verificationKind?: VerificationKind;
  readonly verificationCycleIds: readonly string[];
}

export interface ProgressReadTrigger {
  readonly kind: "repeated_reads";
  readonly warning: Readonly<ProgressReadWarning>;
}

export type ProgressFoldReason =
  | "accepted"
  | "duplicate_source_event"
  | "duplicate_terminal_command"
  | "duplicate_verification_cycle"
  | "source_event_capacity"
  | "terminal_command_capacity"
  | "failure_run_capacity";

export interface ProgressFoldResult {
  readonly state: ProgressGuardState;
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly reason: ProgressFoldReason;
  readonly trigger?: ProgressGuardTrigger | ProgressReadTrigger;
}
