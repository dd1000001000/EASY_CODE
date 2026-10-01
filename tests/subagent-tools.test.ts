import assert from "node:assert/strict";

import type { TaskNode, ToolContext, ToolExecutionResult } from "../src/core/types.js";
import type {
  FollowUpSubagentRequest,
  HandoffSubagentRequest,
  ObserveSubagentsRequest,
  SpawnSubagentRequest,
  StopSubagentRequest,
  SubagentControl,
} from "../src/subagents/types.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import {
  HandoffSubagentTool,
  MessageSubagentTool,
  ObserveSubagentsTool,
  SpawnSubagentTool,
  StopSubagentTool,
} from "../src/tools/subagent-tools.js";
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
  | { method: "spawn"; request: SpawnSubagentRequest }
  | { method: "observe"; request: ObserveSubagentsRequest }
  | { method: "followUp"; request: FollowUpSubagentRequest }
  | { method: "stop"; request: StopSubagentRequest }
  | { method: "handoff"; request: HandoffSubagentRequest };

class RecordingControl implements SubagentControl {
  readonly calls: ControlCall[] = [];
  authorizationChecks = 0;
  authorizationError?: Error;

  assertAuthorized(_context: ToolContext): void {
    this.authorizationChecks += 1;
    if (this.authorizationError) throw this.authorizationError;
  }

  spawn(request: SpawnSubagentRequest): Promise<ToolExecutionResult> {
    return this.record({ method: "spawn", request });
  }

  observe(request: ObserveSubagentsRequest): Promise<ToolExecutionResult> {
    return this.record({ method: "observe", request });
  }

  followUp(request: FollowUpSubagentRequest): Promise<ToolExecutionResult> {
    return this.record({ method: "followUp", request });
  }

  stop(request: StopSubagentRequest): Promise<ToolExecutionResult> {
    return this.record({ method: "stop", request });
  }

  handoff(request: HandoffSubagentRequest): Promise<ToolExecutionResult> {
    return this.record({ method: "handoff", request });
  }

  spawned(index: number): SpawnSubagentRequest {
    const call = this.calls[index];
    if (call?.method !== "spawn") throw new Error(`Expected spawn call ${index}`);
    return call.request;
  }

  private async record(call: ControlCall): Promise<ToolExecutionResult> {
    this.calls.push(call);
    return { ok: true, summary: `Handled ${call.method}`, data: call.request };
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
  it("allows an explicitly selected Plan parent to dispatch a planning child", async () => {
    const control = new RecordingControl();
    const tool = new SpawnSubagentTool(control);
    const parameters = tool.definition.function.parameters as { properties: Record<string, unknown> };
    assert.equal("mode" in parameters.properties, false);
    const result = await tool.execute(
      { name: "Child 1", taskId: "research", instructions: "Inspect without modifying files" },
      { ...context("plan"), selectedMode: "plan" },
    );
    assert.equal(result.ok, true);
    assert.equal(control.calls[0]?.method, "spawn");
    assert.equal(
      (
        await tool.execute(
          { name: "Child 2", taskId: "research", instructions: "Inspect", mode: "code" },
          { ...context("plan"), selectedMode: "plan" },
        )
      ).ok,
      false,
    );
    assert.equal(control.calls.length, 1);
  });

  it("truncates oversized spawn instructions and follow-ups after sanitizing", async () => {
    const control = new RecordingControl();
    const limits = { ...DEFAULT_RUNTIME_LIMITS, subagentInstructionsMaxChars: 64, subagentFollowUpMaxChars: 64 };
    const spawn = new SpawnSubagentTool(control, limits);
    const message = new MessageSubagentTool(control, limits);
    assert.equal(
      (
        await spawn.execute(
          { name: "Child 3", taskId: "implementation", instructions: `START😀${"x".repeat(200)}END` },
          context(),
        )
      ).ok,
      true,
    );
    assert.equal(
      (
        await spawn.execute(
          {
            name: "Child 4",
            task: { title: "Standalone", description: "Work", completionChecks: ["Done"] },
            instructions: `SECOND${"x".repeat(200)}END`,
          },
          context(),
        )
      ).ok,
      true,
    );
    assert.equal(
      (await message.execute({ agentId: AGENT_ONE, message: `FOLLOW${"x".repeat(200)}END` }, context())).ok,
      true,
    );
    assert.match(control.spawned(0).instructions, /^START😀.*\[truncated\].*END$/su);
    assert.ok(control.spawned(0).instructions.length <= 64);
    assert.match(control.spawned(1).instructions, /^SECOND.*\[truncated\].*END$/su);
    assert.ok(control.spawned(1).instructions.length <= 64);
    const followUp = control.calls[2];
    if (followUp?.method !== "followUp") throw new Error("Expected follow-up call");
    assert.match(followUp.request.message, /^FOLLOW.*\[truncated\].*END$/su);
    assert.ok(followUp.request.message.length <= 64);
    assert.equal((await message.execute({ agentId: AGENT_ONE, message: "  \u001b[31m  " }, context())).ok, false);
    assert.equal(control.calls.length, 3);
  });

  it("routes each tool to its controller method and defaults observation to a snapshot", async () => {
    const control = new RecordingControl();
    const spawn = new SpawnSubagentTool(control);
    const observe = new ObserveSubagentsTool(control);
    const message = new MessageSubagentTool(control);
    const stop = new StopSubagentTool(control);
    const handoff = new HandoffSubagentTool(control);

    const results = [
      await spawn.execute(
        {
          name: "Child 5",
          taskId: "implementation",
          instructions: "Inspect the target and implement the focused change.",
          thinkingEffort: "low",
        },
        context(),
      ),
      await observe.execute({}, context()),
      await observe.execute({ agentIds: [AGENT_ONE, AGENT_TWO], timeoutMs: 30_000 }, context()),
      await message.execute({ agentId: AGENT_ONE, message: "Also run the focused test." }, context()),
      await stop.execute({ agentId: AGENT_TWO, reason: "The parent no longer needs this task." }, context()),
      await handoff.execute(
        { agentId: AGENT_ONE, destination: "branch", branchName: "easy-code/implementation" },
        context(),
      ),
    ];
    assert.deepEqual(
      results.map((result) => result.ok),
      [true, true, true, true, true, true],
    );

    assert.deepEqual(
      control.calls.map((call) => call.method),
      ["spawn", "observe", "observe", "followUp", "stop", "handoff"],
    );
    assert.deepEqual(control.calls[1]?.request, { timeoutMs: 0 });
    assert.deepEqual(control.calls[2]?.request, { agentIds: [AGENT_ONE, AGENT_TWO], timeoutMs: 30_000 });
    assert.equal(control.authorizationChecks, 6);
    assert.equal(control.spawned(0).thinkingEffort, "low");
    for (const tool of [spawn, observe, message, stop, handoff]) {
      assert.equal(tool.definition.function.strict, true);
      assert.equal(tool.definition.function.parameters.additionalProperties, false);
    }
    assert.deepEqual((spawn.definition.function.parameters as { required: string[] }).required, [
      "name",
      "instructions",
    ]);
  });

  it("sanitizes controls and secrets before passing text to the controller", async () => {
    const control = new RecordingControl();
    const tool = new SpawnSubagentTool(control);
    const result = await tool.execute(
      {
        name: "Child 6",
        taskId: "implementation",
        instructions: "Inspect\u001b[31m the task\u202e\napi_key=super-secret-value before editing.",
      },
      context(),
    );

    assert.equal(result.ok, true);
    const call = control.spawned(0);
    assert.doesNotMatch(call.instructions, /\u001b|\u202e/u);
    assert.doesNotMatch(call.instructions, /super-secret-value/u);
    assert.match(call.instructions, /api_key=\[REDACTED\]/u);
  });

  it("requires a bounded single-line display name for every spawn", async () => {
    const control = new RecordingControl();
    const tool = new SpawnSubagentTool(control);
    const task = {
      title: "Inspect",
      description: "Inspect an isolated source.",
      completionChecks: ["Evidence is reported"],
    };

    for (const input of [
      { taskId: "implementation", instructions: "Do the task" },
      { task, instructions: "Do the task" },
      { name: ` \u001b[31m\u202e `, taskId: "implementation", instructions: "Do the task" },
      { name: "x".repeat(33), taskId: "implementation", instructions: "Do the task" },
    ]) {
      assert.equal((await tool.execute(input, context())).ok, false);
    }
    assert.equal(control.calls.length, 0);

    const result = await tool.execute(
      { name: `  前端\n  审查员\u202e `, task, instructions: "Do the task" },
      context(),
    );
    assert.equal(result.ok, true);
    assert.equal(control.spawned(0).name, "前端 审查员");
  });

  it("accepts a standalone task contract and enforces exclusive spawn forms", async () => {
    const control = new RecordingControl();
    const tool = new SpawnSubagentTool(control);
    const standalone = await tool.execute(
      {
        name: "Child 7",
        task: {
          title: "Audit authentication\u001b[31m",
          description: "Inspect the login flow without a DAG.",
          completionChecks: ["The findings are verified"],
        },
        instructions: "Return concise evidence.",
        thinkingEffort: "none",
      },
      context(),
    );
    assert.equal(standalone.ok, true);
    const call = control.spawned(0);
    if (!call.task) throw new Error("Expected a standalone spawn call");
    assert.equal(call.task.title, "Audit authentication");
    assert.deepEqual(call.task.completionChecks, ["The findings are verified"]);
    assert.equal(call.thinkingEffort, "none");

    const missing = await tool.execute({ name: "Child 8", instructions: "Missing both assignment forms." }, context());
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /exactly one of taskId/u);
    assert.equal(
      (
        await tool.execute(
          {
            name: "Child 9",
            taskId: "implementation",
            task: {
              title: "Conflicting task",
              description: "Both forms must be rejected.",
              completionChecks: ["Never runs"],
            },
            instructions: "Conflicting forms.",
          },
          context(),
        )
      ).ok,
      false,
    );
    assert.equal(control.calls.length, 1);
  });

  it("rejects malformed, cross-tool, duplicate-target, Auto dispatch, and unauthorized calls", async () => {
    const control = new RecordingControl();
    const spawn = new SpawnSubagentTool(control);
    const observe = new ObserveSubagentsTool(control);
    const message = new MessageSubagentTool(control);
    const handoff = new HandoffSubagentTool(control);

    const rejected = [
      await spawn.execute(
        { name: "Child 10", taskId: "implementation", instructions: "Do the task", agentId: AGENT_ONE },
        context(),
      ),
      await spawn.execute(
        { name: "Child 11", taskId: "implementation", instructions: "Do the task", thinkingEffort: "ultra" },
        context(),
      ),
      await observe.execute({ thinkingEffort: "low" }, context()),
      await observe.execute({ agentIds: [AGENT_ONE, AGENT_ONE], timeoutMs: 1 }, context()),
      await observe.execute({ timeoutMs: 600_000 }, context()),
      await message.execute({ agentId: "agent-not-runtime-issued", message: "Continue" }, context()),
      await handoff.execute({ agentId: AGENT_ONE, destination: "local", branchName: "feature" }, context()),
      await spawn.execute(
        { name: "Child 12", taskId: "implementation", instructions: "Do the task" },
        { ...context("code"), selectedMode: "auto" },
      ),
    ];
    assert.equal(
      rejected.every((result) => !result.ok),
      true,
    );
    assert.equal(control.calls.length, 0);
    assert.equal(control.authorizationChecks, 0);

    control.authorizationError = new Error("Only the main agent may manage children");
    const denied = await observe.execute({}, context());
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? "", /main agent/u);
    assert.equal(control.calls.length, 0);
    assert.equal(control.authorizationChecks, 1);
  });

  it("submits a completed result bound to one in-progress task", async () => {
    const tool = new SubmitTaskResultTool(boundTask());
    const result = await tool.execute(
      {
        outcome: "completed",
        summary: "Implemented the change\u202e and api_key=super-secret-value was not retained.",
        evidence: ["Focused tests passed.", "Reviewed src/feature.ts\u001b[31m successfully."],
      },
      context(),
    );

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
    const result = await tool.execute(
      {
        outcome: "blocked",
        summary: "The implementation cannot proceed yet.",
        blocker: "The required external service is unavailable.",
      },
      context(),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.subagentTaskReport, {
      taskId: "implementation",
      outcome: "blocked",
      summary: "The implementation cannot proceed yet.",
      blocker: "The required external service is unavailable.",
    });
    const spoofed = await tool.execute(
      {
        outcome: "blocked",
        taskId: "different-task",
        summary: "Blocked",
        blocker: "External input is missing",
      },
      context(),
    );
    assert.equal(spoofed.ok, false);
  });

  it("accepts concise evidence in Code and Plan but rejects inactive bindings and cross-outcome fields", async () => {
    const active = new SubmitTaskResultTool(boundTask());
    const concise = await active.execute(
      {
        outcome: "completed",
        summary: "Done",
        evidence: ["Only one check was verified"],
      },
      context(),
    );
    assert.equal(concise.ok, true);
    assert.equal(concise.subagentTaskReport?.outcome, "completed");
    if (concise.subagentTaskReport?.outcome !== "completed") {
      throw new Error("Expected completion report");
    }
    assert.deepEqual(concise.subagentTaskReport.completionEvidence, [
      {
        check: "Focused tests pass",
        evidence: "Only one check was verified",
      },
    ]);

    const pending = new SubmitTaskResultTool(boundTask("pending"));
    assert.equal(
      (
        await pending.execute(
          {
            outcome: "blocked",
            summary: "Blocked",
            blocker: "External input is missing",
          },
          context(),
        )
      ).ok,
      false,
    );
    assert.equal(
      (
        await active.execute(
          {
            outcome: "blocked",
            summary: "Blocked",
            blocker: "External input is missing",
          },
          context("plan"),
        )
      ).ok,
      true,
    );
    assert.equal(
      (
        await active.execute(
          {
            outcome: "completed",
            summary: "Done",
            evidence: ["Tests pass", "Review pass"],
            blocker: "This field belongs to another outcome",
          },
          context(),
        )
      ).ok,
      false,
    );
  });
});
