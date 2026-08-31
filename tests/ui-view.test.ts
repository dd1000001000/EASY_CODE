import assert from "node:assert/strict";

import type { SubagentView } from "../src/subagents/types.js";
import type { TaskGraphView } from "../src/tasks/task-graph.js";
import type { UIEvent, UIProgressStatus } from "../src/ui/contracts.js";
import { displayWidth, stripAnsi } from "../src/ui/render/layout.js";
import {
  renderComposerStatusRegion,
  renderComposerFooter,
  renderComposerPrompt,
  renderLiveActivityRegion,
  renderLiveRegion,
  renderSessionHeader,
  renderThinkingPanel,
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
      status: index === 0
        ? "completed" as const
        : index === 1
          ? "in_progress" as const
          : "pending" as const,
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
    {
      type: "composer.patch",
      patch: { busy: true },
    },
  ];
  return applyEvents(createUIState(), events);
}

function assertBoundedLines(value: string, columns: number): void {
  for (const line of value.split("\n")) {
    assert.ok(
      displayWidth(line) <= columns,
      `${JSON.stringify(stripAnsi(line))} exceeds ${columns} columns`,
    );
  }
}

describe("pure terminal UI views", () => {
  it("renders a safe CJK-aware EASY CODE session card without color", () => {
    const initial = createUIState({
      header: { title: "EASY\u001B[2J CODE" },
    });
    const state = applyEvents(initial, [{
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
    }]);

    const rendered = renderSessionHeader(state, { columns: 80, color: false });

    assert.match(rendered, /^╭─ EASY CODE /u);
    assert.match(rendered, /auto · DeepSeek\/v4-pro · thinking:medium/u);
    assert.match(rendered, /context:82\.4k\/128k/u);
    assert.match(rendered, /课程系统 password=\[REDACTED\]/u);
    assert.match(rendered, /thread: 8f72a1/u);
    assert.equal(rendered.includes("\u001B"), false);
    assertBoundedLines(rendered, 80);
  });

  it("keeps one stable session title and renders unrestricted mode in the live footer", () => {
    const state = applyEvents(createUIState(), [{
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
    }]);

    const header = renderSessionHeader(state, { columns: 80, color: true });
    const footer = renderComposerFooter(state, { columns: 80, color: true });
    assert.match(stripAnsi(header), /^╭─ EASY CODE /u);
    assert.doesNotMatch(stripAnsi(header), /Unrestricted command execution/u);
    assert.match(stripAnsi(footer), /^! EASY CODE DANGER: FULL ACCESS  code/u);
    assert.doesNotMatch(header, /\u001B\[31m/u);
    assert.match(footer, /\u001B\[31m/u);
  });

  it("keeps the red full-access warning visible while a modal overlay is open", () => {
    let state = applyEvents(createUIState(), [{
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
    }]);
    state = applyEvent(state, {
      type: "overlay.show",
      overlay: {
        id: "danger-model-picker",
        kind: "picker",
        title: "Select model",
        rows: [{ id: "one", label: "One" }],
        selectedIndex: 0,
        hint: "Enter confirm",
      },
    });

    const rendered = renderLiveRegion(state, 0, { columns: 100, color: true });
    assert.match(stripAnsi(rendered), /Select model/u);
    assert.match(stripAnsi(rendered), /! EASY CODE DANGER: FULL COMPUTER ACCESS/u);
    assert.match(rendered, /\u001B\[31m/u);
  });

  it("renders compact progress, task, agent, activity, busy composer, and footer", () => {
    const state = populatedState();
    const options = {
      columns: 72,
      color: false,
      spinnerFrame: "⠹",
    } as const;
    const rendered = renderLiveRegion(state, 15_000, options);

    assert.match(rendered, /Progress/u);
    assert.match(rendered, /Tasks 2\/7/u);
    assert.match(rendered, /✓ 1\. Task 1/u);
    assert.match(rendered, /▶ 2\. 实现后端认证/u);
    assert.equal(rendered.includes("Task 6"), false);
    assert.match(rendered, /Agents 2\/4/u);
    assert.match(rendered, /● agent-1  Implement authentication API/u);
    assert.equal(rendered.includes("agent-6"), false);
    assert.match(rendered, /> Working…/u);
    assert.match(rendered, /⠹ Waiting for deepseek-v4-pro · 14s/u);
    assert.match(rendered, /auto  deepseek\/v4-pro/u);
    const blocks = rendered.split("\n\n");
    assert.equal(blocks.length, 5);
    assert.match(blocks[0] ?? "", /^Progress/u);
    assert.match(blocks[0] ?? "", /Read static\/index\.html/u);
    assert.match(blocks[1] ?? "", /^╭─/u);
    assert.match(blocks[1] ?? "", /> Working…/u);
    assert.match(blocks[2] ?? "", /^Tasks 2\/7/u);
    assert.match(blocks[3] ?? "", /^Agents 2\/4/u);
    assert.match(blocks[4] ?? "", /^⠹ Waiting/u);
    assert.doesNotMatch(blocks[0] ?? "", /Tasks/u);
    assert.doesNotMatch(blocks[2] ?? "", /Reading workspace/u);

    assert.equal(
      renderLiveActivityRegion(state, 15_000, options),
      blocks[0],
    );
    assert.equal(
      renderComposerStatusRegion(state, options, 15_000),
      blocks.slice(2).join("\n\n"),
    );
    assertBoundedLines(rendered, 72);
  });

  it("keeps tool activity animation and elapsed time in the footer", () => {
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
    const footer = renderComposerFooter(state, {
      columns: 72,
      color: false,
      spinnerFrame: "⠴",
    }, 65_000);
    const narrowFooter = renderComposerFooter(state, {
      columns: 32,
      color: false,
      spinnerFrame: "⠴",
    }, 65_000);

    assert.doesNotMatch(upper, /Running Tool|1m 04s/u);
    assert.match(footer, /^⠴ Running Tool: run_command · 1m 04s/u);
    assert.match(narrowFooter, /^⠴ .* · 1m 04s$/u);
    assertBoundedLines(footer, 72);
    assertBoundedLines(narrowFooter, 32);
  });

  it("gives a safe boxed overlay exclusive priority over live status", () => {
    const state = applyEvents(populatedState(), [{
      type: "overlay.show",
      overlay: {
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
      },
    }]);

    const rendered = renderLiveRegion(state, 15_000, {
      columns: 54,
      color: false,
    });

    assert.match(rendered, /^╭─ Select model /u);
    assert.match(rendered, /api_key=\[REDACTED\]/u);
    assert.match(rendered, /› deepseek-v4-pro · Recommended/u);
    assert.match(rendered, /badsafe/u);
    assert.equal(rendered.includes("Tasks"), false);
    assert.equal(rendered.includes("Working"), false);
    assert.equal(rendered.includes("\u001B"), false);
    assertBoundedLines(rendered, 54);

    const colored = renderLiveRegion(state, 15_000, {
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
    const first = applyEvent(createUIState(), {
      type: "overlay.show",
      overlay: { ...base, selectedIndex: 0 },
    });
    const second = applyEvent(createUIState(), {
      type: "overlay.show",
      overlay: { ...base, selectedIndex: 1 },
    });

    const firstRendered = stripAnsi(renderLiveRegion(first, 0, {
      columns: 100,
      rows: 5,
      color: false,
    }));
    const secondRendered = stripAnsi(renderLiveRegion(second, 0, {
      columns: 100,
      rows: 5,
      color: false,
    }));

    assert.equal(firstRendered.split("\n").length, 5);
    assert.equal(secondRendered.split("\n").length, 5);
    assert.match(firstRendered, /› Yes, allow execute one time/u);
    assert.match(secondRendered, /› Yes, don't ask me again/u);
    assert.notEqual(firstRendered, secondRendered);

    const fourRows = stripAnsi(renderLiveRegion(first, 0, {
      columns: 100,
      rows: 4,
      color: false,
    }));
    assert.match(fourRows, /Command: node --check src\/app\.js/u);
    assert.match(fourRows, /› Yes, allow execute one time/u);

    const threeRows = stripAnsi(renderLiveRegion(first, 0, {
      columns: 100,
      rows: 3,
      color: false,
    }));
    assert.match(threeRows, /Approval disabled: enlarge the terminal/u);
    assert.doesNotMatch(threeRows, /Yes, allow execute/u);
  });

  it("renders a gray inline Thinking item while keeping generic live views separate", () => {
    const secret = "abcdefghijklmnopqrstuvwxyz";
    const state = applyEvents(populatedState(), [{
      type: "thinking.toggle",
      panel: {
        id: 4,
        body:
          "Inspect the repository before editing.\n" +
          `api_key=abcde\u001B[31mfghijklmnopqrstuvwxyz\n` +
          "Reuse the existing task types.\n" +
          Array.from({ length: 8 }, (_, index) => `reasoning line ${index}`).join("\n"),
      },
    }]);
    const rendered = renderLiveRegion(state, 15_000, {
      columns: 72,
      color: false,
      spinnerFrame: "⠹",
      maxThinkingRows: 3,
    });

    assert.equal(rendered.includes("Thinking #4"), false);
    assert.ok(rendered.indexOf("Progress") < rendered.indexOf("> Working…"));
    assert.ok(rendered.indexOf("> Working…") < rendered.indexOf("Tasks 2/7"));
    assert.ok(rendered.indexOf("Tasks 2/7") < rendered.indexOf("Agents 2/4"));
    assert.ok(rendered.indexOf("Agents 2/4") < rendered.indexOf("Waiting for deepseek-v4-pro"));
    assert.ok(rendered.indexOf("Waiting for deepseek-v4-pro") < rendered.lastIndexOf("auto  deepseek"));
    assertBoundedLines(rendered, 72);

    const activeComposerState = applyEvents(state, [{
      type: "composer.patch",
      patch: { busy: false },
    }]);
    const activeUpper = renderLiveActivityRegion(activeComposerState, 15_000, {
      columns: 72,
      color: false,
      spinnerFrame: "⠹",
    });
    assert.match(activeUpper, /^Progress/u);
    assert.doesNotMatch(activeUpper, /Waiting for deepseek-v4-pro/u);
    assert.equal(activeUpper.includes("Thinking #4"), false);

    const panel = state.live.thinking;
    if (!panel) throw new Error("Expected an expanded Thinking panel");
    const plainPanel = renderThinkingPanel(panel, {
      columns: 72,
      color: false,
      maxThinkingRows: 3,
    });
    const coloredPanel = renderThinkingPanel(panel, {
      columns: 72,
      color: true,
      maxThinkingRows: 3,
    });
    assert.match(plainPanel, /^↕ Thinking #4 · \/thinking 4/u);
    assert.match(plainPanel, /Inspect the repository before editing\./u);
    assert.match(plainPanel, /api_key=\[REDACTED\]/u);
    assert.doesNotMatch(plainPanel, new RegExp(secret, "u"));
    assert.match(plainPanel, /\/thinking 4 shows all retained content\./u);
    assert.match(plainPanel, /VS Code Ctrl\/Cmd\+click to toggle/u);
    assert.equal(plainPanel.includes("reasoning line 7"), false);
    assert.match(coloredPanel, /\u001B\[90m/u);
    assert.doesNotMatch(coloredPanel, /\u001B\[36m/u);
    assert.equal(stripAnsi(coloredPanel), plainPanel);

    const withOverlay = applyEvents(state, [{
      type: "overlay.show",
      overlay: {
        id: "thinking-priority",
        kind: "picker",
        title: "Choose another block",
        rows: [{ id: "one", label: "Thinking #1" }],
        selectedIndex: 0,
        hint: "Enter confirm",
      },
    }]);
    const modal = renderLiveRegion(withOverlay, 15_000, {
      columns: 72,
      color: false,
    });
    assert.match(modal, /^╭─ Choose another block/u);
    assert.equal(modal.includes("Ctrl/Cmd+click the Thinking label to close"), false);
    assert.equal(modal.includes("Working…"), false);
  });

  it("keeps composer and footer useful in a narrow terminal", () => {
    const state = applyEvents(populatedState(), [
      { type: "activity.stop", id: "model" },
      {
        type: "composer.patch",
        patch: {
          busy: false,
          text: "添加登录\nsecond line\u001B[2J",
          images: [{
            id: "image",
            label: "Image #1 token=ghp_abcdefghijklmnopqrstuvwxyz",
            mediaType: "image/png",
            storageKey: "image.png",
            sha256: "0".repeat(64),
            byteSize: 1,
            width: 1,
            height: 1,
          }],
        },
      },
    ]);

    const prompt = renderComposerPrompt(state, { columns: 24, color: false });
    const footer = renderComposerFooter(state, { columns: 24, color: false });

    assert.match(prompt, /> 添加登录/u);
    assert.match(prompt.replace(/[\s│]/gu, ""), /\[REDACTEDTOKEN\]/u);
    assert.equal(prompt.includes("\u001B"), false);
    assertBoundedLines(prompt, 24);
    assertBoundedLines(footer, 24);
    assert.match(footer, /^auto  deepseek\/v4-pro/u);
  });
});
