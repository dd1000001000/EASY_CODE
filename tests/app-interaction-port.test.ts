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
  it("accepts one turn, exposes cancellation, and releases ownership after completion", async () => {
    const app = appProbe();
    const internal = app as unknown as TurnProbe;
    let finish!: (result: AgentRunResult) => void;
    const pending = new Promise<AgentRunResult>((resolve) => { finish = resolve; });
    let signal: AbortSignal | undefined;
    internal.executePromptOwned = async (...args: unknown[]) => {
      signal = (args[4] as AbortController).signal;
      return pending;
    };
    const first = app.submitUserMessage("Inspect the repository");
    assert.equal(signal?.aborted, false);
    await assert.rejects(app.submitUserMessage("A second turn"), /already running/u);
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
    internal.executePromptOwned = async () => { throw new Error("preflight failed"); };
    await assert.rejects(app.submitUserMessage("Continue"), /preflight failed/u);
    assert.equal(app.cancelActiveRequest(), false);
  });

  it("persists adjustments before notifying the UI and rejects inactive turns", async () => {
    const app = appProbe();
    const internal = app as unknown as {
      state: SessionState;
      activeTurnSteering: {
        threadId: string;
        controller: AbortController;
        notifier: { notify(sequence: number): void };
        requestImages: [];
        draftImages: Map<string, ImageAttachment>;
      } | undefined;
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
      threadId: "thread_one", controller, requestImages: [], draftImages: new Map(),
      notifier: { notify: sequence => { events.push(`notified:${sequence}`); } },
    };
    internal.threadStore = {
      pendingTurnSteering: () => [],
      enqueueTurnSteering: (_threadId, _turnId, message) => {
        events.push(`persisted:${message.content}`);
        return { sequence: 1 };
      },
    };
    internal.terminal = {
      addQueuedAdjustment: (sequence, text) => { events.push(`displayed:${sequence}:${text}`); },
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
