import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { parse as parseToml } from "toml";
import { ToolRecoveryBudget } from "../src/runtime/tool-recovery.js";
import os from "node:os";
import path from "node:path";
import { defaultRuntimeLimits, runtimeLimitsSchema } from "../src/config/runtime-limits.js";
import { loadEasyCodeConfig } from "../src/config/loader.js";
import { TaskBudget, TaskBudgetExceeded } from "../src/runtime/task-budget.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { ContextManager } from "../src/context/manager.js";
import { tokenBudget } from "../src/context/token-budget.js";
import { ProviderError } from "../src/providers/errors.js";
import type { SessionState, ToolContext, ToolExecutionResult } from "../src/core/types.js";
import { ManageTasksTool } from "../src/tools/manage-tasks.js";
import { ReadFileTool } from "../src/tools/read-file.js";
import { PollCommandTool } from "../src/tools/run-command.js";
import { projectToolResult } from "../src/tools/output-projection.js";
import type { CommandRuntime } from "../src/command/runtime.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { describe, it } from "./harness.js";

function state(): SessionState {
  return { threadId: "limits-test", mode: "code", provider: "qwen", model: "mock", thinkingEffort: "medium",
    workspaceRoot: process.cwd(), constraints: [], messages: [], filesRead: new Map(), changes: [], commands: [],
    commandApprovalPrefixes: [], workingSummary: "", compactedMessageCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
const options = { maxSteps: 4, maxContextChars: 250000, maxOutputChars: 16000, commandTimeoutMs: 1000, approvalPolicy: "never" as const };
const request = { messages: [{ role: "user" as const, content: "inspect" }], maxTokens: 100 };
const context = (root: string): ToolContext => ({ workspaceRoot: root, mode: "code", threadId: "thread", turnId: "turn",
  approvalPolicy: "never", commandTimeoutMs: 1000, maxOutputChars: 64000, requestApproval: async () => false,
  limits: defaultRuntimeLimits() });

describe("central runtime limits", () => {
  it("documents every shipped operational default and applies per-tool correction ceilings", async () => {
    const example = parseToml(await readFile(path.resolve("docs/config.example.toml"), "utf8")) as { limits: unknown };
    assert.deepEqual(JSON.parse(JSON.stringify(example.limits)), defaultRuntimeLimits());
    const budget = new ToolRecoveryBudget(3, { compact_context: 1 });
    assert.equal(budget.fail("compact_context").remaining, 0);
    assert.equal(budget.fail("propose_plan").remaining, 2);
  });
  it("uses 40/40/40/80 independently of concurrency and validates partial TOML overrides", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-limits-"));
    try {
      await mkdir(path.join(root, ".easycode"));
      await writeFile(path.join(root, ".easycode", "config.toml"),
        "orchestrationEnabled = true\n[limits]\nmaxTaskTokens = 90000\n[limits.steps]\nhigh = 60\n[limits.providerTimeoutMs]\nhigh = 10000\n[limits.maxConcurrentSubagents]\nmedium = 3\n");
      const config = await loadEasyCodeConfig({ workspaceRoot: root, configDir: path.join(root, "config"),
        dataDir: path.join(root, "data"), cacheDir: path.join(root, "cache"), env: {}, credentialStore: false });
      assert.deepEqual(defaultRuntimeLimits().steps, { none: 40, low: 40, medium: 40, high: 80 });
      assert.deepEqual(config.limits.steps, { none: 40, low: 40, medium: 40, high: 60 });
      assert.equal(config.limits.providerTimeoutMs.low, 300000);
      assert.equal(config.limits.providerTimeoutMs.high, 10000);
      assert.deepEqual(defaultRuntimeLimits().maxConcurrentSubagents, { none: 2, low: 2, medium: 4, high: 8 });
      assert.deepEqual(config.limits.maxConcurrentSubagents, { none: 2, low: 2, medium: 3, high: 8 });
      assert.equal(config.limits.maxTaskTokens, 90000);
      assert.equal(config.orchestrationEnabled, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("merges concurrency overrides across config layers and clones defaults", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-concurrency-limits-"));
    try {
      await mkdir(path.join(root, "config"));
      await mkdir(path.join(root, ".easycode"));
      await writeFile(path.join(root, "config", "config.toml"), "[limits.maxConcurrentSubagents]\nlow = 3\nmedium = 5\n");
      await writeFile(path.join(root, ".easycode", "config.toml"), "[limits.maxConcurrentSubagents]\nmedium = 6\n");
      const config = await loadEasyCodeConfig({ workspaceRoot: root, configDir: path.join(root, "config"),
        env: { EASY_CODE_LIMITS_JSON: '{"maxConcurrentSubagents":{"high":10}}' }, credentialStore: false });
      assert.deepEqual(config.limits.maxConcurrentSubagents, { none: 2, low: 3, medium: 6, high: 10 });
      const copy = defaultRuntimeLimits();
      copy.maxConcurrentSubagents.low = 7;
      assert.equal(defaultRuntimeLimits().maxConcurrentSubagents.low, 2);
      for (const invalid of [2, { ...copy.maxConcurrentSubagents, high: 0 },
        { ...copy.maxConcurrentSubagents, high: 17 }, { ...copy.maxConcurrentSubagents, high: 1.5 },
        { ...copy.maxConcurrentSubagents, typo: 3 }]) {
        assert.equal(runtimeLimitsSchema.safeParse({ ...copy, maxConcurrentSubagents: invalid }).success, false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects legacy/unknown limits instead of ignoring them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-limits-invalid-"));
    try {
      const load = (env: NodeJS.ProcessEnv = {}) => loadEasyCodeConfig({ workspaceRoot: root,
        configDir: path.join(root, "config"), env, credentialStore: false });
      await assert.rejects(load({ EASY_CODE_MAX_STEPS: "90" }), /Legacy limit environment/u);
      await assert.rejects(load({ EASY_CODE_LIMITS_JSON: '{"maxStep":90}' }), /Unrecognized key/u);
      await mkdir(path.join(root, ".easycode"));
      await writeFile(path.join(root, ".easycode", "config.toml"), "max_steps = 90\n");
      await assert.rejects(load(), /Legacy limit fields/u);
      assert.throws(() => runtimeLimitsSchema.parse({ ...defaultRuntimeLimits(), defaultReadLines: 10001 }));
      assert.throws(() => runtimeLimitsSchema.parse({ ...defaultRuntimeLimits(), defaultReadLines: 150, maxReadLines: 50 }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("enables headless orchestration explicitly without changing the ordinary default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-orchestration-env-"));
    try {
      const load = (env: NodeJS.ProcessEnv = {}) => loadEasyCodeConfig({ workspaceRoot: root,
        configDir: path.join(root, "config"), env, credentialStore: false });
      assert.equal((await load()).orchestrationEnabled, false);
      assert.equal((await load({ EASY_CODE_ORCHESTRATION_ENABLED: "true" })).orchestrationEnabled, true);
      await mkdir(path.join(root, ".easycode"));
      await writeFile(path.join(root, ".easycode", "config.toml"), "orchestrationEnabled = true\n");
      assert.equal((await load({ EASY_CODE_ORCHESTRATION_ENABLED: "false" })).orchestrationEnabled, false);
      await writeFile(path.join(root, ".easycode", "config.toml"), "orchestrationEnabled = false\n");
      const enabled = await load({ EASY_CODE_ORCHESTRATION_ENABLED: "true" });
      assert.equal(enabled.orchestrationEnabled, true);
      assert.deepEqual(enabled.limits, defaultRuntimeLimits());
      for (const value of ["yes", "1", "FALSE", "typo"]) {
        await assert.rejects(load({ EASY_CODE_ORCHESTRATION_ENABLED: value }), /must be true or false/u);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reserves shared tokens atomically and does not double-charge cache or reasoning", () => {
    const budget = new TaskBudget(2, 250);
    const settle = budget.reserve(request, () => 100);
    assert.throws(() => budget.reserve(request, () => 100), TaskBudgetExceeded);
    settle({ promptTokens: 50, completionTokens: 20, totalTokens: 70, cachedInputTokens: 30, reasoningTokens: 10 });
    settle();
    budget.reserve(request, () => 50)();
    assert.deepEqual(budget.snapshot(), { requests: 2, tokens: 220, reservedTokens: 0, maxRequests: 2, maxTokens: 250 });
    assert.throws(() => budget.reserve(request), /request limit/u);
  });

  it("uses configured context reserves without clipping active reasoning", () => {
    const limits = { ...defaultRuntimeLimits(), maxResponseTokens: 1024, contextToolReserveTokens: 512 };
    const capacity = tokenBudget(16000, limits);
    assert.equal(capacity.outputReserve, 1024);
    assert.equal(capacity.toolReserve, 512);
    assert.equal(capacity.safetyReserve, 800);
    assert.equal(capacity.inputCapacity, 13664);
    const manager = new ContextManager();
    manager.configureTokenBudget(undefined, { ...limits, maxActiveContextChars: 360000 });
    assert.equal(manager.inspect(state(), 400000).budgetChars, 360000);
  });

  it("keeps reserved debits across crashes and refuses dispatch when the journal cannot commit", () => {
    const snapshots: unknown[] = [];
    const before = new TaskBudget(3, 1000, (snapshot) => snapshots.push(snapshot));
    before.reserve(request, () => 50);
    const restored = TaskBudget.restore(snapshots.at(-1));
    assert.equal(restored.snapshot().requests, 1);
    assert.equal(restored.snapshot().tokens, 150);
    assert.equal(restored.snapshot().reservedTokens, 0);
    let writes = 0;
    const failing = new TaskBudget(2, 0, () => { if (++writes > 1) throw new Error("journal unavailable"); });
    assert.throws(() => failing.reserve(request), /journal unavailable/u);
    assert.equal(failing.snapshot().requests, 1);
    assert.throws(() => TaskBudget.restore({ maxRequests: -1 }));
  });

  it("hides orchestration tools and does not execute hallucinated creation calls", async () => {
    let calls = 0;
    const runtime = new AgentRuntime({ limits: defaultRuntimeLimits(), tools: [new ManageTasksTool()],
      contextManager: new ContextManager(), buildSystemPrompt: async () => "system", getWorkspaceSummary: async () => "",
      searchMemories: async () => [], appendEvent: async () => undefined, requestApproval: async () => false,
      provider: { name: "qwen", model: "mock", complete: async (input) => {
        assert.ok(!input.tools?.some((tool) => tool.function.name === "manage_tasks"));
        calls += 1;
        return { message: calls === 1 ? { role: "assistant", content: null,
          tool_calls: [{ id: "denied", type: "function", function: { name: "manage_tasks", arguments: '{"action":"create"}' } }] }
          : { role: "assistant", content: "Done." } };
      } } });
    const current = state();
    const result = await runtime.run(current, "Explain the code", { ...options, orchestrationEnabled: false });
    assert.equal(result.reason, "success");
    assert.equal(current.taskGraph, undefined);
    assert.equal(calls, 2);
  });

  it("charges transport retries against the same shared request limit", async () => {
    let calls = 0;
    const budget = new TaskBudget(1, 0);
    const runtime = new AgentRuntime({ limits: defaultRuntimeLimits(), taskBudget: budget, tools: [],
      contextManager: new ContextManager(), buildSystemPrompt: async () => "system", getWorkspaceSummary: async () => "",
      searchMemories: async () => [], appendEvent: async () => undefined, requestApproval: async () => false,
      provider: { name: "qwen", model: "mock", complete: async (input) => {
        calls += 1;
        assert.equal(input.maxRetries, 0);
        throw new ProviderError("busy", { provider: "qwen", code: "busy", retryable: true, retryAfterMs: 0 });
      } } });
    const result = await runtime.run(state(), "Inspect", options);
    assert.equal(calls, 1);
    assert.equal(result.reason, "limit_reached");
    assert.equal(result.failure?.code, "task_budget_exhausted");
  });

  it("persists the orchestration switch through checkpoint deltas and journal recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-toggle-"));
    const storage = createStorage(root);
    try {
      const store = new ThreadStore(storage);
      const current = store.create({ workspaceRoot: root, mode: "code", provider: "qwen", model: "mock" });
      current.orchestrationEnabled = true;
      store.save(current);
      assert.equal(store.recover(current.threadId).orchestrationEnabled, true);
      current.orchestrationEnabled = false;
      store.save(current);
      assert.equal(store.recover(current.threadId).orchestrationEnabled, false);
    } finally { storage.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("honors a configured provider retry limit of zero within the shared budget", async () => {
    let calls = 0;
    const budget = new TaskBudget(10, 0);
    const runtime = new AgentRuntime({ limits: defaultRuntimeLimits(), taskBudget: budget,
      providerRetryLimit: 0, tools: [], contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system", getWorkspaceSummary: async () => "",
      searchMemories: async () => [], appendEvent: async () => undefined, requestApproval: async () => false,
      provider: { name: "qwen", model: "mock", complete: async () => {
        calls += 1;
        throw new ProviderError("busy", { provider: "qwen", code: "busy", retryable: true, retryAfterMs: 0 });
      } } });
    const result = await runtime.run(state(), "Inspect", options);
    assert.equal(result.reason, "failed");
    assert.equal(calls, 1);
    assert.equal(budget.snapshot().requests, 1);
  });
});

describe("small model-facing tool results", () => {
  it("reads 100 lines by default and honors configured explicit-range limits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-read-window-"));
    try {
      await writeFile(path.join(root, "large.txt"), Array.from({ length: 700 }, (_, i) => String(i + 1)).join("\n"));
      const workspace = await WorkspaceManager.create(root);
      const tool = new ReadFileTool(workspace);
      const initial = await tool.execute({ path: "large.txt" }, context(root));
      assert.equal((initial.data as { endLine: number }).endLine, 100);
      const next = await tool.execute({ path: "large.txt", startLine: 151, endLine: 700 }, {
        ...context(root), limits: { ...defaultRuntimeLimits(), maxReadLines: 200 },
      });
      assert.equal((next.data as { endLine: number }).endLine, 350);
      assert.equal((next.data as { truncated: boolean }).truncated, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps real command identity/status and both failure ends without changing raw evidence", () => {
    const result: ToolExecutionResult = { ok: false, summary: "failed", evidenceId: "evidence_test", data: {
      commandId: "command_test", status: "exited", exitCode: 1,
      failure: { kind: "exit", processStarted: true },
      stdout: { text: "assertion A\n" + "x".repeat(30000) + "\nFAILED case_a", totalBytes: 30050, truncated: false },
      stderr: { text: "stack head\n" + "y".repeat(30000) + "\nstack tail", totalBytes: 30050, truncated: false },
    } };
    const original = JSON.stringify(result);
    const projected = projectToolResult(result);
    assert.equal(JSON.stringify(result), original);
    assert.ok(JSON.stringify(projected).length < 9000);
    assert.match(JSON.stringify(projected), /assertion A|FAILED case_a/u);
    assert.match(JSON.stringify(projected), /stack tail/u);
    assert.equal((projected.data as { exitCode: number }).exitCode, 1);
    assert.equal(projected.evidenceId, "evidence_test");
  });

  it("coalesces internal polls into one tool result and wakes on steering without cancellation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-wait-"));
    try {
      const workspace = await WorkspaceManager.create(root);
      let polls = 0;
      const output = { commandId: "command_00000000-0000-4000-8000-000000000001", status: "running", exitCode: null,
        stdout: { text: "" }, stderr: { text: "" }, policyDecision: {} };
      const runtime = { status: async (_id: string, _context: ToolContext, wait: number) => {
        assert.ok(wait > 0 && wait <= 30000);
        return { ...output, status: ++polls === 1 ? "running" : "exited", exitCode: 0 };
      } } as unknown as CommandRuntime;
      const tool = new PollCommandTool(workspace, runtime);
      assert.equal((await tool.execute({ commandId: output.commandId }, context(root))).ok, true);
      assert.equal(polls, 2);
      const steering = new AbortController();
      const waking = { status: async () => { steering.abort(); return output; } } as unknown as CommandRuntime;
      const result = await new PollCommandTool(workspace, waking).execute({ commandId: output.commandId },
        { ...context(root), waitSignal: steering.signal });
      assert.equal((result.data as { status: string }).status, "running");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
