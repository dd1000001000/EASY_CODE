import { snapshotToolSet } from "./tool-set.js";
import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import type { CommandAuditEntry, SessionState } from "../src/core/types.js";
import { unresolvedCommands, runtimeContinuityMessage } from "../src/context/runtime-state.js";
import { CommandVerificationCollector } from "../src/command/verification.js";
import { expandedMemoryRecall } from "../src/context/memory-controller.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { ContextManager } from "../src/context/manager.js";
import { foldReviewEvent, type ReviewEvent } from "../src/review/session.js";
import { packageScriptRunner } from "../src/command/verification.js";
import { mkdtemp, writeFile, rm, mkdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { createReviewCopies, reviewFingerprint } from "../src/review/workspace.js";
import { createId } from "../src/utils/ids.js";
import { runWorkspaceReview, type WorkspaceReviewDependencies } from "../src/review/application.js";
import { ReviewPersistenceError } from "../src/review/errors.js";
import { preflightReviewEnvironment } from "../src/review/preflight.js";
import type { ReviewParticipant } from "../src/review/driver.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { newDelivery } from "../src/review/delivery.js";
import { baseSessionState } from "./session-state.js";

export function reliabilityState(): SessionState {
  return { ...baseSessionState(), threadId: "reliability", workspaceRoot: process.cwd(), mode: "code", provider: "qwen", model: "mock",
    thinkingEffort: "none", messages: [], constraints: [], filesRead: new Map(), changes: [], commands: [],
    commandApprovalPrefixes: [], workingSummary: "", compactedMessageCount: 0, createdAt: "now", updatedAt: "now" };
}
function command(status: "failed" | "passed" | "unknown", confidence: "high" | "low" = "high"): CommandAuditEntry {
  return { id: status, program: "bash", args: ["test | grep FAILED"], cwd: ".", status: "exited", exitCode: 0,
    durationMs: 1, timestamp: "now", summary: "outer exit 0", verificationKind: "unit_test",
    validation: { status, confidence, source: "framework_summary", coverage: "terminal", reason: "test report", targetKey: "target" } };
}
describe("verification reliability", () => {
  it("retains low-confidence pipeline failures independently of reviewer triggering", () => {
    const collector = new CommandVerificationCollector({ program: "bash", args: ["-c", "python tests/runtests.py test 2>&1 | grep FAILED"] });
    collector.push("stdout", "FAILED (failures=2)\n");
    const s = reliabilityState(), failed = command("failed", "low");
    failed.validation = collector.finish("exited", 0, "unit_test"); s.commands.push(failed);
    assert.equal(failed.validation.status, "failed");
    assert.equal(unresolvedCommands(s).length, 1);
    assert.match(runtimeContinuityMessage(s), /"status":"failed"/);
    assert.equal(expandedMemoryRecall(s), true);
    const resumed = structuredClone(s); resumed.compactedMessageCount = resumed.messages.length;
    assert.equal(unresolvedCommands(resumed).length, 1);
  });
  it("unknown, low confidence, and changed standards cannot clear a failure", () => {
    const s = reliabilityState(); s.commands.push(command("failed"), command("unknown"), command("passed", "low"));
    assert.equal(unresolvedCommands(s).length, 1);
    const changed = command("passed"); changed.validation!.standard = { status: "changed", baselineDigest: "a", changedPaths: ["test.py"] };
    s.commands.push(changed); assert.equal(unresolvedCommands(s).length, 1);
    s.commands.push(command("passed")); assert.equal(unresolvedCommands(s).length, 0);
  });
  it("an unrelated target cannot resolve the failed target", () => {
    const s = reliabilityState(); s.commands.push(command("failed"));
    const other = command("passed"); other.validation!.targetKey = "other"; s.commands.push(other);
    assert.equal(unresolvedCommands(s).length, 1);
  });
  it("a verified same-target result can resolve a failure across user turns", () => {
    const s = reliabilityState(), failed = command("failed"), passed = command("passed");
    failed.sourceScopeKey = "old-turn"; passed.sourceScopeKey = "new-turn";
    s.commands.push(failed, passed); assert.equal(unresolvedCommands(s).length, 0);
  });
});

describe("delivery reliability", () => {
  it("schedules one advisory reviewer for a changed component.test.ts without making its opinion a completion gate", async () => {
    const s = reliabilityState(); let calls = 0; let reviews = 0;
    const tool = { name: "read_file" as const, mutating: false,
      definition: { type: "function" as const, function: { name: "read_file", description: "read", parameters: { type: "object" } } },
      execute: async () => ({ ok: true, summary: "read" }) };
    const runtime = new AgentRuntime({ provider: { name: "qwen", model: "mock", complete: async () => ({
      message: ++calls === 1
        ? { role: "assistant" as const, content: "", tool_calls: [{ id: "read", type: "function" as const,
          function: { name: "read_file", arguments: "{}" } }] }
        : { role: "assistant" as const, content: "implementation complete" },
    }) }, toolCatalog: snapshotToolSet([tool]), contextManager: new ContextManager(),
      buildSystemPrompt: async () => "rules", getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [], appendEvent: async () => {}, requestApproval: async () => false,
      onToolCompleted: async state => { state.changes.push({ path: "src/component.test.ts", operation: "update",
        source: "file_tool", status: "applied", timestamp: "now" }); },
      runReviewSession: async () => { reviews++; return { approved: false, decision: "unavailable", requests: 0,
        reused: false, reason: "reviewer unavailable" }; } });
    const result = await runtime.run(s, "change the component test", { maxSteps: 4,
      maxContextChars: 100000, maxContextTokens: 34000, maxOutputChars: 8000,
      commandTimeoutMs: 1000, approvalPolicy: "never" });
    assert.equal(reviews, 1); assert.equal(result.reason, "success");
    assert.match(result.text, /Review note: unavailable/u);
  });
  it("degrades incomplete snapshots without calling a model, but does not swallow journal failure", async () => {
    const state = reliabilityState(), events: string[] = [];
    const deps = { workspace: { captureSnapshot: async () => ({ files: new Map(), truncated: true }) },
      store: { appendEvent: (_: string, e: { type: string }) => { events.push(e.type); } } } as unknown as WorkspaceReviewDependencies;
    const input = { state, turnId: "turn", userInput: "fix", purpose: "delivery" as const, remainingModelRequests: 32 };
    const result = await runWorkspaceReview(input, deps);
    assert.equal(result.approved, false); assert.equal(result.decision, "unavailable"); assert.equal(result.requests, 0);
    assert.deepEqual(events, ["review.unavailable"]);
    deps.store.appendEvent = () => { throw new Error("disk full"); };
    await assert.rejects(() => runWorkspaceReview(input, deps), ReviewPersistenceError);
  });
  it("copies the current source and links installed dependencies without restoring removed tests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-review-env-test-"));
    let copy: string | undefined;
    try {
      const root = path.join(directory, "source"); await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
      await writeFile(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 42");
      await writeFile(path.join(root, "test_original.py"), "assert True\n");
      await rm(path.join(root, "test_original.py"));
      const workspace = await WorkspaceManager.create(root);
      const copies = await createReviewCopies(workspace, createId("review"), reviewFingerprint(await workspace.captureSnapshot()), 100000);
      copy = copies.directory;
      await assert.rejects(() => readFile(path.join(copies.roots.reviewer, "test_original.py"), "utf8"), { code: "ENOENT" });
      assert.equal(await readFile(path.join(copies.roots.reviewer, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 42");
      assert.equal(await readFile(path.join(root, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 42");
      assert.equal(await readFile(path.join(copies.roots.author, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 42");
      assert.equal(copies.dependencyLinks.author.node_modules, await realpath(path.join(root, "node_modules")));
    } finally { if (copy) await rm(copy, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); }
  });
  it("does not pause a new turn just because a prior advisory review was unresolved", async () => {
    const s = reliabilityState(); s.changes.push({ path: "module.ts", operation: "update", source: "file_tool", status: "applied", timestamp: "now" });
    let reviews = 0;
    const runtime = new AgentRuntime({ provider: { name: "qwen", model: "mock", complete: async () => ({ message: { role: "assistant", content: "Done" } }) },
      toolCatalog: snapshotToolSet([]), contextManager: new ContextManager(), buildSystemPrompt: async () => "rules", getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [], appendEvent: async () => {}, requestApproval: async () => false,
      runReviewSession: async () => { reviews++; return { approved: false, requests: 0, reused: true }; } });
    const result = await runtime.run(s, "Continue", { maxSteps: 4, maxContextChars: 100000, maxContextTokens: 34000,
      maxOutputChars: 8000, commandTimeoutMs: 1000, approvalPolicy: "never" });
    assert.equal(result.reason, "success"); assert.equal(reviews, 0);
  });
  it("a known failed target vetoes consensus citing another passing target", () => {
    const s = reliabilityState();
    const emit = (e: ReviewEvent) => foldReviewEvent(s, e);
    emit({ type: "started", id: "r", key: "k", purpose: "delivery", snapshotId: "snapshot", requirementRevision: "req",
      requirements: ["request"], maxRounds: 5, maxRequests: 32, maxTools: 20, summaryTokens: 2048 });
    emit({ type: "experiment", id: "r", actor: "reviewer", evidenceId: "bad", checkKey: "target", outcome: "failed", passed: false, unchanged: true, standard: "unchanged" });
    emit({ type: "experiment", id: "r", actor: "reviewer", evidenceId: "good", checkKey: "other", method: "test", outcome: "passed", passed: true, unchanged: true, standard: "unchanged" });
    for (const actor of ["reviewer", "author"] as const) emit({ type: "statement", id: "r", actor, value: { proposal: "ready", kind: "delivery", vote: "agree", evidenceRefs: ["good"], unresolved: [],
      checks: [{ requirementId: "request", evidenceId: "good", method: "test", rationale: "test", counterexample: "edge case" }] } });
    for (const actor of ["author", "reviewer"] as const) emit({ type: "summary", id: "r", actor, text: "ready", unavailable: false });
    emit({ type: "decided", id: "r", fresh: true }); assert.equal(s.reviewSessions![0]!.approval, false);
  });
  it("attributes a simple npm script but refuses dynamic scripts and hidden hooks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-script-test-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "jest --runInBand" } }));
      const runner = await packageScriptRunner({ program: "npm", args: ["test"] }, root);
      assert.deepEqual(runner, ["jest", "--runInBand"]);
      const c = new CommandVerificationCollector({ program: "npm", args: ["test"] }, runner);
      c.push("stdout", "Test Suites: 1 passed, 1 total\n"); assert.equal(c.finish("exited", 0, "unit_test").source, "framework_summary");
      await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "jest", posttest: "echo passed" } }));
      assert.equal(await packageScriptRunner({ program: "npm", args: ["test"] }, root), undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("persists the delivery obligation through a real journal recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-delivery-journal-"));
    const db = createStorage(path.join(root, "data"));
    try {
      const store = new ThreadStore(db);
      const s = store.create({ threadId: "delivery", workspaceRoot: root, mode: "code", provider: "glm", model: "mock", thinkingEffort: "none" });
      store.recordMessage(s.threadId, { role: "user", content: "Original requirement" });
      const current = store.recover(s.threadId);
      const obligation = newDelivery(current, "Original requirement", 0, 0);
      store.appendEvent(s.threadId, { type: "delivery.required", payload: obligation });
      const recovered = store.recover(s.threadId);
      assert.deepEqual(recovered.delivery, obligation);
      assert.throws(() => store.appendEvent(s.threadId, { type: "delivery.required", payload: { ...obligation, id: "replacement" } }), /unresolved/);
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });
  it("runs bounded environment checks through the participant's normal command boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-preflight-"));
    try {
      await writeFile(path.join(root, "package.json"), "{}");
      let calls = 0;
      const p = { context: { workspaceRoot: root }, append: async () => {}, tools: [{ name: "run_command", execute: async (input: { program: string; args: string[] }) => {
        assert.equal(input.program, "node"); assert.deepEqual(input.args, ["--version"]); calls++;
        return { ok: false, summary: "sandbox unavailable" };
      } }] } as unknown as ReviewParticipant;
      await assert.rejects(() => preflightReviewEnvironment(p), /preflight unavailable/); assert.equal(calls, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("records a fresh reviewer opinion without turning inventory coverage into a correctness gate", () => {
    const fixture = (vote: "agree" | "needs_evidence", fresh: boolean) => {
      const s = reliabilityState(); foldReviewEvent(s, { type: "started", id: "r", key: "k", purpose: "delivery",
        snapshotId: "s", requirementRevision: "q", maxRounds: 5, maxRequests: 32, maxTools: 20, summaryTokens: 2048 });
      for (const actor of ["reviewer", "author"] as const) foldReviewEvent(s, { type: "statement", id: "r", actor, value: {
        proposal: "ready", kind: "delivery", vote: actor === "reviewer" ? vote : "agree",
        evidenceRefs: [], unresolved: vote === "needs_evidence" && actor === "reviewer" ? ["Boundary not checked"] : [],
      } });
      if (s.reviewSessions[0]!.status === "discussing") foldReviewEvent(s, { type: "close", id: "r", reason: "review_complete" });
      for (const actor of ["author", "reviewer"] as const) foldReviewEvent(s,
        { type: "summary", id: "r", actor, text: "Recorded finding", unavailable: false, raw: true });
      foldReviewEvent(s, { type: "decided", id: "r", fresh });
      return s.reviewSessions[0]!;
    };
    assert.equal(fixture("agree", true).approval, true);
    assert.equal(fixture("needs_evidence", true).approval, false);
    assert.equal(fixture("agree", false).approval, false);
  });
});
