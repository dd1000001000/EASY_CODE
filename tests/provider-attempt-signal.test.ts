import assert from "node:assert/strict";

import {
  createProviderAttemptSignal,
} from "../src/runtime/provider-attempt-signal.js";
import { describe, it } from "./harness.js";

describe("provider attempt signal", () => {
  it("lets steering cancel only the active provider attempt", () => {
    const turn = new AbortController();
    const steering = new AbortController();
    const attempt = createProviderAttemptSignal({
      turnSignal: turn.signal,
      steeringSignal: steering.signal,
    });

    steering.abort("replace this attempt");

    assert.equal(attempt.signal.aborted, true);
    assert.equal(attempt.signal.reason, "replace this attempt");
    assert.equal(attempt.abortSource, "steering");
    assert.equal(turn.signal.aborted, false);
    attempt.dispose();
  });

  it("forwards Ctrl+C-style turn cancellation", () => {
    const turn = new AbortController();
    const steering = new AbortController();
    const attempt = createProviderAttemptSignal({
      turnSignal: turn.signal,
      steeringSignal: steering.signal,
    });

    turn.abort("stop the turn");

    assert.equal(attempt.signal.aborted, true);
    assert.equal(attempt.signal.reason, "stop the turn");
    assert.equal(attempt.abortSource, "turn");
    assert.equal(steering.signal.aborted, false);
    attempt.dispose();
  });

  it("gives the turn precedence when both sources are already aborted", () => {
    const turn = new AbortController();
    const steering = new AbortController();
    steering.abort("steer");
    turn.abort("interrupt");

    const attempt = createProviderAttemptSignal({
      turnSignal: turn.signal,
      steeringSignal: steering.signal,
    });

    assert.equal(attempt.signal.aborted, true);
    assert.equal(attempt.signal.reason, "interrupt");
    assert.equal(attempt.abortSource, "turn");
    attempt.dispose();
  });

  it("upgrades a steering race to a turn cancellation for retry decisions", () => {
    const turn = new AbortController();
    const steering = new AbortController();
    const attempt = createProviderAttemptSignal({
      turnSignal: turn.signal,
      steeringSignal: steering.signal,
    });

    steering.abort("steer");
    assert.equal(attempt.abortSource, "steering");

    turn.abort("interrupt");
    assert.equal(attempt.abortSource, "turn");
    attempt.dispose();
  });

  it("supports a fresh provider attempt after steering without aborting the turn", () => {
    const turn = new AbortController();
    const firstSteering = new AbortController();
    const firstAttempt = createProviderAttemptSignal({
      turnSignal: turn.signal,
      steeringSignal: firstSteering.signal,
    });

    firstSteering.abort();
    assert.equal(firstAttempt.abortSource, "steering");
    firstAttempt.dispose();

    const secondSteering = new AbortController();
    const secondAttempt = createProviderAttemptSignal({
      turnSignal: turn.signal,
      steeringSignal: secondSteering.signal,
    });
    assert.equal(secondAttempt.signal.aborted, false);
    assert.equal(secondAttempt.abortSource, undefined);

    turn.abort();
    assert.equal(secondAttempt.signal.aborted, true);
    assert.equal(secondAttempt.abortSource, "turn");
    secondAttempt.dispose();
  });

  it("detaches both source listeners when disposed", () => {
    const turn = new AbortController();
    const steering = new AbortController();
    const attempt = createProviderAttemptSignal({
      turnSignal: turn.signal,
      steeringSignal: steering.signal,
    });

    attempt.dispose();
    steering.abort();
    turn.abort();

    assert.equal(attempt.signal.aborted, false);
    assert.equal(attempt.abortSource, undefined);
  });
});
