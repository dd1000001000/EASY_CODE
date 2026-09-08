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
  CommandExecutionMode,
} from "../src/core/types.js";
import { normalizeCommandApprovalPrefix, networkCommandApprovalPrefix } from "../src/command/approval.js";
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
  setMode(mode: CommandExecutionMode): void;
  setReview(decision: ApprovalDecision): void;
  close(): void;
}

function approvalRequest(commandPrefix = path.join(path.dirname(process.execPath), "git.exe")): ApprovalRequest {
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
    commandExecutionMode: { value: "manual", writable: true },
    reviewApproval: { value: async () => ({ decision: "allow_once", reason: "Test approval agent" }), writable: true },
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
    setMode: (mode) => { Object.defineProperty(app, "commandExecutionMode", { value: mode }); },
    setReview: (decision) => { Object.defineProperty(app, "reviewApproval", { value: async () => ({ decision, reason: "Test approval agent" }) }); },
    close: () => {
      terminal.close();
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("application command approval decisions", () => {
  it("routes all new commands through the selected approval authority regardless of static risk", async () => {
    const harness = approvalHarness("local_risk_modes");
    try {
      for (const mode of ["manual", "auto_approve", "unrestricted"] as const) {
        harness.setMode(mode);
        for (const risk of ["read", "workspace", "install", "system", "destructive", "external"] as const) {
          const automatic = mode !== "manual";
          const before = harness.terminal.requests.length;
          assert.equal(await harness.request({ ...approvalRequest(), risk }), automatic, `${mode}/${risk}`);
          assert.equal(harness.terminal.requests.length - before, automatic ? 0 : 1);
        }
      }
    } finally { harness.close(); }
  });
  it("uses the independent approval outcome for every network effect and bypasses it in full access", async () => {
    const harness = approvalHarness("network_mode_app");
    try {
      const prefix = networkCommandApprovalPrefix(process.execPath, [], "a".repeat(64));
      for (const mode of ["manual", "auto_approve", "unrestricted"] as const) {
        harness.setMode(mode);
        for (const effect of ["read", "download", "upload", "unknown"] as const) {
          const before = harness.terminal.requests.length;
          const automatic = mode !== "manual";
          assert.equal(await harness.request({ ...approvalRequest(prefix), network: { effect } }), automatic);
          assert.equal(harness.terminal.requests.length - before, automatic ? 0 : 1);
        }
      }
      assert.equal(await harness.request({ ...approvalRequest(), risk: "destructive" }), true);
    } finally { harness.close(); }
  });

  it("remembers explicit network prefixes, honors them with prompts disabled, and consumes them for local execution", async () => {
    const harness = approvalHarness("network_prefix_app");
    try {
      const prefix = networkCommandApprovalPrefix(process.execPath, [], "a".repeat(64));
      const request: ApprovalRequest = { ...approvalRequest(prefix), network: { effect: "download" } };
      await assert.rejects(() => harness.request({ ...request, allowPrompt: false }), /interactive approval is unavailable/);
      assert.equal(harness.terminal.requests.length, 0);
      harness.terminal.decisions.push("allow_prefix");
      assert.equal(await harness.request(request), true);
      assert.equal(await harness.request({ ...request, network: { effect: "upload" }, allowPrompt: false }), true);
      assert.equal(await harness.request({ ...approvalRequest(process.execPath), existingNetworkCommandPrefix: prefix }), true);
      assert.equal(harness.terminal.requests.length, 1);
      assert.deepEqual(harness.threads.recover(harness.state.threadId).commandApprovalPrefixes, [prefix]);
    } finally { harness.close(); }
  });
  it("escalates an independent rejection to the user and journals the override", async () => {
    const harness = approvalHarness("agent_reject_override");
    try {
      harness.setMode("auto_approve"); harness.setReview("reject");
      harness.terminal.decisions.push("allow_prefix");
      assert.equal(await harness.request(approvalRequest()), true);
      assert.equal(harness.terminal.requests.length, 1);
      assert.match(harness.terminal.requests[0]!.description, /Test approval agent/);
      assert.equal(await harness.request(approvalRequest()), true);
      assert.equal(harness.terminal.requests.length, 1);
      assert.equal(harness.threads.recover(harness.state.threadId).commandApprovalPrefixes.length, 1);
    } finally { harness.close(); }
  });
  it("allows once without remembering and asks again next time", async () => {
    const harness = approvalHarness("thread_approval_once");
    try {
      harness.terminal.decisions.push("allow_once", "reject");
      assert.equal(await harness.request(approvalRequest()), true);
      assert.deepEqual(harness.state.commandApprovalPrefixes, []);
      assert.match(
        harness.terminal.messages[0] ?? "",
        /Approved once; starting the command\./u,
      );
      assert.equal(await harness.request(approvalRequest()), false);
      assert.match(
        harness.terminal.messages[1] ?? "",
        /Command execution rejected\./u,
      );
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
        normalizeCommandApprovalPrefix(path.join(path.dirname(process.execPath), "git.exe")),
      ]);
      assert.equal(harness.terminal.requests.length, 1);

      assert.equal(await harness.request(approvalRequest()), true);
      assert.equal(harness.terminal.requests.length, 1);

      const resumed = harness.threads.recover(harness.state.threadId);
      assert.deepEqual(resumed.commandApprovalPrefixes, [
        normalizeCommandApprovalPrefix(path.join(path.dirname(process.execPath), "git.exe")),
      ]);

      const differentPrefix = path.join(
        path.dirname(path.join(path.dirname(process.execPath), "git.exe")),
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
