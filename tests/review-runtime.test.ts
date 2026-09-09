import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, it } from "./harness.js";
import type { ChatMessage, ModelProvider, ModelRequest, SessionState } from "../src/core/types.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { TaskBudget } from "../src/runtime/task-budget.js";
import { createReviewDriver, type ReviewParticipant } from "../src/review/driver.js";
import { foldReviewEvent, runReviewDiscussion, type ReviewEvent } from "../src/review/session.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { createReviewCopies, restoreReviewCopies, reviewFingerprint } from "../src/review/workspace.js";
import { captureValidationBaseline } from "../src/progress/validation-standard.js";
import { createStorage, workspaceIdFromRoot } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { EvidenceStore } from "../src/context/evidence-store.js";
import { createId } from "../src/utils/ids.js";
import { runWorkspaceReview } from "../src/review/application.js";
import type { MemoryManager } from "../src/memory/memory-manager.js";
import type { ContextArtifactIndex } from "../src/context/artifact-index.js";
import { ProviderError } from "../src/providers/errors.js";

function state(threadId: string): SessionState { return { threadId, workspaceRoot: process.cwd(), mode: "code", provider: "glm", model: "mock",
  thinkingEffort: "none", messages: [], constraints: [], filesRead: new Map(), changes: [], commands: [], commandApprovalPrefixes: [],
  workingSummary: "", compactedMessageCount: 0, createdAt: "now", updatedAt: "now" }; }
function setup(provider: ModelProvider) {
  const main = state("main"); main.messages.push({ role: "assistant", content: "PRIVATE_MAIN_CONTEXT" });
  foldReviewEvent(main, { type: "started", id: "r", key: "key", purpose: "delivery", snapshotId: "snap", requirementRevision: "req",
    maxRounds: 5, maxRequests: 32, maxTools: 20, deadline: Date.now() + 60000, summaryTokens: 2048 });
  const events: ReviewEvent[] = [], records: ChatMessage[] = [];
  const emit = async (e: ReviewEvent) => { foldReviewEvent(main, e); events.push(e); };
  const get = () => main.reviewSessions![0]!;
  const participant = (name: string): ReviewParticipant => ({ state: state(name), tools: [],
    context: { workspaceRoot: process.cwd(), threadId: name, turnId: "r", mode: "code", agentRole: "subagent",
      approvalPolicy: "ask", commandExecutionMode: "auto_approve", commandTimeoutMs: 1000, maxOutputChars: 8000,
      requestApproval: async () => false, recallContext: async () => ({ ok: false, summary: "not shared" }) },
    append: async (type, payload) => { if (type === "message") records.push(payload as ChatMessage); },
    capture: () => "evidence_" + "a".repeat(64), unchanged: async () => true,
  });
  const participants = { author: participant("author"), reviewer: participant("reviewer") };
  const budget = new TaskBudget(40, 0);
  const driver = createReviewDriver({ participants, briefSource: main, provider, budget, limits: defaultRuntimeLimits(), get, emit,
    fresh: async () => true, usage: async () => {} });
  return { main, participants, budget, driver, get, emit, events, records };
}

describe("review runtime isolation and recovery", () => {
  it("compacts a reviewer's private history with the same role prefix and never dispatches summary tools", async () => {
    const requests: ModelRequest[] = [];
    let executions = 0;
    const f = setup({ name: "glm", model: "mock", complete: async request => {
      requests.push(request);
      if (request.messages.at(-1)?.content?.startsWith("RUNTIME_CONTEXT_HANDOFF:")) {
        return { message: { role: "assistant", content: "<summary>Private investigation is unfinished. Verify the boundary condition.</summary>",
          tool_calls: [{ id: "forbidden_review_command", type: "function", function: { name: "run_command", arguments: "{}" } }] } };
      }
      return { message: { role: "assistant", content: JSON.stringify({ proposal: "Verify the counterexample", kind: "next_action",
        vote: "needs_evidence", evidenceRefs: [], unresolved: ["Not independently verified"] }) } };
    } });
    const p = f.participants.reviewer;
    p.state.messages.push({ role: "user", content: "PRIVATE_REVIEW_REQUIREMENT" },
      { role: "assistant", content: "Earlier private investigation", reasoning_content: "r".repeat(180_000) },
      ...Array.from({ length: 6 }, (_, i) => ({ role: "assistant" as const, content: `Recent private evidence ${i}` })));
    p.tools.push({ name: "run_command", mutating: false, definition: { type: "function", function: {
      name: "run_command", description: "Execute an approved experiment", parameters: { type: "object" },
    } }, execute: async () => { executions++; return { ok: true, summary: "Must not execute" }; } });
    try {
      const result = await f.driver.discuss("reviewer", f.get());
      assert.equal(result.vote, "needs_evidence");
      assert.equal(requests.length, 2);
      assert.equal(executions, 0);
      assert.match(requests[0]!.messages.at(-1)?.content ?? "", /^RUNTIME_CONTEXT_HANDOFF:/u);
      assert.deepEqual(requests[0]!.messages[0], requests[1]!.messages[0]);
      assert.deepEqual(requests[0]!.tools, requests[1]!.tools);
      assert.match(requests[0]!.messages[0]?.content ?? "", /no tool execution is authorized/);
      assert.doesNotMatch(JSON.stringify(requests), /PRIVATE_MAIN_CONTEXT/);
      assert.ok(!p.state.messages.some(m => m.role === "tool" && m.tool_call_id === "forbidden_review_command"));
    } finally { f.driver.release(); }
  });

  it("retains fresh failed-read feedback during reset reconciliation without re-injecting old memory", async () => {
    let calls = 0, reads = 0;
    const f = setup({ name: "glm", model: "mock", complete: async request => {
      calls++;
      if (calls === 1) throw new ProviderError("maximum context length exceeded", { provider: "glm", code: "context_length_exceeded", statusCode: 400 });
      assert.doesNotMatch(JSON.stringify(request.messages), /OLD_PRIVATE_HISTORY|OLD_OPTIONAL_MEMORY/);
      if (calls === 3) assert.match(JSON.stringify(request.messages), /missing-file-feedback/);
      if (calls <= 3) return { message: { role: "assistant", content: null, tool_calls: [{ id: `read_${calls}`, type: "function",
        function: { name: "read_file", arguments: "{}" } }] } };
      return { message: { role: "assistant", content: JSON.stringify({ proposal: "Investigate independently", kind: "next_action",
        vote: "needs_evidence", evidenceRefs: [], unresolved: ["Verification pending"] }) } };
    } });
    const p = f.participants.reviewer;
    p.state.messages.push({ role: "user", content: "Bound review requirements" }, { role: "assistant", content: "OLD_PRIVATE_HISTORY".repeat(2000) });
    p.optionalMemory = async () => calls < 3 ? "OLD_OPTIONAL_MEMORY" : "";
    p.tools.push({ name: "read_file", mutating: false, definition: { type: "function", function: {
      name: "read_file", description: "Read", parameters: {} } }, execute: async () => ++reads === 1
        ? { ok: false, summary: "missing-file-feedback" } : { ok: true, summary: "Current source", data: { path: "source.ts" } } });
    try {
      const result = await f.driver.discuss("reviewer", f.get());
      assert.equal(result.vote, "needs_evidence"); assert.equal(calls, 4); assert.equal(reads, 2);
      assert.equal(f.get().requests, 4);
    } finally { f.driver.release(); }
  });
  it("resumes closing with a saved body and unknown correction without sending it again", async () => {
    let requests = 0;
    const provider: ModelProvider = { name: "glm", model: "mock", complete: async () => {
      requests++; return { message: { role: "assistant", content: "<summary>Independent reviewer position</summary>" } };
    } };
    const f = setup(provider); f.driver.release();
    await f.emit({ type: "close", id: "r", reason: "round_limit" });
    await f.emit({ type: "request", id: "r", closingActor: "author" });
    await f.emit({ type: "summary_recovery", id: "r", key: "author", event: { type: "attempt", attempt: 1 } });
    await f.emit({ type: "summary_recovery", id: "r", key: "author", event: { type: "candidate", attempt: 1, body: "Earlier raw author position" } });
    await f.emit({ type: "request", id: "r", closingActor: "author", continuation: true });
    await f.emit({ type: "summary_recovery", id: "r", key: "author", event: { type: "attempt", attempt: 2 } });
    const driver = createReviewDriver({ participants: f.participants, provider, budget: f.budget, limits: defaultRuntimeLimits(),
      get: f.get, emit: f.emit, fresh: async () => true, usage: async () => {} });
    try {
      await runReviewDiscussion(f.get, f.emit, driver);
      assert.equal(requests, 1); // only the peer's still-unrequested closing summary
      assert.equal(f.get().summaryRecovery?.author?.attempts, 2);
      assert.equal(f.get().summaries.author?.full, "Earlier raw author position");
      assert.match(f.get().handoff!, /Earlier raw author position/);
      assert.equal(f.get().approval, false);
    } finally { driver.release(); }
  });
  it("shares five API retries and two content corrections in a private reviewer turn", async () => {
    let calls = 0;
    const f = setup({ name: "glm", model: "mock", complete: async () => {
      calls++;
      if (calls <= 5) throw new ProviderError("temporary mock failure", { provider: "glm", code: "http_error", statusCode: 503, retryable: true, retryAfterMs: 0 });
      return { message: { role: "assistant", content: calls <= 7 ? "bad format" : JSON.stringify({
        proposal: "Verify independently", kind: "next_action", vote: "needs_evidence", evidenceRefs: [], unresolved: ["counterexample pending"] }) } };
    } });
    try {
      const statement = await f.driver.discuss("reviewer", f.get());
      assert.equal(statement.vote, "needs_evidence"); assert.equal(calls, 8);
      assert.equal(f.get().requests, 8); assert.equal(f.budget.snapshot().requests, 8);
      assert.equal(f.records.filter(m => m.role === "user" && m.content.startsWith("RUNTIME_REVIEW_FORMAT:")).length, 2);
    } finally { f.driver.release(); }
  });
  it("protects two closing calls from other agents and restores unused holds without invented spend", () => {
    const budget = new TaskBudget(3, 0);
    const held = budget.hold(2, 100);
    const request = { messages: [] };
    budget.reserve(request)({ totalTokens: 1 });
    assert.throws(() => budget.reserve(request), /limit/u);
    held.reserve(request)({ totalTokens: 1 });
    const resumed = TaskBudget.restore(budget.snapshot());
    assert.equal(resumed.snapshot().requests, 2);
    resumed.reserve(request)({ totalTokens: 1 });
    held.reserve(request)({ totalTokens: 1 }); held.release();
    assert.equal(budget.snapshot().requests, 3);
  });
  it("summarizes main once, keeps participant histories private and clips two closing summaries without retry", async () => {
    const requests: ModelRequest[] = []; let speeches = 0;
    const f = setup({ name: "glm", model: "mock", complete: async request => {
      requests.push(request);
      const discussion = request.tools?.some(t => (t.function.name as string) === "post_review");
      const content = discussion ? JSON.stringify({ proposal: `different ${++speeches}`, kind: "next_action", vote: "disagree",
        evidenceRefs: [], unresolved: ["Not independently verified"] }) :
        `<analysis>DISPOSABLE_DRAFT</analysis><summary>${requests.length === 1 ? "Opening brief" : "Final position 中文😀 ".repeat(3000)}</summary>`;
      return { message: { role: "assistant", content, reasoning_content: "NATIVE_DRAFT" }, usage: { totalTokens: 10 } };
    } });
    try {
      await runReviewDiscussion(f.get, f.emit, f.driver);
      assert.equal(requests.length, 13); assert.equal(speeches, 10);
      assert.equal(f.get().round, 5); assert.equal(f.get().approval, false);
      assert.match(JSON.stringify(requests[0]), /PRIVATE_MAIN_CONTEXT/u);
      for (const request of requests.slice(1)) assert.doesNotMatch(JSON.stringify(request), /PRIVATE_MAIN_CONTEXT|DISPOSABLE_DRAFT/u);
      assert.doesNotMatch(JSON.stringify(f.get().summaries), /NATIVE_DRAFT|DISPOSABLE_DRAFT/u);
      assert.equal(f.budget.snapshot().requests, 13);
      for (const request of requests) for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
        assert.ok(!(key in request));
    } finally { f.driver.release(); }
  });
  it("rejects invented references in plain JSON just as strictly as post_review", async () => {
    let calls = 0;
    const f = setup({ name: "glm", model: "mock", complete: async () => { calls++;
      return { message: { role: "assistant", content: JSON.stringify({ proposal: "done", kind: "delivery", vote: "agree",
        evidenceRefs: ["invented"], unresolved: [] }) } }; } });
    try {
      f.get().maxRequests = 5;
      await runReviewDiscussion(f.get, f.emit, f.driver);
      assert.equal(f.get().statements.length, 0); assert.equal(f.get().approval, false);
      assert.equal(calls, 5);
    } finally { f.driver.release(); }
  });
  it("closes an interrupted tool exchange without repeating execution", async () => {
    let calls = 0;
    const f = setup({ name: "glm", model: "mock", complete: async () => { calls++; return { message: { role: "assistant", content: "<summary>summary</summary>" } }; } });
    f.get().briefing = { full: "prior", projected: "prior" };
    f.participants.reviewer.state.messages.push({ role: "assistant", content: null, tool_calls: [{ id: "unknown_effect", type: "function",
      function: { name: "run_command", arguments: "{}" } }] });
    try {
      await runReviewDiscussion(f.get, f.emit, f.driver);
      assert.equal(f.get().round, 0); assert.match(f.get().closeReason!, /Interrupted/u);
      assert.equal(f.get().approval, false); assert.ok(calls <= 2);
    } finally { f.driver.release(); }
  });
  it("recovers a durable public post without repeating its model request", async () => {
    const f = setup({ name: "glm", model: "mock", complete: async () => { throw new Error("must not call"); } });
    const value = { proposal: "experiment next", kind: "next_action", vote: "needs_evidence", evidenceRefs: [], unresolved: ["pending"] };
    f.participants.reviewer.state.messages.push({ role: "user", content: "RUNTIME_REVIEW_TURN r:1:reviewer" },
      { role: "assistant", content: null, tool_calls: [{ id: "post", type: "function", function: { name: "post_review" as never, arguments: JSON.stringify(value) } }] },
      { role: "tool", tool_call_id: "post", name: "post_review" as never, content: '{"ok":true}' });
    try { assert.deepEqual(await f.driver.discuss("reviewer", f.get()), value); }
    finally { f.driver.release(); }
  });
  it("keeps complete captured evidence above the old storage cap and enforces thread scope", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-review-evidence-"));
    const db = createStorage(directory);
    try {
      const evidence = new EvidenceStore(db), content = "large".repeat(230000);
      new ThreadStore(db).create({ threadId: "t", workspaceRoot: directory, mode: "code", provider: "glm", model: "mock", thinkingEffort: "none" });
      const workspaceId = workspaceIdFromRoot(directory);
      const id = evidence.capture(workspaceId, "t", "c", "read_file", { ok: true, summary: "full", data: { content } });
      const read = evidence.read(workspaceId, "t", id, 1_000_000, 16000) as { capturedChars: number; sourceTruncated: boolean };
      assert.ok(read.capturedChars > content.length); assert.equal(read.sourceTruncated, false);
      assert.throws(() => evidence.read("w", "peer", id), /not found/u);
    } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("replays both closing summaries and appends a handoff only once", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-review-journal-"));
    const db = createStorage(directory), store = new ThreadStore(db);
    try {
      const initial = store.create({ threadId: "journal-review", workspaceRoot: directory, mode: "code", provider: "glm", model: "mock", thinkingEffort: "none" });
      const emit = (payload: ReviewEvent) => store.appendEvent(initial.threadId, { type: "review.session.event", payload });
      emit({ type: "started", id: "r", key: "key", purpose: "delivery", snapshotId: "snap", requirementRevision: "req",
        maxRounds: 5, maxRequests: 32, maxTools: 20, deadline: Date.now() + 60000, summaryTokens: 2048 });
      emit({ type: "close", id: "r", reason: "round_limit" });
      for (const actor of ["author", "reviewer"] as const) emit({ type: "summary", id: "r", actor, text: actor, unavailable: false });
      emit({ type: "decided", id: "r", fresh: true }); emit({ type: "applied", id: "r", fresh: false });
      const recovered = store.recover(initial.threadId);
      assert.equal(recovered.reviewSessions![0]!.status, "applied");
      assert.equal(recovered.messages.filter(m => m.content?.startsWith("RUNTIME_REVIEW_HANDOFF")).length, 1);
      assert.throws(() => emit({ type: "applied", id: "r" }), /already applied/u);
    } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("copies source without touching the checkout and restores hash-verified original tests only for reviewer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-review-source-"));
    let reviewDirectory: string | undefined;
    try {
      await mkdir(path.join(directory, "tests"));
      await writeFile(path.join(directory, "tests", "test_original.py"), "assert True\n");
      await writeFile(path.join(directory, "module.py"), "value = 1\n");
      for (const args of [["init"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"]])
        await execa("git", args, { cwd: directory });
      const baseline = await captureValidationBaseline(directory);
      await writeFile(path.join(directory, "tests", "test_original.py"), "assert False\n");
      const workspace = await WorkspaceManager.create(directory), fingerprint = reviewFingerprint(await workspace.captureSnapshot());
      const id = createId("review"), copies = await createReviewCopies(workspace, id, fingerprint, 100000, baseline);
      reviewDirectory = copies.directory;
      assert.equal(await readFile(path.join(copies.roots.reviewer, "tests", "test_original.py"), "utf8"), "assert True\n");
      assert.equal(await readFile(path.join(copies.roots.author, "tests", "test_original.py"), "utf8"), "assert False\n");
      assert.equal(reviewFingerprint(await workspace.captureSnapshot()), fingerprint);
      assert.deepEqual((await restoreReviewCopies(copies.directory, id, fingerprint)).baselines, copies.baselines);
    } finally {
      if (reviewDirectory) await rm(reviewDirectory, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("runs application review on separate private threads and reuses the applied decision without more model calls", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-review-app-"));
    const root = path.join(directory, "workspace"); await mkdir(root);
    await writeFile(path.join(root, "module.py"), "value = 1\n");
    const db = createStorage(path.join(directory, "data")), store = new ThreadStore(db);
    const main = store.create({ threadId: "main", workspaceRoot: root, mode: "code", provider: "glm", model: "mock", thinkingEffort: "none" });
    let calls = 0;
    try {
      const deps = { workspace: await WorkspaceManager.create(root), store,
        memory: { evidenceStore: new EvidenceStore(db), searchHybrid: async () => [] } as unknown as MemoryManager,
        index: { checkpoint: async () => {}, search: async () => [] } as unknown as ContextArtifactIndex,
        provider: { name: "glm" as const, model: "mock", complete: async (request: ModelRequest) => {
          calls++;
          return { message: { role: "assistant" as const, content: request.tools?.length ? JSON.stringify({
            proposal: "position " + calls, vote: "disagree", kind: "next_action", evidenceRefs: [], unresolved: ["Counterexample still needed"] }) :
            "<analysis>discard</analysis><summary>Own unresolved position</summary>" } };
        } }, budget: new TaskBudget(40, 0), limits: defaultRuntimeLimits(), sensitivePaths: [path.join(directory, "data")],
        lifecycleDirectory: path.join(directory, "leases"), offline: false, approve: async () => false, status: () => {} };
      const request = { state: main, turnId: "turn", userInput: "Fix the module", purpose: "delivery" as const, remainingModelRequests: 32 };
      const tooLate = await runWorkspaceReview({ ...request, remainingModelRequests: 2 }, deps);
      assert.equal(tooLate.approved, false); assert.equal(calls, 0); assert.equal(Boolean(main.reviewSessions), false);
      const first = await runWorkspaceReview(request, deps);
      assert.equal(first.approved, false); assert.equal(first.requests, 13);
      assert.equal(main.reviewSessions?.[0]?.status, "applied");
      const participants = main.reviewSessions![0]!.actorThreads!;
      assert.notEqual(participants.author, participants.reviewer);
      assert.equal(store.recover(participants.author).messages.filter(m => m.content?.startsWith("RUNTIME_REVIEW_TURN")).length, 5);
      assert.equal(store.recover(participants.reviewer).messages.filter(m => m.content?.startsWith("RUNTIME_REVIEW_TURN")).length, 5);
      assert.equal(main.messages.length, 1); assert.match(main.messages[0]!.content!, /RUNTIME_REVIEW_HANDOFF/u);
      const second = await runWorkspaceReview(request, deps);
      assert.equal(second.reused, true); assert.equal(calls, 13);
    } finally {
      for (const session of main.reviewSessions ?? []) if (session.directory) await rm(session.directory, { recursive: true, force: true });
      db.close(); await rm(directory, { recursive: true, force: true });
    }
  });
});
