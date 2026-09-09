import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it } from "./harness.js";
import { defaultRuntimeLimits, runtimeLimitsSchema } from "../src/config/runtime-limits.js";
import { ContextManager, contextPressureLevel } from "../src/context/manager.js";
import { tokenBudget, requestTokens } from "../src/context/token-budget.js";
import { effectiveContextWindow } from "../src/models/catalog.js";
import { CompactContextTool } from "../src/tools/compact-context.js";
import { createManageSubagentsInputSchema } from "../src/tools/manage-subagents.js";
import { createSubmitTaskResultInputSchema } from "../src/tools/submit-task-result.js";
import { createRecallContextSchema } from "../src/tools/context-read.js";
import { createManageMemoryInputSchema } from "../src/tools/manage-memory.js";
import { runCompactionTransaction, foldCompactionControl } from "../src/context/compaction-transaction.js";
import { foldMemoryGate } from "../src/context/pressure-recovery.js";
import { toolResultForModel } from "../src/tools/errors.js";
import { OutputCollector } from "../src/command/output-stream.js";
import { EvidenceStore } from "../src/context/evidence-store.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { estimatedTokens } from "../src/context/token-budget.js";
import { foldReviewEvent } from "../src/review/session.js";
import { recallThreadContext } from "../src/context/recall.js";
import type { ChatMessage, SessionState, ToolContext } from "../src/core/types.js";

const state = (): SessionState => ({ threadId: "thread_large", workspaceRoot: process.cwd(), mode: "code", provider: "glm", model: "mock",
  thinkingEffort: "none", messages: [{ role: "user", content: "Fix the parser; preserve all user requirements." }], constraints: [],
  filesRead: new Map(), changes: [], commands: [], commandApprovalPrefixes: [], workingSummary: "", compactedMessageCount: 0,
  createdAt: "now", updatedAt: "now" });

describe("configurable 1M context", () => {
  it("uses a 1M window, separate reservations, and exact configured pressure boundaries", () => {
    const limits = defaultRuntimeLimits();
    assert.equal(limits.maxContextTokens, 1_000_000);
    assert.deepEqual(tokenBudget(limits.maxContextTokens, limits), { window: 1_000_000, outputReserve: 32768,
      toolReserve: 65536, safetyReserve: 50000, inputCapacity: 851696 });
    for (const [value, expected] of [[0.79999, "normal"], [0.8, "suggest"], [0.89999, "suggest"],
      [0.9, "require"], [0.94999, "require"], [0.95, "force"], [1, "force"]] as const)
      assert.equal(contextPressureLevel(value, limits), expected);
    assert.equal(contextPressureLevel(0.7, { ...limits, contextReferenceTriggerRatio: 0.7 }), "suggest");
    assert.equal(effectiveContextWindow("glm", "glm-5.3-flash", 2_000_000), 1_000_000);
    assert.equal(effectiveContextWindow("glm", "glm-5.3-flash", 500_000), 500_000);
    assert.equal(runtimeLimitsSchema.safeParse({ ...limits, contextForceRatio: 0.85 }).success, false);
    assert.equal(runtimeLimitsSchema.safeParse({ ...limits, evidenceRecallMaxChars: 1000 }).success, false);
    assert.equal(runtimeLimitsSchema.safeParse({ ...limits, artifactChunkOverlapChars: 2000 }).success, false);
  });

  it("changes real schema and prose budgets, not just defaults", () => {
    const limits = { ...defaultRuntimeLimits(), contextSemanticFieldMaxChars: 6000,
      subagentInstructionsMaxChars: 16000, subagentSummaryMaxChars: 18000, evidenceRecallMaxChars: 40000 };
    const schema = new CompactContextTool(limits).definition.function.parameters as any;
    assert.equal(schema.properties.currentWork.maxLength, 6000);
    assert.equal(createManageSubagentsInputSchema(limits).parse({ action: "spawn", taskId: "task_a", instructions: "a".repeat(15000) }).action, "spawn");
    assert.throws(() => createManageSubagentsInputSchema(limits).parse({ action: "spawn", taskId: "task_a", instructions: "a".repeat(16001) }));
    assert.equal(createSubmitTaskResultInputSchema(limits).parse({ outcome: "completed", summary: "s".repeat(17000), evidence: ["verified"] }).summary.length, 17000);
    assert.equal(createRecallContextSchema(limits).parse({ evidenceId: "ref", limit: 39000 }).limit, 39000);
  });

  it("estimates append-only history incrementally but detects mutation of nested arguments and thinking", () => {
    const message: ChatMessage = { role: "assistant", content: "text", reasoning_content: "reason", tool_calls: [
      { id: "call", type: "function", function: { name: "run_command", arguments: "{}" } }] };
    const before = requestTokens([message]);
    assert.equal(requestTokens([message]), before);
    message.tool_calls![0]!.function.arguments = JSON.stringify({ program: "python", args: ["x".repeat(1000)] });
    assert.ok(requestTokens([message]) > before);
    const after = requestTokens([message]);
    message.reasoning_content = "new thinking".repeat(1000);
    assert.ok(requestTokens([message]) > after);
  });

  it("does not constrain read tools by the old character window in Token mode", async () => {
    const s = state(); s.messages.push({ role: "assistant", content: "old evidence ".repeat(25000) });
    let calls = 0, observed: ToolContext | undefined;
    const limits = defaultRuntimeLimits();
    const runtime = new AgentRuntime({ limits, contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system", getWorkspaceSummary: async () => "", searchMemories: async () => [],
      appendEvent: async () => undefined, requestApproval: async () => false,
      tools: [{ name: "read_file", mutating: false, definition: { type: "function", function: { name: "read_file", description: "Read", parameters: {} } },
        execute: async (_input, context) => { observed = context; return { ok: true, summary: "read", data: { content: "source" } }; } }],
      provider: { name: "glm", model: "mock", complete: async () => ({ message: ++calls === 1 ? { role: "assistant", content: null,
        tool_calls: [{ id: "read", type: "function", function: { name: "read_file", arguments: "{}" } }] } : { role: "assistant", content: "Source examined." } }) } });
    await runtime.run(s, "Read source", { maxSteps: 3, maxContextChars: 250000, maxContextTokens: 1_000_000,
      maxOutputChars: 64000, commandTimeoutMs: 1000, approvalPolicy: "never" });
    assert.ok(observed); assert.equal(observed.resultCharBudget, undefined);
    assert.ok(observed.resultTokenBudget! > 100000);
  });

  it("summarizes a minimum old prefix instead of everything before the last five exchanges", async () => {
    const s = state();
    s.messages.push(...Array.from({ length: 24 }, (_, i): ChatMessage => ({ role: "assistant", content: `${i}:` + "a".repeat(12000) })));
    const limits = { ...defaultRuntimeLimits(), maxContextTokens: 100000, maxResponseTokens: 2048, contextToolReserveTokens: 1024, contextSummaryMaxTokens: 2048 };
    const manager = new ContextManager(); manager.configureTokenBudget(limits.maxContextTokens, limits);
    const original = s.messages.length;
    const result = await runCompactionTransaction({ state: s, manager, limits, maxContextChars: 250000,
      turnId: "turn", required: true, maxRequests: 3, tool: new CompactContextTool(limits).definition,
      nextRequest: { systemPrompt: "system", runtimeContext: "", tools: [] }, append: async () => undefined,
      complete: async () => ({ role: "assistant", content: "<analysis>scratch</analysis><summary>Investigation remains unverified. Check the parser.</summary>" }) });
    assert.equal(result.committed, true);
    assert.ok(s.compactedMessageCount > 0);
    assert.ok(original - s.compactedMessageCount > 5);
    assert.doesNotMatch(s.workingSummary, /scratch/);
  });

  it("preserves useful command diagnostics and complete file lines under final JSON clipping", () => {
    const result = JSON.parse(toolResultForModel({ ok: false, summary: "failed", evidenceId: "evidence_" + "a".repeat(64), data: {
      commandId: "command", status: "exited", exitCode: 1, stdout: { text: "HEAD\n" + "line\n".repeat(5000) + "TAIL", totalBytes: 25000 }, stderr: { text: "error" } } }, 2000));
    assert.equal(result.data.exitCode, 1);
    assert.match(result.data.stdout.text, /HEAD/); assert.match(result.data.stdout.text, /TAIL/);
    const read = JSON.parse(toolResultForModel({ ok: true, summary: "read", data: { path: "f", startLine: 10, endLine: 509,
      content: Array.from({ length: 500 }, (_, i) => `line ${i} complete`).join("\n") } }, 1000));
    assert.ok(read.data.content.endsWith("complete"));
    assert.equal(read.data.nextStartLine, read.data.endLine + 1);
    assert.ok(JSON.stringify(read).length <= 1000);
  });

  it("reassesses pressure after referencing old results without buying an unnecessary summary", async () => {
    const s = state();
    s.messages = [{ role: "user", content: "Investigate without claiming verification." }];
    for (let n = 0; n < 8; n++) s.messages.push(
      { role: "assistant", content: null, reasoning_content: "r".repeat(6000), tool_calls: [{ id: `read_${n}`,
        type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", name: "read_file", tool_call_id: `read_${n}`, content: "e".repeat(20000) });
    const raw = JSON.stringify(s.messages);
    const limits = defaultRuntimeLimits(), manager = new ContextManager();
    manager.configureTokenBudget(100000, limits);
    let requests = 0;
    const result = await runCompactionTransaction({ state: s, manager, limits, turnId: "reference_first", maxContextChars: 250000,
      required: true, maxRequests: 3, nextRequest: { systemPrompt: "rules", runtimeContext: "", tools: [] },
      append: async () => undefined, complete: async () => { requests++; throw new Error("Unnecessary summary"); } });
    assert.equal(result.committed, true); assert.equal(requests, 0);
    assert.equal(s.compactedMessageCount, 0);
    assert.ok(s.pressureRecovery!.toolReferences.length > 0);
    assert.ok(s.pressureRecovery!.toolReferences.every(index => index < 7));
    assert.equal(JSON.stringify(s.messages), raw);
  });

  it("archives output before head/tail loss and marks finite disk quotas and scope boundaries", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "easy-large-output-"));
    const storage = createStorage(directory);
    try {
      const limits = { ...defaultRuntimeLimits(), commandArchiveMaxBytes: 40000, commandThreadArchiveMaxBytes: 40000 };
      const evidence = new EvidenceStore(storage, limits);
      const archive = evidence.createCommandArchive("workspace", "thread", "command");
      const collector = new OutputCollector(256, text => archive.push("stdout", text));
      collector.push("head".repeat(1000) + "MIDDLE_EVIDENCE" + "tail".repeat(1000));
      assert.doesNotMatch(collector.finish().text, /MIDDLE_EVIDENCE/);
      archive.finish();
      const id = archive.reference("stdout").evidenceId;
      assert.equal(createManageMemoryInputSchema(limits).safeParse({ action: "recall", evidenceId: id, limit: 32000 }).success, true);
      const page = evidence.read("workspace", "thread", id, 3900, 500) as any;
      assert.match(page.content, /MIDDLE_EVIDENCE/); assert.equal(page.complete, true);
      assert.throws(() => evidence.read("workspace", "other", id, 0, 100));
      const large = evidence.createCommandArchive("workspace", "thread", "large");
      large.push("stdout", "x".repeat(40000)); large.finish();
      const clipped = evidence.read("workspace", "thread", large.reference("stdout").evidenceId, 0, 100) as any;
      assert.equal(clipped.complete, false); assert.equal(clipped.sourceTruncated, true);
      assert.ok(clipped.missingRange.end > clipped.missingRange.start);
      const unicode = evidence.createCommandArchive("workspace", "unicode", "unicode");
      unicode.push("stdout", "a😀b"); unicode.finish();
      const unicodeId = unicode.reference("stdout").evidenceId;
      const first = evidence.read("workspace", "unicode", unicodeId, 0, 2) as any;
      assert.equal(first.content, "a"); assert.equal(first.nextOffset, 1);
      assert.equal((evidence.read("workspace", "unicode", unicodeId, first.nextOffset, 2) as any).content, "😀");
      assert.throws(() => evidence.read("workspace", "unicode", unicodeId, 2, 2), /Unicode/);
    } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("restores memory hysteresis without resetting Runtime counters", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "easy-memory-gate-"));
    const storage = createStorage(directory);
    try {
      const store = new ThreadStore(storage);
      const s = store.create({ threadId: "thread_gate", workspaceRoot: process.cwd(), mode: "code", provider: "glm", model: "mock", thinkingEffort: "none" });
      store.appendEvent(s.threadId, { type: "context.memory.gated", payload: { suppressed: true } });
      foldMemoryGate(s, { suppressed: true });
      assert.equal(store.recover(s.threadId).pressureRecovery?.optionalMemorySuppressed, true);
      assert.throws(() => store.appendEvent(s.threadId, { type: "context.memory.gated", payload: { suppressed: "false" } }));
      assert.equal(store.recover(s.threadId).pressureRecovery?.optionalMemorySuppressed, true);
    } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps exact review proposals with bounded independent summaries and pageable full evidence", () => {
    const s = state();
    foldReviewEvent(s, { type: "started", id: "r", key: "k", purpose: "stagnation", snapshotId: "snapshot", requirementRevision: "req",
      maxRounds: 5, maxRequests: 32, maxTools: 20, deadline: Date.now() + 60000, summaryTokens: 4096, briefingTokens: 6144, handoffTokens: 12288 });
    for (const who of ["reviewer", "author"] as const) foldReviewEvent(s, { type: "statement", id: "r", actor: who,
      value: { proposal: "Verify named IntFlag separately from unnamed composites", kind: "next_action", vote: "agree", evidenceRefs: [], unresolved: [] } });
    for (const who of ["author", "reviewer"] as const) foldReviewEvent(s, { type: "summary", id: "r", actor: who,
      text: "<summary>" + `${who} unverified facts `.repeat(5000) + "</summary>", unavailable: false });
    foldReviewEvent(s, { type: "decided", id: "r", fresh: true });
    const handoff = s.reviewSessions![0]!.handoff!;
    assert.ok(estimatedTokens(handoff) <= 12288);
    assert.match(handoff, /Verify named IntFlag/);
    assert.equal(recallThreadContext(s, { evidenceId: "review:r:evidence", offset: 0, limit: 32000 }).ok, true);
  });
});
