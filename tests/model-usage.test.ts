import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ModelUsageRecord } from "../src/core/types.js";
import { createStorage } from "../src/storage/index.js";
import { ThreadStore } from "../src/threads/index.js";
import {
  aggregateModelUsage,
  parseModelUsageRecord,
} from "../src/usage/model-usage.js";
import { describe, it } from "./harness.js";

function record(
  overrides: Partial<ModelUsageRecord> = {},
): ModelUsageRecord {
  return {
    actor: "main_agent",
    purpose: "agent_step",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    turnId: "turn_usage_test",
    retry: false,
    ...overrides,
  };
}

describe("model usage accounting", () => {
  it("parses bounded durable records and rejects malformed accounting payloads", () => {
    const valid = record({
      actor: "subagent",
      purpose: "context_compaction",
      provider: "glm",
      model: "glm-5.3-flash",
      step: 2,
      attempt: 3,
      retry: true,
      sourceAgentId: "agent_worker_1",
      sourceTaskId: "task_verify",
      usage: {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        cachedInputTokens: 40,
        reasoningTokens: 12,
      },
    });
    assert.deepEqual(parseModelUsageRecord(valid), valid);
    assert.deepEqual(
      parseModelUsageRecord(record({
        usage: {
          promptTokens: 7,
          completionTokens: undefined,
          cachedInputTokens: undefined,
        },
      }))?.usage,
      { promptTokens: 7 },
    );

    for (const invalid of [
      null,
      [],
      { ...valid, actor: "manager" },
      { ...valid, purpose: "tool_call" },
      { ...valid, provider: "unknown" },
      { ...valid, model: "bad\nmodel" },
      { ...valid, turnId: "" },
      { ...valid, retry: "false" },
      { ...valid, step: 0 },
      { ...valid, attempt: 1.5 },
      { ...valid, usage: {} },
      { ...valid, usage: { promptTokens: -1 } },
      { ...valid, usage: { completionTokens: Number.MAX_SAFE_INTEGER + 1 } },
      { ...valid, sourceAgentId: "bad\u202eagent" },
    ]) {
      assert.equal(parseModelUsageRecord(invalid), undefined);
    }
  });

  it("aggregates reported, unreported, retry, cached, reasoning, purpose, and actor totals", () => {
    const summary = aggregateModelUsage([
      record({
        purpose: "auto_route",
        provider: "qwen",
        model: "qwen3.7-plus",
        usage: {
          promptTokens: 100,
          completionTokens: 10,
          totalTokens: 110,
          cachedInputTokens: 40,
          reasoningTokens: 3,
        },
      }),
      record({
        purpose: "auto_route",
        provider: "qwen",
        model: "qwen3.7-plus",
        attempt: 2,
        retry: true,
      }),
      record({
        purpose: "agent_step",
        usage: {
          promptTokens: 200,
          completionTokens: 50,
          cachedInputTokens: 50,
          reasoningTokens: 20,
        },
      }),
      record({
        actor: "subagent",
        purpose: "context_compaction",
        provider: "glm",
        model: "glm-5.3-flash",
        sourceAgentId: "agent_compactor",
        usage: {
          promptTokens: 30,
          completionTokens: 5,
          totalTokens: 40,
          cachedInputTokens: 5,
          reasoningTokens: 1,
        },
      }),
    ]);

    assert.deepEqual(
      {
        requests: summary.requests,
        reportedRequests: summary.reportedRequests,
        unreportedRequests: summary.unreportedRequests,
        retryRequests: summary.retryRequests,
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        totalTokens: summary.totalTokens,
        cachedInputTokens: summary.cachedInputTokens,
        uncachedInputTokens: summary.uncachedInputTokens,
        reasoningTokens: summary.reasoningTokens,
      },
      {
        requests: 4,
        reportedRequests: 3,
        unreportedRequests: 1,
        retryRequests: 1,
        promptTokens: 330,
        completionTokens: 65,
        totalTokens: 400,
        cachedInputTokens: 95,
        uncachedInputTokens: 235,
        reasoningTokens: 24,
      },
    );
    assert.deepEqual(summary.byPurpose.auto_route, {
      requests: 2,
      reportedRequests: 1,
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cachedInputTokens: 40,
      reasoningTokens: 3,
    });
    assert.equal(summary.byPurpose.agent_step.totalTokens, 250);
    assert.equal(summary.byPurpose.context_compaction.totalTokens, 40);
    assert.deepEqual(summary.byActor.mainAgent, {
      requests: 3,
      reportedRequests: 2,
      promptTokens: 300,
      completionTokens: 60,
      totalTokens: 360,
      cachedInputTokens: 90,
      reasoningTokens: 23,
    });
    assert.deepEqual(summary.byActor.subagents, {
      requests: 1,
      reportedRequests: 1,
      promptTokens: 30,
      completionTokens: 5,
      totalTokens: 40,
      cachedInputTokens: 5,
      reasoningTokens: 1,
    });
    assert.equal(summary.byModel["qwen/qwen3.7-plus"]?.requests, 2);
    assert.equal(summary.byModel["qwen/qwen3.7-plus"]?.totalTokens, 110);
    assert.equal(summary.byModel["deepseek/deepseek-v4-flash"]?.totalTokens, 250);
    assert.equal(summary.byModel["glm/glm-5.3-flash"]?.totalTokens, 40);
  });

  it("persists completed usage events and rejects invalid journal payloads", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-model-usage-"));
    const threadId = "thread_usage_persistence";
    try {
      const storage = createStorage(root);
      try {
        const threads = new ThreadStore(storage);
        threads.create({
          threadId,
          workspaceRoot: process.cwd(),
          mode: "auto",
          provider: "deepseek",
          model: "deepseek-v4-flash",
        });
        threads.appendEvent(threadId, {
          turnId: "turn_usage_1",
          type: "model.usage",
          phase: "completed",
          payload: record({
            turnId: "turn_usage_1",
            purpose: "auto_route",
            usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
          }),
        });
        threads.appendEvent(threadId, {
          turnId: "turn_usage_1",
          type: "model.usage",
          phase: "completed",
          payload: record({
            turnId: "turn_usage_1",
            purpose: "agent_step",
          }),
        });

        assert.equal(threads.modelUsageSummary(threadId).requests, 2);
        assert.equal(threads.modelUsageSummary(threadId).totalTokens, 100);
        assert.equal(threads.modelUsageSummary(threadId).unreportedRequests, 1);
        assert.throws(
          () => threads.appendEvent(threadId, {
            turnId: "turn_usage_bad",
            type: "model.usage",
            phase: "failed",
            payload: record({ turnId: "turn_usage_bad" }),
          }),
          /valid completed usage record/u,
        );
        assert.throws(
          () => threads.appendEvent(threadId, {
            turnId: "turn_usage_bad",
            type: "model.usage",
            phase: "completed",
            payload: {
              ...record({ turnId: "turn_usage_bad" }),
              usage: { promptTokens: -1 },
            },
          }),
          /valid completed usage record/u,
        );
        assert.equal(threads.modelUsageSummary(threadId).requests, 2);
      } finally {
        storage.close();
      }

      const reopened = createStorage(root);
      try {
        const summary = new ThreadStore(reopened).modelUsageSummary(threadId);
        assert.equal(summary.requests, 2);
        assert.equal(summary.reportedRequests, 1);
        assert.equal(summary.totalTokens, 100);
        assert.equal(summary.byPurpose.auto_route.totalTokens, 100);
        assert.equal(summary.byModel["deepseek/deepseek-v4-flash"]?.requests, 2);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
