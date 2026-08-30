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
import { applyEvents, createUIState } from "../src/ui/store.js";
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
    assert.match(rendered, /⠹ Waiting for deepseek-v4-pro · 14s/u);
    assert.match(rendered, /> Working…/u);
    assert.match(
      rendered,
      /auto  deepseek\/v4-pro  medium  ctx 82\.4k  task 2\/7  agents 2/u,
    );
    const blocks = rendered.split("\n\n");
    assert.equal(blocks.length, 6);
    assert.match(blocks[0] ?? "", /^Progress/u);
    assert.match(blocks[0] ?? "", /Read static\/index\.html/u);
    assert.match(blocks[1] ?? "", /^⠹ Waiting/u);
    assert.match(blocks[2] ?? "", /^╭─/u);
    assert.match(blocks[2] ?? "", /> Working…/u);
    assert.match(blocks[3] ?? "", /^Tasks 2\/7/u);
    assert.match(blocks[4] ?? "", /^Agents 2\/4/u);
    assert.match(blocks[5] ?? "", /^auto  deepseek/u);
    assert.doesNotMatch(blocks[0] ?? "", /Tasks/u);
    assert.doesNotMatch(blocks[3] ?? "", /Reading workspace/u);

    assert.equal(
      renderLiveActivityRegion(state, 15_000, options),
      blocks.slice(0, 2).join("\n\n"),
    );
    assert.equal(
      renderComposerStatusRegion(state, options),
      blocks.slice(3).join("\n\n"),
    );
    assertBoundedLines(rendered, 72);
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

  it("renders one gray Thinking panel with an exact toggle control and modal priority", () => {
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

    assert.match(rendered, /╭─ Thinking #4/u);
    assert.match(rendered, /Inspect the repository before editing\./u);
    assert.match(rendered, /api_key=\[REDACTED\]/u);
    assert.doesNotMatch(rendered, new RegExp(secret, "u"));
    assert.equal(rendered.includes("\u001B"), false);
    assert.match(
      rendered,
      /↕ Thinking #4 · Ctrl\/Cmd\+click to close · \/thinking 4/u,
    );
    assert.equal(rendered.includes("reasoning line 7"), false);
    assert.ok(rendered.indexOf("Waiting for deepseek-v4-pro") < rendered.indexOf("Thinking #4"));
    assert.ok(rendered.indexOf("Thinking #4") < rendered.indexOf("> Working…"));
    assert.ok(rendered.indexOf("> Working…") < rendered.indexOf("Tasks 2/7"));
    assert.ok(rendered.indexOf("Tasks 2/7") < rendered.indexOf("Agents 2/4"));
    assert.ok(rendered.indexOf("Agents 2/4") < rendered.lastIndexOf("auto  deepseek"));
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
    assert.match(activeUpper, /Waiting for deepseek-v4-pro/u);
    assert.equal(activeUpper.includes("Thinking #4"), false);

    const panel = state.live.thinking;
    if (!panel) throw new Error("Expected an expanded Thinking panel");
    const plainPanel = renderThinkingPanel(panel, { columns: 72, color: false });
    const coloredPanel = renderThinkingPanel(panel, { columns: 72, color: true });
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
    assert.equal(modal.includes("Ctrl/Cmd+click to close"), false);
    assert.equal(modal.includes("Working…"), false);
  });

  it("keeps composer and footer useful in a narrow terminal", () => {
    const state = applyEvents(populatedState(), [{
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
    }]);

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
