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
    thinkingEffort: "medium",
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
    compactedMessageCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

describe("ContextManager", () => {
  it("applies a bounded overflow fallback without mutating model-owned summary state", () => {
    const state = makeState();
    const context = new ContextManager().build({
      systemPrompt: "system",
      state,
      maxContextChars: 5_000
    });

    assert.deepEqual(context[0], { role: "system", content: "system" });
    assert.equal(context.some((message) => message.content?.includes("message-29")), true);
    assert.equal(
      context.some((message) =>
        message.content?.includes("Automatic overflow fallback for later messages"),
      ),
      true,
    );
    assert.equal(state.workingSummary, "");
    assert.equal(state.compactedMessageCount, 0);
    assert.ok(contextChars(context) <= 5_000);

    const second = new ContextManager().build({
      systemPrompt: "system",
      state,
      maxContextChars: 5_000
    });
    assert.equal(state.workingSummary, "");
    assert.ok(contextChars(second) <= 5_000);
  });

  it("uses a persistent model summary and never revives messages before its boundary", () => {
    const state = makeState();
    const manager = new ContextManager();
    const summary = "Objective: keep the model summary. Next step: inspect message 20.";
    manager.applyModelCompaction(state, summary, 20);

    const first = manager.build({
      systemPrompt: "system",
      state,
      maxContextChars: 5_000,
    });
    const second = manager.build({
      systemPrompt: "system",
      state,
      maxContextChars: 5_000,
    });

    for (const context of [first, second]) {
      assert.equal(context.some((message) => message.content?.includes(summary)), true);
      assert.equal(context.some((message) => message.content?.includes("message-0-")), false);
      assert.equal(context.some((message) => message.content?.includes("message-20-")), true);
      assert.equal(context.some((message) => message.content?.includes("message-29-")), true);
      assert.ok(contextChars(context) <= 5_000);
    }
    assert.equal(state.workingSummary, summary);
    assert.equal(state.compactedMessageCount, 20);
  });

  it("advances compaction monotonically and redacts secrets", () => {
    const state = makeState();
    const manager = new ContextManager();
    manager.applyModelCompaction(state, "First cumulative summary", 10);
    manager.applyModelCompaction(
      state,
      "Second summary with api_key=super-secret-value and the latest decisions",
      24,
    );

    assert.equal(state.compactedMessageCount, 24);
    assert.doesNotMatch(state.workingSummary, /super-secret-value/u);
    assert.throws(
      () => manager.applyModelCompaction(state, "invalid backwards move", 23),
      /boundary is invalid/u,
    );
    assert.equal(state.compactedMessageCount, 24);
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

  it("keeps image references beyond the former five-image context limit", () => {
    const state = makeState();
    state.messages = Array.from({ length: 7 }, (_, index) => {
      const ordinal = index + 1;
      const id = `image_00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
      return {
        role: "user" as const,
        content: `turn ${ordinal}`,
        images: [{
          id,
          label: "Image #1",
          mediaType: "image/png" as const,
          storageKey: `attachments/00000000000000000000000000000000/${id}.png`,
          sha256: String(ordinal).repeat(64).slice(0, 64),
          byteSize: 68,
          width: 1,
          height: 1,
        }],
      };
    });

    const context = new ContextManager().build({
      systemPrompt: "system",
      state,
      maxContextChars: 50_000,
    });
    const ids = context.flatMap((message) =>
      message.role === "user" ? message.images?.map((image) => image.id) ?? [] : [],
    );
    assert.equal(ids.length, 7);
    assert.equal(ids[0]?.endsWith("000000000001"), true);
    assert.equal(ids.at(-1)?.endsWith("000000000007"), true);
    assert.equal(
      context.some((message) => message.content?.includes("older image attachment")),
      false,
    );
    assert.equal(
      state.messages.reduce(
        (total, message) => total + (message.role === "user" ? message.images?.length ?? 0 : 0),
        0,
      ),
      7,
    );
  });

  it("preserves the latest image when the text budget is very small", () => {
    const state = makeState();
    const id = "image_00000000-0000-4000-8000-000000000099";
    state.messages = [{
      role: "user",
      content: "latest-" + "x".repeat(20_000),
      images: [{
        id,
        label: "Image #1",
        mediaType: "image/png",
        storageKey: `attachments/00000000000000000000000000000000/${id}.png`,
        sha256: "9".repeat(64),
        byteSize: 1_024,
        width: 32,
        height: 32,
      }],
    }];

    const context = new ContextManager().build({
      systemPrompt: "system",
      state,
      maxContextChars: 1_024,
    });
    const latest = context.find((message) => message.role === "user" && message.images?.length);
    assert.equal(latest?.role, "user");
    if (latest?.role === "user") assert.equal(latest.images?.[0]?.id, id);
    assert.ok(contextChars(context) <= 1_024);
  });

  it("caps historical image context by combined bytes and reports image estimates", () => {
    const state = makeState();
    state.messages = Array.from({ length: 3 }, (_, index) => {
      const ordinal = index + 1;
      const id = `image_00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
      return {
        role: "user" as const,
        content: `image turn ${ordinal}`,
        images: [{
          id,
          label: "Image #1",
          mediaType: "image/png" as const,
          storageKey: `attachments/00000000000000000000000000000000/${id}.png`,
          sha256: String(ordinal).repeat(64).slice(0, 64),
          byteSize: 10 * 1024 * 1024,
          width: 4_000,
          height: 4_000,
        }],
      };
    });

    const manager = new ContextManager();
    const context = manager.build({ systemPrompt: "system", state, maxContextChars: 50_000 });
    const images = context.flatMap((message) =>
      message.role === "user" ? message.images ?? [] : [],
    );
    assert.equal(images.length, 2);
    assert.equal(images[0]?.id.endsWith("000000000002"), true);
    assert.equal(images[1]?.id.endsWith("000000000003"), true);

    const inspection = manager.inspect(state, 50_000);
    assert.equal(inspection.imageCount, 3);
    assert.equal(inspection.imageBytes, 30 * 1024 * 1024);
    assert.ok(inspection.estimatedVisionTokens > 0);
  });
});
