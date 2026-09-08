import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { ContextManager } from "../src/context/manager.js";
import { completeExchange, eligiblePhaseEnd, foldCompactionControl, investigationExchangeStart,
  runCompactionTransaction } from "../src/context/compaction-transaction.js";
import { compactionSnapshot, semanticDocument, conservativeDocument, recallCompactionEvidence } from "../src/context/semantic-compaction.js";
import { foldPressureRecovery } from "../src/context/pressure-recovery.js";
import { foldPendingOperations } from "../src/context/pending-operations.js";
import { runtimeContinuityMessage } from "../src/context/runtime-state.js";
import { createProgressGuardState } from "../src/progress/guard.js";
import { CompactContextTool } from "../src/tools/compact-context.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import type { AgentTool, ChatMessage, EventRecord } from "../src/core/types.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";

const semantic = { currentWork: "Investigation is unfinished", hypotheses: ["Parser may drop the value"],
  nextStep: "Reproduce the parser failure before changing code" };
const tool = new CompactContextTool();
function candidate(): Extract<ChatMessage, { role: "assistant" }> {
  return { role: "assistant", content: null, tool_calls: [{ id: "summary", type: "function",
    function: { name: "compact_context", arguments: JSON.stringify(semantic) } }] };
}
function fixture(rounds = 6, tokens = true, recordBoundaries = true, resultChars = 7000, reasoningChars = 7000) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "easy-code-investigation-"));
  const storage = createStorage(directory);
  const store = new ThreadStore(storage);
  const state = store.create({ threadId: "investigation", workspaceRoot: directory, mode: "code",
    provider: "deepseek", model: "test", thinkingEffort: "high" });
  const events: Array<{ type: string; payload: unknown }> = [];
  const append = async (event: Omit<EventRecord, "schemaVersion" | "sequence" | "timestamp" | "eventId">) => {
    store.appendEvent(state.threadId, event); events.push(event);
  };
  function message(m: ChatMessage, extra: Record<string, unknown> = {}) {
    store.appendEvent(state.threadId, { type: m.role === "user" ? "message.user" : m.role === "tool" ? "tool.result" : "message.assistant",
      phase: "completed",
      turnId: "turn", payload: m.role === "user" ? { message: m } : m.role === "tool"
        ? { callId: m.tool_call_id, tool: m.name, message: m, ...extra } : m });
    state.messages.push(m);
    if (m.role === "tool") foldPendingOperations(state, { tool: m.name, ...extra });
  }
  if (rounds) message({ role: "user", content: "Investigate and fix the parser" });
  for (let n = 0; n < rounds; n += 1) {
    message({ role: "assistant", content: null, reasoning_content: `reason ${n} ` + "r".repeat(reasoningChars),
      tool_calls: [{ id: `read_${n}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `${n}.ts` }) } }] });
    message({ role: "tool", name: "read_file", tool_call_id: `read_${n}`, content: JSON.stringify({ ok: true, data: "s".repeat(resultChars) }) });
    const payload = { end: state.messages.length, kind: "investigation", turnId: "turn" };
    if (recordBoundaries) {
      store.appendEvent(state.threadId, { type: "context.phase.closed", payload });
      foldCompactionControl(state, "context.phase.closed", payload);
    }
  }
  Object.assign(state, store.recover(state.threadId));
  const manager = new ContextManager();
  manager.configureTokenBudget(tokens ? 64_000 : undefined);
  const run = (overrides: Partial<Parameters<typeof runCompactionTransaction>[0]> = {}) => runCompactionTransaction({
    state, manager, turnId: "turn", maxContextChars: 100_000, required: true, handlesOpen: false,
    maxRequests: 3, nextRequest: { systemPrompt: "rules", runtimeContext: "workspace", tools: [] },
    tool: tool.definition, inventory: () => "", append, complete: async () => candidate(),
    execute: async () => ({ ok: true, summary: "semantic patch", contextCompaction: {
      formatVersion: 3, summary: JSON.stringify(semantic) } }), ...overrides,
  });
  return { state, store, manager, events, append, run, message,
    dispose() { storage.close(); rmSync(directory, { recursive: true, force: true }); } };
}

describe("unfinished investigation compaction", () => {
  it("evicts older exchanges when a protected two-round tail cannot fit and preserves raw history", async () => {
    const f = fixture(6, false);
    try {
      const raw = JSON.stringify(f.state.messages);
      const result = await f.run({ maxContextChars: 20_000,
        complete: async () => { throw new Error("unnecessary model request"); } });
      assert.equal(result.committed, true);
      assert.equal(JSON.parse(f.state.workingSummary).mode, "history_evicted");
      assert.equal(JSON.stringify(f.state.messages), raw);
      assert.ok(f.state.compactedMessageCount < f.state.messages.length);
      const recovered = f.store.recover(f.state.threadId);
      assert.deepEqual(recovered.pressureRecovery, f.state.pressureRecovery);
      f.store.save(f.state);
      assert.deepEqual(f.store.recover(f.state.threadId).pressureRecovery, recovered.pressureRecovery);
      const event = f.events.find((e) => e.type === "context.history.evicted")!;
      assert.throws(() => foldPressureRecovery(f.state, event.payload), /stale context eviction/);
    } finally { f.dispose(); }
  });

  it("references a single oversized tool result without clipping its thinking or changing the protocol", async () => {
    const f = fixture(1, false, false, 100_000);
    try {
      const raw = JSON.stringify(f.state.messages);
      const result = await f.run({ maxContextChars: 30_000 });
      assert.equal(result.committed, true);
      assert.deepEqual(f.state.pressureRecovery?.toolReferences, [2]);
      const built = f.manager.build({ state: f.state, systemPrompt: "rules", maxContextChars: 30_000 });
      const assistant = built.find((m) => m.role === "assistant");
      assert.deepEqual(assistant, f.state.messages[1]);
      const output = built.find((m) => m.role === "tool");
      assert.equal(output?.role === "tool" && output.tool_call_id, "read_0");
      assert.match(output?.content ?? "", /journal_message_2/);
      assert.equal(JSON.stringify(f.state.messages), raw);
      const recalled = recallCompactionEvidence(f.state, JSON.stringify({ action: "recall", evidenceId: "journal_message_2", limit: 4000 }));
      assert.equal(recalled?.ok, true);
      assert.ok((recalled?.data as { totalChars: number }).totalChars > 100_000);
      assert.ok(f.manager.inspectProviderRequest({ state: f.state, messages: built, tools: [], maxContextChars: 30_000 }).utilization < 0.75);
      assert.deepEqual(f.store.recover(f.state.threadId).pressureRecovery, f.state.pressureRecovery);
    } finally { f.dispose(); }
  });

  it("archives an oversized previous summary when repair and conservative recovery cannot fit", async () => {
    const f = fixture();
    try {
      const large = { ...semantic, decisions: Array.from({ length: 10 }, (_, n) => `${n}:` + "d".repeat(1000)) };
      const largeCandidate = candidate();
      largeCandidate.tool_calls![0]!.function.arguments = JSON.stringify(large);
      await f.run({ limits: { ...defaultRuntimeLimits(), contextSummaryMaxTokens: 12000 }, complete: async () => largeCandidate, execute: async () => ({ ok: true, summary: "ok",
        contextCompaction: { formatVersion: 3, summary: JSON.stringify(large) } }) });
      const oldSummary = f.state.workingSummary;
      assert.ok(oldSummary.length > 10_000);
      f.manager.configureTokenBudget(undefined);
      // Append more complete work, retaining the real previous summary in Journal.
      for (let n = 0; n < 3; n += 1) {
        f.message({ role: "assistant", content: null, reasoning_content: "r".repeat(7000), tool_calls: [{ id: `new_${n}`,
          type: "function", function: { name: "read_file", arguments: "{}" } }] });
        f.message({ role: "tool", name: "read_file", tool_call_id: `new_${n}`, content: "s".repeat(7000) });
      }
      const result = await f.run({ maxContextChars: 50_000, maxAttempts: 1,
        complete: async () => ({ role: "assistant", content: "invalid" }), execute: async () => ({ ok: false, summary: "invalid" }) });
      assert.equal(result.committed, true);
      const summary = JSON.parse(f.state.workingSummary);
      assert.equal(summary.mode, "history_evicted");
      assert.equal(f.state.pressureRecovery?.summaries[summary.previousSummaryRef], oldSummary);
      const recalled = recallCompactionEvidence(f.store.recover(f.state.threadId), JSON.stringify({ action: "recall", evidenceId: summary.previousSummaryRef, limit: 16000 }));
      assert.equal(recalled?.ok, true);
      assert.equal(JSON.parse((recalled?.data as { text: string }).text), oldSummary);
      assert.equal(f.state.compactionControl?.transaction?.status, "superseded");
    } finally { f.dispose(); }
  });

  it("compacts with a running command and preserves its exact polling identity across Resume", async () => {
    const f = fixture();
    try {
      const command = { commandId: "command_running", status: "running", exitCode: null,
        program: "pytest", args: ["tests/parser.py"], cwd: f.state.workspaceRoot, taskId: "parser" };
      f.message({ role: "assistant", content: null, tool_calls: [{ id: "start", type: "function",
        function: { name: "start_command", arguments: JSON.stringify({ program: command.program, args: command.args }) } }] });
      f.message({ role: "tool", name: "start_command", tool_call_id: "start", content: JSON.stringify({ ok: true, data: command }) }, { contextCommand: command });
      const result = await f.run({ handlesOpen: true, maxContextChars: 40_000 });
      assert.equal(result.committed, true);
      assert.deepEqual(f.state.contextOperations?.commands.command_running, command);
      assert.match(runtimeContinuityMessage(f.state), /poll_command/);
      assert.deepEqual(f.store.recover(f.state.threadId).contextOperations, f.state.contextOperations);
      f.message({ role: "assistant", content: null, tool_calls: [{ id: "poll", type: "function",
        function: { name: "poll_command", arguments: JSON.stringify({ commandId: command.commandId }) } }] });
      f.message({ role: "tool", name: "poll_command", tool_call_id: "poll", content: "finished" },
        { contextCommand: { ...command, status: "exited", exitCode: 0 } });
      assert.equal(f.state.contextOperations?.commands.command_running, undefined);
      assert.doesNotMatch(runtimeContinuityMessage(f.state), /command_running/);
      assert.deepEqual(f.store.recover(f.state.threadId).contextOperations, f.state.contextOperations);
    } finally { f.dispose(); }
  });

  it("pins standalone child requirements and follow-ups without freezing history", async () => {
    const f = fixture();
    try {
      const assignment = { agentId: "child", childThreadId: "child_thread", kind: "standalone", taskId: "parser",
        taskTitle: "Inspect parser", taskDescription: "Locate the failing input", completionChecks: ["Provide a counterexample"],
        provider: "deepseek", model: "test", thinkingEffort: "high", createdAt: f.state.createdAt };
      for (const [id, lifecycle] of [["start_child", { action: "activate", agentId: "child" }],
        ["follow", { action: "deliver_follow_up", agentId: "child", message: "Also check empty strings" }]] as const) {
        f.message({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "manage_subagents", arguments: "{}" } }] });
        f.message({ role: "tool", name: "manage_subagents", tool_call_id: id, content: "running" },
          { subagentLifecycle: lifecycle, ...(lifecycle.action === "activate" ? { subagentAssignment: assignment } : {}) });
      }
      assert.equal((await f.run({ handlesOpen: true, maxContextChars: 40_000 })).committed, true);
      const facts = runtimeContinuityMessage(f.state);
      assert.match(facts, /Locate the failing input/);
      assert.match(facts, /Also check empty strings/);
      assert.deepEqual(f.store.recover(f.state.threadId).contextOperations, f.state.contextOperations);
      f.store.save(f.state);
      assert.deepEqual(f.store.recover(f.state.threadId).contextOperations, f.state.contextOperations);
    } finally { f.dispose(); }
  });

  it("does not clear pending reviewer experiments or their budgets during compaction", async () => {
    const f = fixture();
    try {
      f.state.progressGuard = createProgressGuardState();
      f.state.progressGuard.incidents.push({ incidentId: "review", phase: "experiment_pending", reviewAttempts: 1,
        experiment: { instruction: "Compare the two parser branches" } } as unknown as NonNullable<typeof f.state.progressGuard>["incidents"][number]);
      const original = JSON.stringify(f.state.progressGuard);
      const result = await f.run({ handlesOpen: true, append: async () => undefined });
      assert.equal(result.committed, true);
      assert.equal(JSON.stringify(f.state.progressGuard), original);
      assert.match(runtimeContinuityMessage(f.state), /Compare the two parser branches/);
      assert.match(runtimeContinuityMessage(f.state), /"reviewAttempts":1/);
    } finally { f.dispose(); }
  });

  it("archives an oversized latest thinking block whole and resumes from minimal state", async () => {
    const f = fixture(1, false, false, 100_000, 100_000);
    try {
      const raw = JSON.stringify(f.state.messages);
      const result = await f.run({ maxContextChars: 30_000 });
      assert.equal(result.committed, true);
      assert.equal(result.paused, undefined);
      assert.equal(JSON.stringify(f.state.messages), raw);
      assert.equal(JSON.parse(f.state.workingSummary).mode, "minimal_rebase");
      assert.equal(f.state.compactedMessageCount, f.state.messages.length);
      assert.equal(f.state.pressureRecovery?.rebase?.count, 1);
      assert.deepEqual(f.store.recover(f.state.threadId).pressureRecovery, f.state.pressureRecovery);
    } finally { f.dispose(); }
  });

  it("recovers an eviction committed just before a crash without repeating it", async () => {
    const f = fixture(1, false, false, 100_000);
    try {
      await assert.rejects(f.run({ maxContextChars: 30_000, append: async (event) => {
        await f.append(event);
        if (event.type === "context.history.evicted") throw new Error("crash after eviction append");
      } }), /crash after eviction/);
      assert.equal(f.state.pressureRecovery, undefined);
      const resumed = f.store.recover(f.state.threadId);
      assert.deepEqual(resumed.pressureRecovery?.toolReferences, [2]);
      const built = f.manager.build({ state: resumed, systemPrompt: "rules", maxContextChars: 30_000 });
      assert.ok(f.manager.inspectProviderRequest({ state: resumed, messages: built, tools: [], maxContextChars: 30_000 }).utilization < 0.75);
      f.store.save(resumed);
      assert.deepEqual(f.store.recover(f.state.threadId).pressureRecovery, resumed.pressureRecovery);
      assert.equal(f.events.filter((e) => e.type === "context.history.evicted").length, 1);
    } finally { f.dispose(); }
  });
  it("uses raw complete exchanges without requiring historical phase events", async () => {
    const f = fixture(6, true, false);
    try {
      assert.equal(eligiblePhaseEnd(f.state, false), 9);
      const result = await f.run();
      assert.equal(result.committed, true);
      assert.equal(f.state.compactedMessageCount, 9);
      assert.equal(f.events.filter((e) => e.type === "context.phase.closed").length, 0);
      assert.equal(f.store.recover(f.state.threadId).compactedMessageCount, 9);
    } finally { f.dispose(); }
  });
  for (const tokens of [false, true]) it(`compacts six read-only rounds without tests (${tokens ? "token" : "character"} mode)`, async () => {
    const f = fixture(6, tokens);
    try {
      assert.deepEqual(f.state.compactionControl?.phaseEnds, []);
      assert.equal(eligiblePhaseEnd(f.state, false), 9);
      const original = JSON.stringify(f.state.messages);
      const result = await f.run();
      assert.deepEqual(result, { committed: true, requests: 1 });
      assert.equal(f.state.compactedMessageCount, 9);
      assert.equal(JSON.stringify(f.state.messages), original);
      const projected = f.manager.build({ state: f.state, maxContextChars: 100_000, systemPrompt: "rules" });
      for (const recent of f.state.messages.slice(9)) assert.ok(projected.some((m) => JSON.stringify(m) === JSON.stringify(recent)));
      const summary = JSON.parse(f.state.workingSummary);
      assert.equal(summary.investigation, "unfinished_investigation_not_verified");
      assert.deepEqual(summary.semantic.hypotheses, semantic.hypotheses);
      const recovered = f.store.recover(f.state.threadId);
      assert.equal(recovered.compactedMessageCount, 9);
      assert.deepEqual(recovered.compactionControl, f.state.compactionControl);
      assert.equal(JSON.stringify(recovered.messages), original);
    } finally { f.dispose(); }
  });

  it("resumes a prepared investigation summary after a commit crash without a second request", async () => {
    const f = fixture();
    try {
      await assert.rejects(f.run({ append: async (event) => {
        if (event.type === "context.compacted") throw new Error("commit interrupted");
        await f.append(event);
      } }), /commit interrupted/);
      const resumed = f.store.recover(f.state.threadId);
      const result = await f.run({ state: resumed, complete: async () => { throw new Error("duplicate request"); } });
      assert.deepEqual(result, { committed: true, requests: 0 });
      assert.equal(f.store.recover(f.state.threadId).compactedMessageCount, 9);
    } finally { f.dispose(); }
  });

  it("keeps investigation unverified in lossy recovery and in cited model conclusions", async () => {
    const f = fixture(6, false, true, 7000, 12000);
    try {
      const snapshot = compactionSnapshot(f.state, 9);
      const doc = JSON.parse(semanticDocument({ ...semantic, conclusions: [{ text: "The task is fixed", evidenceIds: [snapshot.evidence[0]!.id] }] }, snapshot));
      assert.equal(doc.investigation, "unfinished_investigation_not_verified");
      assert.equal(doc.semantic.conclusions[0].verification, "model_interpretation_not_runtime_verified");
      assert.equal(JSON.parse(conservativeDocument(f.state, snapshot)).investigation, doc.investigation);
      const result = await f.run({ complete: async () => ({ role: "assistant", content: "invalid" }),
        execute: async () => ({ ok: false, summary: "missing candidate" }) });
      assert.equal(result.committed, true);
      assert.equal(JSON.parse(f.state.workingSummary).mode, "history_evicted");
      assert.match(f.store.recover(f.state.threadId).workingSummary, /NOT verified/);
    } finally { f.dispose(); }
  });

  it("prefers the retained-exchange count but can reduce the tail to release capacity", () => {
    const f = fixture();
    try {
      assert.equal(eligiblePhaseEnd(f.state, false, 3), 7);
      assert.equal(eligiblePhaseEnd(f.state, false, 6), 3);
      assert.equal(eligiblePhaseEnd(f.state, true), 9);
      const recovered = f.store.recover(f.state.threadId);
      assert.equal(eligiblePhaseEnd(recovered, false, 3), 7);
    } finally { f.dispose(); }
  });

  it("rejects missing tool results but allows complete write batches", () => {
    const f = fixture();
    try {
      const latest = f.state.messages.at(-2)!;
      assert.equal(investigationExchangeStart(f.state.messages, f.state.messages.length - 1), undefined);
      assert.equal(completeExchange(f.state.messages, f.state.messages.length - 1), false);
      if (latest.role !== "assistant") throw new Error("fixture");
      latest.tool_calls![0]!.function.name = "update_file";
      assert.equal(investigationExchangeStart(f.state.messages), undefined);
      assert.equal(eligiblePhaseEnd(f.state, false), 9);
      assert.throws(() => foldCompactionControl(f.state, "context.phase.closed", {
        end: f.state.messages.length, kind: "investigation" }), /Invalid investigation/);
    } finally { f.dispose(); }
  });

  it("keeps all calls/results in a multi-tool exchange and refuses an open call", async () => {
    const f = fixture();
    try {
      const prefix = f.state.messages.slice(0, 9);
      const batch: ChatMessage[] = [{ role: "assistant", content: null, reasoning_content: "intact batch reasoning",
        tool_calls: ["a", "b"].map((id) => ({ id, type: "function" as const, function: { name: "read_file" as const, arguments: "{}" } })) },
        { role: "tool", name: "read_file", tool_call_id: "a", content: "first" },
        { role: "tool", name: "read_file", tool_call_id: "b", content: "second" }];
      assert.equal(investigationExchangeStart([...prefix, ...batch]), prefix.length);
      f.state.messages = [...prefix, ...batch.slice(0, -1)];
      assert.equal(eligiblePhaseEnd(f.state, false), undefined);
      const result = await f.run({ append: async () => undefined });
      assert.match(result.paused?.reason ?? "", /no matching result/);
      assert.equal(f.state.compactedMessageCount, 0);
    } finally { f.dispose(); }
  });

  it("Runtime records investigation boundaries and continues after automatic compaction", async () => {
    const f = fixture(0, false);
    try {
      let reads = 0;
      let summaries = 0;
      const readTool: AgentTool = { name: "read_file", mutating: false, definition: { type: "function", function: {
        name: "read_file", description: "Read source", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
        execute: async () => ({ ok: true, summary: `source ${reads}`, data: "s".repeat(6000) }) };
      const runtime = new AgentRuntime({ provider: { name: "deepseek", model: "test", complete: async (request) => {
        if (request.tools?.length === 1 && request.tools[0]!.function.name === "compact_context") {
          summaries += 1;
          assert.match(request.messages[0]!.content!, /investigation boundary is NOT task completion/i);
          return { message: candidate() };
        }
        if (reads >= 6) return { message: { role: "assistant", content: "Investigation remains unfinished; reproduce the failure next." } };
        reads += 1;
        return { message: { role: "assistant", content: null, reasoning_content: `${reads}:` + "r".repeat(16_000),
          tool_calls: [{ id: `read_${reads}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `${reads}.ts` }) } }] } };
      } }, tools: [readTool, tool], contextManager: f.manager, appendEvent: f.append,
        buildSystemPrompt: async () => "rules", getWorkspaceSummary: async () => "workspace",
        searchMemories: async () => [], requestApproval: async () => false });
      const result = await runtime.run(f.state, "Investigate the parser", { maxSteps: 12, maxContextChars: 100_000,
        maxOutputChars: 8000, commandTimeoutMs: 1000, approvalPolicy: "never" });
      assert.equal(result.reason, "success", result.text);
      assert.equal(reads, 6);
      assert.ok(summaries > 0);
      assert.ok(f.state.compactedMessageCount > 0);
      assert.ok(f.events.some((e) => e.type === "context.phase.closed" && (e.payload as { kind: string }).kind === "investigation"));
      assert.equal(f.store.recover(f.state.threadId).compactedMessageCount, f.state.compactedMessageCount);
    } finally { f.dispose(); }
  });
});
