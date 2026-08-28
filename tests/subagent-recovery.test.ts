import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EasyCodeApp,
  releaseOrphanedSubagentTasks,
} from "../src/app.js";
import { createDefaultEasyCodeConfig } from "../src/config/index.js";
import type {
  ExecutionEnvironmentSnapshot,
  ResultArtifact,
  SessionState,
  SubagentAssignmentSnapshot,
  ToolContext,
} from "../src/core/types.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { createStorage } from "../src/storage/database.js";
import {
  SubagentCoordinator,
  type SubagentExecutionOutcome,
  type SubagentExecutionRequest,
} from "../src/subagents/coordinator.js";
import { WorkspaceMutationLock } from "../src/subagents/workspace-mutation-lock.js";
import {
  applySubagentTaskOperation,
  applyTaskGraphOperation,
} from "../src/tasks/task-graph.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { describe, it } from "./harness.js";

type StandaloneAssignment = Extract<
  SubagentAssignmentSnapshot,
  { kind: "standalone" }
>;

const STANDALONE_AGENT_ID =
  "subagent_00000000-0000-4000-8000-000000000201";

function standaloneAssignment(
  overrides: Partial<StandaloneAssignment> = {},
): StandaloneAssignment {
  return {
    kind: "standalone",
    agentId: STANDALONE_AGENT_ID,
    taskId: "standalone_recovery",
    taskTitle: "Inspect recovery state",
    taskDescription: "Inspect the saved thread and report a verified result.",
    completionChecks: ["Recovery behavior is verified"],
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingEffort: "medium",
    createdAt: "2026-08-27T13:00:00.000Z",
    ...overrides,
  };
}

function appendStandaloneLifecycle(
  threads: ThreadStore,
  threadId: string,
  turnId: string,
  assignment: StandaloneAssignment,
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

function standaloneContext(state: Readonly<SessionState>, turnId: string): ToolContext {
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

function restoreStandaloneViaApp(
  threads: ThreadStore,
  state: SessionState,
  coordinator: SubagentCoordinator,
): number {
  const app = Object.create(EasyCodeApp.prototype) as EasyCodeApp;
  Object.defineProperties(app, {
    threadStore: { value: threads },
    state: { value: state },
    subagentCoordinator: { value: coordinator },
  });
  return (app as unknown as { restoreSubagents(): number })
    .restoreSubagents();
}

describe("subagent task journal recovery", () => {
  it("rolls back the complete prepared restore batch when a later binding is invalid", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-restore-batch-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_restore_batch_parent",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "high",
      });
      const first = standaloneAssignment({
        agentId: "subagent_00000000-0000-4000-8000-000000000221",
        childThreadId: "thread_00000000-0000-4000-8000-000000000221",
        environmentId: "environment_00000000-0000-4000-8000-000000000221",
        requestedIsolation: "worktree",
      });
      const second = standaloneAssignment({
        agentId: "subagent_00000000-0000-4000-8000-000000000222",
        childThreadId: "thread_00000000-0000-4000-8000-000000000222",
        environmentId: "environment_00000000-0000-4000-8000-000000000222",
        taskId: "standalone_recovery_second",
        requestedIsolation: "worktree",
      });
      appendStandaloneLifecycle(threads, state.threadId, "turn_restore_first", first, "activate");
      appendStandaloneLifecycle(threads, state.threadId, "turn_restore_second", second, "activate");

      const prepared: string[] = [];
      const rolledBack: string[][] = [];
      let activated = false;
      const coordinator = {
        hasAgent: () => false,
        restore: (input: { assignment: StandaloneAssignment }) => {
          if (input.assignment.agentId === second.agentId) {
            throw new Error("second durable binding is invalid");
          }
          prepared.push(input.assignment.agentId);
        },
        restoreStandalone: () => {
          throw new Error("V2 recovery must use the regular restore path");
        },
        rollbackRestored: (agentIds: readonly string[]) => {
          rolledBack.push([...agentIds]);
        },
        activateRestored: () => {
          activated = true;
        },
      };
      const app = Object.create(EasyCodeApp.prototype) as EasyCodeApp;
      Object.defineProperties(app, {
        threadStore: { value: threads },
        state: { value: state },
        subagentCoordinator: { value: coordinator },
      });

      assert.throws(
        () => (app as unknown as { restoreSubagents(): number }).restoreSubagents(),
        /second durable binding is invalid/u,
      );
      assert.deepEqual(prepared, [first.agentId]);
      assert.deepEqual(rolledBack, [[first.agentId]]);
      assert.equal(activated, false);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed when an existing child session has lost its execution environment", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-missing-child-env-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const parent = threads.create({
        threadId: "thread_missing_env_parent",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "high",
      });
      const childThreadId = "thread_00000000-0000-4000-8000-000000000223";
      threads.create({
        threadId: childThreadId,
        workspaceRoot: path.join(dataDir, "old-child-worktree"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "high",
      });
      let provisionCalls = 0;
      const missing = Object.assign(new Error("missing environment record"), {
        code: "ENOENT",
      });
      const app = Object.create(EasyCodeApp.prototype) as EasyCodeApp;
      Object.defineProperties(app, {
        threadStore: { value: threads },
        state: { value: parent },
        workspace: { value: { root: parent.workspaceRoot } },
        executionEnvironments: {
          value: {
            loadEnvironment: async () => Promise.reject(missing),
            provision: async () => {
              provisionCalls += 1;
              throw new Error("must not provision");
            },
          },
        },
      });
      const request = {
        record: {
          id: "subagent_00000000-0000-4000-8000-000000000223",
          childThreadId,
          environmentId: "environment_00000000-0000-4000-8000-000000000223",
          parentThreadId: parent.threadId,
          createdByTurnId: "turn_missing_child_environment",
          assignmentKind: "standalone",
          taskId: "missing_child_environment",
          taskTitle: "Resume exact child environment",
          mode: "code",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          thinkingEffort: "high",
          requestedIsolation: "worktree",
          status: "running",
          revision: 1,
          instructions: "Resume only the exact durable child.",
          followUpCount: 0,
          createdAt: "2026-08-28T14:00:00.000Z",
          startedAt: "2026-08-28T14:00:00.000Z",
          updatedAt: "2026-08-28T14:00:00.000Z",
        },
        task: {
          id: "missing_child_environment",
          title: "Resume exact child environment",
          description: "The old child environment must not be replaced.",
          dependencies: [],
          inputs: [],
          expectedArtifacts: [],
          completionChecks: ["The exact child environment is restored"],
          failureHandling: "Fail closed if the environment is missing.",
          owner: "subagent",
          assignedAgentId: "subagent_00000000-0000-4000-8000-000000000223",
          status: "in_progress",
          startedAt: "2026-08-28T14:00:00.000Z",
        },
        signal: new AbortController().signal,
        drainFollowUps: () => [],
        reportEnvironment: () => undefined,
        isPauseRequested: () => false,
      } as SubagentExecutionRequest;

      const outcome = await (
        app as unknown as {
          runSubagent(input: SubagentExecutionRequest): Promise<SubagentExecutionOutcome>;
        }
      ).runSubagent(request);

      assert.equal(outcome.reason, "failed");
      assert.equal(provisionCalls, 0);
      assert.match(outcome.error ?? "", /refusing to create a different checkout/u);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps a verified completion atomic when pause arrives during artifact finalization", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-finalize-pause-"));
    const workspaceRoot = path.join(dataDir, "workspace");
    const childRoot = path.join(dataDir, "managed-worktree");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(childRoot, { recursive: true });
    const storage = createStorage(dataDir);
    const originalRun = AgentRuntime.prototype.run;
    try {
      const threads = new ThreadStore(storage);
      const workspace = await WorkspaceManager.create(workspaceRoot);
      const childWorkspace = await WorkspaceManager.create(childRoot);
      const parent = threads.create({
        threadId: "thread_finalize_pause_parent",
        workspaceRoot: workspace.root,
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "high",
      });
      const agentId = "subagent_00000000-0000-4000-8000-000000000224";
      const childThreadId = "thread_00000000-0000-4000-8000-000000000224";
      const environmentId = "environment_00000000-0000-4000-8000-000000000224";
      const taskId = "finalize_pause_atomicity";
      const createdAt = "2026-08-28T14:10:00.000Z";
      const baseCommit = "1".repeat(40);
      const resultCommit = "2".repeat(40);
      const baseEnvironment: ExecutionEnvironmentSnapshot = {
        id: environmentId,
        agentId,
        parentThreadId: parent.threadId,
        childThreadId,
        taskId,
        kind: "worktree",
        status: "ready",
        logicalWorkspaceRoot: workspace.root,
        executionRoot: childWorkspace.root,
        requestedIsolation: "worktree",
        baseMode: "current-snapshot",
        repositoryRoot: workspace.root,
        worktreeRoot: childWorkspace.root,
        baseCommit,
        baselineCommit: baseCommit,
        handoffBaseCommit: baseCommit,
        createdAt,
        updatedAt: createdAt,
      };
      const finalEnvironment: ExecutionEnvironmentSnapshot = {
        ...baseEnvironment,
        status: "result_ready",
        resultCommit,
        updatedAt: "2026-08-28T14:10:02.000Z",
      };
      const artifact: ResultArtifact = {
        id: "artifact_00000000-0000-4000-8000-000000000224",
        agentId,
        taskId,
        environmentId,
        environmentKind: "worktree",
        status: "ready",
        logicalWorkspaceRoot: workspace.root,
        baseCommit,
        resultCommit,
        parentArtifactIds: [],
        changedFiles: ["verified-result.txt"],
        createdAt: "2026-08-28T14:10:02.000Z",
        updatedAt: "2026-08-28T14:10:02.000Z",
      };
      let provisioned = false;
      let finalized = false;
      let markFinalizeEntered!: () => void;
      let releaseFinalize!: () => void;
      const finalizeEntered = new Promise<void>((resolve) => {
        markFinalizeEntered = resolve;
      });
      const finalizeGate = new Promise<void>((resolve) => {
        releaseFinalize = resolve;
      });
      const missing = Object.assign(new Error("missing first environment"), {
        code: "ENOENT",
      });
      const executionEnvironments = {
        loadEnvironment: async () => {
          if (!provisioned) throw missing;
          return finalized ? finalEnvironment : baseEnvironment;
        },
        provision: async () => {
          provisioned = true;
          return { descriptor: baseEnvironment, workspace: childWorkspace };
        },
        markRunning: async () => ({ ...baseEnvironment, status: "running" as const }),
        finalize: async (
          _environment: unknown,
          input: { accepted: boolean },
        ) => {
          assert.equal(input.accepted, true);
          markFinalizeEntered();
          await finalizeGate;
          finalized = true;
          return artifact;
        },
      };
      const config = createDefaultEasyCodeConfig(workspace.root);
      config.dataDir = dataDir;
      config.provider = "deepseek";
      config.mode = "code";
      config.thinkingEffort = "high";
      config.deepseek.apiKey = "test-key";
      config.deepseek.model = "deepseek-v4-flash";
      const app = Object.create(EasyCodeApp.prototype) as EasyCodeApp;
      Object.defineProperties(app, {
        config: { value: config },
        state: { value: parent },
        workspace: { value: workspace },
        threadStore: { value: threads },
        executionEnvironments: { value: executionEnvironments },
        workspaceMutationLock: { value: new WorkspaceMutationLock() },
        memoryManager: {
          value: { searchHybrid: async () => [] },
        },
        dirty: { value: false, writable: true },
      });
      (AgentRuntime.prototype as unknown as {
        run: typeof AgentRuntime.prototype.run;
      }).run = async (state) => ({
        text: "verified child completion",
        reason: "success",
        steps: 1,
        threadId: state.threadId,
        turnId: "turn_finalize_pause_child",
        subagentTaskReport: {
          taskId,
          outcome: "completed",
          summary: "The child completed before finalization began.",
          completionEvidence: [{
            check: "The verified result is complete",
            evidence: "The child Runtime returned its structured completion.",
          }],
        },
      });
      const controller = new AbortController();
      let pauseRequested = false;
      const request = {
        record: {
          id: agentId,
          childThreadId,
          environmentId,
          parentThreadId: parent.threadId,
          createdByTurnId: "turn_finalize_pause_parent",
          assignmentKind: "standalone",
          taskId,
          taskTitle: "Finalize one verified result",
          mode: "code",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          thinkingEffort: "high",
          requestedIsolation: "worktree",
          status: "running",
          revision: 1,
          instructions: "Complete the exact bound task.",
          followUpCount: 0,
          createdAt,
          startedAt: createdAt,
          updatedAt: createdAt,
        },
        task: {
          id: taskId,
          title: "Finalize one verified result",
          description: "Return one verified terminal result.",
          dependencies: [],
          inputs: [],
          expectedArtifacts: ["A verified result"],
          completionChecks: ["The verified result is complete"],
          failureHandling: "Retain the result if finalization fails.",
          owner: "subagent",
          assignedAgentId: agentId,
          status: "in_progress",
          startedAt: createdAt,
        },
        signal: controller.signal,
        drainFollowUps: () => [],
        reportEnvironment: () => undefined,
        isPauseRequested: () => pauseRequested,
      } as SubagentExecutionRequest;

      const outcomePromise = (
        app as unknown as {
          runSubagent(input: SubagentExecutionRequest): Promise<SubagentExecutionOutcome>;
        }
      ).runSubagent(request);
      await finalizeEntered;
      pauseRequested = true;
      controller.abort();
      releaseFinalize();
      const outcome = await outcomePromise;

      assert.equal(outcome.reason, "completed");
      assert.equal(outcome.resultArtifact?.status, "ready");
      assert.equal(
        threads.latestSubagentResult(parent.threadId, agentId, taskId)?.reason,
        "completed",
      );
    } finally {
      (AgentRuntime.prototype as unknown as {
        run: typeof AgentRuntime.prototype.run;
      }).run = originalRun;
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("ignores a durable DAG assignment when scanning for standalone recovery", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-dag-binding-scan-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_dag_binding_scan",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "high",
      });
      const createOperation = {
        action: "create" as const,
        goal: "Keep DAG children out of standalone recovery",
        tasks: [{
          id: "inspect_dag",
          title: "Inspect the DAG",
          description: "Inspect only the Runtime-bound DAG task.",
          dependencies: [],
          inputs: [],
          expectedArtifacts: ["A concise inspection result"],
          completionChecks: ["The DAG inspection is verified"],
          failureHandling: "Release the DAG task for reassignment.",
        }],
      };
      const graph = applyTaskGraphOperation(undefined, createOperation, {
        turnId: "turn_create_dag_binding_scan",
        graphId: () => "task_graph_00000000-0000-4000-8000-000000000202",
      });
      threads.appendEvent(state.threadId, {
        type: "tool.result",
        turnId: "turn_create_dag_binding_scan",
        phase: "completed",
        payload: {
          callId: "call_create_dag_binding_scan",
          tool: "manage_tasks",
          message: {
            role: "tool",
            tool_call_id: "call_create_dag_binding_scan",
            name: "manage_tasks",
            content: '{"ok":true}',
          },
          taskGraph: graph,
          taskGraphOperation: createOperation,
        },
      });

      const agentId = "subagent_00000000-0000-4000-8000-000000000202";
      const claim = {
        action: "claim" as const,
        taskId: "inspect_dag",
        agentId,
      };
      const claimed = applySubagentTaskOperation(graph, claim, {
        turnId: "turn_claim_dag_binding_scan",
      });
      const dagAssignment: Extract<
        SubagentAssignmentSnapshot,
        { kind: "dag" }
      > = {
        kind: "dag",
        agentId,
        taskId: "inspect_dag",
        taskTitle: "Inspect the DAG",
        taskDescription: "Inspect only the Runtime-bound DAG task.",
        completionChecks: ["The DAG inspection is verified"],
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "high",
        createdAt: claimed.updatedAt,
        taskGraphId: graph.id,
      };
      threads.appendEvent(state.threadId, {
        type: "tool.result",
        turnId: "turn_claim_dag_binding_scan",
        phase: "completed",
        payload: {
          callId: "call_claim_dag_binding_scan",
          tool: "manage_subagents",
          message: {
            role: "tool",
            tool_call_id: "call_claim_dag_binding_scan",
            name: "manage_subagents",
            content: '{"ok":true}',
          },
          taskGraph: claimed,
          subagentTaskOperation: claim,
          subagentAssignment: dagAssignment,
          subagentLifecycle: { action: "activate", agentId },
        },
      });

      assert.deepEqual(threads.unobservedStandaloneAssignments(state.threadId), []);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("finds an unobserved standalone assignment until its durable observation", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-standalone-binding-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_standalone_binding_recovery",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "medium",
      });
      const assignment = standaloneAssignment();
      appendStandaloneLifecycle(
        threads,
        state.threadId,
        "turn_spawn_standalone",
        assignment,
        "activate",
      );

      const pending = threads.unobservedStandaloneAssignments(state.threadId);
      assert.equal(pending.length, 1);
      assert.deepEqual(pending[0], {
        assignment,
        createdByTurnId: "turn_spawn_standalone",
        observed: false,
      });

      appendStandaloneLifecycle(
        threads,
        state.threadId,
        "turn_observe_standalone",
        assignment,
        "observe",
      );
      assert.deepEqual(threads.unobservedStandaloneAssignments(state.threadId), []);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("restores a durable standalone result for one wait and observation without rerunning it", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-standalone-result-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_standalone_result_recovery",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "medium",
      });
      const assignment = standaloneAssignment();
      appendStandaloneLifecycle(
        threads,
        state.threadId,
        "turn_spawn_standalone_result",
        assignment,
        "activate",
      );
      threads.recordSubagentArtifacts(
        state.threadId,
        "turn_spawn_standalone_result",
        {
          agentId: assignment.agentId,
          taskId: assignment.taskId,
          changes: [{
            path: "src/standalone-result.ts",
            operation: "create",
            afterHash: "standalone-result-hash",
            source: "file_tool",
            status: "applied",
            timestamp: "2026-08-27T13:01:00.000Z",
          }],
          commands: [{
            id: "command_standalone_recovery",
            program: "npm",
            args: ["test"],
            cwd: state.workspaceRoot,
            status: "exited",
            exitCode: 0,
            durationMs: 20,
            timestamp: "2026-08-27T13:01:01.000Z",
            summary: "Standalone verification passed",
            sourceAgentRole: "subagent",
            sourceAgentId: assignment.agentId,
            sourceTaskId: assignment.taskId,
          }],
        },
      );
      threads.recordSubagentResult(
        state.threadId,
        "turn_spawn_standalone_result",
        {
          agentId: assignment.agentId,
          taskId: assignment.taskId,
          reason: "completed",
          report: {
            taskId: assignment.taskId,
            outcome: "completed",
            summary: "Recovered standalone work completed.",
            completionEvidence: [{
              check: "Recovery behavior is verified",
              evidence: "The focused standalone check passed.",
            }],
          },
        },
      );

      const recoveredState = threads.recover(state.threadId);
      assert.equal(
        recoveredState.changes.filter(
          (change) => change.path === "src/standalone-result.ts",
        ).length,
        1,
      );
      assert.equal(
        recoveredState.commands.filter(
          (command) => command.id === "command_standalone_recovery",
        ).length,
        1,
      );
      const pending = threads.unobservedStandaloneAssignments(state.threadId);
      const durable = threads.latestSubagentResult(
        state.threadId,
        assignment.agentId,
        assignment.taskId,
      );
      assert.equal(pending.length, 1);
      assert.equal(durable?.reason, "completed");

      let childRuns = 0;
      const coordinator = new SubagentCoordinator({
        run: async () => {
          childRuns += 1;
          return {
            reason: "failed",
            error: "A recovered process must never be restarted.",
            changes: [],
            commands: [],
            presentations: [],
          };
        },
      });
      coordinator.restoreStandalone({
        parentThreadId: state.threadId,
        createdByTurnId: pending[0]?.createdByTurnId ?? "",
        assignment,
        reason: "completed",
        report: durable?.report,
        finishedAt: durable?.timestamp ?? assignment.createdAt,
      });

      const waited = await coordinator.wait({
        action: "wait",
        agentIds: [assignment.agentId],
        timeoutMs: 0,
      }, standaloneContext(recoveredState, "turn_collect_standalone_result"));
      assert.equal(waited.ok, true);
      assert.equal(
        (waited.data as { timedOut?: boolean }).timedOut,
        false,
      );
      assert.equal(waited.subagentLifecycle?.action, "observe");
      assert.deepEqual(waited.subagentAssignment, {
        ...assignment,
        childThreadId: `thread_${assignment.agentId}`,
        environmentId: `environment_${assignment.agentId}`,
        requestedIsolation: "shared",
      });
      assert.equal(waited.taskGraphUpdate, undefined);
      assert.equal(waited.subagentTaskOperation, undefined);

      appendStandaloneLifecycle(
        threads,
        state.threadId,
        "turn_collect_standalone_result",
        assignment,
        "observe",
      );
      assert.equal(
        coordinator.commitLifecycle(waited.subagentLifecycle!),
        undefined,
      );
      assert.equal(childRuns, 0);
      assert.equal(coordinator.hasOutstanding(state.threadId), false);
      assert.deepEqual(threads.unobservedStandaloneAssignments(state.threadId), []);

      const observedAgain = await coordinator.wait({
        action: "wait",
        agentIds: [assignment.agentId],
        timeoutMs: 0,
      }, standaloneContext(recoveredState, "turn_collect_standalone_again"));
      assert.equal((observedAgain.data as { timedOut?: boolean }).timedOut, true);
      assert.equal(observedAgain.subagentLifecycle, undefined);
      assert.equal(threads.recover(state.threadId).changes.filter(
        (change) => change.path === "src/standalone-result.ts",
      ).length, 1);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("turns a standalone assignment without a durable result into one interrupted result", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-standalone-interrupted-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_standalone_interrupted_recovery",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "low",
      });
      const assignment = standaloneAssignment({ thinkingEffort: "low" });
      appendStandaloneLifecycle(
        threads,
        state.threadId,
        "turn_spawn_interrupted_standalone",
        assignment,
        "activate",
      );
      assert.equal(
        threads.latestSubagentResult(
          state.threadId,
          assignment.agentId,
          assignment.taskId,
        ),
        undefined,
      );

      let childRuns = 0;
      const coordinator = new SubagentCoordinator({
        run: async () => {
          childRuns += 1;
          return {
            reason: "completed",
            changes: [],
            commands: [],
            presentations: [],
          };
        },
      });
      assert.equal(restoreStandaloneViaApp(threads, state, coordinator), 1);
      const interrupted = threads.latestSubagentResult(
        state.threadId,
        assignment.agentId,
        assignment.taskId,
      );
      assert.equal(interrupted?.reason, "interrupted");
      assert.match(interrupted?.error ?? "", /exited before.*durable result/u);
      assert.equal(coordinator.snapshot(state.threadId)[0]?.status, "interrupted");
      assert.equal(childRuns, 0);
      assert.equal(
        threads.journal(state.threadId).read().filter(
          (event) => event.type === "subagent.result",
        ).length,
        1,
      );

      // A later process receives a fresh coordinator. It restores the same
      // durable interrupted result instead of appending another result or
      // starting the old child execution again.
      const secondCoordinator = new SubagentCoordinator({
        run: async () => {
          childRuns += 1;
          return {
            reason: "completed",
            changes: [],
            commands: [],
            presentations: [],
          };
        },
      });
      assert.equal(restoreStandaloneViaApp(threads, state, secondCoordinator), 1);
      assert.equal(childRuns, 0);
      assert.equal(
        threads.journal(state.threadId).read().filter(
          (event) => event.type === "subagent.result",
        ).length,
        1,
      );
      assert.equal(secondCoordinator.snapshot(state.threadId)[0]?.status, "interrupted");
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("replays child claims and durably releases orphaned work without adding chat messages", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-subagent-recovery-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_subagent_recovery",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "high",
      });
      const createOperation = {
        action: "create" as const,
        goal: "Recover isolated child work",
        tasks: [{
          id: "implementation",
          title: "Implement the feature",
          description: "Make the scoped implementation change",
          dependencies: [],
          inputs: [],
          expectedArtifacts: ["src/feature.ts"],
          completionChecks: ["Focused test passes"],
          failureHandling: "Return the task to the main agent",
        }, {
          id: "verification",
          title: "Verify the feature",
          description: "Run the isolated verification",
          dependencies: [],
          inputs: [],
          expectedArtifacts: ["verification log"],
          completionChecks: ["Verification command passes"],
          failureHandling: "Return verification to the main agent",
        }],
      };
      const graph = applyTaskGraphOperation(undefined, createOperation, {
        turnId: "turn_create_recovery",
        graphId: () => "task_graph_00000000-0000-4000-8000-000000000099",
      });
      threads.appendEvent(state.threadId, {
        type: "tool.result",
        turnId: "turn_create_recovery",
        phase: "completed",
        payload: {
          callId: "call_create_recovery",
          tool: "manage_tasks",
          message: {
            role: "tool",
            tool_call_id: "call_create_recovery",
            name: "manage_tasks",
            content: '{"ok":true}',
          },
          taskGraph: graph,
          taskGraphOperation: createOperation,
        },
      });

      const claimOperation = {
        action: "claim" as const,
        taskId: "implementation",
        agentId: "subagent_00000000-0000-4000-8000-000000000099",
      };
      const claimed = applySubagentTaskOperation(graph, claimOperation, {
        turnId: "turn_claim_recovery",
      });
      threads.appendEvent(state.threadId, {
        type: "tool.result",
        turnId: "turn_claim_recovery",
        phase: "completed",
        payload: {
          callId: "call_claim_recovery",
          tool: "manage_subagents",
          message: {
            role: "tool",
            tool_call_id: "call_claim_recovery",
            name: "manage_subagents",
            content: '{"ok":true}',
          },
          taskGraph: claimed,
          subagentTaskOperation: claimOperation,
        },
      });

      const verificationAgentId =
        "subagent_00000000-0000-4000-8000-000000000100";
      const verificationClaim = {
        action: "claim" as const,
        taskId: "verification",
        agentId: verificationAgentId,
      };
      const bothClaimed = applySubagentTaskOperation(claimed, verificationClaim, {
        turnId: "turn_claim_verification",
      });
      threads.appendEvent(state.threadId, {
        type: "tool.result",
        turnId: "turn_claim_verification",
        phase: "completed",
        payload: {
          callId: "call_claim_verification",
          tool: "manage_subagents",
          message: {
            role: "tool",
            tool_call_id: "call_claim_verification",
            name: "manage_subagents",
            content: '{"ok":true}',
          },
          taskGraph: bothClaimed,
          subagentTaskOperation: verificationClaim,
        },
      });

      const staleCheckpoint = threads.recover(state.threadId);
      threads.recordSubagentArtifacts(
        state.threadId,
        "turn_claim_verification",
        {
          agentId: verificationAgentId,
          taskId: "verification",
          changes: [{
            path: "src/verified.ts",
            operation: "create",
            afterHash: "abc123",
            source: "file_tool",
            status: "applied",
            timestamp: "2026-08-27T12:00:00.000Z",
          }],
          commands: [{
            id: "command_subagent_recovery",
            program: "npm",
            args: ["test"],
            cwd: staleCheckpoint.workspaceRoot,
            status: "exited",
            exitCode: 0,
            durationMs: 25,
            timestamp: "2026-08-27T12:00:01.000Z",
            summary: "Verification passed",
            sourceAgentRole: "subagent",
            sourceAgentId: verificationAgentId,
            sourceTaskId: "verification",
          }],
        },
      );
      // Simulate a parent checkpoint that was captured before the background
      // artifact event but appended after it.
      threads.save(staleCheckpoint);
      threads.recordSubagentResult(
        state.threadId,
        "turn_claim_verification",
        {
          agentId: verificationAgentId,
          taskId: "verification",
          reason: "completed",
          report: {
            taskId: "verification",
            outcome: "completed",
            summary: "Verification completed.",
            completionEvidence: [{
              check: "Verification command passes",
              evidence: "npm test exited with code 0",
            }],
          },
        },
      );

      const recovered = threads.recover(state.threadId);
      assert.equal(recovered.taskGraph?.tasks[0]?.owner, "subagent");
      assert.equal(recovered.taskGraph?.tasks[0]?.status, "in_progress");
      assert.equal(recovered.taskGraph?.tasks[1]?.owner, "subagent");
      assert.equal(recovered.changes.some((change) => change.path === "src/verified.ts"), true);
      assert.equal(recovered.commands[0]?.sourceAgentId, verificationAgentId);
      const messageCount = recovered.messages.length;
      assert.equal(releaseOrphanedSubagentTasks(threads, recovered), 2);
      assert.equal(recovered.taskGraph?.tasks[0]?.owner, "main_agent");
      assert.equal(recovered.taskGraph?.tasks[0]?.status, "pending");
      assert.equal(recovered.taskGraph?.tasks[1]?.owner, "subagent");
      assert.equal(recovered.taskGraph?.tasks[1]?.status, "completed");
      assert.equal(
        recovered.taskGraph?.tasks[1]?.completionEvidence?.[0]?.evidence,
        "npm test exited with code 0",
      );

      const replayed = threads.recover(state.threadId);
      assert.equal(replayed.taskGraph?.tasks[0]?.owner, "main_agent");
      assert.equal(replayed.taskGraph?.tasks[0]?.assignedAgentId, undefined);
      assert.equal(replayed.taskGraph?.tasks[1]?.status, "completed");
      assert.equal(replayed.changes.some((change) => change.path === "src/verified.ts"), true);
      assert.equal(replayed.commands[0]?.sourceTaskId, "verification");
      assert.equal(replayed.messages.length, messageCount);
      assert.equal(releaseOrphanedSubagentTasks(threads, replayed), 0);
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("gives a committed stop priority over a durable completion result", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "easy-code-subagent-stop-recovery-"));
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({
        threadId: "thread_subagent_stop_recovery",
        workspaceRoot: path.join(dataDir, "workspace"),
        mode: "code",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingEffort: "high",
      });
      const createOperation = {
        action: "create" as const,
        goal: "Recover a durable cancellation race",
        tasks: [{
          id: "cancel_race",
          title: "Exercise cancellation recovery",
          description: "Do not complete after a committed stop",
          dependencies: [],
          inputs: [],
          expectedArtifacts: ["result"],
          completionChecks: ["Focused check passes"],
          failureHandling: "Release the task",
        }],
      };
      const graph = applyTaskGraphOperation(undefined, createOperation, {
        turnId: "turn_create_stop_race",
        graphId: () => "task_graph_00000000-0000-4000-8000-000000000101",
      });
      threads.appendEvent(state.threadId, {
        type: "tool.result",
        turnId: "turn_create_stop_race",
        phase: "completed",
        payload: {
          callId: "call_create_stop_race",
          tool: "manage_tasks",
          message: {
            role: "tool",
            tool_call_id: "call_create_stop_race",
            name: "manage_tasks",
            content: '{"ok":true}',
          },
          taskGraph: graph,
          taskGraphOperation: createOperation,
        },
      });
      const agentId = "subagent_00000000-0000-4000-8000-000000000101";
      const claim = {
        action: "claim" as const,
        taskId: "cancel_race",
        agentId,
      };
      const claimed = applySubagentTaskOperation(graph, claim, {
        turnId: "turn_claim_stop_race",
      });
      threads.appendEvent(state.threadId, {
        type: "tool.result",
        turnId: "turn_claim_stop_race",
        phase: "completed",
        payload: {
          callId: "call_claim_stop_race",
          tool: "manage_subagents",
          message: {
            role: "tool",
            tool_call_id: "call_claim_stop_race",
            name: "manage_subagents",
            content: '{"ok":true}',
          },
          taskGraph: claimed,
          subagentTaskOperation: claim,
          subagentLifecycle: { action: "activate", agentId },
        },
      });
      threads.appendEvent(state.threadId, {
        type: "tool.result",
        turnId: "turn_stop_race",
        phase: "completed",
        payload: {
          callId: "call_stop_race",
          tool: "manage_subagents",
          message: {
            role: "tool",
            tool_call_id: "call_stop_race",
            name: "manage_subagents",
            content: '{"ok":true}',
          },
          subagentLifecycle: {
            action: "request_stop",
            agentId,
            reason: "Cancel the child.",
          },
        },
      });
      // The child result lands after the stop intent was already durable but
      // before the old process managed to apply its local abort.
      threads.recordSubagentResult(
        state.threadId,
        "turn_claim_stop_race",
        {
          agentId,
          taskId: "cancel_race",
          reason: "completed",
          report: {
            taskId: "cancel_race",
            outcome: "completed",
            summary: "The child finished during the stop race.",
            completionEvidence: [{
              check: "Focused check passes",
              evidence: "The focused check passed",
            }],
          },
        },
      );

      const recovered = threads.recover(state.threadId);
      assert.equal(threads.hasCommittedSubagentStop(state.threadId, agentId), true);
      assert.equal(releaseOrphanedSubagentTasks(threads, recovered), 1);
      assert.equal(recovered.taskGraph?.tasks[0]?.status, "pending");
      assert.equal(recovered.taskGraph?.tasks[0]?.owner, "main_agent");
    } finally {
      storage.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
