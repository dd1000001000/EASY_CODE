import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import { ContextManager } from "../src/context/manager.js";
import type { SessionState } from "../src/core/types.js";

function contextChars(messages: ReturnType<ContextManager["build"]>): number {
  return messages.reduce((total, message) => {
    const toolCalls = message.role === "assistant" && message.tool_calls
      ? JSON.stringify(message.tool_calls).length
      : 0;
    return total + (message.content?.length ?? 0) + toolCalls + 32;
  }, 0);
}

function makeState(): SessionState {
  const now = new Date().toISOString();
  return {
    threadId: "thread_context",
    mode: "code",
    provider: "qwen",
    model: "mock",
    workspaceRoot: process.cwd(),
    constraints: [],
    messages: Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message-${index}-${"x".repeat(300)}`
    })),
    filesRead: new Map(),
    changes: [],
    commands: [],
    workingSummary: "",
    createdAt: now,
    updatedAt: now
  };
}

describe("ContextManager", () => {
  it("compacts old messages and keeps recent messages", () => {
    const state = makeState();
    const context = new ContextManager().build({
      systemPrompt: "system",
      state,
      maxContextChars: 5_000
    });

    assert.deepEqual(context[0], { role: "system", content: "system" });
    assert.equal(context.some((message) => message.content?.includes("message-29")), true);
    assert.ok(state.workingSummary.length > 0);
    assert.ok(contextChars(context) <= 5_000);

    const firstSummary = state.workingSummary;
    const second = new ContextManager().build({
      systemPrompt: "system",
      state,
      maxContextChars: 5_000
    });
    assert.equal(state.workingSummary, firstSummary);
    assert.ok(contextChars(second) <= 5_000);
  });

  it("bounds an oversized latest message and system prompt", () => {
    const state = makeState();
    state.messages.push({ role: "user", content: "latest-" + "y".repeat(20_000) });
    const context = new ContextManager().build({
      systemPrompt: "rules-" + "z".repeat(20_000),
      state,
      maxContextChars: 4_096
    });

    assert.ok(contextChars(context) <= 4_096);
    assert.equal(context.some((message) => message.content?.includes("latest-")), true);
  });
});
