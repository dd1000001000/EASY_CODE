import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import { verificationTargetKey } from "../src/command/verification.js";
import { observeToolResult } from "../src/progress/observation.js";
import { createProgressGuardState, foldProgressHint, foldProgressObservation } from "../src/progress/guard.js";
import { clipSemanticFields, parseSemanticRequestPatch } from "../src/context/semantic-compaction.js";
import type { ProgressObservation, ProgressGuardState } from "../src/progress/types.js";

const target = "sha256:" + "a".repeat(64), outcome = "sha256:" + "b".repeat(64), baseline = "c".repeat(64);
function verification(index: number, extra: Partial<ProgressObservation> = {}): ProgressObservation {
  return { schemaVersion: 1, sourceEventId: `e_${index}`, sourceCallId: `c_${index}`, scopeKey: "task", responseOrdinal: index,
    tool: "run_command", kind: "verification_terminal", confidence: "high", outcomeClass: "failed", verificationKind: "unit_test",
    commandId: `command_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, verificationCycleId: `cycle_${index}`,
    targetKey: target, outcomeKey: outcome, evidenceDigest: outcome, baselineDigest: baseline, standardStatus: "unchanged", ...extra };
}
function failures(): ProgressGuardState {
  let state = createProgressGuardState();
  for (let i = 1; i <= 3; i++) state = foldProgressObservation(state, verification(i)).state;
  return state;
}
function read(index: number): ProgressObservation {
  return { schemaVersion: 1, sourceEventId: `r_${index}`, sourceCallId: `rc_${index}`, scopeKey: "task", responseOrdinal: index,
    tool: "read_file", kind: "read", confidence: "high", outcomeClass: "unknown", targetKey: target, outcomeKey: outcome,
    readRange: { fileKey: target, start: 1, end: 100 },
    investigationPolicy: { minimum: 5, ratio: 0.7, window: 12, review: true } };
}

describe("progress reliability contracts", () => {
  it("persists one-shot weak hints without changing execution state", () => {
    const original = createProgressGuardState();
    const first = foldProgressHint(original, { scopeKey: "task", kind: "search" });
    const replay = foldProgressHint(first, { scopeKey: "task", kind: "search" });
    assert.deepEqual(replay.presentedWeakHintScopes, ["search:task"]);
    assert.equal(original.presentedWeakHintScopes, undefined);
    assert.throws(() => foldProgressHint(first, { scopeKey: "task", kind: "approve" }));
  });

  it("deduplicates terminal polls without promoting inspection activity to review", () => {
    const inspect = (index: number, truncated = false, status = "exited") => observeToolResult({
      sourceEventId: `inspection_${index}`, sourceCallId: `ic_${index}`, scopeKey: "task", responseOrdinal: index,
      tool: "poll_command", verificationIntent: false,
      investigationPolicy: { minimum: 5, ratio: 0.7, window: 12, review: true },
      result: { ok: true, summary: "read only", data: {
        commandId: `command_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, status,
        exitCode: status === "running" ? null : 0, requestMetadata: { intent: "inspect" },
        stdout: { text: "same source evidence", truncated }, stderr: { text: "", truncated: false },
      } },
    });
    assert.equal(inspect(1).kind, "investigation_terminal");
    assert.equal(inspect(1, true).kind, "neutral");
    assert.equal(inspect(1, false, "running").kind, "neutral");
    let state = createProgressGuardState();
    for (let i = 1; i <= 24; i++) state = foldProgressObservation(state, inspect(i)).state;
    assert.equal(state.incidents.length, 0);
    const duplicate = foldProgressObservation(state, { ...inspect(24), sourceEventId: "polled_again", sourceCallId: "other_poll" });
    assert.equal(duplicate.reason, "duplicate_terminal_command");
  });

  it("normalizes display filters without merging selectors or environments", () => {
    const command = (script: string) => ({ program: "bash", args: ["-c", script], cwd: "/testbed" });
    assert.equal(verificationTargetKey(command("python runtests.py a 2>&1 | grep FAIL")), verificationTargetKey(command("python runtests.py a | tail -20")));
    assert.notEqual(verificationTargetKey(command("python runtests.py a | grep FAIL")), verificationTargetKey(command("python runtests.py b | grep FAIL")));
    assert.notEqual(verificationTargetKey(command("python runtests.py a | grep FAIL")), verificationTargetKey(command("python runtests.py a; echo OK")));
    assert.notEqual(verificationTargetKey({ ...command("python runtests.py a"), environmentDigest: "one" }), verificationTargetKey({ ...command("python runtests.py a"), environmentDigest: "two" }));
  });

  it("uses repeated verified failures only to schedule one review", () => {
    const state = failures();
    assert.equal(state.incidents.length, 1);
    assert.equal(state.incidents[0]?.phase, "review_pending");
    assert.equal(foldProgressObservation(state, verification(4, { outcomeClass: "passed" })).state.incidents[0]?.phase, "resolved");
    assert.equal(foldProgressObservation(state, verification(4, { outcomeClass: "passed", standardStatus: "changed" })).state.incidents[0]?.phase, "review_pending");
  });

  it("keeps repeated reads as a weak warning and never creates a reviewer incident", () => {
    let state = createProgressGuardState();
    for (let i = 1; i <= 12; i++) state = foldProgressObservation(state, read(i)).state;
    assert.ok(state.readWarning);
    assert.equal(state.incidents.length, 0);
  });

  it("clips UTF-16 safely and never admits structurally invalid patches", () => {
    const clipped = clipSemanticFields({ currentWork: "x".repeat(1199) + "😀more", nextStep: "verify" }, 1200);
    assert.equal((clipped.patch as { currentWork: string }).currentWork.length, 1199);
    assert.throws(() => parseSemanticRequestPatch({ currentWork: "x".repeat(1300), nextStep: false }));
  });
});
