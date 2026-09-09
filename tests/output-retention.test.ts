import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import { projectText, displayTextSchema } from "../src/utils/bounded-text.js";
import { estimatedTokens } from "../src/context/token-budget.js";
import { semanticSummarySchema, clipSemanticFields, parseSemanticCandidatePatch } from "../src/context/semantic-compaction.js";
import { progressReviewReportSchema } from "../src/progress/reviewer.js";
import { proposePlanInputSchema } from "../src/tools/propose-plan.js";
import { submitTaskResultInputSchema } from "../src/tools/submit-task-result.js";
import { TaskBudget } from "../src/runtime/task-budget.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";

describe("storage-only output retention", () => {
  it("keeps Unicode-safe prefixes within character, byte and estimated-token budgets", () => {
    const text = "abc😀中文".repeat(1000);
    for (const measure of [(text: string) => text.length, (text: string) => Buffer.byteLength(text), estimatedTokens]) {
      for (const limit of [0, 1, 4, 17, 2048]) {
        const result = projectText(text, limit, measure);
        assert.ok(result.truncated);
        assert.ok(text.startsWith(result.text));
        assert.ok(measure(result.text) <= limit);
        assert.doesNotMatch(result.text, /[\uD800-\uDBFF]$/u);
      }
    }
    assert.throws(() => displayTextSchema(20).parse(17));
    assert.match(displayTextSchema(20).parse("x".repeat(100)), /truncated/u);
  });

  it("clips semantic lists only after validating every item, keeping evidence IDs strict", () => {
    const input = { currentWork: "x".repeat(150000), nextStep: "Verify", hypotheses: Array(35).fill("y".repeat(1400)) };
    const normalized = semanticSummarySchema.parse(clipSemanticFields(parseSemanticCandidatePatch(input)).patch);
    assert.equal(normalized.currentWork.length, DEFAULT_RUNTIME_LIMITS.contextSemanticFieldMaxChars);
    assert.equal(normalized.hypotheses.length, 32);
    assert.equal(normalized.hypotheses[0]!.length, 1400);
    assert.throws(() => parseSemanticCandidatePatch({ ...input, hypotheses: [...input.hypotheses, 42] }));
    assert.throws(() => parseSemanticCandidatePatch({ ...input, conclusions: [{ text: "claim", evidenceIds: ["bad-id"] }] }));
  });

  it("clips reviewer prose but never clips executable arguments", () => {
    const report = { recommendation: "run_experiment", summary: "s".repeat(5000), diagnosis: "d", evidence: "e",
      experiment: "experiment", expectedSignal: "yes", falsifyingSignal: "no",
      experimentProgram: "python", experimentArgsJson: '["-c","print(1)"]', experimentCwd: "." };
    const result = progressReviewReportSchema.parse(report);
    assert.ok(result.summary.length <= 2000);
    assert.match(result.summary, /truncated/u);
    assert.equal(result.experimentArgsJson, report.experimentArgsJson);
    assert.throws(() => progressReviewReportSchema.parse({ ...report, experimentArgsJson: "x".repeat(9000) }));
    assert.throws(() => progressReviewReportSchema.parse({ ...report, experimentProgram: "x".repeat(1025) }));
    assert.throws(() => progressReviewReportSchema.parse({ ...report, falsifyingSignal: "x".repeat(2001) }));
    assert.throws(() => progressReviewReportSchema.parse({ ...report, evidence: "x".repeat(4001) }));
  });

  it("clips plan/report presentation but preserves complete verification contracts", () => {
    const draft = { title: "x".repeat(500), overview: "y".repeat(5000),
      steps: [{ title: "test", description: "implement", verification: "check all cases" }] };
    const result = proposePlanInputSchema.parse(draft);
    assert.ok(result.title.length <= 200);
    assert.ok(result.overview.length <= 4000);
    assert.deepEqual(result.steps, draft.steps);
    assert.throws(() => proposePlanInputSchema.parse({ ...draft, steps: [{ ...draft.steps[0], verification: "x".repeat(1001) }] }));
    const submission = { outcome: "completed", summary: "s".repeat(18000), evidence: ["test passed"] };
    assert.ok(submitTaskResultInputSchema.parse(submission).summary.length <= DEFAULT_RUNTIME_LIMITS.subagentSummaryMaxChars);
    assert.throws(() => submitTaskResultInputSchema.parse({ ...submission, evidence: ["e".repeat(1001)] }));
    assert.throws(() => submitTaskResultInputSchema.parse({ outcome: "completed", summary: "done" }));
  });

  it("settles actual output above its local reservation and prevents further spending", () => {
    const budget = new TaskBudget(5, 1000);
    const settle = budget.reserve({ messages: [], outputReserveTokens: 100 });
    assert.ok(budget.snapshot().reservedTokens >= 100);
    settle({ totalTokens: 1500 });
    assert.equal(budget.snapshot().tokens, 1500);
    assert.equal(budget.snapshot().reservedTokens, 0);
    assert.throws(() => budget.reserve({ messages: [], outputReserveTokens: 100 }), /shared token budget/u);
  });
});
