import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import type { CommandAuditEntry, SessionState } from "../src/core/types.js";
import { ContextManager, estimateMessagesChars } from "../src/context/manager.js";
import { RequestPrefixTracker } from "../src/context/request-prefix.js";
import { unresolvedCommands, runtimeContinuityMessage } from "../src/context/runtime-state.js";
import { validateCompactionIntegrity } from "../src/context/compaction-integrity.js";
import { serializeSessionState, deserializeSessionState } from "../src/threads/serialization.js";
import { createProgressGuardState, foldProgressObservation } from "../src/progress/guard.js";
import { compactionV2Input, persistedCompactionV2Summary } from "./compaction-fixture.js";

function state(): SessionState {
  return { threadId: "thread_reliability", mode: "code", provider: "glm-coding-plan", model: "mock",
    thinkingEffort: "high", workspaceRoot: process.cwd(), constraints: [],
    messages: [{ role: "user", content: "Fix tests without changing the API" }],
    filesRead: new Map(), changes: [], commands: [], commandApprovalPrefixes: [],
    workingSummary: "", compactedMessageCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

function command(id: string, args = ["test"], exitCode = 1): CommandAuditEntry {
  return { id, program: "npm", args, cwd: ".", status: "exited", exitCode,
    durationMs: 10, timestamp: new Date().toISOString(), summary: `command ${id}` };
}

function candidate(current: SessionState) {
  const fixture = compactionV2Input({ primaryRequestIndex: 0, primaryRequestText: current.messages[0]!.content! });
  return { formatVersion: 2 as const, summary: persistedCompactionV2Summary(fixture),
    intentLedger: { latestRequest: fixture.primaryRequest, activeConstraints: [], userCorrections: [], supersededRequests: [] },
    coverageCheck: fixture.coverageCheck };
}

describe("context reliability", () => {
  it("keeps failed target evidence after an unrelated success, scoped by owner", () => {
    const current = state();
    current.commands = [command("failed"), command("inspect", ["--version"], 0),
      { ...command("child-pass", ["test"], 0), sourceAgentId: "child" }];
    assert.deepEqual(unresolvedCommands(current).map((item) => item.id), ["failed"]);
    current.commands.push(command("rerun", ["test"], 0));
    assert.deepEqual(unresolvedCommands(current), []);
  });

  it("does not resolve failures in another task or a redacted invocation", () => {
    const current = state();
    current.commands = [
      { ...command("old"), sourceScopeKey: "task:one" },
      { ...command("new", ["test"], 0), sourceScopeKey: "task:two" },
      command("private-failure", ["test", "[REDACTED]"]),
      command("private-pass", ["test", "[REDACTED]"], 0),
    ];
    assert.deepEqual(unresolvedCommands(current).map((item) => item.id), ["old", "private-failure"]);
  });

  it("rejects a summary which loses an earlier failed command", () => {
    const current = state();
    current.commands = [command("failed"), command("inspect", ["--version"], 0)];
    const result = validateCompactionIntegrity({ state: current, request: candidate(current), sourceEndMessageIndex: 1 });
    assert.ok(result.errors.includes("unresolved_command_missing_from_summary"));
  });

  it("requires real durable evidence for verified results, not invented labels", () => {
    const current = state();
    current.commands = [command("passed", ["test"], 0)];
    const request = candidate(current);
    const summary = JSON.parse(request.summary);
    summary.verifiedResults = [{ result: "Recorded tests passed", evidenceRefIds: ["proof"] }];
    summary.evidenceRefs = [{ id: "proof", kind: "command", reference: "command:invented" }];
    request.summary = JSON.stringify(summary);
    assert.ok(validateCompactionIntegrity({ state: current, request, sourceEndMessageIndex: 1 }).errors.includes("unresolvable_verified_evidence"));
    summary.evidenceRefs[0].reference = "command:passed";
    request.summary = JSON.stringify(summary);
    assert.equal(validateCompactionIntegrity({ state: current, request, sourceEndMessageIndex: 1 }).ok, true);
  });

  it("preserves a full accepted summary and constraints until explicit Runtime recovery", () => {
    const current = state();
    current.constraints = ["Never remove rollback support"];
    current.workingSummary = JSON.stringify({ currentWork: "x".repeat(8_100), nextStep: "RUN_COUNTEREXAMPLE_42" });
    current.messages.push(...Array.from({ length: 30 }, () => ({ role: "assistant" as const, content: "old".repeat(300) })));
    const built = new ContextManager().build({ state: current, systemPrompt: "rules", maxContextChars: 16_000 });
    const text = built.map((message) => message.content).join("\n");
    assert.ok(text.includes(current.workingSummary));
    assert.match(text, /Never remove rollback support/u);
    assert.ok(estimateMessagesChars(built) > 16_000);
    const inspected = new ContextManager().inspectProviderRequest({ state: current, messages: built, maxContextChars: 16_000 });
    assert.equal(inspected.pressure, "force");
  });

  it("never truncates protected state when capacity is insufficient", () => {
    const current = state();
    current.constraints = ["constraint".repeat(1_000)];
    const before = structuredClone(current);
    const manager = new ContextManager();
    const built = manager.build({ state: current, systemPrompt: "rules", maxContextChars: 4_096 });
    assert.ok(manager.inspectProviderRequest({ state: current, messages: built, maxContextChars: 4_096 }).utilization > 1);
    assert.deepEqual(current, before);
  });

  it("keeps output witnesses in checkpoints and pending experiments in Runtime context", () => {
    const current = state();
    current.commands = [{ ...command("failure"), outputEvidence: {
      capturedOutputDigest: "sha256:" + "a".repeat(64), stdoutTail: "test_a FAILED expected 2 actual 3",
      stderrTail: "", incomplete: false, processStarted: true, failureKind: "exit",
    } }];
    let guard = createProgressGuardState();
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      const commandId = `command_00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
      guard = foldProgressObservation(guard, { schemaVersion: 1, sourceEventId: `event_${ordinal}`,
        sourceCallId: `call_${ordinal}`, scopeKey: "thread:test", responseOrdinal: ordinal,
        tool: "run_command", kind: "verification_terminal", confidence: "high", outcomeClass: "failed",
        evidenceDigest: "sha256:" + "d".repeat(64),
        verificationCycleId: commandId, commandId, targetKey: "sha256:" + "b".repeat(64), outcomeKey: "sha256:" + "c".repeat(64),
      }).state;
    }
    guard.incidents[0]!.phase = "experiment_required";
    guard.incidents[0]!.reviewReport = { recommendation: "run_experiment", summary: "proposal",
      diagnosis: "Maybe the cache", evidence: "failure", experiment: "Disable cache and rerun",
      expectedSignal: "passes", falsifyingSignal: "same failure" };
    current.progressGuard = guard;
    const restored = deserializeSessionState(serializeSessionState(current));
    assert.deepEqual(restored.commands[0]?.outputEvidence, current.commands[0]?.outputEvidence);
    assert.match(runtimeContinuityMessage(restored), /expected 2 actual 3/u);
    // Progress state intentionally comes from journal replay, not checkpoint text.
    assert.equal(restored.progressGuard, undefined);
    assert.match(runtimeContinuityMessage(current), /unverifiedReview/u);
    assert.match(runtimeContinuityMessage(current), /Disable cache and rerun/u);
    assert.equal(current.progressGuard?.incidents[0]?.phase, "experiment_required");
  });

  it("keeps the history prefix stable when retrieval data changes", () => {
    const current = state();
    current.messages.push({ role: "assistant", content: "inspect", reasoning_content: "Reasoning stays exact\n" });
    const manager = new ContextManager();
    const first = manager.build({ state: current, systemPrompt: "stable rules", runtimeContext: "old retrieval", maxContextChars: 20_000 });
    current.messages.push({ role: "user", content: "continue" });
    const next = manager.build({ state: current, systemPrompt: "stable rules", runtimeContext: "new retrieval", maxContextChars: 20_000 });
    // Stable system + raw history; both Runtime continuity and retrieval are a changing suffix.
    assert.deepEqual(next.slice(0, first.length - 2), first.slice(0, -2));
    const tracker = new RequestPrefixTracker();
    assert.equal(tracker.observe("thread:model", first).hasPrefixBaseline, false);
    assert.ok(tracker.observe("thread:model", next).unchangedPrefixChars > 50);
    assert.equal(tracker.observe("thread:other-model", next).hasPrefixBaseline, false);
  });
});
