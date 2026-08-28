import assert from "node:assert/strict";

import { renderSubagents } from "../src/cli/subagents.js";
import type { SubagentStatus, SubagentView } from "../src/subagents/types.js";
import type { TaskGraphView } from "../src/tasks/task-graph.js";
import { describe, it } from "./harness.js";

const CREATED_AT = "2026-08-27T10:00:00.000Z";

function agent(
  id: string,
  taskId: string,
  taskTitle: string,
  status: SubagentStatus,
): SubagentView {
  return {
    id,
    childThreadId: `thread_${id}`,
    environmentId: `environment_${id}`,
    assignmentKind: "dag",
    taskGraphId: "task_graph_ui",
    taskId,
    taskTitle,
    mode: "code",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingEffort: "high",
    requestedIsolation: "auto",
    status,
    revision: 1,
    followUpCount: 0,
    createdAt: CREATED_AT,
    startedAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function graph(): TaskGraphView {
  const common = {
    description: "Task description",
    owner: "main_agent" as const,
    dependencies: [] as string[],
    blockedBy: [] as string[],
    inputs: [] as string[],
    expectedArtifacts: [] as string[],
    completionChecks: ["Task is verified"],
    failureHandling: "Record a blocker",
  };
  return {
    id: "task_graph_ui",
    goal: "Coordinate children",
    status: "active",
    currentTask: null,
    startableTasks: [],
    completed: 0,
    total: 2,
    tasks: [
      { ...common, id: "backend", title: "Implement backend", status: "in_progress" },
      { ...common, id: "frontend", title: "Implement frontend", status: "in_progress" },
    ],
  };
}

describe("child-agent terminal UI", () => {
  it("shows stable agent numbers, statuses, task numbers, IDs, and names", () => {
    const rendered = renderSubagents([
      agent("subagent_backend", "backend", "Implement backend", "running"),
      agent("subagent_frontend", "frontend", "Implement frontend", "completed"),
    ], { color: false, taskGraph: graph() });

    assert.match(rendered, /Child agents · 1 active · 2 total/u);
    assert.match(
      rendered,
      /▶ 1\. subagent_backend · Task 1 \[backend\] Implement backend \(running\)/u,
    );
    assert.match(
      rendered,
      /✓ 2\. subagent_frontend · Task 2 \[frontend\] Implement frontend \(completed\)/u,
    );
    assert.match(
      rendered,
      /thread thread_subagent_backend · isolation auto → pending · environment environment_subagent_backend \(pending\)/u,
    );
    assert.match(rendered, /artifact pending · handoff pending/u);
    assert.match(rendered, /artifact none · handoff unavailable/u);
    assert.doesNotMatch(rendered, /\u001B/u);
  });

  it("shows effective worktree isolation, result artifacts, and branch handoff", () => {
    const completed: SubagentView = {
      ...agent("subagent_delivery", "backend", "Implement backend", "completed"),
      requestedIsolation: "worktree",
      environment: {
        id: "environment_subagent_delivery",
        kind: "worktree",
        status: "handed_off",
        requestedIsolation: "worktree",
        baseMode: "current-snapshot",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      resultArtifact: {
        id: "artifact_delivery",
        agentId: "subagent_delivery",
        taskId: "backend",
        environmentId: "environment_subagent_delivery",
        environmentKind: "worktree",
        status: "delivered",
        parentArtifactIds: [],
        changedFileCount: 2,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        deliveredAt: CREATED_AT,
        delivery: "branch",
        branchName: "easy-code/backend",
      },
    };

    const rendered = renderSubagents([completed], {
      color: false,
      taskGraph: graph(),
    });

    assert.match(
      rendered,
      /thread thread_subagent_delivery · isolation worktree → worktree · environment environment_subagent_delivery \(handed_off\)/u,
    );
    assert.match(
      rendered,
      /artifact artifact_delivery \(delivered\) · 2 changed files · handoff branch easy-code\/backend/u,
    );
  });

  it("identifies shared environments without suggesting a handoff is required", () => {
    const shared: SubagentView = {
      ...agent("subagent_shared", "backend", "Implement backend", "completed"),
      requestedIsolation: "auto",
      environment: {
        id: "environment_subagent_shared",
        kind: "shared",
        status: "result_ready",
        requestedIsolation: "auto",
        baseMode: "head",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    };

    const rendered = renderSubagents([shared], { color: false });
    assert.match(rendered, /isolation auto → shared/u);
    assert.match(rendered, /artifact none · handoff shared workspace/u);
  });

  it("renders every lifecycle status with a distinct terminal marker", () => {
    const statuses: readonly SubagentStatus[] = [
      "running",
      "stopping",
      "completed",
      "blocked",
      "failed",
      "stopped",
      "interrupted",
    ];
    const rendered = renderSubagents(
      statuses.map((status, index) =>
        agent(`subagent_${index + 1}`, "backend", "Implement backend", status)),
      { color: false, taskGraph: graph() },
    );

    for (const status of statuses) assert.match(rendered, new RegExp(`\\(${status}\\)`, "u"));
    for (const marker of ["▶", "◌", "✓", "⊠", "✗", "■", "!"]) {
      assert.match(rendered, new RegExp(marker, "u"));
    }
  });

  it("distinguishes standalone work and shows the current effort limit", () => {
    const standalone: SubagentView = {
      ...agent("subagent_standalone", "child_abc", "Audit authentication", "running"),
      assignmentKind: "standalone",
      taskGraphId: undefined,
    };
    const rendered = renderSubagents([standalone], {
      color: false,
      taskGraph: graph(),
      concurrencyLimit: 4,
    });

    assert.match(rendered, /Child agents · 1\/4 active · 1 total/u);
    assert.match(
      rendered,
      /▶ 1\. subagent_standalone · Standalone \[child_abc\] Audit authentication \(running\)/u,
    );
    assert.doesNotMatch(rendered, /Task 1 \[child_abc\]/u);
  });

  it("sanitizes task names, supports color, and handles an empty runtime", () => {
    const unsafe = agent(
      "subagent_safe",
      "backend",
      "Inspect\u001B[31m api_key=abcdefghijklmnopqrstuvwxyz",
      "failed",
    );
    const plain = renderSubagents([unsafe], { color: false, taskGraph: graph() });
    const colored = renderSubagents([unsafe], { color: true, taskGraph: graph() });
    const empty = renderSubagents([], { color: false });

    assert.doesNotMatch(plain, /\u001B/u);
    assert.doesNotMatch(plain, /abcdefghijklmnopqrstuvwxyz/u);
    assert.match(plain, /\[REDACTED\]/u);
    assert.match(colored, /\u001B\[/u);
    assert.match(empty, /Child agents · 0 active · 0 total/u);
    assert.match(empty, /No child agents in this runtime/u);
  });
});
