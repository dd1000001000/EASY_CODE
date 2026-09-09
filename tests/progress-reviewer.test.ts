import assert from "node:assert/strict";

import type {
  ModelProvider,
  ModelRequest,
  ProviderResponse,
  ProviderUsage,
} from "../src/core/types.js";
import {
  PROGRESS_REVIEW_TOOL_NAME,
  progressReviewPacketDigest,
  progressReviewToolDefinition,
  runProgressReviewer,
  type ProgressReviewBinding,
} from "../src/progress/reviewer.js";
import { describe, it } from "./harness.js";

const PACKET = [
  "incident: repeated verification failure",
  "observation: test command failed in three distinct cycles",
  "constraint: reviewer must remain read-only",
].join("\n");

function binding(overrides: Partial<ProgressReviewBinding> = {}): ProgressReviewBinding {
  return {
    reviewId: "review_0001",
    incidentId: "incident_0001",
    intentRevision: 3,
    workspaceFingerprint: "sha256:" + "a".repeat(64),
    progressWatermark: 42,
    packetDigest: progressReviewPacketDigest(PACKET),
    ...overrides,
  };
}

function reportArguments(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    recommendation: "run_experiment",
    summary: "One bounded experiment can distinguish the leading explanations.",
    diagnosis: "The repeated failure is consistent with stale generated state.",
    evidence: "Three verification cycles retained the same high-confidence outcome.",
    experiment: "Regenerate only the affected fixture, then rerun the narrow test once.",
    experimentProgram: "node", experimentArgsJson: "[]", experimentCwd: ".",
    expectedSignal: "The narrow failure disappears without introducing a new failure.",
    falsifyingSignal: "The same outcome remains after the fixture is regenerated.",
    ...overrides,
  });
}

function response(
  args: string,
  usage?: ProviderUsage,
  name = PROGRESS_REVIEW_TOOL_NAME,
): ProviderResponse {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_review",
          type: "function",
          function: { name, arguments: args },
        },
      ],
    },
    ...(usage ? { usage } : {}),
  };
}

class ScriptedProvider implements ModelProvider {
  readonly name = "deepseek" as const;
  readonly model = "review-test-model";
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly steps: Array<ProviderResponse | Error>,
  ) {}

  async complete(request: ModelRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (!step) throw new Error("Unexpected reviewer Provider request");
    if (step instanceof Error) throw step;
    return step;
  }
}

describe("isolated progress reviewer", () => {
  it("clips descriptive field and aggregate budgets without a reviewer correction", async () => {
    const reply = response(reportArguments({ summary: "中".repeat(10000), diagnosis: "文".repeat(6000) }));
    reply.message.reasoning_content = "ignored thinking";
    const provider = new ScriptedProvider([reply]);
    let archived: Readonly<ProviderResponse> | undefined;
    const result = await runProgressReviewer({ binding: binding(), packet: PACKET, thinkingEffort: "none", maxOutputTokens: 512 },
      { provider, onResponse: async response => { archived = response; } });
    assert.equal(result.status, "completed");
    assert.equal(provider.requests.length, 1);
    assert.equal(archived, reply);
    if (result.status === "completed") {
      assert.equal(result.report.experimentArgsJson, "[]");
      assert.equal(result.report.experimentProgram, "node");
      assert.match(JSON.stringify(result.report), /truncated/u);
    }
  });
  it("exposes only one flat strict report tool and accounts for a valid review", async () => {
    const provider = new ScriptedProvider([
      response(reportArguments(), {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        cachedInputTokens: 20,
        reasoningTokens: 5,
      }),
    ]);

    const result = await runProgressReviewer({
      binding: binding(),
      packet: PACKET,
      thinkingEffort: "low",
      maxOutputTokens: 2_048,
    }, { provider });

    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.report.recommendation, "run_experiment");
    assert.deepEqual(result.accounting, {
      reviewAttempts: 1,
      validReviews: 1,
      reviewModelRequests: 1,
      reportedModelRequests: 1,
      unreportedModelRequests: 0,
      reviewInputTokens: 120,
      reviewOutputTokens: 30,
      reviewTotalTokens: 150,
      reviewCachedInputTokens: 20,
      reviewReasoningTokens: 5,
      reviewDurationMs: result.accounting.reviewDurationMs,
      requests: result.accounting.requests,
    });
    assert.equal(result.accounting.requests[0]?.status, "completed");
    assert.equal(result.accounting.requests[0]?.kind, "initial");

    assert.equal(provider.requests.length, 1);
    const request = provider.requests[0]!;
    assert.equal(request.tools?.length, 1);
    assert.equal(request.tools?.[0]?.function.name, PROGRESS_REVIEW_TOOL_NAME);
    assert.equal(request.tools?.[0]?.function.strict, true);
    assert.equal(request.outputReserveTokens, undefined); // storage budget is not a generation reservation
    assert.equal(request.temperature, 0);
    const parameters = request.tools?.[0]?.function.parameters as {
      type?: unknown;
      additionalProperties?: unknown;
      oneOf?: unknown;
      anyOf?: unknown;
      allOf?: unknown;
      properties?: Record<string, { type?: unknown }>;
    };
    assert.equal(parameters.type, "object");
    assert.equal(parameters.additionalProperties, false);
    assert.equal(parameters.oneOf, undefined);
    assert.equal(parameters.anyOf, undefined);
    assert.equal(parameters.allOf, undefined);
    assert.ok(
      Object.values(parameters.properties ?? {}).every(
        (property) => property.type === "string",
      ),
    );
    assert.match(request.messages[0]?.content ?? "", /Runtime-isolated progress reviewer/u);
    assert.match(request.messages[1]?.content ?? "", /BEGIN_UNTRUSTED_PROGRESS_REVIEW_PACKET/u);
    assert.match(request.messages[1]?.content ?? "", /repeated verification failure/u);
  });

  it("uses one format correction without increasing the review-attempt count", async () => {
    const provider = new ScriptedProvider([
      response(JSON.stringify({ summary: "missing required fields" }), {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
      }),
      response(reportArguments(), {
        promptTokens: 20,
        completionTokens: 3,
        totalTokens: 23,
      }),
    ]);

    const result = await runProgressReviewer({
      binding: binding(),
      packet: PACKET,
      thinkingEffort: "medium",
    }, { provider });

    assert.equal(result.status, "completed");
    assert.equal(result.accounting.reviewAttempts, 1);
    assert.equal(result.accounting.reviewModelRequests, 2);
    assert.equal(result.accounting.validReviews, 1);
    assert.equal(result.accounting.reviewInputTokens, 30);
    assert.equal(result.accounting.reviewOutputTokens, 5);
    assert.equal(result.accounting.reviewTotalTokens, 35);
    assert.deepEqual(
      result.accounting.requests.map((entry) => entry.kind),
      ["initial", "schema_correction"],
    );

    const correctedRequest = provider.requests[1]!;
    assert.equal(correctedRequest.tools?.length, 1);
    assert.equal(correctedRequest.tools?.[0]?.function.name, PROGRESS_REVIEW_TOOL_NAME);
    assert.deepEqual(
      correctedRequest.messages.map((message) => message.role),
      ["system", "user", "assistant", "tool", "user"],
    );
    assert.match(
      correctedRequest.messages.at(-1)?.content ?? "",
      /RUNTIME_REVIEW_CONTENT_ERROR/u,
    );
  });

  it("stops after three invalid reports and charges all three model requests", async () => {
    const provider = new ScriptedProvider([
      response(reportArguments({ unexpected: "field" }), {
        promptTokens: 8,
        completionTokens: 2,
      }),
      response(reportArguments({ summary: "" }), {
        promptTokens: 12,
        completionTokens: 3,
      }),
      response(reportArguments({ summary: "" }), { promptTokens: 4, completionTokens: 1 }),
    ]);

    const result = await runProgressReviewer({
      binding: binding(),
      packet: PACKET,
      thinkingEffort: "high",
    }, { provider });

    assert.equal(result.status, "unavailable");
    if (result.status !== "unavailable") return;
    assert.equal(result.reason, "invalid_report");
    assert.equal(result.accounting.reviewAttempts, 1);
    assert.equal(result.accounting.reviewModelRequests, 3);
    assert.equal(result.accounting.validReviews, 0);
    assert.equal(result.accounting.reportedModelRequests, 3);
    assert.equal(result.accounting.reviewInputTokens, 24);
    assert.equal(result.accounting.reviewOutputTokens, 6);
    assert.equal(provider.requests.length, 3);
  });

  it("does not spend a format-correction request when the shared budget leaves one slot", async () => {
    const provider = new ScriptedProvider([
      response(JSON.stringify({ summary: "invalid" }), {
        promptTokens: 9,
        completionTokens: 2,
        totalTokens: 11,
      }),
      response(reportArguments()),
    ]);

    const result = await runProgressReviewer({
      binding: binding(),
      packet: PACKET,
      thinkingEffort: "high",
      maxModelRequests: 1,
    }, { provider });

    assert.equal(result.status, "unavailable");
    assert.equal(result.accounting.reviewAttempts, 1);
    assert.equal(result.accounting.reviewModelRequests, 1);
    assert.equal(provider.requests.length, 1);
  });

  it("counts a failed Provider request and does not attempt schema correction", async () => {
    const provider = new ScriptedProvider([new Error("review provider unavailable")]);

    const result = await runProgressReviewer({
      binding: binding(),
      packet: PACKET,
      thinkingEffort: "none",
    }, { provider });

    assert.equal(result.status, "unavailable");
    if (result.status !== "unavailable") return;
    assert.equal(result.reason, "provider_failure");
    assert.equal(result.accounting.reviewAttempts, 1);
    assert.equal(result.accounting.reviewModelRequests, 1);
    assert.equal(result.accounting.reportedModelRequests, 0);
    assert.equal(result.accounting.unreportedModelRequests, 1);
    assert.equal(result.accounting.requests[0]?.status, "failed");
    assert.equal(provider.requests.length, 1);
  });

  it("rejects a packet-binding mismatch before starting a review attempt", async () => {
    const provider = new ScriptedProvider([response(reportArguments())]);

    const result = await runProgressReviewer({
      binding: binding({ packetDigest: progressReviewPacketDigest("different packet") }),
      packet: PACKET,
      thinkingEffort: "low",
    }, { provider });

    assert.equal(result.status, "unavailable");
    if (result.status !== "unavailable") return;
    assert.equal(result.reason, "invalid_packet");
    assert.equal(result.accounting.reviewAttempts, 0);
    assert.equal(result.accounting.reviewModelRequests, 0);
    assert.equal(result.accounting.validReviews, 0);
    assert.equal(provider.requests.length, 0);
  });

  it("keeps the reviewer-only tool outside the normal registry type at runtime", () => {
    const definition = progressReviewToolDefinition();
    assert.equal(definition.function.name, PROGRESS_REVIEW_TOOL_NAME);
    assert.equal(definition.function.strict, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        definition.function.parameters,
        "additionalProperties",
      ),
      true,
    );
  });
});
