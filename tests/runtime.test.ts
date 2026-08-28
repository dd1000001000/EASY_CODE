import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "./harness.js";
import { ContextManager } from "../src/context/manager.js";
import type {
  AgentTool,
  EventRecord,
  ImageAttachment,
  ModelProvider,
  ProviderResponse,
  SessionState,
  ToolExecutionResult
} from "../src/core/types.js";
import { AgentRuntime } from "../src/runtime/agent.js";
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

describe("AgentRuntime", () => {
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

  it("exposes only plan-safe tools and automatic memory maintenance in plan mode", async () => {
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
      "run_command",
      "propose_plan",
      "compact_context",
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
      buildSystemPrompt: async ({ taskGraph }) => {
        promptGraphStatuses.push(taskGraph?.status ?? "none");
        return "system";
      },
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

    assert.equal(result.reason, "success");
    assert.equal(result.text, "DAG work is complete");
    assert.equal(requestCount, 8);
    assert.equal(readExecutions, 1);
    assert.equal(sawRuntimeReminder, true);
    assert.equal(currentState.taskGraph?.status, "completed");
    assert.equal(currentState.taskGraph?.tasks[0]?.status, "completed");
    assert.equal(promptGraphStatuses.includes("active"), true);
    assert.equal(promptGraphStatuses.at(-1), "completed");
    const graphEvents = events.filter((event) => {
      if (event.type !== "tool.result" || !event.payload || typeof event.payload !== "object") {
        return false;
      }
      return "taskGraph" in event.payload;
    });
    assert.equal(graphEvents.length, 3);
    assert.equal(
      currentState.messages.some(
        (message) => message.role === "tool" &&
          message.content.includes("Start one unblocked DAG task"),
      ),
      true,
    );
    assert.equal(
      currentState.messages.some(
        (message) => message.role === "tool" &&
          message.content.includes("completed in this turn"),
      ),
      true,
    );
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
      maxSteps: 3,
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

  it("uses one finalization step when the final task completes at the limit", async () => {
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

    assert.equal(result.reason, "success");
    assert.equal(result.steps, 4);
    assert.equal(
      result.text,
      "The task DAG completed all declared tasks and completion checks.",
    );
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

  it("lets the model replace earlier context with a cumulative summary", async () => {
    const originalPrompt = "ORIGINAL_USER_PROMPT_MARKER";
    const modelSummary =
      "Objective: finish the current task. Constraints: preserve Node.js 16. Next step: answer.";
    let requestCount = 0;
    let secondRequestMessages: Parameters<ModelProvider["complete"]>[0]["messages"] = [];
    const events: EventRecord[] = [];
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_compact",
                type: "function",
                function: {
                  name: "compact_context",
                  arguments: JSON.stringify({ summary: modelSummary }),
                },
              }],
            },
          };
        }
        secondRequestMessages = request.messages;
        return { message: { role: "assistant", content: "done", tool_calls: [] } };
      },
    };
    const currentState = state();
    const runtime = new AgentRuntime({
      provider,
      tools: [new CompactContextTool()],
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
    });

    const result = await runtime.run(currentState, originalPrompt, {
      maxSteps: 3,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.equal(currentState.workingSummary, modelSummary);
    assert.equal(currentState.compactedMessageCount, 3);
    assert.equal(currentState.messages.some((message) => message.content === originalPrompt), true);
    const storedToolResult = currentState.messages.find(
      (message) => message.role === "tool" && message.name === "compact_context",
    );
    assert.ok(storedToolResult?.content);
    assert.doesNotMatch(storedToolResult.content, /preserve Node\.js 16/u);
    assert.equal(
      secondRequestMessages.some((message) => message.content?.includes(modelSummary)),
      true,
    );
    assert.equal(
      secondRequestMessages.some((message) => message.content === originalPrompt),
      false,
    );
    assert.equal(secondRequestMessages.some((message) => message.role === "tool"), false);
    assert.equal(events.some((event) => event.type === "context.compacted"), true);
  });

  it("advises compaction at exactly 60% while keeping normal tools available", async () => {
    const maxContextChars = 20_000;
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
      maxContextChars * 0.6,
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
      ["compact_context", "read_file"],
    );
    const firstSystemPrompt = requests[0]?.messages[0]?.content ?? "";
    assert.match(firstSystemPrompt, /RUNTIME_CONTEXT_PRESSURE/u);
    assert.doesNotMatch(firstSystemPrompt, /RUNTIME_CONTEXT_COMPACTION_(?:REQUIRED|FORCED)/u);
    assert.equal(eventTypes.includes("message.user.synthetic"), false);
  });

  it("requires compaction at exactly 80% and restores normal tools afterward", async () => {
    const maxContextChars = 20_000;
    const input = "Continue after reducing the active context.";
    const historyMarker = "REQUIRED_OLD_HISTORY_MARKER";
    const modelSummary = "Objective: continue safely. Next step: return the verified result.";
    const requests: Parameters<ModelProvider["complete"]>[0][] = [];
    const promptToolNames: string[][] = [];
    const usagePurposes: string[] = [];
    const events: EventRecord[] = [];
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
                id: "call_required_compaction",
                type: "function",
                function: {
                  name: "compact_context",
                  arguments: JSON.stringify({ summary: modelSummary }),
                },
              }],
            },
            usage: { promptTokens: 40, completionTokens: 8, totalTokens: 48 },
          };
        }
        return {
          message: { role: "assistant", content: "done", tool_calls: [] },
          usage: { promptTokens: 12, completionTokens: 2, totalTokens: 14 },
        };
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
    primeRuntimeContextChars(
      currentState,
      input,
      maxContextChars * 0.8,
      historyMarker,
    );
    const runtime = new AgentRuntime({
      provider,
      tools: [new CompactContextTool(), readTool],
      contextManager: new ContextManager(),
      buildSystemPrompt: async ({ toolNames }) => {
        promptToolNames.push([...toolNames]);
        return "system";
      },
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
      onModelUsage: async (record) => {
        usagePurposes.push(record.purpose);
      },
      requestApproval: async () => false,
    });

    const result = await runtime.run(currentState, input, {
      maxSteps: 1,
      maxContextChars,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests[0]?.tools?.map((tool) => tool.function.name),
      ["compact_context"],
    );
    assert.deepEqual(promptToolNames[0], ["compact_context"]);
    assert.match(
      requests[0]?.messages[0]?.content ?? "",
      /RUNTIME_CONTEXT_COMPACTION_REQUIRED/u,
    );
    assert.deepEqual(
      requests[1]?.tools?.map((tool) => tool.function.name),
      ["compact_context", "read_file"],
    );
    assert.deepEqual(promptToolNames[1], ["compact_context", "read_file"]);
    assert.deepEqual(usagePurposes, ["context_compaction", "agent_step"]);
    assert.equal(
      requests[1]?.messages.some((message) => message.content?.includes(modelSummary)),
      true,
    );
    assert.equal(
      requests[1]?.messages.some((message) => message.content?.includes(historyMarker)),
      false,
    );
    assert.equal(requests[1]?.messages.some((message) => message.role === "tool"), false);
    assert.equal(currentState.workingSummary, modelSummary);
    assert.equal(currentState.compactedMessageCount, 4);
    assert.equal(currentState.compactedMessageCount, currentState.messages.length - 1);
    const compactionEvent = events.find((event) => event.type === "context.compacted");
    assert.ok(compactionEvent);
    assert.deepEqual(compactionEvent.payload, {
      summary: modelSummary,
      compactedMessageCount: 4,
      summaryChars: modelSummary.length,
    });
    assert.equal(events.some((event) => event.type === "message.user.synthetic"), false);
    assert.equal(
      new ContextManager().inspect(currentState, maxContextChars).pressure,
      "normal",
    );
  });

  it("inserts and persists a forced compaction request at exactly 90%", async () => {
    const maxContextChars = 20_000;
    const input = "Continue at the forced compaction boundary.";
    const historyMarker = "FORCED_OLD_HISTORY_MARKER";
    const modelSummary = "Objective: continue after forced compaction. Next step: answer.";
    const requests: Parameters<ModelProvider["complete"]>[0][] = [];
    const events: EventRecord[] = [];
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
                id: "call_forced_compaction",
                type: "function",
                function: {
                  name: "compact_context",
                  arguments: JSON.stringify({ summary: modelSummary }),
                },
              }],
            },
          };
        }
        return { message: { role: "assistant", content: "done", tool_calls: [] } };
      },
    };
    const currentState = state();
    primeRuntimeContextChars(
      currentState,
      input,
      maxContextChars * 0.9,
      historyMarker,
    );
    const runtime = new AgentRuntime({
      provider,
      tools: [new CompactContextTool()],
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
    });

    const result = await runtime.run(currentState, input, {
      maxSteps: 1,
      maxContextChars,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.deepEqual(
      requests[0]?.tools?.map((tool) => tool.function.name),
      ["compact_context"],
    );
    assert.match(
      requests[0]?.messages[0]?.content ?? "",
      /RUNTIME_CONTEXT_COMPACTION_FORCED/u,
    );
    assert.equal(
      requests[0]?.messages.some((message) =>
        message.content?.includes("RUNTIME_CONTEXT_COMPACTION_FORCE"),
      ),
      true,
    );
    assert.equal(
      requests[1]?.messages.some((message) =>
        message.content?.includes("RUNTIME_CONTEXT_COMPACTION_FORCE"),
      ),
      false,
    );
    assert.equal(
      currentState.messages.some((message) =>
        message.role === "user" &&
        message.content.includes("RUNTIME_CONTEXT_COMPACTION_FORCE"),
      ),
      true,
    );
    assert.equal(currentState.compactedMessageCount, 5);
    assert.equal(currentState.compactedMessageCount, currentState.messages.length - 1);
    assert.equal(
      events.some((event) =>
        event.type === "message.user.synthetic" &&
        JSON.stringify(event.payload).includes("RUNTIME_CONTEXT_COMPACTION_FORCE"),
      ),
      true,
    );
  });

  it("blocks batched or incorrect tools from causing side effects at 80%", async () => {
    const maxContextChars = 20_000;
    const scenarios = [
      {
        name: "batched compact_context and create_file",
        calls: [
          {
            id: "call_blocked_compaction",
            type: "function" as const,
            function: {
              name: "compact_context",
              arguments: JSON.stringify({ summary: "This summary must not be applied." }),
            },
          },
          {
            id: "call_blocked_create",
            type: "function" as const,
            function: { name: "create_file", arguments: "{}" },
          },
        ],
      },
      {
        name: "incorrect create_file call",
        calls: [{
          id: "call_incorrect_create",
          type: "function" as const,
          function: { name: "create_file", arguments: "{}" },
        }],
      },
    ];

    for (const scenario of scenarios) {
      const input = `Continue after ${scenario.name}.`;
      const recoveredSummary = `Recovered safely after ${scenario.name}.`;
      const requests: Parameters<ModelProvider["complete"]>[0][] = [];
      let sideEffectExecutions = 0;
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
                tool_calls: scenario.calls,
              },
            };
          }
          if (requests.length === 2) {
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "call_recovery_compaction",
                  type: "function",
                  function: {
                    name: "compact_context",
                    arguments: JSON.stringify({ summary: recoveredSummary }),
                  },
                }],
              },
            };
          }
          return { message: { role: "assistant", content: "done", tool_calls: [] } };
        },
      };
      const sideEffectTool: AgentTool = {
        name: "create_file",
        mutating: true,
        definition: {
          type: "function",
          function: {
            name: "create_file",
            description: "side-effect sentinel",
            parameters: { type: "object" },
          },
        },
        async execute() {
          sideEffectExecutions += 1;
          return { ok: true, summary: "side effect executed" };
        },
      };
      const currentState = state();
      primeRuntimeContextChars(
        currentState,
        input,
        maxContextChars * 0.8,
        `BLOCKED_SIDE_EFFECT_HISTORY_${scenario.name}`,
      );
      const runtime = new AgentRuntime({
        provider,
        tools: [new CompactContextTool(), sideEffectTool],
        contextManager: new ContextManager(),
        buildSystemPrompt: async () => "system",
        getWorkspaceSummary: async () => "workspace",
        searchMemories: async () => [],
        appendEvent: async () => undefined,
        requestApproval: async () => false,
      });

      const result = await runtime.run(currentState, input, {
        maxSteps: 3,
        maxContextChars,
        maxOutputChars: 4_000,
        commandTimeoutMs: 1_000,
        approvalPolicy: "never",
      });

      assert.equal(result.reason, "success", scenario.name);
      assert.equal(sideEffectExecutions, 0, scenario.name);
      assert.deepEqual(
        requests[0]?.tools?.map((tool) => tool.function.name),
        ["compact_context"],
        scenario.name,
      );
      assert.deepEqual(
        requests[1]?.tools?.map((tool) => tool.function.name),
        ["compact_context"],
        scenario.name,
      );
      assert.deepEqual(
        requests[2]?.tools?.map((tool) => tool.function.name),
        ["compact_context", "create_file"],
        scenario.name,
      );
      const blockedResults = currentState.messages.filter(
        (message) =>
          message.role === "tool" &&
          (message.name === "create_file" || message.name === "compact_context") &&
          message.content.includes("context_compaction_required"),
      );
      assert.equal(blockedResults.length, scenario.calls.length, scenario.name);
      assert.equal(currentState.workingSummary, recoveredSummary, scenario.name);
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
                    arguments: JSON.stringify({ summary: "This must not be applied." }),
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
    assert.match(failedCompaction?.content ?? "", /compact_context_must_be_exclusive/u);
  });

  it("rejects repeated compaction when no new history exists", async () => {
    let requestCount = 0;
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete() {
        requestCount += 1;
        if (requestCount <= 2) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `call_compact_${requestCount}`,
                type: "function",
                function: {
                  name: "compact_context",
                  arguments: JSON.stringify({
                    summary: requestCount === 1 ? "Accepted summary" : "Must not replace it",
                  }),
                },
              }],
            },
          };
        }
        return { message: { role: "assistant", content: "done", tool_calls: [] } };
      },
    };
    const currentState = state();
    const runtime = new AgentRuntime({
      provider,
      tools: [new CompactContextTool()],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [],
      appendEvent: async () => undefined,
      requestApproval: async () => false,
    });

    await runtime.run(currentState, "compact once", {
      maxSteps: 3,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(currentState.workingSummary, "Accepted summary");
    assert.equal(currentState.compactedMessageCount, 3);
    assert.equal(
      currentState.messages.some(
        (message) =>
          message.role === "tool" && message.content.includes("no_new_context_to_compact"),
      ),
      true,
    );
  });

  it("reserves a final response step and commits staged memory only after turn completion", async () => {
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
      maxSteps: 1,
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
      maxSteps: 1,
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
