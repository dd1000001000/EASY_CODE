import { progressReviewPacketDigest, progressReviewReportSchema } from "./reviewer.js";
import { cloneProgressGuardState } from "./guard.js";
import type {
  ProgressGuardState,
  ProgressIncident,
  ProgressReviewBindingSnapshot,
} from "./types.js";

export const PROGRESS_REVIEW_EVENT_TYPES = [
  "progress.review.requested",
  "progress.review.started",
  "progress.review.model_request.started",
  "progress.review.model_request.finished",
  "progress.review.completed",
  "progress.review.unavailable",
  "progress.review.stale",
] as const;

export type ProgressReviewEventType = (typeof PROGRESS_REVIEW_EVENT_TYPES)[number];

interface ReviewAccountingSnapshot {
  reviewAttempts: number;
  validReviews: number;
  reviewModelRequests: number;
  reviewInputTokens: number;
  reviewOutputTokens: number;
  reviewTotalTokens: number;
  reviewCachedInputTokens: number;
  reviewReasoningTokens: number;
  reviewDurationMs: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid progress review event payload");
  }
  return value as Record<string, unknown>;
}

function safeText(value: unknown, name: string, maximum = 64_000): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`Invalid progress review ${name}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid progress review ${name}`);
  }
  return Number(value);
}

function optionalNonNegativeInteger(
  value: unknown,
  name: string,
): number {
  return value === undefined ? 0 : nonNegativeInteger(value, name);
}

function parseBinding(value: unknown): ProgressReviewBindingSnapshot {
  const input = record(value);
  const binding: ProgressReviewBindingSnapshot = {
    reviewId: safeText(input.reviewId, "reviewId", 256),
    incidentId: safeText(input.incidentId, "incidentId", 256),
    intentRevision: nonNegativeInteger(input.intentRevision, "intentRevision"),
    workspaceFingerprint: safeText(
      input.workspaceFingerprint,
      "workspaceFingerprint",
      256,
    ),
    progressWatermark: nonNegativeInteger(
      input.progressWatermark,
      "progressWatermark",
    ),
    packetDigest: safeText(input.packetDigest, "packetDigest", 80),
  };
  if (!/^sha256:[0-9a-f]{64}$/u.test(binding.packetDigest)) {
    throw new Error("Invalid progress review packetDigest");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(binding.workspaceFingerprint)) {
    throw new Error("Invalid progress review workspaceFingerprint");
  }
  return binding;
}

function sameBinding(
  left: Readonly<ProgressReviewBindingSnapshot>,
  right: Readonly<ProgressReviewBindingSnapshot>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseAccounting(value: unknown): ReviewAccountingSnapshot {
  const input = record(value);
  return {
    reviewAttempts: nonNegativeInteger(input.reviewAttempts, "reviewAttempts"),
    validReviews: nonNegativeInteger(input.validReviews, "validReviews"),
    reviewModelRequests: nonNegativeInteger(
      input.reviewModelRequests,
      "reviewModelRequests",
    ),
    reviewInputTokens: nonNegativeInteger(input.reviewInputTokens, "reviewInputTokens"),
    reviewOutputTokens: nonNegativeInteger(
      input.reviewOutputTokens,
      "reviewOutputTokens",
    ),
    reviewTotalTokens: nonNegativeInteger(input.reviewTotalTokens, "reviewTotalTokens"),
    reviewCachedInputTokens: optionalNonNegativeInteger(
      input.reviewCachedInputTokens,
      "reviewCachedInputTokens",
    ),
    reviewReasoningTokens: optionalNonNegativeInteger(
      input.reviewReasoningTokens,
      "reviewReasoningTokens",
    ),
    reviewDurationMs: optionalNonNegativeInteger(
      input.reviewDurationMs,
      "reviewDurationMs",
    ),
  };
}

function incidentFor(
  state: ProgressGuardState,
  incidentId: string,
): ProgressIncident {
  const incident = state.incidents.find((candidate) => candidate.incidentId === incidentId);
  if (!incident) throw new Error(`Unknown progress incident ${incidentId}`);
  return incident;
}

function applyAccounting(
  incident: ProgressIncident,
  accounting: ReviewAccountingSnapshot,
): void {
  // started is the authoritative attempt charge; terminal accounting cannot
  // erase it and cannot manufacture a second attempt.
  incident.reviewAttempts = Math.max(incident.reviewAttempts, accounting.reviewAttempts);
  incident.validReviews = Math.max(incident.validReviews, accounting.validReviews);
  incident.reviewModelRequests = Math.max(
    incident.reviewModelRequests,
    accounting.reviewModelRequests,
  );
  incident.reviewInputTokens = Math.max(
    incident.reviewInputTokens,
    accounting.reviewInputTokens,
  );
  incident.reviewOutputTokens = Math.max(
    incident.reviewOutputTokens,
    accounting.reviewOutputTokens,
  );
  incident.reviewTotalTokens = Math.max(
    incident.reviewTotalTokens,
    accounting.reviewTotalTokens,
  );
  incident.reviewCachedInputTokens = Math.max(
    incident.reviewCachedInputTokens,
    accounting.reviewCachedInputTokens,
  );
  incident.reviewReasoningTokens = Math.max(
    incident.reviewReasoningTokens,
    accounting.reviewReasoningTokens,
  );
  incident.reviewDurationMs = Math.max(
    incident.reviewDurationMs,
    accounting.reviewDurationMs,
  );
}

export function isProgressReviewEventType(value: string): value is ProgressReviewEventType {
  return (PROGRESS_REVIEW_EVENT_TYPES as readonly string[]).includes(value);
}

export function nextPendingProgressIncident(
  state: Readonly<ProgressGuardState>,
  scopeKey?: string,
): Readonly<ProgressIncident> | undefined {
  return state.incidents.find(
    (incident) =>
      incident.phase === "review_pending" &&
      (scopeKey === undefined || incident.scopeKey === scopeKey),
  );
}

export function requestedProgressIncident(
  state: Readonly<ProgressGuardState>,
  scopeKey?: string,
): Readonly<ProgressIncident> | undefined {
  return state.incidents.find(
    (incident) =>
      incident.phase === "review_requested" &&
      (scopeKey === undefined || incident.scopeKey === scopeKey),
  );
}

export function interruptedProgressIncident(
  state: Readonly<ProgressGuardState>,
  scopeKey?: string,
): Readonly<ProgressIncident> | undefined {
  return state.incidents.find(
    (incident) =>
      incident.phase === "reviewing" &&
      (scopeKey === undefined || incident.scopeKey === scopeKey),
  );
}

export function reviewAttemptUsedForScope(
  state: Readonly<ProgressGuardState>,
  scopeKey: string,
  excludingIncidentId?: string,
): boolean {
  return state.incidents.some(
    (incident) =>
      incident.incidentId !== excludingIncidentId &&
      incident.scopeKey === scopeKey &&
      incident.reviewAttempts > 0,
  );
}

/**
 * Validate and fold one durable reviewer lifecycle event. This is shared by
 * append-time validation, live Runtime projection, and crash recovery.
 */
export function foldProgressReviewEvent(
  current: Readonly<ProgressGuardState>,
  eventType: ProgressReviewEventType,
  rawPayload: unknown,
): ProgressGuardState {
  const state = cloneProgressGuardState(current);
  const payload = record(rawPayload);
  const incidentId = safeText(payload.incidentId, "incidentId", 256);
  const incident = incidentFor(state, incidentId);

  if (eventType === "progress.review.requested") {
    if (incident.phase !== "review_pending" || incident.reviewBinding) {
      throw new Error(`Progress incident ${incidentId} is not awaiting a review request`);
    }
    if (reviewAttemptUsedForScope(state, incident.scopeKey, incident.incidentId)) {
      throw new Error(`Progress review attempt budget is exhausted for ${incident.scopeKey}`);
    }
    const binding = parseBinding(payload.binding);
    const packet = safeText(payload.packet, "packet");
    if (
      binding.incidentId !== incident.incidentId ||
      binding.progressWatermark !== state.acceptedObservations ||
      progressReviewPacketDigest(packet) !== binding.packetDigest
    ) {
      throw new Error("Progress review request binding is stale or mismatched");
    }
    incident.reviewBinding = binding;
    incident.reviewPacket = packet;
    incident.phase = "review_requested";
    return state;
  }

  if (eventType === "progress.review.started") {
    const reviewId = safeText(payload.reviewId, "reviewId", 256);
    if (
      incident.phase !== "review_requested" ||
      incident.reviewBinding?.reviewId !== reviewId ||
      incident.reviewAttempts !== 0
    ) {
      throw new Error(`Invalid progress review start for ${incidentId}`);
    }
    incident.reviewAttempts = 1;
    incident.phase = "reviewing";
    return state;
  }

  if (eventType === "progress.review.model_request.started") {
    const reviewId = safeText(payload.reviewId, "reviewId", 256);
    const ordinal = nonNegativeInteger(payload.ordinal, "request ordinal");
    if (
      incident.phase !== "reviewing" ||
      incident.reviewBinding?.reviewId !== reviewId ||
      (ordinal !== 1 && ordinal !== 2) ||
      incident.reviewStartedRequestOrdinals.includes(ordinal) ||
      ordinal !== incident.reviewStartedRequestOrdinals.length + 1
    ) {
      throw new Error(`Invalid progress review Provider request start for ${incidentId}`);
    }
    incident.reviewStartedRequestOrdinals.push(ordinal);
    incident.reviewModelRequests = Math.max(
      incident.reviewModelRequests,
      incident.reviewStartedRequestOrdinals.length,
    );
    return state;
  }

  if (eventType === "progress.review.model_request.finished") {
    const reviewId = safeText(payload.reviewId, "reviewId", 256);
    const ordinal = nonNegativeInteger(payload.ordinal, "request ordinal");
    const status = safeText(payload.status, "request status", 32);
    if (
      incident.phase !== "reviewing" ||
      incident.reviewBinding?.reviewId !== reviewId ||
      (status !== "completed" && status !== "failed") ||
      !incident.reviewStartedRequestOrdinals.includes(ordinal) ||
      incident.reviewFinishedRequestOrdinals.includes(ordinal)
    ) {
      throw new Error(`Invalid progress review Provider request finish for ${incidentId}`);
    }
    incident.reviewFinishedRequestOrdinals.push(ordinal);
    incident.reviewDurationMs += nonNegativeInteger(payload.durationMs, "request durationMs");
    const usage = payload.usage === undefined ? undefined : record(payload.usage);
    if (usage) {
      const inputTokens = optionalNonNegativeInteger(usage.promptTokens, "promptTokens");
      const outputTokens = optionalNonNegativeInteger(
        usage.completionTokens,
        "completionTokens",
      );
      incident.reviewInputTokens += inputTokens;
      incident.reviewOutputTokens += outputTokens;
      incident.reviewTotalTokens += usage.totalTokens === undefined
        ? inputTokens + outputTokens
        : nonNegativeInteger(usage.totalTokens, "totalTokens");
      incident.reviewCachedInputTokens += optionalNonNegativeInteger(
        usage.cachedInputTokens,
        "cachedInputTokens",
      );
      incident.reviewReasoningTokens += optionalNonNegativeInteger(
        usage.reasoningTokens,
        "reasoningTokens",
      );
    }
    return state;
  }

  if (eventType === "progress.review.completed") {
    const binding = parseBinding(payload.binding);
    if (
      incident.phase !== "reviewing" ||
      !incident.reviewBinding ||
      !sameBinding(incident.reviewBinding, binding)
    ) {
      throw new Error(`Invalid progress review completion for ${incidentId}`);
    }
    const report = progressReviewReportSchema.parse(payload.report);
    const accounting = parseAccounting(payload.accounting);
    if (accounting.reviewAttempts !== 1 || accounting.validReviews !== 1) {
      throw new Error("A completed progress review requires one valid charged attempt");
    }
    if (
      incident.reviewStartedRequestOrdinals.length < 1 ||
      incident.reviewStartedRequestOrdinals.length !==
        incident.reviewFinishedRequestOrdinals.length ||
      accounting.reviewModelRequests !== incident.reviewStartedRequestOrdinals.length
    ) {
      throw new Error(
        "A completed progress review requires a durable outcome for every Provider request",
      );
    }
    applyAccounting(incident, accounting);
    incident.reviewReport = { ...report };
    incident.phase = report.recommendation === "run_experiment"
      ? "experiment_required"
      : "strategy_adjustment";
    return state;
  }

  if (eventType === "progress.review.stale") {
    const reviewId = safeText(payload.reviewId, "reviewId", 256);
    if (
      (incident.phase !== "reviewing" &&
        incident.phase !== "review_requested" &&
        incident.phase !== "experiment_required" &&
        incident.phase !== "strategy_adjustment" &&
        incident.phase !== "review_exhausted") ||
      incident.reviewBinding?.reviewId !== reviewId
    ) {
      throw new Error(`Invalid stale progress review for ${incidentId}`);
    }
    if (payload.accounting !== undefined) {
      applyAccounting(incident, parseAccounting(payload.accounting));
    }
    incident.reviewUnavailableReason = safeText(payload.reason, "stale reason", 2_000);
    incident.phase = "review_stale";
    return state;
  }

  const reviewId = payload.reviewId === undefined
    ? undefined
    : safeText(payload.reviewId, "reviewId", 256);
  if (
    incident.phase !== "review_pending" &&
    incident.phase !== "review_requested" &&
    incident.phase !== "reviewing" &&
    incident.phase !== "experiment_required" &&
    incident.phase !== "strategy_adjustment" &&
    incident.phase !== "review_exhausted"
  ) {
    throw new Error(`Invalid unavailable progress review for ${incidentId}`);
  }
  if (
    reviewId !== undefined &&
    incident.reviewBinding &&
    incident.reviewBinding.reviewId !== reviewId
  ) {
    throw new Error(`Progress review ID mismatch for ${incidentId}`);
  }
  if (payload.accounting !== undefined) {
    applyAccounting(incident, parseAccounting(payload.accounting));
  }
  incident.reviewUnavailableReason = safeText(
    payload.reason,
    "unavailable reason",
    2_000,
  );
  incident.phase = "review_unavailable";
  return state;
}
