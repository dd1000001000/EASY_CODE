import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { SubagentMessageMailbox } from "../src/subagents/messages.js";
import { SubagentCoordinator } from "../src/subagents/coordinator.js";
import { SendParentMessageTool } from "../src/tools/send-parent-message.js";
import { bindBuiltinToolMetadata, isToolAvailable } from "../src/tools/capabilities.js";
import type { ToolContext } from "../src/core/types.js";
import { describe, it } from "./harness.js";

const parentThreadId = "thread_parent_messages";
const childThreadId = "thread_child_messages";
const agentId = "subagent_00000000-0000-4000-8000-000000000001";

function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "easy-code-child-message-"));
  const storage = createStorage(directory);
  const threads = new ThreadStore(storage);
  for (const threadId of [parentThreadId, childThreadId]) {
    threads.create({ threadId, workspaceRoot: directory, mode: "code",
      provider: "deepseek", model: "test", thinkingEffort: "medium" });
  }
  return { threads, storage, mailbox: new SubagentMessageMailbox(threads),
    close: () => { storage.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function childContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workspaceRoot: process.cwd(), mode: "code", threadId: childThreadId,
    turnId: "turn_child_messages", approvalPolicy: "never", requestApproval: async () => false,
    commandTimeoutMs: 1_000, maxOutputChars: 8_000, agentRole: "subagent", agentId,
    assignedTaskId: "inspect", toolCallId: "call_send_1", ...overrides };
}

function parentContext(): ToolContext {
  return { ...childContext(), threadId: parentThreadId, turnId: "turn_parent_messages",
    agentRole: "main_agent", agentId: undefined, assignedTaskId: undefined,
    thinkingEffort: "medium", provider: "deepseek", model: "test",
    commandExecutionMode: "auto_approve", orchestrationEnabled: true };
}

describe("child-to-parent messages", () => {
  it("truncates an oversized child report instead of rejecting it", async () => {
    const fixture = setup();
    try {
      const binding = { agentId, childThreadId, parentThreadId, taskId: "inspect", taskTitle: "Inspect source" };
      const tool = new SendParentMessageTool(binding, (message, child, callId) =>
        fixture.mailbox.post(parentThreadId, message, child, callId), 64);
      assert.equal((await tool.execute({ message: `START😀${"x".repeat(200)}END` }, childContext())).ok, true);
      const delivered = fixture.mailbox.pending(parentThreadId)[0]?.text ?? "";
      assert.match(delivered, /^START😀.*\[truncated\].*END$/su);
      assert.ok(delivered.length <= 64);
      assert.equal((await tool.execute({ message: " \u001b[31m " },
        childContext({ toolCallId: "call_empty" }))).ok, false);
      assert.equal(fixture.mailbox.pending(parentThreadId).length, 1);
    } finally { fixture.close(); }
  });

  it("persists a bounded report once, restores it, and delivers it into parent context once", async () => {
    const fixture = setup();
    try {
      const binding = { agentId, childThreadId, parentThreadId, taskId: "inspect", taskTitle: "Inspect source" };
      const tool = new SendParentMessageTool(binding, (message, child, callId) =>
        fixture.mailbox.post(parentThreadId, message, child, callId));
      const first = await tool.execute({ message: "Found a failing edge case." }, childContext());
      const duplicate = await tool.execute({ message: "Found a failing edge case." }, childContext());
      assert.equal(first.ok, true);
      assert.deepEqual(duplicate.data, first.data);
      assert.equal(fixture.mailbox.pending(parentThreadId).length, 1);
      const restored = new SubagentMessageMailbox(new ThreadStore(fixture.storage));
      assert.equal(restored.pending(parentThreadId).length, 1);
      const delivered = restored.deliverToModel(parentThreadId, "turn_parent_messages");
      assert.equal(delivered.length, 1);
      assert.match(delivered[0]?.content ?? "", /Found a failing edge case/u);
      assert.deepEqual(fixture.mailbox.deliverToModel(parentThreadId, "turn_parent_messages"), []);
      assert.equal(fixture.mailbox.pending(parentThreadId).length, 0);
      const replayed = fixture.threads.rebuildProjection(parentThreadId);
      assert.equal(replayed.messages.filter((message) => message.role === "user" &&
        message.content.includes("Found a failing edge case")).length, 1);
    } finally { fixture.close(); }
  });

  it("rejects a different child identity and records wait delivery exactly once", async () => {
    const fixture = setup();
    try {
      const binding = { agentId, childThreadId, parentThreadId, taskId: "inspect", taskTitle: "Inspect source" };
      const tool = new SendParentMessageTool(binding, (message, child, callId) =>
        fixture.mailbox.post(parentThreadId, message, child, callId));
      assert.equal((await tool.execute({ message: "Hello" }, childContext({ agentId: "other" }))).ok, false);
      assert.equal((await tool.execute({ message: "Hello" }, childContext({ toolCallId: undefined }))).ok, false);
      assert.equal(fixture.mailbox.pending(parentThreadId).length, 0);
      const sent = await tool.execute({ message: "Need a decision on the interface." }, childContext());
      assert.equal(sent.ok, true);
      const differentText = await tool.execute({ message: "Different content" }, childContext());
      assert.equal(differentText.ok, false);
      const messageId = (sent.data as { messageId: string }).messageId;
      fixture.threads.appendEvent(parentThreadId, { type: "tool.result", phase: "completed",
        turnId: "turn_parent_messages", payload: {
          callId: "call_wait", tool: "manage_subagents", subagentMessageId: messageId,
          message: { role: "tool", name: "manage_subagents", tool_call_id: "call_wait", content: "received" },
        } });
      assert.equal(fixture.mailbox.pending(parentThreadId).length, 0);
      assert.deepEqual(fixture.mailbox.deliverToModel(parentThreadId, "turn_parent_messages"), []);
    } finally { fixture.close(); }
  });

  it("accepts more than 32 reports while keeping idempotent retries", () => {
    const fixture = setup();
    try {
      const message = { agentId, taskId: "inspect", taskTitle: "Inspect source", text: "Progress" };
      for (let index = 0; index < 40; index += 1) {
        fixture.mailbox.post(parentThreadId, message, childThreadId, `call_${index}`);
      }
      assert.equal(fixture.mailbox.pending(parentThreadId).length, 40);
      assert.doesNotThrow(() => fixture.mailbox.post(parentThreadId, message, childThreadId, "call_0"));
      assert.equal(fixture.mailbox.pending(parentThreadId).length, 40);
    } finally { fixture.close(); }
  });

  it("allows the bound child to send in every mode but not a main agent", async () => {
    const fixture = setup();
    try {
      const binding = { agentId, childThreadId, parentThreadId, taskId: "inspect", taskTitle: "Inspect source" };
      const tool = bindBuiltinToolMetadata(new SendParentMessageTool(binding, (message, child, callId) =>
        fixture.mailbox.post(parentThreadId, message, child, callId)));
      for (const mode of ["plan", "auto", "code"] as const) {
        assert.equal(isToolAvailable(tool, { mode, role: "subagent", orchestrationAvailable: false }), true);
        const result = await tool.execute({ message: `Update from ${mode}` },
          childContext({ mode, toolCallId: `call_${mode}` }));
        assert.equal(result.ok, true);
      }
      assert.equal(isToolAvailable(tool, { mode: "plan", role: "main_agent", orchestrationAvailable: true }), false);
      assert.equal((await tool.execute({ message: "Impersonation" },
        childContext({ mode: "plan", agentRole: "main_agent", toolCallId: "call_main" }))).ok, false);
      assert.equal(fixture.mailbox.pending(parentThreadId).length, 3);
    } finally { fixture.close(); }
  });

  it("replays two identical reports from different calls as distinct parent messages", () => {
    const fixture = setup();
    try {
      const message = { agentId, taskId: "inspect", taskTitle: "Inspect source", text: "Still investigating" };
      fixture.mailbox.post(parentThreadId, message, childThreadId, "call_one");
      fixture.mailbox.post(parentThreadId, message, childThreadId, "call_two");
      assert.equal(fixture.mailbox.deliverToModel(parentThreadId, "turn_parent_messages").length, 2);
      const replayed = fixture.threads.rebuildProjection(parentThreadId);
      assert.equal(replayed.messages.filter((item) => item.role === "user" &&
        item.content.includes("Still investigating")).length, 2);
    } finally { fixture.close(); }
  });

  it("wakes a parent wait for a child update without completing the child", async () => {
    const fixture = setup();
    try {
      const coordinator = new SubagentCoordinator({
        createAgentId: () => agentId,
        run: async () => new Promise(() => undefined),
        pendingMessages: (threadId, agentIds) => fixture.mailbox.pending(threadId, agentIds),
      });
      const spawned = await coordinator.spawn({ action: "spawn", task: {
        title: "Inspect source", description: "Inspect", completionChecks: ["Verified"],
      }, instructions: "Inspect" }, parentContext());
      assert.equal(spawned.ok, true);
      assert.ok(spawned.subagentLifecycle);
      assert.ok(spawned.subagentAssignment);
      coordinator.commitLifecycle(spawned.subagentLifecycle);
      const waiting = coordinator.wait({ action: "wait", agentIds: [agentId], timeoutMs: 5_000 }, parentContext());
      const posted = fixture.mailbox.post(parentThreadId, { agentId, taskId: spawned.subagentAssignment.taskId,
        taskTitle: "Inspect source", text: "Progress update" }, childThreadId, "call_progress");
      coordinator.notifyMessage(parentThreadId);
      const result = await waiting;
      assert.equal(result.subagentMessageId, posted.id);
      assert.equal((result.data as { agents: { status: string }[] }).agents[0]?.status, "running");
      assert.equal(result.subagentLifecycle, undefined);
      const snapshot = await coordinator.status({ action: "status" }, parentContext());
      assert.equal((snapshot.data as { unreadMessageCount: number }).unreadMessageCount, 1);
    } finally { fixture.close(); }
  });
});
