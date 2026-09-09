import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import { extractSummaryText, projectSummary } from "../src/context/summary-output.js";
import { estimatedTokens } from "../src/context/token-budget.js";
import { recallThreadContext } from "../src/context/recall.js";
import { sha256 } from "../src/utils/hash.js";
import type { SessionState } from "../src/core/types.js";
import { foldReviewEvent, runReviewDiscussion, type ReviewEvent } from "../src/review/session.js";
import { referenceToolOutputs } from "../src/context/pressure-recovery.js";
import { pressureProjectedMessages } from "../src/context/pressure-projection.js";
import { ContextManager } from "../src/context/manager.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { sharedReviewEvidenceOwner } from "../src/context/recall.js";

function state(): SessionState { return { threadId: "test", mode: "code", provider: "glm", model: "test", thinkingEffort: "none",
  workspaceRoot: process.cwd(), messages: [], constraints: [], filesRead: new Map(), changes: [], commands: [],
  commandApprovalPrefixes: [], workingSummary: "", compactedMessageCount: 0, createdAt: "now", updatedAt: "now" }; }
function fixture() {
  const s = state(); const events: ReviewEvent[] = [];
  const emit = async (event: ReviewEvent) => { foldReviewEvent(s, event); events.push(event); };
  foldReviewEvent(s, { type: "started", id: "review_1", key: "key", purpose: "delivery", snapshotId: "snap",
    requirementRevision: "req", maxRounds: 5, maxRequests: 32, maxTools: 20, deadline: Date.now() + 60000, summaryTokens: 2048 });
  return { s, events, emit, get: () => s.reviewSessions![0]! };
}
describe("unified memory and five-round review", () => {
  it("drops disposable scratch, accepts prose, rejects ambiguous envelopes", () => {
    assert.equal(extractSummaryText("<analysis>secret draft</analysis>\n<summary>formal</summary>"), "formal");
    assert.equal(extractSummaryText("<analysis>only draft</analysis>"), undefined);
    assert.equal(extractSummaryText("<analysis>discard me</analysis>formal prose"), "formal prose");
    assert.equal(extractSummaryText("<analysis>unclosed"), undefined);
    assert.equal(extractSummaryText("<summary>a</summary><summary>b</summary>"), undefined);
    assert.equal(extractSummaryText(" <summary>formal</summary> "), "formal");
    assert.equal(extractSummaryText("ordinary prose "), "ordinary prose ");
  });
  it("clips summaries independently, keeps valid JSON and includes metadata in 2048 tokens", () => {
    for (const who of ["author", "reviewer"]) {
      const text = `${who} 中文😀 `.repeat(8000);
      const p = projectSummary(text, `review:r:${who}`, 2048);
      assert.ok(p.truncated); assert.ok(text.startsWith(p.text));
      assert.ok(estimatedTokens(p.encoded) <= 2048);
      assert.equal(JSON.parse(p.encoded).sourceRef, `review:r:${who}`);
      assert.doesNotMatch(p.text, /[\uD800-\uDBFF]$/u);
    }
  });
  it("resolves short hashes only inside the current thread", () => {
    const s = state(); const content = JSON.stringify({ content: "historical file" });
    s.messages.push({ role: "tool", content, tool_call_id: "c", name: "read_file" });
    const input = { evidenceId: `artifact:${sha256(content).slice(0, 12)}`, offset: 0, limit: 8000 };
    assert.equal(recallThreadContext(s, input).ok, true);
    assert.throws(() => recallThreadContext(state(), input), /not found/u);
    assert.throws(() => recallThreadContext(s, { ...input, evidenceId: "artifact:bad" }), /Invalid/u);
  });
  it("references only the old three of eight exchanges while keeping the recent five and all reasoning intact", async () => {
    const s = state(), limits = defaultRuntimeLimits(), manager = new ContextManager();
    manager.configureTokenBudget(undefined, limits);
    s.messages.push({ role: "user", content: "Read source" });
    for (let i = 0; i < 8; i++) s.messages.push({ role: "assistant", content: null, reasoning_content: `intact thought ${i}`,
      tool_calls: [{ id: `read_${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `${i}.ts` }) } }] },
      { role: "tool", name: "read_file", tool_call_id: `read_${i}`, content: JSON.stringify({ ok: true, data: { content: `${i}:` + "s".repeat(20000) } }) });
    const raw = JSON.stringify(s.messages);
    assert.equal(await referenceToolOutputs({ state: s, manager, limits, turnId: "t", maxContextChars: 190000,
      nextRequest: { systemPrompt: "rules", runtimeContext: "", tools: [] }, reason: "pressure", append: async () => {} }, true), true);
    assert.deepEqual(s.pressureRecovery?.toolReferences, [2, 4, 6]);
    assert.equal(JSON.stringify(s.messages), raw);
    const projected = pressureProjectedMessages(s);
    assert.deepEqual(projected.slice(7), s.messages.slice(7));
    assert.equal(projected[1]?.role === "assistant" && projected[1].reasoning_content, "intact thought 0");
  });
  it("shares only published reviewer evidence back to its owning parent", async () => {
    const f = fixture(); f.get().actorThreads = { author: "a", reviewer: "r" };
    await f.emit({ type: "experiment", id: f.get().id, actor: "reviewer", evidenceId: "published", passed: false, unchanged: true });
    assert.equal(sharedReviewEvidenceOwner(f.s, "published"), "r");
    assert.equal(sharedReviewEvidenceOwner(f.s, "private_peer_read"), f.s.threadId);
    assert.equal(sharedReviewEvidenceOwner(state(), "published"), "test");
  });
  it("forces closure at five rounds and appends BOTH independent summaries without a sixth round or length retry", async () => {
    const f = fixture(); let turns = 0, summaries = 0;
    await runReviewDiscussion(f.get, f.emit, {
      discuss: async who => { turns++; await f.emit({ type: "request", id: f.get().id });
        return { proposal: `Different ${who}`, kind: "delivery", vote: "disagree", evidenceRefs: [], unresolved: [`${who} objection`] }; },
      summarize: async who => { summaries++; return `<analysis>discard</analysis><summary>${(who + " opinion 😀 ").repeat(6000)}</summary>`; },
      fresh: async () => true,
    });
    assert.equal(turns, 10); assert.equal(summaries, 2); assert.equal(f.get().round, 5);
    assert.equal(f.get().closeReason, "round_limit"); assert.equal(f.get().approval, false);
    assert.doesNotMatch(f.get().handoff!, /discard/u);
    assert.match(f.get().handoff!, /AUTHOR_SUMMARY/u); assert.match(f.get().handoff!, /REVIEWER_SUMMARY/u);
    for (const summary of Object.values(f.get().summaries)) assert.ok(estimatedTokens(summary.projected) <= 2048);
    await f.emit({ type: "applied", id: f.get().id });
    assert.equal(f.s.messages.length, 1);
    assert.throws(() => foldReviewEvent(f.s, { type: "applied", id: f.get().id }), /already applied/u);
  });
  it("consensus without real verification cannot approve delivery", async () => {
    const f = fixture();
    await runReviewDiscussion(f.get, f.emit, {
      discuss: async () => ({ proposal: "done", kind: "delivery", vote: "agree", evidenceRefs: ["invented"], unresolved: [] }),
      summarize: async who => who, fresh: async () => true,
    });
    assert.equal(f.get().round, 1); assert.equal(f.get().approval, false);
    const altered = fixture();
    await altered.emit({ type: "experiment", id: altered.get().id, actor: "reviewer", evidenceId: "changed_tests",
      passed: true, unchanged: true, standard: "changed" });
    await runReviewDiscussion(altered.get, altered.emit, {
      discuss: async () => ({ proposal: "done", kind: "delivery", vote: "agree", evidenceRefs: ["changed_tests"], unresolved: [] }),
      summarize: async who => who, fresh: async () => true,
    });
    assert.equal(altered.get().experiments[0]?.passed, true); // Test result is not rewritten as a failure.
    assert.equal(altered.get().approval, false); // A changed oracle is insufficient independent proof.
  });
  it("does not repeat a charged summary after resume and records an explicit fallback", async () => {
    const f = fixture();
    await f.emit({ type: "close", id: f.get().id, reason: "interrupted" });
    await f.emit({ type: "request", id: f.get().id, closingActor: "author" });
    let count = 0;
    await runReviewDiscussion(f.get, f.emit, { discuss: async () => { throw new Error("not allowed"); },
      summarize: async who => { count++; assert.equal(who, "reviewer"); return "position"; }, fresh: async () => false });
    assert.equal(count, 1); assert.equal(f.get().summaries.author?.unavailable, true); assert.equal(f.get().approval, false);
    const offline = fixture();
    await offline.emit({ type: "close", id: offline.get().id, reason: "environment unavailable" });
    await runReviewDiscussion(offline.get, offline.emit, { canSummarize: false,
      discuss: async () => { throw new Error("not allowed"); }, summarize: async () => { throw new Error("not dispatched"); }, fresh: async () => false });
    assert.equal(offline.get().requests, 0);
    assert.equal(offline.get().summaries.reviewer?.unavailable, true);
  });
  it("approves only with reviewer evidence and revokes a stale decision before applying it", async () => {
    const f = fixture();
    f.get().requirements = ["request"];
    await f.emit({ type: "experiment", id: f.get().id, actor: "reviewer", evidenceId: "independent", passed: true, unchanged: true, standard: "unchanged", method: "test", outcome: "passed" });
    await runReviewDiscussion(f.get, f.emit, { discuss: async () => ({ proposal: "deliver verified patch", kind: "delivery", vote: "agree",
      evidenceRefs: ["independent"], unresolved: [], checks: [{ requirementId: "request", evidenceId: "independent", method: "test", rationale: "original behavior checked", counterexample: "named enum member" }] }), summarize: async who => who + " final", fresh: async () => true });
    assert.equal(f.get().approval, true);
    await f.emit({ type: "applied", id: f.get().id, fresh: false });
    assert.equal(f.get().approval, false);
    assert.match(f.get().handoff!, /"deliveryApproved":false/u);
  });
});
