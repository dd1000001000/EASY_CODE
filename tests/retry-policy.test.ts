import { snapshotToolSet } from "../src/tools/catalog.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import type { ModelProvider, ModelRequest, ProviderResponse, SessionState, ToolExecutionResult } from "../src/core/types.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { completeWithApiRetries, markRetryManaged, incompleteModelOutput } from "../src/runtime/model-retry.js";
import { ProviderError } from "../src/providers/errors.js";
import { TaskBudget } from "../src/runtime/task-budget.js";
import { CommandRetryTracker } from "../src/runtime/command-retry.js";
import { requestSummaryWithCorrections, projectSummary } from "../src/context/summary-output.js";
import { resetServerContext, resetRequestHistory } from "../src/context/server-reset.js";
import { shortTermMessages, ContextManager } from "../src/context/manager.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { normalizeToolFailure } from "../src/tools/errors.js";

const request: ModelRequest = { messages: [{ role: "system", content: "policy" }, { role: "user", content: "fix this" }] };
const ok: ProviderResponse = { message: { role: "assistant", content: "done" }, usage: { totalTokens: 2 } };
const apiFailure = () => new ProviderError("temporary API failure", { provider: "glm", code: "http_error", statusCode: 503, retryable: true, retryAfterMs: 0 });
const capacityFailure = () => new ProviderError("maximum context length exceeded", { provider: "glm", code: "context_length_exceeded", statusCode: 400 });
function provider(complete: ModelProvider["complete"]): ModelProvider { return { name: "glm", model: "test", complete }; }
function state(): SessionState { return { threadId: "retry", workspaceRoot: process.cwd(), mode: "code", provider: "glm", model: "test",
  thinkingEffort: "none", messages: [], constraints: [], filesRead: new Map(), changes: [], commands: [], commandApprovalPrefixes: [],
  workingSummary: "", compactedMessageCount: 0, createdAt: "now", updatedAt: "now" }; }
const runOptions = { maxSteps: 10, maxContextChars: 200000, maxOutputChars: 8000, commandTimeoutMs: 1000, approvalPolicy: "never" as const };
function runtime(p: ModelProvider, extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {}) {
  return new AgentRuntime({ provider: p, toolCatalog: snapshotToolSet([]), contextManager: new ContextManager(), limits: defaultRuntimeLimits(),
    buildSystemPrompt: async () => "rules", getWorkspaceSummary: async () => "", searchMemories: async () => [],
    requestApproval: async () => false, appendEvent: async () => {}, ...extra });
}

describe("shared retry policy", () => {
  it("permits exactly five API retries and debits every physical attempt once", async () => {
    const budget = new TaskBudget(100, 0); let calls = 0; const events: number[] = [];
    await assert.rejects(completeWithApiRetries(provider(async r => { calls++; assert.equal(r.maxRetries, 0); throw apiFailure(); }), request,
      { reserve: r => budget.reserve(r), sleep: async () => {}, onSettled: a => { events.push(a.attempt); } }), /temporary API/);
    assert.equal(calls, 6); assert.equal(budget.snapshot().requests, 6); assert.deepEqual(events, [1, 2, 3, 4, 5, 6]);
  });
  it("does not multiply retry counts when auxiliary callers receive an owned provider", async () => {
    let calls = 0;
    const raw = provider(async () => { if (++calls < 6) throw apiFailure(); return ok; });
    const owned = provider(r => completeWithApiRetries(raw, r, { sleep: async () => {} })); markRetryManaged(owned);
    assert.equal(await completeWithApiRetries(owned, request, { reserve: () => { throw Error("duplicate debit"); } }), ok);
    assert.equal(calls, 6);
  });
  it("configuration and shared budget can shorten API retry allowance", async () => {
    for (const limit of [0, 1, 2]) {
      let calls = 0;
      await assert.rejects(completeWithApiRetries(provider(async () => { calls++; throw apiFailure(); }), request,
        { limits: { ...defaultRuntimeLimits(), maxProviderRetries: limit }, sleep: async () => {} }));
      assert.equal(calls, limit + 1);
    }
    let calls = 0; const budget = new TaskBudget(2, 0);
    await assert.rejects(completeWithApiRetries(provider(async () => { calls++; throw apiFailure(); }), request,
      { reserve: r => budget.reserve(r), sleep: async () => {} }), /task_budget_exhausted/);
    assert.equal(calls, 2);
  });
  it("does not retry cancellation, permanent API errors, or journal callback failures", async () => {
    const controller = new AbortController(); let calls = 0;
    await assert.rejects(completeWithApiRetries(provider(async () => { calls++; controller.abort(); throw apiFailure(); }),
      { ...request, signal: controller.signal })); assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(completeWithApiRetries(provider(async () => { calls++; throw new ProviderError("invalid key", { provider: "glm", code: "http_error", statusCode: 401 }); }), request));
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(completeWithApiRetries(provider(async () => { calls++; return ok; }), request,
      { onSettled: () => { throw apiFailure(); } })); assert.equal(calls, 1);
  });
  it("separates server capacity reset from the five-retry transport counter", async () => {
    let calls = 0, resets = 0;
    const full: ModelRequest = { messages: [...request.messages, { role: "assistant", content: "OLD_HISTORY" }] };
    await assert.rejects(completeWithApiRetries(provider(async r => {
      calls++; if (calls > 1) assert.ok(!JSON.stringify(r.messages).includes("OLD_HISTORY")); throw capacityFailure();
    }), full, { resetContext: async r => { resets++; return resetRequestHistory(r); } }), /context length/);
    assert.equal(calls, 2); assert.equal(resets, 1);
  });
  it("requires summary envelopes for three attempts, then preserves raw body without more model calls", async () => {
    let calls = 0;
    const raw = "<analysis>unclosed body scratch " + "中".repeat(10000);
    const result = await requestSummaryWithCorrections(async (attempt, feedback) => {
      calls++; if (attempt > 1) assert.match(feedback!, /outer <summary>/); return raw;
    });
    assert.equal(calls, 3); assert.equal(result.raw, true); assert.equal(result.text, raw);
    assert.equal(projectSummary(result.text!, "test").truncated, true);
    calls = 0;
    const corrected = await requestSummaryWithCorrections(async () => ++calls < 3 ? "missing tags" : "<analysis>scratch</analysis><summary>formal</summary>");
    assert.equal(calls, 3); assert.equal(corrected.text, "formal"); assert.equal(corrected.raw, false);
    const single = await requestSummaryWithCorrections(async () => "raw", { ...defaultRuntimeLimits(), modelContentRetries: 0 });
    assert.equal(single.attempts, 1);
  });
  it("empty or truncated normal responses never masquerade as successful completion", async () => {
    for (const response of [{ message: { role: "assistant" as const, content: "", reasoning_content: "thinking" } },
      { message: { role: "assistant" as const, content: "half answer" }, finishReason: "length" }]) {
      let calls = 0; const result = await runtime(provider(async () => { calls++; return response; })).run(state(), "work", runOptions);
      assert.equal(result.reason, "failed"); assert.equal(calls, 3); assert.ok(incompleteModelOutput(response));
    }
  });
  it("does not give a premature final answer an automatic continuation", async () => {
    for (const mode of ["plan", "background", "children"] as const) {
      const s = state(); if (mode === "plan") s.mode = "plan";
      let calls = 0;
      const result = await runtime(provider(async () => { calls++; return ok; }), {
        hasOpenCommandHandles: () => mode === "background",
        getOutstandingSubagents: () => mode === "children" ? [{ agentId: "child", status: "running" } as any] : [],
      }).run(s, "work", runOptions);
      assert.equal(calls, 1); assert.equal(result.reason, "failed");
    }
  });
  it("never dispatches a tool attached to truncated output and durably closes its protocol", async () => {
    let calls = 0, executions = 0; const events: string[] = []; const current = state();
    const result = await runtime(provider(async () => { calls++; return { finishReason: "length", message: { role: "assistant", content: null,
      tool_calls: [{ id: `half_${calls}`, type: "function", function: { name: "run_command", arguments: '{"program":"node"}' } }] } }; }), {
      toolCatalog: snapshotToolSet([{ name: "run_command", mutating: true, definition: { type: "function", function: { name: "run_command", description: "run", parameters: {} } },
        execute: async () => { executions++; return { ok: true, summary: "ran" }; } }]),
      appendEvent: async event => { events.push(event.type); },
    }).run(current, "run", runOptions);
    assert.equal(result.reason, "failed"); assert.equal(calls, 3); assert.equal(executions, 0);
    assert.equal(events.filter(e => e === "tool.result").length, 3);
    assert.equal(current.messages.filter(m => m.role === "tool").length, 3);
  });
  it("server reset is replayable, retains requirements, and does not erase execution facts", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "easy-code-reset-")); const storage = createStorage(dir); const store = new ThreadStore(storage);
    try {
      const created = store.create({ threadId: "reset-test", workspaceRoot: dir, mode: "code", provider: "glm", model: "mock", thinkingEffort: "none" });
      store.appendEvent(created.threadId, { type: "message.user", turnId: "turn", payload: { content: "Keep API compatibility" } });
      store.recordMessage(created.threadId, { role: "assistant", content: "OLD_RESULT", reasoning_content: "OLD_THINKING" }, "turn");
      const s = store.recover(created.threadId); s.constraints.push("offline"); s.filesRead.set("x", { path: "x", hash: "abc", readAt: new Date().toISOString() });
      const before = JSON.stringify(s.messages);
      await resetServerContext(s, "turn", async e => store.appendEvent(s.threadId, e));
      assert.equal(JSON.stringify(s.messages), before); assert.deepEqual(s.constraints, ["offline"]); assert.equal(s.filesRead.size, 1);
      assert.deepEqual(shortTermMessages(s), [{ role: "user", content: "Keep API compatibility" }]);
      store.save(s);
      const replay = store.recover(s.threadId); assert.deepEqual(shortTermMessages(replay), shortTermMessages(s));
      assert.equal(replay.pressureRecovery?.serverReset?.scope, "turn");
    } finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("a main Runtime capacity retry uses cleared history and does not clear it again on failure", async () => {
    let calls = 0; const s = state(); s.messages.push({ role: "assistant", content: "old assistant result" });
    const result = await runtime(provider(async r => {
      if (++calls === 1) throw capacityFailure();
      assert.doesNotMatch(JSON.stringify(r.messages), /old assistant result/); return ok;
    })).run(s, "new user requirement", runOptions);
    assert.equal(calls, 2); assert.equal(result.reason, "failed"); assert.match(result.text, /reconciliation/);
    assert.ok(s.pressureRecovery?.serverReset);
  });
});

describe("commands are never automatically replayed", () => {
  const command = { program: "python", args: ["test.py"], cwd: "." };
  function sandbox(id: string, execution = "not_started"): ToolExecutionResult {
    return { ok: false, summary: "sandbox failed", data: { commandId: id, status: "sandbox_unavailable",
      lifecycle: { execution }, sandboxFailure: { phase: "initialization", retryable: true } } };
  }
  it("permits one model-authored startup retry for the same proven-not-started command", () => {
    const tracker = new CommandRetryTracker(1);
    assert.equal(tracker.before("run_command", command), undefined);
    assert.equal(tracker.after("run_command", command, sandbox("first")).failure, undefined);
    assert.equal(tracker.before("run_command", command), undefined);
    assert.equal(tracker.after("run_command", command, sandbox("second")).failure?.recovery, "none");
    assert.equal(tracker.before("run_command", command)?.failure?.execution, "not_started");
    assert.equal(tracker.before("run_command", { ...command, args: ["other.py"] }), undefined);
  });
  it("attributes terminal polls once to the original command", () => {
    const tracker = new CommandRetryTracker(1);
    tracker.after("start_command", command, { ok: true, summary: "started", data: { commandId: "handle", status: "running" } });
    tracker.after("poll_command", { commandId: "handle" }, sandbox("handle"));
    tracker.after("poll_command", { commandId: "handle" }, sandbox("handle"));
    assert.equal(tracker.before("start_command", command), undefined);
    tracker.after("start_command", command, sandbox("retry"));
    assert.equal(tracker.before("start_command", command)?.failure?.recovery, "none");
  });
  it("never treats unknown execution as a retryable unstarted command", () => {
    const tracker = new CommandRetryTracker(1);
    assert.equal(tracker.after("run_command", command, sandbox("unknown", "unknown")).failure?.execution, "unknown");
    assert.equal(tracker.before("run_command", command)?.failure?.execution, "unknown");
    const normalized = normalizeToolFailure({ ok: false, summary: "unknown", data: { lifecycle: { execution: "unknown" },
      failure: { kind: "sandbox", code: "unknown", processStarted: false } } });
    assert.equal(normalized.failure?.execution, "unknown");
  });
  it("nonzero exits, timeout and cancellation are returned untouched, not replayed", () => {
    const tracker = new CommandRetryTracker(1);
    for (const status of ["exited", "timed_out", "canceled", "spawn_failed"]) {
      const result = { ok: false, summary: status, data: { status, exitCode: 1 } };
      assert.equal(tracker.after("run_command", command, result), result);
    }
    assert.equal(new CommandRetryTracker(0).after("run_command", command, sandbox("none")).failure?.recovery, "none");
  });
});
