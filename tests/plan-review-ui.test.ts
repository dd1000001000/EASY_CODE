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

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

class TtyOutput extends PassThrough {
  readonly isTTY = true;
  readonly columns = 100;
  readonly rows = 30;
}

async function waitForText(
  read: () => string,
  expected: RegExp,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (expected.test(read())) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${expected}`);
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

  it("does not silently truncate long plan adjustment feedback", async () => {
    const feedback = `${"detail ".repeat(800)}PLAN-FEEDBACK-TAIL`;
    const terminal = new ScriptedPlanTerminal([feedback]);
    const decision = await terminal.reviewPlan();
    assert.equal(decision.action, "adjust");
    if (decision.action !== "adjust") return;
    assert.equal(decision.feedback, feedback);
    assert.match(decision.feedback, /PLAN-FEEDBACK-TAIL$/u);
  });

  it("keeps multiline pasted adjustment feedback intact until explicit Enter", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    const terminal = new Terminal(input, output);
    let settled = false;
    const review = terminal.reviewPlan().then((decision) => {
      settled = true;
      return decision;
    });

    await waitForText(() => transcript, /Choose 1\/2/u);
    input.write("3\r");
    await waitForText(() => transcript, /Plan feedback >/u);
    input.write("\u001B[200~A\nB\u001B[201~");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(settled, false);
    assert.match(transcript, /\[Pasted text #1 · 2 lines\]/u);

    input.write("\r");
    assert.deepEqual(await review, {
      action: "adjust",
      feedback: "A\nB",
    });
    terminal.close();
  });

  it("keeps multiline feedback intact after choosing Adjust in the inline menu", async () => {
    const previousCI = process.env.CI;
    const previousTerm = process.env.TERM;
    process.env.CI = "";
    process.env.TERM = "xterm-256color";
    try {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.setEncoding("utf8");
      let transcript = "";
      output.on("data", (chunk: string) => {
        transcript += chunk;
      });
      output.resume();
      const terminal = new Terminal(input, output);
      assert.equal(terminal.beginShell({
        threadId: "thread_plan_review",
        workspaceRoot: "F:\\projects\\plan-review",
        mode: "auto",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "medium",
        contextTokens: 0,
      }), true);
      terminal.showPlan(plan());
      let settled = false;
      const review = terminal.reviewPlan().then((decision) => {
        settled = true;
        return decision;
      });

      await waitForText(() => transcript, /Review proposed plan/u);
      input.write("\u001B[B\u001B[B\r");
      await waitForText(() => transcript, /Plan feedback >/u);
      input.write("\u001B[200~First line\nSecond line\u001B[201~");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);

      input.write("\r");
      assert.deepEqual(await review, {
        action: "adjust",
        feedback: "First line\nSecond line",
      });
      // The permanent conversation viewport remains the terminal input owner
      // after the feedback editor completes.
      assert.equal(input.isRaw, true);
      terminal.close();
    } finally {
      if (previousCI === undefined) delete process.env.CI;
      else process.env.CI = previousCI;
      if (previousTerm === undefined) delete process.env.TERM;
      else process.env.TERM = previousTerm;
    }
  });

  it("records only accepted feedback when retained UI uses the numbered path", async () => {
    const previousCI = process.env.CI;
    const previousTerm = process.env.TERM;
    process.env.CI = "";
    process.env.TERM = "xterm-256color";
    try {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const terminal = new Terminal(input, output);
      assert.equal(terminal.beginShell({
        threadId: "thread_numbered_plan_review",
        workspaceRoot: "F:\\projects\\plan-review",
        mode: "auto",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "medium",
        contextTokens: 0,
      }), true);

      const review = terminal.reviewPlan();
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write("3\r");
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write("\u001B[200~A\nB\u001B[201~\r");

      assert.deepEqual(await review, {
        action: "adjust",
        feedback: "A\nB",
      });
      const state = terminal as unknown as {
        uiState: {
          transcript: Array<{ kind: string; text: string }>;
        };
      };
      assert.deepEqual(
        state.uiState.transcript
          .filter((entry) => entry.kind === "user")
          .map((entry) => entry.text),
        ["A\nB"],
      );
      terminal.close();
    } finally {
      if (previousCI === undefined) delete process.env.CI;
      else process.env.CI = previousCI;
      if (previousTerm === undefined) delete process.env.TERM;
      else process.env.TERM = previousTerm;
    }
  });

  it("re-prompts instead of submitting a failed clipboard marker as feedback", async () => {
    const input = new TtyInput();
    const output = new TtyOutput();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    output.resume();
    const terminal = new Terminal(input, output);
    const review = terminal.reviewPlan({
      captureText: async () => {
        throw new Error("clipboard helper unavailable");
      },
    });

    await waitForText(() => transcript, /Choose 1\/2/u);
    input.write("3\r");
    await waitForText(() => transcript, /Plan feedback >/u);
    input.write("\u0016");
    await waitForText(() => transcript, /Text paste failed/u);
    input.write("\r");
    await waitForText(() => transcript, /Plan feedback paste failed/u);
    assert.match(transcript, /clipboard helper unavailable/u);
    input.write("\u001B[200~A\nB\u001B[201~\r");

    assert.deepEqual(await review, {
      action: "adjust",
      feedback: "A\nB",
    });
    terminal.close();
  });

  it("defers without rejecting when terminal input closes", async () => {
    const terminal = new ScriptedPlanTerminal([null]);
    assert.deepEqual(await terminal.reviewPlan(), { action: "defer" });
  });
});
