import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { Terminal } from "../src/cli/terminal.js";
import { ContextManager } from "../src/context/manager.js";
import type {
  AgentTool,
  ModelProvider,
  SessionState,
  ToolExecutionResult,
} from "../src/core/types.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { describe, it } from "./harness.js";

class TtyOutput extends PassThrough {
  readonly isTTY = true;
}

async function withoutAnimationSuppressors<T>(
  action: () => T | Promise<T>,
): Promise<T> {
  const previousCi = process.env.CI;
  const previousTerm = process.env.TERM;
  const previousNoColor = process.env.NO_COLOR;
  try {
    delete process.env.CI;
    delete process.env.TERM;
    process.env.NO_COLOR = "1";
    return await action();
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
}

function runtimeState(mode: "auto" | "code"): SessionState {
  const now = new Date().toISOString();
  return {
    threadId: "thread_loading_indicator",
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

function runtimeFor(
  provider: ModelProvider,
  lifecycle: string[],
): AgentRuntime {
  return new AgentRuntime({
    provider,
    tools: [],
    contextManager: new ContextManager(),
    buildSystemPrompt: async () => "system",
    getWorkspaceSummary: async () => "workspace",
    searchMemories: async () => [],
    appendEvent: async () => undefined,
    requestApproval: async () => false,
    onModelRequestStart: (text) => lifecycle.push(`start:${text}`),
    onModelRequestEnd: () => lifecycle.push("end"),
  });
}

describe("model request loading indicator", () => {
  it("wraps both Auto routing and the main agent request", async () => {
    let requestCount = 0;
    const lifecycle: string[] = [];
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete() {
        requestCount += 1;
        return requestCount === 1
          ? {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "call_select_mode",
                  type: "function",
                  function: {
                    name: "select_mode",
                    arguments: '{"mode":"code","reason":"Scoped change."}',
                  },
                }],
              },
            }
          : {
              message: {
                role: "assistant",
                content: "done",
                tool_calls: [],
              },
            };
      },
    };
    const runtime = runtimeFor(provider, lifecycle);

    const result = await runtime.run(runtimeState("auto"), "Make the change", {
      maxSteps: 2,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.deepEqual(lifecycle, [
      "start:Waiting for mock-model response",
      "end",
      "start:Waiting for mock-model response",
      "end",
    ]);
  });

  it("clears the request activity when the provider rejects", async () => {
    const lifecycle: string[] = [];
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete() {
        throw new Error("offline");
      },
    };
    const runtime = runtimeFor(provider, lifecycle);

    const result = await runtime.run(runtimeState("code"), "Make the change", {
      maxSteps: 1,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "failed");
    assert.match(result.text, /offline/u);
    assert.deepEqual(lifecycle, [
      "start:Waiting for mock-model response",
      "end",
    ]);
  });

  it("times tool execution and disables run_command after sandbox initialization fails", async () => {
    let requestCount = 0;
    let executionCount = 0;
    let directResponse = false;
    const advertisedTools: string[][] = [];
    const lifecycle: string[] = [];
    const provider: ModelProvider = {
      name: "deepseek",
      model: "mock-model",
      async complete(request) {
        requestCount += 1;
        advertisedTools.push((request.tools ?? []).map((tool) => tool.function.name));
        if (directResponse) {
          return {
            message: { role: "assistant", content: "fresh turn", tool_calls: [] },
          };
        }
        if (requestCount <= 2) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `call_run_${requestCount}`,
                type: "function",
                function: {
                  name: "run_command",
                  arguments: '{"program":"node","intent":"inspect"}',
                },
              }],
            },
          };
        }
        return {
          message: { role: "assistant", content: "verification blocked", tool_calls: [] },
        };
      },
    };
    const tool: AgentTool = {
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
      async execute(): Promise<ToolExecutionResult> {
        executionCount += 1;
        return {
          ok: false,
          summary: "OS sandbox initialization failed; do not retry",
          error: "sandbox unavailable",
          data: { status: "sandbox_unavailable" },
        };
      },
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
      onToolExecutionStart: (name) => {
        lifecycle.push(`tool-start:${name}`);
        return "tool-token";
      },
      onToolExecutionEnd: (name, token) => {
        lifecycle.push(`tool-end:${name}:${String(token)}`);
      },
    });

    const result = await runtime.run(runtimeState("code"), "Verify the project", {
      maxSteps: 3,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.equal(executionCount, 1);
    assert.equal(advertisedTools[0]?.includes("run_command"), true);
    assert.equal(advertisedTools[1]?.includes("run_command"), false);
    assert.equal(advertisedTools[2]?.includes("run_command"), false);
    assert.deepEqual(lifecycle, [
      "tool-start:run_command",
      "tool-end:run_command:tool-token",
    ]);

    // The breaker belongs to one AgentRuntime.run call (one user turn), not to
    // the reusable CommandRuntime or the next user request.
    directResponse = true;
    advertisedTools.length = 0;
    const nextTurn = await runtime.run(runtimeState("code"), "Try again", {
      maxSteps: 1,
      maxContextChars: 20_000,
      maxOutputChars: 4_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });
    assert.equal(nextTurn.reason, "success");
    assert.equal(advertisedTools[0]?.includes("run_command"), true);
  });

  it("shows a TTY spinner and clears it without adding a blank line", async () => {
    await withoutAnimationSuppressors(() => {
      const input = new PassThrough();
      const output = new TtyOutput();
      output.setEncoding("utf8");
      let transcript = "";
      output.on("data", (chunk: string) => {
        transcript += chunk;
      });
      const terminal = new Terminal(input, output);

      terminal.startActivity("Waiting for mock-model response");
      assert.match(transcript, /⠋ Waiting for mock-model response · 0s/u);
      terminal.stopActivity();
      assert.ok(transcript.endsWith("\r\u001B[2K"));
      terminal.close();
    });
  });

  it("stops the spinner before writing regular terminal output", async () => {
    await withoutAnimationSuppressors(async () => {
      const input = new PassThrough();
      const output = new TtyOutput();
      output.setEncoding("utf8");
      let transcript = "";
      output.on("data", (chunk: string) => {
        transcript += chunk;
      });
      const terminal = new Terminal(input, output);

      terminal.startActivity("Waiting for a response");
      terminal.info("Tool: read_file");
      const settledTranscript = transcript;
      await new Promise((resolve) => setTimeout(resolve, 120));

      assert.equal(transcript, settledTranscript);
      assert.match(transcript, /\r\u001B\[2KTool: read_file\n$/u);
      terminal.close();
    });
  });

  it("does not emit animated control sequences for non-TTY output", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    const terminal = new Terminal(input, output);

    terminal.startActivity("Waiting for a response");
    terminal.stopActivity();

    assert.equal(transcript, "");
    terminal.close();
  });
});
