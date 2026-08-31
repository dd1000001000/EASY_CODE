import assert from "node:assert/strict";

import {
  TurnSteeringAttemptNotifier,
} from "../src/runtime/turn-steering-notifier.js";
import { describe, it } from "./harness.js";

describe("turn steering attempt notifier", () => {
  it("aborts only the active provider attempt after durable enqueue", () => {
    const notifier = new TurnSteeringAttemptNotifier();
    const attempt = notifier.openAttempt();

    notifier.notify(1);

    assert.equal(attempt.signal.aborted, true);
    assert.equal(notifier.pending, true);
    assert.equal(notifier.notifiedThroughSequence, 1);
    assert.equal(notifier.consumedThroughSequence, 0);
    attempt.dispose();
  });

  it("does not lose a notification received between provider attempts", () => {
    const notifier = new TurnSteeringAttemptNotifier();
    const first = notifier.openAttempt();
    first.dispose();

    notifier.notify(1);
    const second = notifier.openAttempt();

    assert.equal(second.signal.aborted, true);
    assert.equal(notifier.pending, true);
    second.dispose();
  });

  it("coalesces multiple notifications at the highest durable sequence", () => {
    const notifier = new TurnSteeringAttemptNotifier();
    const attempt = notifier.openAttempt();

    notifier.notify(1);
    notifier.notify(3);
    notifier.notify(2);
    notifier.notify(3);

    assert.equal(attempt.signal.aborted, true);
    assert.equal(notifier.notifiedThroughSequence, 3);
    assert.equal(notifier.pending, true);
    attempt.dispose();
  });

  it("consumes only the durable prefix and preserves a newer notification", () => {
    const notifier = new TurnSteeringAttemptNotifier();
    notifier.notify(1);
    notifier.notify(2);

    notifier.consume(1);
    assert.equal(notifier.pending, true);
    assert.equal(notifier.consumedThroughSequence, 1);

    const attempt = notifier.openAttempt();
    assert.equal(attempt.signal.aborted, true);
    attempt.dispose();

    notifier.consume(2);
    assert.equal(notifier.pending, false);
  });

  it("allows durable recovery to advance beyond process-local notifications", () => {
    const notifier = new TurnSteeringAttemptNotifier();

    notifier.consume(7);
    assert.equal(notifier.notifiedThroughSequence, 7);
    assert.equal(notifier.consumedThroughSequence, 7);
    assert.equal(notifier.pending, false);

    // A delayed duplicate App notification cannot cancel the next request.
    notifier.notify(7);
    const attempt = notifier.openAttempt();
    assert.equal(attempt.signal.aborted, false);
    attempt.dispose();
  });

  it("opens a fresh non-aborted signal after the pending watermark is consumed", () => {
    const notifier = new TurnSteeringAttemptNotifier();
    const first = notifier.openAttempt();
    notifier.notify(4);
    assert.equal(first.signal.aborted, true);
    first.dispose();

    notifier.consume(4);
    const second = notifier.openAttempt();
    assert.equal(second.signal.aborted, false);
    assert.notEqual(second.signal, first.signal);
    second.dispose();
  });

  it("resets a completed lifecycle to a supplied durable watermark", () => {
    const notifier = new TurnSteeringAttemptNotifier();
    notifier.notify(9);
    notifier.reset(6);

    assert.equal(notifier.notifiedThroughSequence, 6);
    assert.equal(notifier.consumedThroughSequence, 6);
    assert.equal(notifier.pending, false);

    notifier.notify(7);
    assert.equal(notifier.pending, true);
  });

  it("rejects reset and overlapping attempts that could lose wakeups", () => {
    const notifier = new TurnSteeringAttemptNotifier();
    const attempt = notifier.openAttempt();

    assert.throws(() => notifier.openAttempt(), /disposing the active attempt/u);
    assert.throws(() => notifier.reset(), /during an active attempt/u);

    attempt.dispose();
    notifier.reset();
    assert.equal(notifier.pending, false);
  });

  it("validates durable inbox sequence watermarks", () => {
    const notifier = new TurnSteeringAttemptNotifier();

    assert.throws(() => notifier.notify(0), /safe integer/u);
    assert.throws(() => notifier.notify(1.5), /safe integer/u);
    assert.throws(() => notifier.consume(-1), /safe integer/u);
    assert.throws(() => notifier.reset(Number.MAX_SAFE_INTEGER + 1), /safe integer/u);
  });
});
