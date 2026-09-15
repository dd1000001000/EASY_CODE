import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import { extractSummaryText, projectSummary } from "../src/context/summary-output.js";
import { estimatedTokens } from "../src/context/token-budget.js";
import { recallThreadContext, sharedReviewEvidenceOwner } from "../src/context/recall.js";
import { sha256 } from "../src/utils/hash.js";
import type { SessionState } from "../src/core/types.js";
import { foldReviewEvent } from "../src/review/session.js";
import { referenceToolOutputs } from "../src/context/pressure-recovery.js";
import { pressureProjectedMessages } from "../src/context/pressure-projection.js";
import { ContextManager } from "../src/context/manager.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { baseSessionState } from "./session-state.js";

function state(): SessionState { return { ...baseSessionState(), threadId: "test", mode: "code", provider: "glm", model: "test", thinkingEffort: "none",
  workspaceRoot: process.cwd(), messages: [], constraints: [], filesRead: new Map(), changes: [], commands: [],
  commandApprovalPrefixes: [], workingSummary: "", compactedMessageCount: 0, createdAt: "now", updatedAt: "now" }; }

describe("unified memory and one-way review", () => {
  it("drops disposable summary scratch and rejects ambiguous envelopes", () => {
    assert.equal(extractSummaryText("<analysis>secret draft</analysis>\n<summary>formal</summary>"), "formal");
    assert.equal(extractSummaryText("<analysis>only draft</analysis>"), undefined);
    assert.equal(extractSummaryText("<summary>a</summary><summary>b</summary>"), undefined);
    assert.equal(extractSummaryText("ordinary prose "), "ordinary prose ");
  });
  it("projects large historical summaries independently", () => {
    const p = projectSummary("中文😀 ".repeat(8000), "historical", 2048);
    assert.ok(p.truncated); assert.ok(estimatedTokens(p.encoded) <= 2048);
    assert.equal(JSON.parse(p.encoded).sourceRef, "historical");
  });
  it("resolves short artifact hashes only inside the current thread", () => {
    const s = state(), content = JSON.stringify({ content: "historical file" });
    s.messages.push({ role: "tool", content, tool_call_id: "c", name: "read_file" });
    const input = { evidenceId: `artifact:${sha256(content).slice(0, 12)}`, offset: 0, limit: 8000 };
    assert.equal(recallThreadContext(s, input).ok, true);
    assert.throws(() => recallThreadContext(state(), input), /not found/u);
  });
  it("references old tool outputs while preserving the recent five and reasoning", async () => {
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
  it("publishes only captured reviewer evidence to its parent", () => {
    const s = state();
    foldReviewEvent(s, { type: "started", id: "r", key: "k", scope: "task", purpose: "delivery",
      snapshotId: "snapshot", requirementRevision: "req", reviewerThreadId: "private_reviewer" });
    foldReviewEvent(s, { type: "brief_ready", id: "r", text: "fallible main handoff" });
    foldReviewEvent(s, { type: "review_started", id: "r" });
    foldReviewEvent(s, { type: "evidence", id: "r", evidenceId: "captured" });
    assert.equal(sharedReviewEvidenceOwner(s, "captured"), "private_reviewer");
    assert.equal(sharedReviewEvidenceOwner(s, "uncaptured"), s.threadId);
  });
  it("recalls the exact reviewer report without author summary or consensus", () => {
    const s = state();
    foldReviewEvent(s, { type: "started", id: "r", key: "k", scope: "task", purpose: "delivery",
      snapshotId: "snapshot", requirementRevision: "req", reviewerThreadId: "private_reviewer" });
    foldReviewEvent(s, { type: "brief_ready", id: "r", text: "fallible main handoff" });
    foldReviewEvent(s, { type: "review_started", id: "r" });
    foldReviewEvent(s, { type: "reported", id: "r", report: { conclusion: "A boundary remains untested",
      nextAction: "Run a discriminating experiment", evidenceRefs: [], uncertainties: ["No official result"] } });
    foldReviewEvent(s, { type: "applied", id: "r", fresh: true });
    const recalled = recallThreadContext(s, { evidenceId: "review:r:report", offset: 0, limit: 8000 });
    assert.equal(recalled.ok, true);
    assert.match(JSON.stringify(recalled.data), /boundary remains untested/);
    assert.doesNotMatch(s.messages[0]!.content ?? "", /AUTHOR_SUMMARY|consensus/u);
  });
});
