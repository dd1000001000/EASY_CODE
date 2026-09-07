import assert from "node:assert/strict";

import {
  assertProgressObservationBinding,
  observeToolResult,
  parseProgressObservation,
} from "../src/progress/observation.js";
import { describe, it } from "./harness.js";

const COMMAND_ID = "command_00000000-0000-4000-8000-000000000001";

function commandOutput(
  status: "running" | "exited" | "timed_out" | "sandbox_unavailable",
  exitCode: number | null,
  output = "",
): Record<string, unknown> {
  return {
    commandId: COMMAND_ID,
    status,
    exitCode,
    stdout: { text: output },
    stderr: { text: status === "exited" ? "" : output },
    executed: { program: "npm", args: ["test"], cwd: "." },
    ...(status === "exited" && exitCode !== 0
      ? { failure: { kind: "exit", code: "nonzero_exit" } }
      : {}),
  };
}

describe("progress observation", () => {
  it("derives bounded command evidence before model-facing output is truncated", () => {
    const observation = observeToolResult({
      sourceEventId: "event_command_result",
      sourceCallId: "call_command_result",
      scopeKey: "thread:test/task:backend",
      responseOrdinal: 7,
      tool: "run_command",
      verificationIntent: true,
      result: {
        ok: false,
        summary: "test failed",
        data: commandOutput("exited", 1, "x".repeat(2_000_000)),
        error: "test failed",
      },
    });

    assert.equal(observation.kind, "verification_terminal");
    assert.equal(observation.confidence, "high");
    assert.equal(observation.outcomeClass, "failed");
    assert.equal(observation.commandId, COMMAND_ID);
    assert.equal(observation.verificationCycleId, COMMAND_ID);
    assert.match(observation.targetKey ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.match(observation.outcomeKey ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.ok(JSON.stringify(observation).length < 2_000);
  });

  it("does not let a running poll consume the terminal command de-duplication key", () => {
    const observation = observeToolResult({
      sourceEventId: "event_running_poll",
      sourceCallId: "call_running_poll",
      scopeKey: "thread:test",
      responseOrdinal: 2,
      tool: "poll_command",
      result: {
        ok: true,
        summary: "still running",
        data: commandOutput("running", null),
      },
    });

    assert.equal(observation.kind, "neutral");
    assert.equal(observation.commandId, undefined);
    assert.equal(observation.verificationCycleId, undefined);
  });

  it("classifies sandbox failures separately from code verification failures", () => {
    const observation = observeToolResult({
      sourceEventId: "event_sandbox_failure",
      sourceCallId: "call_sandbox_failure",
      scopeKey: "thread:test",
      responseOrdinal: 3,
      tool: "run_command",
      result: {
        ok: false,
        summary: "sandbox unavailable",
        data: commandOutput("sandbox_unavailable", null, "sandbox did not initialize"),
      },
    });

    assert.equal(observation.kind, "infrastructure_failure");
    assert.equal(observation.outcomeClass, "unknown");
    assert.equal(observation.commandId, COMMAND_ID);
    assert.equal(observation.verificationCycleId, undefined);
  });

  it("does not promote an ordinary command failure into verified code evidence", () => {
    const observation = observeToolResult({
      sourceEventId: "event_inspect_failure",
      sourceCallId: "call_inspect_failure",
      scopeKey: "thread:test",
      responseOrdinal: 4,
      tool: "run_command",
      verificationIntent: false,
      result: {
        ok: false,
        summary: "git inspection failed",
        data: commandOutput("exited", 1, "not a repository"),
      },
    });

    assert.equal(observation.kind, "neutral");
    assert.equal(observation.confidence, "low");
    assert.equal(observation.commandId, undefined);
  });

  it("turns a verified read range into a stable coverage target without storing content", () => {
    const contentHash = "a".repeat(64);
    const observation = observeToolResult({
      sourceEventId: "event_read_result",
      sourceCallId: "call_read_result",
      scopeKey: "thread:test",
      responseOrdinal: 4,
      tool: "read_file",
      result: {
        ok: true,
        summary: "read file",
        data: {
          path: "src/app.ts",
          content: "secret source bytes must not be retained",
          startLine: 1,
          endLine: 25,
          totalLines: 100,
          contentHash,
          truncated: true,
        },
      },
    });

    assert.equal(observation.kind, "read");
    assert.equal(observation.outcomeKey, `sha256:${contentHash}`);
    assert.doesNotMatch(JSON.stringify(observation), /secret source bytes/u);
  });

  it("strictly rejects unbounded, extra, and incorrectly bound journal material", () => {
    const valid = observeToolResult({
      sourceEventId: "event_bound",
      sourceCallId: "call_bound",
      scopeKey: "thread:test",
      responseOrdinal: 1,
      tool: "run_command",
      verificationIntent: true,
      result: {
        ok: true,
        summary: "passed",
        data: commandOutput("exited", 0),
      },
    });

    assert.throws(
      () => parseProgressObservation({ ...valid, injected: "not allowed" }),
      /shape/u,
    );
    assert.throws(
      () => parseProgressObservation({ ...valid, scopeKey: "x".repeat(513) }),
      /scopeKey/u,
    );
    assert.throws(
      () => assertProgressObservationBinding(valid, {
        sourceEventId: "event_other",
        sourceCallId: valid.sourceCallId,
      }),
      /sourceEventId/u,
    );
    assert.throws(
      () => parseProgressObservation(valid, {
        sourceEventId: valid.sourceEventId,
        sourceCallId: "call_other",
      }),
      /sourceCallId/u,
    );
  });
});
