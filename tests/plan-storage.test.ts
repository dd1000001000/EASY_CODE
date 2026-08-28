import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PlanReviewState, SessionState } from "../src/core/types.js";
import { cloneSessionState } from "../src/runtime/state.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import {
  deserializeSessionState,
  serializeSessionState,
} from "../src/threads/serialization.js";
import { describe, it } from "./harness.js";

function review(): PlanReviewState {
  return {
    status: "awaiting_review",
    proposal: {
      id: "plan_22222222-2222-4222-8222-222222222222",
      revision: 1,
      proposedByTurnId: "turn_plan_storage",
      proposedAt: "2026-08-27T00:00:00.000Z",
      title: "Add authentication",
      overview: "Add the approved local login and registration flow.",
      steps: [{
        title: "Implement authentication",
        description: "Add login and registration with per-user state.",
        verification: "Verify login, logout, and account isolation.",
      }],
    },
  };
}

function stateWithReview(): SessionState {
  const now = new Date().toISOString();
  return {
    threadId: "thread_plan_serialization",
    mode: "auto",
    provider: "deepseek",
    model: "mock-model",
    thinkingEffort: "medium",
    workspaceRoot: process.cwd(),
    constraints: [],
    messages: [],
    filesRead: new Map(),
    changes: [],
    commands: [],
    planReview: review(),
    workingSummary: "",
    compactedMessageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe("plan review persistence", () => {
  it("serializes and deep-clones review state while accepting legacy checkpoints", () => {
    const original = stateWithReview();
    const restored = deserializeSessionState(serializeSessionState(original));
    const cloned = cloneSessionState(original);

    assert.deepEqual(restored.planReview, original.planReview);
    assert.deepEqual(cloned.planReview, original.planReview);
    cloned.planReview!.proposal.steps[0]!.title = "Changed clone";
    assert.equal(original.planReview?.proposal.steps[0]?.title, "Implement authentication");

    const legacy = serializeSessionState(original) as unknown as Record<string, unknown>;
    delete legacy.planReview;
    assert.equal(deserializeSessionState(legacy).planReview, undefined);
  });

  it("rejects malformed or approved review state without an approval timestamp", () => {
    const serialized = serializeSessionState(stateWithReview()) as unknown as Record<string, unknown>;
    serialized.planReview = {
      ...review(),
      status: "approved_pending_execution",
    };
    assert.throws(() => deserializeSessionState(serialized), /Invalid serialized session state/u);
  });

  it("replays proposal, feedback, approval, and execution-start events", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-plan-storage-"));
    const storage = createStorage(root);
    try {
      const store = new ThreadStore(storage);
      const initial = store.create({
        threadId: "thread_plan_event_replay",
        workspaceRoot: process.cwd(),
        mode: "auto",
        provider: "deepseek",
        model: "mock-model",
      });
      const pending = review();
      store.appendEvent(initial.threadId, {
        turnId: "turn_plan_storage",
        stepId: "step_1",
        type: "tool.result",
        phase: "completed",
        payload: {
          callId: "call_plan",
          tool: "propose_plan",
          message: {
            role: "tool",
            tool_call_id: "call_plan",
            name: "propose_plan",
            content: '{"ok":true}',
          },
          planReview: pending,
        },
      });
      assert.equal(store.recover(initial.threadId).planReview?.status, "awaiting_review");

      store.appendEvent(initial.threadId, {
        type: "plan.feedback_submitted",
        phase: "completed",
        payload: {
          planId: pending.proposal.id,
          revision: pending.proposal.revision,
          feedback: "Use a modal dialog.",
        },
      });
      assert.equal(
        store.recover(initial.threadId).planReview?.feedback,
        "Use a modal dialog.",
      );

      store.appendEvent(initial.threadId, {
        type: "plan.approved",
        phase: "completed",
        payload: {
          planId: pending.proposal.id,
          revision: pending.proposal.revision,
        },
      });
      assert.equal(
        store.recover(initial.threadId).planReview?.status,
        "approved_pending_execution",
      );

      store.appendEvent(initial.threadId, {
        turnId: "turn_execute_plan",
        type: "plan.execution_started",
        phase: "completed",
        payload: {
          planId: pending.proposal.id,
          revision: pending.proposal.revision,
        },
      });
      assert.equal(store.recover(initial.threadId).planReview, undefined);
    } finally {
      storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
