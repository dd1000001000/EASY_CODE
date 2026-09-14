import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import type {
  ContextIntentLedger,
  SessionState,
} from "../src/core/types.js";
import { ContextManager } from "../src/context/manager.js";
import {
  compactionCooldownSatisfied,
  evaluateCompactionBenefit,
} from "../src/context/compaction-policy.js";
import {
  deserializeSessionState,
  serializeChatMessages,
  serializeSessionState,
} from "../src/threads/serialization.js";
import { sha256 } from "../src/utils/hash.js";
import { baseSessionState } from "./session-state.js";

function makeState(messages: SessionState["messages"]): SessionState {
  const now = new Date().toISOString();
  return {
    ...baseSessionState(),
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

describe("context compaction acceptance policy", () => {
  it("accepts only a material reduction and reports the safe post-compaction waterline", () => {
    const state = makeState(Array.from({ length: 20 }, (_, index) => ({
      role: "assistant" as const,
      content: `history-${index}-${"x".repeat(3_000)}`,
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
      { role: "tool", name: "compact_context", tool_call_id: "compact_call", content: "ok" },
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
      targetRatio: 0.6,
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
