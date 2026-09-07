import assert from "node:assert/strict";

import { foldProgressObservation, createProgressGuardState } from "../src/progress/guard.js";
import type { ProgressObservation } from "../src/progress/types.js";
import { describe, it } from "./harness.js";

function failure(
  ordinal: number,
  options: {
    eventId?: string;
    callId?: string;
    commandId?: string;
    cycleId?: string;
    outcomeKey?: string;
    targetKey?: string;
  } = {},
): ProgressObservation {
  const suffix = String(ordinal).padStart(12, "0");
  const commandId = options.commandId ??
    `command_00000000-0000-4000-8000-${suffix}`;
  return {
    schemaVersion: 1,
    sourceEventId: options.eventId ?? `event_failure_${ordinal}`,
    sourceCallId: options.callId ?? `call_failure_${ordinal}`,
    scopeKey: "thread:test/task:backend",
    responseOrdinal: ordinal,
    tool: "run_command",
    kind: "verification_terminal",
    confidence: "high",
    outcomeClass: "failed",
    verificationCycleId: options.cycleId ?? commandId,
    commandId,
    targetKey: options.targetKey ?? "sha256:" + "a".repeat(64),
    outcomeKey: options.outcomeKey ?? "sha256:" + "b".repeat(64),
    evidenceDigest: options.outcomeKey ?? "sha256:" + "b".repeat(64),
  };
}

function read(ordinal: number, targetKey: string): ProgressObservation {
  return {
    schemaVersion: 1,
    sourceEventId: `event_read_${ordinal}`,
    sourceCallId: `call_read_${ordinal}`,
    scopeKey: "thread:test",
    responseOrdinal: ordinal,
    tool: "read_file",
    kind: "read",
    confidence: "high",
    outcomeClass: "unknown",
    targetKey,
    outcomeKey: "sha256:" + "c".repeat(64),
    evidenceDigest: "sha256:" + "d".repeat(64),
  };
}

describe("progress guard", () => {
  it("folds immutably and rejects the same source event twice", () => {
    const initial = createProgressGuardState();
    const observation = read(1, "read-target");
    const first = foldProgressObservation(initial, observation);
    const second = foldProgressObservation(first.state, observation);

    assert.equal(initial.acceptedObservations, 0);
    assert.equal(first.accepted, true);
    assert.equal(first.state.acceptedObservations, 1);
    assert.equal(second.accepted, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.reason, "duplicate_source_event");
    assert.equal(second.state.acceptedObservations, 1);
  });

  it("counts repeated read_file coverage independently from unique coverage", () => {
    let state = createProgressGuardState();
    state = foldProgressObservation(state, read(1, "read:a")).state;
    state = foldProgressObservation(state, read(2, "read:a")).state;
    state = foldProgressObservation(state, read(3, "read:b")).state;

    assert.deepEqual(
      {
        total: state.readCoverage.totalReads,
        repeated: state.readCoverage.repeatedReads,
        unique: state.readCoverage.uniqueTargets,
      },
      { total: 3, repeated: 1, unique: 2 },
    );
    assert.equal(state.readCoverage.targets.find((item) => item.targetKey === "read:a")?.reads, 2);
  });

  it("emits only a weak read warning after five repeated versioned reads", () => {
    let state = createProgressGuardState();
    let trigger;
    for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
      const folded = foldProgressObservation(state, read(ordinal, "read:same"));
      state = folded.state;
      trigger = folded.trigger ?? trigger;
    }
    assert.equal(trigger?.kind, "repeated_reads");
    assert.equal(state.readWarning?.totalReads, 5);
    assert.equal(state.readWarning?.repeatedReads, 4);
    assert.equal(state.incidents.length, 0, "read repetition alone must not start a reviewer");
  });

  it("counts one terminal command exactly once even across distinct result events", () => {
    const initial = createProgressGuardState();
    const first = foldProgressObservation(initial, failure(1));
    const repeatedTerminal = failure(2, {
      commandId: failure(1).commandId,
      cycleId: failure(1).verificationCycleId,
    });
    const second = foldProgressObservation(first.state, repeatedTerminal);

    assert.equal(second.accepted, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.reason, "duplicate_terminal_command");
    assert.equal(second.state.failureRuns[0]?.verificationCycleIds.length, 1);
  });

  it("triggers only on the third distinct verification cycle with the same high-confidence failure", () => {
    let state = createProgressGuardState();
    const first = foldProgressObservation(state, failure(1));
    state = first.state;
    const second = foldProgressObservation(state, failure(2));
    state = second.state;
    const third = foldProgressObservation(state, failure(3));

    assert.equal(first.trigger, undefined);
    assert.equal(second.trigger, undefined);
    assert.equal(third.trigger?.kind, "repeated_verified_failure");
    assert.deepEqual(third.trigger?.verificationCycleIds, [
      failure(1).verificationCycleId,
      failure(2).verificationCycleId,
      failure(3).verificationCycleId,
    ]);
    assert.equal(third.state.failureRuns[0]?.triggered, true);

    const fourth = foldProgressObservation(third.state, failure(4));
    assert.equal(fourth.trigger, undefined, "one incident must not trigger repeatedly");
  });

  it("retains low-confidence evidence without allowing it to trigger", () => {
    let state = createProgressGuardState();
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      state = foldProgressObservation(state, {
        ...failure(ordinal),
        confidence: "low",
      }).state;
    }

    assert.equal(state.acceptedObservations, 3);
    assert.equal(state.failureRuns.length, 0);
  });

  it("does not combine different failure signatures and clears a target after a verified pass", () => {
    let state = createProgressGuardState();
    state = foldProgressObservation(state, failure(1)).state;
    state = foldProgressObservation(state, failure(2, {
      outcomeKey: "sha256:" + "e".repeat(64),
    })).state;
    const mixed = foldProgressObservation(state, failure(3));
    assert.equal(mixed.trigger, undefined);
    assert.equal(mixed.state.failureRuns.length, 2);

    const passed: ProgressObservation = {
      ...failure(4),
      outcomeClass: "passed",
      outcomeKey: "passed",
      evidenceDigest: "sha256:" + "f".repeat(64),
    };
    const resolved = foldProgressObservation(mixed.state, passed);
    assert.equal(resolved.state.failureRuns.length, 0);
  });
});
