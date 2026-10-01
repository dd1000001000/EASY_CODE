import assert from "node:assert/strict";

import type { SubagentView } from "../src/subagents/types.js";
import type { TaskGraphView } from "../src/tasks/task-graph.js";
import type { UIEvent, UISessionInfo, UITranscriptKind } from "../src/ui/contracts.js";
import {
  DEFAULT_COMPOSER_PLACEHOLDER,
  MAX_LIVE_SUBAGENTS,
  MAX_LIVE_PROGRESS_ITEMS,
  MAX_LIVE_TASKS,
  applyEvent,
  applyEvents,
  createUIState,
  uiReducer,
} from "../src/ui/store.js";
import { describe, it } from "./harness.js";

const CREATED_AT = "2026-08-29T00:00:00.000Z";

function taskGraph(taskCount: number): TaskGraphView {
  return {
    id: "task_graph_ui_store",
    goal: "Exercise the UI store",
    status: "active",
    currentTask: taskCount > 0 ? "task_0" : null,
    startableTasks: taskCount > 1 ? ["task_1"] : [],
    completed: 0,
    total: taskCount,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `task_${index}`,
      title: `Task ${index}`,
      description: "A task",
      status: index === 0 ? ("in_progress" as const) : ("pending" as const),
      owner: "main_agent" as const,
      dependencies: index === 0 ? [] : ["task_0"],
      blockedBy: index === 0 ? [] : ["task_0"],
      inputs: [],
      expectedArtifacts: [],
      completionChecks: ["Verified"],
      failureHandling: "Report a blocker",
    })),
  };
}

function subagent(index: number): SubagentView {
  return {
    id: `subagent_${index}`,
    childThreadId: `thread_${index}`,
    environmentId: `environment_${index}`,
    assignmentKind: "standalone",
    taskId: `task_${index}`,
    taskTitle: `Task ${index}`,
    mode: "code",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    thinkingEffort: "medium",
    requestedIsolation: "auto",
    status: "running",
    revision: 1,
    followUpCount: 0,
    createdAt: CREATED_AT,
    startedAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

describe("pure terminal UI state", () => {
  it("creates defaults and updates header/session without mutating prior state", () => {
    const initial = createUIState({
      header: { title: "TEST CODE" },
      composer: { placeholder: "Ask…" },
    });
    assert.deepEqual(initial.header, { title: "TEST CODE", session: null });
    assert.deepEqual(initial.transcript, []);
    assert.deepEqual(initial.live, {
      activity: null,
      review: null,
      progress: [],
      tasks: null,
      subagents: [],
    });
    assert.equal(initial.composer.placeholder, "Ask…");

    const session: UISessionInfo = {
      threadId: "thread_ui",
      workspaceRoot: "F:\\project",
      mode: "auto",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinkingEffort: "medium",
      approvalPolicy: "ask",
      contextTokens: 82_400,
    };
    const withSession = applyEvent(initial, {
      type: "session.set",
      session,
    });
    const renamed = uiReducer(withSession, {
      type: "header.merge",
      patch: { title: "EASY CODE" },
    });

    assert.equal(initial.header.session, null);
    assert.notEqual(withSession.header, initial.header);
    assert.notEqual(withSession.header.session, session);
    assert.deepEqual(withSession.header.session, session);
    assert.equal(renamed.header.title, "EASY CODE");
    assert.deepEqual(renamed.header.session, session);
  });

  it("appends every transcript category without evicting terminal history", () => {
    const kinds: readonly UITranscriptKind[] = [
      "user",
      "assistant",
      "tool",
      "info",
      "success",
      "warning",
      "error",
      "raw",
    ];
    const events: UIEvent[] = kinds.map((kind) => ({
      type: "transcript.append",
      entry: { kind, text: kind },
    }));
    const initial = createUIState();
    const categorized = applyEvents(initial, events);
    assert.deepEqual(
      categorized.transcript.map((entry) => entry.kind),
      kinds,
    );
    assert.deepEqual(initial.transcript, []);

    let retained = createUIState();
    const transcriptCount = 1_003;
    for (let index = 0; index < transcriptCount; index += 1) {
      retained = applyEvent(retained, {
        type: "transcript.append",
        entry: { kind: "raw", text: String(index) },
      });
    }
    assert.equal(retained.transcript.length, transcriptCount);
    assert.equal(retained.transcript[0]?.text, "0");
    assert.equal(retained.transcript[transcriptCount - 1]?.text, String(transcriptCount - 1));

    const presentation = {
      type: "file_diff" as const,
      path: "src/app.ts",
      before: "old",
      after: "new",
    };
    const withPresentation = applyEvent(createUIState(), {
      type: "transcript.append",
      entry: { kind: "success", text: "Updated", presentation },
    });
    assert.notEqual(withPresentation.transcript[0]?.presentation, presentation);
  });

  it("replaces a mutable transcript entry by stable id without moving it", () => {
    const initial = applyEvents(createUIState(), [
      { type: "transcript.append", entry: { kind: "user", id: "before", text: "before" } },
      { type: "transcript.append", entry: { kind: "assistant", id: "stream", text: "partial" } },
      { type: "transcript.append", entry: { kind: "tool", id: "after", text: "after" } },
    ]);
    const replaced = applyEvent(initial, {
      type: "transcript.replace",
      id: "stream",
      entry: { kind: "assistant", text: "complete" },
    });
    assert.deepEqual(
      replaced.transcript.map((entry) => entry.id),
      ["before", "stream", "after"],
    );
    assert.equal(replaced.transcript[1]?.text, "complete");
    assert.equal(initial.transcript[1]?.text, "partial");
    assert.equal(
      applyEvent(replaced, {
        type: "transcript.replace",
        id: "missing",
        entry: { kind: "assistant", text: "ignored" },
      }).transcript,
      replaced.transcript,
    );
  });

  it("keeps activity transitions stale-safe and task/subagent snapshots bounded", () => {
    const initial = createUIState();
    const active = applyEvent(initial, {
      type: "activity.start",
      activity: {
        id: "activity_model",
        kind: "model",
        label: "Waiting for deepseek-v4-pro",
        startedAt: 1_777_777_777_000,
      },
    });
    const staleStop = applyEvent(active, {
      type: "activity.stop",
      id: "activity_old",
    });
    assert.equal(staleStop, active);
    assert.equal(active.live.activity?.startedAt, 1_777_777_777_000);
    assert.equal(applyEvent(active, { type: "activity.stop", id: "activity_model" }).live.activity, null);

    const progress = Array.from({ length: MAX_LIVE_PROGRESS_ITEMS + 2 }, (_, index) => ({
      id: `progress_${index}`,
      kind: index % 2 === 0 ? ("step" as const) : ("tool" as const),
      label: `Progress ${index}`,
      status: "running" as const,
    }));
    const withProgress = applyEvent(initial, {
      type: "progress.set",
      progress,
    });
    assert.equal(withProgress.live.progress.length, MAX_LIVE_PROGRESS_ITEMS);
    assert.equal(withProgress.live.progress[0]?.id, "progress_2");
    assert.notEqual(withProgress.live.progress[0], progress[2]);
    assert.deepEqual(applyEvent(withProgress, { type: "progress.clear" }).live.progress, []);

    const graph = taskGraph(MAX_LIVE_TASKS + 5);
    const withTasks = applyEvent(initial, { type: "tasks.set", tasks: graph });
    assert.equal(withTasks.live.tasks?.tasks.length, MAX_LIVE_TASKS);
    assert.notEqual(withTasks.live.tasks, graph);
    assert.notEqual(withTasks.live.tasks?.tasks[0]?.dependencies, graph.tasks[0]?.dependencies);
    assert.equal(applyEvent(withTasks, { type: "tasks.clear" }).live.tasks, null);
    const completedGraph: TaskGraphView = {
      ...graph,
      status: "completed",
      currentTask: null,
      completed: graph.total,
      startableTasks: [],
      tasks: graph.tasks.map((task) => ({ ...task, status: "completed" as const })),
    };
    assert.equal(
      applyEvent(withTasks, { type: "tasks.set", tasks: completedGraph }).live.tasks,
      null,
      "a completed DAG is history, not a persistent live footer section",
    );

    const agents = Array.from({ length: MAX_LIVE_SUBAGENTS + 3 }, (_, index) => subagent(index));
    const withAgents = applyEvent(initial, {
      type: "subagents.set",
      subagents: agents,
    });
    assert.equal(withAgents.live.subagents.length, MAX_LIVE_SUBAGENTS);
    assert.equal(withAgents.live.subagents[0]?.id, "subagent_3");
    assert.notEqual(withAgents.live.subagents[0], agents[3]);
    assert.deepEqual(applyEvent(withAgents, { type: "subagents.clear" }).live.subagents, []);
  });

  it("patches, clamps, and resets the composer chrome", () => {
    const initial = createUIState();
    const populated = applyEvent(initial, {
      type: "composer.patch",
      patch: { pendingSubmissions: 3, placeholder: "Continue…" },
    });
    assert.deepEqual(initial.composer, { pendingSubmissions: 0, placeholder: DEFAULT_COMPOSER_PLACEHOLDER });
    assert.deepEqual(populated.composer, { pendingSubmissions: 3, placeholder: "Continue…" });
    assert.equal(
      applyEvent(populated, { type: "composer.patch", patch: { pendingSubmissions: -4 } }).composer.pendingSubmissions,
      0,
    );

    const reset = applyEvent(populated, { type: "composer.reset" });
    assert.deepEqual(reset.composer, { pendingSubmissions: 0, placeholder: DEFAULT_COMPOSER_PLACEHOLDER });
  });
});
