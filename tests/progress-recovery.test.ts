import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SessionState } from "../src/core/types.js";
import {
  createProgressGuardState,
  foldProgressObservation,
} from "../src/progress/guard.js";
import { parseProgressObservation } from "../src/progress/observation.js";
import { progressReviewPacketDigest } from "../src/progress/reviewer.js";
import type {
  ProgressGuardState,
  ProgressObservation,
} from "../src/progress/types.js";
import { createStorage } from "../src/storage/index.js";
import { ThreadStore } from "../src/threads/index.js";
import { describe, it } from "./harness.js";

const THREAD_ID = "thread_progress_recovery";
const SCOPE_KEY = `thread:${THREAD_ID}/turn:turn_progress_recovery`;
const TARGET_KEY = "test:progress-recovery";
const OUTCOME_KEY = "test-failure:assertion";
const TRUNCATED_TOOL_MESSAGE =
  '{"ok":false,"summary":"failed","data":{"truncated":true,"originalChars":999999}}';

type SessionWithProgress = SessionState & {
  progressGuard?: ProgressGuardState;
};

function temporaryDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "easy-code-progress-recovery-"));
}

function createThread(threads: ThreadStore, dataDir: string, threadId = THREAD_ID): void {
  threads.create({
    threadId,
    workspaceRoot: path.join(dataDir, "workspace"),
    mode: "code",
    provider: "qwen",
    model: "qwen-test",
  });
}

function commandId(index: number): string {
  return `command_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function failedObservation(input: {
  eventId: string;
  callId: string;
  commandId: string;
  responseOrdinal: number;
  cycleId?: string;
}): ProgressObservation {
  return parseProgressObservation({
    schemaVersion: 1,
    sourceEventId: input.eventId,
    sourceCallId: input.callId,
    scopeKey: SCOPE_KEY,
    responseOrdinal: input.responseOrdinal,
    tool: "poll_command",
    kind: "verification_terminal",
    confidence: "high",
    outcomeClass: "failed",
    verificationCycleId: input.cycleId ?? input.commandId,
    commandId: input.commandId,
    targetKey: TARGET_KEY,
    outcomeKey: OUTCOME_KEY,
    evidenceDigest: `sha256:${String(input.responseOrdinal % 10).repeat(64)}`,
  });
}

function appendObservation(
  threads: ThreadStore,
  input: {
    threadId?: string;
    eventId: string;
    callId: string;
    observation: ProgressObservation | unknown;
  },
): void {
  threads.appendEvent(input.threadId ?? THREAD_ID, {
    eventId: input.eventId,
    type: "tool.result",
    phase: "failed",
    turnId: "turn_progress_recovery",
    payload: {
      callId: input.callId,
      tool: "poll_command",
      message: {
        role: "tool",
        tool_call_id: input.callId,
        name: "poll_command",
        content: TRUNCATED_TOOL_MESSAGE,
      },
      progressObservation: input.observation,
    },
  });
}

function recoveredProgress(state: SessionState): ProgressGuardState {
  const progress = (state as SessionWithProgress).progressGuard;
  assert.ok(progress, "tool.result observation was not folded during recovery");
  return progress;
}

function expectedAfter(observations: readonly ProgressObservation[]): ProgressGuardState {
  let state = createProgressGuardState();
  for (const observation of observations) {
    state = foldProgressObservation(state, observation).state;
  }
  return state;
}

describe("ProgressGuard journal recovery", () => {
  it("recovers the Observation atomically from its tool.result after a damaged-tail crash", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    const eventId = "event_progress_atomic";
    const callId = "call_progress_atomic";
    const observation = failedObservation({
      eventId,
      callId,
      commandId: commandId(1),
      responseOrdinal: 1,
    });
    try {
      const threads = new ThreadStore(storage);
      createThread(threads, dataDir);
      appendObservation(threads, { eventId, callId, observation });

      const events = threads.journal(THREAD_ID).read();
      assert.equal(events.filter((event) => event.type === "tool.result").length, 1);
      assert.equal(
        events.some((event) => event.type === "progress.observed"),
        false,
        "Observation must share the tool.result durability boundary",
      );

      // Simulate a crash after the complete tool.result was fsynced but while a
      // later journal record was only partially written.
      appendFileSync(
        threads.journal(THREAD_ID).filePath,
        '{"schemaVersion":1,"eventId":"event_incomplete_progress_tail"',
        "utf8",
      );
    } finally {
      storage.close();
    }

    const reopened = createStorage(dataDir);
    try {
      const threads = new ThreadStore(reopened);
      const recovered = threads.recover(THREAD_ID);
      assert.deepEqual(recoveredProgress(recovered), expectedAfter([observation]));
      assert.equal(
        recovered.messages.some(
          (message) => message.role === "tool" && message.content === TRUNCATED_TOOL_MESSAGE,
        ),
        true,
      );
    } finally {
      reopened.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("counts one terminal command once across repeated polls, recovery, and projection rebuild", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      createThread(threads, dataDir);
      const terminalCommandId = commandId(2);
      const first = failedObservation({
        eventId: "event_progress_terminal_first",
        callId: "call_progress_terminal_first",
        commandId: terminalCommandId,
        responseOrdinal: 2,
        cycleId: "cycle_progress_terminal_first",
      });
      const repeatedPoll = failedObservation({
        eventId: "event_progress_terminal_repeated",
        callId: "call_progress_terminal_repeated",
        commandId: terminalCommandId,
        responseOrdinal: 3,
        cycleId: "cycle_progress_terminal_repeated",
      });
      appendObservation(threads, {
        eventId: first.sourceEventId,
        callId: first.sourceCallId,
        observation: first,
      });
      appendObservation(threads, {
        eventId: repeatedPoll.sourceEventId,
        callId: repeatedPoll.sourceCallId,
        observation: repeatedPoll,
      });

      const expected = expectedAfter([first, repeatedPoll]);
      assert.equal(expected.acceptedObservations, 1);
      assert.equal(expected.duplicateObservations, 1);
      assert.deepEqual(expected.seenTerminalCommandIds, [terminalCommandId]);
      assert.equal(expected.failureRuns[0]?.verificationCycleIds.length, 1);
      assert.equal(expected.failureRuns[0]?.triggered, false);

      const firstRecovery = threads.recover(THREAD_ID);
      assert.deepEqual(recoveredProgress(firstRecovery), expected);
      threads.save(firstRecovery);
      assert.deepEqual(recoveredProgress(threads.recover(THREAD_ID)), expected);
      assert.deepEqual(recoveredProgress(threads.rebuildProjection(THREAD_ID)), expected);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed and mismatched Observations before appending the tool.result", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      createThread(threads, dataDir);
      const eventId = "event_progress_binding";
      const callId = "call_progress_binding";
      const valid = failedObservation({
        eventId,
        callId,
        commandId: commandId(3),
        responseOrdinal: 4,
      });
      const initialEventCount = threads.journal(THREAD_ID).read().length;

      assert.throws(
        () => appendObservation(threads, {
          eventId,
          callId,
          observation: { ...valid, schemaVersion: 2 },
        }),
        /ProgressObservation/u,
      );
      assert.throws(
        () => appendObservation(threads, {
          eventId,
          callId,
          observation: { ...valid, sourceEventId: "event_progress_wrong" },
        }),
        /sourceEventId/u,
      );
      assert.throws(
        () => appendObservation(threads, {
          eventId,
          callId,
          observation: { ...valid, sourceCallId: "call_progress_wrong" },
        }),
        /sourceCallId/u,
      );
      assert.throws(
        () => appendObservation(threads, {
          eventId,
          callId,
          observation: { ...valid, tool: "read_file" },
        }),
        /tool/u,
      );
      assert.throws(
        () => appendObservation(threads, {
          eventId,
          callId,
          observation: { ...valid, scopeKey: "thread:other/turn:turn_progress_recovery" },
        }),
        /scope/u,
      );
      assert.throws(
        () => parseProgressObservation(valid, {
          sourceEventId: eventId,
          sourceCallId: callId,
          commandId: commandId(4),
        }),
        /commandId/u,
      );
      assert.equal(
        threads.journal(THREAD_ID).read().length,
        initialEventCount,
        "a rejected Observation must not leave a partial authoritative event",
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not infer high-confidence progress from a legacy truncated tool result", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      createThread(threads, dataDir);
      threads.appendEvent(THREAD_ID, {
        eventId: "event_progress_legacy_truncated",
        type: "tool.result",
        phase: "failed",
        turnId: "turn_progress_legacy",
        payload: {
          callId: "call_progress_legacy",
          tool: "poll_command",
          message: {
            role: "tool",
            tool_call_id: "call_progress_legacy",
            name: "poll_command",
            content: TRUNCATED_TOOL_MESSAGE,
          },
        },
      });

      const recovered = threads.recover(THREAD_ID) as SessionWithProgress;
      assert.deepEqual(recovered.progressGuard ?? createProgressGuardState(), createProgressGuardState());
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("recovers a started reviewer as a charged, non-repeatable attempt", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      createThread(threads, dataDir);
      for (let index = 1; index <= 3; index += 1) {
        const observation = failedObservation({
          eventId: `event_review_recovery_${index}`,
          callId: `call_review_recovery_${index}`,
          commandId: commandId(index + 10),
          responseOrdinal: index,
        });
        appendObservation(threads, {
          eventId: observation.sourceEventId,
          callId: observation.sourceCallId,
          observation,
        });
      }
      const pending = recoveredProgress(threads.recover(THREAD_ID)).incidents[0];
      assert.ok(pending);
      const packet = "immutable reviewer recovery packet";
      const binding = {
        reviewId: "review_recovery",
        incidentId: pending.incidentId,
        intentRevision: 1,
        workspaceFingerprint: "sha256:" + "a".repeat(64),
        progressWatermark: 3,
        packetDigest: progressReviewPacketDigest(packet),
      };
      threads.appendEvent(THREAD_ID, {
        type: "progress.review.requested",
        phase: "requested",
        turnId: "turn_progress_recovery",
        payload: { incidentId: pending.incidentId, binding, packet },
      });
      threads.appendEvent(THREAD_ID, {
        type: "progress.review.started",
        phase: "started",
        turnId: "turn_progress_recovery",
        payload: { incidentId: pending.incidentId, reviewId: binding.reviewId },
      });

      const recovered = recoveredProgress(threads.recover(THREAD_ID));
      assert.equal(recovered.incidents[0]?.phase, "reviewing");
      assert.equal(recovered.incidents[0]?.reviewAttempts, 1);
      assert.throws(
        () => threads.appendEvent(THREAD_ID, {
          type: "progress.review.started",
          phase: "started",
          turnId: "turn_progress_recovery",
          payload: { incidentId: pending.incidentId, reviewId: binding.reviewId },
        }),
        /Invalid progress review start/u,
      );
      threads.appendEvent(THREAD_ID, {
        type: "progress.review.unavailable",
        phase: "interrupted",
        turnId: "turn_progress_recovery_resume",
        payload: {
          incidentId: pending.incidentId,
          reviewId: binding.reviewId,
          reason: "started review had no durable terminal event",
          accounting: {
            reviewAttempts: 1,
            validReviews: 0,
            reviewModelRequests: 0,
            reviewInputTokens: 0,
            reviewOutputTokens: 0,
            reviewTotalTokens: 0,
          },
        },
      });
      const terminal = recoveredProgress(threads.recover(THREAD_ID));
      assert.equal(terminal.incidents[0]?.phase, "review_unavailable");
      assert.equal(terminal.incidents[0]?.reviewAttempts, 1);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
