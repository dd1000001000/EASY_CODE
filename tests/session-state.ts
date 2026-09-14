import type { SessionState } from "../src/core/types.js";
import { ACTIVE_MODEL_REGISTRY_HASH } from "../src/models/catalog.js";
import { activePromptBundleBinding } from "../src/prompt-bundle/index.js";
import { createProgressGuardState } from "../src/progress/guard.js";

/** Current-protocol defaults for focused tests that override only relevant state. */
export function baseSessionState(): SessionState {
  const now = new Date().toISOString();
  return {
    reviewSessions: [],
    orchestrationEnabled: false,
    compactionControl: { phaseEnds: [] },
    userMessageIndices: [],
    threadId: "thread_test",
    mode: "code",
    provider: "qwen",
    model: "mock",
    thinkingEffort: "none",
    workspaceRoot: process.cwd(),
    promptBundle: activePromptBundleBinding(),
    modelRegistryHash: ACTIVE_MODEL_REGISTRY_HASH,
    constraints: [],
    messages: [],
    filesRead: new Map(),
    changes: [],
    commands: [],
    commandApprovalPrefixes: [],
    pendingSteering: [],
    steeringSequence: 0,
    steeringWatermark: 0,
    workingSummary: "",
    compactedMessageCount: 0,
    progressGuard: createProgressGuardState(),
    createdAt: now,
    updatedAt: now,
  };
}
