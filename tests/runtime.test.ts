import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "./harness.js";
import {
  compactionV2Input,
} from "./compaction-fixture.js";
import {
  ContextManager,
  MAX_ACTIVE_WORKING_SET_CHARS,
  estimateMessagesChars,
  estimateToolDefinitionsChars,
} from "../src/context/manager.js";
import type {
  AgentTool,
  EventRecord,
  ImageAttachment,
  ModelProvider,
  ProviderResponse,
  SessionState,
  ToolExecutionResult
} from "../src/core/types.js";
import { AgentRuntime, type ProviderContextSnapshot } from "../src/runtime/agent.js";
import { applyTaskGraphOperation } from "../src/tasks/task-graph.js";
import { CompactContextTool } from "../src/tools/compact-context.js";
import { ManageTasksTool } from "../src/tools/manage-tasks.js";
import { ProposePlanTool } from "../src/tools/propose-plan.js";

function state(mode: "plan" | "auto" | "code" = "code"): SessionState {
  const now = new Date().toISOString();
  return {
    threadId: "thread_test",
    mode,
    provider: "qwen",
    model: "mock",
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
    updatedAt: now
  };
}

function primeRuntimeContextChars(
  currentState: SessionState,
  input: string,
  targetChars: number,
  marker: string,
): void {
  const currentInputChars = input.length + 32;
  const historicalContentChars = targetChars - currentInputChars - 32;
  assert.ok(
    historicalContentChars >= marker.length,
    "The target context must leave enough room for the historical marker",
  );
  currentState.messages = [{
    role: "user",
    content: marker + "x".repeat(historicalContentChars - marker.length),
  }];
  assert.equal(
    new ContextManager().estimateShortTermChars(currentState) + currentInputChars,
    targetChars,
  );
}


const degradationOptions = {
  maxSteps: 4, maxContextChars: 100_000, maxContextTokens: 34_000,
  maxOutputChars: 8000, commandTimeoutMs: 1000, approvalPolicy: "never" as const,
};
function investigationState(reasoningChars = 60_000): SessionState {
  const current = state();
  current.messages = [
    { role: "user", content: "Preserve Node.js 16 support" },
    { role: "assistant", content: "Earlier unfinished investigation", reasoning_content: "r".repeat(reasoningChars) },
    { role: "assistant", content: "Recent evidence", reasoning_content: "recent reasoning" },
    { role: "assistant", content: "Live work", reasoning_content: "keep this exactly" },
  ];
  return current;
}
function summaryResponse(currentWork = "Investigation unfinished; no fix verified."): ProviderResponse {
  return { message: { role: "assistant", content: null, tool_calls: [{
    id: "compact_candidate", type: "function", function: { name: "compact_context",
      arguments: JSON.stringify({ currentWork, nextStep: "Test the competing hypotheses." }) },
  }] } };
}
function contextRuntime(provider: ModelProvider, tools: AgentTool[],
  events: Array<{ type: string; payload: unknown }> = [], purposes: string[] = []) {
  return new AgentRuntime({
    provider, tools, contextManager: new ContextManager(), buildSystemPrompt: async () => "rules",
    getWorkspaceSummary: async () => "workspace", searchMemories: async () => [],
    appendEvent: async (event) => { events.push(event); },
    onModelUsage: async (record) => { purposes.push(record.purpose); },
    requestApproval: async () => false,
  });
}

describe("AgentRuntime", () => {
  it("injects layered context before the model request and checkpoints the final state", async () => {
    const currentState = state();
    currentState.goal = "Keep the release migration safe";
    currentState.constraints = ["Do not lose the rollback requirement"];
    currentState.messages = Array.from({ length: 120 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `historical-${index}-${"x".repeat(1_000)}`,
    }));
    currentState.compactedMessageCount = 60;
    currentState.workingSummary = "The first sixty messages were compacted.";
    currentState.changes.push({
      path: "src/release.ts",
      operation: "update",
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
      source: "file_tool",
      status: "verified",
      timestamp: new Date().toISOString(),
    });
    currentState.commands.push({
      id: "command_release_test",
      program: "npm",
      args: ["test"],
      cwd: process.cwd(),
      status: "exited",
      exitCode: 1,
      durationMs: 12,
      timestamp: new Date().toISOString(),
      summary: "release migration test failed at rollback assertion",
    });
    let observedBoundary = 0;
    let observedQuery = "";
    let finalCheckpointMessages = 0;
    let promptLayers: { checkpoint?: string; evidence?: string } = {};
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        const context = request.messages.map((message) => message.content ?? "").join("\n");
        assert.doesNotMatch(request.messages[0]?.content ?? "", /older-retrieved-evidence/u);
        assert.match(context, /pinnedCurrentState/u);
        assert.match(context, /continue the historical task/u);
        assert.match(context, /src\/release\.ts/u);
        assert.match(context, /older-retrieved-evidence/u);
        return { message: { role: "assistant", content: "done" } };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [],
      contextManager: new ContextManager(),
      buildSystemPrompt: async (input) => {
        promptLayers = {
          checkpoint: input.workingCheckpoint,
          evidence: input.retrievedThreadEvidence,
        };
        return `system ${input.workingCheckpoint ?? ""} ${input.retrievedThreadEvidence ?? ""}`;
      },
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      getLayeredContext: async (input) => {
        observedBoundary = input.beforeMessageIndex;
        observedQuery = input.query;
        return {
          workingCheckpoint: "checkpoint-sequence-7",
          retrievedThreadEvidence: "older-retrieved-evidence",
        };
      },
      checkpointContext: async (finalState) => {
        finalCheckpointMessages = finalState.messages.length;
      },
      appendEvent: async () => undefined,
      requestApproval: async () => false,
    });

    const result = await runtime.run(currentState, "continue the historical task", {
      maxSteps: 1,
      maxContextChars: 1_600_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success", result.text);
    assert.ok(observedBoundary > 0);
    assert.match(observedQuery, /continue the historical task/u);
    assert.equal(promptLayers.checkpoint, undefined);
    assert.equal(promptLayers.evidence, undefined);
    assert.match(observedQuery, /LATEST_FAILURE/u);
    assert.match(observedQuery, /rollback assertion/u);
    assert.match(observedQuery, /CURRENT_DIFF_AND_PATH_EVIDENCE/u);
    assert.match(observedQuery, /src\/release\.ts/u);
    assert.equal(finalCheckpointMessages, currentState.messages.length);
    assert.equal(currentState.messages.at(-1)?.role, "assistant");
  });

  it("uses the Auto Router projection boundary for layered retrieval", async () => {
    const currentState = state("auto");
    currentState.messages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `prior-${index}`,
    }));
    const observedBoundaries: number[] = [];
    let requestCount = 0;
    const runtime = new AgentRuntime({
      provider: {
        name: "qwen",
        model: "mock",
        async complete() {
          requestCount += 1;
          if (requestCount === 1) {
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "call_auto_boundary",
                  type: "function",
                  function: {
                    name: "respond_directly",
                    arguments: '{"content":"done"}',
                  },
                }],
              },
            };
          }
          throw new Error("Auto direct response should finish in one request");
        },
      },
      tools: [],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      getLayeredContext: async (input) => {
        observedBoundaries.push(input.beforeMessageIndex);
        return {};
      },
      appendEvent: async () => undefined,
      requestApproval: async () => false,
    });

    const result = await runtime.run(currentState, "answer now", {
      maxSteps: 1,
      maxContextChars: 1_600_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.deepEqual(observedBoundaries, [0, 4]);
  });

  it("keeps the current request when layered-system reservation exceeds a low context budget", async () => {
    const currentState = state();
    currentState.messages = Array.from({ length: 20 }, (_, index) => ({
      role: "assistant" as const,
      content: `large-history-${index}-${"x".repeat(500)}`,
    }));
    // Keep the old history durable but already summarized so this case tests
    // system-layer reservation rather than the independent 90% compaction gate.
    currentState.compactedMessageCount = currentState.messages.length;
    currentState.workingSummary = "Earlier work was compacted.";
    const currentRequest = "CURRENT_LOW_BUDGET_REQUEST";
    const runtime = new AgentRuntime({
      provider: {
        name: "qwen",
        model: "mock",
        async complete(request) {
          assert.ok(request.messages.some((message) => message.role === "user" && message.content === currentRequest));
          return { message: { role: "assistant", content: "done" } };
        },
      },
      tools: [],
      contextManager: new ContextManager(),
      buildSystemPrompt: async (input) =>
        `system ${input.workingCheckpoint ?? ""} ${input.retrievedThreadEvidence ?? ""}`,
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      getLayeredContext: async () => ({
        workingCheckpoint: "checkpoint",
        retrievedThreadEvidence: "retrieved evidence",
      }),
      appendEvent: async () => undefined,
      requestApproval: async () => false,
    });

    const result = await runtime.run(currentState, currentRequest, {
      maxSteps: 1,
      maxContextChars: 4_096,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success", result.text);
  });

  it("notifies the UI only for main-model thinking when thinking is enabled", async () => {
    let requestCount = 0;
    const notifications: string[] = [];
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete() {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_select_mode",
                type: "function",
                function: {
                  name: "select_mode",
                  arguments: '{"mode":"code","reason":"A scoped task."}',
                },
              }],
              reasoning_content: "internal router thinking",
            },
          };
        }
        return {
          message: {
            role: "assistant",
            content: "done",
            reasoning_content: "visible main-model thinking",
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
      onReasoning: (notification) => {
        assert.equal(notification.type, "reasoning");
        assert.equal(notification.thinkingEffort, "medium");
        notifications.push(notification.text);
      },
    });

    const result = await runtime.run(state("auto"), "Complete the task", {
      maxSteps: 2,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.deepEqual(notifications, ["visible main-model thinking"]);
  });

  it("does not notify the UI when thinking effort is none", async () => {
    let notificationCount = 0;
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete() {
        return {
          message: {
            role: "assistant",
            content: "done",
            reasoning_content: "provider returned this anyway",
            tool_calls: [],
          },
        };
      },
    };
    const currentState = state();
    currentState.thinkingEffort = "none";
    const runtime = new AgentRuntime({
      provider,
      tools: [],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
      onReasoning: () => {
        notificationCount += 1;
      },
    });

    await runtime.run(currentState, "Complete the task", {
      maxSteps: 1,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(notificationCount, 0);
  });

  it("keeps a throwing reasoning presentation hook from interrupting the turn", async () => {
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete() {
        return {
          message: {
            role: "assistant",
            content: "done despite UI failure",
            reasoning_content: "thinking",
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
      onReasoning: () => {
        throw new Error("renderer failed");
      },
    });

    const result = await runtime.run(state(), "Complete the task", {
      maxSteps: 1,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.equal(result.text, "done despite UI failure");
  });

  it("continues text-only turns after the thread reaches Image #99", async () => {
    let requestCount = 0;
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        requestCount += 1;
        assert.deepEqual(request.currentTurnImageIds, []);
        assert.equal(request.thinkingEffort, "medium");
        return { message: { role: "assistant", content: "Text still works.", tool_calls: [] } };
      },
    };
    const currentState = state();
    currentState.messages.push({
      role: "user",
      content: "historical image",
      images: [{
        id: "image_00000000-0000-4000-8000-000000000099",
        label: "Image #99",
        mediaType: "image/png",
        storageKey:
          "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000099.png",
        sha256: "9".repeat(64),
        byteSize: 128,
        width: 16,
        height: 16,
      }],
    });
    const runtime = new AgentRuntime({
      provider,
      tools: [],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
    });

    const result = await runtime.run(currentState, "Continue without another image", {
      maxSteps: 1,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(requestCount, 1);
    assert.equal(result.reason, "success");
    assert.equal(result.text, "Text still works.");
  });

  it("lets Auto mode inspect attached images before choosing a route", async () => {
    const image: ImageAttachment = {
      id: "image_00000000-0000-4000-8000-000000000010",
      label: "Image #1",
      mediaType: "image/png",
      storageKey:
        "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000010.png",
      sha256: "a".repeat(64),
      byteSize: 128,
      width: 16,
      height: 16,
    };
    let requestCount = 0;
    let routerSawImage = false;
    let imageCommittedBeforeRouting = false;
    const provider: ModelProvider = {
      name: "qwen",
      model: "qwen3-vl-plus",
      async complete(request) {
        requestCount += 1;
        assert.equal(request.thinkingEffort, "medium");
        if (requestCount === 1) {
          assert.equal(imageCommittedBeforeRouting, true);
          routerSawImage = request.messages.some(
            (message) => message.role === "user" && message.images?.[0]?.id === image.id,
          );
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_select_mode_image",
                type: "function",
                function: {
                  name: "select_mode",
                  arguments:
                    '{"mode":"code","reason":"The screenshot identifies a scoped fix."}',
                },
              }],
            },
          };
        }
        assert.deepEqual(request.currentTurnImageIds, [image.id]);
        return { message: { role: "assistant", content: "done", tool_calls: [] } };
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
      commitImages: async (_threadId, attachments) => {
        imageCommittedBeforeRouting = attachments[0]?.id === image.id;
      },
      requestApproval: async () => false,
    });

    const result = await runtime.run(
      state("auto"),
      { text: "Fix the issue shown here", images: [image] },
      {
        maxSteps: 2,
        maxContextChars: 20_000,
        maxOutputChars: 4_000,
        commandTimeoutMs: 1_000,
        approvalPolicy: "never",
      },
    );

    assert.equal(routerSawImage, true);
    assert.equal(imageCommittedBeforeRouting, true);
    assert.equal(result.reason, "success");
  });

  it("continues an unfinished Auto-mode DAG in Code mode without rerouting", async () => {
    const currentState = state("auto");
    currentState.taskGraph = applyTaskGraphOperation(undefined, {
      action: "create",
      goal: "Continue the existing implementation DAG",
      tasks: [{
        id: "continue",
        title: "Continue",
        description: "Continue the existing implementation work",
        dependencies: [],
        inputs: ["Existing task state"],
        expectedArtifacts: ["Resolved continuation"],
        completionChecks: ["Continuation is resolved"],
        failureHandling: "Block if an external decision is still missing",
      }],
    }, {
      turnId: "turn_previous",
      graphId: () => "task_graph_00000000-0000-4000-8000-000000000006",
    });
    let requests = 0;
    const promptModes: string[] = [];
    const runtime = new AgentRuntime({
      provider: {
        name: "qwen",
        model: "mock",
        async complete(request) {
          requests += 1;
          assert.equal(
            request.tools?.some((tool) => tool.function.name === "manage_tasks"),
            true,
          );
          if (requests === 1) {
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "continue_start",
                  type: "function",
                  function: {
                    name: "manage_tasks",
                    arguments: '{"action":"start","taskId":"continue"}',
                  },
                }],
              },
            };
          }
          if (requests === 2) {
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "continue_block",
                  type: "function",
                  function: {
                    name: "manage_tasks",
                    arguments: JSON.stringify({
                      action: "block",
                      taskId: "continue",
                      reason: "The external API contract is still missing",
                    }),
                  },
                }],
              },
            };
          }
          return {
            message: {
              role: "assistant",
              content: "The existing DAG remains blocked on the API contract.",
              tool_calls: [],
            },
          };
        },
      },
      tools: [new ManageTasksTool()],
      contextManager: new ContextManager(),
      buildSystemPrompt: async ({ mode }) => {
        promptModes.push(mode);
        return "system";
      },
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
    });
    const result = await runtime.run(currentState, "Continue", {
      maxSteps: 3,
      maxContextChars: 20_000,
      maxOutputChars: 8_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(requests, 3);
    assert.deepEqual(promptModes, ["code", "code", "code"]);
    assert.equal(result.reason, "blocked");
    assert.equal(currentState.taskGraph.status, "blocked");
  });

  it("executes a tool call and returns the final response", async () => {
    const uiOnlyMarker = "UI_ONLY_DIFF_CONTENT";
    let requestCount = 0;
    let secondRequestToolContent = "";
    let completedPresentation: ToolExecutionResult["presentation"];
    const responses: ProviderResponse[] = [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.ts"}' }
            }
          ]
        }
      },
      { message: { role: "assistant", content: "完成", tool_calls: [] } }
    ];
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        requestCount += 1;
        if (requestCount === 2) {
          secondRequestToolContent =
            [...request.messages].reverse().find((message) => message.role === "tool")?.content ?? "";
        }
        const response = responses.shift();
        if (!response) throw new Error("unexpected call");
        return response;
      }
    };
    const tool: AgentTool = {
      name: "read_file",
      mutating: false,
      definition: {
        type: "function",
        function: { name: "read_file", description: "read", parameters: { type: "object" } }
      },
      async execute(): Promise<ToolExecutionResult> {
        return {
          ok: true,
          summary: "read",
          data: { content: "hello" },
          presentation: {
            type: "file_diff",
            path: "a.ts",
            before: uiOnlyMarker,
            after: "changed",
          },
        };
      }
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [tool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
      onToolCompleted: async (_state, _toolName, toolResult) => {
        completedPresentation = toolResult.presentation;
      },
    });

    const result = await runtime.run(state(), "读取文件", {
      maxSteps: 4,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never"
    });

    assert.equal(result.reason, "success");
    assert.equal(result.text, "完成");
    assert.equal(completedPresentation?.type, "file_diff");
    assert.doesNotMatch(secondRequestToolContent, new RegExp(uiOnlyMarker, "u"));
  });

  it("exposes planning/file/command tools without DAG creation in Plan mode", async () => {
    let seenToolNames: string[] = [];
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        seenToolNames = request.tools?.map((tool) => tool.function.name) ?? [];
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_propose_plan",
              type: "function",
              function: {
                name: "propose_plan",
                arguments: JSON.stringify({
                  title: "Plan the change",
                  overview: "Inspect and implement the requested scoped change.",
                  steps: [{
                    title: "Implement and verify",
                    description: "Make the scoped change after the user approves this plan.",
                    verification: "Run the relevant test suite.",
                  }],
                }),
              },
            }],
          },
        };
      }
    };
    const tools = [
      "read_file",
      "read_image",
      "create_file",
      "update_file",
      "delete_file",
      "run_command",
      "start_command",
      "poll_command",
      "cancel_command",
      "manage_tasks",
      "propose_plan",
      "compact_context",
      "manage_memory",
    ].map(
      (name): AgentTool => name === "propose_plan" ? new ProposePlanTool() : ({
        name: name as AgentTool["name"],
        mutating: name !== "read_file",
        definition: {
          type: "function",
          function: {
            name: name as AgentTool["name"],
            description: name,
            parameters: { type: "object" }
          }
        },
        async execute() {
          return { ok: true, summary: "ok" };
        }
      })
    );
    const runtime = new AgentRuntime({
      provider,
      tools,
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false
    });

    await runtime.run(state("plan"), "给出计划", {
      maxSteps: 2,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never"
    });

    assert.deepEqual(seenToolNames, [
      "read_file",
      "read_image",
      "create_file", "update_file", "delete_file",
      "run_command", "start_command", "poll_command", "cancel_command",
      "propose_plan",
      "manage_memory",
    ]);
  });

  it("enforces a model-created task DAG and refuses a premature final answer", async () => {
    let requestCount = 0;
    let readExecutions = 0;
    let sawRuntimeReminder = false;
    const promptGraphStatuses: string[] = [];
    const events: Array<Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp">> = [];
    const taskDefinition = {
      id: "inspect",
      title: "Inspect implementation",
      description: "Read the implementation and verify the requested behavior",
      dependencies: [],
      inputs: ["Current workspace"],
      expectedArtifacts: ["Verified implementation understanding"],
      completionChecks: ["The implementation was actually read"],
      failureHandling: "Block only if the workspace cannot be read",
    };
    const toolCall = (id: string, name: "manage_tasks" | "read_file", input: unknown) => ({
      id,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(input) },
    });
    const responses: ProviderResponse[] = [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall("call_create", "manage_tasks", {
            action: "create",
            goal: "Inspect a complex implementation",
            tasks: [taskDefinition],
          })],
        },
      },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall("call_early_read", "read_file", { path: "src/app.ts" })],
        },
      },
      { message: { role: "assistant", content: "Finished too early", tool_calls: [] } },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall("call_start", "manage_tasks", {
            action: "start",
            taskId: "inspect",
          })],
        },
      },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall("call_read", "read_file", { path: "src/app.ts" })],
        },
      },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall("call_complete", "manage_tasks", {
            action: "complete",
            taskId: "inspect",
            evidence: ["read_file returned the implementation contents successfully"],
          })],
        },
      },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall("call_late_read", "read_file", { path: "src/app.ts" })],
        },
      },
      { message: { role: "assistant", content: "DAG work is complete", tool_calls: [] } },
    ];
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        const continuity = request.messages.find((message) => message.content?.startsWith("RUNTIME_CONTINUITY_STATE"));
        if (continuity?.content?.includes('"taskGraph"')) {
          const payload = JSON.parse(continuity.content.split("\n").at(-1)!);
          promptGraphStatuses.push(payload.taskGraph.status);
        }
        requestCount += 1;
        if (requestCount === 4) {
          sawRuntimeReminder = request.messages.some(
            (message) => message.role === "user" &&
              message.content.includes("RUNTIME_TASK_DAG_ENFORCEMENT"),
          );
        }
        const response = responses.shift();
        if (!response) throw new Error("Unexpected model request");
        return response;
      },
    };
    const readTool: AgentTool = {
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
      async execute() {
        readExecutions += 1;
        return { ok: true, summary: "read", data: { content: "implementation" } };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [new ManageTasksTool(), readTool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async (event) => {
        events.push(event);
      },
      requestApproval: async () => false,
    });
    const currentState = state();
    const result = await runtime.run(currentState, "Inspect the implementation", {
      maxSteps: 8,
      maxContextChars: 30_000,
      maxOutputChars: 8_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "failed");
    assert.match(result.text, /DAG is incomplete/);
    assert.equal(requestCount, 3);
    assert.equal(readExecutions, 0);
    assert.equal(sawRuntimeReminder, false);
    assert.equal(currentState.taskGraph?.status, "active");
    assert.equal(currentState.taskGraph?.tasks[0]?.status, "pending");
    assert.equal(currentState.messages.some(m => m.role === "tool" && m.content.includes("Start one unblocked DAG task")), true);
  });

  it("refuses a plain final answer until the supervised command is terminal", async () => {
    let requests = 0;
    let running = true;
    let sawRuntimePrompt = false;
    const pollCommand: AgentTool = {
      name: "poll_command",
      mutating: false,
      definition: {
        type: "function",
        function: { name: "poll_command", description: "poll command", parameters: {} },
      },
      async execute() {
        running = false;
        return {
          ok: true,
          summary: "terminal",
          data: { status: "exited", exitCode: 0 },
        };
      },
    };
    const runtime = new AgentRuntime({
      provider: {
        name: "qwen",
        model: "mock",
        async complete(request) {
          requests += 1;
          if (requests === 2) {
            sawRuntimePrompt = request.messages.some(
              (message) => message.content?.includes(
                "RUNTIME_BACKGROUND_COMMAND_FINALIZATION_REQUIRED",
              ) === true,
            );
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "status_background",
                  type: "function",
                  function: {
                    name: "poll_command",
                    arguments: JSON.stringify({
                      commandId: "command_00000000-0000-4000-8000-000000000000",
                      waitMs: 1_000,
                    }),
                  },
                }],
              },
            };
          }
          return {
            message: {
              role: "assistant",
              content: requests === 1 ? "Finished too early." : "Finished after status.",
              tool_calls: [],
            },
          };
        },
      },
      tools: [pollCommand],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
      hasOpenCommandHandles: () => running,
    });

    const result = await runtime.run(state(), "Wait for verification", {
      maxSteps: 3,
      maxContextChars: 20_000,
      maxOutputChars: 8_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "failed");
    assert.match(result.text, /BACKGROUND_COMMAND_FINALIZATION_REQUIRED/);
    assert.equal(requests, 1);
    assert.equal(sawRuntimePrompt, false);
    assert.equal(running, true);
  });

  it("rejects task-DAG complete and block transitions while a command is running", async () => {
    for (const terminalAction of ["complete", "block"] as const) {
      let requests = 0;
      let running = false;
      let sawRejection = false;
      const task = {
        id: "verify",
        title: "Verify the implementation",
        description: "Run verification before declaring a terminal result",
        dependencies: [],
        inputs: ["Current workspace"],
        expectedArtifacts: ["Verified result"],
        completionChecks: ["Verification reached a terminal status"],
        failureHandling: "Block only for a concrete external reason",
      };
      const terminalInput = terminalAction === "complete"
        ? {
            action: terminalAction,
            taskId: task.id,
            evidence: ["The supervised command reached a successful terminal status"],
          }
        : {
            action: terminalAction,
            taskId: task.id,
            reason: "A concrete external dependency is unavailable",
          };
      const call = (id: string, name: "manage_tasks" | "poll_command", input: unknown) => ({
        id,
        type: "function" as const,
        function: { name, arguments: JSON.stringify(input) },
      });
      const responses: ProviderResponse[] = [
        { message: { role: "assistant", content: null, tool_calls: [call("create", "manage_tasks", { action: "create", goal: "Verify safely", tasks: [task] })] } },
        { message: { role: "assistant", content: null, tool_calls: [call("start", "manage_tasks", { action: "start", taskId: task.id })] } },
        { message: { role: "assistant", content: null, tool_calls: [call("premature_terminal", "manage_tasks", terminalInput)] } },
        { message: { role: "assistant", content: null, tool_calls: [call("status", "poll_command", { commandId: "command_00000000-0000-4000-8000-000000000000", waitMs: 1_000 })] } },
        { message: { role: "assistant", content: null, tool_calls: [call("terminal", "manage_tasks", terminalInput)] } },
        { message: { role: "assistant", content: "Terminal result is now safe.", tool_calls: [] } },
      ];
      const runtime = new AgentRuntime({
        provider: {
          name: "qwen",
          model: "mock",
          async complete(request) {
            requests += 1;
            if (requests === 3) running = true;
            if (requests === 4) {
              sawRejection = request.messages.some(
                (message) => message.role === "tool" && message.content.includes(
                  "RUNTIME_BACKGROUND_COMMAND_FINALIZATION_REQUIRED",
                ),
              );
            }
            const response = responses.shift();
            if (!response) throw new Error("Unexpected model request");
            return response;
          },
        },
        tools: [
          new ManageTasksTool(),
          {
            name: "poll_command",
            mutating: false,
            definition: {
              type: "function",
              function: { name: "poll_command", description: "poll command", parameters: {} },
            },
            async execute() {
              running = false;
              return { ok: true, summary: "terminal", data: { status: "exited" } };
            },
          },
        ],
        contextManager: new ContextManager(),
        buildSystemPrompt: async () => "system",
        getWorkspaceSummary: async () => "workspace",
        searchMemories: async () => [],
        appendEvent: async () => undefined,
        requestApproval: async () => false,
        hasOpenCommandHandles: () => running,
      });

      const currentState = state();
      const result = await runtime.run(currentState, "Verify safely", {
        maxSteps: 6,
        maxContextChars: 30_000,
        maxOutputChars: 8_000,
        commandTimeoutMs: 1_000,
        approvalPolicy: "never",
      });

      assert.equal(requests, 3);
      assert.equal(sawRejection, false);
      assert.equal(currentState.taskGraph?.status, "active");
      assert.equal(result.reason, "failed");
      assert.match(result.text, /BACKGROUND_COMMAND_FINALIZATION_REQUIRED/);
    }
  });

  it("rejects every call when manage_tasks is batched with a work tool", async () => {
    let requests = 0;
    let reads = 0;
    const runtime = new AgentRuntime({
      provider: {
        name: "qwen",
        model: "mock",
        async complete() {
          requests += 1;
          if (requests === 1) {
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "mixed_create",
                    type: "function",
                    function: {
                      name: "manage_tasks",
                      arguments: JSON.stringify({
                        action: "create",
                        goal: "A graph that must not be created",
                        tasks: [{
                          id: "inspect",
                          title: "Inspect",
                          description: "Inspect one file",
                          dependencies: [],
                          inputs: ["Workspace"],
                          expectedArtifacts: ["Finding"],
                          completionChecks: ["File inspected"],
                          failureHandling: "Block if the file is unavailable",
                        }],
                      }),
                    },
                  },
                  {
                    id: "mixed_read",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"src/app.ts"}',
                    },
                  },
                ],
              },
            };
          }
          return { message: { role: "assistant", content: "Stopped", tool_calls: [] } };
        },
      },
      tools: [
        new ManageTasksTool(),
        {
          name: "read_file",
          mutating: false,
          definition: {
            type: "function",
            function: { name: "read_file", description: "read", parameters: { type: "object" } },
          },
          async execute() {
            reads += 1;
            return { ok: true, summary: "read" };
          },
        },
      ],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
    });
    const currentState = state();
    const result = await runtime.run(currentState, "Try the mixed batch", {
      maxSteps: 2,
      maxContextChars: 20_000,
      maxOutputChars: 8_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.equal(reads, 0);
    assert.equal(currentState.taskGraph, undefined);
    assert.equal(
      currentState.messages.filter(
        (message) => message.role === "tool" &&
          message.content.includes("manage_tasks_must_be_exclusive"),
      ).length,
      2,
    );
  });

  it("allows a blocked DAG to end the turn without pretending tasks completed", async () => {
    const call = (id: string, input: unknown) => ({
      id,
      type: "function" as const,
      function: { name: "manage_tasks", arguments: JSON.stringify(input) },
    });
    const responses: ProviderResponse[] = [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [call("create", {
            action: "create",
            goal: "Complete an externally gated task",
            tasks: [{
              id: "gated",
              title: "Use external input",
              description: "Complete work that requires an external decision",
              dependencies: [],
              inputs: ["User decision"],
              expectedArtifacts: ["Verified result"],
              completionChecks: ["The external decision was applied"],
              failureHandling: "Block and request the missing user decision",
            }],
          })],
        },
      },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [call("start", { action: "start", taskId: "gated" })],
        },
      },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [call("block", {
            action: "block",
            taskId: "gated",
            reason: "The user must choose which external API contract to use",
          })],
        },
      },
      {
        message: {
          role: "assistant",
          content: "I need the API contract choice before continuing.",
          tool_calls: [],
        },
      },
    ];
    const runtime = new AgentRuntime({
      provider: {
        name: "qwen",
        model: "mock",
        async complete() {
          const response = responses.shift();
          if (!response) throw new Error("Unexpected model request");
          return response;
        },
      },
      tools: [new ManageTasksTool()],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
    });
    const currentState = state();
    const result = await runtime.run(currentState, "Do the gated task", {
      maxSteps: 4,
      maxContextChars: 20_000,
      maxOutputChars: 8_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "blocked");
    assert.equal(result.steps, 4);
    assert.equal(currentState.taskGraph?.status, "blocked");
    assert.equal(currentState.taskGraph?.tasks[0]?.status, "blocked");
    assert.equal(currentState.taskGraph?.tasks[0]?.completionEvidence, undefined);
  });

  it("blocks repeated sandbox startup for one command while preserving the DAG for explicit Resume", async () => {
    const current = state();
    const task = { id: "verify", title: "Verify", description: "Run tests", dependencies: [], inputs: ["workspace"],
      expectedArtifacts: ["result"], completionChecks: ["Tests passed"], failureHandling: "Report environment failure" };
    current.taskGraph = applyTaskGraphOperation(applyTaskGraphOperation(undefined,
      { action: "create", goal: "Verify", tasks: [task] }, { turnId: "seed" }), { action: "start", taskId: "verify" }, { turnId: "seed" });
    let calls = 0, executions = 0, resumed = false;
    const model: ModelProvider = { name: "qwen", model: "mock", complete: async request => {
      calls++;
      assert.ok(request.tools?.some(t => t.function.name === "run_command"));
      if (!resumed && calls <= 3 || resumed && calls === 1) return { message: { role: "assistant", content: null,
        tool_calls: [{ id: `command_${calls}`, type: "function", function: { name: "run_command", arguments: '{"program":"node","intent":"test"}' } }] } };
      if (resumed && calls === 2) return { message: { role: "assistant", content: null, tool_calls: [{ id: "complete", type: "function",
        function: { name: "manage_tasks", arguments: JSON.stringify({ action: "complete", taskId: "verify", evidence: ["Tests passed"] }) } }] } };
      return { message: { role: "assistant", content: "Finish" } };
    } };
    const runtime = new AgentRuntime({ provider: model, tools: [new ManageTasksTool(), {
      name: "run_command", mutating: true, definition: { type: "function", function: { name: "run_command", description: "run", parameters: {} } },
      execute: async () => { executions++; return resumed ? { ok: true, summary: "passed" } : {
        ok: false, summary: "sandbox failed", data: { commandId: `h${executions}`, status: "sandbox_unavailable",
          lifecycle: { execution: "not_started", cleanup: "not_required" }, sandboxFailure: { phase: "initialization", retryable: true } } }; }
    }], contextManager: new ContextManager(), buildSystemPrompt: async () => "rules", getWorkspaceSummary: async () => "",
      searchMemories: async () => [], appendEvent: async () => {}, requestApproval: async () => false });
    const opts = { maxSteps: 4, maxContextChars: 30000, maxOutputChars: 8000, commandTimeoutMs: 1000, approvalPolicy: "never" as const };
    const first = await runtime.run(current, "Verify", opts);
    assert.equal(first.reason, "failed"); assert.equal(executions, 2); assert.equal(current.taskGraph.status, "active");
    assert.equal(current.messages.some(m => m.role === "tool" && m.content.includes("command_sandbox_unavailable")), true);
    resumed = true; calls = 0;
    const second = await runtime.run(current, "Explicitly retry after environment repair", opts);
    assert.equal(second.reason, "success"); assert.equal(executions, 3); assert.equal(current.taskGraph.status, "completed");
  });

  it("clears transient sandbox recovery after a retry reaches a real command failure", async () => {
    const definition = {
      id: "verify",
      title: "Verify implementation",
      description: "Run a verification command that depends on an external service",
      dependencies: [],
      inputs: ["Current workspace"],
      expectedArtifacts: ["Verification result"],
      completionChecks: ["The external verification completes"],
      failureHandling: "Block if required external credentials are unavailable",
    };
    const currentState = state();
    const created = applyTaskGraphOperation(undefined, {
      action: "create",
      goal: "Verify against the external service",
      tasks: [definition],
    }, { turnId: "turn_seed" });
    currentState.taskGraph = applyTaskGraphOperation(created, {
      action: "start",
      taskId: "verify",
    }, { turnId: "turn_seed" });
    let requestCount = 0;
    let commandExecutions = 0;
    const call = (
      id: string,
      name: "manage_tasks" | "run_command",
      input: unknown,
    ) => ({
      id,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(input) },
    });
    const runtime = new AgentRuntime({
      provider: {
        name: "qwen",
        model: "mock",
        async complete() {
          requestCount += 1;
          if (requestCount <= 2) {
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [call(`command_${String(requestCount)}`, "run_command", {
                  program: "node",
                  intent: "test",
                })],
              },
            };
          }
          if (requestCount === 3) {
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [call("durable_block", "manage_tasks", {
                  action: "block",
                  taskId: "verify",
                  reason: "The external service requires credentials that only the user can provide",
                })],
              },
            };
          }
          return {
            message: {
              role: "assistant",
              content: "External verification needs user credentials.",
              tool_calls: [],
            },
          };
        },
      },
      tools: [
        new ManageTasksTool(),
        {
          name: "run_command",
          mutating: true,
          definition: {
            type: "function",
            function: {
              name: "run_command",
              description: "run",
              parameters: { type: "object" },
            },
          },
          async execute() {
            commandExecutions += 1;
            return commandExecutions === 1
              ? {
                  ok: false,
                  summary: "Transient sandbox initialization failure",
                  error: "sandbox unavailable",
                  data: {
                    status: "sandbox_unavailable",
                    lifecycle: { execution: "not_started", cleanup: "not_required" },
                    sandboxFailure: { phase: "initialization", retryable: true },
                  },
                }
              : {
                  ok: false,
                  summary: "Command exited with code 1",
                  error: "External credentials are missing",
                  data: { status: "exited", exitCode: 1 },
                };
          },
        },
      ],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
    });

    const result = await runtime.run(currentState, "Retry verification once", {
      maxSteps: 4,
      maxContextChars: 30_000,
      maxOutputChars: 8_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "blocked");
    assert.equal(result.steps, 4);
    assert.equal(commandExecutions, 2);
    assert.equal(currentState.taskGraph.status, "blocked");
    assert.equal(currentState.taskGraph.tasks[0]?.status, "blocked");
    assert.match(currentState.taskGraph.tasks[0]?.blocker ?? "", /credentials/iu);
  });

  it("does not exceed the hard step cap for DAG finalization", async () => {
    let requestCount = 0;
    let finalRequestTools: string[] = [];
    const call = (id: string, input: unknown) => ({
      id,
      type: "function" as const,
      function: { name: "manage_tasks", arguments: JSON.stringify(input) },
    });
    const responses: ProviderResponse[] = [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [call("create", {
            action: "create",
            goal: "Finish exactly at the configured limit",
            tasks: [{
              id: "finish",
              title: "Finish",
              description: "Complete the bounded task",
              dependencies: [],
              inputs: ["Current request"],
              expectedArtifacts: ["Completion record"],
              completionChecks: ["The bounded task is complete"],
              failureHandling: "Block if completion cannot be established",
            }],
          })],
        },
      },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [call("start", { action: "start", taskId: "finish" })],
        },
      },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [call("complete", {
            action: "complete",
            taskId: "finish",
            evidence: ["The completion condition was checked in this bounded test"],
          })],
        },
      },
      {
        // Even if a provider hallucinates a call after receiving tools: [],
        // Runtime normalizes it to a matched, tool-free terminal response.
        message: {
          role: "assistant",
          content: null,
          tool_calls: [call("hallucinated", { action: "list" })],
        },
      },
    ];
    const runtime = new AgentRuntime({
      provider: {
        name: "qwen",
        model: "mock",
        async complete(request) {
          requestCount += 1;
          if (requestCount === 4) {
            finalRequestTools = (request.tools ?? []).map((tool) => tool.function.name);
          }
          const response = responses.shift();
          if (!response) throw new Error("Unexpected model request");
          return response;
        },
      },
      tools: [new ManageTasksTool()],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
    });
    const currentState = state();
    const result = await runtime.run(currentState, "Finish the bounded task", {
      maxSteps: 3,
      maxContextChars: 20_000,
      maxOutputChars: 8_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "limit_reached");
    assert.equal(result.steps, 3);
    assert.equal(requestCount, 3);
    assert.match(result.text, /hard limit/u);
    assert.equal(currentState.taskGraph?.status, "completed");
    assert.deepEqual(finalRequestTools, []);
    const lastAssistant = [...currentState.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    assert.equal(lastAssistant?.role, "assistant");
    assert.equal(lastAssistant?.tool_calls, undefined);
  });

  it("promotes read_image output into a synthetic multimodal user message", async () => {
    let requestCount = 0;
    let secondRequest: Parameters<ModelProvider["complete"]>[0]["messages"] = [];
    const events: EventRecord[] = [];
    let committedAfterSyntheticEvent = false;
    const provider: ModelProvider = {
      name: "qwen",
      model: "vision-model",
      async complete(request) {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_image",
                type: "function",
                function: {
                  name: "read_image",
                  arguments: '{"path":"diagram.png"}',
                },
              }],
            },
          };
        }
        secondRequest = request.messages;
        return { message: { role: "assistant", content: "I inspected it.", tool_calls: [] } };
      },
    };
    const imageTool: AgentTool = {
      name: "read_image",
      mutating: false,
      definition: {
        type: "function",
        function: {
          name: "read_image",
          description: "read image",
          parameters: { type: "object" },
        },
      },
      async execute(_input, context) {
        assert.ok(context.attachImage);
        const image = await context.attachImage({
          absolutePath: path.join(process.cwd(), "diagram.png"),
          sourceName: "diagram.png",
        });
        return {
          ok: true,
          summary: `Loaded ${image.label}`,
          data: { label: image.label },
          imageAttachments: [image],
        };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [imageTool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async (event) => {
        events.push({
          ...event,
          schemaVersion: 1,
          eventId: `event_${events.length + 1}`,
          sequence: events.length + 1,
          timestamp: new Date().toISOString(),
        });
      },
      requestApproval: async () => false,
      attachImage: async ({ label }) => ({
        id: "image_00000000-0000-4000-8000-000000000000",
        label,
        mediaType: "image/png",
        storageKey:
          "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000000.png",
        sha256: "0".repeat(64),
        byteSize: 68,
        width: 16,
        height: 16,
      }),
      commitImages: async (_threadId, attachments) => {
        committedAfterSyntheticEvent =
          attachments.length === 1 &&
          events.some((event) => event.type === "message.user.synthetic");
      },
    });
    const currentState = state();

    const result = await runtime.run(currentState, "Inspect the diagram", {
      maxSteps: 3,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    const toolIndex = secondRequest.findIndex((message) => message.role === "tool");
    const imageIndex = secondRequest.findIndex(
      (message) => message.role === "user" && message.images?.length,
    );
    assert.ok(toolIndex >= 0);
    assert.ok(imageIndex > toolIndex);
    const imageMessage = secondRequest[imageIndex];
    assert.equal(imageMessage?.role, "user");
    if (imageMessage?.role === "user") {
      assert.equal(imageMessage.images?.[0]?.label, "Image #1");
    }
    const toolMessage = secondRequest[toolIndex];
    assert.equal(toolMessage?.role, "tool");
    assert.doesNotMatch(toolMessage?.content ?? "", /storageKey|base64/u);
    assert.equal(events.some((event) => event.type === "message.user.synthetic"), true);
    assert.equal(committedAfterSyntheticEvent, true);
  });

  it("discards a Qwen-incompatible read_image result without poisoning the next request", async () => {
    let requestCount = 0;
    let secondRequest: Parameters<ModelProvider["complete"]>[0]["messages"] = [];
    let discarded = false;
    let committed = false;
    const events: EventRecord[] = [];
    const provider: ModelProvider = {
      name: "qwen",
      model: "vision-model",
      async complete(request) {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_invalid_image",
                type: "function",
                function: {
                  name: "read_image",
                  arguments: '{"path":"tiny.png"}',
                },
              }],
            },
          };
        }
        secondRequest = request.messages;
        return { message: { role: "assistant", content: "Recovered.", tool_calls: [] } };
      },
    };
    const imageTool: AgentTool = {
      name: "read_image",
      mutating: false,
      definition: {
        type: "function",
        function: {
          name: "read_image",
          description: "read image",
          parameters: { type: "object" },
        },
      },
      async execute(_input, context) {
        assert.ok(context.attachImage);
        const image = await context.attachImage({
          absolutePath: path.join(process.cwd(), "tiny.png"),
          sourceName: "tiny.png",
        });
        return {
          ok: true,
          summary: `Loaded ${image.label}`,
          imageAttachments: [image],
        };
      },
    };
    const currentState = state();
    const runtime = new AgentRuntime({
      provider,
      tools: [imageTool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async (event) => {
        events.push({
          ...event,
          schemaVersion: 1,
          eventId: `event_${events.length + 1}`,
          sequence: events.length + 1,
          timestamp: new Date().toISOString(),
        });
      },
      requestApproval: async () => false,
      attachImage: async ({ label }) => ({
        id: "image_00000000-0000-4000-8000-000000000011",
        label,
        mediaType: "image/png",
        storageKey:
          "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000011.png",
        sha256: "1".repeat(64),
        byteSize: 68,
        width: 10,
        height: 16,
      }),
      discardImage: async (_threadId, attachment) => {
        discarded = attachment.label === "Image #1";
      },
      commitImages: async () => {
        committed = true;
      },
    });

    const result = await runtime.run(currentState, "Inspect the tiny image", {
      maxSteps: 2,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.equal(requestCount, 2);
    assert.equal(discarded, true);
    assert.equal(committed, false);
    assert.equal(
      currentState.messages.some((message) => message.role === "user" && message.images?.length),
      false,
    );
    assert.equal(events.some((event) => event.type === "message.user.synthetic"), false);
    assert.equal(secondRequest.some((message) => message.role === "user" && message.images?.length), false);
  });


  it("accepts an exclusive legacy model compaction intent without another paid summary", async () => {
    const current = investigationState(15_000);
    const raw = JSON.stringify(current.messages);
    const requests: Parameters<ModelProvider["complete"]>[0][] = [];
    const events: Array<{ type: string; payload: unknown }> = [];
    const result = await contextRuntime({
      name: "qwen", model: "mock", async complete(request) {
        requests.push(request);
        return requests.length === 1 ? summaryResponse("Preserve compatibility while investigating.") :
          { message: { role: "assistant", content: "done" } };
      },
    }, [new CompactContextTool()], events).run(current, "Continue the investigation", degradationOptions);
    assert.equal(result.reason, "success", result.text);
    assert.equal(requests.length, 2);
    // The parent's submission consumes attempt one without another provider call.
    assert.equal(events.filter((event) => event.type === "context.compaction.attempt").length, 1);
    assert.equal(events.filter((event) => event.type === "context.compacted").length, 1);
    assert.match(current.workingSummary, /Preserve compatibility/);
    assert.ok(current.compactedMessageCount > 0);
    assert.equal(JSON.stringify(current.messages.slice(0, 4)), raw);
    assert.match(JSON.stringify(requests[1]?.messages), /Preserve Node.js 16 support/);
    assert.ok(requests[1]?.messages.some((message) =>
      message.role === "assistant" && message.reasoning_content === "keep this exactly"));
  });

  it("keeps normal tools available below the trigger without a model-driven compaction protocol", async () => {
    const maxContextChars = 400_000;
    const input = "Continue the task at the advisory boundary.";
    const historyMarker = "ADVISORY_HISTORY_MARKER";
    const requests: Parameters<ModelProvider["complete"]>[0][] = [];
    const eventTypes: string[] = [];
    let readExecutions = 0;
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_read_at_suggestion",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              }],
            },
          };
        }
        return { message: { role: "assistant", content: "done", tool_calls: [] } };
      },
    };
    const readTool: AgentTool = {
      name: "read_file",
      mutating: false,
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "read",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
      },
      async execute() {
        readExecutions += 1;
        return { ok: true, summary: "read completed" };
      },
    };
    const currentState = state();
    primeRuntimeContextChars(
      currentState,
      input,
      MAX_ACTIVE_WORKING_SET_CHARS * 0.6,
      historyMarker,
    );
    const runtime = new AgentRuntime({
      provider,
      tools: [new CompactContextTool(), readTool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async (event) => {
        eventTypes.push(event.type);
      },
      requestApproval: async () => false,
    });

    const result = await runtime.run(currentState, input, {
      maxSteps: 2,
      maxContextChars,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.equal(readExecutions, 1);
    assert.deepEqual(
      requests[0]?.tools?.map((tool) => tool.function.name),
      ["read_file"],
    );
    const firstSystemPrompt = requests[0]?.messages[0]?.content ?? "";
    assert.equal(firstSystemPrompt, "system");
    assert.doesNotMatch(firstSystemPrompt, /RUNTIME_CONTEXT_COMPACTION_(?:REQUIRED|FORCED)/u);
    assert.equal(eventTypes.includes("message.user.synthetic"), false);
  });

  it("pauses oversized user requirements without silently dropping them or dispatching an impossible request", async () => {
    const maxContextChars = 100_000;
    const input = "Continue with the current request.";
    const currentState = state();
    currentState.messages = [{
      role: "user",
      content: `OMITTED_HISTORY_START_${"x".repeat(200_000)}_OMITTED_HISTORY_END`,
    }];
    const requests: Parameters<ModelProvider["complete"]>[0][] = [];
    const snapshots: ProviderContextSnapshot[] = [];
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        requests.push(request);
        return { message: { role: "assistant", content: "done", tool_calls: [] } };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [new CompactContextTool()],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => `system-${"s".repeat(11_000)}`,
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
      onProviderContext: (snapshot) => snapshots.push(snapshot),
    });

    const result = await runtime.run(currentState, input, {
      maxSteps: 3,
      maxContextChars,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "limit_reached", result.text);
    assert.equal(result.failure?.code, "context_capacity_exhausted");
    assert.equal(requests.length, 0);
    assert.equal(snapshots.length, 0);
    assert.equal(currentState.compactedMessageCount, 2);
    assert.ok(currentState.pressureRecovery?.serverReset);
    assert.match(currentState.messages[0]?.content ?? "", /OMITTED_HISTORY_END/);
    assert.equal(currentState.messages[1]?.content, input);
  });

  it("reports provider context snapshots from the exact captured request", async () => {
    const maxContextChars = 50_000;
    const currentState = state();
    const requests: Parameters<ModelProvider["complete"]>[0][] = [];
    const snapshots: ProviderContextSnapshot[] = [];
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        requests.push(request);
        return { message: { role: "assistant", content: "done", tool_calls: [] } };
      },
    };
    const readTool: AgentTool = {
      name: "read_file",
      mutating: false,
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a workspace file.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
      async execute() {
        return { ok: true, summary: "read" };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [readTool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "snapshot-system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
      onProviderContext: (snapshot) => snapshots.push(snapshot),
    });

    const result = await runtime.run(currentState, "capture context telemetry", {
      maxSteps: 2,
      maxContextChars,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success", result.text);
    assert.equal(requests.length, 1);
    assert.equal(snapshots.length, 1);
    const request = requests[0]!;
    const snapshot = snapshots[0]!;
    const expectedMessageChars = estimateMessagesChars(request.messages);
    const expectedToolChars = estimateToolDefinitionsChars(request.tools);
    assert.equal(snapshot.purpose, "agent_step");
    assert.equal(snapshot.actor, "main_agent");
    assert.equal(snapshot.step, 1);
    assert.equal(snapshot.attempt, 1);
    assert.equal(snapshot.actualRequest.providerMessageChars, expectedMessageChars);
    assert.equal(snapshot.actualRequest.providerToolDefinitionChars, expectedToolChars);
    assert.equal(
      snapshot.actualRequest.providerInputChars,
      expectedMessageChars + expectedToolChars,
    );
    assert.equal(snapshot.enforcedPressure, snapshot.actualRequest.pressure);
    assert.equal(snapshot.enforcedUtilization, snapshot.actualRequest.utilization);
  });


  it("uses one isolated summary at the token trigger then restores ordinary tools", async () => {
    const current = investigationState();
    const originalHistory = JSON.stringify(current.messages);
    const requests: Parameters<ModelProvider["complete"]>[0][] = [];
    const events: Array<{ type: string; payload: unknown }> = [];
    const purposes: string[] = [];
    const read: AgentTool = {
      name: "read_file", mutating: false,
      definition: { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } },
      async execute() { return { ok: true, summary: "read" }; },
    };
    const result = await contextRuntime({
      name: "qwen", model: "mock", async complete(request) {
        requests.push(request);
        return requests.length === 1 ? summaryResponse() : { message: { role: "assistant", content: "done" } };
      },
    }, [new CompactContextTool(), read], events, purposes).run(current, "Continue", degradationOptions);
    assert.equal(result.reason, "success", result.text);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.tools?.map((tool) => tool.function.name)),
      [["compact_context"], ["read_file"]]);
    assert.equal(requests[0]?.thinkingEffort, "none");
    assert.equal("maxTokens" in requests[0]!, false);
    assert.ok(requests[0]?.outputReserveTokens);
    assert.deepEqual(purposes, ["context_compaction", "agent_step"]);
    assert.equal(current.compactedMessageCount, 2);
    assert.equal(JSON.stringify(current.messages.slice(0, 4)), originalHistory);
    assert.ok(requests[1]?.messages.some((message) =>
      message.role === "assistant" && message.reasoning_content === "keep this exactly"));
    assert.match(JSON.stringify(requests[1]?.messages), /Preserve Node.js 16 support/);
    assert.equal(events.filter((event) => event.type === "context.compaction.attempt").length, 1);
    assert.equal(events.filter((event) => event.type === "context.compacted").length, 1);
    assert.equal(current.contextCompactionMetadata?.formatVersion, 2); // Provenance schema, not semantic handoff version.
    assert.equal(JSON.parse(current.workingSummary).formatVersion, 3);
    assert.equal(events.some((event) => event.type === "message.user.synthetic"), false);
  });


  it("handles higher pressure without injecting forced repair instructions into work history", async () => {
    const current = investigationState(64_000);
    const events: Array<{ type: string; payload: unknown }> = [];
    let requests = 0;
    const result = await contextRuntime({
      name: "qwen", model: "mock", async complete() {
        return ++requests === 1 ? summaryResponse() : { message: { role: "assistant", content: "done" } };
      },
    }, [new CompactContextTool()], events).run(current, "Continue", degradationOptions);
    assert.equal(result.reason, "success", result.text);
    assert.ok(current.compactedMessageCount > 0);
    assert.equal(events.filter((event) => event.type === "context.compaction.attempt").length, 1);
    assert.equal(events.some((event) => event.type === "message.user.synthetic"), false);
    assert.equal(current.messages.some((message) => message.role === "user" &&
      message.content.includes("RUNTIME_CONTEXT_COMPACTION_FORCE")), false);
    assert.equal(requests, 2);
  });


  it("never executes workspace tools returned by the isolated summarizer", async () => {
    for (const batched of [true, false]) {
      const current = investigationState();
      const requests: Parameters<ModelProvider["complete"]>[0][] = [];
      let writes = 0;
      const create: AgentTool = {
        name: "create_file", mutating: true,
        definition: { type: "function", function: { name: "create_file", description: "write sentinel", parameters: { type: "object" } } },
        async execute() { writes++; return { ok: true, summary: "written" }; },
      };
      const result = await contextRuntime({
        name: "qwen", model: "mock", async complete(request) {
          requests.push(request);
          if (requests.length === 1) {
            const response = summaryResponse();
            response.message.tool_calls = [
              ...(batched ? response.message.tool_calls ?? [] : []),
              { id: "forbidden_write", type: "function", function: { name: "create_file", arguments: "{}" } },
            ];
            return response;
          }
          return { message: { role: "assistant", content: "done" } };
        },
      }, [new CompactContextTool(), create]).run(current, "Continue", degradationOptions);
      assert.equal(result.reason, "success", result.text);
      assert.equal(writes, 0);
      assert.equal(requests.length, 4);
      assert.deepEqual(requests[0]?.tools?.map((tool) => tool.function.name), ["compact_context"]);
      assert.deepEqual(requests[3]?.tools?.map((tool) => tool.function.name), ["create_file"]);
      assert.equal(current.compactionControl?.transaction?.attempts, 3);
      assert.equal(JSON.parse(current.workingSummary).mode, "text_prefix");
      assert.equal(current.messages.some((message) => message.role === "tool" && message.name === "create_file"), false);
    }
  });

  it("rejects compact_context when it is batched with another tool", async () => {
    let requestCount = 0;
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete() {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_compact_mixed",
                  type: "function",
                  function: {
                    name: "compact_context",
                    arguments: JSON.stringify(compactionV2Input({
                      primaryRequestIndex: 0,
                      primaryRequestText: "mixed tools",
                      currentWork: "This valid summary must still be rejected because it was batched.",
                      nextStep: "Continue without compacting.",
                    })),
                  },
                },
                {
                  id: "call_read_mixed",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
          };
        }
        return { message: { role: "assistant", content: "done", tool_calls: [] } };
      },
    };
    const readTool: AgentTool = {
      name: "read_file",
      mutating: false,
      definition: {
        type: "function",
        function: { name: "read_file", description: "read", parameters: { type: "object" } },
      },
      async execute() {
        return { ok: true, summary: "read" };
      },
    };
    const currentState = state();
    const runtime = new AgentRuntime({
      provider,
      tools: [new CompactContextTool(), readTool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
    });

    await runtime.run(currentState, "mixed tools", {
      maxSteps: 3,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(currentState.workingSummary, "");
    assert.equal(currentState.compactedMessageCount, 0);
    const failedCompaction = currentState.messages.find(
      (message) => message.role === "tool" && message.name === "compact_context",
    );
    assert.match(failedCompaction?.content ?? "", /context_compaction_must_be_exclusive/u);
  });


  it("does not buy another summary after a tiny normal tool round", async () => {
    const current = investigationState();
    let requests = 0;
    const events: Array<{ type: string; payload: unknown }> = [];
    const read: AgentTool = {
      name: "read_file", mutating: false,
      definition: { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } },
      async execute() { return { ok: true, summary: "small observation" }; },
    };
    const result = await contextRuntime({
      name: "qwen", model: "mock", async complete() {
        if (++requests === 1) return summaryResponse();
        if (requests === 2) return { message: { role: "assistant", content: null, tool_calls: [{
          id: "read_after_summary", type: "function", function: { name: "read_file", arguments: "{}" },
        }] } };
        return { message: { role: "assistant", content: "done" } };
      },
    }, [new CompactContextTool(), read], events).run(current, "Continue", degradationOptions);
    assert.equal(result.reason, "success", result.text);
    assert.equal(requests, 3);
    assert.equal(events.filter((event) => event.type === "context.compaction.attempt").length, 1);
    assert.equal(events.filter((event) => event.type === "context.compacted").length, 1);
    assert.equal(current.compactedMessageCount, 2);
  });

  it("commits staged memory only after turn completion within the step budget", async () => {
    let requestCount = 0;
    let commitCount = 0;
    const eventTypes: string[] = [];
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete() {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [0, 1, 2].map((index) => ({
                id: `call_memory_${index}`,
                type: "function" as const,
                function: {
                  name: "manage_memory",
                  arguments: JSON.stringify({ action: "remember", index }),
                },
              })),
            },
          };
        }
        return { message: { role: "assistant", content: "done", tool_calls: [] } };
      },
    };
    const memoryTool: AgentTool = {
      name: "manage_memory",
      mutating: true,
      definition: {
        type: "function",
        function: {
          name: "manage_memory",
          description: "memory",
          parameters: { type: "object" },
        },
      },
      async execute(input) {
        const facts = [
          {
            category: "convention" as const,
            content: "The project always uses strict TypeScript.",
            reason: "The user established this durable convention.",
          },
          {
            category: "architecture" as const,
            content: "SQLite stores durable local data.",
            reason: "The completed implementation verifies this architecture.",
          },
          {
            category: "environment" as const,
            content: "Node.js 16.20 is the minimum runtime.",
            reason: "The package metadata verifies the supported runtime.",
          },
        ];
        const index = (input as { index: number }).index;
        const fact = facts[index];
        assert.ok(fact);
        return {
          ok: true,
          summary: `staged atomic fact ${index + 1}`,
          memoryMutation: { action: "remember" as const, ...fact },
        };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [memoryTool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async (event) => {
        eventTypes.push(event.type);
      },
      requestApproval: async () => false,
      commitMemoryMutations: async (input) => {
        commitCount += 1;
        assert.equal(eventTypes.at(-1), "turn.completed");
        assert.equal(input.outcome, "success");
        assert.equal(input.mutations.length, 3);
        return {
          applied: 3,
          memoryIds: ["memory_test_a", "memory_test_b", "memory_test_c"],
        };
      },
    });

    const result = await runtime.run(state(), "Use strict TypeScript from now on", {
      maxSteps: 2,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.equal(result.steps, 2);
    assert.equal(requestCount, 2);
    assert.equal(commitCount, 1);
    assert.ok(eventTypes.indexOf("turn.completed") < eventTypes.indexOf("memory.committed"));
  });

  it("accepts at most eight parallel atomic memory facts in one turn", async () => {
    let requestCount = 0;
    let committedMutations = 0;
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete() {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: Array.from({ length: 9 }, (_, index) => ({
                id: `call_atomic_memory_${index}`,
                type: "function" as const,
                function: {
                  name: "manage_memory" as const,
                  arguments: JSON.stringify({ index }),
                },
              })),
            },
          };
        }
        return { message: { role: "assistant", content: "done", tool_calls: [] } };
      },
    };
    const memoryTool: AgentTool = {
      name: "manage_memory",
      mutating: true,
      definition: {
        type: "function",
        function: {
          name: "manage_memory",
          description: "memory",
          parameters: { type: "object" },
        },
      },
      async execute(input) {
        const index = (input as { index: number }).index;
        return {
          ok: true,
          summary: `staged fact ${index}`,
          memoryMutation: {
            action: "remember",
            category: "convention",
            content: `Atomic memory fact number ${index}.`,
            reason: `Verified evidence for atomic fact ${index}.`,
          },
        };
      },
    };
    const currentState = state();
    const runtime = new AgentRuntime({
      provider,
      tools: [memoryTool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
      commitMemoryMutations: async (input) => {
        committedMutations = input.mutations.length;
        return {
          applied: input.mutations.length,
          memoryIds: input.mutations.map((_, index) => `memory_${index}`),
        };
      },
    });

    const result = await runtime.run(currentState, "Remember the verified conventions", {
      maxSteps: 2,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.equal(committedMutations, 8);
    assert.equal(
      currentState.messages.some(
        (message) =>
          message.role === "tool" && message.content.includes("memory_mutation_limit_reached"),
      ),
      true,
    );
  });

  it("persists a synthetic final reply before completing a turn", async () => {
    const eventTypes: string[] = [];
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete() {
        throw new Error("provider unavailable");
      },
    };
    const currentState = state();
    const runtime = new AgentRuntime({
      provider,
      tools: [],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async (event) => {
        eventTypes.push(event.type);
      },
      requestApproval: async () => false,
    });

    const result = await runtime.run(currentState, "Inspect the project", {
      maxSteps: 1,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "failed");
    const finalAssistantIndex = eventTypes.lastIndexOf("message.assistant");
    const turnCompletedIndex = eventTypes.indexOf("turn.completed");
    assert.ok(finalAssistantIndex >= 0);
    assert.ok(finalAssistantIndex < turnCompletedIndex);
    assert.equal(currentState.messages.at(-1)?.role, "assistant");
  });

  it("discards staged memory when a later model step fails", async () => {
    let requestCount = 0;
    let commitCount = 0;
    const eventTypes: string[] = [];
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete() {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_memory_before_failure",
                type: "function",
                function: { name: "manage_memory", arguments: "{}" },
              }],
            },
          };
        }
        throw new Error("provider failed after staging memory");
      },
    };
    const memoryTool: AgentTool = {
      name: "manage_memory",
      mutating: true,
      definition: {
        type: "function",
        function: {
          name: "manage_memory",
          description: "memory",
          parameters: { type: "object" },
        },
      },
      async execute() {
        return {
          ok: true,
          summary: "staged",
          memoryMutation: {
            action: "remember",
            category: "environment",
            content: "The project uses Node.js 20 in production.",
            reason: "Verified from the repository configuration.",
          },
        };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [memoryTool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async (event) => {
        eventTypes.push(event.type);
      },
      requestApproval: async () => false,
      commitMemoryMutations: async () => {
        commitCount += 1;
        return { applied: 1, memoryIds: ["must_not_commit"] };
      },
    });

    const result = await runtime.run(state(), "Inspect the environment", {
      maxSteps: 2,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "failed");
    assert.equal(commitCount, 0);
    assert.ok(eventTypes.includes("memory.discarded"));
    assert.ok(eventTypes.indexOf("turn.completed") < eventTypes.indexOf("memory.discarded"));
  });
});
