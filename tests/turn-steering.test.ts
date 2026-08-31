import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ImageAttachment } from "../src/core/types.js";
import { cloneSessionState } from "../src/runtime/state.js";
import { createStorage } from "../src/storage/index.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { describe, it } from "./harness.js";

function image(): ImageAttachment {
  return {
    id: "image_00000000-0000-4000-8000-000000000001",
    label: "Image #1",
    mediaType: "image/png",
    storageKey:
      "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000001.png",
    sha256: "1".repeat(64),
    byteSize: 68,
    width: 1,
    height: 1,
  };
}

describe("durable turn steering", () => {
  it("persists individual text and image entries and drains one exact FIFO batch", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-steering-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_steering_fifo",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "mock",
      });
      threads.appendEvent("thread_steering_fifo", {
        type: "message.user",
        turnId: "turn_a",
        phase: "completed",
        payload: { message: { role: "user", content: "start" } },
      });
      const first = threads.enqueueTurnSteering(
        "thread_steering_fifo",
        "turn_a",
        { role: "user", content: "first follow-up" },
      );
      const second = threads.enqueueTurnSteering(
        "thread_steering_fifo",
        "turn_a",
        { role: "user", content: "look here", images: [image()] },
      );

      assert.deepEqual(
        threads.pendingTurnSteering("thread_steering_fifo").map((entry) => entry.sequence),
        [1, 2],
      );
      const batch = threads.drainTurnSteering("thread_steering_fifo", "turn_a");
      assert.ok(batch);
      assert.equal(batch.throughSequence, 2);
      assert.deepEqual(batch.entries.map((entry) => entry.id), [first.id, second.id]);
      assert.match(batch.message.content, /\[Steering 1\][\s\S]*first follow-up/u);
      assert.match(batch.message.content, /\[Steering 2\][\s\S]*look here/u);
      assert.equal(batch.message.images?.[0]?.id, image().id);

      const recovered = threads.recover("thread_steering_fifo");
      assert.equal(recovered.steeringSequence, 2);
      assert.equal(recovered.steeringWatermark, 2);
      assert.deepEqual(recovered.pendingSteering, []);
      assert.equal(recovered.messages.at(-1)?.role, "user");
      assert.equal(recovered.messages.at(-1)?.content, batch.message.content);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not impose an artificial message-count limit on queued adjustments", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-steering-many-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_steering_many",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "mock",
      });
      threads.appendEvent("thread_steering_many", {
        type: "message.user",
        turnId: "turn_many",
        phase: "completed",
        payload: { message: { role: "user", content: "start" } },
      });

      const messageCount = 128;
      for (let index = 1; index <= messageCount; index += 1) {
        threads.enqueueTurnSteering("thread_steering_many", "turn_many", {
          role: "user",
          content: `adjustment ${index}`,
        });
      }

      const pending = threads.pendingTurnSteering("thread_steering_many");
      assert.equal(pending.length, messageCount);
      assert.deepEqual(
        pending.map((entry) => entry.sequence),
        Array.from({ length: messageCount }, (_, index) => index + 1),
      );

      const batch = threads.drainTurnSteering("thread_steering_many", "turn_many");
      assert.equal(batch?.entries.length, messageCount);
      assert.equal(batch?.throughSequence, messageCount);
      assert.match(batch?.message.content ?? "", /\[Steering 128\]\nadjustment 128/u);
      assert.deepEqual(threads.pendingTurnSteering("thread_steering_many"), []);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps a late pending entry across an interrupted turn and stale checkpoint", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-steering-resume-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const initial = threads.create({
        threadId: "thread_steering_resume",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "mock",
      });
      threads.appendEvent(initial.threadId, {
        type: "message.user",
        turnId: "turn_old",
        phase: "completed",
        payload: { message: { role: "user", content: "old request" } },
      });
      const stale = cloneSessionState(threads.recover(initial.threadId));
      threads.enqueueTurnSteering(initial.threadId, "turn_old", {
        role: "user",
        content: "survive restart",
      });
      threads.save(stale);
      assert.equal(threads.pendingTurnSteering(initial.threadId).length, 1);

      threads.appendEvent(initial.threadId, {
        type: "turn.completed",
        turnId: "turn_old",
        phase: "completed",
        payload: { reason: "interrupted", steps: 0 },
      });
      threads.appendEvent(initial.threadId, {
        type: "message.user",
        turnId: "turn_resumed",
        phase: "completed",
        payload: { message: { role: "user", content: "resume" } },
      });
      const batch = threads.drainTurnSteering(initial.threadId, "turn_resumed");
      assert.equal(batch?.entries[0]?.targetTurnId, "turn_old");
      assert.match(batch?.message.content ?? "", /survive restart/u);
      assert.equal(threads.recover(initial.threadId).steeringWatermark, 1);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("seals the finalization race and rejects later entries", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-steering-seal-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_steering_seal",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "glm",
        model: "mock",
      });
      threads.appendEvent("thread_steering_seal", {
        type: "message.user",
        turnId: "turn_seal",
        phase: "completed",
        payload: { message: { role: "user", content: "finish" } },
      });
      assert.equal(threads.sealTurnSteering("thread_steering_seal", "turn_seal"), undefined);
      assert.throws(
        () => threads.enqueueTurnSteering("thread_steering_seal", "turn_seal", {
          role: "user",
          content: "too late",
        }),
        /sealed for finalization/u,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
