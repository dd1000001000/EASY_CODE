import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import { verificationTargetKey } from "../src/command/verification.js";
import { matchesReviewExperiment } from "../src/progress/experiment.js";
import { observeToolResult } from "../src/progress/observation.js";
import { createProgressGuardState, foldProgressObservation } from "../src/progress/guard.js";
import { foldProgressReviewEvent } from "../src/progress/lifecycle.js";
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
function read(index: number, extra: Partial<ProgressObservation> = {}): ProgressObservation {
  return { schemaVersion: 1, sourceEventId: `r_${index}`, sourceCallId: `rc_${index}`, scopeKey: "task", responseOrdinal: index,
    tool: "read_file", kind: "read", confidence: "high", outcomeClass: "unknown", targetKey: target, outcomeKey: outcome,
    readRange: { fileKey: target, start: 1, end: 100 },
    investigationPolicy: { minimum: 5, ratio: 0.7, window: 12, review: true }, ...extra };
}

describe("progress reliability contracts", () => {
  it("replays one-shot weak hints without duplicating the task-scope registry", () => {
    const original = createProgressGuardState();
    const first = foldProgressReviewEvent(original, "progress.hint.presented", { scopeKey: "task", kind: "search" });
    const replay = foldProgressReviewEvent(first, "progress.hint.presented", { scopeKey: "task", kind: "search" });
    assert.deepEqual(replay.presentedWeakHintScopes, ["search:task"]);
    assert.equal(original.presentedWeakHintScopes, undefined);
    assert.throws(() => foldProgressReviewEvent(first, "progress.hint.presented", { scopeKey: "task", kind: "approve" }));
  });
  it("counts only complete successful inspection outputs and deduplicates terminal polls", () => {
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
    assert.equal(state.incidents[0]?.phase, "review_pending");
    const duplicate = foldProgressObservation(state, { ...inspect(24), sourceEventId: "polled_again", sourceCallId: "other_poll" });
    assert.equal(duplicate.reason, "duplicate_terminal_command");
    assert.equal(duplicate.state.acceptedObservations, 24);
  });
  it("normalizes literal display filters without merging selectors, environment or shell control flow", () => {
    const command = (script: string) => ({ program: "bash", args: ["-c", script], cwd: "/testbed" });
    assert.equal(verificationTargetKey(command("python runtests.py a 2>&1 | grep FAIL")), verificationTargetKey(command("python runtests.py a | tail -20")));
    assert.notEqual(verificationTargetKey(command("python runtests.py a | grep FAIL")), verificationTargetKey(command("python runtests.py b | grep FAIL")));
    assert.notEqual(verificationTargetKey(command("python runtests.py a | grep FAIL")), verificationTargetKey(command("python runtests.py a; echo OK")));
    assert.notEqual(verificationTargetKey(command("python runtests.py '2>&1' | grep FAIL")), verificationTargetKey(command("python runtests.py | grep FAIL")));
    assert.notEqual(verificationTargetKey({ ...command("python runtests.py a"), environmentDigest: "one" }), verificationTargetKey({ ...command("python runtests.py a"), environmentDigest: "two" }));
  });

  it("retains known changed standards but accepts actual passes without a global inventory", () => {
    for (const change of [{ standardStatus: "changed" as const }, { baselineDigest: "d".repeat(64) }]) {
      const state = foldProgressObservation(failures(), verification(4, { outcomeClass: "passed", ...change })).state;
      assert.equal(state.failureRuns.length, 1);
      assert.notEqual(state.incidents[0]!.phase, "resolved");
    }
    for (const change of [{ standardStatus: "unknown" as const },
      { baselineDigest: undefined, standardStatus: undefined }]) {
      const state = foldProgressObservation(failures(), verification(4, { outcomeClass: "passed", ...change })).state;
      assert.equal(state.failureRuns.length, 0);
    }
    assert.equal(foldProgressObservation(failures(), verification(4, { outcomeClass: "passed" })).state.failureRuns.length, 0);
  });

  it("unrelated commands cannot complete a contracted experiment, including an unrelated pass", () => {
    const state = failures(), incident = state.incidents[0]!;
    incident.phase = "experiment_required";
    incident.reviewReport = { recommendation: "run_experiment", summary: "s", diagnosis: "h1 versus h2", evidence: "e", experiment: "test", expectedSignal: "pass", falsifyingSignal: "fail",
      experimentProgram: "node", experimentArgsJson: '["--test"]', experimentCwd: "." };
    const unrelated = foldProgressObservation(state, verification(4, { outcomeClass: "passed" })).state;
    assert.equal(unrelated.incidents[0]!.phase, "experiment_required");
    assert.equal(unrelated.failureRuns.length, 1);
    const actual = foldProgressObservation(unrelated, verification(5, { outcomeClass: "passed", experimentIncidentId: incident.incidentId })).state;
    assert.equal(actual.incidents[0]!.phase, "resolved");
    assert.equal(actual.incidents[0]!.experiment?.verifiedImprovement, true);
    assert.equal(matchesReviewExperiment(incident.reviewReport, { program: "node", args: ["--test"], cwd: "tests/.." }, process.cwd()), true);
    assert.equal(matchesReviewExperiment(incident.reviewReport, { program: "node", args: [] }, process.cwd()), false);
  });

  it("requires two separate evidence windows, and replay does not create a second incident", () => {
    let state = createProgressGuardState();
    const observations: ProgressObservation[] = [];
    for (let i = 1; i <= 12; i++) { const item = read(i); observations.push(item); state = foldProgressObservation(state, item).state; }
    assert.equal(state.incidents[0]?.phase, "investigation_suspected");
    for (let i = 13; i <= 24; i++) { const item = read(i, { readRange: { fileKey: target, start: i, end: i + 5 } }); observations.push(item); state = foldProgressObservation(state, item).state; }
    assert.equal(state.incidents[0]?.phase, "review_pending");
    let replay = createProgressGuardState();
    for (const item of observations) replay = foldProgressObservation(replay, item).state;
    assert.deepEqual(replay, state);
    assert.equal(foldProgressObservation(state, observations.at(-1)).state.incidents.length, 1);
  });

  it("new source coverage, waiting and neutral thinking are not investigation stagnation", () => {
    let state = createProgressGuardState();
    for (let i = 1; i <= 36; i++) state = foldProgressObservation(state, read(i, { readRange: { fileKey: target, start: i * 100, end: i * 100 + 99 } })).state;
    assert.equal(state.incidents.length, 0);
    for (let i = 40; i < 80; i++) state = foldProgressObservation(state, { ...read(i), tool: "poll_command", kind: "neutral", readRange: undefined, targetKey: undefined, outcomeKey: undefined }).state;
    assert.equal(state.incidents.length, 0);
  });

  it("observe-only investigation mode never dispatches an automatic reviewer", () => {
    let state = createProgressGuardState();
    for (let i = 1; i <= 40; i++) state = foldProgressObservation(state, read(i, { investigationPolicy: { minimum: 5, ratio: 0.7, window: 12, review: false } })).state;
    assert.equal(state.incidents[0]?.phase, "investigation_suspected");
  });

  it("clips UTF-16 safely and never admits structurally invalid patches", () => {
    const clipped = clipSemanticFields({ currentWork: "x".repeat(1199) + "😀more", nextStep: "verify" }, 1200);
    assert.equal((clipped.patch as { currentWork: string }).currentWork.length, 1199);
    assert.throws(() => parseSemanticRequestPatch({ currentWork: "x".repeat(1300), nextStep: false }));
  });
});
