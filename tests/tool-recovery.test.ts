import assert from "node:assert/strict";
import { z } from "zod";
import type { AgentTool, ModelProvider, SessionState, TaskNode, ToolExecutionResult } from "../src/core/types.js";
import { ContextManager } from "../src/context/manager.js";
import { AgentRuntime, type AgentRuntimeDependencies } from "../src/runtime/agent.js";
import { CompactContextTool } from "../src/tools/compact-context.js";
import { ProposePlanTool } from "../src/tools/propose-plan.js";
import { SubmitTaskResultTool } from "../src/tools/submit-task-result.js";
import { toolFailure } from "../src/tools/base.js";
import { normalizeToolFailure, prepareToolInput, toolResultForModel } from "../src/tools/errors.js";
import { deserializeSessionState, serializeSessionState } from "../src/threads/serialization.js";
import { compactionV2Input } from "./compaction-fixture.js";
import { describe, it } from "./harness.js";

const requestText = "网页端插件和vscode插件具体是怎么通信的";
const options = { maxSteps: 4, maxContextChars: 400_000, maxOutputChars: 1_024, commandTimeoutMs: 1_000, approvalPolicy: "never" as const };

function newState(pressure = false, mode: SessionState["mode"] = "code"): SessionState {
  return {
    threadId: "thread_recovery_test", mode, provider: "qwen", model: "mock", thinkingEffort: "medium",
    workspaceRoot: process.cwd(), constraints: [],
    messages: pressure ? [{ role: "user", content: "previous context " + "x".repeat(205_000) }] : [],
    filesRead: new Map(), changes: [], commands: [], commandApprovalPrefixes: [],
    workingSummary: "", compactedMessageCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

function toolCall(name: string, value: unknown, id: number): Awaited<ReturnType<ModelProvider["complete"]>> {
  return { message: { role: "assistant", content: null, reasoning_content: "keep current reasoning intact",
    tool_calls: [{ id: `call_${id}`, type: "function", function: { name, arguments: JSON.stringify(value) } }],
  } };
}

function fixture(current: SessionState) {
  const primary = current.contextIntentLedger?.latestRequest;
  assert.ok(primary);
  const latest = current.messages.length - 1 - [...current.messages].reverse().findIndex((message) => message.role === "user" && !message.content.startsWith("RUNTIME_"));
  return compactionV2Input({ primaryRequestIndex: primary.sourceMessageIndex, primaryRequestText: primary.text,
    latestMessageIndex: latest, userCorrections: current.contextIntentLedger?.userCorrections,
    supersededRequests: current.contextIntentLedger?.supersededRequests,
  });
}

function createRuntime(provider: ModelProvider, tools: AgentTool[], extra: Partial<AgentRuntimeDependencies> = {}) {
  return new AgentRuntime({
    provider, tools, contextManager: new ContextManager(), buildSystemPrompt: async () => "system",
    getWorkspaceSummary: async () => "workspace", searchMemories: async () => [],
    appendEvent: async () => undefined, requestApproval: async () => false, ...extra,
  });
}

describe("Runtime tool recovery", () => {
  it("repairs the reported two missing fields across two corrections without losing the candidate", async () => {
    const current = newState(true);
    const requests: Parameters<ModelProvider["complete"]>[0][] = [];
    const provider: ModelProvider = { name: "qwen", model: "mock", async complete(request) {
      requests.push(request);
      const attempt = requests.length;
      if (attempt === 4) return { message: { role: "assistant", content: "communication explained" } };
      const candidate = fixture(current);
      if (attempt < 3) delete (candidate.coverageCheck as Partial<typeof candidate.coverageCheck>).unresolvedErrorsPreserved;
      if (attempt === 1) delete (candidate as Partial<typeof candidate>).activeConstraints;
      if (attempt === 2) {
        const previous = [...request.messages].reverse().find((message) => message.role === "assistant" && message.tool_calls?.length);
        assert.ok(previous?.role === "assistant");
        const parsed = JSON.parse(previous.tool_calls![0]!.function.arguments);
        assert.equal(parsed.coverageCheck.latestRequestPreserved, true);
        assert.ok(parsed.intentLedger);
        assert.equal(previous.reasoning_content, "keep current reasoning intact");
      }
      if (attempt > 1) {
        const repair = request.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
        assert.match(repair, /RUNTIME_TOOL_REPAIR/);
        assert.match(repair, /coverageCheck.unresolvedErrorsPreserved/);
      }
      return toolCall("compact_context", candidate, attempt);
    } };
    const result = await createRuntime(provider, [new CompactContextTool()]).run(current, requestText, options);
    assert.equal(result.reason, "success", result.text);
    assert.equal(requests.length, 4);
    assert.ok(current.compactedMessageCount > 0);
    const summary = JSON.parse(current.workingSummary);
    assert.equal(summary.coverageCheck, undefined);
    assert.equal(summary.intentLedger, undefined);
    assert.ok(!JSON.stringify(requests[3]!.messages).includes("latestRequestPreserved"));
  });

  for (const mode of ["code", "auto"] as const) {
    it(`preserves failed ${mode} compaction and its error classification through checkpoint serialization`, async () => {
      const current = newState(true, mode);
      let calls = 0;
      const events: Array<{ type: string; payload: unknown }> = [];
      const provider: ModelProvider = { name: "qwen", model: "mock", async complete() {
        calls += 1;
        const candidate = fixture(current);
        delete (candidate.coverageCheck as Partial<typeof candidate.coverageCheck>).unresolvedErrorsPreserved;
        return toolCall("compact_context", candidate, calls);
      } };
      const result = await createRuntime(provider, [new CompactContextTool()], {
        appendEvent: async (event) => { events.push(event); },
      }).run(current, requestText, options);
      assert.equal(calls, 3);
      assert.equal(result.reason, "failed");
      assert.equal(result.failure?.code, "context_compaction_failed");
      assert.equal(result.failure?.recoverable, true);
      assert.equal(current.compactedMessageCount, 0);
      assert.equal(current.workingSummary, "");
      assert.equal(current.activeTurnId, undefined);
      assert.equal(([...events].reverse().find((event) => event.type === "turn.completed")?.payload as { failure?: { code: string } }).failure?.code, "context_compaction_failed");
      const restored = deserializeSessionState(serializeSessionState(current));
      const candidate = [...restored.messages].reverse().find((message) => message.role === "assistant" && message.tool_calls?.length);
      assert.ok(candidate?.role === "assistant");
      assert.ok(JSON.parse(candidate.tool_calls![0]!.function.arguments).coverageCheck);
      assert.ok(restored.messages.some((message) => message.role === "tool" && message.content.includes("unresolvedErrorsPreserved")));
      // An explicit new turn can retry from preserved evidence, not a fresh empty history.
      restored.mode = "code";
      let resumedCalls = 0;
      const resumed: ModelProvider = { name: "qwen", model: "mock", async complete() {
        resumedCalls += 1;
        return resumedCalls === 1 ? toolCall("compact_context", fixture(restored), 10)
          : { message: { role: "assistant", content: "resumed" } };
      } };
      const resumedResult = await createRuntime(resumed, [new CompactContextTool()]).run(restored, requestText, options);
      assert.equal(resumedResult.reason, "success", resumedResult.text);
    });
  }

  it("uses the same preflight and correction allowance for Plan submissions", async () => {
    const current = newState(false, "plan");
    let calls = 0;
    const provider: ModelProvider = { name: "qwen", model: "mock", async complete(request) {
      calls += 1;
      if (calls === 2) assert.match(JSON.stringify(request.messages), /steps.0.verification/);
      return toolCall("propose_plan", { title: "Communication", overview: "Inspect communication",
        steps: [{ title: "Trace", description: "Trace messages", ...(calls === 2 ? { verification: "Read both handlers" } : {}) }],
      }, calls);
    } };
    const result = await createRuntime(provider, [new ProposePlanTool()]).run(current, requestText, options);
    assert.equal(result.reason, "planned", result.text);
    assert.equal(calls, 2);
  });

  it("never executes invalid mutation arguments or automatically replays an unknown outcome", async () => {
    const current = newState();
    let executions = 0;
    const tool: AgentTool = { name: "update_file", mutating: true,
      inputSchema: z.object({ path: z.string(), expectedHash: z.string() }),
      definition: { type: "function", function: { name: "update_file", description: "edit", parameters: { type: "object" } } },
      async execute() { executions += 1; throw new Error("write completed but verification unavailable"); },
    };
    let calls = 0;
    const provider: ModelProvider = { name: "qwen", model: "mock", async complete(request) {
      calls += 1;
      if (calls === 1) return toolCall("update_file", { path: "file" }, calls);
      if (calls === 2) {
        assert.equal(executions, 0);
        assert.match(JSON.stringify(request.messages), /expectedHash/);
        return toolCall("update_file", { path: "file", expectedHash: "observed hash" }, calls);
      }
      const failureMessage = [...request.messages].reverse().find((message) => message.role === "tool")!;
      const failure = JSON.parse(failureMessage.content!).failure;
      assert.equal(failure.execution, "unknown");
      assert.equal(failure.recovery, "inspect_state");
      return { message: { role: "assistant", content: "Need to inspect before retrying." } };
    } };
    await createRuntime(provider, [tool]).run(current, requestText, { ...options, maxSteps: 3 });
    assert.equal(executions, 1);
  });

  it("repairs a missing child evidence array without fabricating completion evidence", async () => {
    const task: TaskNode = {
      id: "child-task", title: "Trace communication", description: "Inspect communication",
      dependencies: [], inputs: [], expectedArtifacts: [], completionChecks: ["Trace verified"],
      failureHandling: "Report unresolved work", owner: "subagent", assignedAgentId: "child",
      status: "in_progress", startedAt: new Date().toISOString(),
    };
    let calls = 0;
    const provider: ModelProvider = { name: "qwen", model: "mock", async complete(request) {
      calls += 1;
      if (calls === 2) assert.match(JSON.stringify(request.messages), /Required field is missing/);
      return toolCall("submit_task_result", { outcome: "completed", summary: "Trace verified",
        ...(calls === 2 ? { evidence: ["Both message handlers inspected"] } : {}),
      }, calls);
    } };
    const result = await createRuntime(provider, [new SubmitTaskResultTool(task)], {
      agentIdentity: { role: "subagent", agentId: "child", assignedTaskId: task.id },
    }).run(newState(), requestText, options);
    assert.equal(result.reason, "success", result.text);
    assert.equal(calls, 2);
    assert.equal(result.subagentTaskReport?.outcome, "completed");
  });

  it("stops repeated invalid Plan submissions with a distinct protocol failure", async () => {
    let calls = 0;
    const provider: ModelProvider = { name: "qwen", model: "mock", async complete() {
      return toolCall("propose_plan", { title: "Missing steps" }, ++calls);
    } };
    const current = newState(false, "plan");
    const result = await createRuntime(provider, [new ProposePlanTool()]).run(current, requestText, options);
    assert.equal(calls, 3);
    assert.equal(result.failure?.code, "tool_protocol_failed");
    assert.equal(current.planReview, undefined);
  });

  it("distinguishes JSON preflight from errors raised inside execution", () => {
    const tool = new CompactContextTool();
    let invalidJson: ToolExecutionResult | undefined;
    try { prepareToolInput(tool, "{bad json"); }
    catch (error) { invalidJson = toolFailure(error); }
    assert.equal(invalidJson?.failure?.code, "invalid_json");
    assert.equal(invalidJson?.failure?.execution, "not_started");
    const late = z.object({ field: z.string() }).safeParse({});
    assert.equal(late.success, false);
    if (!late.success) {
      assert.equal(toolFailure(late.error).failure?.execution, "unknown");
      assert.equal(toolFailure(late.error).failure?.recovery, "inspect_state");
    }
    const denial = normalizeToolFailure({ ok: false, summary: "Denied", data: {
      failure: { kind: "approval", code: "approval_denied", processStarted: false },
    } });
    assert.equal(denial.failure?.recovery, "none");
    assert.equal(denial.failure?.execution, "not_started");
  });

  it("preserves machine-readable missing paths when long errors are clipped", () => {
    const tool = new CompactContextTool();
    const candidate = compactionV2Input({ primaryRequestIndex: 0, primaryRequestText: "question" });
    delete (candidate.coverageCheck as Partial<typeof candidate.coverageCheck>).unresolvedErrorsPreserved;
    let result: ToolExecutionResult | undefined;
    try { prepareToolInput(tool, JSON.stringify(candidate)); }
    catch (error) { result = toolFailure(error, "Invalid parameters"); }
    assert.ok(result?.failure);
    result.error = "very long error ".repeat(1000);
    const serialized = toolResultForModel(result, 1024);
    assert.ok(serialized.length <= 1024);
    assert.equal(JSON.parse(serialized).failure.issues[0].path, "coverageCheck.unresolvedErrorsPreserved");
    assert.equal(JSON.parse(serialized).failure.execution, "not_started");
    assert.equal("unresolvedErrorsPreserved" in candidate.coverageCheck, false);
  });
});
