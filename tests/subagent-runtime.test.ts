import assert from "node:assert/strict";

import { ContextManager } from "../src/context/manager.js";
import type {
  AgentTool,
  ModelProvider,
  ModelRequest,
  ProviderResponse,
  SessionState,
  SubagentAssignmentSnapshot,
  SubagentTaskReport,
  TaskNode,
  ThinkingEffort,
  ToolExecutionResult,
  ToolName,
} from "../src/core/types.js";
import {
  AgentRuntime,
  type AgentRuntimeDependencies,
} from "../src/runtime/agent.js";
import { SubmitTaskResultTool } from "../src/tools/submit-task-result.js";
import { describe, it } from "./harness.js";

const CHILD_AGENT_ID = "subagent_00000000-0000-4000-8000-000000000001";

const ALL_TOOL_NAMES: ToolName[] = [
  "select_mode",
  "propose_plan",
  "read_file",
  "read_image",
  "create_file",
  "update_file",
  "delete_file",
  "run_command",
  "manage_tasks",
  "manage_subagents",
  "submit_task_result",
  "compact_context",
  "manage_memory",
];

const CHILD_TOOL_NAMES: ToolName[] = [
  "compact_context",
  "create_file",
  "delete_file",
  "read_file",
  "run_command",
  "submit_task_result",
  "update_file",
];

function state(
  thinkingEffort: ThinkingEffort,
  suffix: string,
): SessionState {
  const now = new Date().toISOString();
  return {
    threadId: `thread_subagent_runtime_${suffix}`,
    mode: "code",
    provider: "qwen",
    model: "mock",
    thinkingEffort,
    workspaceRoot: process.cwd(),
    constraints: [],
    messages: [],
    filesRead: new Map(),
    changes: [],
    commands: [],
    workingSummary: "",
    compactedMessageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function boundTask(taskId: string): TaskNode {
  return {
    id: taskId,
    title: "Implement the assigned change",
    description: "Complete exactly one isolated child task",
    dependencies: [],
    inputs: ["Parent instructions"],
    expectedArtifacts: ["A verified result"],
    completionChecks: ["Focused verification passes"],
    failureHandling: "Report a concrete external blocker",
    owner: "subagent",
    assignedAgentId: CHILD_AGENT_ID,
    status: "in_progress",
    startedAt: new Date().toISOString(),
  };
}

function fakeTool(
  name: ToolName,
  execute?: AgentTool["execute"],
): AgentTool {
  return {
    name,
    mutating:
      name === "create_file" ||
      name === "update_file" ||
      name === "delete_file" ||
      name === "run_command" ||
      name === "manage_tasks" ||
      name === "manage_subagents" ||
      name === "submit_task_result" ||
      name === "manage_memory",
    definition: {
      type: "function",
      function: {
        name,
        description: `Test ${name}`,
        parameters: { type: "object" },
      },
    },
    execute: execute ?? (async (): Promise<ToolExecutionResult> => ({
      ok: true,
      summary: `${name} completed`,
    })),
  };
}

function provider(
  complete: (request: ModelRequest) => ProviderResponse | Promise<ProviderResponse>,
): ModelProvider {
  return {
    name: "qwen",
    model: "mock",
    async complete(request) {
      return complete(request);
    },
  };
}

function runtime(input: {
  provider: ModelProvider;
  tools: AgentTool[];
  agentIdentity?: NonNullable<AgentRuntimeDependencies["agentIdentity"]>;
  appendEvent?: AgentRuntimeDependencies["appendEvent"];
  onToolCompleted?: AgentRuntimeDependencies["onToolCompleted"];
  onSubagentLifecycleRollback?: AgentRuntimeDependencies["onSubagentLifecycleRollback"];
  getOutstandingSubagents?: AgentRuntimeDependencies["getOutstandingSubagents"];
}): AgentRuntime {
  return new AgentRuntime({
    provider: input.provider,
    tools: input.tools,
    ...(input.agentIdentity ? { agentIdentity: input.agentIdentity } : {}),
    contextManager: new ContextManager(),
    buildSystemPrompt: async () => "system",
    getWorkspaceSummary: async () => "workspace",
    searchMemories: async () => [],
    appendEvent: input.appendEvent ?? (async () => undefined),
    requestApproval: async () => false,
    ...(input.onToolCompleted ? { onToolCompleted: input.onToolCompleted } : {}),
    ...(input.onSubagentLifecycleRollback
      ? { onSubagentLifecycleRollback: input.onSubagentLifecycleRollback }
      : {}),
    ...(input.getOutstandingSubagents
      ? { getOutstandingSubagents: input.getOutstandingSubagents }
      : {}),
  });
}

function standaloneAssignment(
  thinkingEffort: ThinkingEffort = "medium",
): SubagentAssignmentSnapshot {
  return {
    kind: "standalone",
    agentId: CHILD_AGENT_ID,
    taskId: "child_00000000000040008000000000000001",
    taskTitle: "Inspect authentication",
    taskDescription: "Inspect authentication without a DAG.",
    completionChecks: ["Findings are verified"],
    provider: "qwen",
    model: "mock",
    thinkingEffort,
    createdAt: "2026-08-27T10:00:00.000Z",
  };
}

function options(maxSteps = 4) {
  return {
    maxSteps,
    maxContextChars: 100_000,
    maxOutputChars: 8_000,
    commandTimeoutMs: 1_000,
    approvalPolicy: "never" as const,
  };
}

function submitCall(
  callId: string,
  summary = "Completed the assigned task.",
): ProviderResponse {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: callId,
        type: "function",
        function: {
          name: "submit_task_result",
          arguments: JSON.stringify({
            outcome: "completed",
            summary,
            evidence: ["The focused verification passed."],
          }),
        },
      }],
    },
  };
}

function completionReport(
  taskId: string,
  summary = "Completed the assigned task.",
): SubagentTaskReport {
  return {
    taskId,
    outcome: "completed",
    summary,
    completionEvidence: [{
      check: "Focused verification passes",
      evidence: "The focused verification passed.",
    }],
  };
}

describe("AgentRuntime subagent boundaries", () => {
  it("exposes manage_subagents to a main agent at every thinking effort", async () => {
    const visibleByEffort = new Map<ThinkingEffort, ToolName[]>();

    for (const effort of ["none", "low", "medium", "high"] as const) {
      const model = provider(async (request) => {
        visibleByEffort.set(
          effort,
          (request.tools ?? []).map((tool) => tool.function.name),
        );
        return {
          message: {
            role: "assistant",
            content: `${effort} main agent finished`,
            tool_calls: [],
          },
        };
      });
      const result = await runtime({
        provider: model,
        tools: [fakeTool("read_file"), fakeTool("manage_subagents")],
        agentIdentity: { role: "main_agent" },
      }).run(state(effort, `main_${effort}`), "Inspect tool access", options(1));

      assert.equal(result.reason, "success");
    }

    for (const effort of ["none", "low", "medium", "high"] as const) {
      assert.equal(visibleByEffort.get(effort)?.includes("manage_subagents"), true);
      assert.equal(visibleByEffort.get(effort)?.includes("read_file"), true);
    }
  });

  it("keeps Auto in Code mode while a standalone child result is outstanding", async () => {
    const assignment = standaloneAssignment("medium");
    const currentState = state("medium", "auto_with_standalone");
    currentState.mode = "auto";
    let outstanding = true;
    let routerRequests = 0;
    let codeRequests = 0;
    let codeTools: ToolName[] = [];
    const events: Array<{ type: string; payload?: unknown }> = [];
    const model = provider(async (request) => {
      const toolNames = (request.tools ?? []).map((tool) => tool.function.name);
      if (toolNames.includes("select_mode")) {
        routerRequests += 1;
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "route_outstanding_child_to_plan",
              type: "function",
              function: {
                name: "select_mode",
                arguments: JSON.stringify({
                  mode: "plan",
                  reason: "This response must be ignored while child work is outstanding.",
                }),
              },
            }],
          },
        };
      }
      codeRequests += 1;
      codeTools = toolNames as ToolName[];
      if (codeRequests === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "collect_outstanding_standalone_in_auto",
              type: "function",
              function: { name: "manage_subagents", arguments: "{}" },
            }],
          },
        };
      }
      return {
        message: {
          role: "assistant",
          content: "The standalone child result was collected in Code mode.",
          tool_calls: [],
        },
      };
    });

    const result = await runtime({
      provider: model,
      tools: [fakeTool("manage_subagents", async () => ({
        ok: true,
        summary: "Collected the outstanding standalone child.",
        subagentAssignment: assignment,
        subagentLifecycle: { action: "observe", agentId: CHILD_AGENT_ID },
      }))],
      agentIdentity: { role: "main_agent" },
      getOutstandingSubagents: () => outstanding
        ? [{
            id: CHILD_AGENT_ID,
            assignmentKind: "standalone",
            taskId: assignment.taskId,
            taskTitle: assignment.taskTitle,
            status: "completed",
          }]
        : [],
      onToolCompleted: async () => {
        outstanding = false;
      },
      appendEvent: async (event) => {
        events.push({ type: event.type, payload: event.payload });
      },
    }).run(currentState, "Continue after the child inspection", options(3));

    assert.equal(result.reason, "success");
    assert.equal(routerRequests, 0);
    assert.equal(codeRequests, 2);
    assert.equal(codeTools.includes("manage_subagents"), true);
    assert.equal(codeTools.includes("propose_plan"), false);
    assert.equal(result.planProposal, undefined);
    const route = events.find((event) => event.type === "mode.auto_route");
    assert.equal((route?.payload as { mode?: string } | undefined)?.mode, "code");
  });

  it("rejects an explicit Auto-to-Plan override while standalone work is outstanding", async () => {
    const assignment = standaloneAssignment("medium");
    const currentState = state("medium", "plan_override_with_standalone");
    currentState.mode = "auto";
    let providerRequests = 0;
    const model = provider(async () => {
      providerRequests += 1;
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "propose_plan_with_outstanding_child",
            type: "function",
            function: { name: "propose_plan", arguments: "{}" },
          }],
        },
      };
    });

    const result = await runtime({
      provider: model,
      tools: [fakeTool("propose_plan")],
      agentIdentity: { role: "main_agent" },
      getOutstandingSubagents: () => [{
        id: CHILD_AGENT_ID,
        assignmentKind: "standalone",
        taskId: assignment.taskId,
        taskTitle: assignment.taskTitle,
        status: "completed",
      }],
    }).run(currentState, "Adjust the pending plan", {
      ...options(2),
      modeOverride: "plan",
    });
    assert.equal(result.reason, "failed");
    assert.match(
      result.text,
      /collect.*standalone|standalone.*before.*Plan|outstanding.*child/iu,
    );
    assert.equal(providerRequests, 0);
    assert.equal(currentState.planReview, undefined);
  });

  it("accepts a graphless standalone lifecycle only with its exact binding", async () => {
    const assignment = standaloneAssignment();
    let requests = 0;
    const events: Array<{ type: string; payload?: unknown }> = [];
    const model = provider(async () => {
      requests += 1;
      if (requests === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "spawn_standalone",
              type: "function",
              function: { name: "manage_subagents", arguments: "{}" },
            }],
          },
        };
      }
      return { message: { role: "assistant", content: "Child started.", tool_calls: [] } };
    });
    const result = await runtime({
      provider: model,
      tools: [fakeTool("manage_subagents", async () => ({
        ok: true,
        summary: "Standalone child reserved.",
        subagentAssignment: assignment,
        subagentLifecycle: { action: "activate", agentId: CHILD_AGENT_ID },
      }))],
      agentIdentity: { role: "main_agent" },
      appendEvent: async (event) => {
        events.push({ type: event.type, payload: event.payload });
      },
    }).run(state("medium", "standalone_lifecycle"), "Start child", options(2));

    assert.equal(result.reason, "success");
    const toolResult = events.find((event) => event.type === "tool.result");
    assert.deepEqual(
      (toolResult?.payload as { subagentAssignment?: unknown }).subagentAssignment,
      assignment,
    );

    requests = 0;
    const invalidState = state("medium", "standalone_missing_binding");
    const invalid = await runtime({
      provider: model,
      tools: [fakeTool("manage_subagents", async () => ({
        ok: true,
        summary: "Missing binding.",
        subagentLifecycle: { action: "activate", agentId: CHILD_AGENT_ID },
      }))],
      agentIdentity: { role: "main_agent" },
    }).run(invalidState, "Start invalid child", options(2));
    assert.equal(invalid.reason, "success");
    assert.equal(
      invalidState.messages.some(
        (message) => message.role === "tool" && message.content.includes("missing its exact Runtime binding"),
      ),
      true,
    );
  });

  it("requires the main agent to collect standalone children before finishing", async () => {
    const assignment = standaloneAssignment("low");
    let request = 0;
    let outstanding = true;
    const model = provider(async () => {
      request += 1;
      if (request === 1) {
        return { message: { role: "assistant", content: "Done too early.", tool_calls: [] } };
      }
      if (request === 2) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "collect_standalone",
              type: "function",
              function: { name: "manage_subagents", arguments: "{}" },
            }],
          },
        };
      }
      return { message: { role: "assistant", content: "Collected safely.", tool_calls: [] } };
    });
    const collectionState = state("low", "standalone_collection");
    const result = await runtime({
      provider: model,
      tools: [fakeTool("manage_subagents", async () => ({
        ok: true,
        summary: "Collected child result.",
        subagentAssignment: assignment,
        subagentLifecycle: { action: "observe", agentId: CHILD_AGENT_ID },
      }))],
      agentIdentity: { role: "main_agent" },
      getOutstandingSubagents: () => outstanding
        ? [{
            id: CHILD_AGENT_ID,
            assignmentKind: "standalone",
            taskId: assignment.taskId,
            taskTitle: assignment.taskTitle,
            status: "completed",
          }]
        : [],
      onToolCompleted: async () => {
        outstanding = false;
      },
    }).run(collectionState, "Use a child", options(3));

    assert.equal(request, 3);
    assert.equal(result.reason, "success");
    assert.match(result.text, /Collected safely/u);
    assert.equal(
      collectionState.messages.some(
        (message) => message.role === "user" &&
          message.content.includes("RUNTIME_SUBAGENT_COLLECTION_REQUIRED"),
      ),
      true,
    );
  });

  it("gives a child only its Code-mode worker tools and hides parent controls and memory", async () => {
    const taskId = "child_tool_visibility";
    let visibleTools: ToolName[] = [];
    const tools = ALL_TOOL_NAMES.map((name) =>
      name === "submit_task_result"
        ? new SubmitTaskResultTool(boundTask(taskId))
        : fakeTool(name)
    );
    const model = provider(async (request) => {
      visibleTools = (request.tools ?? []).map((tool) => tool.function.name);
      return submitCall("submit_visible_tools");
    });

    const result = await runtime({
      provider: model,
      tools,
      agentIdentity: {
        role: "subagent",
        agentId: CHILD_AGENT_ID,
        assignedTaskId: taskId,
      },
    }).run(state("high", "child_tools"), "Complete the assigned task", options(1));

    assert.equal(result.reason, "success");
    assert.deepEqual([...visibleTools].sort(), [...CHILD_TOOL_NAMES].sort());
    assert.equal(visibleTools.includes("manage_subagents"), false);
    assert.equal(visibleTools.includes("manage_tasks"), false);
    assert.equal(visibleTools.includes("manage_memory"), false);
    assert.equal(visibleTools.includes("read_image"), false);
  });

  it("corrects a plain child final and returns the eventual structured report", async () => {
    const taskId = "child_plain_final";
    const currentState = state("high", "plain_final");
    let requests = 0;
    let correctionWasVisible = false;
    const model = provider(async (request) => {
      requests += 1;
      if (requests === 1) {
        return {
          message: {
            role: "assistant",
            content: "I finished the child task.",
            tool_calls: [],
          },
        };
      }
      correctionWasVisible = request.messages.some(
        (message) => message.role === "user" &&
          message.content.includes("RUNTIME_SUBAGENT_RESULT_PROTOCOL"),
      );
      return submitCall("submit_after_runtime_correction", "Verified child result.");
    });

    const result = await runtime({
      provider: model,
      tools: [new SubmitTaskResultTool(boundTask(taskId))],
      agentIdentity: {
        role: "subagent",
        agentId: CHILD_AGENT_ID,
        assignedTaskId: taskId,
      },
    }).run(currentState, "Complete the assigned task", options(1));

    assert.equal(requests, 2);
    assert.equal(correctionWasVisible, true);
    assert.equal(result.reason, "success");
    assert.equal(result.steps, 2);
    assert.deepEqual(
      result.subagentTaskReport,
      completionReport(taskId, "Verified child result."),
    );
    assert.equal(
      currentState.messages.some(
        (message) => message.role === "user" &&
          message.content.includes("RUNTIME_SUBAGENT_RESULT_PROTOCOL"),
      ),
      true,
    );
  });

  it("rejects a forged structured result before accepting the bound task report", async () => {
    const taskId = "child_forged_report";
    const currentState = state("high", "forged_report");
    let requests = 0;
    let toolExecutions = 0;
    let rejectionWasVisible = false;
    const submitTool = fakeTool(
      "submit_task_result",
      async (): Promise<ToolExecutionResult> => {
        toolExecutions += 1;
        return {
          ok: true,
          summary: "Submitted a child result.",
          subagentTaskReport: toolExecutions === 1
            ? completionReport("a_different_task", "Forged result.")
            : completionReport(taskId, "Bound result accepted."),
        };
      },
    );
    const model = provider(async (request) => {
      requests += 1;
      if (requests === 2) {
        rejectionWasVisible = request.messages.some(
          (message) => message.role === "tool" &&
            message.content.includes("invalid_subagent_task_result"),
        );
      }
      return submitCall(`submit_forged_${requests}`);
    });

    const result = await runtime({
      provider: model,
      tools: [submitTool],
      agentIdentity: {
        role: "subagent",
        agentId: CHILD_AGENT_ID,
        assignedTaskId: taskId,
      },
    }).run(currentState, "Complete the assigned task", options(2));

    assert.equal(requests, 2);
    assert.equal(toolExecutions, 2);
    assert.equal(rejectionWasVisible, true);
    assert.equal(result.reason, "success");
    assert.deepEqual(
      result.subagentTaskReport,
      completionReport(taskId, "Bound result accepted."),
    );
  });

  it("rejects every tool in a batched submit response without executing the batch", async () => {
    const taskId = "child_batched_report";
    const currentState = state("high", "batched_report");
    let requests = 0;
    let submitExecutions = 0;
    let readExecutions = 0;
    const submitTool = fakeTool(
      "submit_task_result",
      async (): Promise<ToolExecutionResult> => {
        submitExecutions += 1;
        return {
          ok: true,
          summary: "Submitted the bound result.",
          subagentTaskReport: completionReport(taskId),
        };
      },
    );
    const readTool = fakeTool(
      "read_file",
      async (): Promise<ToolExecutionResult> => {
        readExecutions += 1;
        return { ok: true, summary: "Read a file." };
      },
    );
    const model = provider(async () => {
      requests += 1;
      if (requests === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "batched_submit",
                type: "function",
                function: {
                  name: "submit_task_result",
                  arguments: JSON.stringify({
                    outcome: "completed",
                    summary: "This batch must not execute.",
                    evidence: ["This evidence must not be accepted."],
                  }),
                },
              },
              {
                id: "batched_read",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "src/app.ts" }),
                },
              },
            ],
          },
        };
      }
      return submitCall("single_submit_after_batch");
    });

    const result = await runtime({
      provider: model,
      tools: [submitTool, readTool],
      agentIdentity: {
        role: "subagent",
        agentId: CHILD_AGENT_ID,
        assignedTaskId: taskId,
      },
    }).run(currentState, "Complete the assigned task", options(2));

    assert.equal(requests, 2);
    assert.equal(submitExecutions, 1);
    assert.equal(readExecutions, 0);
    assert.equal(
      currentState.messages.filter(
        (message) => message.role === "tool" &&
          message.content.includes("submit_task_result_must_be_exclusive"),
      ).length,
      2,
    );
    assert.equal(result.reason, "success");
    assert.deepEqual(result.subagentTaskReport, completionReport(taskId));
  });

  it("does not expose a phantom control result when its journal append fails", async () => {
    const currentState = state("high", "control_append_failure");
    let completedHooks = 0;
    const rolledBack: string[] = [];
    const model = provider(async () => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "follow_up_with_failed_event",
          type: "function",
          function: {
            name: "manage_subagents",
            arguments: "{}",
          },
        }],
      },
    }));
    const control = fakeTool("manage_subagents", async () => ({
      ok: true,
      summary: "Prepared follow-up delivery.",
      subagentLifecycle: {
        action: "deliver_follow_up",
        agentId: CHILD_AGENT_ID,
        message: "Inspect the race.",
      },
    }));

    const result = await runtime({
        provider: model,
        tools: [control],
        agentIdentity: { role: "main_agent" },
        appendEvent: async (event) => {
          if (event.type === "tool.result") throw new Error("journal unavailable");
        },
        onToolCompleted: async () => {
          completedHooks += 1;
        },
        onSubagentLifecycleRollback: (update) => {
          rolledBack.push(update.action);
        },
      }).run(currentState, "Send follow-up", options(1));
    assert.equal(result.reason, "failed");
    assert.match(result.text, /journal unavailable/u);
    assert.equal(completedHooks, 0);
    assert.deepEqual(rolledBack, ["deliver_follow_up"]);
    assert.equal(currentState.messages.some((message) => message.role === "tool"), false);
  });

  it("keeps a truncated tool result valid JSON", async () => {
    const currentState = state("high", "bounded_json");
    let requests = 0;
    let parsedToolResult: unknown;
    const model = provider(async (request) => {
      requests += 1;
      if (requests === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "large_read_result",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            }],
          },
        };
      }
      const toolMessage = request.messages.find((message) => message.role === "tool");
      assert.ok(toolMessage && toolMessage.role === "tool");
      parsedToolResult = JSON.parse(toolMessage.content) as unknown;
      assert.ok(toolMessage.content.length <= 256);
      return {
        message: { role: "assistant", content: "Done.", tool_calls: [] },
      };
    });

    const result = await runtime({
      provider: model,
      tools: [fakeTool("read_file", async () => ({
        ok: true,
        summary: "x".repeat(2_000),
        data: { content: "y".repeat(20_000) },
      }))],
      agentIdentity: { role: "main_agent" },
    }).run(currentState, "Read a large file", {
      ...options(2),
      maxOutputChars: 256,
    });

    assert.equal(result.reason, "success");
    assert.equal(requests, 2);
    assert.deepEqual(
      (parsedToolResult as { data?: { truncated?: boolean } }).data?.truncated,
      true,
    );
  });
});
