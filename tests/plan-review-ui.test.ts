import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { Terminal } from "../src/cli/terminal.js";
import type { PlanProposal } from "../src/core/types.js";
import { describe, it } from "./harness.js";

class ScriptedPlanTerminal extends Terminal {
  transcript = "";

  constructor(private readonly answers: Array<string | null>) {
    super(new PassThrough(), new PassThrough());
  }

  override isInteractive(): boolean {
    return true;
  }

  override question(prompt: string): Promise<string | null> {
    this.transcript += prompt;
    return Promise.resolve(this.answers.shift() ?? null);
  }

  override write(text: string): void {
    this.transcript += text;
  }

  override close(): void {
    // Scripted streams do not own external resources.
  }
}

function plan(): PlanProposal {
  return {
    id: "plan_11111111-1111-4111-8111-111111111111",
    revision: 2,
    proposedByTurnId: "turn_plan",
    proposedAt: "2026-08-27T00:00:00.000Z",
    title: "Add authentication",
    overview: "Add login and registration before course selection.",
    steps: [{
      title: "Implement the UI",
      description: "Add login, registration, and signed-in states.",
      verification: "Verify login, logout, and two isolated accounts.",
    }],
  };
}

describe("plan review terminal UI", () => {
  it("shows the structured proposal and accepts Yes/use Auto", async () => {
    const terminal = new ScriptedPlanTerminal(["1"]);
    terminal.showPlan(plan());
    const decision = await terminal.reviewPlan();

    assert.deepEqual(decision, { action: "approve" });
    assert.match(terminal.transcript, /Plan: Add authentication/u);
    assert.match(terminal.transcript, /Plan ID: .*revision 2/u);
    assert.match(terminal.transcript, /1\. Yes, use Auto mode/u);
    assert.match(terminal.transcript, /2\. No, reject plan/u);
    assert.match(terminal.transcript, /type feedback to adjust/u);
  });

  it("rejects only on the explicit No choice", async () => {
    const terminal = new ScriptedPlanTerminal(["no"]);
    assert.deepEqual(await terminal.reviewPlan(), { action: "reject" });
  });

  it("treats arbitrary Unicode text as direct adjustment feedback", async () => {
    const secret = "abcdefghijklmnopqrstuvwxyz";
    const terminal = new ScriptedPlanTerminal([
      `请把登录框改成弹窗\u001B[31m api_key=${secret}`,
    ]);
    const decision = await terminal.reviewPlan();

    assert.equal(decision.action, "adjust");
    if (decision.action !== "adjust") return;
    assert.match(decision.feedback, /请把登录框改成弹窗/u);
    assert.doesNotMatch(decision.feedback, /\u001B/u);
    assert.doesNotMatch(decision.feedback, new RegExp(secret, "u"));
  });

  it("supports the numbered Adjust choice followed by feedback", async () => {
    const terminal = new ScriptedPlanTerminal(["3", "Keep the existing CSS classes"]);
    assert.deepEqual(await terminal.reviewPlan(), {
      action: "adjust",
      feedback: "Keep the existing CSS classes",
    });
    assert.match(terminal.transcript, /Plan feedback >/u);
  });

  it("defers without rejecting when terminal input closes", async () => {
    const terminal = new ScriptedPlanTerminal([null]);
    assert.deepEqual(await terminal.reviewPlan(), { action: "defer" });
  });
});
