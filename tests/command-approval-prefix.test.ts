import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  grantCommandApprovalPrefix,
  isCommandApprovalPrefixGranted,
  MAX_COMMAND_APPROVAL_PREFIXES,
  normalizeCommandApprovalPrefix,
  validateCommandApprovalPrefixes,
} from "../src/command/approval.js";
import { cloneSessionState } from "../src/runtime/state.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import {
  deserializeSessionState,
  serializeSessionState,
} from "../src/threads/serialization.js";
import { describe, it } from "./harness.js";

function temporaryDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "easy-code-command-approval-"));
}

describe("per-Thread command approval prefixes", () => {
  it("normalizes by platform and matches only the exact executable identity", () => {
    const granted = grantCommandApprovalPrefix(
      [],
      "E:\\Miniconda3\\python.exe",
      "win32",
    );
    assert.deepEqual(granted, ["e:\\miniconda3\\python.exe"]);
    assert.equal(
      isCommandApprovalPrefixGranted(
        granted,
        "e:/MINICONDA3/python.exe",
        "win32",
      ),
      true,
    );
    assert.equal(
      isCommandApprovalPrefixGranted(
        granted,
        "E:\\Miniconda3\\python.exe-evil",
        "win32",
      ),
      false,
    );
    assert.equal(
      isCommandApprovalPrefixGranted(
        granted,
        "E:\\Miniconda3\\python.exe\\child",
        "win32",
      ),
      false,
    );
    assert.equal(
      isCommandApprovalPrefixGranted(
        ["/usr/bin/Python"],
        "/usr/bin/python",
        "linux",
      ),
      false,
    );

    const duplicate = grantCommandApprovalPrefix(
      granted,
      "E:\\MINICONDA3\\PYTHON.EXE",
      "win32",
    );
    assert.deepEqual(duplicate, granted);
    assert.notEqual(duplicate, granted);
  });

  it("rejects relative, control-character, and oversized persisted grants", () => {
    assert.throws(
      () => normalizeCommandApprovalPrefix("python.exe", process.platform),
      /absolute executable path/u,
    );
    assert.throws(
      () => normalizeCommandApprovalPrefix(`${process.execPath}\nspoofed`),
      /Invalid command approval prefix/u,
    );
    assert.throws(
      () => validateCommandApprovalPrefixes(
        Array.from({ length: MAX_COMMAND_APPROVAL_PREFIXES + 1 }, () => process.execPath),
      ),
      /Invalid command approval prefix list/u,
    );
  });

  it("serializes and clones grants while migrating legacy checkpoints to an empty list", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_prefix_serialization",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-test",
      });
      state.commandApprovalPrefixes = grantCommandApprovalPrefix(
        state.commandApprovalPrefixes,
        process.execPath,
      );

      const serialized = serializeSessionState(state);
      const restored = deserializeSessionState(serialized);
      const cloned = cloneSessionState(state);
      assert.deepEqual(restored.commandApprovalPrefixes, state.commandApprovalPrefixes);
      assert.deepEqual(cloned.commandApprovalPrefixes, state.commandApprovalPrefixes);
      restored.commandApprovalPrefixes.push(normalizeCommandApprovalPrefix(os.tmpdir()));
      cloned.commandApprovalPrefixes.length = 0;
      assert.equal(state.commandApprovalPrefixes.length, 1);

      const legacy = { ...serialized } as Record<string, unknown>;
      delete legacy.commandApprovalPrefixes;
      assert.deepEqual(deserializeSessionState(legacy).commandApprovalPrefixes, []);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed checkpoint grant fields", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_prefix_malformed",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen-test",
      });
      const baseline = serializeSessionState(state) as unknown as Record<string, unknown>;

      assert.throws(
        () => deserializeSessionState({ ...baseline, commandApprovalPrefixes: process.execPath }),
        /Invalid command approval prefixes/u,
      );
      assert.throws(
        () => deserializeSessionState({
          ...baseline,
          commandApprovalPrefixes: [`${process.execPath}\u0000spoofed`],
        }),
        /Invalid command approval prefixes/u,
      );
      assert.throws(
        () => deserializeSessionState({
          ...baseline,
          commandApprovalPrefixes: Array.from(
            { length: MAX_COMMAND_APPROVAL_PREFIXES + 1 },
            () => process.execPath,
          ),
        }),
        /Invalid command approval prefixes/u,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("durably replays grants and prevents a stale checkpoint from erasing them", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const stale = threads.create({
        threadId: "thread_prefix_stale_checkpoint",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "glm",
        model: "glm-test",
      });

      const first = threads.recordCommandApprovalPrefixGrant(
        stale.threadId,
        process.execPath,
        "turn_prefix",
      );
      assert.equal(first.type, "command.approval_prefix_granted");
      threads.recordCommandApprovalPrefixGrant(
        stale.threadId,
        process.execPath,
        "turn_prefix",
      );

      assert.deepEqual(threads.recover(stale.threadId).commandApprovalPrefixes, [
        normalizeCommandApprovalPrefix(process.execPath),
      ]);

      // This checkpoint was captured before either grant event. Recovery must
      // preserve the event-authoritative grant and continue de-duplicating it.
      threads.save(stale);
      const recovered = threads.recover(stale.threadId);
      assert.deepEqual(recovered.commandApprovalPrefixes, [
        normalizeCommandApprovalPrefix(process.execPath),
      ]);
      assert.equal(
        threads.journal(stale.threadId).read().filter(
          (event) => event.type === "command.approval_prefix_granted",
        ).length,
        2,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails recovery closed for a malformed durable grant event", () => {
    const dataDir = temporaryDataDir();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_prefix_bad_event",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen-test",
      });
      // Bypass ThreadStore's write-time validator to emulate a damaged or
      // manually edited source-of-truth journal.
      threads.journal(state.threadId).append({
        type: "command.approval_prefix_granted",
        phase: "completed",
        payload: { commandPrefix: `${process.execPath}\nspoofed` },
      });
      assert.throws(
        () => threads.recover(state.threadId),
        /Invalid command approval prefix/u,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
