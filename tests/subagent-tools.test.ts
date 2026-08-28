import assert from "node:assert/strict";

import type {
  TaskNode,
  ToolContext,
  ToolExecutionResult,
} from "../src/core/types.js";
import type {
  FollowUpSubagentRequest,
  HandoffSubagentRequest,
  SpawnSubagentRequest,
  StopSubagentRequest,
  SubagentControl,
  SubagentStatusRequest,
  WaitForSubagentsRequest,
} from "../src/subagents/types.js";
import { ManageSubagentsTool } from "../src/tools/manage-subagents.js";
import { SubmitTaskResultTool } from "../src/tools/submit-task-result.js";
import { describe, it } from "./harness.js";

const AGENT_ONE = "subagent_00000000-0000-4000-8000-000000000001";
const AGENT_TWO = "subagent_00000000-0000-4000-8000-000000000002";

function context(mode: ToolContext["mode"] = "code"): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    mode,
    threadId: "thread_subagents",
    turnId: "turn_subagents",
    approvalPolicy: "never",
    requestApproval: async () => false,
    commandTimeoutMs: 1_000,
    maxOutputChars: 8_000,
  };
}

type ControlCall =
  | SpawnSubagentRequest
  | SubagentStatusRequest
  | WaitForSubagentsRequest
  | FollowUpSubagentRequest
  | StopSubagentRequest
  | HandoffSubagentRequest;

class RecordingControl implements SubagentControl {
  readonly calls: ControlCall[] = [];
  authorizationChecks = 0;
  authorizationError?: Error;

  assertAuthorized(_context: ToolContext): void {
    this.authorizationChecks += 1;
    if (this.authorizationError) throw this.authorizationError;
  }

  spawn(request: SpawnSubagentRequest): Promise<ToolExecutionResult> {
    return this.record(request);
  }

  status(request: SubagentStatusRequest): Promise<ToolExecutionResult> {
    return this.record(request);
  }

  wait(request: WaitForSubagentsRequest): Promise<ToolExecutionResult> {
    return this.record(request);
  }

  followUp(request: FollowUpSubagentRequest): Promise<ToolExecutionResult> {
    return this.record(request);
  }

  stop(request: StopSubagentRequest): Promise<ToolExecutionResult> {
    return this.record(request);
  }

  handoff(request: HandoffSubagentRequest): Promise<ToolExecutionResult> {
    return this.record(request);
  }

  private async record(request: ControlCall): Promise<ToolExecutionResult> {
    this.calls.push(request);
    return { ok: true, summary: `Handled ${request.action}`, data: request };
  }
}

function boundTask(
  status: TaskNode["status"] = "in_progress",
  completionChecks = ["Focused tests pass", "Changed file was reviewed"],
): TaskNode {
  return {
    id: "implementation",
    title: "Implement the change",
    description: "Implement only the assigned change",
    dependencies: [],
    inputs: [],
    expectedArtifacts: ["src/feature.ts"],
    completionChecks,
    failureHandling: "Report a concrete external blocker",
    owner: "main_agent",
    status,
    ...(status === "in_progress" ? { startedAt: "2026-08-27T00:00:00.000Z" } : {}),
  };
}

describe("subagent control tools", () => {
  it("strictly dispatches every main-agent action and defaults wait timeout", async () => {
    const control = new RecordingControl();
    const tool = new ManageSubagentsTool(control);

    assert.equal((await tool.execute({
      action: "spawn",
      taskId: "implementation",
      instructions: "Inspect the target and implement the focused change.",
    }, context())).ok, true);
    assert.equal((await tool.execute({
      action: "status",
      agentIds: [AGENT_ONE],
    }, context())).ok, true);
    assert.equal((await tool.execute({
      action: "wait",
      agentIds: [AGENT_ONE, AGENT_TWO],
    }, context())).ok, true);
    assert.equal((await tool.execute({
      action: "follow_up",
      agentId: AGENT_ONE,
      message: "Also run the focused test.",
    }, context())).ok, true);
    assert.equal((await tool.execute({
      action: "stop",
      agentId: AGENT_TWO,
      reason: "The parent no longer needs this task.",
    }, context())).ok, true);
    assert.equal((await tool.execute({
      action: "handoff",
      agentId: AGENT_ONE,
      destination: "branch",
      branchName: "easy-code/implementation",
    }, context())).ok, true);

    assert.deepEqual(control.calls.map((call) => call.action), [
      "spawn",
      "status",
      "wait",
      "follow_up",
      "stop",
      "handoff",
    ]);
    const wait = control.calls[2];
    assert.equal(wait?.action, "wait");
    if (wait?.action === "wait") assert.equal(wait.timeoutMs, 30_000);
    assert.equal(control.authorizationChecks, 6);
    assert.equal(tool.definition.function.strict, true);
    assert.equal(tool.definition.function.parameters.additionalProperties, false);
  });

  it("sanitizes controls and secrets before passing text to the controller", async () => {
    const control = new RecordingControl();
    const tool = new ManageSubagentsTool(control);
    const result = await tool.execute({
      action: "spawn",
      taskId: "implementation",
      instructions:
        "Inspect\u001b[31m the task\u202e\napi_key=super-secret-value before editing.",
    }, context());

    assert.equal(result.ok, true);
    const call = control.calls[0];
    assert.equal(call?.action, "spawn");
    if (call?.action !== "spawn") throw new Error("Expected spawn call");
    assert.doesNotMatch(call.instructions, /\u001b|\u202e/u);
    assert.doesNotMatch(call.instructions, /super-secret-value/u);
    assert.match(call.instructions, /api_key=\[REDACTED\]/u);
  });

  it("accepts a standalone task contract and enforces exclusive spawn forms", async () => {
    const control = new RecordingControl();
    const tool = new ManageSubagentsTool(control);
    const standalone = await tool.execute({
      action: "spawn",
      task: {
        title: "Audit authentication\u001b[31m",
        description: "Inspect the login flow without a DAG.",
        completionChecks: ["The findings are verified"],
      },
      instructions: "Return concise evidence.",
    }, context());
    assert.equal(standalone.ok, true);
    const call = control.calls[0];
    assert.equal(call?.action, "spawn");
    if (call?.action !== "spawn" || !call.task) {
      throw new Error("Expected a standalone spawn call");
    }
    assert.equal(call.task.title, "Audit authentication");
    assert.deepEqual(call.task.completionChecks, ["The findings are verified"]);

    assert.equal((await tool.execute({
      action: "spawn",
      instructions: "Missing both assignment forms.",
    }, context())).ok, false);
    assert.equal((await tool.execute({
      action: "spawn",
      taskId: "implementation",
      task: {
        title: "Conflicting task",
        description: "Both forms must be rejected.",
        completionChecks: ["Never runs"],
      },
      instructions: "Conflicting forms.",
    }, context())).ok, false);
    assert.equal(control.calls.length, 1);
  });

  it("rejects malformed, cross-action, duplicate-target, Plan-mode, and unauthorized calls", async () => {
    const control = new RecordingControl();
    const tool = new ManageSubagentsTool(control);

    assert.equal((await tool.execute({
      action: "spawn",
      taskId: "implementation",
      instructions: "Do the task",
      agentId: AGENT_ONE,
    }, context())).ok, false);
    assert.equal((await tool.execute({
      action: "wait",
      agentIds: [AGENT_ONE, AGENT_ONE],
      timeoutMs: 1,
    }, context())).ok, false);
    assert.equal((await tool.execute({
      action: "follow_up",
      agentId: "agent-not-runtime-issued",
      message: "Continue",
    }, context())).ok, false);
    assert.equal((await tool.execute({
      action: "spawn",
      taskId: "implementation",
      instructions: "Do the task",
    }, context("plan"))).ok, false);
    assert.equal(control.calls.length, 0);
    assert.equal(control.authorizationChecks, 0);

    control.authorizationError = new Error("Only the main agent may manage children");
    const denied = await tool.execute({ action: "status" }, context());
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? "", /main agent/u);
    assert.equal(control.calls.length, 0);
    assert.equal(control.authorizationChecks, 1);
  });

  it("submits a completed result bound to one in-progress task", async () => {
    const tool = new SubmitTaskResultTool(boundTask());
    const result = await tool.execute({
      outcome: "completed",
      summary: "Implemented the change\u202e and api_key=super-secret-value was not retained.",
      evidence: [
        "Focused tests passed.",
        "Reviewed src/feature.ts\u001b[31m successfully.",
      ],
    }, context());

    assert.equal(result.ok, true);
    const report = result.subagentTaskReport;
    assert.equal(report?.outcome, "completed");
    if (report?.outcome !== "completed") throw new Error("Expected completion report");
    assert.equal(report.taskId, "implementation");
    assert.equal(report.completionEvidence.length, 2);
    assert.deepEqual(
      report.completionEvidence.map((item) => item.check),
      ["Focused tests pass", "Changed file was reviewed"],
    );
    assert.doesNotMatch(report.summary, /super-secret-value|\u202e/u);
    assert.doesNotMatch(report.completionEvidence[1]?.evidence ?? "", /\u001b/u);
    assert.equal(result.data && (result.data as { evidenceCount?: number }).evidenceCount, 2);
  });

  it("submits a blocked result without accepting model-selected task identity", async () => {
    const tool = new SubmitTaskResultTool(boundTask());
    const result = await tool.execute({
      outcome: "blocked",
      summary: "The implementation cannot proceed yet.",
      blocker: "The required external service is unavailable.",
    }, context());

    assert.equal(result.ok, true);
    assert.deepEqual(result.subagentTaskReport, {
      taskId: "implementation",
      outcome: "blocked",
      summary: "The implementation cannot proceed yet.",
      blocker: "The required external service is unavailable.",
    });
    const spoofed = await tool.execute({
      outcome: "blocked",
      taskId: "different-task",
      summary: "Blocked",
      blocker: "External input is missing",
    }, context());
    assert.equal(spoofed.ok, false);
  });

  it("rejects incorrect evidence counts, inactive bindings, Plan mode, and cross-outcome fields", async () => {
    const active = new SubmitTaskResultTool(boundTask());
    const mismatch = await active.execute({
      outcome: "completed",
      summary: "Done",
      evidence: ["Only one check was verified"],
    }, context());
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error ?? "", /requires exactly 2/u);

    const pending = new SubmitTaskResultTool(boundTask("pending"));
    assert.equal((await pending.execute({
      outcome: "blocked",
      summary: "Blocked",
      blocker: "External input is missing",
    }, context())).ok, false);
    assert.equal((await active.execute({
      outcome: "blocked",
      summary: "Blocked",
      blocker: "External input is missing",
    }, context("plan"))).ok, false);
    assert.equal((await active.execute({
      outcome: "completed",
      summary: "Done",
      evidence: ["Tests pass", "Review pass"],
      blocker: "This field belongs to another outcome",
    }, context())).ok, false);
  });
});
