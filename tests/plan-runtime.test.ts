import assert from "node:assert/strict";

import { ContextManager } from "../src/context/manager.js";
import type {
  AgentMode,
  AgentTool,
  EventRecord,
  ModelUsageRecord,
  ModelProvider,
  PlanReviewState,
  SessionState,
} from "../src/core/types.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { CompactContextTool } from "../src/tools/compact-context.js";
import { ProposePlanTool } from "../src/tools/propose-plan.js";
import { describe, it } from "./harness.js";

function state(mode: AgentMode = "auto"): SessionState {
  const now = new Date().toISOString();
  return {
    threadId: "thread_plan_runtime",
    mode,
    provider: "deepseek",
    model: "mock-model",
    thinkingEffort: "medium",
    workspaceRoot: process.cwd(),
    constraints: [],
    messages: [],
    filesRead: new Map(),
    changes: [],
    commands: [],
    commandApprovalPrefixes: [],
    workingSummary: "",
    compactedMessageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function options() {
  return {
    maxSteps: 3,
    maxContextChars: 24_000,
    maxOutputChars: 8_000,
    commandTimeoutMs: 1_000,
    approvalPolicy: "never" as const,
  };
}

function selectMode(mode: "plan" | "code") {
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [{
        id: "call_select_mode",
        type: "function" as const,
        function: {
          name: "select_mode" as const,
          arguments: JSON.stringify({
            mode,
            reason: `The model selected ${mode}.`,
          }),
        },
      }],
    },
  };
}

function respondDirectly(content: string) {
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [{
        id: "call_respond_directly",
        type: "function" as const,
        function: {
          name: "respond_directly",
          arguments: JSON.stringify({ content }),
        },
      }],
    },
  };
}

function proposePlanCall() {
  return {
    id: "call_propose_plan",
    type: "function" as const,
    function: {
      name: "propose_plan" as const,
      arguments: JSON.stringify({
        title: "Add login and registration",
        overview: "Implement the approved local authentication demonstration.",
        steps: [{
          title: "Add authentication state",
          description: "Add login, registration, logout, and per-user local state.",
          verification: "Run the relevant tests and verify two accounts remain isolated.",
        }],
      }),
    },
  };
}

function createFileTool(): AgentTool {
  return {
    name: "create_file",
    mutating: true,
    definition: {
      type: "function",
      function: {
        name: "create_file",
        description: "Create a file",
        parameters: { type: "object" },
      },
    },
    async execute() {
      return { ok: true, summary: "created" };
    },
  };
}

function review(status: PlanReviewState["status"] = "awaiting_review"): PlanReviewState {
  return {
    status,
    proposal: {
      id: "plan_11111111-1111-4111-8111-111111111111",
      revision: 1,
      proposedByTurnId: "turn_original",
      proposedAt: "2026-08-27T00:00:00.000Z",
      title: "Add login and registration",
      overview: "Implement the local authentication demonstration.",
      steps: [{
        title: "Implement authentication",
        description: "Add the approved login and registration behavior.",
        verification: "Run tests for login, logout, and account isolation.",
      }],
    },
    ...(status === "approved_pending_execution"
      ? { approvedAt: "2026-08-27T00:05:00.000Z" }
      : {}),
  };
}

function runtime(
  provider: ModelProvider,
  tools: AgentTool[],
  events: Array<Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp">> = [],
  modes: AgentMode[] = [],
  usageRecords: ModelUsageRecord[] = [],
  reasoningTexts: string[] = [],
) {
  return new AgentRuntime({
    provider,
    tools,
    contextManager: new ContextManager(),
    buildSystemPrompt: async ({ mode }) => {
      modes.push(mode);
      return `mode:${mode}`;
    },
    getWorkspaceSummary: async () => "workspace",
    searchMemories: async () => [],
    appendEvent: async (event) => {
      events.push(event);
    },
    onModelUsage: async (record) => {
      usageRecords.push(record);
    },
    onReasoning: ({ text }) => {
      reasoningTexts.push(text);
    },
    requestApproval: async () => false,
  });
}

describe("model-controlled plan flow", () => {
  it("answers a bounded Auto request in one call and records router usage", async () => {
    let requests = 0;
    let routerTools: string[] = [];
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete(request) {
        requests += 1;
        routerTools = request.tools?.map((tool) => tool.function.name) ?? [];
        return {
          message: {
            ...respondDirectly("The current task is to add usage accounting.").message,
            reasoning_content: "The bounded conversation already contains the task.",
          },
          usage: {
            promptTokens: 90,
            completionTokens: 10,
            totalTokens: 100,
            cachedInputTokens: 25,
            reasoningTokens: 4,
          },
        };
      },
    };
    const events: Array<Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp">> = [];
    const usageRecords: ModelUsageRecord[] = [];
    const reasoningTexts: string[] = [];
    const modes: AgentMode[] = [];
    const current = state("auto");
    const result = await runtime(
      provider,
      [],
      events,
      modes,
      usageRecords,
      reasoningTexts,
    ).run(current, "What is the current task?", options());

    assert.equal(requests, 1);
    assert.deepEqual(routerTools, ["select_mode", "respond_directly"]);
    assert.equal(result.reason, "success");
    assert.equal(result.steps, 0);
    assert.equal(result.text, "The current task is to add usage accounting.");
    assert.deepEqual(modes, ["auto"]);
    const finalMessage = current.messages.at(-1);
    assert.equal(finalMessage?.role, "assistant");
    assert.equal(
      finalMessage?.role === "assistant" ? finalMessage.reasoning_content : undefined,
      "The bounded conversation already contains the task.",
    );
    assert.deepEqual(reasoningTexts, [
      "The bounded conversation already contains the task.",
    ]);
    assert.ok(events.some((event) => event.type === "mode.auto_direct_response"));
    assert.equal(events.some((event) => event.type === "mode.auto_route"), false);
    assert.deepEqual(usageRecords, [{
      actor: "main_agent",
      purpose: "auto_route",
      provider: "deepseek",
      model: "mock-model",
      turnId: result.turnId,
      attempt: 1,
      retry: false,
      usage: {
        promptTokens: 90,
        completionTokens: 10,
        totalTokens: 100,
        cachedInputTokens: 25,
        reasoningTokens: 4,
      },
    }]);
  });

  it("records an earlier invalid Auto attempt when the retry request fails", async () => {
    let requests = 0;
    const usageRecords: ModelUsageRecord[] = [];
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete() {
        requests += 1;
        if (requests === 1) {
          return {
            message: { role: "assistant", content: "invalid plain text" },
            usage: { promptTokens: 100, completionTokens: 23, totalTokens: 123 },
          };
        }
        throw new Error("second controller request failed");
      },
    };

    const result = await runtime(
      provider,
      [],
      [],
      [],
      usageRecords,
    ).run(state("auto"), "Fix the bug", options());

    assert.equal(result.reason, "failed");
    assert.match(result.text, /second controller request failed/u);
    assert.equal(requests, 2);
    assert.equal(usageRecords.length, 1);
    assert.equal(usageRecords[0]?.purpose, "auto_route");
    assert.equal(usageRecords[0]?.usage?.totalTokens, 123);
  });

  it("compacts an Auto thread at 80% and then restores model-controlled routing", async () => {
    const current = state("auto");
    current.messages.push({ role: "user", content: "x".repeat(20_000) });
    const requestTools: string[][] = [];
    const modes: AgentMode[] = [];
    const events: Array<Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp">> = [];
    let requests = 0;
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete(request) {
        requests += 1;
        requestTools.push(request.tools?.map((tool) => tool.function.name) ?? []);
        if (requests === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_compact_before_direct",
                type: "function",
                function: {
                  name: "compact_context",
                  arguments: JSON.stringify({
                    summary: "Objective: answer after required context compaction.",
                  }),
                },
              }],
            },
          };
        }
        if (requests === 2) return selectMode("plan");
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [proposePlanCall()],
          },
        };
      },
    };

    const result = await runtime(
      provider,
      [new ProposePlanTool(), new CompactContextTool()],
      events,
      modes,
    ).run(current, "What is the current task?", {
      ...options(),
      maxSteps: 1,
      maxContextChars: 24_000,
    });

    assert.equal(result.reason, "planned");
    assert.deepEqual(requestTools[0], ["compact_context"]);
    assert.deepEqual(requestTools[1], ["select_mode", "respond_directly"]);
    assert.deepEqual(requestTools[2], ["propose_plan", "compact_context"]);
    assert.deepEqual(modes, ["auto", "auto", "plan"]);
    const eventTypes = events.map((event) => event.type);
    assert.ok(eventTypes.indexOf("context.compacted") >= 0);
    assert.ok(
      eventTypes.indexOf("context.compacted") < eventTypes.indexOf("mode.auto_route"),
    );
  });

  it("records an ordinary Code response as agent-step usage", async () => {
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete() {
        return {
          message: {
            role: "assistant",
            content: "Completed without tools.",
            tool_calls: [],
          },
          usage: { promptTokens: 60, completionTokens: 8, totalTokens: 68 },
        };
      },
    };
    const usageRecords: ModelUsageRecord[] = [];
    const result = await runtime(
      provider,
      [],
      [],
      [],
      usageRecords,
    ).run(state("code"), "Answer directly", options());

    assert.equal(result.reason, "success");
    assert.equal(usageRecords.length, 1);
    assert.deepEqual(usageRecords[0], {
      actor: "main_agent",
      purpose: "agent_step",
      provider: "deepseek",
      model: "mock-model",
      turnId: result.turnId,
      step: 1,
      attempt: 1,
      retry: false,
      usage: { promptTokens: 60, completionTokens: 8, totalTokens: 68 },
    });
  });

  it("uses select_mode to enter Plan and ends immediately on propose_plan", async () => {
    let requests = 0;
    let mainTools: string[] = [];
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete(request) {
        requests += 1;
        if (requests === 1) return selectMode("plan");
        mainTools = request.tools?.map((tool) => tool.function.name) ?? [];
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [proposePlanCall()],
          },
        };
      },
    };
    const current = state("auto");
    const events: Array<Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp">> = [];
    const modes: AgentMode[] = [];
    const result = await runtime(
      provider,
      [new ProposePlanTool(), createFileTool()],
      events,
      modes,
    ).run(current, "Please decide how to handle this feature", options());

    assert.equal(requests, 2);
    assert.deepEqual(mainTools, ["propose_plan"]);
    assert.deepEqual(modes, ["auto", "plan"]);
    assert.equal(current.mode, "auto");
    assert.equal(result.reason, "planned");
    assert.equal(result.planProposal?.id, current.planReview?.proposal.id);
    assert.equal(current.planReview?.status, "awaiting_review");
    assert.equal(current.planReview?.proposal.revision, 1);
    assert.match(result.text, /waiting for user review/u);
    assert.ok(events.some((event) =>
      event.type === "tool.result" &&
      typeof event.payload === "object" &&
      event.payload !== null &&
      "planReview" in event.payload
    ));
  });

  it("uses a Code selection without exposing propose_plan", async () => {
    let requests = 0;
    let mainTools: string[] = [];
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete(request) {
        requests += 1;
        if (requests === 1) return selectMode("code");
        mainTools = request.tools?.map((tool) => tool.function.name) ?? [];
        return {
          message: { role: "assistant", content: "Handled directly.", tool_calls: [] },
        };
      },
    };
    const current = state("auto");
    const result = await runtime(
      provider,
      [new ProposePlanTool(), createFileTool()],
    ).run(current, "Handle this request", options());

    assert.equal(result.reason, "success");
    assert.deepEqual(mainTools, ["create_file"]);
    assert.equal(current.planReview, undefined);
  });

  it("requires propose_plan instead of accepting plain Plan text", async () => {
    let requests = 0;
    let sawReminder = false;
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete(request) {
        requests += 1;
        if (requests === 1) {
          return {
            message: { role: "assistant", content: "A plain text plan", tool_calls: [] },
          };
        }
        sawReminder = request.messages.some((message) =>
          message.role === "user" && /RUNTIME_PLAN_PROTOCOL/u.test(message.content)
        );
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [proposePlanCall()],
          },
        };
      },
    };
    const result = await runtime(
      provider,
      [new ProposePlanTool()],
    ).run(state("plan"), "Create a plan", options());

    assert.equal(requests, 2);
    assert.equal(sawReminder, true);
    assert.equal(result.reason, "planned");
  });

  it("consumes an exact approved proposal only after the execution message is durable", async () => {
    let requests = 0;
    let mainTools: string[] = [];
    const events: Array<Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp">> = [];
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete(request) {
        requests += 1;
        mainTools = request.tools?.map((tool) => tool.function.name) ?? [];
        return {
          message: { role: "assistant", content: "Executed approved plan.", tool_calls: [] },
        };
      },
    };
    const current = state("auto");
    current.planReview = review("approved_pending_execution");
    const approved = current.planReview.proposal;
    const result = await runtime(provider, [], events).run(
      current,
      "Execute the approved plan",
      {
        ...options(),
        modeOverride: "code",
        approvedPlan: { id: approved.id, revision: approved.revision },
      },
    );

    assert.equal(result.reason, "success");
    assert.equal(requests, 1);
    assert.deepEqual(mainTools, []);
    assert.equal(current.planReview, undefined);
    const userIndex = events.findIndex((event) => event.type === "message.user");
    const executionIndex = events.findIndex((event) => event.type === "plan.execution_started");
    assert.ok(userIndex >= 0 && executionIndex > userIndex);
  });

  it("returns an approved plan to review after a provider timeout", async () => {
    const events: Array<Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp">> = [];
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete() {
        throw new Error("Provider request timed out after 450000ms");
      },
    };
    const current = state("auto");
    current.planReview = review("approved_pending_execution");
    const approved = current.planReview.proposal;

    const result = await runtime(provider, [], events).run(
      current,
      "Execute the approved plan",
      {
        ...options(),
        modeOverride: "code",
        approvedPlan: { id: approved.id, revision: approved.revision },
      },
    );

    assert.equal(result.reason, "failed");
    assert.match(result.text, /timed out after 450000ms/u);
    assert.equal(current.planReview?.status, "awaiting_review");
    assert.equal(current.planReview?.proposal.id, approved.id);
    assert.equal(current.planReview?.proposal.revision, approved.revision);
    assert.equal(
      Object.prototype.hasOwnProperty.call(current.planReview ?? {}, "approvedAt"),
      false,
    );
    assert.match(current.planReview?.feedback ?? "", /workspace|partial/u);

    const lifecycle = events
      .map((event) => event.type)
      .filter((type) => [
        "plan.execution_started",
        "model.error",
        "plan.execution_returned_to_review",
        "turn.completed",
      ].includes(type));
    assert.deepEqual(lifecycle, [
      "plan.execution_started",
      "model.error",
      "plan.execution_returned_to_review",
      "turn.completed",
    ]);

    const returned = events.find(
      (event) => event.type === "plan.execution_returned_to_review",
    );
    assert.ok(returned);
    const payload = returned.payload as {
      planId?: string;
      revision?: number;
      outcome?: string;
      planReview?: PlanReviewState;
    };
    assert.equal(payload.planId, approved.id);
    assert.equal(payload.revision, approved.revision);
    assert.equal(payload.outcome, "failed");
    assert.equal(payload.planReview?.status, "awaiting_review");
  });

  it("revises the same pending plan in a Runtime-owned Plan override", async () => {
    let requests = 0;
    let mainTools: string[] = [];
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete(request) {
        requests += 1;
        mainTools = request.tools?.map((tool) => tool.function.name) ?? [];
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [proposePlanCall()],
          },
        };
      },
    };
    const current = state("auto");
    current.planReview = { ...review(), feedback: "Use a modal dialog." };
    const originalId = current.planReview.proposal.id;
    const result = await runtime(provider, [new ProposePlanTool()]).run(
      current,
      "Adjust the pending plan",
      { ...options(), modeOverride: "plan" },
    );

    assert.equal(requests, 1);
    assert.deepEqual(mainTools, ["propose_plan"]);
    assert.equal(result.planProposal?.id, originalId);
    assert.equal(result.planProposal?.revision, 2);
    assert.equal(current.planReview?.feedback, undefined);
  });
});
