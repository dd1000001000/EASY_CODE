import assert from "node:assert/strict";

import { createProgressGuardState, foldProgressObservation } from "../src/progress/guard.js";
import {
  foldProgressReviewEvent,
  nextPendingProgressIncident,
  reviewAttemptUsedForScope,
} from "../src/progress/lifecycle.js";
import { progressReviewPacketDigest } from "../src/progress/reviewer.js";
import type { ProgressGuardState, ProgressObservation } from "../src/progress/types.js";
import { describe, it } from "./harness.js";

const SCOPE = "thread:test/task:repair";
const TARGET = "sha256:" + "a".repeat(64);
const OUTCOME = "sha256:" + "b".repeat(64);

function failure(index: number): ProgressObservation {
  const suffix = String(index).padStart(12, "0");
  const commandId = `command_00000000-0000-4000-8000-${suffix}`;
  return {
    schemaVersion: 1,
    sourceEventId: `event_failure_${index}`,
    sourceCallId: `call_failure_${index}`,
    scopeKey: SCOPE,
    responseOrdinal: index,
    tool: "run_command",
    kind: "verification_terminal",
    confidence: "high",
    outcomeClass: "failed",
    verificationCycleId: commandId,
    commandId,
    targetKey: TARGET,
    outcomeKey: OUTCOME,
    evidenceDigest: OUTCOME,
  };
}

function triggeredState(): ProgressGuardState {
  let state = createProgressGuardState();
  for (let index = 1; index <= 3; index += 1) {
    state = foldProgressObservation(state, failure(index)).state;
  }
  return state;
}

function report() {
  return {
    recommendation: "run_experiment" as const,
    summary: "The current explanation is testable.",
    diagnosis: "Generated state may be stale.",
    evidence: "Three distinct cycles returned the same assertion.",
    experiment: "Regenerate one fixture and run the narrow test once.",
    expectedSignal: "The assertion changes or passes.",
    falsifyingSignal: "The identical assertion remains.",
  };
}

function accounting() {
  return {
    reviewAttempts: 1,
    validReviews: 1,
    reviewModelRequests: 1,
    reviewInputTokens: 100,
    reviewOutputTokens: 20,
    reviewTotalTokens: 120,
  };
}

describe("progress reviewer lifecycle", () => {
  it("persists request/start/completion and gates the parent on one experiment", () => {
    let state = triggeredState();
    const incident = nextPendingProgressIncident(state);
    assert.ok(incident);
    const packet = "bounded immutable review packet";
    const binding = {
      reviewId: "review_lifecycle_1",
      incidentId: incident.incidentId,
      intentRevision: 4,
      workspaceFingerprint: "sha256:" + "c".repeat(64),
      progressWatermark: state.acceptedObservations,
      packetDigest: progressReviewPacketDigest(packet),
    };

    state = foldProgressReviewEvent(state, "progress.review.requested", {
      incidentId: incident.incidentId,
      binding,
      packet,
    });
    assert.equal(state.incidents[0]?.phase, "review_requested");
    assert.equal(state.incidents[0]?.reviewAttempts, 0);

    state = foldProgressReviewEvent(state, "progress.review.started", {
      incidentId: incident.incidentId,
      reviewId: binding.reviewId,
    });
    assert.equal(state.incidents[0]?.phase, "reviewing");
    assert.equal(state.incidents[0]?.reviewAttempts, 1);

    state = foldProgressReviewEvent(
      state,
      "progress.review.model_request.started",
      {
        incidentId: incident.incidentId,
        reviewId: binding.reviewId,
        ordinal: 1,
        kind: "initial",
      },
    );
    assert.equal(state.incidents[0]?.reviewModelRequests, 1);
    state = foldProgressReviewEvent(
      state,
      "progress.review.model_request.finished",
      {
        incidentId: incident.incidentId,
        reviewId: binding.reviewId,
        ordinal: 1,
        kind: "initial",
        status: "completed",
        durationMs: 25,
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
        },
      },
    );

    state = foldProgressReviewEvent(state, "progress.review.completed", {
      incidentId: incident.incidentId,
      binding,
      report: report(),
      accounting: accounting(),
    });
    assert.equal(state.incidents[0]?.phase, "experiment_required");
    assert.equal(state.incidents[0]?.validReviews, 1);
    assert.equal(state.incidents[0]?.reviewTotalTokens, 120);
    assert.equal(state.incidents[0]?.reviewDurationMs, 25);
  });

  it("does not let an unchanged experiment reset stagnation", () => {
    let state = triggeredState();
    const incident = state.incidents[0]!;
    const packet = "packet";
    const binding = {
      reviewId: "review_lifecycle_2",
      incidentId: incident.incidentId,
      intentRevision: 1,
      workspaceFingerprint: "sha256:" + "d".repeat(64),
      progressWatermark: state.acceptedObservations,
      packetDigest: progressReviewPacketDigest(packet),
    };
    state = foldProgressReviewEvent(state, "progress.review.requested", {
      incidentId: incident.incidentId,
      binding,
      packet,
    });
    state = foldProgressReviewEvent(state, "progress.review.started", {
      incidentId: incident.incidentId,
      reviewId: binding.reviewId,
    });
    state = foldProgressReviewEvent(
      state,
      "progress.review.model_request.started",
      {
        incidentId: incident.incidentId,
        reviewId: binding.reviewId,
        ordinal: 1,
        kind: "initial",
      },
    );
    state = foldProgressReviewEvent(
      state,
      "progress.review.model_request.finished",
      {
        incidentId: incident.incidentId,
        reviewId: binding.reviewId,
        ordinal: 1,
        kind: "initial",
        status: "completed",
        durationMs: 1,
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
        },
      },
    );
    state = foldProgressReviewEvent(state, "progress.review.completed", {
      incidentId: incident.incidentId,
      binding,
      report: report(),
      accounting: accounting(),
    });

    state = foldProgressObservation(state, failure(4)).state;
    assert.equal(state.incidents[0]?.phase, "review_exhausted");
    assert.equal(state.incidents[0]?.experiment?.newEvidence, false);
    assert.equal(state.incidents[0]?.experiment?.verifiedImprovement, false);
  });

  it("resolves only on a verified passing result and retains review budget", () => {
    let state = triggeredState();
    const incident = state.incidents[0]!;
    incident.phase = "experiment_required";
    incident.reviewAttempts = 1;
    const passed: ProgressObservation = {
      ...failure(5),
      outcomeClass: "passed",
      outcomeKey: "passed",
      evidenceDigest: "sha256:" + "e".repeat(64),
    };
    state = foldProgressObservation(state, passed).state;
    assert.equal(state.incidents[0]?.phase, "resolved");
    assert.equal(state.incidents[0]?.experiment?.verifiedImprovement, true);
    assert.equal(reviewAttemptUsedForScope(state, SCOPE), true);
  });

  it("rejects stale bindings and a second review request in one task scope", () => {
    const state = triggeredState();
    const incident = state.incidents[0]!;
    const packet = "packet";
    assert.throws(
      () => foldProgressReviewEvent(state, "progress.review.requested", {
        incidentId: incident.incidentId,
        binding: {
          reviewId: "review_stale",
          incidentId: incident.incidentId,
          intentRevision: 1,
          workspaceFingerprint: "sha256:" + "f".repeat(64),
          progressWatermark: state.acceptedObservations + 1,
          packetDigest: progressReviewPacketDigest(packet),
        },
        packet,
      }),
      /stale or mismatched/u,
    );
  });
});
