import { snapshotToolSet } from "../src/tools/catalog.js";
import { ProviderError } from "../src/providers/errors.js";
import { assessCapacity } from "../src/context/capacity.js";
import { estimatedTokens } from "../src/context/token-budget.js";
import { pressureProjectedMessages } from "../src/context/pressure-projection.js";
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
import { recordUserRequirement } from "../src/context/user-requirements.js";

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
    if (m.role === "user") recordUserRequirement(state, state.messages.length - 1);
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


describe("bounded context degradation", () => {
  const largeEnvelope = { systemPrompt: "rules", runtimeContext: "", tools: [{
    type: "function" as const, function: { name: "read_file" as const, description: "schema".repeat(3500), parameters: { type: "object" } },
  }] };
  it("clears a safe explicit no-op request durably instead of bypassing cooldown forever", async () => {
    const f = fixture(0, false);
    try {
      f.message({ role: "user", content: "Answer a small question" });
      f.message({ role: "assistant", content: "Only one short exchange" });
      const payload = { patch: semantic };
      await f.append({ threadId: f.state.threadId, type: "context.compaction.requested", payload });
      foldCompactionControl(f.state, "context.compaction.requested", payload);
      const result = await f.run({ complete: async () => { throw new Error("No eligible prefix"); } });
      assert.equal(result.requests, 0);
      assert.equal(result.paused, undefined);
      assert.equal(f.state.compactionControl?.requested, false);
      assert.equal(f.state.compactionControl?.seed, undefined);
      const resumed = f.store.recover(f.state.threadId);
      assert.equal(resumed.compactionControl?.requested, false);
      assert.equal(resumed.compactionControl?.seed, undefined);
      assert.deepEqual(await f.run({ state: resumed }), { requests: 0, committed: false });
    } finally { f.dispose(); }
  });

  it("a cached maintenance decision cannot bypass an incomplete tool exchange on Resume", async () => {
    const f = fixture(0, false);
    try {
      f.message({ role: "user", content: "Inspect the parser" });
      f.message({ role: "assistant", content: null, tool_calls: [{ id: "unanswered", type: "function",
        function: { name: "read_file", arguments: "{}" } }] });
      const result = await f.run({ complete: async () => { throw new Error("Do not dispatch"); } });
      assert.equal(result.paused?.code, "context_capacity_exhausted");
      assert.equal(result.requests, 0);
      const again = await f.run({ state: structuredClone(f.state), complete: async () => { throw new Error("Do not dispatch"); } });
      assert.equal(again.paused?.code, "context_capacity_exhausted");
      assert.equal(again.requests, 0);
      assert.equal(f.state.messages.length, 2);
    } finally { f.dispose(); }
  });

  it("uses three malformed summary attempts then local recovery", async () => {
    const f = fixture(6, false, false, 1000, 8000);
    try {
      let requests = 0;
      const result = await f.run({ nextRequest: largeEnvelope, complete: async () => {
        requests++; return { role: "assistant", content: null, tool_calls: [{ id: "bad_summary", type: "function",
          function: { name: "compact_context", arguments: "{incomplete" } }] };
      } });
      assert.equal(requests, 3);
      assert.equal(result.committed, true);
      assert.equal(result.paused, undefined);
      assert.equal(JSON.parse(f.state.workingSummary).mode, "history_evicted");
      assert.equal(f.state.compactionControl?.transaction?.attempts, 3);
      assert.equal(f.state.compactionControl?.transaction?.status, "superseded");
      const again = await f.run({ state: f.store.recover(f.state.threadId), nextRequest: largeEnvelope,
        complete: async () => { throw new Error("duplicate request"); } });
      assert.deepEqual(again, { requests: 0, committed: false });
    } finally { f.dispose(); }
  });

  it("auxiliary provider errors fall back locally instead of failing the agent", async () => {
    const f = fixture(6, false, false, 1000, 8000);
    try {
      let requests = 0;
      const result = await f.run({ nextRequest: largeEnvelope, complete: async () => {
        requests++; throw new ProviderError("busy", { provider: "deepseek", code: "429", statusCode: 429, retryable: true });
      } });
      assert.equal(requests, 1);
      assert.equal(result.committed, true);
      assert.equal(result.paused, undefined);
      assert.equal(f.state.compactionControl?.transaction?.attempts, 1);
    } finally { f.dispose(); }
  });

  it("does not swallow user cancellation or spend a summary call after abort", async () => {
    const f = fixture(6, false);
    try {
      const controller = new AbortController();
      controller.abort(new Error("user cancelled"));
      await assert.rejects(f.run({ signal: controller.signal }), /user cancelled/);
      assert.equal(f.events.length, 0);
    } finally { f.dispose(); }
  });

  it("a durable dispatched attempt cannot be spent again after a crash", async () => {
    const f = fixture(6, false, false, 1000, 8000);
    try {
      await assert.rejects(f.run({ nextRequest: largeEnvelope, append: async (event) => {
        await f.append(event);
        if (event.type === "context.compaction.attempt") throw new Error("dispatch crash");
      } }), /dispatch crash/);
      const resumed = f.store.recover(f.state.threadId);
      assert.equal(resumed.compactionControl?.transaction?.attempts, 1);
      const result = await f.run({ state: resumed, nextRequest: largeEnvelope,
        complete: async () => { throw new Error("must not redispatch"); } });
      assert.equal(result.requests, 0);
      assert.equal(result.paused, undefined);
      assert.equal(f.events.filter((e) => e.type === "context.compaction.attempt").length, 1);
    } finally { f.dispose(); }
  });

  it("accepts a safe summary above the soft target and never resummarizes unchanged history", async () => {
    const f = fixture(6, false, false, 100, 6500);
    try {
      const nextRequest = { systemPrompt: "s".repeat(40000), runtimeContext: "", tools: [] };
      const result = await f.run({ nextRequest });
      assert.equal(result.requests, 1);
      assert.equal(result.committed, true);
      const capacity = assessCapacity(f.manager, f.state, 100000, nextRequest);
      assert.ok(capacity.utilization > 0.55);
      assert.equal(capacity.fits, true);
      assert.equal((await f.run({ nextRequest, complete: async () => { throw new Error("repeat"); } })).requests, 0);
    } finally { f.dispose(); }
  });

  it("uses token capacity rather than treating a character limit as a second token window", async () => {
    const f = fixture(3, true, false, 100, 1000);
    try {
      const nextRequest = { systemPrompt: "s".repeat(6000), runtimeContext: "", tools: [] };
      const capacity = assessCapacity(f.manager, f.state, 4096, nextRequest);
      assert.equal(capacity.fits, true);
      assert.equal(capacity.unit, "tokens");
      assert.equal(f.manager.build({ state: f.state, ...nextRequest, maxContextChars: 4096 })[0]?.content, nextRequest.systemPrompt);
    } finally { f.dispose(); }
  });

  it("does not pay for another summary after tiny growth above the soft trigger", async () => {
    // Leave room for the full normal system plus the handoff tail, while the
    // retained post-summary history still remains above the soft trigger.
    const f = fixture(6, false, false, 100, 5000);
    try {
      const nextRequest = { systemPrompt: "s".repeat(50000), runtimeContext: "", tools: [] };
      assert.equal((await f.run({ nextRequest })).requests, 1);
      assert.ok(assessCapacity(f.manager, f.state, 100000, nextRequest).utilization >= 0.8);
      f.message({ role: "assistant", content: "Still investigating", reasoning_content: "a small new observation" });
      const result = await f.run({ nextRequest, complete: async () => { throw new Error("thrashing"); } });
      assert.deepEqual(result, { requests: 0, committed: false });
    } finally { f.dispose(); }
  });

  it("discards a stale summary when user steering arrives without a second summary call", async () => {
    const f = fixture(6, false, false, 1000, 8000);
    try {
      const result = await f.run({ nextRequest: largeEnvelope, complete: async () => {
        f.message({ role: "user", content: "Preserve the public API while fixing the parser" });
        f.state.contextIntentLedger = f.store.recover(f.state.threadId).contextIntentLedger;
        f.state.goal = "Preserve the public API while fixing the parser";
        return candidate();
      } });
      assert.equal(result.requests, 1);
      assert.equal(result.paused, undefined);
      assert.match(f.state.contextIntentLedger?.latestRequest.text ?? "", /Preserve the public API/);
      assert.ok(f.state.messages.some((m) => m.role === "user" && m.content.includes("Preserve the public API")));
      assert.equal(f.events.filter((e) => e.type === "context.compaction.attempt").length, 1);
      assert.deepEqual(f.store.recover(f.state.threadId).pressureRecovery, f.state.pressureRecovery);
    } finally { f.dispose(); }
  });

  it("counts normal tool definitions when deciding whether any handoff can fit", async () => {
    const f = fixture(3, false, false, 100, 1000);
    try {
      let calls = 0;
      const result = await f.run({ maxContextChars: 12000, nextRequest: largeEnvelope,
        complete: async () => { calls++; return candidate(); } });
      assert.equal(calls, 0);
      assert.equal(result.paused?.code, "context_capacity_exhausted");
      assert.ok(result.paused!.usage > result.paused!.capacity);
      assert.equal(f.state.compactedMessageCount, f.state.messages.length);
      assert.ok(f.state.pressureRecovery?.serverReset);
    } finally { f.dispose(); }
  });

  it("shares a tool body budget across a multi-call batch, including individually small results", async () => {
    const f = fixture(0, false);
    try {
      f.message({ role: "user", content: "Read sources" });
      f.message({ role: "assistant", content: null, reasoning_content: "keep reasoning",
        tool_calls: Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, type: "function" as const,
          function: { name: "read_file", arguments: "{}" } })) });
      for (let i = 0; i < 8; i++) f.message({ role: "tool", name: "read_file", tool_call_id: `b${i}`, content: "x".repeat(2000) });
      Object.assign(f.state, f.store.recover(f.state.threadId));
      const raw = JSON.stringify(f.state.messages);
      const result = await f.run({ required: false, limits: { ...defaultRuntimeLimits(), contextToolBatchTokens: 3000 },
        complete: async () => { throw new Error("no model needed"); } });
      assert.equal(result.requests, 0);
      assert.equal(result.committed, true);
      const projected = pressureProjectedMessages(f.state);
      assert.ok(projected.filter((m) => m.role === "tool").reduce((sum, m) => sum + estimatedTokens(m.content ?? ""), 0) <= 3000);
      assert.equal(completeExchange(projected), true);
      assert.equal(JSON.stringify(f.state.messages), raw);
      assert.deepEqual(f.store.recover(f.state.threadId).pressureRecovery, f.state.pressureRecovery);
    } finally { f.dispose(); }
  });

  it("can rebase only once for the same user request, including after checkpoint/Resume", async () => {
    const f = fixture(1, false, false, 100, 100000);
    try {
      assert.equal((await f.run({ maxContextChars: 30000 })).committed, true);
      const firstRebase = structuredClone(f.state.pressureRecovery?.rebase);
      f.store.save(f.state);
      Object.assign(f.state, f.store.recover(f.state.threadId));
      f.message({ role: "assistant", content: null, reasoning_content: "r".repeat(100000),
        tool_calls: [{ id: "again", type: "function", function: { name: "read_file", arguments: "{}" } }] });
      f.message({ role: "tool", name: "read_file", tool_call_id: "again", content: "small" });
      const raw = JSON.stringify(f.state.messages);
      const result = await f.run({ maxContextChars: 30000 });
      assert.equal(result.paused, undefined);
      assert.ok(f.state.pressureRecovery?.serverReset);
      assert.deepEqual(f.state.pressureRecovery?.rebase, firstRebase);
      assert.equal(JSON.stringify(f.state.messages), raw);
      const resumed = f.store.recover(f.state.threadId);
      assert.deepEqual(resumed.pressureRecovery, f.state.pressureRecovery);
      const again = await f.run({ state: resumed, maxContextChars: 30000 });
      assert.deepEqual(again.paused, result.paused);
      assert.equal(again.requests, 0);
    } finally { f.dispose(); }
  });

  it("preserves a committed minimal rebase when a crash occurs before the in-memory fold", async () => {
    const f = fixture(1, false, false, 100, 100000);
    try {
      await assert.rejects(f.run({ maxContextChars: 30000, append: async (event) => {
        await f.append(event);
        if ((event.payload as { mode?: string }).mode === "minimal_rebase") throw new Error("rebase commit crash");
      } }), /rebase commit crash/);
      const resumed = f.store.recover(f.state.threadId);
      assert.equal(resumed.compactedMessageCount, resumed.messages.length);
      assert.equal(resumed.pressureRecovery?.rebase?.count, 1);
      assert.equal(JSON.parse(resumed.workingSummary).mode, "minimal_rebase");
      assert.equal((await f.run({ state: resumed, maxContextChars: 30000 })).requests, 0);
    } finally { f.dispose(); }
  });

  it("does not erase an oversized user requirement to manufacture a fit", async () => {
    const f = fixture(0, false);
    try {
      const request = "must preserve ".repeat(10000);
      f.message({ role: "user", content: request });
      const result = await f.run({ maxContextChars: 30000 });
      assert.equal(result.paused?.code, "context_capacity_exhausted");
      assert.equal(result.requests, 0);
      assert.equal(f.state.messages[0]?.content, request);
      assert.equal(f.state.compactedMessageCount, f.state.messages.length);
      assert.equal(f.state.pressureRecovery?.serverReset?.requirementIndices[0], 0);
    } finally { f.dispose(); }
  });

  it("minimal rebase keeps pending commands and reviewer experiment budgets", async () => {
    const f = fixture(1, false, false, 100, 100000);
    try {
      f.state.progressGuard = createProgressGuardState();
      f.state.progressGuard.incidents.push({ incidentId: "review", phase: "experiment_pending", reviewAttempts: 1,
        experiment: { instruction: "Compare parser branches" } } as never);
      f.state.contextOperations = { commands: { job: { commandId: "job", program: "pytest", args: ["test.py"],
        cwd: f.state.workspaceRoot, status: "running", exitCode: null } }, children: {}, knownCommandIds: ["job"] };
      const facts = runtimeContinuityMessage(f.state);
      const result = await f.run({ maxContextChars: 30000, append: async () => undefined });
      assert.equal(result.committed, true);
      assert.equal(f.state.contextOperations.commands.job?.commandId, "job");
      assert.match(runtimeContinuityMessage(f.state), /Compare parser branches/);
      assert.equal(f.state.progressGuard.incidents[0]?.reviewAttempts, 1);
      assert.match(facts, /poll_command/);
    } finally { f.dispose(); }
  });

  const options = { maxSteps: 4, maxContextChars: 30000, maxOutputChars: 8000, commandTimeoutMs: 1000, approvalPolicy: "never" as const };
  function runtime(f: ReturnType<typeof fixture>, complete: NonNullable<ConstructorParameters<typeof AgentRuntime>[0]>["provider"]["complete"],
    tools: AgentTool[] = [], system = "rules") {
    return new AgentRuntime({ provider: { name: "deepseek", model: "mock", complete }, toolCatalog: snapshotToolSet(tools),
      contextManager: f.manager, appendEvent: f.append, buildSystemPrompt: async () => system,
      getWorkspaceSummary: async () => "", searchMemories: async () => [], requestApproval: async () => false });
  }

  it("Runtime keeps working after a huge tool exchange even without a summary tool", async () => {
    const f = fixture(0, false);
    try {
      let calls = 0;
      const read: AgentTool = { name: "read_file", mutating: false, definition: { type: "function", function: {
        name: "read_file", description: "Read", parameters: { type: "object", properties: {} } } },
        execute: async () => ({ ok: true, summary: "read", data: "small" }) };
      const agent = runtime(f, async (request) => {
        calls++;
        if (calls === 1) return { message: { role: "assistant", content: null, reasoning_content: "r".repeat(100000),
          tool_calls: [{ id: "read", type: "function", function: { name: "read_file", arguments: "{}" } }] } };
        assert.ok(!request.messages.some((m) => m.role === "assistant" && m.reasoning_content?.length === 100000));
        assert.ok(request.messages.some((m) => m.content?.includes("Inspect parser")));
        return { message: { role: "assistant", content: "The evidence is available; continue the parser investigation." } };
      }, [read]);
      const result = await agent.run(f.state, "Inspect parser", options);
      assert.equal(result.reason, "success", result.text);
      assert.equal(calls, 2);
      assert.equal(f.state.pressureRecovery?.rebase?.count, 1);
      assert.equal(f.state.messages.find((m) => m.role === "assistant" && m.reasoning_content)?.role, "assistant");
      assert.deepEqual(f.store.recover(f.state.threadId).pressureRecovery, f.state.pressureRecovery);
    } finally { f.dispose(); }
  });

  it("Runtime pauses gracefully when mandatory system instructions alone cannot fit", async () => {
    const f = fixture(0, false);
    try {
      let calls = 0;
      const result = await runtime(f, async () => { calls++; throw new Error("must not dispatch"); }, [], "s".repeat(100000))
        .run(f.state, "Inspect parser", options);
      assert.equal(result.reason, "limit_reached", result.text);
      assert.equal(result.failure?.code, "context_capacity_exhausted");
      assert.doesNotMatch(result.text, /Agent run failed/);
      assert.equal(calls, 0);
      assert.ok(f.events.some((e) => e.type === "turn.completed" && (e.payload as { failure?: { code: string } }).failure?.code === "context_capacity_exhausted"));
    } finally { f.dispose(); }
  });

  it("a provider context rejection gets one smaller deterministic retry, not another summary", async () => {
    const f = fixture(3, false, false, 1000, 1000);
    try {
      let calls = 0, firstSize = 0;
      const result = await runtime(f, async (request) => {
        calls++;
        const size = JSON.stringify(request.messages).length;
        if (calls === 1) { firstSize = size; throw new ProviderError("maximum context length exceeded",
          { provider: "deepseek", code: "context_length_exceeded", statusCode: 400 }); }
        assert.ok(size < firstSize);
        if (calls === 2) return { message: { role: "assistant", content: null, tool_calls: [{ id: "reconcile", type: "function",
          function: { name: "read_file", arguments: "{}" } }] } };
        return { message: { role: "assistant", content: "Recovered" } };
      }, [{ name: "read_file", mutating: false, definition: { type: "function", function: { name: "read_file", description: "Read", parameters: {} } },
        execute: async () => ({ ok: true, summary: "Current source inspected" }) }]).run(f.state, "Continue parser investigation", options);
      assert.equal(result.reason, "success", result.text);
      assert.equal(calls, 3);
      assert.equal(f.events.filter((e) => e.type === "context.compaction.attempt").length, 0);
    } finally { f.dispose(); }
  });

  it("repeated provider capacity rejection stops with a recoverable capacity result", async () => {
    const f = fixture(3, false, false, 1000, 1000);
    try {
      let calls = 0;
      const result = await runtime(f, async () => { calls++; throw new ProviderError("prompt is too long",
        { provider: "deepseek", code: "context_length_exceeded", statusCode: 400 }); }).run(f.state, "Continue", options);
      assert.equal(result.reason, "limit_reached", result.text);
      assert.equal(result.failure?.code, "context_capacity_exhausted");
      assert.equal(calls, 2);
    } finally { f.dispose(); }
  });

  it("Auto routing reports remote capacity exhaustion as a recoverable pause", async () => {
    const f = fixture(0, false);
    try {
      f.state.mode = "auto";
      let calls = 0;
      const result = await runtime(f, async () => { calls++; throw new ProviderError("prompt is too long",
        { provider: "deepseek", code: "context_length_exceeded", statusCode: 400 }); })
        .run(f.state, "Answer a question", options);
      assert.equal(result.reason, "limit_reached", result.text);
      assert.equal(result.failure?.code, "context_capacity_exhausted");
      assert.doesNotMatch(result.text, /Agent run failed/);
      assert.equal(calls, 1); // already requirements-only: never resend an identical rejected request
    } finally { f.dispose(); }
  });

  it("ordinary authentication failures are not disguised as capacity recovery", async () => {
    const f = fixture(0, false);
    try {
      let calls = 0;
      const result = await runtime(f, async () => { calls++; throw new ProviderError("unauthorized",
        { provider: "deepseek", code: "invalid_api_key", statusCode: 401 }); }).run(f.state, "Continue", options);
      assert.equal(result.reason, "failed");
      assert.equal(result.failure?.code, undefined);
      assert.equal(calls, 1);
      assert.equal(f.events.filter((event) => event.type === "context.history.evicted").length, 0);
    } finally { f.dispose(); }
  });
});
