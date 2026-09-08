import assert from "node:assert/strict";
import { CommandVerificationCollector } from "../src/command/verification.js";
import { OutputCollector } from "../src/command/output-stream.js";
import { observeToolResult } from "../src/progress/observation.js";
import { createProgressGuardState, foldProgressObservation } from "../src/progress/guard.js";
import { describe, it } from "./harness.js";

const pipeline = { program: "/bin/bash", args: ["-c", "python runtests.py deletion 2>&1 | grep -E 'FAIL|Error'"] };
const failure = "FAIL: test_batch_boundary (deletion.tests.DeletionTests)\nAssertionError: 2 != 3\nFAILED (failures=1)\n";
function collect(command: { program: string; args: string[] }, text: string, exitCode = 0) {
  const collector = new CommandVerificationCollector(command);
  // Deliberately split UTF-8/ANSI and terminal lines across transport chunks.
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += 7) collector.push("stderr", bytes.subarray(i, i + 7));
  return collector.finish("exited", exitCode, "unit_test");
}

describe("command validation evidence", () => {
  it("overrides a zero pipeline exit with a real unittest failure report", () => {
    const validation = collect(pipeline, failure);
    assert.equal(validation.status, "failed");
    assert.equal(validation.confidence, "high");
    assert.equal(validation.source, "framework_summary");
    assert.match(validation.evidenceKey ?? "", /^sha256:/u);
  });

  it("does not equate a bare outer exit, fixture prose or grep no-match with a test verdict", () => {
    assert.equal(collect(pipeline, "", 0).status, "unknown");
    assert.equal(collect(pipeline, "", 1).status, "unknown");
    assert.equal(collect(pipeline, "expected output: FAILED (failures=1)\n", 0).status, "unknown");
    assert.equal(collect({ program: "bash", args: ["-c", "echo 'FAILED (failures=1)'"] }, "FAILED (failures=1)\n").status, "unknown");
    assert.equal(collect(pipeline, "OK\n", 1).status, "unknown");
    const summaryOnly = collect(pipeline, "FAILED (failures=1)\n");
    assert.equal(summaryOnly.status, "failed");
    assert.equal(summaryOnly.confidence, "low", "counts alone cannot identify the same failure three times");
  });

  it("keeps framework evidence independently of display clipping and does not merge different assertions", () => {
    const text = "setup\n".repeat(100) + failure + "cleanup\n".repeat(100);
    const display = new OutputCollector(256); display.push(text);
    assert.equal(display.finish().text.includes("FAILED"), false);
    assert.equal(collect(pipeline, text).status, "failed");
    assert.notEqual(collect(pipeline, failure).evidenceKey, collect(pipeline, failure.replace("2 != 3", "4 != 5")).evidenceKey);
  });

  it("recognizes pytest, node and Jest summaries only for the matching runner", () => {
    assert.equal(collect({ program: "pytest", args: ["tests"] }, "FAILED tests/test_a.py::test_a - assert 1 == 2\n=== 1 failed in 0.12s ===\n", 1).status, "failed");
    assert.equal(collect({ program: "python", args: ["-m", "pytest"] }, "=== 3 passed, 1 skipped in 0.12s ===\n").status, "passed");
    assert.equal(collect({ program: "node", args: ["--test"] }, "# tests 3\n# pass 3\n# fail 0\n").status, "passed");
    const nodeFailure = collect({ program: "node", args: ["--test"] }, "not ok 1 - boundary\n  expected: 3\n  actual: 2\n# tests 1\n# pass 0\n# fail 1\n", 1);
    assert.equal(nodeFailure.status, "failed"); assert.equal(nodeFailure.confidence, "high");
    assert.equal(collect({ program: "jest", args: [] }, "Test Suites: 2 passed, 2 total\n").status, "passed");
    assert.equal(collect({ program: "python", args: ["-m", "unittest"] }, "Ran 3 tests in 1.1s\n\nOK\n").status, "passed");
  });

  it("downgrades mixed targets, repeated reports, incomplete lines and interrupted runs", () => {
    assert.equal(collect({ program: "sh", args: ["-c", "python runtests.py a; python runtests.py b"] }, failure).status, "unknown");
    assert.equal(collect(pipeline, failure + "OK\n").status, "unknown");
    assert.equal(collect(pipeline, "x".repeat(9000) + "\n" + failure).status, "unknown");
    assert.equal(collect(pipeline, "OK\n").status, "unknown");
    assert.equal(collect({ program: "pytest", args: [] }, "=== 3 skipped in 0.01s ===\n").status, "unknown");
    const collector = new CommandVerificationCollector(pipeline); collector.push("stdout", failure);
    assert.equal(collector.finish("timed_out", null, "custom").status, "unknown");
  });

  it("triggers a reviewer after three distinct matching failure cycles and deduplicates polls", () => {
    let state = createProgressGuardState();
    let trigger;
    for (let index = 1; index <= 3; index++) {
      const observation = observeToolResult({ sourceEventId: `event_${index}`, sourceCallId: `call_${index}`, scopeKey: "thread:test", responseOrdinal: index,
        tool: "run_command", verificationIntent: true, verificationKind: "unit_test", result: { ok: false, summary: "validation failed", data: {
          commandId: `command_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, status: "exited", exitCode: 0,
          executed: { ...pipeline, cwd: "." }, validation: collect(pipeline, failure), stdout: { text: "clipped" }, stderr: { text: "" },
        } } });
      const folded = foldProgressObservation(state, observation); state = folded.state; trigger = folded.trigger;
      const repeated = foldProgressObservation(state, { ...observation, sourceEventId: `poll_${index}`, tool: "poll_command" });
      assert.equal(repeated.duplicate, true); state = repeated.state;
    }
    assert.equal(trigger?.kind, "repeated_verified_failure");
    assert.equal(state.incidents.length, 1);
    const before = JSON.stringify(state.failureRuns);
    const unknown = observeToolResult({ sourceEventId: "unknown", sourceCallId: "call_unknown", scopeKey: "thread:test", responseOrdinal: 4,
      tool: "run_command", verificationIntent: true, result: { ok: true, summary: "exit zero", data: {
        commandId: "command_00000000-0000-4000-8000-000000000004", status: "exited", exitCode: 0,
        executed: { ...pipeline, cwd: "." }, validation: collect(pipeline, ""),
      } } });
    state = foldProgressObservation(state, unknown).state;
    assert.equal(JSON.stringify(state.failureRuns), before);
    assert.equal(state.incidents[0]?.phase, "review_pending");
    const weakPass = { ...unknown, sourceEventId: "weak_pass", sourceCallId: "weak_pass_call", commandId: "command_00000000-0000-4000-8000-000000000005", outcomeClass: "passed", confidence: "low" };
    assert.equal(foldProgressObservation(state, weakPass).state.incidents[0]?.phase, "review_pending");
    // Resume consumes journal observations, not a reparsed clipped summary.
    assert.deepEqual(foldProgressObservation(JSON.parse(JSON.stringify(state)), unknown).state.failureRuns, state.failureRuns);
  });
});
