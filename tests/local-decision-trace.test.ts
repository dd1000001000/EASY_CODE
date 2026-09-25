import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendLocalDecisionFallbackTrace, appendLocalDecisionTrace } from "../src/local-decision/trace.js";
import { describe, it } from "./harness.js";

describe("local decision trace", () => {
  it("records the exact model-bound input and decision in the project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-local-decision-"));
    try {
      const input = "Original user request:\n修复登录\n\nMain agent completion summary:\n已修复登录";
      await appendLocalDecisionTrace(root, {
        id: "decision_test", threadId: "thread_123", turnId: "turn_123",
        challenged: false, challengeAlreadyUsed: false, appliedDecision: "RELEASE",
        decision: { task: "delivery", input, inputTokens: 36, truncated: false,
          optionOrder: ["RELEASE", "CHALLENGE"], scores: { RELEASE: 0.91, CHALLENGE: 0.09 },
          decision: "RELEASE", modelSha256: "test-hash", device: "cpu" },
      });
      await appendLocalDecisionFallbackTrace(root, {
        id: "decision_fallback", threadId: "thread_123", turnId: "turn_124",
        task: "route", input: "Can you inspect this repository?", reason: "Python unavailable",
      });
      const data = await readFile(path.join(root, ".easycode", "decision-traces", "thread_123.jsonl"), "utf8");
      const [line, fallbackLine] = data.trim().split("\n");
      const record = JSON.parse(line!) as Record<string, unknown>;
      assert.equal(record.input, input);
      assert.equal(record.decision, "RELEASE");
      assert.equal(record.appliedDecision, "RELEASE");
      assert.equal(record.challenged, false);
      const fallback = JSON.parse(fallbackLine!) as Record<string, unknown>;
      assert.equal(fallback.decision, null);
      assert.equal(fallback.fallbackToCloud, true);
      assert.equal(fallback.submittedToModel, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
