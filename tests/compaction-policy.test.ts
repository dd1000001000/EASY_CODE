import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import type {
  ContextCompactionRequest,
  ContextIntentLedger,
  SessionState,
} from "../src/core/types.js";
import { ContextManager } from "../src/context/manager.js";
import {
  compactionCooldownSatisfied,
  evaluateCompactionBenefit,
} from "../src/context/compaction-policy.js";
import { validateCompactionIntegrity } from "../src/context/compaction-integrity.js";
import {
  deserializeSessionState,
  serializeChatMessages,
  serializeSessionState,
} from "../src/threads/serialization.js";
import { sha256 } from "../src/utils/hash.js";
import {
  compactionV2Input,
  persistedCompactionV2Summary,
} from "./compaction-fixture.js";

function makeState(messages: SessionState["messages"]): SessionState {
  const now = new Date().toISOString();
  return {
    threadId: "thread_compaction_policy",
    mode: "code",
    provider: "qwen",
    model: "mock",
    thinkingEffort: "medium",
    workspaceRoot: process.cwd(),
    constraints: [],
    messages,
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

function requestFromFixture(
  fixture: ReturnType<typeof compactionV2Input>,
): ContextCompactionRequest {
  return {
    formatVersion: 2,
    summary: persistedCompactionV2Summary(fixture),
    intentLedger: {
      latestRequest: { ...fixture.primaryRequest },
      activeConstraints: fixture.activeConstraints.map((item) => ({ ...item })),
      userCorrections: fixture.intentLedger.userCorrections.map((item) => ({ ...item })),
      supersededRequests: fixture.intentLedger.supersededRequests.map((item) => ({ ...item })),
    },
    coverageCheck: {
      ...fixture.coverageCheck,
      coveredMessageIndices: [...fixture.coverageCheck.coveredMessageIndices],
    },
  };
}

describe("context compaction acceptance policy", () => {
  it("preserves a pinned primary request and a later steering correction separately", () => {
    const state = makeState([
      { role: "user", content: "Implement OAuth2 without removing JWT." },
      { role: "assistant", content: "I will inspect the authentication flow." },
      { role: "user", content: "Use authorization-code flow and keep JWT tests." },
    ]);
    state.contextIntentLedger = {
      latestRequest: {
        sourceMessageIndex: 0,
        text: "Implement OAuth2 without removing JWT.",
      },
      activeConstraints: [],
      userCorrections: [{
        sourceMessageIndex: 2,
        text: "Use authorization-code flow and keep JWT tests.",
      }],
      supersededRequests: [],
    };
    const fixture = compactionV2Input({
      primaryRequestIndex: 0,
      primaryRequestText: "Implement OAuth2 without removing JWT.",
      latestMessageIndex: 2,
      userCorrections: [{
        sourceMessageIndex: 2,
        text: "Use authorization-code flow and keep JWT tests.",
      }],
    });

    const validation = validateCompactionIntegrity({
      state,
      request: requestFromFixture(fixture),
      sourceEndMessageIndex: state.messages.length,
    });

    assert.equal(validation.ok, true);
    assert.deepEqual(validation.intentLedger, state.contextIntentLedger);
  });

  it("rejects a summary that drops a correction or moves the pinned primary request", () => {
    const state = makeState([
      { role: "user", content: "Keep the existing API while adding OAuth2." },
      { role: "user", content: "Do not remove JWT authentication." },
    ]);
    state.contextIntentLedger = {
      latestRequest: {
        sourceMessageIndex: 0,
        text: "Keep the existing API while adding OAuth2.",
      },
      activeConstraints: [],
      userCorrections: [{
        sourceMessageIndex: 1,
        text: "Do not remove JWT authentication.",
      }],
      supersededRequests: [],
    };
    const fixture = compactionV2Input({
      primaryRequestIndex: 1,
      primaryRequestText: "Do not remove JWT authentication.",
    });

    const validation = validateCompactionIntegrity({
      state,
      request: requestFromFixture(fixture),
      sourceEndMessageIndex: state.messages.length,
    });

    assert.equal(validation.ok, false);
    assert.ok(validation.errors.includes("latest_request_source_mismatch"));
    assert.ok(validation.errors.includes("user_correction_ledger_incomplete"));
  });

  it("accepts only a material reduction and reports the safe post-compaction waterline", () => {
    const state = makeState(Array.from({ length: 20 }, (_, index) => ({
      role: "user" as const,
      content: `history-${index}-${"x".repeat(1_000)}`,
    })));
    const candidateMessages: SessionState["messages"] = [
      ...state.messages,
      { role: "assistant", content: null, tool_calls: [{
        id: "compact_call",
        type: "function",
        function: { name: "compact_context", arguments: "{}" },
      }] },
      { role: "tool", name: "compact_context", tool_call_id: "compact_call", content: "ok" },
    ];

    const result = evaluateCompactionBenefit(new ContextManager(), {
      state,
      candidateMessages,
      summary: "A concise durable summary.",
      compactedMessageCount: candidateMessages.length,
      maxContextChars: 100_000,
      historyEndExclusive: state.messages.length,
      required: false,
    });

    assert.equal(result.accepted, true);
    assert.ok(result.savedChars >= 8_192);
    assert.ok(result.savingsRatio >= 0.1);
    assert.equal(result.safeWaterlineReached, true);
  });

  it("uses cooldown hysteresis and rejects a candidate still in mandatory pressure", () => {
    const state = makeState([
      { role: "user", content: "old" },
      { role: "assistant", content: "done" },
      { role: "user", content: "small follow-up" },
    ]);
    state.compactedMessageCount = 2;
    assert.equal(
      compactionCooldownSatisfied(state, state.messages.length),
      false,
    );

    const largeState = makeState(Array.from({ length: 20 }, (_, index) => ({
      role: "user" as const,
      content: `history-${index}-${"x".repeat(1_000)}`,
    })));
    const candidateMessages: SessionState["messages"] = [
      ...largeState.messages,
      { role: "assistant", content: "compact" },
      { role: "tool", tool_call_id: "compact_call", content: "ok" },
    ];
    const result = evaluateCompactionBenefit(new ContextManager(), {
      state: largeState,
      candidateMessages,
      summary: "s".repeat(8_500),
      compactedMessageCount: candidateMessages.length,
      maxContextChars: 10_000,
      historyEndExclusive: largeState.messages.length,
      required: false,
    });

    assert.equal(result.accepted, false);
    assert.equal(result.rejectionReason, "unsafe_post_compaction_pressure");
    assert.equal(result.safeWaterlineReached, false);
  });

  it("round-trips accepted provenance and rejects a changed source prefix", () => {
    const state = makeState([
      { role: "user", content: "Implement the requested change." },
      { role: "assistant", content: "Work completed." },
    ]);
    const intentLedger: ContextIntentLedger = {
      latestRequest: {
        sourceMessageIndex: 0,
        text: "Implement the requested change.",
      },
      activeConstraints: [],
      userCorrections: [],
      supersededRequests: [],
    };
    state.workingSummary = "accepted summary";
    state.compactedMessageCount = 2;
    state.contextIntentLedger = intentLedger;
    state.contextCompactionMetadata = {
      formatVersion: 2,
      sourceStartMessageIndex: 0,
      sourceEndMessageIndex: 2,
      compactedMessageCount: 2,
      sourceHistoryHash: `sha256:${sha256(serializeChatMessages(state.messages))}`,
      acceptedAt: new Date().toISOString(),
      beforeProjectedChars: 100,
      afterProjectedChars: 20,
      savedChars: 80,
      savingsRatio: 0.8,
      postCompactionUtilization: 0.2,
      safeWaterlineReached: true,
    };
    const serialized = serializeSessionState(state);

    const restored = deserializeSessionState(serialized);
    assert.deepEqual(restored.contextIntentLedger, intentLedger);
    assert.deepEqual(
      restored.contextCompactionMetadata,
      state.contextCompactionMetadata,
    );

    const tampered = structuredClone(serialized);
    tampered.messages[0] = { role: "user", content: "Changed source text." };
    assert.throws(
      () => deserializeSessionState(tampered),
      /source history hash mismatch/u,
    );
  });
});
