import type {
  CommandAuditEntry,
  FileChangeRecord,
  ExecutionEnvironmentSnapshot,
  ResultArtifact,
  ResultArtifactRef,
  SubagentIsolationMode,
  SubagentLifecycleUpdate,
  SubagentAssignmentSnapshot,
  SubagentTaskReport,
  TaskGraph,
  TaskNode,
  ToolContext,
  ToolExecutionResult,
  ToolPresentation,
  ThinkingEffort,
} from "../core/types.js";
import {
  applySubagentTaskOperation,
  cloneTaskGraph,
  type SubagentTaskTransitionOperation,
} from "../tasks/task-graph.js";
import { createId } from "../utils/ids.js";
import { sanitizeSubagentText } from "./types.js";
import type {
  FollowUpSubagentRequest,
  HandoffSubagentRequest,
  SpawnSubagentRequest,
  StandaloneSubagentTask,
  StopSubagentRequest,
  SubagentControl,
  SubagentRecord,
  SubagentStatus,
  SubagentStatusRequest,
  SubagentView,
  WaitForSubagentsRequest,
} from "./types.js";

export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 2;
const MAX_FOLLOW_UPS_PER_SUBAGENT = 32;

/** Scale child concurrency from the user's selected parent thinking effort. */
export function maxConcurrentSubagents(thinkingEffort: ThinkingEffort): number {
  if (thinkingEffort === "high") return DEFAULT_MAX_CONCURRENT_SUBAGENTS * 4;
  if (thinkingEffort === "medium") return DEFAULT_MAX_CONCURRENT_SUBAGENTS * 2;
  return DEFAULT_MAX_CONCURRENT_SUBAGENTS;
}

export interface SubagentExecutionRequest {
  readonly record: Readonly<SubagentRecord>;
  readonly task: Readonly<TaskNode>;
  readonly signal: AbortSignal;
  /** Follow-ups are delivered once, in FIFO order, at a model-request boundary. */
  readonly drainFollowUps: () => string[];
  /** Runtime reports the physical checkout as soon as provisioning succeeds. */
  readonly reportEnvironment: (environment: ExecutionEnvironmentSnapshot) => void;
  /** True only when the parent is preserving this child for a later resume. */
  readonly isPauseRequested: () => boolean;
}

export interface SubagentExecutionOutcome {
  readonly report?: SubagentTaskReport;
  readonly reason: "completed" | "blocked" | "failed" | "stopped" | "interrupted";
  readonly error?: string;
  readonly changes: readonly FileChangeRecord[];
  readonly commands: readonly CommandAuditEntry[];
  readonly presentations: readonly ToolPresentation[];
  readonly environment?: ExecutionEnvironmentSnapshot;
  readonly resultArtifact?: ResultArtifact;
}

export interface ObservedSubagentArtifacts {
  readonly agentId: string;
  readonly taskId: string;
  readonly changes: readonly FileChangeRecord[];
  readonly commands: readonly CommandAuditEntry[];
  readonly presentations: readonly ToolPresentation[];
  readonly environment?: ExecutionEnvironmentSnapshot;
  readonly resultArtifact?: ResultArtifact;
}

export interface RecoveredStandaloneSubagent {
  readonly parentThreadId: string;
  readonly createdByTurnId: string;
  readonly assignment: Extract<SubagentAssignmentSnapshot, { kind: "standalone" }>;
  readonly reason: SubagentExecutionOutcome["reason"];
  readonly report?: SubagentTaskReport;
  readonly error?: string;
  readonly environment?: ExecutionEnvironmentSnapshot;
  readonly resultArtifact?: ResultArtifact;
  readonly finishedAt: string;
  readonly observed?: boolean;
}

/** Durable parent/child binding restored after a process boundary. */
export interface RecoveredSubagent {
  readonly parentThreadId: string;
  readonly createdByTurnId: string;
  readonly assignment: SubagentAssignmentSnapshot;
  /** Required for DAG assignments; standalone tasks can be rebuilt from the binding. */
  readonly task?: TaskNode;
  /** Omit to resume the bound child session; provide to expose a terminal result. */
  readonly reason?: SubagentExecutionOutcome["reason"];
  readonly report?: SubagentTaskReport;
  readonly error?: string;
  readonly environment?: ExecutionEnvironmentSnapshot;
  readonly resultArtifact?: ResultArtifact;
  readonly finishedAt?: string;
  readonly observed?: boolean;
}

export interface SubagentCoordinatorOptions {
  readonly run: (request: SubagentExecutionRequest) => Promise<SubagentExecutionOutcome>;
  readonly maxConcurrent?: number;
  readonly now?: () => Date;
  readonly createAgentId?: () => string;
  readonly defaultIsolation?: SubagentIsolationMode;
  readonly onWaitStart?: (text: string) => unknown;
  readonly onWaitEnd?: (activityToken: unknown) => void;
  readonly handoff?: (
    artifact: Readonly<ResultArtifact>,
    destination: { type: "local" } | { type: "branch"; branchName?: string },
  ) => Promise<ResultArtifact>;
}

interface SubagentJob {
  readonly record: SubagentRecord;
  readonly task: TaskNode;
  readonly controller: AbortController;
  readonly followUps: string[];
  readonly settled: Promise<void>;
  resolveSettled: () => void;
  activated: boolean;
  graphObserved: boolean;
  artifactsMerged: boolean;
  stopReason?: string;
  pauseRequested?: boolean;
  preparedRestore?: boolean;
  outcome?: SubagentExecutionOutcome;
}

export interface RestoreSubagentOptions {
  /** Register and validate the durable binding without starting child work yet. */
  readonly deferActivation?: boolean;
}

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set([
  "completed",
  "blocked",
  "failed",
  "stopped",
  "interrupted",
]);

/** In-process control plane. Every child has private messages and one bound assignment. */
export class SubagentCoordinator implements SubagentControl {
  private readonly jobs = new Map<string, SubagentJob>();
  private readonly runChild: SubagentCoordinatorOptions["run"];
  private readonly maxConcurrentOverride: number | undefined;
  private readonly now: () => Date;
  private readonly createAgentId: () => string;
  private readonly defaultIsolation: SubagentIsolationMode;
  private readonly onWaitStart: ((text: string) => unknown) | undefined;
  private readonly onWaitEnd: ((activityToken: unknown) => void) | undefined;
  private readonly handoffResult: SubagentCoordinatorOptions["handoff"];

  constructor(options: SubagentCoordinatorOptions) {
    this.runChild = options.run;
    this.maxConcurrentOverride = options.maxConcurrent;
    if (
      this.maxConcurrentOverride !== undefined &&
      (!Number.isInteger(this.maxConcurrentOverride) ||
        this.maxConcurrentOverride < 1 ||
        this.maxConcurrentOverride > 16)
    ) {
      throw new Error("Subagent concurrency must be an integer from 1 through 16");
    }
    this.now = options.now ?? (() => new Date());
    this.createAgentId = options.createAgentId ?? (() => createId("subagent"));
    this.defaultIsolation = options.defaultIsolation ?? "auto";
    this.onWaitStart = options.onWaitStart;
    this.onWaitEnd = options.onWaitEnd;
    this.handoffResult = options.handoff;
  }

  assertAuthorized(context: ToolContext): void {
    if (context.agentRole !== "main_agent") {
      throw new Error("Only the main agent may manage child agents");
    }
    if (context.mode !== "code") {
      throw new Error("Subagents may be managed only in effective Code mode");
    }
    if (!context.provider || !context.model || !context.thinkingEffort) {
      throw new Error("The parent provider, model, or thinking-effort identity is unavailable");
    }
  }

  async spawn(
    request: SpawnSubagentRequest,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const active = this.recordsForThread(context.threadId).filter(
      (record) => !TERMINAL_STATUSES.has(record.status),
    ).length;
    const concurrencyLimit = this.concurrencyLimit(context);
    if (active >= concurrencyLimit) {
      throw new Error(
        `The parent already has ${active} active subagent(s); the concurrency limit is ${concurrencyLimit}`,
      );
    }
    const agentId = this.createAgentId();
    const childThreadId = createId("thread");
    const environmentId = createId("environment");
    if (this.jobs.has(agentId)) throw new Error(`Duplicate subagent ID: ${agentId}`);
    let task: TaskNode;
    let nextGraph: TaskGraph | undefined;
    let operation: SubagentTaskTransitionOperation | undefined;
    let assignmentKind: SubagentRecord["assignmentKind"];
    let taskGraphId: string | undefined;
    let timestamp: string;

    if ("taskId" in request && request.taskId) {
      const graph = this.requireActiveGraph(context);
      operation = {
        action: "claim",
        taskId: request.taskId,
        agentId,
      };
      nextGraph = applySubagentTaskOperation(graph, operation, {
        turnId: context.turnId,
        now: this.now,
      });
      const assigned = nextGraph.tasks.find((candidate) => candidate.id === request.taskId);
      if (!assigned) throw new Error(`Task not found after assignment: ${request.taskId}`);
      task = assigned;
      assignmentKind = "dag";
      taskGraphId = nextGraph.id;
      timestamp = nextGraph.updatedAt;
    } else {
      if (!request.task) {
        throw new Error("A standalone child assignment requires a task definition");
      }
      if (
        context.taskGraph &&
        (context.taskGraph.status !== "completed" ||
          context.taskGraph.updatedByTurnId === context.turnId)
      ) {
        throw new Error(
          "Standalone child assignments are unavailable while a task DAG is unfinished or was completed in this turn; assign a DAG taskId instead.",
        );
      }
      timestamp = this.now().toISOString();
      task = standaloneTask(request.task, agentId, timestamp);
      assignmentKind = "standalone";
    }
    const record: SubagentRecord = {
      id: agentId,
      childThreadId,
      environmentId,
      parentThreadId: context.threadId,
      createdByTurnId: context.turnId,
      assignmentKind,
      ...(taskGraphId ? { taskGraphId } : {}),
      taskId: task.id,
      taskTitle: task.title,
      mode: "code",
      provider: context.provider as NonNullable<ToolContext["provider"]>,
      model: context.model as string,
      thinkingEffort: context.thinkingEffort as ThinkingEffort,
      requestedIsolation: request.isolation ?? this.defaultIsolation,
      status: "running",
      revision: 1,
      instructions: sanitizeSubagentText(request.instructions),
      followUpCount: 0,
      createdAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    this.jobs.set(agentId, {
      record,
      task: cloneTask(task),
      controller: new AbortController(),
      followUps: [],
      settled,
      resolveSettled,
      activated: false,
      graphObserved: false,
      artifactsMerged: false,
    });
    return {
      ok: true,
      summary: assignmentKind === "dag"
        ? `Assigned DAG task ${task.id} to child ${agentId}.`
        : `Created standalone task ${task.id} for child ${agentId}.`,
      data: {
        agent: publicRecord(record),
        concurrency: { active: active + 1, limit: concurrencyLimit },
      },
      ...(nextGraph ? { taskGraphUpdate: nextGraph } : {}),
      ...(operation ? { subagentTaskOperation: operation } : {}),
      subagentAssignment: assignmentSnapshot(record, task),
      subagentLifecycle: { action: "activate", agentId },
    };
  }

  async status(
    request: SubagentStatusRequest,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const records = this.selectRecords(request.agentIds, context.threadId);
    const active = this.recordsForThread(context.threadId).filter(
      (record) => !TERMINAL_STATUSES.has(record.status),
    ).length;
    return {
      ok: true,
      summary: records.length
        ? `Reported ${records.length} subagent status record(s).`
        : "This parent has no subagents.",
      data: {
        agents: records.map(publicRecord),
        concurrency: { active, limit: this.concurrencyLimit(context) },
      },
    };
  }

  async wait(
    request: WaitForSubagentsRequest,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const jobs = this.selectJobs(request.agentIds, context.threadId);
    let mergeable = jobs.find((job) => isTerminal(job.record.status) && !job.graphObserved);
    if (!mergeable && request.timeoutMs > 0) {
      const unsettled = jobs.filter((job) => !isTerminal(job.record.status));
      if (unsettled.length) {
        let activityToken: unknown;
        let activityStarted = false;
        try {
          try {
            if (this.onWaitStart) {
              activityToken = this.onWaitStart(
                `Waiting for ${unsettled.length} subagent result${unsettled.length === 1 ? "" : "s"}`,
              );
              activityStarted = true;
            }
          } catch {
            // Presentation is advisory and cannot change child lifecycle state.
          }
          await waitForFirstSettlement(unsettled, request.timeoutMs, context.signal);
        } finally {
          try {
            if (activityStarted) this.onWaitEnd?.(activityToken);
          } catch {
            // Presentation is advisory and cannot replace a wait result.
          }
        }
      }
      mergeable = jobs.find((job) => isTerminal(job.record.status) && !job.graphObserved);
    }
    const records = jobs.map((job) => publicRecord(job.record));
    const concurrency = {
      active: this.recordsForThread(context.threadId).filter(
        (record) => !TERMINAL_STATUSES.has(record.status),
      ).length,
      limit: this.concurrencyLimit(context),
    };
    if (!mergeable) {
      return {
        ok: true,
        summary: `No unobserved subagent result became available within ${request.timeoutMs} ms.`,
        data: { timedOut: true, agents: records, concurrency },
      };
    }

    const binding = assignmentSnapshot(mergeable.record, mergeable.task);
    if (mergeable.record.assignmentKind === "standalone") {
      return {
        ok: true,
        summary:
          `Collected ${mergeable.record.id}'s standalone result for ${mergeable.record.taskId}.`,
        data: {
          timedOut: false,
          observedAgentId: mergeable.record.id,
          result: mergeable.record.result,
          ...(mergeable.record.error ? { error: mergeable.record.error } : {}),
          agents: records,
          concurrency,
        },
        subagentAssignment: binding,
        subagentLifecycle: { action: "observe", agentId: mergeable.record.id },
      };
    }

    const graph = this.requireGraph(context);
    const operation = operationForObservedJob(mergeable);
    const nextGraph = applySubagentTaskOperation(graph, operation, {
      turnId: context.turnId,
      now: this.now,
    });
    return {
      ok: true,
      summary: operation.action === "complete"
        ? `Merged ${mergeable.record.id}'s verified result and completed task ${mergeable.record.taskId}.`
        : `Received ${mergeable.record.id}'s terminal result and released task ${mergeable.record.taskId} for reassignment.`,
      data: {
        timedOut: false,
        observedAgentId: mergeable.record.id,
        result: mergeable.record.result,
        ...(mergeable.record.error ? { error: mergeable.record.error } : {}),
        agents: records,
        concurrency,
      },
      taskGraphUpdate: nextGraph,
      subagentTaskOperation: operation,
      subagentAssignment: binding,
      subagentLifecycle: { action: "observe", agentId: mergeable.record.id },
    };
  }

  async followUp(
    request: FollowUpSubagentRequest,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const job = this.requireOwnedJob(request.agentId, context.threadId);
    if (isTerminal(job.record.status) || job.record.status === "stopping") {
      throw new Error(`Subagent ${request.agentId} is no longer accepting follow-up guidance`);
    }
    if (job.record.followUpCount >= MAX_FOLLOW_UPS_PER_SUBAGENT) {
      throw new Error(`Subagent ${request.agentId} reached its follow-up limit`);
    }
    const message = sanitizeSubagentText(request.message);
    return {
      ok: true,
      summary: `Queued follow-up guidance for ${request.agentId}.`,
      data: {
        agentId: request.agentId,
        followUpCount: job.record.followUpCount + 1,
        delivery: "next_model_request_boundary",
      },
      subagentLifecycle: {
        action: "deliver_follow_up",
        agentId: request.agentId,
        message,
      },
    };
  }

  async stop(
    request: StopSubagentRequest,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const job = this.requireOwnedJob(request.agentId, context.threadId);
    if (isTerminal(job.record.status)) {
      return {
        ok: true,
        summary: `Subagent ${request.agentId} is already terminal.`,
        data: { agent: publicRecord(job.record) },
      };
    }
    const reason = sanitizeSubagentText(request.reason);
    return {
      ok: true,
      summary: `Cancellation was requested for ${request.agentId}; wait for and collect its terminal result before continuing.`,
      data: { agent: publicRecord({ ...job.record, status: "stopping" }) },
      subagentLifecycle: {
        action: "request_stop",
        agentId: request.agentId,
        reason,
      },
    };
  }

  async handoff(
    request: HandoffSubagentRequest,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const job = this.requireOwnedJob(request.agentId, context.threadId);
    if (job.record.status !== "completed" || !job.record.resultArtifact) {
      throw new Error(`Subagent ${request.agentId} has no completed result artifact to hand off`);
    }
    if (job.record.assignmentKind === "dag") {
      const graph = this.requireGraph(context);
      if (graph.id !== job.record.taskGraphId) {
        throw new Error(`Subagent ${request.agentId} belongs to a different task DAG`);
      }
      if (graph.status !== "completed") {
        throw new Error("A DAG result can be handed off only after the complete task graph finishes");
      }
      const dependencyIds = new Set(
        graph.tasks.flatMap((task) => task.dependencies),
      );
      const terminalLeaves = graph.tasks.filter(
        (task) => task.status === "completed" && !dependencyIds.has(task.id),
      );
      if (terminalLeaves.length !== 1) {
        throw new Error(
          "A DAG result can be handed off only when the graph has exactly one terminal leaf task",
        );
      }
      if (terminalLeaves[0]?.id !== job.record.taskId) {
        throw new Error(
          `Subagent ${request.agentId} does not own the DAG's terminal result task`,
        );
      }
    }
    if (!this.handoffResult) throw new Error("Result handoff is unavailable in this runtime");
    const artifact = await this.handoffResult(
      job.record.resultArtifact,
      request.destination === "local"
        ? { type: "local" }
        : { type: "branch", ...(request.branchName ? { branchName: request.branchName } : {}) },
    );
    job.record.resultArtifact = cloneArtifact(artifact);
    if (job.record.environment) {
      job.record.environment = {
        ...job.record.environment,
        status: artifact.status === "conflicted" ? "conflicted" : "handed_off",
        updatedAt: artifact.updatedAt,
      };
    }
    touch(job.record, this.now);
    return {
      ok: artifact.status === "delivered",
      summary: artifact.status === "delivered"
        ? `Handed off ${artifact.id} to ${artifact.delivery ?? request.destination}.`
        : `Artifact ${artifact.id} requires conflict resolution before handoff.`,
      data: {
        agentId: job.record.id,
        taskId: job.record.taskId,
        artifactId: artifact.id,
        status: artifact.status,
        delivery: artifact.delivery,
        branchName: artifact.branchName,
        changedFileCount: artifact.changedFiles.length,
      },
      ...(artifact.status === "delivered"
        ? {}
        : { error: "Result handoff is conflicted" }),
    };
  }

  /** Commit a local lifecycle change only after Runtime persisted its parent event. */
  commitLifecycle(update: Readonly<SubagentLifecycleUpdate>): ObservedSubagentArtifacts | undefined {
    const job = this.jobs.get(update.agentId);
    if (!job) throw new Error(`Unknown subagent lifecycle target: ${update.agentId}`);
    if (update.action === "activate") {
      if (!job.activated) {
        job.activated = true;
        void this.execute(job);
      }
      return undefined;
    }
    if (update.action === "deliver_follow_up") {
      if (isTerminal(job.record.status) || job.record.status === "stopping") return undefined;
      if (job.record.followUpCount >= MAX_FOLLOW_UPS_PER_SUBAGENT) return undefined;
      job.followUps.push(sanitizeSubagentText(update.message));
      job.record.followUpCount += 1;
      touch(job.record, this.now);
      return undefined;
    }
    if (update.action === "request_stop") {
      job.stopReason = sanitizeSubagentText(update.reason);
      job.record.status = "stopping";
      delete job.record.result;
      touch(job.record, this.now);
      job.controller.abort();
      if (job.record.finishedAt) {
        job.record.status = "stopped";
        touch(job.record, this.now);
      }
      return undefined;
    }
    if (!isTerminal(job.record.status)) {
      throw new Error(`Cannot observe non-terminal subagent ${update.agentId}`);
    }
    job.graphObserved = true;
    if (!job.record.resultObservedAt) {
      job.record.resultObservedAt = this.now().toISOString();
      touch(job.record, this.now);
    }
    if (job.artifactsMerged) return undefined;
    return {
      agentId: job.record.id,
      taskId: job.record.taskId,
      changes: [...(job.outcome?.changes ?? [])],
      commands: [...(job.outcome?.commands ?? [])],
      presentations: [...(job.outcome?.presentations ?? [])],
      ...(job.outcome?.environment
        ? { environment: { ...job.outcome.environment } }
        : {}),
      ...(job.outcome?.resultArtifact
        ? { resultArtifact: cloneArtifact(job.outcome.resultArtifact) }
        : {}),
    };
  }

  /** Mark a previously returned artifact batch as durably merged by the parent. */
  finalizeArtifactMerge(agentId: string): void {
    const job = this.jobs.get(agentId);
    if (!job) throw new Error(`Unknown subagent artifact target: ${agentId}`);
    if (!isTerminal(job.record.status)) {
      throw new Error(`Cannot finalize artifacts for non-terminal subagent ${agentId}`);
    }
    job.artifactsMerged = true;
  }

  /** Return terminal artifact batches that still need an idempotent parent merge. */
  pendingArtifactMerges(threadId: string): ReadonlyArray<ObservedSubagentArtifacts> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.record.parentThreadId === threadId &&
          isTerminal(job.record.status) &&
          !job.artifactsMerged,
      )
      .map((job) => ({
        agentId: job.record.id,
        taskId: job.record.taskId,
        changes: [...(job.outcome?.changes ?? [])],
        commands: [...(job.outcome?.commands ?? [])],
        presentations: [...(job.outcome?.presentations ?? [])],
        ...(job.outcome?.environment
          ? { environment: { ...job.outcome.environment } }
          : {}),
        ...(job.outcome?.resultArtifact
          ? { resultArtifact: cloneArtifact(job.outcome.resultArtifact) }
          : {}),
      }));
  }

  /** Discard a prepared spawn when its authoritative parent event did not commit. */
  rollbackLifecycle(update: Readonly<SubagentLifecycleUpdate>): void {
    if (update.action !== "activate") return;
    const job = this.jobs.get(update.agentId);
    if (!job || job.activated) return;
    this.finishUnstarted(
      job,
      "interrupted",
      "The parent child-assignment transition did not commit.",
    );
    this.jobs.delete(update.agentId);
  }

  hasUnfinished(threadId?: string): boolean {
    return [...this.jobs.values()].some(
      (job) =>
        (!threadId || job.record.parentThreadId === threadId) &&
        !isTerminal(job.record.status),
    );
  }

  hasOutstanding(threadId?: string): boolean {
    return [...this.jobs.values()].some(
      (job) =>
        (!threadId || job.record.parentThreadId === threadId) &&
        (!job.graphObserved || !job.artifactsMerged),
    );
  }

  snapshot(threadId: string): ReadonlyArray<SubagentView> {
    return this.recordsForThread(threadId).map(publicRecord);
  }

  outstanding(threadId: string): ReadonlyArray<SubagentView> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.record.parentThreadId === threadId &&
          (!job.graphObserved || !job.artifactsMerged),
      )
      .map((job) => publicRecord(job.record));
  }

  /** Restore a terminal standalone result without restarting its old process. */
  restoreStandalone(
    input: RecoveredStandaloneSubagent,
    options: RestoreSubagentOptions = {},
  ): void {
    this.restore({
      ...input,
      assignment: {
        ...input.assignment,
        childThreadId:
          input.assignment.childThreadId ?? `thread_${input.assignment.agentId}`,
        environmentId:
          input.assignment.environmentId ?? `environment_${input.assignment.agentId}`,
        requestedIsolation: input.assignment.requestedIsolation ?? "shared",
      },
    }, options);
  }

  /** Restore a durable DAG or standalone binding, resuming non-terminal children. */
  restore(
    input: RecoveredSubagent,
    options: RestoreSubagentOptions = {},
  ): void {
    const { assignment } = input;
    if (this.jobs.has(assignment.agentId)) {
      throw new Error(`Duplicate recovered subagent ID: ${assignment.agentId}`);
    }
    if (!assignment.childThreadId || !assignment.environmentId) {
      throw new Error(`Recovered child ${assignment.agentId} has only a legacy binding`);
    }
    const task: TaskNode = input.task
      ? cloneTask(input.task)
      : {
          id: assignment.taskId,
          title: assignment.taskTitle,
          description: assignment.taskDescription,
          dependencies: [],
          inputs: [],
          expectedArtifacts: [],
          completionChecks: [...assignment.completionChecks],
          failureHandling: "Return a blocked result only for a concrete external condition.",
          owner: "subagent",
          assignedAgentId: assignment.agentId,
          status: "in_progress",
          startedAt: assignment.createdAt,
        };
    if (
      task.id !== assignment.taskId ||
      task.assignedAgentId !== assignment.agentId ||
      task.owner !== "subagent"
    ) {
      throw new Error(`Recovered child ${assignment.agentId} does not match its bound task`);
    }
    const terminal = input.reason !== undefined;
    const status = terminal
      ? statusForRecovered(input.reason as SubagentExecutionOutcome["reason"], input.report)
      : "running";
    const record: SubagentRecord = {
      id: assignment.agentId,
      childThreadId: assignment.childThreadId,
      environmentId: assignment.environmentId,
      parentThreadId: input.parentThreadId,
      createdByTurnId: input.createdByTurnId,
      assignmentKind: assignment.kind,
      ...(assignment.kind === "dag" ? { taskGraphId: assignment.taskGraphId } : {}),
      taskId: assignment.taskId,
      taskTitle: assignment.taskTitle,
      mode: "code",
      provider: assignment.provider,
      model: assignment.model,
      thinkingEffort: assignment.thinkingEffort,
      requestedIsolation: assignment.requestedIsolation ?? "shared",
      status,
      revision: terminal ? 2 : 1,
      instructions:
        "Resume the persisted child session and continue only the Runtime-bound assignment.",
      followUpCount: 0,
      ...(input.report && status !== "stopped"
        ? { result: validateAndCloneReport(task, input.report) }
        : {}),
      ...(input.error ? { error: sanitizeSubagentText(input.error).slice(0, 2_000) } : {}),
      ...(input.environment ? { environment: { ...input.environment } } : {}),
      ...(input.resultArtifact
        ? { resultArtifact: cloneArtifact(input.resultArtifact) }
        : {}),
      createdAt: assignment.createdAt,
      startedAt: assignment.createdAt,
      updatedAt: input.finishedAt ?? this.now().toISOString(),
      ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
    };
    let resolveSettled!: () => void;
    const settled = terminal
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          resolveSettled = resolve;
        });
    this.jobs.set(assignment.agentId, {
      record,
      task,
      controller: new AbortController(),
      followUps: [],
      settled,
      resolveSettled: terminal ? () => undefined : resolveSettled,
      activated: options.deferActivation !== true,
      graphObserved: input.observed ?? false,
      // Durable terminal artifact events were already replayed into the parent state.
      artifactsMerged: terminal,
      ...(terminal
        ? {
            outcome: {
              ...(record.result ? { report: record.result } : {}),
              reason: input.reason as SubagentExecutionOutcome["reason"],
              ...(record.error ? { error: record.error } : {}),
              changes: [],
              commands: [],
              presentations: [],
              ...(input.environment ? { environment: { ...input.environment } } : {}),
              ...(input.resultArtifact
                ? { resultArtifact: cloneArtifact(input.resultArtifact) }
                : {}),
            },
          }
        : {}),
      ...(options.deferActivation ? { preparedRestore: true } : {}),
    });
    if (!terminal && !options.deferActivation) {
      const job = this.jobs.get(assignment.agentId);
      if (!job) throw new Error(`Could not restore subagent ${assignment.agentId}`);
      void this.execute(job);
    }
  }

  /** Start a fully validated batch of durable restores as one control-plane commit. */
  activateRestored(agentIds: readonly string[]): void {
    const jobs = agentIds.map((agentId) => {
      const job = this.jobs.get(agentId);
      if (!job || !job.preparedRestore) {
        throw new Error(`Subagent ${agentId} is not a prepared durable restore`);
      }
      return job;
    });
    for (const job of jobs) {
      delete job.preparedRestore;
      if (isTerminal(job.record.status)) {
        job.activated = true;
        continue;
      }
      job.activated = true;
      void this.execute(job);
    }
  }

  /** Roll back only a batch that has not started any child execution. */
  rollbackRestored(agentIds: readonly string[]): void {
    const jobs = agentIds.map((agentId) => {
      const job = this.jobs.get(agentId);
      if (!job || !job.preparedRestore || job.activated) {
        throw new Error(`Subagent ${agentId} is not an unstarted durable restore`);
      }
      return job;
    });
    for (const job of jobs) this.jobs.delete(job.record.id);
  }

  hasAgent(agentId: string, parentThreadId?: string): boolean {
    const job = this.jobs.get(agentId);
    return Boolean(
      job && (!parentThreadId || job.record.parentThreadId === parentThreadId),
    );
  }

  async shutdown(threadId?: string): Promise<void> {
    const jobs = [...this.jobs.values()].filter(
      (job) => !threadId || job.record.parentThreadId === threadId,
    );
    for (const job of jobs) {
      if (isTerminal(job.record.status)) continue;
      job.stopReason = "The parent runtime is shutting down.";
      job.record.status = "stopping";
      touch(job.record, this.now);
      job.controller.abort();
      // A reserved job can exist only during a parent tool commit failure.
      if (!job.activated) {
        this.finishUnstarted(job, "stopped", job.stopReason);
      }
    }
    await Promise.all(jobs.map((job) => job.settled));
  }

  /** Abort process-local execution while preserving the durable claim/session. */
  async pause(threadId?: string): Promise<void> {
    const jobs = [...this.jobs.values()].filter(
      (job) =>
        (!threadId || job.record.parentThreadId === threadId) &&
        !isTerminal(job.record.status),
    );
    for (const job of jobs) {
      job.pauseRequested = true;
      job.controller.abort();
      if (!job.activated) {
        this.finishUnstarted(
          job,
          "interrupted",
          "The prepared child restore was paused before execution started.",
        );
      }
    }
    await Promise.all(jobs.map((job) => job.settled));
  }

  /** Remove process-local interrupted workers while preserving their durable bindings. */
  discardPausedJobs(threadId: string): number {
    const paused = [...this.jobs.values()].filter(
      (job) => job.record.parentThreadId === threadId && job.pauseRequested,
    );
    const unsafe = paused.find((job) => !isTerminal(job.record.status));
    if (unsafe) {
      throw new Error(`Cannot forget child ${unsafe.record.id}; pause has not settled`);
    }
    for (const job of paused) this.jobs.delete(job.record.id);
    return paused.length;
  }

  /** Forget only jobs that were deliberately paused and remain durable elsewhere. */
  discardPausedThread(threadId: string): void {
    const jobs = [...this.jobs.values()].filter(
      (job) => job.record.parentThreadId === threadId,
    );
    const unsafe = jobs.find(
      (job) =>
        !isTerminal(job.record.status) ||
        (!job.pauseRequested && (!job.graphObserved || !job.artifactsMerged)),
    );
    if (unsafe) {
      throw new Error(
        `Cannot forget child ${unsafe.record.id}; it was not durably paused`,
      );
    }
    for (const job of jobs) this.jobs.delete(job.record.id);
  }

  /**
   * Forget process-local child records after their thread has been durably
   * closed or switched away from. Callers must shut the jobs down and repair
   * any persisted task claims before discarding them.
   */
  discardThread(threadId: string): void {
    const jobs = [...this.jobs.values()].filter(
      (job) => job.record.parentThreadId === threadId,
    );
    const unfinished = jobs.find((job) => !isTerminal(job.record.status));
    if (unfinished) {
      throw new Error(
        `Cannot discard thread ${threadId} while child ${unfinished.record.id} is still running`,
      );
    }
    const unmerged = jobs.find((job) => !job.artifactsMerged);
    if (unmerged) {
      throw new Error(
        `Cannot discard thread ${threadId} before child ${unmerged.record.id} artifacts are merged`,
      );
    }
    for (const job of jobs) {
      this.jobs.delete(job.record.id);
    }
  }

  private async execute(job: SubagentJob): Promise<void> {
    try {
      const outcome = await this.runChild({
        record: { ...job.record },
        task: cloneTask(job.task),
        signal: job.controller.signal,
        drainFollowUps: () => job.followUps.splice(0),
        reportEnvironment: (environment) => {
          job.record.environment = { ...environment };
          touch(job.record, this.now);
        },
        isPauseRequested: () => job.pauseRequested === true,
      });
      job.outcome = outcome;
      if (outcome.environment) job.record.environment = { ...outcome.environment };
      if (outcome.resultArtifact) {
        job.record.resultArtifact = cloneArtifact(outcome.resultArtifact);
      }
      if (outcome.report) {
        try {
          job.record.result = validateAndCloneReport(job.task, outcome.report);
        } catch (error) {
          const message = sanitizeSubagentText(
            error instanceof Error ? error.message : String(error),
          ).slice(0, 2_000);
          job.outcome = { ...outcome, report: undefined, reason: "failed", error: message };
          job.record.error = message;
          job.record.status = "failed";
          return;
        }
      }
      job.record.error = outcome.error
        ? sanitizeSubagentText(outcome.error).slice(0, 2_000)
        : undefined;
      job.record.status = statusForOutcome(
        outcome,
        job.controller.signal.aborted,
        job.pauseRequested === true && !job.stopReason,
      );
      if (job.record.status === "stopped") delete job.record.result;
    } catch (error) {
      job.record.status = job.controller.signal.aborted ? "stopped" : "failed";
      job.record.error = job.controller.signal.aborted
        ? job.stopReason ?? "The child was canceled."
        : sanitizeSubagentText(
            error instanceof Error ? error.message : String(error),
          ).slice(0, 2_000);
      job.outcome = {
        reason: job.record.status,
        error: job.record.error,
        changes: [],
        commands: [],
        presentations: [],
      };
    } finally {
      const finishedAt = this.now().toISOString();
      job.record.finishedAt = finishedAt;
      job.record.updatedAt = finishedAt;
      job.record.revision += 1;
      job.resolveSettled();
    }
  }

  private finishUnstarted(
    job: SubagentJob,
    status: "stopped" | "interrupted",
    error: string,
  ): void {
    job.record.status = status;
    job.record.error = error;
    job.record.finishedAt = this.now().toISOString();
    touch(job.record, this.now);
    job.outcome = { reason: status, error, changes: [], commands: [], presentations: [] };
    job.resolveSettled();
  }

  private requireGraph(context: ToolContext): Readonly<TaskGraph> {
    if (!context.taskGraph) throw new Error("An active task DAG is required");
    return cloneTaskGraph(context.taskGraph);
  }

  private requireActiveGraph(context: ToolContext): Readonly<TaskGraph> {
    const graph = this.requireGraph(context);
    if (graph.status !== "active") {
      throw new Error("A DAG-bound child requires an active task DAG");
    }
    return graph;
  }

  private concurrencyLimit(context: ToolContext): number {
    if (this.maxConcurrentOverride !== undefined) return this.maxConcurrentOverride;
    if (!context.thinkingEffort) {
      throw new Error("The parent thinking effort is unavailable");
    }
    return maxConcurrentSubagents(context.thinkingEffort);
  }

  private recordsForThread(threadId: string): SubagentRecord[] {
    return [...this.jobs.values()]
      .filter((job) => job.record.parentThreadId === threadId)
      .map((job) => job.record);
  }

  private selectRecords(agentIds: readonly string[] | undefined, threadId: string): SubagentRecord[] {
    return agentIds
      ? this.selectJobs(agentIds, threadId).map((job) => job.record)
      : this.recordsForThread(threadId);
  }

  private selectJobs(agentIds: readonly string[], threadId: string): SubagentJob[] {
    return agentIds.map((agentId) => this.requireOwnedJob(agentId, threadId));
  }

  private requireOwnedJob(agentId: string, threadId: string): SubagentJob {
    const job = this.jobs.get(agentId);
    if (!job || job.record.parentThreadId !== threadId) {
      throw new Error(`Subagent ${agentId} does not belong to this parent thread`);
    }
    return job;
  }
}

function operationForObservedJob(job: SubagentJob): SubagentTaskTransitionOperation {
  const report = job.record.result;
  if (job.record.status === "completed" && report?.outcome === "completed") {
    return {
      action: "complete",
      taskId: job.record.taskId,
      agentId: job.record.id,
      evidence: report.completionEvidence.map((item) => item.evidence),
      ...(job.record.resultArtifact
        ? { resultArtifact: toResultArtifactRef(job.record.resultArtifact) }
        : {}),
    };
  }
  return { action: "release", taskId: job.record.taskId, agentId: job.record.id };
}

function publicRecord(record: Readonly<SubagentRecord>): SubagentView {
  return {
    id: record.id,
    childThreadId: record.childThreadId,
    environmentId: record.environmentId,
    assignmentKind: record.assignmentKind,
    ...(record.taskGraphId ? { taskGraphId: record.taskGraphId } : {}),
    taskId: record.taskId,
    taskTitle: record.taskTitle,
    mode: record.mode,
    provider: record.provider,
    model: record.model,
    thinkingEffort: record.thinkingEffort,
    requestedIsolation: record.requestedIsolation,
    ...(record.environment
      ? {
          environment: {
            id: record.environment.id,
            kind: record.environment.kind,
            status: record.environment.status,
            requestedIsolation: record.environment.requestedIsolation,
            baseMode: record.environment.baseMode,
            createdAt: record.environment.createdAt,
            updatedAt: record.environment.updatedAt,
          },
        }
      : {}),
    ...(record.resultArtifact
      ? {
          resultArtifact: {
            ...toResultArtifactRef(record.resultArtifact),
            ...(record.resultArtifact.delivery
              ? { delivery: record.resultArtifact.delivery }
              : {}),
            ...(record.resultArtifact.branchName
              ? { branchName: record.resultArtifact.branchName }
              : {}),
          },
        }
      : {}),
    status: record.status,
    revision: record.revision,
    followUpCount: record.followUpCount,
    ...(record.result ? { result: cloneReport(record.result) } : {}),
    ...(record.error ? { error: record.error } : {}),
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.resultObservedAt ? { resultObservedAt: record.resultObservedAt } : {}),
  };
}

function standaloneTask(
  definition: Readonly<StandaloneSubagentTask>,
  agentId: string,
  startedAt: string,
): TaskNode {
  const uuid = agentId.slice("subagent_".length).replace(/-/gu, "");
  return {
    id: `child_${uuid}`,
    title: sanitizeSubagentText(definition.title),
    description: sanitizeSubagentText(definition.description),
    dependencies: [],
    inputs: [],
    expectedArtifacts: [],
    completionChecks: definition.completionChecks.map(sanitizeSubagentText),
    failureHandling: "Return a blocked result only for a concrete external condition.",
    owner: "subagent",
    assignedAgentId: agentId,
    status: "in_progress",
    startedAt,
  };
}

function assignmentSnapshot(
  record: Readonly<SubagentRecord>,
  task: Readonly<TaskNode>,
): SubagentAssignmentSnapshot {
  const common = {
    agentId: record.id,
    childThreadId: record.childThreadId,
    environmentId: record.environmentId,
    taskId: task.id,
    taskTitle: task.title,
    taskDescription: task.description,
    completionChecks: [...task.completionChecks],
    provider: record.provider,
    model: record.model,
    thinkingEffort: record.thinkingEffort,
    requestedIsolation: record.requestedIsolation,
    createdAt: record.createdAt,
  };
  if (record.assignmentKind === "standalone") {
    return { kind: "standalone", ...common };
  }
  if (!record.taskGraphId) {
    throw new Error(`DAG child ${record.id} is missing its task graph ID`);
  }
  return { kind: "dag", taskGraphId: record.taskGraphId, ...common };
}

function cloneTask(task: Readonly<TaskNode>): TaskNode {
  return {
    ...task,
    dependencies: [...task.dependencies],
    inputs: [...task.inputs],
    expectedArtifacts: [...task.expectedArtifacts],
    completionChecks: [...task.completionChecks],
    ...(task.completionEvidence
      ? { completionEvidence: task.completionEvidence.map((item) => ({ ...item })) }
      : {}),
    ...(task.resultArtifact
      ? {
          resultArtifact: {
            ...task.resultArtifact,
            parentArtifactIds: [...task.resultArtifact.parentArtifactIds],
          },
        }
      : {}),
  };
}

/** Strip private and unbounded artifact fields before accepting lineage into a DAG. */
export function toResultArtifactRef(
  artifact: Readonly<ResultArtifact>,
): ResultArtifactRef {
  return {
    id: artifact.id,
    agentId: artifact.agentId,
    taskId: artifact.taskId,
    environmentId: artifact.environmentId,
    environmentKind: artifact.environmentKind,
    status: artifact.status,
    ...(artifact.baseCommit ? { baseCommit: artifact.baseCommit } : {}),
    ...(artifact.resultCommit ? { resultCommit: artifact.resultCommit } : {}),
    ...(artifact.snapshotRef ? { snapshotRef: artifact.snapshotRef } : {}),
    parentArtifactIds: [...(artifact.parentArtifactIds ?? [])],
    changedFileCount: artifact.changedFiles.length,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    ...(artifact.deliveredAt ? { deliveredAt: artifact.deliveredAt } : {}),
  };
}

function cloneArtifact(artifact: Readonly<ResultArtifact>): ResultArtifact {
  return {
    ...artifact,
    ...(artifact.parentArtifactIds
      ? { parentArtifactIds: [...artifact.parentArtifactIds] }
      : {}),
    changedFiles: [...artifact.changedFiles],
  };
}

function cloneReport(report: Readonly<SubagentTaskReport>): SubagentTaskReport {
  return report.outcome === "completed"
    ? {
        taskId: report.taskId,
        outcome: "completed",
        summary: sanitizeSubagentText(report.summary),
        completionEvidence: report.completionEvidence.map((item) => ({
          check: sanitizeSubagentText(item.check),
          evidence: sanitizeSubagentText(item.evidence),
        })),
      }
    : {
        taskId: report.taskId,
        outcome: "blocked",
        summary: sanitizeSubagentText(report.summary),
        blocker: sanitizeSubagentText(report.blocker),
      };
}

function validateAndCloneReport(
  task: Readonly<TaskNode>,
  report: Readonly<SubagentTaskReport>,
): SubagentTaskReport {
  if (report.taskId !== task.id) {
    throw new Error(`Child result targeted ${report.taskId} instead of bound task ${task.id}`);
  }
  if (report.outcome === "completed") {
    if (report.completionEvidence.length !== task.completionChecks.length) {
      throw new Error(
        `Child result for ${task.id} requires exactly ${task.completionChecks.length} evidence item(s)`,
      );
    }
    for (let index = 0; index < task.completionChecks.length; index += 1) {
      if (report.completionEvidence[index]?.check !== task.completionChecks[index]) {
        throw new Error(`Child result for ${task.id} changed completion check ${index + 1}`);
      }
    }
  }
  return cloneReport(report);
}

function statusForOutcome(
  outcome: Readonly<SubagentExecutionOutcome>,
  aborted: boolean,
  paused: boolean,
): SubagentStatus {
  // A pause preserves the durable child session. If the child already crossed
  // its verified completion boundary, that completed result (and its artifact)
  // must remain atomic even when the pause abort arrives during finalization.
  // Explicit stop/shutdown requests still win because they are not pauses.
  if (
    paused &&
    outcome.reason === "completed" &&
    outcome.report?.outcome === "completed"
  ) {
    return "completed";
  }
  if (aborted || outcome.reason === "stopped") return "stopped";
  if (outcome.report?.outcome === "completed") return "completed";
  if (outcome.report?.outcome === "blocked") return "blocked";
  if (outcome.reason === "interrupted") return "interrupted";
  return "failed";
}

function statusForRecovered(
  reason: SubagentExecutionOutcome["reason"],
  report: Readonly<SubagentTaskReport> | undefined,
): SubagentStatus {
  if (reason === "stopped") return "stopped";
  if (reason === "interrupted") return "interrupted";
  if (report?.outcome === "completed" && reason === "completed") return "completed";
  if (report?.outcome === "blocked" && reason === "blocked") return "blocked";
  return "failed";
}

function isTerminal(status: SubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function touch(record: SubagentRecord, now: () => Date): void {
  record.revision += 1;
  record.updatedAt = now().toISOString();
}

async function waitForFirstSettlement(
  jobs: readonly SubagentJob[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) throw new Error("Waiting for subagents was canceled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const aborted = new Promise<void>((_resolve, reject) => {
    if (!signal) return;
    onAbort = () => reject(new Error("Waiting for subagents was canceled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([...jobs.map((job) => job.settled), timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
