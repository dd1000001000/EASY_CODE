import assert from "node:assert/strict";

import type {
  SubagentLifecycleUpdate,
  SubagentTaskReport,
  TaskGraph,
  ToolContext,
  ToolExecutionResult,
} from "../src/core/types.js";
import {
  maxConcurrentSubagents,
  SubagentCoordinator,
  type SubagentExecutionOutcome,
  type SubagentExecutionRequest,
} from "../src/subagents/coordinator.js";
import { applyTaskGraphOperation, taskGraphView } from "../src/tasks/task-graph.js";
import { describe, it } from "./harness.js";

const AGENT_ONE = "subagent_00000000-0000-4000-8000-000000000001";
const AGENT_TWO = "subagent_00000000-0000-4000-8000-000000000002";
const AGENT_THREE = "subagent_00000000-0000-4000-8000-000000000003";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function graph(taskIds: readonly string[]): TaskGraph {
  return applyTaskGraphOperation(undefined, {
    action: "create",
    goal: "Coordinate isolated child tasks",
    tasks: taskIds.map((id) => ({
      id,
      title: `Task ${id}`,
      description: `Complete only ${id}`,
      dependencies: [],
      inputs: [],
      expectedArtifacts: [`artifact-${id}`],
      completionChecks: [`${id} is verified`],
      failureHandling: `Release ${id} for reassignment`,
    })),
  }, {
    turnId: "turn_create_subagent_graph",
    now: () => new Date("2026-08-27T10:00:00.000Z"),
  });
}

function context(
  taskGraph: Readonly<TaskGraph> | undefined,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    mode: "code",
    threadId: "thread_subagent_coordinator",
    turnId: "turn_subagent_coordinator",
    approvalPolicy: "never",
    requestApproval: async () => false,
    commandTimeoutMs: 1_000,
    maxOutputChars: 8_000,
    agentRole: "main_agent",
    thinkingEffort: "high",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    ...(taskGraph ? { taskGraph } : {}),
    ...overrides,
  };
}

function idFactory(ids: readonly string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    if (!id) throw new Error("Test subagent ID sequence was exhausted");
    index += 1;
    return id;
  };
}

function lifecycle(result: Readonly<ToolExecutionResult>, action: SubagentLifecycleUpdate["action"]):
SubagentLifecycleUpdate {
  const update = result.subagentLifecycle;
  assert.ok(update, `Expected a ${action} lifecycle update`);
  assert.equal(update.action, action);
  return update;
}

function completedOutcome(taskId: string): SubagentExecutionOutcome {
  const report: SubagentTaskReport = {
    taskId,
    outcome: "completed",
    summary: `Completed ${taskId} in an isolated context.`,
    completionEvidence: [{
      check: `${taskId} is verified`,
      evidence: `${taskId} focused verification passed`,
    }],
  };
  return {
    report,
    reason: "completed",
    changes: [],
    commands: [],
    presentations: [],
  };
}

describe("SubagentCoordinator", () => {
  it("scales the default concurrency limit as 2, 2, 4, and 8", async () => {
    assert.deepEqual(
      (["none", "low", "medium", "high"] as const).map(maxConcurrentSubagents),
      [2, 2, 4, 8],
    );

    for (const [thinkingEffort, limit] of [
      ["none", 2],
      ["low", 2],
      ["medium", 4],
      ["high", 8],
    ] as const) {
      const ids = Array.from({ length: limit + 1 }, (_value, index) =>
        `subagent_00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`);
      const coordinator = new SubagentCoordinator({
        createAgentId: idFactory(ids),
        run: async () => new Promise<SubagentExecutionOutcome>(() => undefined),
      });
      let latestActive = 0;
      for (let index = 0; index < limit; index += 1) {
        const spawned = await coordinator.spawn({
          action: "spawn",
          task: {
            title: `Standalone ${index + 1}`,
            description: "Perform isolated verification without a DAG.",
            completionChecks: ["Verification is reported"],
          },
          instructions: "Keep the result concise.",
        }, context(undefined, { thinkingEffort }));
        const concurrency = (spawned.data as {
          concurrency: { active: number; limit: number };
        }).concurrency;
        latestActive = concurrency.active;
        assert.equal(concurrency.limit, limit);
      }
      assert.equal(latestActive, limit);
      await assert.rejects(
        coordinator.spawn({
          action: "spawn",
          task: {
            title: "One too many",
            description: "This assignment must exceed the limit.",
            completionChecks: ["It is never started"],
          },
          instructions: "Do not run.",
        }, context(undefined, { thinkingEffort })),
        new RegExp(`concurrency limit is ${limit}`, "u"),
      );
    }
  });

  it("authorizes every parent thinking effort in effective Code mode", () => {
    const taskGraph = graph(["inspect"]);
    const coordinator = new SubagentCoordinator({
      run: async () => completedOutcome("inspect"),
    });

    for (const thinkingEffort of ["none", "low", "medium", "high"] as const) {
      assert.doesNotThrow(() => coordinator.assertAuthorized(context(undefined, {
        thinkingEffort,
      })));
    }
    assert.throws(
      () => coordinator.assertAuthorized(context(taskGraph, { agentRole: "subagent" })),
      /Only the main agent/u,
    );
    assert.throws(
      () => coordinator.assertAuthorized(context(taskGraph, { mode: "plan" })),
      /only in effective Code mode/u,
    );
  });

  it("binds spawn to the DAG but does not execute before lifecycle commit", async () => {
    const taskGraph = graph(["inspect"]);
    const requests: SubagentExecutionRequest[] = [];
    const coordinator = new SubagentCoordinator({
      createAgentId: idFactory([AGENT_ONE]),
      run: async (request) => {
        requests.push(request);
        return completedOutcome(request.task.id);
      },
    });

    const spawned = await coordinator.spawn({
      action: "spawn",
      taskId: "inspect",
      instructions: "Inspect only the assigned task and return concise evidence.",
    }, context(taskGraph));
    assert.equal(spawned.ok, true);
    assert.equal(requests.length, 0, "prepared children must not start before Runtime commit");
    const assigned = spawned.taskGraphUpdate?.tasks.find((task) => task.id === "inspect");
    assert.equal(assigned?.status, "in_progress");
    assert.equal(assigned?.owner, "subagent");
    assert.equal(assigned?.assignedAgentId, AGENT_ONE);
    assert.equal(spawned.subagentTaskOperation?.action, "claim");
    const spawnedAgent = (spawned.data as {
      agent: { taskGraphId: string; taskId: string; taskTitle: string };
    }).agent;
    assert.equal(spawnedAgent.taskGraphId, taskGraph.id);
    assert.equal(spawnedAgent.taskId, "inspect");
    assert.equal(spawnedAgent.taskTitle, "Task inspect");

    coordinator.commitLifecycle(lifecycle(spawned, "activate"));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.record.mode, "code");
    assert.equal(requests[0]?.record.thinkingEffort, "high");
    assert.equal(requests[0]?.record.taskId, "inspect");
    assert.equal(requests[0]?.record.taskTitle, "Task inspect");

    const status = await coordinator.status({ action: "status" }, context(
      spawned.taskGraphUpdate as TaskGraph,
    ));
    const statusAgent = (status.data as {
      agents: Array<{ taskId: string; taskTitle: string }>;
    }).agents[0];
    assert.equal(statusAgent?.taskId, "inspect");
    assert.equal(statusAgent?.taskTitle, "Task inspect");

    const waited = await coordinator.wait({
      action: "wait",
      agentIds: [AGENT_ONE],
      timeoutMs: 100,
    }, context(spawned.taskGraphUpdate as TaskGraph));
    assert.equal(waited.subagentTaskOperation?.action, "complete");
    assert.equal(waited.taskGraphUpdate?.status, "completed");
    coordinator.commitLifecycle(lifecycle(waited, "observe"));
    assert.equal(coordinator.snapshot(context(taskGraph).threadId)[0]?.taskTitle, "Task inspect");
  });

  it("runs and observes a named standalone assignment without creating a DAG", async () => {
    const requests: SubagentExecutionRequest[] = [];
    const coordinator = new SubagentCoordinator({
      createAgentId: idFactory([AGENT_ONE]),
      run: async (request) => {
        requests.push(request);
        return {
          report: {
            taskId: request.task.id,
            outcome: "completed",
            summary: "Standalone inspection completed.",
            completionEvidence: [{
              check: request.task.completionChecks[0] as string,
              evidence: "The focused inspection passed.",
            }],
          },
          reason: "completed",
          changes: [],
          commands: [],
          presentations: [],
        };
      },
    });
    const standaloneContext = context(undefined, { thinkingEffort: "medium" });
    const spawned = await coordinator.spawn({
      action: "spawn",
      task: {
        title: "Inspect authentication",
        description: "Inspect authentication without creating a task DAG.",
        completionChecks: ["Authentication findings are verified"],
      },
      instructions: "Return only concrete findings.",
    }, standaloneContext);

    assert.equal(spawned.taskGraphUpdate, undefined);
    assert.equal(spawned.subagentTaskOperation, undefined);
    assert.equal(spawned.subagentAssignment?.kind, "standalone");
    assert.equal(spawned.subagentAssignment?.taskTitle, "Inspect authentication");
    assert.equal(requests.length, 0);
    coordinator.commitLifecycle(lifecycle(spawned, "activate"));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.record.assignmentKind, "standalone");
    assert.equal(requests[0]?.record.thinkingEffort, "medium");

    const waited = await coordinator.wait({
      action: "wait",
      agentIds: [AGENT_ONE],
      timeoutMs: 100,
    }, standaloneContext);
    assert.equal(waited.taskGraphUpdate, undefined);
    assert.equal(waited.subagentTaskOperation, undefined);
    assert.equal(waited.subagentAssignment?.kind, "standalone");
    assert.equal(waited.subagentLifecycle?.action, "observe");
    const artifacts = coordinator.commitLifecycle(lifecycle(waited, "observe"));
    assert.equal(artifacts?.agentId, AGENT_ONE);
    coordinator.finalizeArtifactMerge(AGENT_ONE);
    assert.equal(coordinator.hasOutstanding(standaloneContext.threadId), false);
  });

  it("keeps standalone work outside an unfinished DAG and DAG work inside one", async () => {
    const coordinator = new SubagentCoordinator({
      createAgentId: idFactory([AGENT_ONE, AGENT_TWO]),
      run: async () => completedOutcome("inspect"),
    });
    await assert.rejects(
      coordinator.spawn({
        action: "spawn",
        task: {
          title: "Bypass graph",
          description: "This must not bypass an active graph.",
          completionChecks: ["Never runs"],
        },
        instructions: "Do not run.",
      }, context(graph(["inspect"]))),
      /Standalone child assignments are unavailable/u,
    );
    await assert.rejects(
      coordinator.spawn({
        action: "spawn",
        taskId: "inspect",
        instructions: "A DAG task cannot be claimed without a graph.",
      }, context(undefined)),
      /active task DAG/u,
    );
  });

  it("rolls back a prepared spawn whose authoritative DAG event did not commit", async () => {
    const initialGraph = graph(["first", "second"]);
    let runs = 0;
    const coordinator = new SubagentCoordinator({
      maxConcurrent: 1,
      createAgentId: idFactory([AGENT_ONE, AGENT_TWO]),
      run: async (request) => {
        runs += 1;
        return completedOutcome(request.task.id);
      },
    });
    const prepared = await coordinator.spawn({
      action: "spawn",
      taskId: "first",
      instructions: "Prepare the first child.",
    }, context(initialGraph));
    coordinator.rollbackLifecycle(lifecycle(prepared, "activate"));
    assert.equal(runs, 0);
    assert.deepEqual(coordinator.snapshot(context(initialGraph).threadId), []);

    const replacement = await coordinator.spawn({
      action: "spawn",
      taskId: "second",
      instructions: "The rolled-back reservation must not consume the only slot.",
    }, context(initialGraph));
    assert.equal(replacement.ok, true);
    assert.equal(replacement.subagentLifecycle?.agentId, AGENT_TWO);
  });

  it("runs two independent children, preserves follow-up FIFO, and enforces concurrency", async () => {
    const initialGraph = graph(["backend", "frontend", "remaining"]);
    const backend = deferred<SubagentExecutionOutcome>();
    const frontend = deferred<SubagentExecutionOutcome>();
    const requests = new Map<string, SubagentExecutionRequest>();
    const coordinator = new SubagentCoordinator({
      maxConcurrent: 2,
      createAgentId: idFactory([AGENT_ONE, AGENT_TWO, AGENT_THREE]),
      run: (request) => {
        requests.set(request.record.id, request);
        return request.record.id === AGENT_ONE ? backend.promise : frontend.promise;
      },
    });

    const first = await coordinator.spawn({
      action: "spawn",
      taskId: "backend",
      instructions: "Implement the backend branch.",
    }, context(initialGraph));
    const firstGraph = first.taskGraphUpdate as TaskGraph;
    const second = await coordinator.spawn({
      action: "spawn",
      taskId: "frontend",
      instructions: "Implement the frontend branch.",
    }, context(firstGraph));
    const parallelGraph = second.taskGraphUpdate as TaskGraph;
    assert.deepEqual(taskGraphView(parallelGraph).startableTasks, ["remaining"]);
    await assert.rejects(
      coordinator.spawn({
        action: "spawn",
        taskId: "remaining",
        instructions: "Exceed the configured child limit.",
      }, context(parallelGraph)),
      /concurrency limit is 2/u,
    );

    coordinator.commitLifecycle(lifecycle(first, "activate"));
    coordinator.commitLifecycle(lifecycle(second, "activate"));
    assert.equal(requests.size, 2);
    const firstFollowUp = await coordinator.followUp({
      action: "follow_up",
      agentId: AGENT_ONE,
      message: "First inspect the API boundary.",
    }, context(parallelGraph));
    assert.deepEqual(requests.get(AGENT_ONE)?.drainFollowUps(), []);
    coordinator.commitLifecycle(lifecycle(firstFollowUp, "deliver_follow_up"));
    const secondFollowUp = await coordinator.followUp({
      action: "follow_up",
      agentId: AGENT_ONE,
      message: "Then run the focused backend test.",
    }, context(parallelGraph));
    coordinator.commitLifecycle(lifecycle(secondFollowUp, "deliver_follow_up"));
    assert.deepEqual(requests.get(AGENT_ONE)?.drainFollowUps(), [
      "First inspect the API boundary.",
      "Then run the focused backend test.",
    ]);
    assert.deepEqual(requests.get(AGENT_ONE)?.drainFollowUps(), []);

    backend.resolve(completedOutcome("backend"));
    frontend.resolve(completedOutcome("frontend"));
    const observedBackend = await coordinator.wait({
      action: "wait",
      agentIds: [AGENT_ONE],
      timeoutMs: 100,
    }, context(parallelGraph));
    assert.equal(observedBackend.subagentTaskOperation?.action, "complete");
    const afterBackend = observedBackend.taskGraphUpdate as TaskGraph;
    coordinator.commitLifecycle(lifecycle(observedBackend, "observe"));

    const observedFrontend = await coordinator.wait({
      action: "wait",
      agentIds: [AGENT_TWO],
      timeoutMs: 100,
    }, context(afterBackend));
    assert.equal(observedFrontend.subagentTaskOperation?.action, "complete");
    coordinator.commitLifecycle(lifecycle(observedFrontend, "observe"));
    assert.equal(observedFrontend.taskGraphUpdate?.tasks.filter(
      (task) => task.status === "completed",
    ).length, 2);
  });

  it("releases a failed child task only when its terminal result is observed", async () => {
    const initialGraph = graph(["verify"]);
    const coordinator = new SubagentCoordinator({
      createAgentId: idFactory([AGENT_ONE]),
      run: async () => ({
        reason: "failed",
        error: "Focused verification failed.",
        changes: [],
        commands: [],
        presentations: [],
      }),
    });
    const spawned = await coordinator.spawn({
      action: "spawn",
      taskId: "verify",
      instructions: "Run focused verification.",
    }, context(initialGraph));
    coordinator.commitLifecycle(lifecycle(spawned, "activate"));

    const waited = await coordinator.wait({
      action: "wait",
      agentIds: [AGENT_ONE],
      timeoutMs: 100,
    }, context(spawned.taskGraphUpdate as TaskGraph));
    assert.equal(waited.subagentTaskOperation?.action, "release");
    const released = waited.taskGraphUpdate?.tasks.find((task) => task.id === "verify");
    assert.equal(released?.status, "pending");
    assert.equal(released?.owner, "main_agent");
    assert.equal(released?.assignedAgentId, undefined);
    assert.equal(
      (waited.data as { error?: string }).error,
      "Focused verification failed.",
    );
    const artifacts = coordinator.commitLifecycle(lifecycle(waited, "observe"));
    assert.equal(artifacts?.agentId, AGENT_ONE);
    assert.deepEqual(artifacts?.changes, []);
    assert.equal(
      coordinator.pendingArtifactMerges("thread_subagent_coordinator").length,
      1,
    );
    assert.equal(coordinator.hasOutstanding("thread_subagent_coordinator"), true);
    coordinator.finalizeArtifactMerge(AGENT_ONE);
    assert.equal(coordinator.hasOutstanding("thread_subagent_coordinator"), false);
  });

  it("stops an active child and releases its task after waiting for settlement", async () => {
    const initialGraph = graph(["long_running"]);
    let childSignal: AbortSignal | undefined;
    const coordinator = new SubagentCoordinator({
      createAgentId: idFactory([AGENT_ONE]),
      run: (request) => {
        childSignal = request.signal;
        return new Promise<SubagentExecutionOutcome>((resolve) => {
          request.signal.addEventListener("abort", () => resolve({
            reason: "stopped",
            error: "Stopped by parent.",
            changes: [],
            commands: [],
            presentations: [],
          }), { once: true });
        });
      },
    });
    const spawned = await coordinator.spawn({
      action: "spawn",
      taskId: "long_running",
      instructions: "Wait for a parent cancellation.",
    }, context(initialGraph));
    const claimedGraph = spawned.taskGraphUpdate as TaskGraph;
    coordinator.commitLifecycle(lifecycle(spawned, "activate"));

    const stopped = await coordinator.stop({
      action: "stop",
      agentId: AGENT_ONE,
      reason: "The result is no longer needed.",
    }, context(claimedGraph));
    assert.equal(childSignal?.aborted, false);
    coordinator.commitLifecycle(lifecycle(stopped, "request_stop"));
    assert.equal(childSignal?.aborted, true);
    assert.equal(
      (stopped.data as { agent: { status: string } }).agent.status,
      "stopping",
    );
    const waited = await coordinator.wait({
      action: "wait",
      agentIds: [AGENT_ONE],
      timeoutMs: 100,
    }, context(claimedGraph));
    assert.equal(waited.subagentTaskOperation?.action, "release");
    assert.equal(waited.taskGraphUpdate?.tasks[0]?.status, "pending");
    coordinator.commitLifecycle(lifecycle(waited, "observe"));
    assert.equal(coordinator.hasUnfinished(), false);
  });

  it("lets a committed stop win a race with a late completion report", async () => {
    const initialGraph = graph(["race"]);
    const late = deferred<SubagentExecutionOutcome>();
    const coordinator = new SubagentCoordinator({
      createAgentId: idFactory([AGENT_ONE]),
      run: async () => late.promise,
    });
    const spawned = await coordinator.spawn({
      action: "spawn",
      taskId: "race",
      instructions: "Return only after the parent cancellation race.",
    }, context(initialGraph));
    const claimedGraph = spawned.taskGraphUpdate as TaskGraph;
    coordinator.commitLifecycle(lifecycle(spawned, "activate"));
    const stopped = await coordinator.stop({
      action: "stop",
      agentId: AGENT_ONE,
      reason: "Cancel before the late completion is accepted.",
    }, context(claimedGraph));
    coordinator.commitLifecycle(lifecycle(stopped, "request_stop"));
    late.resolve(completedOutcome("race"));

    const waited = await coordinator.wait({
      action: "wait",
      agentIds: [AGENT_ONE],
      timeoutMs: 100,
    }, context(claimedGraph));
    assert.equal(waited.subagentTaskOperation?.action, "release");
    assert.equal(waited.taskGraphUpdate?.tasks[0]?.status, "pending");
  });

  it("lets a durable prepared stop win when completion settles before local commit", async () => {
    const initialGraph = graph(["durable_stop_race"]);
    const late = deferred<SubagentExecutionOutcome>();
    const coordinator = new SubagentCoordinator({
      createAgentId: idFactory([AGENT_ONE]),
      run: async () => late.promise,
    });
    const spawned = await coordinator.spawn({
      action: "spawn",
      taskId: "durable_stop_race",
      instructions: "Exercise event-before-effect cancellation ordering.",
    }, context(initialGraph));
    const claimedGraph = spawned.taskGraphUpdate as TaskGraph;
    coordinator.commitLifecycle(lifecycle(spawned, "activate"));
    const preparedStop = await coordinator.stop({
      action: "stop",
      agentId: AGENT_ONE,
      reason: "The durable cancellation intent must win.",
    }, context(claimedGraph));

    late.resolve(completedOutcome("durable_stop_race"));
    await Promise.resolve();
    await Promise.resolve();
    coordinator.commitLifecycle(lifecycle(preparedStop, "request_stop"));
    const waited = await coordinator.wait({
      action: "wait",
      agentIds: [AGENT_ONE],
      timeoutMs: 100,
    }, context(claimedGraph));
    assert.equal(waited.subagentTaskOperation?.action, "release");
    assert.equal(waited.taskGraphUpdate?.tasks[0]?.status, "pending");
  });

  it("discards settled process-local jobs when their parent thread is closed", async () => {
    const initialGraph = graph(["settled"]);
    const running = deferred<SubagentExecutionOutcome>();
    const coordinator = new SubagentCoordinator({
      createAgentId: idFactory([AGENT_ONE]),
      run: async () => running.promise,
    });
    const spawned = await coordinator.spawn({
      action: "spawn",
      taskId: "settled",
      instructions: "Finish after the discard guard is verified.",
    }, context(initialGraph));
    coordinator.commitLifecycle(lifecycle(spawned, "activate"));

    assert.throws(
      () => coordinator.discardThread("thread_subagent_coordinator"),
      /still running/u,
    );
    running.resolve(completedOutcome("settled"));
    await coordinator.shutdown("thread_subagent_coordinator");
    assert.equal(coordinator.hasOutstanding("thread_subagent_coordinator"), true);

    const pending = coordinator.pendingArtifactMerges("thread_subagent_coordinator");
    assert.equal(pending.length, 1);
    coordinator.finalizeArtifactMerge(AGENT_ONE);
    coordinator.discardThread("thread_subagent_coordinator");
    assert.equal(coordinator.hasOutstanding("thread_subagent_coordinator"), false);
    assert.deepEqual(coordinator.snapshot("thread_subagent_coordinator"), []);
  });
});
