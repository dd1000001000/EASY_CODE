import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { Terminal } from "../src/cli/terminal.js";
import { ContextManager } from "../src/context/manager.js";
import type { ModelProvider, SessionState } from "../src/core/types.js";
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
                content: '{"route":"direct_code","reason":"Scoped change."}',
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
