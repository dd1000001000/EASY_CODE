import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { EasyCodeApp } from "../src/app.js";
import { Terminal } from "../src/cli/terminal.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  SessionState,
} from "../src/core/types.js";
import { normalizeCommandApprovalPrefix } from "../src/command/approval.js";
import { createStorage, type EasyCodeStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { describe, it } from "./harness.js";

class ScriptedApprovalTerminal extends Terminal {
  readonly decisions: ApprovalDecision[] = [];
  readonly requests: ApprovalRequest[] = [];
  readonly messages: string[] = [];

  constructor() {
    super(new PassThrough(), new PassThrough());
  }

  override async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return this.decisions.shift() ?? "reject";
  }

  override info(text: string): void {
    this.messages.push(text);
  }
}

interface ApprovalHarness {
  readonly dataDir: string;
  readonly storage: EasyCodeStorage;
  readonly threads: ThreadStore;
  readonly terminal: ScriptedApprovalTerminal;
  readonly state: SessionState;
  request(request: ApprovalRequest): Promise<boolean>;
  close(): void;
}

function approvalRequest(commandPrefix = process.execPath): ApprovalRequest {
  return {
    id: "approval_app_test",
    title: "Run executable",
    description: "The resolved command requires approval.",
    risk: "workspace",
    commandPrefix,
    commandPreview: JSON.stringify([commandPrefix, "script.js"]),
  };
}

function approvalHarness(threadId: string): ApprovalHarness {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-approval-app-"));
  const storage = createStorage(dataDir);
  const threads = new ThreadStore(storage);
  const state = threads.create({
    threadId,
    workspaceRoot: path.join(dataDir, "workspace"),
    mode: "code",
    provider: "deepseek",
    model: "deepseek-test",
  });
  const terminal = new ScriptedApprovalTerminal();
  const app = Object.create(EasyCodeApp.prototype) as EasyCodeApp;
  Object.defineProperties(app, {
    assumeYes: { value: false },
    terminal: { value: terminal },
    state: { value: state, writable: true },
    threadStore: { value: threads },
    dirty: { value: false, writable: true },
  });
  const internal = app as unknown as {
    requestToolApproval(request: ApprovalRequest): Promise<boolean>;
  };
  return {
    dataDir,
    storage,
    threads,
    terminal,
    state,
    request: (request) => internal.requestToolApproval(request),
    close: () => {
      terminal.close();
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("application command approval decisions", () => {
  it("allows once without remembering and asks again next time", async () => {
    const harness = approvalHarness("thread_approval_once");
    try {
      harness.terminal.decisions.push("allow_once", "reject");
      assert.equal(await harness.request(approvalRequest()), true);
      assert.deepEqual(harness.state.commandApprovalPrefixes, []);
      assert.equal(await harness.request(approvalRequest()), false);
      assert.equal(harness.terminal.requests.length, 2);
      assert.deepEqual(
        harness.threads.recover(harness.state.threadId).commandApprovalPrefixes,
        [],
      );
    } finally {
      harness.close();
    }
  });

  it("persists an exact Thread grant, restores it on Resume, and does not leak to a new Thread", async () => {
    const harness = approvalHarness("thread_approval_prefix");
    try {
      harness.terminal.decisions.push("allow_prefix");
      assert.equal(await harness.request(approvalRequest()), true);
      assert.deepEqual(harness.state.commandApprovalPrefixes, [
        normalizeCommandApprovalPrefix(process.execPath),
      ]);
      assert.equal(harness.terminal.requests.length, 1);

      assert.equal(await harness.request(approvalRequest()), true);
      assert.equal(harness.terminal.requests.length, 1);

      const resumed = harness.threads.recover(harness.state.threadId);
      assert.deepEqual(resumed.commandApprovalPrefixes, [
        normalizeCommandApprovalPrefix(process.execPath),
      ]);

      const differentPrefix = path.join(
        path.dirname(process.execPath),
        "different-executable",
      );
      harness.terminal.decisions.push("reject");
      assert.equal(await harness.request(approvalRequest(differentPrefix)), false);
      assert.equal(harness.terminal.requests.length, 2);

      const newThread = harness.threads.create({
        threadId: "thread_approval_new",
        workspaceRoot: harness.state.workspaceRoot,
        mode: "code",
        provider: "deepseek",
        model: "deepseek-test",
      });
      assert.deepEqual(newThread.commandApprovalPrefixes, []);
    } finally {
      harness.close();
    }
  });

  it("fails closed when the durable grant cannot be recorded", async () => {
    const harness = approvalHarness("thread_approval_write_failure");
    try {
      harness.terminal.decisions.push("allow_prefix");
      const original = harness.threads.recordCommandApprovalPrefixGrant.bind(harness.threads);
      harness.threads.recordCommandApprovalPrefixGrant = () => {
        throw new Error("simulated journal failure");
      };
      await assert.rejects(
        () => harness.request(approvalRequest()),
        /simulated journal failure/u,
      );
      assert.deepEqual(harness.state.commandApprovalPrefixes, []);
      harness.threads.recordCommandApprovalPrefixGrant = original;
    } finally {
      harness.close();
    }
  });
});
