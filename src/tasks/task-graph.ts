import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type {
  TaskCompletionEvidence,
  TaskGraph,
  TaskGraphStatus,
  TaskNode,
  TaskNodeStatus,
  ResultArtifactRef,
} from "../core/types.js";
import {
  containsSensitiveInformation,
  redactSensitiveInformation,
} from "../memory/sensitive.js";
import { createId } from "../utils/ids.js";

export const MAX_TASK_GRAPH_NODES = 32;
export const MAX_TASK_DEPENDENCIES = 16;
export const MAX_TASK_TEXT_CHARS = 600;
export const MAX_TASK_LIST_ITEMS = 16;
export const MAX_TASK_EVIDENCE_CHARS = 1_000;
export const MAX_TASK_COMPLETION_EVIDENCE_TOTAL_CHARS = 4_000;
export const MAX_TASK_GRAPH_SERIALIZED_CHARS = 48_000;
export const MAX_TASK_GRAPH_DEFINITION_CHARS = 20_000;

const TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u;
const AGENT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const GRAPH_ID_PATTERN = /^task_graph_[0-9a-f-]{36}$/u;
const UNSAFE_TASK_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;

const taskIdSchema = z.string().trim().regex(TASK_ID_PATTERN);
const agentIdSchema = z.string().trim().regex(AGENT_ID_PATTERN);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);

const artifactIdSchema = z.string().regex(/^artifact_[0-9a-f-]{36}$/u);

const resultArtifactRefSchema = z
  .object({
    id: artifactIdSchema,
    agentId: agentIdSchema,
    taskId: taskIdSchema,
    environmentId: z.string().regex(/^environment_[0-9a-f-]{36}$/u),
    environmentKind: z.enum(["shared", "worktree"]),
    status: z.enum(["ready", "integrated", "conflicted", "delivered", "retained"]),
    baseCommit: gitCommitSchema.optional(),
    resultCommit: gitCommitSchema.optional(),
    snapshotRef: z.string().min(1).max(512).optional(),
    parentArtifactIds: z.array(artifactIdSchema).max(MAX_TASK_DEPENDENCIES),
    changedFileCount: z.number().int().min(0).max(1_000_000),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    deliveredAt: z.string().datetime().optional(),
  })
  .strict();

function boundedTaskText(maximum = MAX_TASK_TEXT_CHARS): z.ZodEffects<z.ZodString, string, string> {
  return z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !UNSAFE_TASK_TEXT.test(value), {
      message: "Task text must be a single safe line without terminal controls",
    });
}

const taskTextListSchema = z
  .array(boundedTaskText())
  .max(MAX_TASK_LIST_ITEMS);

export const taskDefinitionInputSchema = z
  .object({
    id: taskIdSchema,
    title: boundedTaskText(120),
    description: boundedTaskText(),
    dependencies: z.array(taskIdSchema).max(MAX_TASK_DEPENDENCIES),
    inputs: taskTextListSchema,
    expectedArtifacts: taskTextListSchema,
    completionChecks: z.array(boundedTaskText()).min(1).max(MAX_TASK_LIST_ITEMS),
    failureHandling: boundedTaskText(),
  })
  .strict();

export type TaskDefinitionInput = z.infer<typeof taskDefinitionInputSchema>;

export const taskGraphOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      goal: boundedTaskText(),
      tasks: z.array(taskDefinitionInputSchema).min(1).max(MAX_TASK_GRAPH_NODES),
    })
    .strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("start"), taskId: taskIdSchema }).strict(),
  z
    .object({
      action: z.literal("complete"),
      taskId: taskIdSchema,
      evidence: z
        .array(boundedTaskText(MAX_TASK_EVIDENCE_CHARS))
        .min(1)
        .max(MAX_TASK_LIST_ITEMS),
    })
    .strict(),
  z
    .object({
      action: z.literal("block"),
      taskId: taskIdSchema,
      reason: boundedTaskText(MAX_TASK_EVIDENCE_CHARS),
    })
    .strict(),
  z.object({ action: z.literal("resume"), taskId: taskIdSchema }).strict(),
]);

export type TaskGraphOperation = z.infer<typeof taskGraphOperationSchema>;
export type TaskGraphTransitionOperation = Exclude<TaskGraphOperation, { action: "list" }>;

/** Runtime-only subagent transitions. These operations are never model-facing DAG tools. */
export const subagentTaskOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("claim"),
      taskId: taskIdSchema,
      agentId: agentIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      taskId: taskIdSchema,
      agentId: agentIdSchema,
      evidence: z
        .array(boundedTaskText(MAX_TASK_EVIDENCE_CHARS))
        .min(1)
        .max(MAX_TASK_LIST_ITEMS),
      resultArtifact: resultArtifactRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("release"),
      taskId: taskIdSchema,
      agentId: agentIdSchema,
    })
    .strict(),
]);

export type SubagentTaskOperation = z.infer<typeof subagentTaskOperationSchema>;
export type SubagentTaskTransitionOperation = SubagentTaskOperation;

export interface TaskGraphTransitionOptions {
  readonly turnId: string;
  readonly now?: () => Date;
  readonly graphId?: () => string;
}

const completionEvidenceSchema = z
  .object({
    check: boundedTaskText(),
    evidence: boundedTaskText(MAX_TASK_EVIDENCE_CHARS),
  })
  .strict();

const persistedTaskNodeSchema = z
  .object({
    id: taskIdSchema,
    title: boundedTaskText(120),
    description: boundedTaskText(),
    dependencies: z.array(taskIdSchema).max(MAX_TASK_DEPENDENCIES),
    inputs: taskTextListSchema,
    expectedArtifacts: taskTextListSchema,
    completionChecks: z.array(boundedTaskText()).min(1).max(MAX_TASK_LIST_ITEMS),
    failureHandling: boundedTaskText(),
    owner: z.enum(["main_agent", "subagent"]),
    assignedAgentId: agentIdSchema.optional(),
    status: z.enum(["pending", "in_progress", "completed", "blocked"]),
    completionEvidence: z.array(completionEvidenceSchema).optional(),
    resultArtifact: resultArtifactRefSchema.optional(),
    blocker: boundedTaskText(MAX_TASK_EVIDENCE_CHARS).optional(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

const persistedTaskGraphSchema = z
  .object({
    id: z.string().regex(GRAPH_ID_PATTERN),
    goal: boundedTaskText(),
    status: z.enum(["active", "completed", "blocked"]),
    createdByTurnId: z.string().trim().min(1).max(128),
    updatedByTurnId: z.string().trim().min(1).max(128),
    tasks: z.array(persistedTaskNodeSchema).min(1).max(MAX_TASK_GRAPH_NODES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

function assertSafeText(value: string): void {
  if (
    UNSAFE_TASK_TEXT.test(value) ||
    containsSensitiveInformation(value) ||
    redactSensitiveInformation(value) !== value
  ) {
    throw new Error("Task DAG text cannot contain secrets or unsafe control characters");
  }
}

function assertSafeDefinition(task: TaskDefinitionInput): void {
  assertSafeText(task.title);
  assertSafeText(task.description);
  assertSafeText(task.failureHandling);
  for (const value of [
    ...task.inputs,
    ...task.expectedArtifacts,
    ...task.completionChecks,
  ]) {
    assertSafeText(value);
  }
}

function taskById(graph: TaskGraph, taskId: string): TaskNode {
  const task = graph.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Task ${taskId} does not exist in the active DAG`);
  return task;
}

function derivedGraphStatus(tasks: readonly Readonly<TaskNode>[]): TaskGraphStatus {
  if (tasks.every((task) => task.status === "completed")) return "completed";
  return tasks.some((task) => task.status === "blocked") ? "blocked" : "active";
}

function assertMainOwnedTask(task: Readonly<TaskNode>): void {
  if (task.owner !== "main_agent" || task.assignedAgentId !== undefined) {
    throw new Error(`Task ${task.id} is assigned to a subagent`);
  }
}

function applyCompletionEvidence(
  task: TaskNode,
  evidence: readonly string[],
  completedAt: string,
): void {
  if (evidence.length !== task.completionChecks.length) {
    throw new Error(
      `Task ${task.id} requires exactly ${task.completionChecks.length} completion evidence item(s)`,
    );
  }
  if (
    evidence.reduce((total, item) => total + item.length, 0) >
    MAX_TASK_COMPLETION_EVIDENCE_TOTAL_CHARS
  ) {
    throw new Error(
      `Task ${task.id} completion evidence exceeds ` +
        `${MAX_TASK_COMPLETION_EVIDENCE_TOTAL_CHARS} total characters`,
    );
  }
  for (const item of evidence) assertSafeText(item);
  task.completionEvidence = task.completionChecks.map((check, index) => ({
    check,
    evidence: evidence[index] as string,
  }));
  task.status = "completed";
  task.completedAt = completedAt;
}

function assertAcyclicTasks(tasks: readonly Pick<TaskNode, "id" | "dependencies">[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error("Task IDs must be unique");
  for (const task of tasks) {
    const uniqueDependencies = new Set(task.dependencies);
    if (uniqueDependencies.size !== task.dependencies.length) {
      throw new Error(`Task ${task.id} contains duplicate dependencies`);
    }
    for (const dependency of task.dependencies) {
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself`);
      if (!byId.has(dependency)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new Error("Task dependencies must form an acyclic graph");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependencies ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

function assertTaskGraphInvariants(graph: TaskGraph): void {
  if (JSON.stringify(graph).length > MAX_TASK_GRAPH_SERIALIZED_CHARS) {
    throw new Error(`Task DAG exceeds ${MAX_TASK_GRAPH_SERIALIZED_CHARS} serialized characters`);
  }
  assertSafeText(graph.goal);
  assertAcyclicTasks(graph.tasks);
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  const inProgress = graph.tasks.filter((task) => task.status === "in_progress");
  const blocked = graph.tasks.filter((task) => task.status === "blocked");
  const mainInProgress = graph.tasks.filter(
    (task) => task.status === "in_progress" && task.owner === "main_agent",
  );
  if (mainInProgress.length > 1) {
    throw new Error("Only one main-agent task may be in progress");
  }
  if (blocked.length > 1) throw new Error("Only one task may be blocked");
  if (inProgress.length && blocked.length) {
    throw new Error("A task graph cannot be blocked and in progress at the same time");
  }
  const assignedAgents = new Set<string>();

  for (const task of graph.tasks) {
    assertSafeDefinition(task);
    if (task.owner === "subagent") {
      if (!task.assignedAgentId) {
        throw new Error(`Subagent-owned task ${task.id} is missing its assigned agent ID`);
      }
      if (task.status !== "in_progress" && task.status !== "completed") {
        throw new Error(`Subagent-owned task ${task.id} must be in progress or completed`);
      }
      if (assignedAgents.has(task.assignedAgentId)) {
        throw new Error(`Subagent ${task.assignedAgentId} is assigned to more than one task`);
      }
      assignedAgents.add(task.assignedAgentId);
    } else if (task.assignedAgentId !== undefined) {
      throw new Error(`Main-agent task ${task.id} cannot contain an assigned agent ID`);
    }
    for (const item of task.completionEvidence ?? []) {
      assertSafeText(item.check);
      assertSafeText(item.evidence);
    }
    if (
      (task.completionEvidence ?? []).reduce(
        (total, item) => total + item.evidence.length,
        0,
      ) > MAX_TASK_COMPLETION_EVIDENCE_TOTAL_CHARS
    ) {
      throw new Error(
        `Task ${task.id} completion evidence exceeds ` +
          `${MAX_TASK_COMPLETION_EVIDENCE_TOTAL_CHARS} total characters`,
      );
    }
    if (task.blocker) assertSafeText(task.blocker);
    if (task.resultArtifact) {
      if (task.status !== "completed") {
        throw new Error(`Only completed task ${task.id} may contain a result artifact`);
      }
      if (
        task.resultArtifact.taskId !== task.id ||
        task.resultArtifact.agentId !== task.assignedAgentId
      ) {
        throw new Error(`Task ${task.id} result artifact does not match its child assignment`);
      }
      if (
        task.resultArtifact.status === "conflicted" ||
        task.resultArtifact.status === "retained" ||
        (task.resultArtifact.environmentKind === "worktree" &&
          !task.resultArtifact.resultCommit)
      ) {
        throw new Error(`Task ${task.id} result artifact is not ready for DAG lineage`);
      }
      const expectedParents = task.dependencies.flatMap((dependencyId) => {
        const artifact = byId.get(dependencyId)?.resultArtifact;
        return artifact ? [artifact.id] : [];
      });
      if (
        expectedParents.length !== task.resultArtifact.parentArtifactIds.length ||
        expectedParents.some(
          (artifactId, index) =>
            task.resultArtifact?.parentArtifactIds[index] !== artifactId,
        )
      ) {
        throw new Error(`Task ${task.id} result artifact has invalid parent lineage`);
      }
    }
    if (
      task.status === "in_progress" ||
      task.status === "completed" ||
      task.status === "blocked"
    ) {
      for (const dependency of task.dependencies) {
        if (byId.get(dependency)?.status !== "completed") {
          throw new Error(`Task ${task.id} started before dependency ${dependency} completed`);
        }
      }
    }
    if (task.status === "completed") {
      if (
        !task.startedAt ||
        !task.completedAt ||
        task.completionEvidence?.length !== task.completionChecks.length
      ) {
        throw new Error(`Completed task ${task.id} is missing completion evidence`);
      }
      for (let index = 0; index < task.completionChecks.length; index += 1) {
        if (task.completionEvidence[index]?.check !== task.completionChecks[index]) {
          throw new Error(`Completed task ${task.id} has mismatched completion evidence`);
        }
      }
    } else if (task.status === "in_progress" && !task.startedAt) {
      throw new Error(`In-progress task ${task.id} is missing its start time`);
    } else if (task.status === "blocked" && !task.startedAt) {
      throw new Error(`Blocked task ${task.id} is missing its start time`);
    } else if (task.completedAt || task.completionEvidence) {
      throw new Error(`Incomplete task ${task.id} cannot contain completion evidence`);
    }
    if (task.status === "blocked" && !task.blocker) {
      throw new Error(`Blocked task ${task.id} must include a blocker`);
    }
    if (task.status !== "blocked" && task.blocker) {
      throw new Error(`Only blocked tasks may include a blocker`);
    }
  }

  const expectedStatus = derivedGraphStatus(graph.tasks);
  if (graph.status !== expectedStatus) {
    throw new Error(`Task graph status must be ${expectedStatus}`);
  }
}

export function isTaskGraph(value: unknown): value is TaskGraph {
  const parsed = persistedTaskGraphSchema.safeParse(value);
  if (!parsed.success) return false;
  try {
    assertTaskGraphInvariants(parsed.data as TaskGraph);
    return true;
  } catch {
    return false;
  }
}

export function cloneTaskGraph(graph: Readonly<TaskGraph>): TaskGraph {
  return {
    ...graph,
    tasks: graph.tasks.map((task) => ({
      ...task,
      dependencies: [...task.dependencies],
      inputs: [...task.inputs],
      expectedArtifacts: [...task.expectedArtifacts],
      completionChecks: [...task.completionChecks],
      ...(task.completionEvidence
        ? { completionEvidence: task.completionEvidence.map((item) => ({ ...item })) }
        : {}),
      ...(task.resultArtifact
        ? { resultArtifact: cloneResultArtifact(task.resultArtifact) }
        : {}),
    })),
  };
}

function transitionTime(options: TaskGraphTransitionOptions): string {
  const value = (options.now ?? (() => new Date()))();
  if (Number.isNaN(value.getTime())) throw new Error("Task transition time is invalid");
  return value.toISOString();
}

export function applyTaskGraphOperation(
  current: Readonly<TaskGraph> | undefined,
  operation: TaskGraphTransitionOperation,
  options: TaskGraphTransitionOptions,
): TaskGraph {
  const now = transitionTime(options);
  if (operation.action === "create") {
    if (current && current.status !== "completed") {
      throw new Error("Finish or resolve the active task DAG before creating another one");
    }
    if (current?.updatedByTurnId === options.turnId) {
      throw new Error("Finish the current turn before creating a replacement task DAG");
    }
    if (JSON.stringify({ goal: operation.goal, tasks: operation.tasks }).length >
      MAX_TASK_GRAPH_DEFINITION_CHARS) {
      throw new Error(
        `Task DAG definitions exceed ${MAX_TASK_GRAPH_DEFINITION_CHARS} serialized characters`,
      );
    }
    assertSafeText(operation.goal);
    for (const task of operation.tasks) assertSafeDefinition(task);
    assertAcyclicTasks(operation.tasks);
    const graph: TaskGraph = {
      id: (options.graphId ?? (() => createId("task_graph")))(),
      goal: operation.goal,
      status: "active",
      createdByTurnId: options.turnId,
      updatedByTurnId: options.turnId,
      tasks: operation.tasks.map((task) => ({
        ...task,
        dependencies: [...task.dependencies],
        inputs: [...task.inputs],
        expectedArtifacts: [...task.expectedArtifacts],
        completionChecks: [...task.completionChecks],
        owner: "main_agent",
        status: "pending",
      })),
      createdAt: now,
      updatedAt: now,
    };
    if (!isTaskGraph(graph)) throw new Error("The proposed task DAG is invalid");
    return graph;
  }

  if (!current) throw new Error("No task DAG exists in this thread");
  const graph = cloneTaskGraph(current);
  const task = taskById(graph, operation.taskId);

  if (operation.action === "start") {
    if (graph.status !== "active") throw new Error("Only an active task DAG can start work");
    if (
      graph.tasks.some(
        (candidate) =>
          candidate.status === "in_progress" && candidate.owner === "main_agent",
      )
    ) {
      throw new Error("Complete or block the current main-agent task before starting another one");
    }
    if (task.status !== "pending") throw new Error(`Task ${task.id} is not pending`);
    assertMainOwnedTask(task);
    const unresolved = task.dependencies.filter(
      (dependency) => taskById(graph, dependency).status !== "completed",
    );
    if (unresolved.length) {
      throw new Error(`Task ${task.id} is blocked by: ${unresolved.join(", ")}`);
    }
    task.status = "in_progress";
    task.startedAt = now;
  } else if (operation.action === "complete") {
    assertMainOwnedTask(task);
    if (task.status !== "in_progress") {
      throw new Error(`Task ${task.id} must be in progress before it can be completed`);
    }
    applyCompletionEvidence(task, operation.evidence, now);
    graph.status = derivedGraphStatus(graph.tasks);
  } else if (operation.action === "block") {
    assertMainOwnedTask(task);
    if (task.status !== "in_progress") {
      throw new Error(`Task ${task.id} must be in progress before it can be blocked`);
    }
    assertSafeText(operation.reason);
    task.status = "blocked";
    task.blocker = operation.reason;
    graph.status = derivedGraphStatus(graph.tasks);
  } else {
    assertMainOwnedTask(task);
    if (task.status !== "blocked") {
      throw new Error(`Task ${task.id} is not the blocked task`);
    }
    task.status = "pending";
    delete task.blocker;
    graph.status = derivedGraphStatus(graph.tasks);
  }

  graph.updatedAt = now;
  graph.updatedByTurnId = options.turnId;
  assertTaskGraphInvariants(graph);
  return graph;
}

/**
 * Applies one Runtime-owned child-agent transition. Model-facing manage_tasks
 * cannot call this path, and every operation is bound to one immutable agent ID.
 */
export function applySubagentTaskOperation(
  current: Readonly<TaskGraph> | undefined,
  operation: SubagentTaskTransitionOperation,
  options: TaskGraphTransitionOptions,
): TaskGraph {
  if (!current) throw new Error("No task DAG exists in this thread");
  const now = transitionTime(options);
  const graph = cloneTaskGraph(current);
  const task = taskById(graph, operation.taskId);

  if (operation.action === "claim") {
    if (graph.status !== "active") {
      throw new Error("Only an active task DAG can assign subagent work");
    }
    if (task.status !== "pending") throw new Error(`Task ${task.id} is not pending`);
    assertMainOwnedTask(task);
    if (graph.tasks.some((candidate) => candidate.assignedAgentId === operation.agentId)) {
      throw new Error(`Subagent ${operation.agentId} is already assigned to a task`);
    }
    const unresolved = task.dependencies.filter(
      (dependency) => taskById(graph, dependency).status !== "completed",
    );
    if (unresolved.length) {
      throw new Error(`Task ${task.id} is blocked by: ${unresolved.join(", ")}`);
    }
    task.owner = "subagent";
    task.assignedAgentId = operation.agentId;
    task.status = "in_progress";
    task.startedAt = now;
  } else {
    if (task.owner !== "subagent" || task.assignedAgentId !== operation.agentId) {
      throw new Error(`Task ${task.id} is not assigned to subagent ${operation.agentId}`);
    }
    if (task.status !== "in_progress") {
      throw new Error(`Task ${task.id} must be in progress for a subagent transition`);
    }
    if (operation.action === "complete") {
      applyCompletionEvidence(task, operation.evidence, now);
      if (operation.resultArtifact) {
        if (
          operation.resultArtifact.agentId !== operation.agentId ||
          operation.resultArtifact.taskId !== operation.taskId
        ) {
          throw new Error("Subagent result artifact does not match the completed assignment");
        }
        if (
          operation.resultArtifact.status === "conflicted" ||
          operation.resultArtifact.status === "retained" ||
          (operation.resultArtifact.environmentKind === "worktree" &&
            !operation.resultArtifact.resultCommit)
        ) {
          throw new Error("Subagent result artifact is not ready for DAG lineage");
        }
        task.resultArtifact = cloneResultArtifact(operation.resultArtifact);
      }
    } else {
      task.owner = "main_agent";
      delete task.assignedAgentId;
      task.status = "pending";
      delete task.startedAt;
      delete task.resultArtifact;
    }
  }

  graph.status = derivedGraphStatus(graph.tasks);
  graph.updatedAt = now;
  graph.updatedByTurnId = options.turnId;
  assertTaskGraphInvariants(graph);
  return graph;
}

function cloneResultArtifact(artifact: Readonly<ResultArtifactRef>): ResultArtifactRef {
  return { ...artifact, parentArtifactIds: [...artifact.parentArtifactIds] };
}

/**
 * Replays one persisted model operation against the prior authoritative graph
 * and accepts its snapshot only when every field matches the legal transition.
 */
export function validateTaskGraphTransition(
  current: Readonly<TaskGraph> | undefined,
  operation: TaskGraphTransitionOperation,
  snapshot: unknown,
  turnId: string,
): TaskGraph {
  if (!isTaskGraph(snapshot)) throw new Error("Task DAG transition snapshot is invalid");
  if (snapshot.updatedByTurnId !== turnId) {
    throw new Error("Task DAG transition turn does not match its journal event");
  }
  const expected = applyTaskGraphOperation(current, operation, {
    turnId,
    now: () => new Date(snapshot.updatedAt),
    graphId: () => snapshot.id,
  });
  if (!isDeepStrictEqual(expected, snapshot)) {
    throw new Error("Task DAG snapshot does not match the declared legal transition");
  }
  return cloneTaskGraph(snapshot);
}

/** Validate a persisted Runtime-only subagent transition against prior state. */
export function validateSubagentTaskTransition(
  current: Readonly<TaskGraph> | undefined,
  operation: SubagentTaskTransitionOperation,
  snapshot: unknown,
  turnId: string,
): TaskGraph {
  if (!isTaskGraph(snapshot)) throw new Error("Subagent task transition snapshot is invalid");
  if (snapshot.updatedByTurnId !== turnId) {
    throw new Error("Subagent task transition turn does not match its journal event");
  }
  const expected = applySubagentTaskOperation(current, operation, {
    turnId,
    now: () => new Date(snapshot.updatedAt),
  });
  if (!isDeepStrictEqual(expected, snapshot)) {
    throw new Error("Subagent task snapshot does not match the declared legal transition");
  }
  return cloneTaskGraph(snapshot);
}

export interface TaskGraphView {
  id: string;
  goal: string;
  status: TaskGraphStatus;
  currentTask: string | null;
  startableTasks: string[];
  completed: number;
  total: number;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    status: TaskNodeStatus;
    owner: TaskNode["owner"];
    assignedAgentId?: string;
    dependencies: string[];
    blockedBy: string[];
    inputs: string[];
    expectedArtifacts: string[];
    completionChecks: string[];
    failureHandling: string;
    completionEvidence?: TaskCompletionEvidence[];
    blocker?: string;
  }>;
}

export function taskGraphView(graph: Readonly<TaskGraph>): TaskGraphView {
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  const current = activeTask(graph);
  const tasks = graph.tasks.map((task) => {
    const blockedBy = task.dependencies.filter(
      (dependency) => byId.get(dependency)?.status !== "completed",
    );
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      owner: task.owner,
      ...(task.assignedAgentId ? { assignedAgentId: task.assignedAgentId } : {}),
      dependencies: [...task.dependencies],
      blockedBy,
      inputs: [...task.inputs],
      expectedArtifacts: [...task.expectedArtifacts],
      completionChecks: [...task.completionChecks],
      failureHandling: task.failureHandling,
      ...(task.completionEvidence
        ? { completionEvidence: task.completionEvidence.map((item) => ({ ...item })) }
        : {}),
      ...(task.blocker ? { blocker: task.blocker } : {}),
    };
  });
  return {
    id: graph.id,
    goal: graph.goal,
    status: graph.status,
    currentTask: current?.id ?? null,
    startableTasks: graph.status === "active"
      ? tasks
          .filter((task) => task.status === "pending" && task.blockedBy.length === 0)
          .map((task) => task.id)
      : [],
    completed: graph.tasks.filter((task) => task.status === "completed").length,
    total: graph.tasks.length,
    tasks,
  };
}

/**
 * Bounded control-plane view for prompts. The current/blocked/startable nodes
 * retain every execution field; inactive nodes stay compact until eligible.
 */
export function taskGraphPromptView(graph: Readonly<TaskGraph>): Record<string, unknown> {
  const view = taskGraphView(graph);
  const expanded = new Set([
    ...(view.currentTask ? [view.currentTask] : []),
    ...view.startableTasks,
    ...view.tasks.filter((task) => task.status === "in_progress").map((task) => task.id),
    ...view.tasks.filter((task) => task.status === "blocked").map((task) => task.id),
  ]);
  return {
    id: view.id,
    goal: view.goal,
    status: view.status,
    currentTask: view.currentTask,
    startableTasks: view.startableTasks,
    completed: view.completed,
    total: view.total,
    tasks: view.tasks.map((task) => expanded.has(task.id)
      ? task
      : {
          id: task.id,
          title: task.title,
          status: task.status,
          owner: task.owner,
          ...(task.assignedAgentId ? { assignedAgentId: task.assignedAgentId } : {}),
          dependencies: task.dependencies,
          blockedBy: task.blockedBy,
          expectedArtifacts: task.expectedArtifacts,
          completionEvidenceCount: task.completionEvidence?.length ?? 0,
        }),
  };
}

export function activeTask(graph: Readonly<TaskGraph> | undefined): TaskNode | undefined {
  return activeTasksByOwner(graph, "main_agent")[0];
}

export function activeTasksByOwner(
  graph: Readonly<TaskGraph> | undefined,
  owner: TaskNode["owner"],
): TaskNode[] {
  return graph?.tasks.filter(
    (task) => task.status === "in_progress" && task.owner === owner,
  ) ?? [];
}

export function activeTaskByOwner(
  graph: Readonly<TaskGraph> | undefined,
  owner: TaskNode["owner"],
  assignedAgentId?: string,
): TaskNode | undefined {
  if (owner === "subagent" && !assignedAgentId) {
    throw new Error("A subagent owner lookup requires an assigned agent ID");
  }
  return activeTasksByOwner(graph, owner).find(
    (task) => owner === "main_agent" || task.assignedAgentId === assignedAgentId,
  );
}

export function activeTaskForAgent(
  graph: Readonly<TaskGraph> | undefined,
  assignedAgentId: string,
): TaskNode | undefined {
  const parsedAgentId = agentIdSchema.parse(assignedAgentId);
  return activeTaskByOwner(graph, "subagent", parsedAgentId);
}
