import assert from "node:assert/strict";

import type { PromptBundleBinding, SessionState } from "../src/core/types.js";
import { assertCurrentSessionBindings } from "../src/protocol/session-bindings.js";
import { describe, it } from "./harness.js";
import { baseSessionState } from "./session-state.js";

const bundle: PromptBundleBinding = {
  formatVersion: 1,
  bundleVersion: "1.2.1",
  bundleHash: `sha256:${"1".repeat(64)}`,
  manifestHash: `sha256:${"2".repeat(64)}`,
  toolCatalogHash: `sha256:${"3".repeat(64)}`,
};

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    ...baseSessionState(),
    threadId: "thread_current",
    mode: "code",
    provider: "glm",
    model: "glm-5.3-flash",
    thinkingEffort: "medium",
    workspaceRoot: "C:\\workspace",
    promptBundle: bundle,
    modelRegistryHash: `sha256:${"4".repeat(64)}`,
    constraints: [],
    messages: [],
    userMessageIndices: [],
    filesRead: new Map(),
    changes: [],
    commands: [],
    commandApprovalPrefixes: [],
    pendingSteering: [],
    steeringSequence: 0,
    steeringWatermark: 0,
    workingSummary: "",
    compactedMessageCount: 0,
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("current session bindings", () => {
  it("accepts the current Prompt Bundle regardless of model-registry changes", () => {
    assert.doesNotThrow(() => assertCurrentSessionBindings(state(), {
      promptBundle: bundle,
    }));
    for (const changed of ["bundleVersion", "bundleHash", "manifestHash", "toolCatalogHash"] as const) {
      assert.throws(() => assertCurrentSessionBindings(state(), {
        promptBundle: { ...bundle, [changed]: changed === "bundleVersion"
          ? "1.2.2"
          : `sha256:${"5".repeat(64)}` },
      }), /different Prompt Bundle/u);
    }
  });

  it("rejects malformed development bindings instead of filling them during Resume", () => {
    assert.throws(() => assertCurrentSessionBindings(state({ promptBundle: undefined as never }), {
      promptBundle: bundle,
    }), /no current Prompt Bundle binding/u);
  });
});
