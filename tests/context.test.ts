import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import {
  ContextManager,
  MAX_ACTIVE_WORKING_SET_CHARS,
  activeWorkingSetCharBudget,
  contextPressureLevel,
  estimateMessagesChars,
  estimateTextTokens,
  estimateToolDefinitionsChars,
} from "../src/context/manager.js";
import type { SessionState, ToolDefinition } from "../src/core/types.js";

function contextChars(messages: ReturnType<ContextManager["build"]>): number {
  return estimateMessagesChars(messages);
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
    commandApprovalPrefixes: [],
    workingSummary: "",
    compactedMessageCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

describe("ContextManager", () => {
  it("keeps the complete view until Runtime commits retirement, even above the working budget", () => {
    const state = makeState();
    state.messages = Array.from({ length: 360 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `rolling-message-${index}-${"x".repeat(1_000)}`,
    }));
    const manager = new ContextManager();
    const boundary = manager.retrievalBoundary(state, 1_600_000);
    const context = manager.build({
      systemPrompt: "system",
      state,
      maxContextChars: 1_600_000,
    });

    assert.equal(boundary, state.compactedMessageCount);
    assert.equal(context.some((message) => message.content?.includes("rolling-message-0-")), true);
    assert.equal(context.some((message) => message.content?.includes("rolling-message-359-")), true);
    assert.ok(contextChars(context) > MAX_ACTIVE_WORKING_SET_CHARS);
  });

  it("does not move the retrieval boundary for artificial system reservations", () => {
    const state = makeState();
    const manager = new ContextManager();
    const systemPrompt = `system-${"s".repeat(1_200)}`;
    const reservedSystemPromptChars = 4_000;
    const boundary = manager.retrievalBoundary(
      state,
      5_000,
      systemPrompt,
      reservedSystemPromptChars,
    );
    const context = manager.build({
      systemPrompt,
      state,
      maxContextChars: 5_000,
      reservedSystemPromptChars,
    });

    assert.equal(boundary, state.compactedMessageCount);
    assert.equal(context.includes(state.messages[boundary]!), true);
    assert.equal(context.includes(state.messages[boundary - 1]!), false);
    assert.ok(contextChars(context) > 5_000);
  });

  it("preserves the entire current request despite oversized artificial reservations", () => {
    const state = makeState();
    state.messages.push({
      role: "user",
      content: `CURRENT_USER_REQUEST_${"z".repeat(2_000)}`,
    });
    const manager = new ContextManager();
    const maxContextChars = 4_096;
    const reservedSystemPromptChars = 25_000;
    const boundary = manager.retrievalBoundary(
      state,
      maxContextChars,
      "system",
      reservedSystemPromptChars,
    );
    assert.equal(boundary, state.compactedMessageCount);
    const context = manager.build({
      systemPrompt: "system",
      state,
      maxContextChars,
      reservedSystemPromptChars,
    });

    assert.equal(context.at(-1)?.role, "user");
    assert.ok(context.some((m) => m.content?.startsWith("CURRENT_USER_REQUEST_")));
    assert.ok(contextChars(context) > maxContextChars);
  });

  it("classifies the exact 80/90/95 percent context-pressure boundaries", () => {
    assert.equal(contextPressureLevel(0.7999), "normal");
    assert.equal(contextPressureLevel(0.8), "suggest");
    assert.equal(contextPressureLevel(0.8999), "suggest");
    assert.equal(contextPressureLevel(0.9), "require");
    assert.equal(contextPressureLevel(0.9499), "require");
    assert.equal(contextPressureLevel(0.95), "force");
    assert.equal(contextPressureLevel(Number.POSITIVE_INFINITY), "force");
    assert.equal(contextPressureLevel(Number.NaN), "normal");
  });

  it("uses the actual rolling working-set capacity for pressure", () => {
    assert.equal(activeWorkingSetCharBudget(1_600_000), MAX_ACTIVE_WORKING_SET_CHARS);
    assert.equal(activeWorkingSetCharBudget(50_000), 50_000);
    assert.throws(() => activeWorkingSetCharBudget(0), /positive safe integer/u);

    const current = makeState();
    current.messages = [{
      role: "user",
      content: "x".repeat(Math.floor(MAX_ACTIVE_WORKING_SET_CHARS * 0.8) - 32),
    }];
    const inspection = new ContextManager().inspect(current, 1_600_000);
    assert.equal(inspection.configuredBudgetChars, 1_600_000);
    assert.equal(inspection.budgetChars, MAX_ACTIVE_WORKING_SET_CHARS);
    assert.equal(inspection.pressure, "suggest");
  });

  it("treats retrieval reservations as diagnostics, not actual provider occupancy", () => {
    const current = makeState();
    current.messages = [{
      role: "user",
      content: "x".repeat(2_100 - 32),
    }];
    const manager = new ContextManager();

    const generic = manager.inspect(current, 10_000);
    const request = manager.inspect(current, 10_000, {
      systemPrompt: "system",
      reservedSystemPromptChars: 7_500,
    });
    const built = manager.build({
      systemPrompt: "system",
      state: current,
      maxContextChars: 10_000,
      reservedSystemPromptChars: 7_500,
    });

    assert.equal(generic.pressure, "normal");
    assert.ok(request.budgetChars >= 2_500);
    const exact = manager.inspectProviderRequest({ state: current, maxContextChars: 10_000, messages: built });
    assert.equal(exact.pressure, "normal");
    assert.ok(exact.utilization < 0.4);
    assert.ok(contextChars(built) <= 10_000);
  });

  it("inspects the exact provider request while keeping durable and projected sizes distinct", () => {
    const current = makeState();
    current.messages = [
      {
        role: "assistant",
        content: null,
        reasoning_content: `consumed-reasoning-${"r".repeat(4_000)}`,
        tool_calls: [{
          id: "call_consumed_read",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"src/old.ts"}' },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_consumed_read",
        name: "read_file",
        content: `consumed-result-${"o".repeat(6_000)}`,
      },
      {
        role: "assistant",
        content: "The earlier read has been consumed.",
        reasoning_content: `completed-reasoning-${"c".repeat(3_000)}`,
      },
      { role: "user", content: "Inspect the current file." },
      {
        role: "assistant",
        content: null,
        reasoning_content: `active-tool-reasoning-${"a".repeat(500)}`,
        tool_calls: [{
          id: "call_active_read",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"src/current.ts"}' },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_active_read",
        name: "read_file",
        content: `active-result-${"n".repeat(3_000)}`,
      },
    ];
    const tools: ToolDefinition[] = [{
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
    }];
    const manager = new ContextManager();
    const messages = manager.build({
      systemPrompt: "Exact provider system prompt",
      state: current,
      maxContextChars: 250_000,
    });
    const inspection = manager.inspectProviderRequest({
      state: current,
      maxContextChars: 250_000,
      messages,
      tools,
    });
    const expectedMessageChars = estimateMessagesChars(messages);
    const expectedToolChars = estimateToolDefinitionsChars(tools);

    assert.equal(inspection.providerMessageCount, messages.length);
    assert.equal(inspection.providerMessageChars, expectedMessageChars);
    assert.equal(inspection.providerToolDefinitionChars, expectedToolChars);
    assert.equal(inspection.providerInputChars, expectedMessageChars + expectedToolChars);
    assert.equal(
      inspection.pressure,
      contextPressureLevel(inspection.providerInputChars / inspection.budgetChars),
    );
    assert.equal(inspection.durableHistoryChars, estimateMessagesChars(current.messages));
    assert.equal(inspection.durableActiveChars, inspection.durableHistoryChars);
    assert.equal(inspection.projectedActiveChars, inspection.durableActiveChars);
    assert.ok(inspection.providerInputChars > inspection.durableHistoryChars);
  });

  it("estimates mixed-language short-term tokens and excludes compacted raw history", () => {
    assert.equal(estimateTextTokens("abcd"), 1);
    assert.equal(estimateTextTokens("中文"), 2);

    const state = makeState();
    state.messages.push({
      role: "assistant",
      content: null,
      reasoning_content: "推理".repeat(200),
      tool_calls: [{
        id: "call_pending",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      }],
    });
    const manager = new ContextManager();
    const before = manager.estimateShortTermTokens(state);
    manager.applyModelCompaction(state, "Objective and verified result.", state.messages.length - 1);
    const after = manager.estimateShortTermTokens(state);

    assert.ok(before > after);
    assert.ok(after >= 400);
    assert.equal(manager.inspect(state, 50_000).estimatedShortTermTokens, after);
  });

  it("leaves overflow recovery to Runtime without mutating the summary or hiding history", () => {
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
        message.content?.includes("Earlier messages are omitted"),
      ),
      false,
    );
    assert.equal(state.workingSummary, "");
    assert.equal(state.compactedMessageCount, 0);
    assert.ok(contextChars(context) > 5_000);

    const second = new ContextManager().build({
      systemPrompt: "system",
      state,
      maxContextChars: 5_000
    });
    assert.equal(state.workingSummary, "");
    assert.deepEqual(second, context);
  });

  it("uses the accepted summary and restores retired user requirements, not retired reasoning", () => {
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
      assert.equal(context.some((message) => message.content?.includes("message-0-")), true);
      assert.equal(context.some((message) => message.role === "assistant" && message.content?.includes("message-1-")), false);
      assert.equal(context.some((message) => message.content?.includes("message-20-")), true);
      assert.equal(context.some((message) => message.content?.includes("message-29-")), true);
      assert.ok(contextChars(context) > 5_000);
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

  it("preserves oversized instructions so Runtime can diagnose capacity without truncation", () => {
    const state = makeState();
    state.messages.push({ role: "user", content: "latest-" + "y".repeat(20_000) });
    const manager = new ContextManager();
    const built = manager.build({ systemPrompt: "rules-" + "z".repeat(20_000), state, maxContextChars: 4_096 });
    assert.equal(built[0]?.content?.length, 20_006);
    assert.ok(manager.inspectProviderRequest({ state, messages: built, maxContextChars: 4_096 }).utilization > 1);
    assert.equal(state.messages.at(-1)?.content?.length, 20_007);
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

  it("preserves image and request intact or reports insufficient capacity", () => {
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

    const small = new ContextManager().build({ systemPrompt: "system", state, maxContextChars: 1_024 });
    assert.ok(contextChars(small) > 1_024);
    assert.ok(small.some((message) => message.role === "user" && message.images?.[0]?.id === id));
    const context = new ContextManager().build({ systemPrompt: "system", state, maxContextChars: 30_000 });
    const latest = context.find((message) => message.role === "user" && message.images?.length);
    assert.equal(latest?.role, "user");
    if (latest?.role === "user") assert.equal(latest.images?.[0]?.id, id);
    assert.ok(contextChars(context) <= 30_000);
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
