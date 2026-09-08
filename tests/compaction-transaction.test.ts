import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { compactionV2Input } from "./compaction-fixture.js";
import { ContextManager } from "../src/context/manager.js";
import { TokenCalibration } from "../src/context/token-calibration.js";
import { requestTokens, tokenBudget, budgetedRequest } from "../src/context/token-budget.js";
import { completeExchange, eligiblePhaseEnd, foldCompactionControl, prefixHash,
  runCompactionTransaction } from "../src/context/compaction-transaction.js";
import { exactContext } from "../src/context/context-request.js";
import { CompactContextTool } from "../src/tools/compact-context.js";
import { prepareToolInput, protocolToolFailure } from "../src/tools/errors.js";
import { toolFailure } from "../src/tools/base.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import type { ChatMessage, EventRecord, SessionState } from "../src/core/types.js";

const envelope = { systemPrompt: "Stable system rules", runtimeContext: "workspace state", tools: [] };
const compactTool = new CompactContextTool();
const options = { maxSteps: 4, maxContextChars: 100_000, maxContextTokens: 64_000,
  maxOutputChars: 8000, commandTimeoutMs: 1000, approvalPolicy: "never" as const };

function candidate(primary = 0, text = "Fix the task") {
  return { role: "assistant" as const, content: null, tool_calls: [{ id: "compact_candidate", type: "function" as const,
    function: { name: "compact_context" as const, arguments: JSON.stringify(compactionV2Input({
      primaryRequestIndex: primary, primaryRequestText: text })) } }] };
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "easy-code-compaction-tx-"));
  const storage = createStorage(directory);
  const store = new ThreadStore(storage);
  let state = store.create({ threadId: "phase_test", workspaceRoot: directory, mode: "code",
    provider: "deepseek", model: "test", thinkingEffort: "high" });
  const events: Array<{ type: string; payload: unknown }> = [];
  const append = async (event: Omit<EventRecord, "schemaVersion" | "sequence" | "timestamp" | "eventId">) => {
    events.push(event);
    store.appendEvent(state.threadId, event);
  };
  const message = (m: ChatMessage) => {
    store.appendEvent(state.threadId, { type: m.role === "user" ? "message.user" : m.role === "tool" ? "tool.result" : "message.assistant",
      turnId: "prior_turn", payload: m.role === "user" ? { message: m } : m.role === "tool"
        ? { callId: m.tool_call_id, tool: m.name, message: m } : m });
    state.messages.push(m);
  };
  message({ role: "user", content: "Fix the task" });
  message({ role: "assistant", content: "Old completed work", reasoning_content: "old ".repeat(15_000) });
  for (const end of [2, 4]) {
    if (end === 4) {
      message({ role: "assistant", content: "Retain recent cycle", reasoning_content: "recent thought",
        tool_calls: [{ id: "read_recent", type: "function", function: { name: "read_file", arguments: "{}" } }] });
      message({ role: "tool", name: "read_file", tool_call_id: "read_recent", content: "Recent raw evidence" });
    }
    store.appendEvent(state.threadId, { type: "context.phase.closed", payload: { end } });
    foldCompactionControl(state, "context.phase.closed", { end });
  }
  message({ role: "assistant", content: "Live work", reasoning_content: "keep this exactly" });
  // Use event-recovered intent rather than fabricate a checkpoint-only ledger.
  state = store.recover(state.threadId);
  const manager = new ContextManager();
  manager.configureTokenBudget(options.maxContextTokens);
  const execute = async (m: Extract<ChatMessage, { role: "assistant" }>) => {
    const call = m.tool_calls?.[0];
    if (!call) return { ok: false, summary: "Missing call", failure: protocolToolFailure("missing_call", "Call compact_context") };
    try { return await compactTool.execute(prepareToolInput(compactTool, call.function.arguments), {
      workspaceRoot: directory, mode: "code", threadId: state.threadId, turnId: "test_turn",
      approvalPolicy: "never", requestApproval: async () => false, commandTimeoutMs: 1000, maxOutputChars: 8000,
    }); } catch (error) { return toolFailure(error); }
  };
  const run = (overrides: Partial<Parameters<typeof runCompactionTransaction>[0]> = {}) => runCompactionTransaction({
    state, manager, turnId: "test_turn", maxContextChars: options.maxContextChars,
    required: true, handlesOpen: false, maxRequests: 3, nextRequest: envelope,
    tool: compactTool.definition, inventory: () => "Runtime source inventory", append,
    complete: async () => candidate(), execute, ...overrides,
  });
  return { directory, storage, store, state, manager, events, append, run,
    dispose() { storage.close(); rmSync(directory, { recursive: true, force: true }); } };
}

describe("completed-phase compaction transactions", () => {
  it("retires only a completed prefix and leaves the recent cycle and live thinking byte-identical", async () => {
    const f = fixture();
    try {
      const raw = JSON.stringify(f.state.messages);
      const tail = JSON.stringify(f.state.messages.slice(2));
      const result = await f.run();
      assert.deepEqual(result, { requests: 1, committed: true });
      assert.equal(f.state.compactedMessageCount, 2);
      assert.equal(JSON.stringify(f.state.messages), raw);
      assert.equal(JSON.stringify(f.state.messages.slice(2)), tail);
      assert.equal(f.events.filter((e) => e.type === "message.assistant" || e.type === "tool.result").length, 0);
      const recovered = f.store.recover(f.state.threadId);
      assert.equal(recovered.compactionControl?.transaction?.status, "committed");
      assert.equal(recovered.compactedMessageCount, 2);
      assert.equal(JSON.stringify(recovered.messages), raw);
      const built = f.manager.build({ state: f.state, ...envelope, maxContextChars: options.maxContextChars });
      assert.deepEqual(built, exactContext(f.state, envelope));
      assert.ok(built.some((m) => m.role === "assistant" && m.reasoning_content === "keep this exactly"));
    } finally { f.dispose(); }
  });

  it("repairs missing schema fields without inventing booleans or polluting work history", async () => {
    const f = fixture();
    try {
      let calls = 0;
      const raw = JSON.stringify(f.state.messages);
      await f.run({ complete: async (messages) => {
        calls += 1;
        if (calls === 2) {
          assert.match(messages.at(-1)!.content!, /unresolvedErrorsPreserved/u);
          return candidate();
        }
        const broken = candidate();
        const args = JSON.parse(broken.tool_calls[0]!.function.arguments);
        delete args.coverageCheck.unresolvedErrorsPreserved;
        broken.tool_calls[0]!.function.arguments = JSON.stringify(args);
        return broken;
      } });
      assert.equal(calls, 2);
      assert.equal(f.state.compactionControl?.transaction?.attempts, 2);
      assert.equal(JSON.stringify(f.state.messages), raw);
    } finally { f.dispose(); }
  });

  it("recovers a durable candidate after commit-write failure without another model request", async () => {
    const f = fixture();
    try {
      await assert.rejects(f.run({ append: async (event) => {
        if (event.type === "context.compacted") throw new Error("simulated crash before commit");
        return f.append(event);
      } }), /simulated crash/u);
      assert.equal(f.state.compactedMessageCount, 0);
      const recovered = f.store.recover(f.state.threadId);
      assert.ok(recovered.compactionControl?.transaction?.candidate);
      const result = await f.run({ state: recovered, complete: async () => { throw new Error("must not request twice"); } });
      assert.deepEqual(result, { requests: 0, committed: true });
      assert.equal(f.store.recover(f.state.threadId).compactedMessageCount, 2);
    } finally { f.dispose(); }
  });

  it("does not reset exhausted attempts across checkpoint and Resume", async () => {
    const f = fixture();
    try {
      const fail = async () => ({ role: "assistant" as const, content: "Not a structured candidate" });
      await assert.rejects(f.run({ complete: fail }), /attempts remain consumed/u);
      f.store.save(f.state);
      const resumed = f.store.recover(f.state.threadId);
      assert.equal(resumed.compactionControl?.transaction?.attempts, 3);
      assert.equal(resumed.compactedMessageCount, 0);
      await assert.rejects(f.run({ state: resumed, complete: async () => { throw new Error("budget reset"); } }), /attempts remain consumed/u);
      assert.equal(f.events.filter((e) => e.type === "context.compaction.attempt").length, 3);
    } finally { f.dispose(); }
  });

  it("retains a configured single-attempt ceiling even when Resume increases the configured limit", async () => {
    const f = fixture();
    try {
      await assert.rejects(f.run({ maxAttempts: 1,
        complete: async () => ({ role: "assistant", content: "No structured candidate" }) }), /attempts remain consumed/u);
      f.store.save(f.state);
      const resumed = f.store.recover(f.state.threadId);
      assert.equal(resumed.compactionControl?.transaction?.maxAttempts, 1);
      assert.equal(resumed.compactionControl?.transaction?.attempts, 1);
      await assert.rejects(f.run({ state: resumed, maxAttempts: 3,
        complete: async () => { throw new Error("budget reset"); } }), /attempts remain consumed/u);
      assert.equal(f.events.filter((event) => event.type === "context.compaction.attempt").length, 1);
    } finally { f.dispose(); }
  });

  it("revalidates new user intent on Resume under the same transaction and attempt budget", async () => {
    const f = fixture();
    try {
      await assert.rejects(f.run({ append: async (event) => {
        if (event.type === "context.compacted") throw new Error("crash");
        return f.append(event);
      } }), /crash/u);
      const id = f.state.compactionControl!.transaction!.id;
      f.store.appendEvent(f.state.threadId, { type: "message.user", turnId: "resume_turn",
        payload: { message: { role: "user", content: "Preserve the API on resume" } } });
      const resumed = f.store.recover(f.state.threadId);
      await f.run({ state: resumed, complete: async () => candidate(5, "Preserve the API on resume") });
      assert.equal(resumed.compactionControl?.transaction?.id, id);
      assert.equal(resumed.compactionControl?.transaction?.attempts, 2);
      assert.equal(resumed.contextIntentLedger?.latestRequest.text, "Preserve the API on resume");
      assert.equal(resumed.compactedMessageCount, 2);
    } finally { f.dispose(); }
  });

  it("does not turn a final answer into a tiny cycle that evicts the most recent verification", () => {
    const f = fixture();
    try {
      f.state.compactionControl = { phaseEnds: [2] };
      foldCompactionControl(f.state, "context.phase.closed", { end: 5, kind: "verification", turnId: "same_turn" });
      f.state.messages.push({ role: "assistant", content: "final" });
      foldCompactionControl(f.state, "context.phase.closed", { end: 6, kind: "turn", turnId: "same_turn" });
      assert.deepEqual(f.state.compactionControl.phaseEnds, [2, 5]);
      assert.equal(eligiblePhaseEnd(f.state, false), 2);
    } finally { f.dispose(); }
  });

  it("reports capacity pauses separately from compaction-protocol or code failures", async () => {
    const f = fixture();
    try {
      f.state.compactionControl = { phaseEnds: [] };
      const runtime = new AgentRuntime({ provider: { name: "deepseek", model: "test", complete: async () => {
        throw new Error("must not request a destructive fallback");
      } }, tools: [compactTool], contextManager: f.manager, appendEvent: async () => undefined,
      buildSystemPrompt: async () => "rules", getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [], requestApproval: async () => false });
      const result = await runtime.run(f.state, "Continue safely", { ...options, maxContextChars: 60_000 });
      assert.equal(result.failure?.code, "context_capacity_insufficient");
      assert.equal(result.failure?.attempts, 0);
      assert.equal(f.state.compactedMessageCount, 0);
    } finally { f.dispose(); }
  });

  it("reserves an attempt before dispatch so a lost response still consumes budget", async () => {
    const f = fixture();
    try {
      await assert.rejects(f.run({ complete: async () => { throw new Error("network disconnect"); } }), /network disconnect/u);
      const resumed = f.store.recover(f.state.threadId);
      assert.equal(resumed.compactionControl?.transaction?.attempts, 1);
      await f.run({ state: resumed });
      assert.equal(resumed.compactionControl?.transaction?.attempts, 2);
    } finally { f.dispose(); }
  });

  it("commits idempotently and rejects malformed events before poisoning the journal", async () => {
    const f = fixture();
    try {
      await f.run();
      const commit = f.events.find((event) => event.type === "context.compacted")!;
      f.store.appendEvent(f.state.threadId, commit);
      assert.equal(f.store.recover(f.state.threadId).compactedMessageCount, 2);
      assert.throws(() => f.store.appendEvent(f.state.threadId, { type: "context.compaction.started",
        payload: { id: "forged", start: 2, end: 99, sourceHash: "a".repeat(64), status: "pending", attempts: 0 } }), /Invalid compaction/u);
      assert.equal(f.store.recover(f.state.threadId).compactedMessageCount, 2);
    } finally { f.dispose(); }
  });

  it("cannot obtain an extra normal model call after spending the final shared request on compaction", async () => {
    const f = fixture();
    try {
      let requests = 0;
      const runtime = new AgentRuntime({ provider: { name: "deepseek", model: "test", complete: async () => {
        requests += 1; return { message: candidate(5, "Continue safely") };
      } }, tools: [compactTool], contextManager: f.manager, appendEvent: f.append,
      buildSystemPrompt: async () => "rules", getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [], requestApproval: async () => false });
      const result = await runtime.run(f.state, "Continue safely", { ...options, maxSteps: 1 });
      assert.equal(requests, 1);
      assert.equal(result.reason, "limit_reached");
      assert.equal(f.state.compactedMessageCount, 2);
    } finally { f.dispose(); }
  });

  it("uses the isolated transaction before Auto routing without replaying or duplicating the active user message", async () => {
    const f = fixture();
    try {
      f.state.mode = "auto";
      let requests = 0;
      const runtime = new AgentRuntime({ provider: { name: "deepseek", model: "test", complete: async (request) => {
        requests += 1;
        if (requests === 1) {
          assert.deepEqual(request.tools?.map((tool) => tool.function.name), ["compact_context"]);
          return { message: candidate(5, "Answer directly") };
        }
        assert.ok(request.tools?.some((tool) => String(tool.function.name) === "respond_directly"));
        return { message: { role: "assistant", content: null, tool_calls: [{ id: "route_reply", type: "function",
          function: { name: "respond_directly", arguments: JSON.stringify({ content: "done" }) } }] } };
      } }, tools: [compactTool], contextManager: f.manager, appendEvent: async () => undefined,
      buildSystemPrompt: async () => "rules", getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [], requestApproval: async () => false });
      const result = await runtime.run(f.state, "Answer directly", { ...options, maxContextChars: 70_000 });
      assert.equal(result.reason, "success", result.text);
      assert.equal(requests, 2);
      assert.equal(f.state.compactedMessageCount, 2);
      assert.equal(f.state.messages.filter((m) => m.role === "user" && m.content === "Answer directly").length, 1);
    } finally { f.dispose(); }
  });

  it("does not spend a request when protected tail cannot meet the 55% target", async () => {
    const f = fixture();
    try {
      f.state.messages.at(-1)!.content = "protected".repeat(20_000);
      await assert.rejects(f.run({ complete: async () => { throw new Error("should not run"); } }), /protected tail/u);
      assert.equal(f.state.compactionControl?.transaction, undefined);
      assert.equal(f.events.length, 0);
    } finally { f.dispose(); }
  });

  it("rejects split tool exchanges, open command handles and stale source hashes", async () => {
    const f = fixture();
    try {
      const exchange: ChatMessage[] = [{ role: "assistant", content: null, tool_calls: [{ id: "call", type: "function",
        function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", name: "read_file", tool_call_id: "call", content: "result" }];
      assert.equal(completeExchange(exchange, 1), false);
      assert.equal(completeExchange(exchange), true);
      assert.equal(eligiblePhaseEnd(f.state, true), undefined);
      await assert.rejects(f.run({ handlesOpen: true }), /no safely completed phase/u);
      assert.throws(() => foldCompactionControl(f.state, "context.compaction.started", {
        id: "stale", start: 0, end: 2, sourceHash: "a".repeat(64), status: "pending", attempts: 0,
      }), /Invalid compaction transaction source/u);
      assert.equal(prefixHash(f.state, 2).length, 64);
    } finally { f.dispose(); }
  });

  it("shares the main model-request budget and switches back to the normal capability envelope", async () => {
    const f = fixture();
    try {
      let requests = 0;
      const raw = JSON.stringify(f.state.messages.slice(2));
      const runtime = new AgentRuntime({ provider: { name: "deepseek", model: "test", complete: async (request) => {
        requests += 1;
        if (requests === 1) {
          assert.deepEqual(request.tools?.map((t) => t.function.name), ["compact_context"]);
          return { message: candidate(5, "Continue safely") };
        }
        assert.equal(request.tools?.some((t) => t.function.name === "compact_context"), false);
        assert.ok(request.messages.some((m) => m.role === "assistant" && m.reasoning_content === "keep this exactly"));
        assert.ok(request.messages.every((m) => m.role !== "assistant" || !m.tool_calls?.some((c) => c.id === "compact_candidate")));
        return { message: { role: "assistant", content: "done" } };
      } }, tools: [compactTool], contextManager: f.manager, appendEvent: f.append,
      buildSystemPrompt: async () => "rules", getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [], requestApproval: async () => false });
      const result = await runtime.run(f.state, "Continue safely", { ...options, maxSteps: 2 });
      assert.equal(result.reason, "success", result.text);
      assert.equal(requests, 2);
      assert.equal(f.state.compactedMessageCount, 2);
      assert.equal(JSON.stringify(f.state.messages.slice(2, 5)), raw);
      assert.equal(f.store.recover(f.state.threadId).compactedMessageCount, 2);
    } finally { f.dispose(); }
  });
});

describe("provider-neutral token calibration", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "estimate this input ".repeat(500) }];
  it("uses total prompt usage once, persists estimates and isolates model/endpoint identities", () => {
    const f = fixture();
    try {
      const baseline = requestTokens(messages);
      const first = new TokenCalibration("endpoint/model-a", f.storage);
      first.observe(messages, [], { promptTokens: baseline * 2, cachedInputTokens: baseline, reasoningTokens: 9000 });
      assert.equal(first.estimate(messages), Math.ceil(baseline * 2.2));
      assert.equal(new TokenCalibration("endpoint/model-a", f.storage).estimate(messages), first.estimate(messages));
      assert.equal(new TokenCalibration("endpoint/model-b", f.storage).estimate(messages), baseline);
      assert.equal(new TokenCalibration("other-endpoint/model-a", f.storage).estimate(messages), baseline);
      assert.equal(f.storage.db.prepare<[], { count: number }>("SELECT count(*) AS count FROM context_token_samples").get()!.count, 1);
    } finally { f.dispose(); }
  });

  it("ignores missing/invalid usage and bounds sample retention without modifying source messages", () => {
    const f = fixture();
    try {
      const calibration = new TokenCalibration("bounded", f.storage);
      const raw = JSON.stringify(messages);
      for (const usage of [undefined, {}, { promptTokens: -1 }, { promptTokens: NaN }, { promptTokens: 0 }]) calibration.observe(messages, [], usage);
      assert.equal(calibration.estimate(messages), requestTokens(messages));
      for (let n = 0; n < 50; n += 1) calibration.observe(messages, [], { promptTokens: 1000 });
      assert.equal(f.storage.db.prepare<[], { count: number }>("SELECT count(*) AS count FROM context_token_samples").get()!.count, 32);
      assert.equal(JSON.stringify(messages), raw);
    } finally { f.dispose(); }
  });

  it("reserves future tools as well as output and safety at the final request guard", () => {
    const budget = tokenBudget(32_000);
    assert.throws(() => budgetedRequest({ messages, tools: [] }, budget,
      () => budget.inputCapacity + 1), /context_capacity_insufficient/u);
    assert.equal(budgetedRequest({ messages, tools: [] }, budget,
      () => budget.inputCapacity).maxTokens, budget.outputReserve);
  });
});
