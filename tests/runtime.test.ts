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
import { CompactContextTool } from "../src/tools/compact-context.js";

function state(mode: "plan" | "auto" | "code" = "code"): SessionState {
  const now = new Date().toISOString();
  return {
    threadId: "thread_test",
    mode,
    provider: "qwen",
    model: "mock",
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

describe("AgentRuntime", () => {
  it("continues text-only turns after the thread reaches Image #999", async () => {
    let requestCount = 0;
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        requestCount += 1;
        assert.deepEqual(request.currentTurnImageIds, []);
        return { message: { role: "assistant", content: "Text still works.", tool_calls: [] } };
      },
    };
    const currentState = state();
    currentState.messages.push({
      role: "user",
      content: "historical image",
      images: [{
        id: "image_00000000-0000-4000-8000-000000000999",
        label: "Image #999",
        mediaType: "image/png",
        storageKey:
          "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000999.png",
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
        if (requestCount === 1) {
          assert.equal(imageCommittedBeforeRouting, true);
          routerSawImage = request.messages.some(
            (message) => message.role === "user" && message.images?.[0]?.id === image.id,
          );
          return {
            message: {
              role: "assistant",
              content: '{"route":"direct_code","reason":"The screenshot identifies a scoped fix."}',
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

  it("does not expose mutating tools in plan mode", async () => {
    let seenToolNames: string[] = [];
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        seenToolNames = request.tools?.map((tool) => tool.function.name) ?? [];
        return { message: { role: "assistant", content: "计划", tool_calls: [] } };
      }
    };
    const tools = ["read_file", "read_image", "create_file", "update_file", "run_command", "compact_context"].map(
      (name): AgentTool => ({
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

    assert.deepEqual(seenToolNames, ["read_file", "read_image", "run_command", "compact_context"]);
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
});
