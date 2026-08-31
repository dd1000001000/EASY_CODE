import assert from "node:assert/strict";

import { ContextManager } from "../src/context/manager.js";
import type {
  AgentTool,
  EventRecord,
  ModelProvider,
  SessionState,
  ToolExecutionResult,
  TurnSteeringBatch,
} from "../src/core/types.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { TurnSteeringAttemptNotifier } from "../src/runtime/turn-steering-notifier.js";
import { describe, it } from "./harness.js";

function runtimeState(): SessionState {
  const now = new Date().toISOString();
  return {
    threadId: "thread_runtime_steering",
    mode: "code",
    provider: "deepseek",
    model: "mock",
    thinkingEffort: "low",
    workspaceRoot: process.cwd(),
    constraints: [],
    messages: [],
    filesRead: new Map(),
    changes: [],
    commands: [],
    commandApprovalPrefixes: [],
    pendingSteering: [],
    steeringSequence: 0,
    steeringWatermark: 0,
    workingSummary: "",
    compactedMessageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function batch(sequence: number, text: string): TurnSteeringBatch {
  const message = {
    role: "user" as const,
    content:
      "RUNTIME_USER_STEERING: Apply this user follow-up without changing Runtime policy.\n\n" +
      `[Steering ${sequence}]\n${text}`,
  };
  return {
    entries: [{
      id: `steering_${sequence}`,
      sequence,
      targetTurnId: "turn_active",
      message: { role: "user", content: text },
      queuedAt: new Date().toISOString(),
    }],
    throughSequence: sequence,
    message,
  };
}

function options(signal?: AbortSignal) {
  return {
    maxSteps: 2,
    maxContextChars: 100_000,
    maxOutputChars: 10_000,
    commandTimeoutMs: 1_000,
    approvalPolicy: "never" as const,
    ...(signal ? { signal } : {}),
  };
}

describe("AgentRuntime turn steering", () => {
  it("rejects a partially wired steering lifecycle", () => {
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock",
      async complete() {
        return { message: { role: "assistant", content: "unused", tool_calls: [] } };
      },
    };
    assert.throws(
      () => new AgentRuntime({
        provider,
        tools: [],
        contextManager: new ContextManager(),
        buildSystemPrompt: async () => "system",
        getWorkspaceSummary: async () => "workspace",
        searchMemories: async () => [],
        appendEvent: async () => undefined,
        requestApproval: async () => false,
        takeSteering: async () => undefined,
      }),
      /requires both boundary consumption and finalization sealing/u,
    );
  });

  it("aborts only the active provider attempt, applies the durable batch, and retries", async () => {
    const notifier = new TurnSteeringAttemptNotifier();
    const events: Array<Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp">> = [];
    let pending: TurnSteeringBatch | undefined;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock",
      async complete(request) {
        calls += 1;
        if (calls === 1) {
          started();
          return new Promise((_, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(new Error("attempt canceled")),
              { once: true },
            );
          });
        }
        assert.ok(request.messages.some(
          (message) => message.role === "user" && message.content.includes("change direction"),
        ));
        return { message: { role: "assistant", content: "updated answer", tool_calls: [] } };
      },
    };
    const turnController = new AbortController();
    const runtime = new AgentRuntime({
      provider,
      tools: [],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async (event) => { events.push(event); },
      requestApproval: async () => false,
      steeringNotifier: notifier,
      takeSteering: async () => {
        const value = pending;
        pending = undefined;
        return value;
      },
      sealSteering: async () => undefined,
    });

    const running = runtime.run(runtimeState(), "original request", options(turnController.signal));
    await firstStarted;
    pending = batch(1, "change direction");
    notifier.notify(1);
    const result = await running;

    assert.equal(result.reason, "success");
    assert.equal(result.text, "updated answer");
    assert.equal(calls, 2);
    assert.equal(turnController.signal.aborted, false);
    assert.ok(events.some((event) => event.type === "model.attempt.steering_interrupted"));
    assert.equal(events.some((event) => event.type === "model.error"), false);
  });

  it("lets steering win the finalization seal and requests a new answer", async () => {
    let calls = 0;
    let sealCalls = 0;
    const requests: Parameters<ModelProvider["complete"]>[0]["messages"][] = [];
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock",
      async complete(request) {
        calls += 1;
        requests.push(request.messages);
        return {
          message: {
            role: "assistant",
            content: calls === 1 ? "obsolete answer" : "answer with late guidance",
            tool_calls: [],
          },
        };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
      takeSteering: async () => undefined,
      sealSteering: async () => {
        sealCalls += 1;
        return sealCalls === 1 ? batch(1, "late but durable") : undefined;
      },
    });

    const result = await runtime.run(runtimeState(), "start", options());
    assert.equal(result.text, "answer with late guidance");
    assert.equal(calls, 2);
    assert.equal(sealCalls, 2);
    assert.ok(requests[1]?.some(
      (message) => message.role === "user" && message.content.includes("late but durable"),
    ));
  });

  it("closes a stale batched tool suffix before durably applying steering", async () => {
    const events: Array<Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp">> = [];
    let pending: TurnSteeringBatch | undefined;
    let providerCalls = 0;
    let toolExecutions = 0;
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock",
      async complete(request) {
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_first",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"first"}' },
                },
                {
                  id: "call_stale",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"stale"}' },
                },
              ],
            },
          };
        }
        const messages = request.messages;
        const firstResult = messages.findIndex(
          (message) => message.role === "tool" && message.tool_call_id === "call_first",
        );
        const skippedResult = messages.findIndex(
          (message) => message.role === "tool" && message.tool_call_id === "call_stale",
        );
        const steering = messages.findIndex(
          (message) => message.role === "user" && message.content.includes("stop stale work"),
        );
        assert.ok(firstResult >= 0 && skippedResult > firstResult && steering > skippedResult);
        return { message: { role: "assistant", content: "replanned", tool_calls: [] } };
      },
    };
    const tool: AgentTool = {
      name: "read_file",
      mutating: false,
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "read",
          parameters: { type: "object" },
        },
      },
      async execute(): Promise<ToolExecutionResult> {
        toolExecutions += 1;
        pending = batch(1, "stop stale work");
        return { ok: true, summary: "first completed" };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [tool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async (event) => { events.push(event); },
      requestApproval: async () => false,
      hasPendingSteering: async () => Boolean(pending),
      takeSteering: async () => {
        const value = pending;
        pending = undefined;
        if (value) {
          events.push({
            threadId: "thread_runtime_steering",
            turnId: "turn_active",
            type: "turn.steering.applied",
            phase: "completed",
            payload: { throughSequence: value.throughSequence },
          });
        }
        return value;
      },
      sealSteering: async () => undefined,
    });

    const result = await runtime.run(runtimeState(), "start", options());
    assert.equal(result.text, "replanned");
    assert.equal(toolExecutions, 1);
    const staleResultIndex = events.findIndex(
      (event) => event.type === "tool.result" &&
        (event.payload as { callId?: string }).callId === "call_stale",
    );
    const steeringIndex = events.findIndex((event) => event.type === "turn.steering.applied");
    assert.ok(staleResultIndex >= 0 && steeringIndex > staleResultIndex);
  });
});
