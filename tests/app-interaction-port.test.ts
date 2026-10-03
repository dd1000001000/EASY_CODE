import assert from "node:assert/strict";

import { EasyCodeApp } from "../src/app.js";
import type { AgentRunResult, ImageAttachment, SessionState } from "../src/core/types.js";
import { describe, it } from "./harness.js";

type TurnProbe = {
  state: SessionState;
  executePromptOwned: (...args: unknown[]) => Promise<AgentRunResult>;
};

function appProbe(): EasyCodeApp {
  const app = Object.create(EasyCodeApp.prototype) as EasyCodeApp;
  (app as unknown as TurnProbe).state = { planReview: undefined } as SessionState;
  return app;
}

describe("host-neutral request entry", () => {
  it("makes manual compaction exclusive in both directions and releases the lock on cancellation", async () => {
    const app = appProbe();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal: AbortSignal | undefined;
    let saved = 0;
    Object.assign(app, {
      state: { threadId: "compact_test" },
      hasRunningCommands: () => false,
      subagentCoordinator: { hasUnfinished: () => false, hasOutstanding: () => false },
      terminal: { setCurrentRequest() {}, clearCurrentRequest() {}, compactionProgress() {}, warning() {} },
      activeContextCharLimit: () => 100_000,
      save: () => {
        saved++;
      },
      syncTerminalView() {},
      createRuntime: async () => ({
        compactSession: async (_state: unknown, options: { signal: AbortSignal }) => {
          signal = options.signal;
          await pending;
          return { phase: "cancelled" };
        },
      }),
    });
    const compact = app.handleSlashCommand("/compact");
    assert.equal(app.isCompacting(), true);
    assert.equal(app.isRequestActive(), true);
    await assert.rejects(app.submitUserMessage("Run tests"), /compaction/);
    await assert.rejects(app.submitAdjustment("Continue"), /compaction/);
    await assert.rejects(app.handleSlashCommand("/compact"), /compaction/);
    await assert.rejects(app.handleSlashCommand("/model"), /compaction/);
    assert.equal(app.cancelActiveRequest(), true);
    assert.equal(signal?.aborted, true);
    finish();
    await compact;
    assert.equal(app.isCompacting(), false);
    assert.equal(app.isRequestActive(), false);
    assert.equal(saved, 1);
    Object.assign(app, { activeTurnController: new AbortController() });
    await assert.rejects(app.handleSlashCommand("/compact"), /idle/);
    await assert.rejects(app.submitAdjustment("/compact"), /idle/);
  });

  it("rejects adjustments while automatic compaction runs inside a turn", async () => {
    const app = appProbe();
    Object.assign(app, { autoCompacting: true });
    assert.equal(app.isCompacting(), true);
    await assert.rejects(app.submitAdjustment("Continue"), /compaction/);
    Object.assign(app, { autoCompacting: false });
    assert.equal(app.isCompacting(), false);
  });

  it("accepts one turn, exposes cancellation, and releases ownership after completion", async () => {
    const app = appProbe();
    const internal = app as unknown as TurnProbe;
    let finish!: (result: AgentRunResult) => void;
    const pending = new Promise<AgentRunResult>((resolve) => {
      finish = resolve;
    });
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    internal.executePromptOwned = async (...args: unknown[]) => {
      signal = (args[4] as AbortController).signal;
      started();
      return pending;
    };
    const first = app.submitUserMessage("Inspect the repository");
    // The turn is claimed at once, before its project folders are checked.
    await assert.rejects(app.submitUserMessage("A second turn"), /already running/u);
    await running;
    assert.equal(signal?.aborted, false);
    assert.equal(app.cancelActiveRequest(), true);
    assert.equal(signal?.aborted, true);
    assert.equal(app.cancelActiveRequest(), false);
    const result = { text: "Done" } as AgentRunResult;
    finish(result);
    assert.equal(await first, result);
    assert.equal(app.cancelActiveRequest(), false);

    internal.executePromptOwned = async () => result;
    assert.equal(await app.submitUserMessage("Next turn"), result);
  });

  it("rejects an empty turn or pending plan and releases a failed turn", async () => {
    const app = appProbe();
    const internal = app as unknown as TurnProbe;
    await assert.rejects(app.submitUserMessage("  "), /non-empty prompt/u);
    internal.state = { planReview: {} } as SessionState;
    await assert.rejects(app.submitUserMessage("Continue"), /pending plan/u);
    internal.state = { planReview: undefined } as SessionState;
    internal.executePromptOwned = async () => {
      throw new Error("preflight failed");
    };
    await assert.rejects(app.submitUserMessage("Continue"), /preflight failed/u);
    assert.equal(app.cancelActiveRequest(), false);
  });

  it("persists adjustments before notifying the UI and rejects inactive turns", async () => {
    const app = appProbe();
    const internal = app as unknown as {
      state: SessionState;
      activeTurnSteering:
        | {
            threadId: string;
            controller: AbortController;
            notifier: { notify(sequence: number): void };
            requestImages: [];
            draftImages: Map<string, ImageAttachment>;
          }
        | undefined;
      threadStore: {
        pendingTurnSteering(threadId: string): [];
        enqueueTurnSteering(threadId: string, turnId: string, message: { content: string }): { sequence: number };
      };
      terminal: { addQueuedAdjustment(sequence: number, text: string): void };
    };
    internal.state = { threadId: "thread_one", activeTurnId: "turn_one", provider: "deepseek" } as SessionState;
    const events: string[] = [];
    const controller = new AbortController();
    internal.activeTurnSteering = {
      threadId: "thread_one",
      controller,
      requestImages: [],
      draftImages: new Map(),
      notifier: {
        notify: (sequence) => {
          events.push(`notified:${sequence}`);
        },
      },
    };
    internal.threadStore = {
      pendingTurnSteering: () => [],
      enqueueTurnSteering: (_threadId, _turnId, message) => {
        events.push(`persisted:${message.content}`);
        return { sequence: 1 };
      },
    };
    internal.terminal = {
      addQueuedAdjustment: (sequence, text) => {
        events.push(`displayed:${sequence}:${text}`);
      },
    };
    assert.equal(await app.submitAdjustment("Use the existing parser"), 1);
    assert.deepEqual(events, [
      "persisted:Use the existing parser",
      "notified:1",
      "displayed:1:Use the existing parser",
    ]);
    controller.abort();
    await assert.rejects(app.submitAdjustment("Too late"), /active task finished/u);
    assert.equal(events.length, 3);
  });
});
