import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import { ContextManager } from "../src/context/manager.js";
import type {
  AgentTool,
  ModelProvider,
  ProviderResponse,
  SessionState,
  ToolExecutionResult
} from "../src/core/types.js";
import { AgentRuntime } from "../src/runtime/agent.js";

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
    createdAt: now,
    updatedAt: now
  };
}

describe("AgentRuntime", () => {
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
    const tools = ["read_file", "create_file", "update_file", "run_command"].map(
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

    assert.deepEqual(seenToolNames, ["read_file", "run_command"]);
  });
});
