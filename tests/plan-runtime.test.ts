import assert from "node:assert/strict";

import { ContextManager } from "../src/context/manager.js";
import type {
  AgentMode,
  AgentTool,
  EventRecord,
  ModelProvider,
  PlanReviewState,
  SessionState,
} from "../src/core/types.js";
import { AgentRuntime } from "../src/runtime/agent.js";
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
    requestApproval: async () => false,
  });
}

describe("model-controlled plan flow", () => {
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
    assert.deepEqual(modes, ["plan"]);
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
