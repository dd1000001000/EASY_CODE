import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  SessionState,
  SubagentAssignmentSnapshot,
  SubagentTaskReport,
  ToolContext,
} from "../src/core/types.js";
import {
  SubagentCoordinator,
  type SubagentExecutionRequest,
} from "../src/subagents/coordinator.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { describe, it } from "./harness.js";

type StandaloneAssignment = Extract<
  SubagentAssignmentSnapshot,
  { kind: "standalone" }
>;
type DagAssignment = Extract<SubagentAssignmentSnapshot, { kind: "dag" }>;

const CREATED_AT = "2026-08-28T12:00:00.000Z";

function standaloneAssignment(
  overrides: Partial<StandaloneAssignment> = {},
): StandaloneAssignment {
  return {
    kind: "standalone",
    agentId: "subagent_00000000-0000-4000-8000-000000000301",
    childThreadId: "thread_00000000-0000-4000-8000-000000000301",
    environmentId: "environment_00000000-0000-4000-8000-000000000301",
    taskId: "child_durable_recovery",
    taskTitle: "Resume durable child",
    taskDescription: "Continue the child from its private journal and checkout.",
    completionChecks: ["The durable child session finishes successfully"],
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingEffort: "high",
    requestedIsolation: "worktree",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function dagAssignment(overrides: Partial<DagAssignment> = {}): DagAssignment {
  return {
    kind: "dag",
    taskGraphId: "task_graph_00000000-0000-4000-8000-000000000302",
    agentId: "subagent_00000000-0000-4000-8000-000000000302",
    childThreadId: "thread_00000000-0000-4000-8000-000000000302",
    environmentId: "environment_00000000-0000-4000-8000-000000000302",
    taskId: "verify_durable_recovery",
    taskTitle: "Verify durable recovery",
    taskDescription: "Verify the recovered DAG child without changing its binding.",
    completionChecks: ["The recovered DAG task is verified"],
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingEffort: "high",
    requestedIsolation: "worktree",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function appendLifecycle(
  threads: ThreadStore,
  threadId: string,
  turnId: string,
  assignment: SubagentAssignmentSnapshot,
  action: "activate" | "observe",
): void {
  threads.appendEvent(threadId, {
    type: "tool.result",
    turnId,
    phase: "completed",
    payload: {
      callId: `call_${action}_${assignment.agentId}`,
      tool: "manage_subagents",
      message: {
        role: "tool",
        tool_call_id: `call_${action}_${assignment.agentId}`,
        name: "manage_subagents",
        content: '{"ok":true}',
      },
      subagentAssignment: assignment,
      subagentLifecycle: { action, agentId: assignment.agentId },
    },
  });
}

function context(state: Readonly<SessionState>, turnId: string): ToolContext {
  return {
    workspaceRoot: state.workspaceRoot,
    mode: "code",
    threadId: state.threadId,
    turnId,
    approvalPolicy: "never",
    requestApproval: async () => false,
    commandTimeoutMs: 1_000,
    maxOutputChars: 8_000,
    agentRole: "main_agent",
    thinkingEffort: state.thinkingEffort,
    provider: state.provider,
    model: state.model,
  };
}

function completedReport(assignment: SubagentAssignmentSnapshot): SubagentTaskReport {
  return {
    taskId: assignment.taskId,
    outcome: "completed",
    summary: "The persisted child session completed.",
    completionEvidence: assignment.completionChecks.map((check) => ({
      check,
      evidence: "The focused recovery verification passed.",
    })),
  };
}

describe("durable child session recovery", () => {
  it("validates a deferred restore batch before starting any child", async () => {
    const first = standaloneAssignment({
      agentId: "subagent_00000000-0000-4000-8000-000000000310",
      childThreadId: "thread_00000000-0000-4000-8000-000000000310",
      environmentId: "environment_00000000-0000-4000-8000-000000000310",
    });
    const second = standaloneAssignment({
      agentId: "subagent_00000000-0000-4000-8000-000000000311",
      childThreadId: "thread_00000000-0000-4000-8000-000000000311",
      environmentId: "environment_00000000-0000-4000-8000-000000000311",
      taskId: "child_durable_recovery_two",
    });
    let childRuns = 0;
    const coordinator = new SubagentCoordinator({
      run: async (request) => {
        childRuns += 1;
        return {
          reason: "completed",
          report: completedReport(
            request.record.id === first.agentId ? first : second,
          ),
          changes: [],
          commands: [],
          presentations: [],
        };
      },
    });

    coordinator.restore({
      parentThreadId: "thread_parent_deferred_restore",
      createdByTurnId: "turn_first_deferred_restore",
      assignment: first,
    }, { deferActivation: true });
    coordinator.restore({
      parentThreadId: "thread_parent_deferred_restore",
      createdByTurnId: "turn_second_deferred_restore",
      assignment: second,
    }, { deferActivation: true });
    assert.equal(childRuns, 0);

    coordinator.activateRestored([first.agentId, second.agentId]);
    const state = {
      threadId: "thread_parent_deferred_restore",
      workspaceRoot: "C:\\workspace",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingEffort: "high",
    } as SessionState;
    await coordinator.wait(
      { action: "wait", agentIds: [first.agentId, second.agentId], timeoutMs: 1_000 },
      context(state, "turn_wait_deferred_restore"),
    );
    assert.equal(childRuns, 2);
  });

  it("rolls back an unstarted durable restore batch without running children", () => {
    const assignment = standaloneAssignment({
      agentId: "subagent_00000000-0000-4000-8000-000000000312",
      childThreadId: "thread_00000000-0000-4000-8000-000000000312",
      environmentId: "environment_00000000-0000-4000-8000-000000000312",
    });
    let childRuns = 0;
    const coordinator = new SubagentCoordinator({
      run: async () => {
        childRuns += 1;
        throw new Error("Rolled-back children must not run");
      },
    });
    const parentThreadId = "thread_parent_rollback_restore";
    coordinator.restore({
      parentThreadId,
      createdByTurnId: "turn_rollback_restore",
      assignment,
    }, { deferActivation: true });

    coordinator.rollbackRestored([assignment.agentId]);

    assert.equal(childRuns, 0);
    assert.deepEqual(coordinator.snapshot(parentThreadId), []);
  });

  it("discovers V2 standalone and DAG bindings and removes each after observation", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-v2-bindings-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_v2_binding_parent",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "high",
      });
      const standalone = standaloneAssignment();
      const dag = dagAssignment();
      appendLifecycle(threads, state.threadId, "turn_activate_standalone", standalone, "activate");
      appendLifecycle(threads, state.threadId, "turn_activate_dag", dag, "activate");

      const pending = threads.unobservedSubagentAssignments(state.threadId);
      assert.deepEqual(
        pending.map((entry) => entry.assignment),
        [standalone, dag],
      );
      assert.deepEqual(
        pending.map((entry) => entry.createdByTurnId),
        ["turn_activate_standalone", "turn_activate_dag"],
      );

      appendLifecycle(threads, state.threadId, "turn_observe_standalone", standalone, "observe");
      assert.deepEqual(
        threads.unobservedSubagentAssignments(state.threadId).map(
          (entry) => entry.assignment,
        ),
        [dag],
      );

      appendLifecycle(threads, state.threadId, "turn_observe_dag", dag, "observe");
      assert.deepEqual(threads.unobservedSubagentAssignments(state.threadId), []);
      assert.deepEqual(
        threads.subagentAssignments(state.threadId).map((entry) => entry.observed),
        [true, true],
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects an observation that replaces any immutable durable assignment identity", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-binding-identity-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const replacements: ReadonlyArray<{
        name: string;
        replace: (assignment: DagAssignment) => DagAssignment;
      }> = [
        {
          name: "child thread",
          replace: (assignment) => ({ ...assignment, childThreadId: `${assignment.childThreadId}_other` }),
        },
        {
          name: "environment",
          replace: (assignment) => ({ ...assignment, environmentId: `${assignment.environmentId}_other` }),
        },
        {
          name: "task graph",
          replace: (assignment) => ({ ...assignment, taskGraphId: `${assignment.taskGraphId}_other` }),
        },
        {
          name: "task ID",
          replace: (assignment) => ({ ...assignment, taskId: `${assignment.taskId}_other` }),
        },
        {
          name: "task title",
          replace: (assignment) => ({ ...assignment, taskTitle: `${assignment.taskTitle} replacement` }),
        },
        {
          name: "task description",
          replace: (assignment) => ({ ...assignment, taskDescription: `${assignment.taskDescription} replacement` }),
        },
        {
          name: "completion checks",
          replace: (assignment) => ({ ...assignment, completionChecks: ["A replacement check"] }),
        },
        {
          name: "provider",
          replace: (assignment) => ({ ...assignment, provider: "qwen" }),
        },
        {
          name: "model",
          replace: (assignment) => ({ ...assignment, model: "another-model" }),
        },
        {
          name: "thinking effort",
          replace: (assignment) => ({ ...assignment, thinkingEffort: "low" }),
        },
        {
          name: "requested isolation",
          replace: (assignment) => ({ ...assignment, requestedIsolation: "shared" }),
        },
        {
          name: "creation timestamp",
          replace: (assignment) => ({ ...assignment, createdAt: "2026-08-28T12:00:01.000Z" }),
        },
      ];

      replacements.forEach(({ name, replace }, index) => {
        const state = threads.create({
          threadId: `thread_binding_identity_${index}`,
          workspaceRoot: path.join(dataDir, `workspace-${index}`),
          mode: "code",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          thinkingEffort: "high",
        });
        const assignment = dagAssignment({
          agentId: `subagent_binding_identity_${index}`,
          childThreadId: `thread_child_binding_identity_${index}`,
          environmentId: `environment_binding_identity_${index}`,
          taskId: `task_binding_identity_${index}`,
          taskGraphId: `task_graph_binding_identity_${index}`,
        });
        appendLifecycle(
          threads,
          state.threadId,
          `turn_activate_binding_identity_${index}`,
          assignment,
          "activate",
        );
        appendLifecycle(
          threads,
          state.threadId,
          `turn_observe_binding_identity_${index}`,
          replace(assignment),
          "observe",
        );

        assert.throws(
          () => threads.subagentAssignments(state.threadId),
          /Invalid child observation/u,
          name,
        );
      });
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("accepts only the deterministic shared identity upgrade for a legacy binding", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-legacy-binding-upgrade-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const createParent = (suffix: string) => threads.create({
        threadId: `thread_legacy_binding_${suffix}`,
        workspaceRoot: path.join(dataDir, `workspace-${suffix}`),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "high",
      });
      const {
        childThreadId: _childThreadId,
        environmentId: _environmentId,
        requestedIsolation: _requestedIsolation,
        ...legacy
      } = standaloneAssignment();

      const accepted = createParent("accepted");
      appendLifecycle(threads, accepted.threadId, "turn_activate_legacy", legacy, "activate");
      appendLifecycle(threads, accepted.threadId, "turn_observe_legacy", {
        ...legacy,
        childThreadId: `thread_${legacy.agentId}`,
        environmentId: `environment_${legacy.agentId}`,
        requestedIsolation: "shared",
      }, "observe");
      assert.equal(threads.subagentAssignments(accepted.threadId)[0]?.observed, true);

      const rejected = createParent("rejected");
      appendLifecycle(threads, rejected.threadId, "turn_activate_legacy_bad", legacy, "activate");
      appendLifecycle(threads, rejected.threadId, "turn_observe_legacy_bad", {
        ...legacy,
        childThreadId: "thread_attacker_selected",
        environmentId: "environment_attacker_selected",
        requestedIsolation: "shared",
      }, "observe");
      assert.throws(
        () => threads.subagentAssignments(rejected.threadId),
        /Invalid child observation/u,
      );
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("resumes a non-terminal V2 binding with the same child session, environment, and task", async () => {
    const assignment = standaloneAssignment();
    let received: SubagentExecutionRequest | undefined;
    let childRuns = 0;
    const coordinator = new SubagentCoordinator({
      run: async (request) => {
        childRuns += 1;
        received = request;
        return {
          reason: "completed",
          report: completedReport(assignment),
          changes: [],
          commands: [],
          presentations: [],
        };
      },
    });
    coordinator.restore({
      parentThreadId: "thread_parent_durable_resume",
      createdByTurnId: "turn_activate_durable_resume",
      assignment,
    });

    const state = {
      threadId: "thread_parent_durable_resume",
      workspaceRoot: "C:\\workspace",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingEffort: "high",
    } as SessionState;
    const waited = await coordinator.wait(
      { action: "wait", agentIds: [assignment.agentId], timeoutMs: 1_000 },
      context(state, "turn_observe_durable_resume"),
    );

    assert.equal(childRuns, 1);
    assert.equal(received?.record.id, assignment.agentId);
    assert.equal(received?.record.childThreadId, assignment.childThreadId);
    assert.equal(received?.record.environmentId, assignment.environmentId);
    assert.equal(received?.record.requestedIsolation, "worktree");
    assert.deepEqual(
      {
        id: received?.task.id,
        title: received?.task.title,
        description: received?.task.description,
        completionChecks: received?.task.completionChecks,
        assignedAgentId: received?.task.assignedAgentId,
      },
      {
        id: assignment.taskId,
        title: assignment.taskTitle,
        description: assignment.taskDescription,
        completionChecks: assignment.completionChecks,
        assignedAgentId: assignment.agentId,
      },
    );
    assert.equal((waited.data as { timedOut?: boolean }).timedOut, false);
    assert.equal(waited.subagentAssignment?.childThreadId, assignment.childThreadId);
    assert.equal(waited.subagentAssignment?.environmentId, assignment.environmentId);
    assert.equal(coordinator.snapshot(state.threadId)[0]?.status, "completed");
  });

  it("restores a terminal V2 result without rerunning the child", async () => {
    const assignment = standaloneAssignment({
      agentId: "subagent_00000000-0000-4000-8000-000000000303",
      childThreadId: "thread_00000000-0000-4000-8000-000000000303",
      environmentId: "environment_00000000-0000-4000-8000-000000000303",
    });
    let childRuns = 0;
    const coordinator = new SubagentCoordinator({
      run: async () => {
        childRuns += 1;
        throw new Error("A terminal durable child must not be restarted");
      },
    });
    coordinator.restore({
      parentThreadId: "thread_parent_terminal_restore",
      createdByTurnId: "turn_activate_terminal_restore",
      assignment,
      reason: "completed",
      report: completedReport(assignment),
      finishedAt: "2026-08-28T12:05:00.000Z",
    });

    const state = {
      threadId: "thread_parent_terminal_restore",
      workspaceRoot: "C:\\workspace",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingEffort: "high",
    } as SessionState;
    const waited = await coordinator.wait(
      { action: "wait", agentIds: [assignment.agentId], timeoutMs: 0 },
      context(state, "turn_observe_terminal_restore"),
    );

    assert.equal(childRuns, 0);
    assert.equal((waited.data as { timedOut?: boolean }).timedOut, false);
    assert.equal(waited.subagentLifecycle?.action, "observe");
    assert.equal(coordinator.snapshot(state.threadId)[0]?.status, "completed");
  });

  it("restores observed terminal history without making it outstanding or rerunning it", () => {
    const assignment = standaloneAssignment({
      agentId: "subagent_00000000-0000-4000-8000-000000000305",
      childThreadId: "thread_00000000-0000-4000-8000-000000000305",
      environmentId: "environment_00000000-0000-4000-8000-000000000305",
    });
    let childRuns = 0;
    const coordinator = new SubagentCoordinator({
      run: async () => {
        childRuns += 1;
        throw new Error("Observed history must not be restarted");
      },
    });
    coordinator.restore({
      parentThreadId: "thread_parent_observed_restore",
      createdByTurnId: "turn_activate_observed_restore",
      assignment,
      reason: "completed",
      report: completedReport(assignment),
      finishedAt: "2026-08-28T12:06:00.000Z",
      observed: true,
    });

    assert.equal(childRuns, 0);
    assert.equal(coordinator.hasOutstanding("thread_parent_observed_restore"), false);
    assert.equal(
      coordinator.snapshot("thread_parent_observed_restore")[0]?.status,
      "completed",
    );
  });

  it("keeps a legacy standalone binding safely terminal through restoreStandalone", async () => {
    const durable = standaloneAssignment({
      agentId: "subagent_00000000-0000-4000-8000-000000000304",
    });
    const {
      childThreadId: _childThreadId,
      environmentId: _environmentId,
      requestedIsolation: _requestedIsolation,
      ...legacy
    } = durable;
    let childRuns = 0;
    const coordinator = new SubagentCoordinator({
      run: async () => {
        childRuns += 1;
        throw new Error("A legacy interrupted child must not be restarted");
      },
    });
    coordinator.restoreStandalone({
      parentThreadId: "thread_parent_legacy_restore",
      createdByTurnId: "turn_activate_legacy_restore",
      assignment: legacy,
      reason: "interrupted",
      error: "The previous process exited before the legacy child returned.",
      finishedAt: "2026-08-28T12:10:00.000Z",
    });

    const state = {
      threadId: "thread_parent_legacy_restore",
      workspaceRoot: "C:\\workspace",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingEffort: "high",
    } as SessionState;
    const waited = await coordinator.wait(
      { action: "wait", agentIds: [legacy.agentId], timeoutMs: 0 },
      context(state, "turn_observe_legacy_restore"),
    );

    assert.equal(childRuns, 0);
    assert.equal((waited.data as { timedOut?: boolean }).timedOut, false);
    assert.equal(coordinator.snapshot(state.threadId)[0]?.status, "interrupted");
    assert.equal(
      coordinator.snapshot(state.threadId)[0]?.childThreadId,
      `thread_${legacy.agentId}`,
    );
    assert.equal(
      coordinator.snapshot(state.threadId)[0]?.environmentId,
      `environment_${legacy.agentId}`,
    );
  });
});
