import assert from "node:assert/strict";

import { renderTaskGraph } from "../src/cli/task-graph.js";
import type { TaskGraphView } from "../src/tasks/task-graph.js";
import { describe, it } from "./harness.js";

function graph(): TaskGraphView {
  const common = {
    description: "Task description",
    dependencies: [] as string[],
    blockedBy: [] as string[],
    inputs: [] as string[],
    expectedArtifacts: [] as string[],
    completionChecks: ["Task is verified"],
    failureHandling: "Record a blocker",
  };
  return {
    id: "task_graph_test",
    goal: "Implement and verify the feature",
    status: "blocked",
    currentTask: "implement",
    startableTasks: [],
    completed: 1,
    total: 4,
    tasks: [
      { ...common, id: "inspect", title: "Inspect architecture", status: "completed" },
      { ...common, id: "implement", title: "Implement feature", status: "in_progress" },
      { ...common, id: "verify", title: "Run verification", status: "pending" },
      {
        ...common,
        id: "publish",
        title: "Publish result",
        status: "blocked",
        blocker: "Waiting for credentials",
      },
    ],
  };
}

describe("task DAG terminal UI", () => {
  it("renders stable task numbers, IDs, names, and status symbols", () => {
    const rendered = renderTaskGraph(graph(), { color: false });

    assert.match(rendered, /Task DAG · 1\/4 completed/u);
    assert.match(rendered, /Goal: Implement and verify the feature/u);
    assert.match(rendered, /✓ 1\. \[inspect\] Inspect architecture/u);
    assert.match(rendered, /▶ 2\. \[implement\] Implement feature \(in progress\)/u);
    assert.match(rendered, /□ 3\. \[verify\] Run verification/u);
    assert.match(
      rendered,
      /⊠ 4\. \[publish\] Publish result \(blocked: Waiting for credentials\)/u,
    );
    assert.ok(rendered.indexOf("1. [inspect]") < rendered.indexOf("4. [publish]"));
    assert.doesNotMatch(rendered, /\u001B/u);
  });

  it("sanitizes task text and supports colored TTY rendering", () => {
    const view = graph();
    view.tasks[2] = {
      ...view.tasks[2]!,
      title: "Verify\u001B[31m api_key=abcdefghijklmnopqrstuvwxyz",
    };
    const plain = renderTaskGraph(view, { color: false });
    const colored = renderTaskGraph(view, { color: true });

    assert.doesNotMatch(plain, /\u001B/u);
    assert.doesNotMatch(plain, /abcdefghijklmnopqrstuvwxyz/u);
    assert.match(plain, /\[REDACTED\]/u);
    assert.match(colored, /\u001B\[/u);
  });
});
