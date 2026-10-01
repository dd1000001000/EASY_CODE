import assert from "node:assert/strict";

import type { SubagentView } from "../src/subagents/types.js";
import type { TaskGraphView } from "../src/tasks/task-graph.js";
import type { UIEvent, UIOverlayState, UIProgressStatus } from "../src/ui/contracts.js";
import { displayWidth, stripAnsi } from "../src/ui/render/layout.js";
import { LOGO_ROWS } from "../src/ui/render/logo.js";
import {
  renderAgentStatusLines,
  renderComposerStatusRegion,
  renderComposerFooter,
  renderFixedBottomRegions,
  renderLiveActivityRegion,
  renderOverlayRegion,
  renderSessionHeader,
  renderTaskStatusLines,
} from "../src/ui/render/view.js";
import { applyEvent, applyEvents, createUIState } from "../src/ui/store.js";
import { describe, it } from "./harness.js";

const CREATED_AT = "2026-08-29T00:00:00.000Z";

function graph(taskCount = 7): TaskGraphView {
  return {
    id: "task_graph_view",
    goal: "完成课程系统",
    status: "active",
    currentTask: "task_1",
    startableTasks: [],
    completed: 1,
    total: taskCount,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `task_${index}`,
      title: index === 1 ? "实现后端认证" : `Task ${index + 1}`,
      description: "A task",
      status: index === 0 ? ("completed" as const) : index === 1 ? ("in_progress" as const) : ("pending" as const),
      owner: "main_agent" as const,
      dependencies: [],
      blockedBy: [],
      inputs: [],
      expectedArtifacts: [],
      completionChecks: ["Verified"],
      failureHandling: "Report",
    })),
  };
}

function agent(index: number): SubagentView {
  return {
    id: `agent-${index + 1}`,
    childThreadId: `thread-${index}`,
    environmentId: `environment-${index}`,
    assignmentKind: "standalone",
    taskId: `task-${index}`,
    taskTitle: index === 0 ? "Implement authentication API" : `Agent task ${index + 1}`,
    mode: "code",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    thinkingEffort: "medium",
    requestedIsolation: "auto",
    status: index < 2 ? "running" : "completed",
    revision: 1,
    followUpCount: 0,
    ...(index < 2
      ? {}
      : {
          result: {
            taskId: `task-${index}`,
            outcome: "completed" as const,
            summary: `Completed ${index + 1}`,
            completionEvidence: [],
          },
        }),
    createdAt: CREATED_AT,
    startedAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function populatedState(): ReturnType<typeof createUIState> {
  const statuses: readonly UIProgressStatus[] = ["completed", "running"];
  const events: UIEvent[] = [
    {
      type: "session.set",
      session: {
        threadId: "8f72a1",
        workspaceRoot: "F:\\projects\\课程系统",
        mode: "auto",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinkingEffort: "medium",
        contextTokens: 82_400,
      },
    },
    { type: "tasks.set", tasks: graph() },
    {
      type: "subagents.set",
      subagents: Array.from({ length: 7 }, (_, index) => agent(index)),
    },
    {
      type: "progress.set",
      progress: statuses.map((status, index) => ({
        id: `progress-${index}`,
        kind: index === 0 ? "tool" : "step",
        label: index === 0 ? "Read static/index.html" : "Reading workspace",
        status,
      })),
    },
    {
      type: "activity.start",
      activity: {
        id: "model",
        kind: "model",
        label: "Waiting for deepseek-v4-pro",
        startedAt: 1_000,
      },
    },
  ];
  return applyEvents(createUIState(), events);
}

function assertBoundedLines(value: string, columns: number): void {
  for (const line of value.split("\n")) {
    assert.ok(displayWidth(line) <= columns, `${JSON.stringify(stripAnsi(line))} exceeds ${columns} columns`);
  }
}

describe("pure terminal UI views", () => {
  it("nests active DAG children under their task and omits finished agents from live rows", () => {
    const startedAt = "2026-08-29T00:00:00.000Z";
    const child: SubagentView = {
      ...agent(0),
      assignmentKind: "dag",
      taskId: "task_1",
      activity: { kind: "tool", label: "read_file", startedAt },
    };
    const terminal: SubagentView = { ...agent(2), finishedAt: startedAt };
    const state = applyEvents(createUIState(), [
      { type: "tasks.set", tasks: graph() },
      { type: "subagents.set", subagents: [child, agent(1), terminal] },
    ]);
    const nowMs = Date.parse(startedAt) + 5_000;
    const taskRows = renderTaskStatusLines(
      state.live.tasks,
      { columns: 100, color: false },
      undefined,
      state.live.subagents,
      nowMs,
    );
    assert.ok(taskRows.some((row) => row.includes("agent-1") && row.includes("Tool read_file") && row.includes("5s")));
    const agentRows = renderAgentStatusLines(state, { columns: 100, color: false }, undefined, nowMs);
    assert.ok(agentRows.some((row) => row.includes("agent-2")));
    assert.ok(!agentRows.some((row) => row.includes("agent-1") || row.includes("agent-3")));
  });

  it("labels live children by their display name instead of their ID", () => {
    const startedAt = "2026-08-29T00:00:00.000Z";
    const child: SubagentView = { ...agent(0), assignmentKind: "dag", taskId: "task_1", displayName: "前端构建者" };
    const loose: SubagentView = { ...agent(1), displayName: "Docs Writer" };
    const state = applyEvents(createUIState(), [
      { type: "tasks.set", tasks: graph() },
      { type: "subagents.set", subagents: [child, loose] },
    ]);
    const nowMs = Date.parse(startedAt) + 5_000;
    const taskRows = renderTaskStatusLines(
      state.live.tasks,
      { columns: 100, color: false },
      undefined,
      state.live.subagents,
      nowMs,
    );
    assert.ok(taskRows.some((row) => row.includes("↳ 前端构建者 ·")));
    const agentRows = renderAgentStatusLines(state, { columns: 100, color: false }, undefined, nowMs);
    assert.ok(agentRows.some((row) => row.includes("Docs Writer")));
    assert.ok(![...taskRows, ...agentRows].some((row) => row.includes("agent-1") || row.includes("agent-2")));
  });

  it("renders review stages and real elapsed time in the fixed footer without replacing model activity", () => {
    const review = { id: "review_ui", startedAt: 1_000, phase: "independent_review" as const };
    const state = applyEvents(createUIState(), [
      { type: "review.set", review },
      { type: "activity.start", activity: { id: "model", label: "requesting model", startedAt: 60_000 } },
    ]);
    const footer = renderFixedBottomRegions(state, { columns: 100, color: false }, 65_000, {
      totalRows: 2,
      detailRows: 0,
    });
    assert.equal(footer.status.length, 2);
    assert.match(stripAnsi(footer.status[0] ?? ""), /Review · Reviewer independently investigating · 1m/u);
    assert.doesNotMatch(stripAnsi(footer.status[0] ?? ""), /[█▣░]/u);
    const preparing = applyEvent(state, { type: "review.set", review: { ...review, phase: "main_brief" } });
    const preparingFooter = renderFixedBottomRegions(preparing, { columns: 100, color: false }, 65_000, {
      totalRows: 2,
      detailRows: 0,
    });
    assert.match(stripAnsi(preparingFooter.status[0] ?? ""), /Main agent preparing review handoff · 1m/u);
    assert.equal(state.live.activity?.id, "model");
    const stopped = applyEvent(state, { type: "activity.stop", id: "model" });
    assert.equal(stopped.live.review?.id, review.id);
    assert.equal(applyEvent(stopped, { type: "review.clear", id: review.id }).live.review, null);
  });

  it("renders a safe CJK-aware EASY CODE session card without color", () => {
    const initial = createUIState({
      header: { title: "EASY\u001B[2J CODE" },
    });
    const state = applyEvents(initial, [
      {
        type: "session.set",
        session: {
          threadId: "8f72a1",
          workspaceRoot: "F:\\projects\\课程系统 password=hunter22",
          mode: "auto",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          thinkingEffort: "medium",
          contextTokens: 82_400,
          contextLimitTokens: 128_000,
        },
      },
    ]);

    const rendered = renderSessionHeader(state, { columns: 80, color: false });

    assert.match(rendered, /^EASY CODE\n/u);
    assert.match(rendered, /auto · DeepSeek\/v4-pro · thinking:medium/u);
    assert.match(rendered, /context:82\.4k\/128k/u);
    assert.match(rendered, /课程系统 password=\[REDACTED\]/u);
    assert.match(rendered, /thread: 8f72a1/u);
    assert.equal(rendered.includes("\u001B"), false);
    assertBoundedLines(rendered, 80);
  });

  it("shows the orchestration switch in the live footer without crowding header context", () => {
    for (const enabled of [false, true]) {
      const state = applyEvents(createUIState(), [
        {
          type: "session.set",
          session: {
            threadId: "toggle-thread",
            workspaceRoot: "F:\\project",
            mode: "code",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            thinkingEffort: "medium",
            orchestrationEnabled: enabled,
            contextTokens: 82_400,
            contextLimitTokens: 128_000,
          },
        },
      ]);
      const footer = renderComposerFooter(state, { columns: 80, color: false });
      assert.equal(footer.includes("DAG/agents on"), enabled);
      assert.match(renderSessionHeader(state, { columns: 80, color: false }), /context:82\.4k\/128k/u);
      assertBoundedLines(footer, 80);
    }
  });

  it("right-aligns the model in the footer and hides idle run state", () => {
    const state = applyEvents(createUIState(), [
      {
        type: "session.set",
        session: {
          threadId: "footer-thread",
          workspaceRoot: "F:\\project",
          mode: "code",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          thinkingEffort: "medium",
          contextTokens: 82_400,
          contextLimitTokens: 128_000,
        },
      },
    ]);
    const footer = renderComposerFooter(state, { columns: 60, color: false });
    assert.match(footer, /^code {2,}v4-pro · medium · ctx 82\.4k\/128k$/u);
    assert.equal(footer.length, 59, "the last terminal cell stays empty");
    assert.doesNotMatch(footer, /task|Agents|DAG/u);
    // Too narrow to split: the model still follows the mode.
    assert.match(renderComposerFooter(state, { columns: 24, color: false }), /^code · v4-pro · medium/u);
  });

  it("keeps one stable session title and renders unrestricted mode in the live footer", () => {
    const state = applyEvents(createUIState(), [
      {
        type: "session.set",
        session: {
          threadId: "danger-thread",
          workspaceRoot: "F:\\projects\\danger",
          mode: "code",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          thinkingEffort: "high",
          commandExecutionMode: "unrestricted",
        },
      },
    ]);

    const header = renderSessionHeader(state, { columns: 80, color: true });
    const footer = renderComposerFooter(state, { columns: 80, color: true });
    // With color, room and height, the origami-dog logo sits left of the title.
    const headerRows = stripAnsi(header).split("\n");
    assert.equal(headerRows.length, LOGO_ROWS);
    assert.match(headerRows[1] ?? "", /^[▀▄ ]{11} {2}EASY CODE$/u);
    assert.match(headerRows[3] ?? "", /^[▀▄ ]{11} {2}F:\\projects\\danger · thread: danger-thread$/u);
    assertBoundedLines(header, 80);
    // A short or narrow terminal keeps its rows for the conversation.
    for (const options of [{ columns: 80, rows: 12 }, { columns: 30 }]) {
      assert.match(stripAnsi(renderSessionHeader(state, { ...options, color: true })), /^EASY CODE\n/u);
    }
    assert.doesNotMatch(stripAnsi(header), /Unrestricted command execution/u);
    assert.match(stripAnsi(footer), /^! EASY CODE HOST FULL ACCESS  code/u);
    assert.doesNotMatch(header, /\u001B\[31m/u);
    assert.match(footer, /\u001B\[31m/u);
  });

  it("keeps the red full-access warning visible while a modal overlay is open", () => {
    const state = applyEvents(createUIState(), [
      {
        type: "session.set",
        session: {
          threadId: "danger-overlay-thread",
          workspaceRoot: "F:\\projects\\danger",
          mode: "code",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          thinkingEffort: "high",
          commandExecutionMode: "unrestricted",
        },
      },
    ]);
    const overlay: UIOverlayState = {
      id: "danger-model-picker",
      kind: "picker",
      title: "Select model",
      rows: [{ id: "one", label: "One" }],
      selectedIndex: 0,
      hint: "Enter confirm",
    };

    const rendered = renderOverlayRegion(overlay, state, { columns: 100, color: true });
    assert.match(stripAnsi(rendered), /Select model/u);
    assert.match(stripAnsi(rendered), /! HOST FULL ACCESS/u);
    assert.match(rendered, /\u001B\[31m/u);
  });

  it("renders compact progress, task, agent, activity, and footer", () => {
    const state = populatedState();
    const options = {
      columns: 72,
      color: false,
      spinnerFrame: "⠹",
    } as const;
    const activity = renderLiveActivityRegion(state, 15_000, options);
    const status = renderComposerStatusRegion(state, options, 15_000);

    assert.match(activity, /^Progress/u);
    assert.match(activity, /Read static\/index\.html/u);
    assert.match(activity, /⠹ Waiting for deepseek-v4-pro \(14s\)/u);
    assert.doesNotMatch(activity, /Tasks/u);

    const blocks = status.split("\n\n");
    assert.equal(blocks.length, 3);
    assert.match(blocks[0] ?? "", /^auto · .*v4-pro · medium/u);
    assert.match(blocks[1] ?? "", /^Tasks 2\/7/u);
    assert.match(blocks[1] ?? "", /✓ 1\. Task 1/u);
    assert.match(blocks[1] ?? "", /▶ 2\. 实现后端认证/u);
    assert.equal(status.includes("Task 6"), false);
    assert.match(blocks[2] ?? "", /^Agents 2\/4/u);
    assert.match(blocks[2] ?? "", /● agent-1  Implement authentication API/u);
    assert.equal(status.includes("agent-6"), false);
    assert.doesNotMatch(blocks[1] ?? "", /Reading workspace/u);
    assertBoundedLines(activity, 72);
    assertBoundedLines(status, 72);
  });

  it("budgets fixed bottom rows independently in status, Tasks, Agents order", () => {
    const state = populatedState();
    const options = { columns: 28, color: false, spinnerFrame: "⠹" } as const;
    const tasks = renderTaskStatusLines(state.live.tasks, options, 4);
    const agents = renderAgentStatusLines(state, options, 3);

    assert.equal(tasks.length, 4);
    assert.match(tasks[0] ?? "", /^Tasks 2\/7/u);
    assert.ok(tasks.some((line) => /▶ 2\. 实现后端认证/u.test(line)));
    assert.match(tasks.at(-1) ?? "", /… 5 other tasks/u);
    assert.equal(agents.length, 3);
    assert.match(agents[0] ?? "", /^Agents 2\/4/u);
    assert.match(agents[1] ?? "", /● agent-1/u);
    assert.match(agents[2] ?? "", /agent-2/u);
    assertBoundedLines(tasks.join("\n"), 28);
    assertBoundedLines(agents.join("\n"), 28);

    const regions = renderFixedBottomRegions(state, options, 15_000, {
      totalRows: 7,
      detailRows: 6,
      taskRows: 4,
      agentRows: 4,
    });
    assert.equal(regions.lines.length, 7);
    assert.equal(regions.status.length, 1);
    assert.equal(regions.tasks.length, 3);
    assert.equal(regions.agents.length, 3);
    assert.deepEqual(regions.lines, [...regions.status, ...regions.tasks, ...regions.agents]);
    assert.match(regions.lines[0] ?? "", /^auto · .*v4-pro · medium/u);
    assert.match(regions.lines[1] ?? "", /^Tasks 2\/7/u);
    assert.match(regions.lines[4] ?? "", /^Agents 2\/4/u);

    const headingsOnly = renderFixedBottomRegions(state, options, 15_000, {
      totalRows: 3,
    });
    assert.deepEqual(
      headingsOnly.lines.map((line) => stripAnsi(line)),
      [stripAnsi(renderComposerFooter(state, options, 15_000)), "Tasks 2/7", "Agents 2/4"],
    );
    const detailCapped = renderFixedBottomRegions(state, options, 15_000, {
      totalRows: 20,
      detailRows: 2,
    });
    assert.equal(detailCapped.lines.length, 3);
    assert.deepEqual(
      detailCapped.lines.slice(1).map((line) => stripAnsi(line)),
      ["Tasks 2/7", "Agents 2/4"],
    );
    assert.deepEqual(renderFixedBottomRegions(state, options, 15_000, { totalRows: 0 }), {
      status: [],
      tasks: [],
      agents: [],
      lines: [],
    });

    const narrow = renderFixedBottomRegions(state, { ...options, columns: 8 }, 15_000, { totalRows: 3 });
    assert.equal(narrow.lines.length, 3);
    assertBoundedLines(narrow.lines.join("\n"), 8);
  });

  it("keeps tool activity above Request while metadata remains in the footer", () => {
    const state = applyEvent(populatedState(), {
      type: "activity.start",
      activity: {
        id: "tool-run",
        kind: "tool",
        label: "Running Tool: run_command",
        startedAt: 1_000,
      },
    });

    const upper = renderLiveActivityRegion(state, 65_000, {
      columns: 72,
      color: false,
      spinnerFrame: "⠴",
    });
    const footer = renderComposerFooter(
      state,
      {
        columns: 72,
        color: false,
        spinnerFrame: "⠴",
      },
      65_000,
    );
    const narrowFooter = renderComposerFooter(
      state,
      {
        columns: 32,
        color: false,
        spinnerFrame: "⠴",
      },
      65_000,
    );

    assert.match(upper, /⠴ Running Tool: run_command \(1m 04s\)/u);
    assert.match(footer, /^auto · .*v4-pro · medium/u);
    assert.match(narrowFooter, /^auto/u);
    assertBoundedLines(footer, 72);
    assertBoundedLines(narrowFooter, 32);
  });

  it("gives a safe boxed overlay exclusive priority over live status", () => {
    const overlay: UIOverlayState = {
      id: "picker",
      kind: "picker",
      title: "Select\u001B[2J model",
      detail: "api_key=abcdefghijklmnop",
      rows: [
        { id: "a", label: "deepseek-v4-flash" },
        { id: "b", label: "deepseek-v4-pro", detail: "Recommended" },
        { id: "c", label: "bad\u001B]52;c;payload\u0007safe" },
      ],
      selectedIndex: 1,
      hint: "↑/↓ select · Enter confirm",
    };
    const state = populatedState();

    const rendered = renderOverlayRegion(overlay, state, {
      columns: 54,
      color: false,
    });

    assert.match(rendered, /^╭─ Select model /u);
    assert.match(rendered, /api_key=\[REDACTED\]/u);
    assert.match(rendered, /› deepseek-v4-pro · Recommended/u);
    assert.match(rendered, /badsafe/u);
    assert.equal(rendered.includes("Tasks"), false);
    assert.equal(rendered.includes("Progress"), false);
    assert.equal(rendered.includes("\u001B"), false);
    assertBoundedLines(rendered, 54);

    const colored = renderOverlayRegion(overlay, state, {
      columns: 54,
      color: true,
    });
    assert.equal(colored.includes("\u001B["), true);
    assert.equal(stripAnsi(colored), rendered);
  });

  it("keeps the selected approval action visible in a short terminal", () => {
    const base = {
      id: "short-approval",
      kind: "approval" as const,
      title: "Approve command execution",
      request: {
        id: "approval-short",
        title: "Run command",
        description: "Executes workspace code inside the sandbox.",
        risk: "workspace" as const,
        commandPrefix: "node",
        commandPreview: "node --check src/app.js",
      },
      rows: [
        { id: "once", label: "Yes, allow execute one time" },
        { id: "prefix", label: "Yes, don't ask me again" },
        { id: "reject", label: "Reject" },
      ],
      hint: "Use ↑/↓ to move, Enter to confirm",
    };
    const ui = createUIState();
    const first: UIOverlayState = { ...base, selectedIndex: 0 };
    const second: UIOverlayState = { ...base, selectedIndex: 1 };

    const firstRendered = stripAnsi(
      renderOverlayRegion(first, ui, {
        columns: 100,
        rows: 5,
        color: false,
      }),
    );
    const secondRendered = stripAnsi(
      renderOverlayRegion(second, ui, {
        columns: 100,
        rows: 5,
        color: false,
      }),
    );

    assert.equal(firstRendered.split("\n").length, 5);
    assert.equal(secondRendered.split("\n").length, 5);
    assert.match(firstRendered, /› Yes, allow execute one time/u);
    assert.match(secondRendered, /› Yes, don't ask me again/u);
    assert.notEqual(firstRendered, secondRendered);

    const fourRows = stripAnsi(
      renderOverlayRegion(first, ui, {
        columns: 100,
        rows: 4,
        color: false,
      }),
    );
    assert.match(fourRows, /Command: node --check src\/app\.js/u);
    assert.match(fourRows, /› Yes, allow execute one time/u);

    const threeRows = stripAnsi(
      renderOverlayRegion(first, ui, {
        columns: 100,
        rows: 3,
        color: false,
      }),
    );
    assert.match(threeRows, /Approval disabled: enlarge the terminal/u);
    assert.doesNotMatch(threeRows, /Yes, allow execute/u);
  });

  it("keeps the footer useful in a narrow terminal", () => {
    const state = applyEvents(populatedState(), [{ type: "activity.stop", id: "model" }]);
    const footer = renderComposerFooter(state, { columns: 24, color: false });

    assertBoundedLines(footer, 24);
    assert.match(footer, /^auto · .*v4-pro · medium/u);
  });
});
