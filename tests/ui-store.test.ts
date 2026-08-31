import assert from "node:assert/strict";

import type {
  ApprovalRequest,
  ImageAttachment,
  PlanProposal,
} from "../src/core/types.js";
import type { SubagentView } from "../src/subagents/types.js";
import type { TaskGraphView } from "../src/tasks/task-graph.js";
import type {
  UIEvent,
  UISessionInfo,
  UITranscriptKind,
} from "../src/ui/contracts.js";
import {
  DEFAULT_COMPOSER_PLACEHOLDER,
  MAX_COMPOSER_IMAGES,
  MAX_LIVE_SUBAGENTS,
  MAX_LIVE_PROGRESS_ITEMS,
  MAX_LIVE_TASKS,
  MAX_OVERLAY_ROWS,
  applyEvent,
  applyEvents,
  createInitialUIState,
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
      status: index === 0 ? "in_progress" as const : "pending" as const,
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

function image(index: number): ImageAttachment {
  return {
    id: `image_${index}`,
    label: `Image #${index + 1}`,
    mediaType: "image/png",
    storageKey: `images/${index}.png`,
    sha256: String(index).padStart(64, "0"),
    byteSize: 4,
    width: 1,
    height: 1,
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
      progress: [],
      thinking: null,
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
    assert.deepEqual(createInitialUIState(), createUIState());
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
    assert.deepEqual(categorized.transcript.map((entry) => entry.kind), kinds);
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
    assert.equal(
      retained.transcript[transcriptCount - 1]?.text,
      String(transcriptCount - 1),
    );

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
    assert.equal(
      applyEvent(active, { type: "activity.stop", id: "activity_model" }).live.activity,
      null,
    );

    const progress = Array.from(
      { length: MAX_LIVE_PROGRESS_ITEMS + 2 },
      (_, index) => ({
        id: `progress_${index}`,
        kind: index % 2 === 0 ? "step" as const : "tool" as const,
        label: `Progress ${index}`,
        status: "running" as const,
      }),
    );
    const withProgress = applyEvent(initial, {
      type: "progress.set",
      progress,
    });
    assert.equal(withProgress.live.progress.length, MAX_LIVE_PROGRESS_ITEMS);
    assert.equal(withProgress.live.progress[0]?.id, "progress_2");
    assert.notEqual(withProgress.live.progress[0], progress[2]);
    assert.deepEqual(
      applyEvent(withProgress, { type: "progress.clear" }).live.progress,
      [],
    );

    const graph = taskGraph(MAX_LIVE_TASKS + 5);
    const withTasks = applyEvent(initial, { type: "tasks.set", tasks: graph });
    assert.equal(withTasks.live.tasks?.tasks.length, MAX_LIVE_TASKS);
    assert.notEqual(withTasks.live.tasks, graph);
    assert.notEqual(withTasks.live.tasks?.tasks[0]?.dependencies, graph.tasks[0]?.dependencies);
    assert.equal(applyEvent(withTasks, { type: "tasks.clear" }).live.tasks, null);

    const agents = Array.from(
      { length: MAX_LIVE_SUBAGENTS + 3 },
      (_, index) => subagent(index),
    );
    const withAgents = applyEvent(initial, {
      type: "subagents.set",
      subagents: agents,
    });
    assert.equal(withAgents.live.subagents.length, MAX_LIVE_SUBAGENTS);
    assert.equal(withAgents.live.subagents[0]?.id, "subagent_3");
    assert.notEqual(withAgents.live.subagents[0], agents[3]);
    assert.deepEqual(
      applyEvent(withAgents, { type: "subagents.clear" }).live.subagents,
      [],
    );
  });

  it("toggles one complete, sanitized Thinking panel with stale-safe hiding", () => {
    const secret = "abcdefghijklmnopqrstuvwxyz";
    const lines = [
      `Inspect api_key=abcde\u001B[31mfghijklmnopqrstuvwxyz`,
      "x".repeat(1_020),
      ...Array.from(
        { length: 123 },
        (_, index) => `reasoning line ${index}`,
      ),
    ];
    const text = lines.join("\n");
    const initial = createUIState();
    const opened = applyEvent(initial, {
      type: "thinking.toggle",
      panel: {
        id: 7,
        text,
        sourceChars: text.length,
        sourceLines: lines.length,
        truncated: false,
      },
    });

    const panel = opened.live.thinking;
    assert.equal(initial.live.thinking, null);
    assert.equal(panel?.id, 7);
    assert.equal(panel?.truncated, false);
    assert.equal(panel?.sourceLines, lines.length);
    assert.doesNotMatch(panel?.body ?? "", /\u001B/u);
    assert.doesNotMatch(panel?.body ?? "", new RegExp(secret, "u"));
    assert.match(panel?.body ?? "", /api_key=\[REDACTED\]/u);
    const retainedLines = (panel?.body ?? "").split("\n");
    assert.equal(retainedLines.length, lines.length);
    assert.equal(retainedLines[1], "x".repeat(1_020));
    assert.equal(retainedLines.at(-1), "reasoning line 122");

    const closed = applyEvent(opened, {
      type: "thinking.toggle",
      panel: { id: 7, body: "The same marker closes the panel." },
    });
    assert.equal(closed.live.thinking, null);

    const replacement = applyEvent(opened, {
      type: "thinking.toggle",
      panel: { id: 8, body: "A different block replaces the open panel." },
    });
    assert.equal(replacement.live.thinking?.id, 8);
    assert.equal(
      applyEvent(replacement, { type: "thinking.hide", id: 7 }),
      replacement,
    );
    assert.equal(
      applyEvent(replacement, { type: "thinking.hide", id: 8 }).live.thinking,
      null,
    );
    assert.equal(
      applyEvent(initial, {
        type: "thinking.toggle",
        panel: { id: Number.NaN, body: "invalid" },
      }),
      initial,
    );
  });

  it("supports generic, approval, and plan-review overlays", () => {
    const initial = createUIState();
    const picker = applyEvent(initial, {
      type: "overlay.show",
      overlay: {
        id: "model-picker",
        kind: "picker",
        title: "Select a model",
        rows: Array.from({ length: MAX_OVERLAY_ROWS + 2 }, (_, index) => ({
          id: String(index),
          label: `Model ${index}`,
        })),
        selectedIndex: MAX_OVERLAY_ROWS + 20,
        hint: "↑/↓ select · Enter confirm",
        detail: "Provider models",
      },
    });
    assert.equal(picker.overlay?.rows.length, MAX_OVERLAY_ROWS);
    assert.equal(picker.overlay?.selectedIndex, MAX_OVERLAY_ROWS - 1);
    assert.equal(
      applyEvent(picker, { type: "overlay.hide", id: "another-picker" }),
      picker,
    );
    assert.equal(
      applyEvent(picker, { type: "overlay.hide", id: "model-picker" }).overlay,
      null,
    );

    const request: ApprovalRequest = {
      id: "approval_run",
      title: "Run tests",
      description: "Execute the project test command.",
      risk: "workspace",
      commandPrefix: "npm",
      commandPreview: "npm test",
    };
    const approval = applyEvent(initial, {
      type: "overlay.show",
      overlay: {
        kind: "approval",
        title: request.title,
        rows: [{ id: "once", label: "Allow once" }],
        selectedIndex: -10,
        hint: "Enter confirm",
        request,
      },
    });
    assert.equal(approval.overlay?.kind, "approval");
    assert.equal(approval.overlay?.selectedIndex, 0);
    if (approval.overlay?.kind === "approval") {
      assert.notEqual(approval.overlay.request, request);
    }

    const proposal: PlanProposal = {
      id: "plan_ui",
      revision: 1,
      proposedByTurnId: "turn_ui",
      proposedAt: CREATED_AT,
      title: "Add authentication",
      overview: "Add login and registration.",
      steps: [{
        title: "Implement",
        description: "Build the feature.",
        verification: "Run tests.",
      }],
    };
    const review = applyEvent(initial, {
      type: "overlay.show",
      overlay: {
        kind: "plan-review",
        title: proposal.title,
        rows: [{ id: "approve", label: "Approve" }],
        selectedIndex: 0,
        hint: "Enter confirm",
        proposal,
      },
    });
    assert.equal(review.overlay?.kind, "plan-review");
    if (review.overlay?.kind === "plan-review") {
      assert.notEqual(review.overlay.proposal, proposal);
      assert.notEqual(review.overlay.proposal.steps, proposal.steps);
    }
  });

  it("patches, clamps, bounds, and resets the persistent composer", () => {
    const images = Array.from(
      { length: MAX_COMPOSER_IMAGES + 2 },
      (_, index) => image(index),
    );
    const initial = createUIState();
    const populated = applyEvent(initial, {
      type: "composer.patch",
      patch: {
        text: "hello",
        cursor: 999,
        busy: true,
        pendingSubmissions: 3,
        placeholder: "Continue…",
        images,
      },
    });
    assert.deepEqual(initial.composer, {
      text: "",
      cursor: 0,
      busy: false,
      pendingSubmissions: 0,
      placeholder: DEFAULT_COMPOSER_PLACEHOLDER,
      images: [],
    });
    assert.equal(populated.composer.cursor, 5);
    assert.equal(populated.composer.pendingSubmissions, 3);
    assert.equal(populated.composer.images.length, MAX_COMPOSER_IMAGES);
    assert.notEqual(populated.composer.images[0], images[0]);

    const shortened = applyEvent(populated, {
      type: "composer.patch",
      patch: { text: "hi" },
    });
    assert.equal(shortened.composer.cursor, 2);

    const reset = applyEvent(shortened, { type: "composer.reset" });
    assert.deepEqual(reset.composer, {
      text: "",
      cursor: 0,
      busy: false,
      pendingSubmissions: 0,
      placeholder: DEFAULT_COMPOSER_PLACEHOLDER,
      images: [],
    });
  });
});
