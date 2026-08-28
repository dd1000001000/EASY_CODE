import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { EasyCodeApp, repairInterruptedTurn } from "../src/app.js";
import { Terminal } from "../src/cli/terminal.js";
import type { FileChangeRecord, SessionState } from "../src/core/types.js";
import { cloneSessionState } from "../src/runtime/state.js";
import { createStorage } from "../src/storage/index.js";
import { ThreadStore } from "../src/threads/index.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

const TEST_ENVIRONMENT = [
  "EASY_CODE_CONFIG_DIR",
  "EASY_CODE_DATA_DIR",
  "EASY_CODE_CACHE_DIR",
  "EASY_CODE_PROVIDER",
  "EASY_CODE_WORKSPACE_ROOT",
  "EASY_CODE_WORKSPACE",
  "QWEN_API_KEY",
] as const;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function restoreEnvironment(previous: ReadonlyMap<string, string | undefined>): void {
  for (const name of TEST_ENVIRONMENT) {
    const value = previous.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

class InteractiveOutputTerminal extends Terminal {
  override isInteractive(): boolean {
    return true;
  }
}

describe("resume state recovery", () => {
  it("restores only file read versions that still match the current workspace", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-workspace-resume-"));
    try {
      writeFileSync(path.join(root, "unchanged.txt"), "same", "utf8");
      writeFileSync(path.join(root, "changed.txt"), "before", "utf8");
      writeFileSync(path.join(root, "deleted.txt"), "gone", "utf8");
      const savedReads = new Map([
        ["unchanged.txt", { path: "unchanged.txt", hash: digest("same"), readAt: "2026-01-01T00:00:00.000Z" }],
        ["changed.txt", { path: "changed.txt", hash: digest("before"), readAt: "2026-01-01T00:00:01.000Z" }],
        ["deleted.txt", { path: "deleted.txt", hash: digest("gone"), readAt: "2026-01-01T00:00:02.000Z" }],
      ]);
      const historicalChange: FileChangeRecord = {
        path: "unchanged.txt",
        operation: "update",
        beforeHash: digest("old"),
        afterHash: digest("same"),
        source: "file_tool",
        status: "verified",
        timestamp: "2026-01-01T00:00:03.000Z",
      };

      writeFileSync(path.join(root, "changed.txt"), "after", "utf8");
      unlinkSync(path.join(root, "deleted.txt"));
      const manager = await WorkspaceManager.create(root);
      const result = manager.restorePersistedState(
        savedReads,
        [historicalChange, historicalChange],
      );

      assert.deepEqual(result, {
        restoredReadVersions: 1,
        staleReadVersions: 2,
        restoredChanges: 1,
        discardedChanges: 1,
      });
      assert.deepEqual(manager.getReadVersions(), [savedReads.get("unchanged.txt")]);
      assert.deepEqual(manager.getChangeSet(), [historicalChange]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrates verified reads, audit state, and Thinking history through app startup resume", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-app-resume-"));
    const workspaceRoot = path.join(root, "workspace");
    mkdirSync(workspaceRoot);
    writeFileSync(path.join(workspaceRoot, "stable.txt"), "stable", "utf8");
    writeFileSync(path.join(workspaceRoot, "stale.txt"), "before", "utf8");
    const previous = new Map(
      TEST_ENVIRONMENT.map((name) => [name, process.env[name]] as const),
    );
    process.env.EASY_CODE_CONFIG_DIR = path.join(root, "config");
    process.env.EASY_CODE_DATA_DIR = path.join(root, "data");
    process.env.EASY_CODE_CACHE_DIR = path.join(root, "cache");
    process.env.EASY_CODE_PROVIDER = "qwen";
    delete process.env.EASY_CODE_WORKSPACE_ROOT;
    delete process.env.EASY_CODE_WORKSPACE;
    process.env.QWEN_API_KEY = "resume-test-key";
    let first: EasyCodeApp | undefined;
    let resumed: EasyCodeApp | undefined;
    const firstTerminal = new Terminal(new PassThrough(), new PassThrough());
    const output = new PassThrough();
    output.setEncoding("utf8");
    let transcript = "";
    output.on("data", (chunk: string) => {
      transcript += chunk;
    });
    const resumedTerminal = new InteractiveOutputTerminal(new PassThrough(), output);
    try {
      first = await EasyCodeApp.create({
        workspaceRoot,
        terminal: firstTerminal,
        credentialStore: false,
      });
      const internals = first as unknown as {
        state: SessionState;
        workspace: WorkspaceManager;
        dirty: boolean;
      };
      internals.workspace.recordRead("stable.txt", digest("stable"));
      internals.workspace.recordRead("stale.txt", digest("before"));
      internals.workspace.recordChange({
        path: "stable.txt",
        operation: "update",
        beforeHash: digest("old"),
        afterHash: digest("stable"),
        source: "file_tool",
        status: "verified",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      internals.state.commands.push({
        id: "command_resume_test",
        program: "node",
        args: ["--version"],
        cwd: workspaceRoot,
        status: "exited",
        exitCode: 0,
        durationMs: 1,
        timestamp: "2026-01-01T00:00:01.000Z",
        summary: "ok",
      });
      internals.state.messages.push({
        role: "assistant",
        content: "done",
        reasoning_content: "Recovered private model reasoning.",
      });
      internals.dirty = true;
      const threadId = internals.state.threadId;
      const originalWorkspaceRoot = internals.workspace.root;
      first.close();
      first = undefined;

      writeFileSync(path.join(workspaceRoot, "stale.txt"), "after", "utf8");
      resumed = await EasyCodeApp.create({
        resumeThreadId: threadId,
        terminal: resumedTerminal,
        credentialStore: false,
      });
      const restored = resumed as unknown as {
        state: SessionState;
        workspace: WorkspaceManager;
      };
      assert.deepEqual(
        restored.workspace.getReadVersions().map((entry) => entry.path),
        ["stable.txt"],
      );
      assert.equal(restored.workspace.root, originalWorkspaceRoot);
      assert.deepEqual([...restored.state.filesRead.keys()], ["stable.txt"]);
      assert.equal(restored.state.changes.length, 1);
      assert.equal(restored.workspace.getChangeSet().length, 1);
      assert.equal(restored.state.commands.length, 1);
      await resumed.handleSlashCommand("/thinking 1");
      assert.match(transcript, /Recovered private model reasoning\./u);
      await resumed.handleSlashCommand("/new");
      resumedTerminal.addReasoning("A different Thread's Thinking block.");
      await resumed.handleSlashCommand(`/resume ${threadId}`);
      await resumed.handleSlashCommand("/thinking 1");
      assert.equal(
        (transcript.match(/Recovered private model reasoning\./gu) ?? []).length,
        2,
      );
    } finally {
      resumed?.close();
      first?.close();
      resumedTerminal.close();
      firstTerminal.close();
      restoreEnvironment(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the event-authoritative compaction boundary across a stale checkpoint", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-compaction-resume-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_resume_compaction",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "auto",
        provider: "qwen",
        model: "qwen3.7-max",
      });
      state.messages.push(
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      );
      threads.save(state);
      const stale = cloneSessionState(state);
      threads.appendEvent(state.threadId, {
        type: "context.compacted",
        phase: "completed",
        payload: {
          summary: "Durable compacted objective and verified state.",
          compactedMessageCount: 2,
          summaryChars: 47,
        },
      });
      threads.save(stale);

      const recovered = threads.recover(state.threadId);
      assert.equal(recovered.compactedMessageCount, 2);
      assert.equal(
        recovered.workingSummary,
        "Durable compacted objective and verified state.",
      );
      assert.deepEqual(
        recovered.messages.map((message) => message.content),
        ["one", "two", "three"],
      );

      threads.appendEvent(state.threadId, {
        type: "context.compacted",
        phase: "completed",
        payload: {
          summary: "A newer compacted summary through the complete history.",
          compactedMessageCount: 3,
          summaryChars: 56,
        },
      });
      const advanced = threads.recover(state.threadId);
      threads.save(advanced);
      assert.equal(threads.recover(state.threadId).compactedMessageCount, 3);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("records interrupted-turn repair atomically and only once", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-atomic-resume-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_atomic_resume",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-pro",
      });
      const turnId = "turn_atomic_resume";
      threads.appendEvent(state.threadId, {
        type: "message.user",
        turnId,
        payload: {
          content: "continue safely",
          message: { role: "user", content: "continue safely" },
        },
      });
      threads.appendEvent(state.threadId, {
        type: "message.assistant",
        turnId,
        payload: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "missing_call",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          }],
        },
      });
      const interrupted = threads.recover(state.threadId);
      assert.equal(repairInterruptedTurn(threads, interrupted), true);
      const afterFirstRepair = threads.journal(state.threadId).read();
      assert.equal(afterFirstRepair.filter((event) => event.type === "turn.recovered").length, 1);

      const recovered = threads.recover(state.threadId);
      assert.equal(repairInterruptedTurn(threads, recovered), false);
      assert.equal(
        threads.journal(state.threadId).read().filter((event) => event.type === "turn.recovered").length,
        1,
      );
      assert.equal(recovered.activeTurnId, undefined);
      assert.equal(
        recovered.messages.some(
          (message) => message.role === "tool" && message.tool_call_id === "missing_call",
        ),
        true,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns an interrupted approved-plan execution to explicit review", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-plan-resume-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_interrupted_plan_resume",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "auto",
        provider: "deepseek",
        model: "deepseek-v4-pro",
      });
      const planReview = {
        status: "awaiting_review" as const,
        proposal: {
          id: "plan_interrupted_resume",
          revision: 1,
          proposedByTurnId: "turn_propose_resume",
          proposedAt: "2026-01-01T00:00:00.000Z",
          title: "Resume approved work safely",
          overview: "Complete the approved scope without replaying unknown side effects.",
          steps: [{
            title: "Inspect and continue",
            description: "Inspect current state, then finish only missing work.",
            verification: "Run the relevant verification.",
          }],
        },
      };
      threads.appendEvent(state.threadId, {
        turnId: "turn_propose_resume",
        type: "tool.result",
        phase: "completed",
        payload: {
          callId: "call_propose_resume",
          tool: "propose_plan",
          message: {
            role: "tool",
            tool_call_id: "call_propose_resume",
            name: "propose_plan",
            content: '{"ok":true}',
          },
          planReview,
        },
      });
      threads.appendEvent(state.threadId, {
        type: "plan.approved",
        phase: "completed",
        payload: { planId: planReview.proposal.id, revision: 1 },
      });
      const executionTurn = "turn_execute_interrupted_plan";
      threads.appendEvent(state.threadId, {
        turnId: executionTurn,
        type: "message.user",
        phase: "completed",
        payload: {
          content: "Execute the approved plan.",
          message: { role: "user", content: "Execute the approved plan." },
        },
      });
      threads.appendEvent(state.threadId, {
        turnId: executionTurn,
        type: "plan.execution_started",
        phase: "completed",
        payload: { planId: planReview.proposal.id, revision: 1 },
      });

      const interrupted = threads.recover(state.threadId);
      assert.equal(interrupted.planReview, undefined);
      assert.equal(repairInterruptedTurn(threads, interrupted), true);
      const repairedPlan = (interrupted as {
        planReview?: { status: string; feedback?: string };
      }).planReview;
      assert.equal(repairedPlan?.status, "awaiting_review");
      assert.match(repairedPlan?.feedback ?? "", /interrupted/u);

      const recovered = threads.recover(state.threadId);
      assert.equal(recovered.planReview?.proposal.id, planReview.proposal.id);
      assert.equal(recovered.planReview?.status, "awaiting_review");
      assert.equal(recovered.activeTurnId, undefined);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not duplicate a final assistant reply that was durable before the crash", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-final-reply-resume-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_final_reply_resume",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen3.7-max",
      });
      const turnId = "turn_final_reply_resume";
      threads.appendEvent(state.threadId, {
        type: "message.user",
        turnId,
        payload: {
          content: "Answer once.",
          message: { role: "user", content: "Answer once." },
        },
      });
      const staleCheckpoint = threads.recover(state.threadId);
      threads.appendEvent(state.threadId, {
        type: "message.assistant",
        turnId,
        phase: "completed",
        payload: { role: "assistant", content: "The durable final answer." },
      });
      threads.save(staleCheckpoint);

      const interrupted = threads.recover(state.threadId);
      assert.equal(repairInterruptedTurn(threads, interrupted), true);
      const recovered = threads.recover(state.threadId);
      assert.equal(
        recovered.messages.filter(
          (message) => message.role === "assistant" && message.content === "The durable final answer.",
        ).length,
        1,
      );
      assert.equal(
        recovered.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content?.includes("marked as interrupted"),
        ),
        false,
      );
      assert.equal(recovered.activeTurnId, undefined);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not mistake an assistant followed by a Runtime reminder for a final reply", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-reminder-resume-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_reminder_resume",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen3.7-max",
      });
      const turnId = "turn_reminder_resume";
      threads.appendEvent(state.threadId, {
        type: "message.user",
        turnId,
        payload: {
          content: "Complete the DAG.",
          message: { role: "user", content: "Complete the DAG." },
        },
      });
      threads.appendEvent(state.threadId, {
        type: "message.assistant",
        turnId,
        phase: "completed",
        payload: { role: "assistant", content: "I am done." },
      });
      threads.appendEvent(state.threadId, {
        type: "message.user.synthetic",
        turnId,
        phase: "completed",
        payload: {
          role: "user",
          content: "RUNTIME_TASK_DAG_PROTOCOL: continue the unfinished graph.",
        },
      });

      const interrupted = threads.recover(state.threadId);
      assert.equal(repairInterruptedTurn(threads, interrupted), true);
      const recovered = threads.recover(state.threadId);
      assert.equal(
        recovered.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content?.includes("marked as interrupted"),
        ),
        true,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
