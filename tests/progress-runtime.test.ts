import assert from "node:assert/strict";

import { ContextManager } from "../src/context/manager.js";
import type {
  AgentTool,
  EventRecord,
  ModelProvider,
  ModelUsageRecord,
  SessionState,
} from "../src/core/types.js";
import { createProgressGuardState, foldProgressObservation } from "../src/progress/guard.js";
import { foldProgressReviewEvent } from "../src/progress/lifecycle.js";
import { progressReviewPacketDigest } from "../src/progress/reviewer.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { applyTaskGraphOperation } from "../src/tasks/task-graph.js";
import { ManageTasksTool } from "../src/tools/manage-tasks.js";
import { sha256 } from "../src/utils/hash.js";
import { describe, it } from "./harness.js";

function initialState(): SessionState {
  const now = new Date().toISOString();
  const created = applyTaskGraphOperation(undefined, {
    action: "create",
    goal: "Repair the failing behavior",
    tasks: [{
      id: "repair",
      title: "Repair",
      description: "Find and fix the failing behavior",
      dependencies: [],
      inputs: ["Current source"],
      expectedArtifacts: ["Verified repair"],
      completionChecks: ["Narrow verification passes"],
      failureHandling: "Report an evidence-backed blocker",
    }],
  }, { turnId: "turn_seed" });
  const taskGraph = applyTaskGraphOperation(created, {
    action: "start",
    taskId: "repair",
  }, { turnId: "turn_seed" });
  let progressGuard = createProgressGuardState();
  for (let index = 1; index <= 3; index += 1) {
    const suffix = String(index).padStart(12, "0");
    progressGuard = foldProgressObservation(progressGuard, {
      schemaVersion: 1,
      sourceEventId: `event_seed_${index}`,
      sourceCallId: `call_seed_${index}`,
      scopeKey: "thread:thread_progress_runtime/task:repair",
      responseOrdinal: index,
      tool: "run_command",
      kind: "verification_terminal",
      confidence: "high",
      outcomeClass: "failed",
      verificationCycleId: `command_00000000-0000-4000-8000-${suffix}`,
      commandId: `command_00000000-0000-4000-8000-${suffix}`,
      targetKey: `sha256:${sha256(JSON.stringify({
        program: "node",
        args: [],
        cwd: ".",
      }))}`,
      outcomeKey: "sha256:" + "b".repeat(64),
      evidenceDigest: "sha256:" + "b".repeat(64),
    }).state;
  }
  return {
    threadId: "thread_progress_runtime",
    mode: "code",
    provider: "qwen",
    model: "mock",
    thinkingEffort: "high",
    workspaceRoot: process.cwd(),
    constraints: [],
    messages: [],
    filesRead: new Map(),
    changes: [],
    commands: [],
    commandApprovalPrefixes: [],
    taskGraph,
    workingSummary: "",
    compactedMessageCount: 0,
    progressGuard,
    createdAt: now,
    updatedAt: now,
  };
}

describe("AgentRuntime progress intervention", () => {
  it("charges one isolated review, injects its experiment, and records real verification", async () => {
    const state = initialState();
    const events: Array<Omit<EventRecord, "schemaVersion" | "sequence" | "timestamp">> = [];
    const usage: ModelUsageRecord[] = [];
    const systemPrompts: string[] = [];
    let requestIndex = 0;
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        requestIndex += 1;
        if (String(request.tools?.[0]?.function.name) === "submit_review_result") {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_private_review",
                type: "function",
                function: {
                  name: "submit_review_result",
                  arguments: JSON.stringify({
                    recommendation: "run_experiment",
                    summary: "A narrow experiment can separate the hypotheses.",
                    diagnosis: "The fixture may be stale.",
                    evidence: "Three distinct runs had the same assertion.",
                    experiment: "Run the narrow fixture verification once.",
                    expectedSignal: "It passes after the state refresh.",
                    falsifyingSignal: "The identical assertion remains.",
                  }),
                },
              }],
            },
            usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
          };
        }
        if (requestIndex === 2) {
          assert.match(request.messages[0]?.content ?? "", /falsifiable experiment/u);
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_verify",
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify({
                    program: "node",
                    intent: "verify",
                    verificationKind: "smoke_test",
                  }),
                },
              }],
            },
          };
        }
        if (requestIndex === 3) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_complete",
                type: "function",
                function: {
                  name: "manage_tasks",
                  arguments: JSON.stringify({
                    action: "complete",
                    taskId: "repair",
                    evidence: ["Narrow verification exited with code 0"],
                  }),
                },
              }],
            },
          };
        }
        return { message: { role: "assistant", content: "done" } };
      },
    };
    const runCommand: AgentTool = {
      name: "run_command",
      mutating: true,
      definition: {
        type: "function",
        function: {
          name: "run_command",
          description: "Run verification",
          parameters: { type: "object", properties: {}, additionalProperties: true },
        },
      },
      async execute() {
        return {
          ok: true,
          summary: "verification passed",
          data: {
            commandId: "command_00000000-0000-4000-8000-000000000099",
            status: "exited",
            exitCode: 0,
            stdout: { text: "ok" },
            stderr: { text: "" },
            executed: { program: "node", args: [], cwd: "." },
          },
        };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [runCommand, new ManageTasksTool()],
      contextManager: new ContextManager(),
      buildSystemPrompt: async (input) => {
        const prompt = `system\n${input.workingCheckpoint ?? ""}`;
        systemPrompts.push(prompt);
        return prompt;
      },
      getWorkspaceSummary: async () => "workspace",
      getProgressWorkspaceFingerprint: async () => "sha256:" + "c".repeat(64),
      searchMemories: async () => [],
      appendEvent: async (event) => {
        events.push(event as typeof events[number]);
      },
      onModelUsage: async (record) => {
        usage.push(record);
      },
      requestApproval: async () => true,
    });

    const result = await runtime.run(state, "continue the repair", {
      maxSteps: 5,
      maxContextChars: 250_000,
      maxOutputChars: 8_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success", result.text);
    assert.equal(requestIndex, 4);
    assert.deepEqual(
      events
        .filter((event) => event.type.startsWith("progress.review."))
        .map((event) => event.type),
      [
        "progress.review.requested",
        "progress.review.started",
        "progress.review.model_request.started",
        "progress.review.model_request.finished",
        "progress.review.completed",
      ],
    );
    assert.equal(usage[0]?.actor, "reviewer");
    assert.equal(usage[0]?.purpose, "progress_review");
    assert.equal(state.progressGuard?.incidents[0]?.phase, "resolved");
    assert.equal(state.progressGuard?.incidents[0]?.experiment?.verifiedImprovement, true);
    assert.ok(systemPrompts.some((prompt) => /system/u.test(prompt)));
  });

  it("fails review closed when a complete workspace snapshot cannot be captured", async () => {
    const state = initialState();
    const events: Array<Omit<EventRecord, "schemaVersion" | "sequence" | "timestamp">> = [];
    let privateReviewRequests = 0;
    let parentRequests = 0;
    const provider: ModelProvider = {
      name: "qwen",
      model: "mock",
      async complete(request) {
        if (String(request.tools?.[0]?.function.name) === "submit_review_result") {
          privateReviewRequests += 1;
          throw new Error("reviewer must not start");
        }
        parentRequests += 1;
        if (parentRequests === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_block_after_snapshot_failure",
                type: "function",
                function: {
                  name: "manage_tasks",
                  arguments: JSON.stringify({
                    action: "block",
                    taskId: "repair",
                    reason: "The Runtime could not capture a complete review snapshot",
                  }),
                },
              }],
            },
          };
        }
        return { message: { role: "assistant", content: "Review stayed fail-closed." } };
      },
    };
    const runtime = new AgentRuntime({
      provider,
      tools: [new ManageTasksTool()],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      getProgressWorkspaceFingerprint: async () => {
        throw new Error("snapshot truncated");
      },
      searchMemories: async () => [],
      appendEvent: async (event) => {
        events.push(event as typeof events[number]);
      },
      requestApproval: async () => true,
    });

    const result = await runtime.run(state, "continue", {
      maxSteps: 3,
      maxContextChars: 250_000,
      maxOutputChars: 8_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "blocked");
    assert.equal(privateReviewRequests, 0);
    assert.equal(state.progressGuard?.incidents[0]?.phase, "review_unavailable");
    assert.ok(events.some((event) => event.type === "progress.review.unavailable"));
  });

  it("closes an interrupted standalone reviewer globally without retrying it", async () => {
    const state = initialState();
    state.taskGraph = undefined;
    let guard = createProgressGuardState();
    const oldScope = `thread:${state.threadId}/turn:turn_interrupted`;
    for (let index = 1; index <= 3; index += 1) {
      const suffix = String(index).padStart(12, "0");
      guard = foldProgressObservation(guard, {
        schemaVersion: 1,
        sourceEventId: `event_old_${index}`,
        sourceCallId: `call_old_${index}`,
        scopeKey: oldScope,
        responseOrdinal: index,
        tool: "run_command",
        kind: "verification_terminal",
        confidence: "high",
        outcomeClass: "failed",
        verificationCycleId: `command_00000000-0000-4000-8000-${suffix}`,
        commandId: `command_00000000-0000-4000-8000-${suffix}`,
        targetKey: "sha256:" + "a".repeat(64),
        outcomeKey: "sha256:" + "b".repeat(64),
        evidenceDigest: "sha256:" + "b".repeat(64),
      }).state;
    }
    const incident = guard.incidents[0]!;
    const packet = "interrupted immutable packet";
    const binding = {
      reviewId: "review_interrupted_runtime",
      incidentId: incident.incidentId,
      intentRevision: 1,
      workspaceFingerprint: "sha256:" + "c".repeat(64),
      progressWatermark: guard.acceptedObservations,
      packetDigest: progressReviewPacketDigest(packet),
    };
    guard = foldProgressReviewEvent(guard, "progress.review.requested", {
      incidentId: incident.incidentId,
      binding,
      packet,
    });
    guard = foldProgressReviewEvent(guard, "progress.review.started", {
      incidentId: incident.incidentId,
      reviewId: binding.reviewId,
    });
    guard = foldProgressReviewEvent(
      guard,
      "progress.review.model_request.started",
      {
        incidentId: incident.incidentId,
        reviewId: binding.reviewId,
        ordinal: 1,
        kind: "initial",
      },
    );
    state.progressGuard = guard;

    let privateReviewRequests = 0;
    const events: Array<Omit<EventRecord, "schemaVersion" | "sequence" | "timestamp">> = [];
    const runtime = new AgentRuntime({
      provider: {
        name: "qwen",
        model: "mock",
        async complete(request) {
          if (String(request.tools?.[0]?.function.name) === "submit_review_result") {
            privateReviewRequests += 1;
          }
          return { message: { role: "assistant", content: "Recovered safely." } };
        },
      },
      tools: [],
      contextManager: new ContextManager(),
      buildSystemPrompt: async () => "system",
      getWorkspaceSummary: async () => "workspace",
      getProgressWorkspaceFingerprint: async () => "sha256:" + "c".repeat(64),
      searchMemories: async () => [],
      appendEvent: async (event) => {
        events.push(event as typeof events[number]);
      },
      requestApproval: async () => true,
    });

    const result = await runtime.run(state, "resume", {
      maxSteps: 2,
      maxContextChars: 250_000,
      maxOutputChars: 8_000,
      commandTimeoutMs: 1_000,
      approvalPolicy: "never",
    });

    assert.equal(result.reason, "success");
    assert.equal(privateReviewRequests, 0);
    assert.equal(state.progressGuard.incidents[0]?.phase, "review_unavailable");
    assert.equal(state.progressGuard.incidents[0]?.reviewAttempts, 1);
    assert.equal(state.progressGuard.incidents[0]?.reviewModelRequests, 1);
    assert.ok(events.some((event) => event.type === "progress.review.unavailable"));
  });
});
