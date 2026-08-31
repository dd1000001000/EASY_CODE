import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { Terminal } from "../src/cli/terminal.js";
import {
  VSCODE_IMAGE_PASTE_SEQUENCE,
  vscodeToggleThinkingSequence,
} from "../src/cli/prompt-input.js";
import type { ApprovalRequest, ImageAttachment } from "../src/core/types.js";
import type { SubagentView } from "../src/subagents/types.js";
import type { TaskGraphView } from "../src/tasks/task-graph.js";
import type { UISessionInfo, UIState } from "../src/ui/contracts.js";
import { stripAnsi } from "../src/ui/render/layout.js";
import { renderSessionHeader } from "../src/ui/render/view.js";
import { describe, it } from "./harness.js";

const CREATED_AT = "2026-08-29T00:00:00.000Z";

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawModeTransitions: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModeTransitions.push(mode);
    return this;
  }
}

class TtyInputWithoutRawMode extends PassThrough {
  readonly isTTY = true;
}

class TtyOutput extends PassThrough {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
}

function captureOutput(output: PassThrough): () => string {
  let transcript = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    transcript += chunk;
  });
  return () => transcript;
}

function lastCursorVisibility(value: string): "shown" | "hidden" | undefined {
  const matches = [...value.matchAll(/\u001B\[\?25([hl])/gu)];
  const final = matches.at(-1)?.[1];
  return final === "h" ? "shown" : final === "l" ? "hidden" : undefined;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withInteractiveEnvironment<T>(run: () => Promise<T> | T): Promise<T> {
  const previousCI = process.env.CI;
  const previousTerm = process.env.TERM;
  const previousNoColor = process.env.NO_COLOR;
  const previousForceColor = process.env.FORCE_COLOR;
  process.env.CI = "";
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  try {
    return await run();
  } finally {
    restoreEnvironment("CI", previousCI);
    restoreEnvironment("TERM", previousTerm);
    restoreEnvironment("NO_COLOR", previousNoColor);
    restoreEnvironment("FORCE_COLOR", previousForceColor);
  }
}

function session(overrides: Partial<UISessionInfo> = {}): UISessionInfo {
  return {
    threadId: "thread_inline_ui",
    workspaceRoot: "F:\\projects\\course-system",
    mode: "auto",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    thinkingEffort: "medium",
    contextTokens: 82_400,
    ...overrides,
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
    completionChecks: ["Verified"],
    failureHandling: "Report a blocker",
  };
  return {
    id: "task_graph_inline_ui",
    goal: "Add authentication",
    status: "active",
    currentTask: "backend",
    startableTasks: [],
    completed: 1,
    total: 3,
    tasks: [
      { ...common, id: "inspect", title: "Inspect auth flow", status: "completed" },
      { ...common, id: "backend", title: "Implement backend", status: "in_progress" },
      { ...common, id: "frontend", title: "Connect frontend", status: "pending" },
    ],
  };
}

function agent(): SubagentView {
  return {
    id: "backend-auth",
    childThreadId: "thread_backend_auth",
    environmentId: "environment_backend_auth",
    assignmentKind: "dag",
    taskGraphId: "task_graph_inline_ui",
    taskId: "backend",
    taskTitle: "Implement authentication API",
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

function terminalState(terminal: Terminal): Readonly<UIState> {
  return (terminal as unknown as { readonly uiState: UIState }).uiState;
}

interface DisclosureFrameProbe {
  columns: number;
  viewport: Readonly<{
    transcriptStartRow: number;
    targetTitleScreenRow?: number;
    scrollOffset: number;
    viewportRows: number;
    totalDocumentRows: number;
    atStart: boolean;
    atEnd: boolean;
  }>;
  visibleRows: readonly Readonly<{
    screenRow: number;
    region: "header" | "transcript" | "composer" | "footer";
    part: string;
    text: string;
  }>[];
}

interface DisclosureNodeProbe {
  readonly id: string;
  readonly kind: "text" | "thinking" | "adjustment";
  readonly text?: string;
  readonly title?: string;
  readonly preview?: string;
  readonly body?: string;
  readonly expanded?: boolean;
}

function disclosureFrame(terminal: Terminal): Readonly<DisclosureFrameProbe> | undefined {
  return (terminal as unknown as {
    readonly disclosureViewer?: {
      readonly frame: Readonly<DisclosureFrameProbe>;
    };
  }).disclosureViewer?.frame;
}

function disclosureNodes(
  terminal: Terminal,
): readonly Readonly<DisclosureNodeProbe>[] {
  return (terminal as unknown as {
    readonly disclosureViewer?: {
      readonly state: {
        readonly nodes: readonly Readonly<DisclosureNodeProbe>[];
      };
    };
  }).disclosureViewer?.state.nodes ?? [];
}

function disclosureNodeText(node: Readonly<DisclosureNodeProbe>): string {
  if (node.kind === "text") return stripAnsi(node.text ?? "");
  return stripAnsi([
    node.title ?? "",
    node.expanded ? node.body ?? "" : node.preview ?? "",
  ].join("\n"));
}

function disclosureRegionText(
  terminal: Terminal,
  region?: DisclosureFrameProbe["visibleRows"][number]["region"],
): string {
  const frame = disclosureFrame(terminal);
  assert.ok(frame, "the persistent conversation frame must be active");
  return stripAnsi(frame.visibleRows
    .filter((row) => region === undefined || row.region === region)
    .map((row) => row.text)
    .join("\n"));
}

function disclosureNode(
  terminal: Terminal,
  id: string,
): Readonly<DisclosureNodeProbe> {
  const virtualId = id.replace(/^thinking_/u, "thinking:")
    .replace(/^adjustment_/u, "adjustment:");
  const node = disclosureNodes(terminal).find((candidate) =>
    candidate.id === id || candidate.id === virtualId
  );
  assert.ok(node, `expected disclosure node ${id}`);
  return node;
}

function assertPersistentFrame(
  terminal: Terminal,
  output: Readonly<Pick<TtyOutput, "columns" | "rows">>,
): Readonly<DisclosureFrameProbe> {
  const frame = disclosureFrame(terminal);
  assert.ok(frame, "the persistent conversation frame must be active");
  assert.equal(frame.columns, output.columns - 1);
  assert.equal(frame.visibleRows.length, output.rows);
  assert.deepEqual(
    frame.visibleRows.map((row) => row.screenRow),
    Array.from({ length: output.rows }, (_, index) => index),
  );
  return frame;
}

function steeringAttachment(index: number): ImageAttachment {
  return {
    id: `image_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    label: `Image #${index}`,
    mediaType: "image/png",
    storageKey: `attachments/test/steering-${index}.png`,
    sha256: String(index % 10).repeat(64),
    byteSize: 68,
    width: 1,
    height: 1,
  };
}

async function settlePromptInput(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Terminal retained inline shell", () => {
  it("enables only for a usable interactive TTY and remains safe across retries", async () => {
    await withInteractiveEnvironment(() => {
      const plain = new Terminal(new PassThrough(), new PassThrough());
      assert.equal(plain.beginShell(session()), false);
      assert.equal(plain.isInlineShell(), false);
      plain.close();

      const noRawMode = new Terminal(new TtyInputWithoutRawMode(), new TtyOutput());
      assert.equal(noRawMode.beginShell(session()), false);
      noRawMode.close();

      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const gated = new Terminal(input, output);
      process.env.CI = "true";
      assert.equal(gated.beginShell(session()), false);
      process.env.CI = "";
      process.env.TERM = "dumb";
      assert.equal(gated.beginShell(session()), false);
      process.env.TERM = "xterm-256color";
      assert.equal(gated.beginShell(session()), true);
      assert.equal(gated.beginShell(session({ model: "deepseek-v4-flash" })), true);
      assert.equal(terminalState(gated).header.session?.model, "deepseek-v4-flash");
      gated.close();
      assert.equal(gated.isInlineShell(), false);
      assert.equal(gated.beginShell(session()), false);

      const endedOutput = new TtyOutput();
      endedOutput.resume();
      endedOutput.end();
      const ended = new Terminal(new TtyInput(), endedOutput);
      assert.equal(endedOutput.writableEnded, true);
      assert.equal(ended.beginShell(session()), false);
      ended.close();
    });
  });

  it("resets the retained conversation and redraws only the new Thread", async () => {
    await withInteractiveEnvironment(() => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.write("old conversation\n");
        terminal.setCurrentRequest("Old request");
        terminal.status("Step 1/3: requesting deepseek-v4-pro");
        terminal.taskGraph(graph());
        terminal.subagents([agent()], graph(), 4);
        const reasoningId = terminal.addReasoning("Old private reasoning.");
        assert.equal(terminal.toggleReasoning(reasoningId), true);

        const resetOffset = captured().length;
        const next = session({ threadId: "thread_new_inline_ui" });
        terminal.resetForNewThread(next);
        const state = terminalState(terminal);
        assert.equal(state.header.session?.threadId, "thread_new_inline_ui");
        assert.deepEqual(state.transcript, []);
        assert.equal(state.live.activity, null);
        assert.deepEqual(state.live.progress, []);
        assert.equal(state.live.thinking, null);
        assert.equal(state.live.tasks, null);
        assert.deepEqual(state.live.subagents, []);
        assert.equal(state.overlay, null);
        assert.equal(state.composer.busy, false);

        const resetOutput = stripAnsi(captured().slice(resetOffset));
        assert.match(captured().slice(resetOffset), /\u001Bc/u);
        assert.match(resetOutput, /thread: thread_new_inline_ui/u);
        assert.equal(resetOutput.includes("old conversation"), false);

        terminal.success("Created thread thread_new_inline_ui");
        assert.deepEqual(
          terminalState(terminal).transcript.map((entry) => entry.kind),
          ["raw"],
        );
      } finally {
        terminal.close();
      }
    });
  });

  it("renders the session header and keeps activity, task DAG, and subagents live", async () => {
    await withInteractiveEnvironment(() => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.showSessionHeader();
        terminal.setCurrentRequest("Add login and registration");
        terminal.status("Step 1/3: requesting deepseek-v4-pro");
        terminal.taskGraph(graph());
        terminal.subagents([agent()], graph(), 4);
        terminal.startActivity("Waiting for deepseek-v4-pro");

        const state = terminalState(terminal);
        assert.equal(state.header.session?.threadId, "thread_inline_ui");
        assert.equal(state.live.activity?.label, "Waiting for deepseek-v4-pro");
        assert.equal(state.live.progress[0]?.kind, "step");
        assert.equal(state.live.tasks?.id, "task_graph_inline_ui");
        assert.equal(state.live.subagents[0]?.id, "backend-auth");
        assert.equal(state.composer.busy, true);

        const frame = assertPersistentFrame(terminal, output);
        const rendered = disclosureRegionText(terminal);
        assert.match(rendered, /EASY CODE/u);
        assert.match(rendered, /DeepSeek\/v4-pro/u);
        assert.match(rendered, /Tasks 2\/3/u);
        assert.match(rendered, /Implement backend/u);
        assert.match(rendered, /Agents 1\/4/u);
        assert.match(rendered, /backend-auth/u);
        assert.match(rendered, /Waiting for deepseek-v4-pro/u);

        const firstRegionRows = new Map<
          DisclosureFrameProbe["visibleRows"][number]["region"],
          number
        >();
        for (const row of frame.visibleRows) {
          if (!firstRegionRows.has(row.region)) {
            firstRegionRows.set(row.region, row.screenRow);
          }
        }
        assert.ok((firstRegionRows.get("header") ?? -1) === 0);
        assert.ok(
          (firstRegionRows.get("header") ?? -1) <
            (firstRegionRows.get("transcript") ?? -1),
        );
        assert.ok(
          (firstRegionRows.get("transcript") ?? -1) <
            (firstRegionRows.get("composer") ?? -1),
        );
        assert.ok(
          (firstRegionRows.get("composer") ?? -1) <
            (firstRegionRows.get("footer") ?? -1),
        );

        const composer = disclosureRegionText(terminal, "composer");
        assert.ok(composer.indexOf("Progress") < composer.indexOf("Working on:"));
        const footer = disclosureRegionText(terminal, "footer");
        const statusOffset = footer.indexOf("auto  deepseek/v4-pro");
        const tasksOffset = footer.indexOf("Tasks 2/3");
        const agentsOffset = footer.indexOf("Agents 1/4");
        assert.ok(statusOffset >= 0);
        assert.ok(statusOffset < tasksOffset);
        assert.ok(tasksOffset < agentsOffset);
      } finally {
        terminal.stopActivity();
        terminal.close();
      }
    });
  });

  it("uses activity tokens and clears requesting progress only when model activity ends", async () => {
    await withInteractiveEnvironment(() => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Run and verify the command");
        terminal.status("Step 4/12: requesting deepseek-v4-pro");

        const modelActivity = terminal.startActivity(
          "Waiting for deepseek-v4-pro response",
          "model",
        );
        assert.equal(typeof modelActivity, "string");
        assert.equal(terminalState(terminal).live.progress[0]?.kind, "step");

        terminal.stopActivity(modelActivity);
        assert.equal(terminalState(terminal).live.activity, null);
        assert.equal(
          terminalState(terminal).live.progress.some((item) => item.kind === "step"),
          false,
        );

        const toolActivity = terminal.startActivity(
          "Running Tool: run_command",
          "tool",
        );
        assert.equal(terminalState(terminal).live.activity?.kind, "tool");
        terminal.stopActivity(modelActivity);
        assert.equal(terminalState(terminal).live.activity?.id, toolActivity);
        terminal.stopActivity(toolActivity);
        assert.equal(terminalState(terminal).live.activity, null);
      } finally {
        terminal.close();
      }
    });
  });

  it("updates command posture in the live footer without appending another session title", async () => {
    await withInteractiveEnvironment(() => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.showSessionHeader();

        const dangerOffset = captured().length;
        terminal.setSessionInfo(session({ commandExecutionMode: "unrestricted" }));
        const dangerFrame = stripAnsi(captured().slice(dangerOffset));
        assert.match(dangerFrame, /! EASY CODE DANGER: FULL ACCESS/u);

        const safeOffset = captured().length;
        terminal.setSessionInfo(session({ commandExecutionMode: "auto_approve" }));
        const safeFrame = stripAnsi(captured().slice(safeOffset));
        assert.doesNotMatch(safeFrame, /! EASY CODE DANGER/u);
        assert.equal(
          (stripAnsi(captured()).match(/╭─ EASY CODE /gu) ?? []).length,
          1,
        );
      } finally {
        terminal.close();
      }
    });
  });

  it("uses the retained generic picker for selectChoice and clears it afterward", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        const selection = terminal.selectChoice("Resume a task", [
          { id: "first", label: "First task" },
          { id: "second", label: "Second task", detail: "Recommended" },
          { id: "third", label: "Third task" },
        ], "second");

        const overlay = terminalState(terminal).overlay;
        assert.equal(overlay?.kind, "picker");
        assert.equal(overlay?.title, "Resume a task");
        assert.equal(overlay?.selectedIndex, 1);
        assert.equal(overlay?.rows.length, 3);
        assert.deepEqual(terminalState(terminal).transcript, []);

        input.write("\u001B[B\r");
        assert.equal(await selection, "third");
        assert.equal(terminalState(terminal).overlay, null);
        assert.deepEqual(terminalState(terminal).transcript, []);
        // The outer modal owner enters Raw Mode, then the selector reasserts
        // it once to repair possible Windows ConPTY cooked-mode drift before
        // accepting the first arrow key.
        assert.deepEqual(input.rawModeTransitions, [true, true, false]);
      } finally {
        terminal.close();
      }
    });
  });

  it("keeps only running progress live and commits each tool completion once", async () => {
    await withInteractiveEnvironment(() => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.status("Step 1/2: requesting deepseek-v4-pro");
        terminal.status("Step 2/2: requesting deepseek-v4-pro");
        assert.deepEqual(
          terminalState(terminal).live.progress.map((item) => [item.kind, item.label]),
          [["step", "Step 2/2: requesting deepseek-v4-pro"]],
        );

        terminal.status("Tool: stale_probe");
        terminal.status("Tool: read_file");
        assert.equal(
          terminalState(terminal).live.progress.filter((item) => item.kind === "tool").length,
          1,
        );
        assert.equal(
          terminalState(terminal).live.progress.find((item) => item.kind === "tool")?.label,
          "Tool: read_file",
        );
        assert.equal(terminalState(terminal).transcript.length, 0);

        terminal.toolCompleted("read_file", true, "Read static/index.html");
        assert.equal(
          terminalState(terminal).live.progress.some((item) => item.kind === "tool"),
          false,
        );
        terminal.status(
          "Context utilization is 90%; compact_context is required before other work.",
        );
        terminal.write("Authentication flow inspected.\n");
        terminal.status("Step 3/3: requesting deepseek-v4-pro");
        terminal.taskGraph(graph());
        terminal.setSessionInfo(session({ contextTokens: 84_000 }));

        const runningProgress = terminalState(terminal).live.progress;
        assert.deepEqual(
          runningProgress.map((item) => [item.kind, item.status, item.label]),
          [["step", "running", "Step 3/3: requesting deepseek-v4-pro"]],
        );

        const transcript = terminalState(terminal).transcript;
        assert.deepEqual(
          transcript.map((entry) => entry.kind),
          ["tool", "warning", "raw"],
        );
        assert.match(transcript[0]?.text ?? "", /✓ Tool: read_file/u);
        assert.match(transcript[1]?.text ?? "", /Context utilization is 90%/u);
        assert.equal(transcript[2]?.text, "Authentication flow inspected.\n");
        assert.equal(
          transcript.filter((entry) => entry.kind === "tool").length,
          1,
        );
        assert.match(stripAnsi(captured()), /✓ Tool: read_file/u);

        terminal.clearCurrentRequest();
        assert.deepEqual(terminalState(terminal).live.progress, []);
      } finally {
        terminal.close();
      }
    });
  });

  it("keeps the boxed composer and footer live throughout active readline input", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.columns = 32;
      const captured = captureOutput(output);
        const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        const promptStartupOffset = captured().length;
        const rawTransitionsBeforePrompt = input.rawModeTransitions.length;
        const prompt = terminal.readPrompt("> ", {
          captureImage: async (index) => ({
            id: `image_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            label: `Image #${index}`,
            mediaType: "image/png",
            storageKey: `attachments/test/image-${index}.png`,
            sha256: String(index).repeat(64).slice(0, 64),
            byteSize: 68,
            width: 1,
            height: 1,
          }),
        });

        const promptStartup = captured().slice(promptStartupOffset);
        const alternateScreenOffset = promptStartup.indexOf("\u001B[?1049h");
        assert.ok(alternateScreenOffset >= 0);
        assert.equal(
          promptStartup.slice(0, alternateScreenOffset).includes("\u001B[?2004h"),
          false,
          "readPrompt must not enable terminal modes before the persistent writer",
        );
        assert.equal(
          stripAnsi(promptStartup.slice(0, alternateScreenOffset)).includes("╭─ Request"),
          false,
          "readPrompt must not paint a transient inline prompt before the fixed frame",
        );
        assert.deepEqual(
          input.rawModeTransitions.slice(rawTransitionsBeforePrompt),
          [true],
          "the persistent writer must be the first and only startup input owner",
        );

        const initial = disclosureRegionText(terminal);
        assert.match(initial, /╭─ Request /u);
        assert.match(initial, /╰─+╯\r?\nauto\s+deepseek\/v4-pro/u);

        const liveOnlyOffset = captured().length;
        terminal.status("Tool: read_file");
        terminal.taskGraph(graph());
        terminal.subagents([agent()], graph(), 4);
        terminal.startActivity("Waiting for deepseek-v4-pro");

        const activeState = terminalState(terminal);
        assert.equal(activeState.live.progress.at(-1)?.label, "Tool: read_file");
        assert.equal(activeState.live.activity?.label, "Waiting for deepseek-v4-pro");
        assert.ok(captured().length > liveOnlyOffset);
        assertPersistentFrame(terminal, output);
        const activeComposer = disclosureRegionText(terminal, "composer");
        assert.match(activeComposer, /Progress[\s\S]*Tool: read_file/u);
        assert.match(activeComposer, /╭─ Request/u);
        const activeFooter = disclosureRegionText(terminal, "footer");
        const tasksOffset = activeFooter.indexOf("Tasks 2/3");
        const agentsOffset = activeFooter.indexOf("Agents 1/4");
        const metadataOffset = activeFooter.indexOf("auto");
        assert.ok(metadataOffset >= 0 && metadataOffset < tasksOffset);
        assert.ok(tasksOffset < agentsOffset);
        terminal.stopActivity();

        input.write("A request long enough to wrap across several terminal rows");
        await new Promise<void>((resolve) => setImmediate(resolve));
        terminal.status(
          "Model usage accounting could not be saved: temporary database issue",
        );
        assert.equal(
          terminalState(terminal).transcript.some((entry) =>
            entry.kind === "warning" &&
            entry.text.includes("Model usage accounting could not be saved")
          ),
          true,
        );
        assert.match(disclosureRegionText(terminal, "composer"), /╭─ Request/u);
        const afterStatusFooter = disclosureRegionText(terminal, "footer");
        assert.ok(
          afterStatusFooter.indexOf("auto  deepseek/v4-pro") <
            afterStatusFooter.indexOf("Tasks 2/3"),
        );
        assert.ok(
          afterStatusFooter.indexOf("Tasks 2/3") <
            afterStatusFooter.indexOf("Agents 1/4"),
        );

        output.columns = 44;
        output.emit("resize");
        const resized = assertPersistentFrame(terminal, output);
        assert.equal(
          resized.visibleRows.every((row) => stripAnsi(row.text).length <= 43),
          true,
        );

        // Shrinking height must atomically compact the old Tasks/Agents
        // footer instead of validating it against the smaller frame first.
        output.rows = 9;
        output.emit("resize");
        const compactHeight = assertPersistentFrame(terminal, output);
        assert.equal(compactHeight.viewport.viewportRows >= 1, true);
        assert.match(disclosureRegionText(terminal, "footer"), /auto/u);

        input.write(Buffer.from([0x16, 0x0d]));
        const result = await prompt;
        assert.match(result?.text ?? "", /\[Image #1\]/u);
        assert.deepEqual(result?.images.map((image) => image.label), ["Image #1"]);

        const transcript = terminalState(terminal).transcript;
        assert.deepEqual(transcript.map((entry) => entry.kind), ["warning", "user"]);
        assert.equal(
          transcript.some((entry) =>
            /deepseek\/v4-pro|ctx 82\.4k/u.test(stripAnsi(entry.text))),
          false,
        );
        // The real shell immediately promotes a submitted idle draft into the
        // busy model turn; verify that transition remounts the same fixed UI.
        terminal.setCurrentRequest(result?.text ?? "", result?.images ?? []);
        assertPersistentFrame(terminal, output);
        assert.equal(lastCursorVisibility(captured()), "hidden");
        terminal.clearCurrentRequest();
      } finally {
        terminal.close();
      }
    });
  });

  it("replaces a submitted Request card with one plain transcript entry", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.columns = 48;
      output.resume();
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        const prompt = terminal.readPrompt("> ", {
          captureImage: async () => {
            throw new Error("not used");
          },
        });

        input.write("\u001B[200~first line\nsecond line\u001B[201~\r");
        assert.equal((await prompt)?.text, "first line\nsecond line");

        const submittedUsers = terminalState(terminal).transcript.filter(
          (entry) => entry.kind === "user",
        );
        assert.equal(submittedUsers.length, 1);
        assert.match(submittedUsers[0]?.text ?? "", /first line/u);
        assert.match(submittedUsers[0]?.text ?? "", /second line/u);
        assert.match(
          disclosureNodes(terminal).map(disclosureNodeText).join("\n"),
          /> first line[\s\S]*second line/u,
        );

        terminal.setCurrentRequest("Process the pasted request");
        assert.equal(
          terminalState(terminal).transcript.filter((entry) =>
            entry.kind === "user" && /first line[\s\S]*second line/u.test(entry.text)
          ).length,
          1,
        );
        assert.match(
          disclosureRegionText(terminal, "composer"),
          /Working on: Process the pasted request/u,
        );
        terminal.clearCurrentRequest();
      } finally {
        terminal.close();
      }
    });
  });

  it("toggles fragmented Thinking controls immediately while a request is busy", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      const initialDataListeners = input.listenerCount("data");
      let interrupts = 0;
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Implement authentication", [], {
          onInterrupt: () => {
            interrupts += 1;
          },
        });
        assert.equal(input.isRaw, true);
        assert.equal(input.listenerCount("data"), initialDataListeners + 1);

        // Replacing a busy request must replace, not stack, its stdin owner.
        terminal.setCurrentRequest("Implement authentication safely", [], {
          onInterrupt: () => {
            interrupts += 1;
          },
        });
        assert.equal(input.listenerCount("data"), initialDataListeners + 1);

        const firstId = terminal.addReasoning("Inspect the authentication routes.");
        const secondId = terminal.addReasoning("Verify the registration form.");
        const sequence = Buffer.from(vscodeToggleThinkingSequence(firstId));
        input.write(sequence.subarray(0, 8));
        input.write(sequence.subarray(8, 23));
        input.write(sequence.subarray(23));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, firstId);

        input.write(vscodeToggleThinkingSequence(secondId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, secondId);
        input.write(vscodeToggleThinkingSequence(secondId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);

        input.write(Buffer.from([0x03, 0x03]));
        input.write("discard this while busy");
        await settlePromptInput();
        assert.equal(interrupts, 1);

        terminal.clearCurrentRequest();
        assert.equal(lastCursorVisibility(captured()), "hidden");
        assert.equal((captured().match(/\u001B\[\?1049h/gu) ?? []).length, 1);
        assert.equal((captured().match(/\u001B\[\?1049l/gu) ?? []).length, 0);

        const prompt = terminal.readPrompt("> ", {
          captureImage: async (index) => ({
            id: `image_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            label: `Image #${index}`,
            mediaType: "image/png",
            storageKey: `attachments/test/image-${index}.png`,
            sha256: String(index).repeat(64).slice(0, 64),
            byteSize: 68,
            width: 1,
            height: 1,
          }),
        });
        input.write("fresh draft\r");
        assert.equal((await prompt)?.text, "fresh draft");
        assert.equal(input.isRaw, true);
        assert.equal(input.listenerCount("data"), initialDataListeners + 1);
        terminal.close();
        assert.equal(input.listenerCount("data"), initialDataListeners);
        assert.equal((captured().match(/\u001B\[\?1049h/gu) ?? []).length, 1);
        assert.equal((captured().match(/\u001B\[\?1049l/gu) ?? []).length, 1);
      } finally {
        terminal.close();
      }
    });
  });

  it("suspends the busy control owner while a modal input owns stdin", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const terminal = new Terminal(input, output);
      const initialDataListeners = input.listenerCount("data");
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Implement authentication");
        const id = terminal.addReasoning("Inspect the authentication routes.");
        const viewerBefore = (terminal as unknown as {
          disclosureViewer?: object;
        }).disclosureViewer;
        assert.ok(viewerBefore);
        assert.equal(input.listenerCount("data"), initialDataListeners + 1);

        const choice = terminal.selectChoice("Continue?", [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ]);
        await settlePromptInput();
        assert.equal(
          (terminal as unknown as { disclosureViewer?: object }).disclosureViewer,
          viewerBefore,
        );
        assert.equal(terminalState(terminal).overlay?.kind, "picker");
        assert.equal(input.isRaw, true);
        assert.equal(input.listenerCount("data"), initialDataListeners + 1);
        input.write(`${vscodeToggleThinkingSequence(id)}\r`);
        assert.equal(await choice, "yes");
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);

        // Once the modal releases stdin, the busy owner resumes immediately.
        assert.equal(input.isRaw, true);
        assert.equal(
          (terminal as unknown as { disclosureViewer?: object }).disclosureViewer,
          viewerBefore,
        );
        assert.equal(input.listenerCount("data"), initialDataListeners + 1);
        input.write(vscodeToggleThinkingSequence(id));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, id);
        terminal.clearCurrentRequest();
        assert.equal(input.isRaw, true);
        assert.equal(input.listenerCount("data"), initialDataListeners + 1);
      } finally {
        terminal.close();
      }
    });
  });

  it("keeps the same persistent viewer across approval and model-picker modals", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      output.resume();
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Verify modal ownership");
        const thinkingId = terminal.addReasoning(
          "Keep this disclosure selected while modal input borrows stdin.",
        );
        input.write(vscodeToggleThinkingSequence(thinkingId));
        await settlePromptInput();

        const viewerBefore = (terminal as unknown as {
          disclosureViewer?: object;
        }).disclosureViewer;
        const initialScrollOffset = disclosureFrame(terminal)?.viewport.scrollOffset;
        assert.ok(viewerBefore);
        assert.equal(terminalState(terminal).live.thinking?.id, thinkingId);
        assert.equal((captured().match(/\u001B\[\?1049h/gu) ?? []).length, 1);
        assert.equal((captured().match(/\u001B\[\?1049l/gu) ?? []).length, 0);

        const approval = terminal.approve({
          id: "persistent-viewer-approval",
          title: "Run verification",
          description: "Run one workspace verification command.",
          risk: "workspace",
          commandPrefix: "node",
          commandPreview: "node --check src/app.js",
        });
        await settlePromptInput();
        assert.equal(terminalState(terminal).overlay?.kind, "approval");
        assert.equal(
          (terminal as unknown as { disclosureViewer?: object }).disclosureViewer,
          viewerBefore,
        );

        // The first Down and Enter delivered to the modal must both take
        // effect; no priming Enter may be required on Windows ConPTY.
        input.write("\u001B[B\r");
        assert.equal(await approval, "allow_prefix");
        await settlePromptInput();
        assert.equal(terminalState(terminal).overlay, null);
        assert.equal(
          (terminal as unknown as { disclosureViewer?: object }).disclosureViewer,
          viewerBefore,
        );
        assert.equal(terminalState(terminal).live.thinking?.id, thinkingId);
        assert.equal(disclosureFrame(terminal)?.viewport.scrollOffset, initialScrollOffset);
        assert.equal((captured().match(/\u001B\[\?1049h/gu) ?? []).length, 1);
        assert.equal((captured().match(/\u001B\[\?1049l/gu) ?? []).length, 0);

        const model = terminal.selectModel(
          "DeepSeek",
          [
            { id: "deepseek-flash", label: "DeepSeek Flash" },
            { id: "deepseek-pro", label: "DeepSeek Pro" },
          ],
          "deepseek-pro",
        );
        await settlePromptInput();
        assert.equal(terminalState(terminal).overlay?.kind, "picker");
        assert.equal(
          (terminal as unknown as { disclosureViewer?: object }).disclosureViewer,
          viewerBefore,
        );

        // Likewise, the first Up and Enter select the preceding model while
        // the permanent conversation projection remains mounted.
        input.write("\u001B[A\r");
        assert.equal(await model, "deepseek-flash");
        await settlePromptInput();
        assert.equal(terminalState(terminal).overlay, null);
        assert.equal(
          (terminal as unknown as { disclosureViewer?: object }).disclosureViewer,
          viewerBefore,
        );
        assert.equal(terminalState(terminal).live.thinking?.id, thinkingId);
        assert.equal(disclosureFrame(terminal)?.viewport.scrollOffset, initialScrollOffset);
        assert.equal((captured().match(/\u001B\[\?1049h/gu) ?? []).length, 1);
        assert.equal((captured().match(/\u001B\[\?1049l/gu) ?? []).length, 0);

        terminal.clearCurrentRequest();
      } finally {
        terminal.close();
      }
    });
  });

  it("keeps transcript updates made behind a modal and repaints the same viewer", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      output.resume();
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Inspect modal transcript ownership");
        const viewerBefore = (terminal as unknown as {
          disclosureViewer?: object;
        }).disclosureViewer;
        assert.ok(viewerBefore);

        const choice = terminal.selectChoice("Continue?", [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ]);
        await settlePromptInput();
        assert.equal(terminalState(terminal).overlay?.kind, "picker");

        terminal.write("OVERLAY-TRANSCRIPT-SENTINEL\n");
        assert.equal(terminalState(terminal).overlay?.kind, "picker");
        input.write("\r");
        assert.equal(await choice, "yes");
        await settlePromptInput();

        assert.equal(
          (terminal as unknown as { disclosureViewer?: object }).disclosureViewer,
          viewerBefore,
        );
        assert.equal(terminalState(terminal).overlay, null);
        assert.match(
          disclosureNodes(terminal).map(disclosureNodeText).join("\n"),
          /OVERLAY-TRANSCRIPT-SENTINEL/u,
        );
        assert.equal((captured().match(/\u001B\[\?1049h/gu) ?? []).length, 1);
        assert.equal((captured().match(/\u001B\[\?1049l/gu) ?? []).length, 0);
        terminal.clearCurrentRequest();
      } finally {
        terminal.close();
      }
    });
  });

  it("does not resume the Request editor until a short-terminal modal releases input", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        const prompt = terminal.readPrompt("> ", {
          captureImage: async (index) => steeringAttachment(index),
        });
        input.write("draft");
        await settlePromptInput();
        const viewerBefore = (terminal as unknown as {
          disclosureViewer?: object;
        }).disclosureViewer;
        assert.ok(viewerBefore);

        const choice = terminal.selectChoice("Continue?", [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ]);
        await settlePromptInput();
        output.rows = 8;
        output.emit("resize");
        await settlePromptInput();
        assert.equal(terminalState(terminal).overlay?.kind, "picker");
        assert.equal(
          (terminal as unknown as { disclosureViewer?: object }).disclosureViewer,
          viewerBefore,
        );

        input.write("\r");
        assert.equal(await choice, "yes");
        await settlePromptInput();
        assert.equal(
          (terminal as unknown as { disclosureViewer?: object }).disclosureViewer,
          undefined,
        );

        output.rows = 24;
        input.write("!\r");
        assert.equal((await prompt)?.text, "draft!");
      } finally {
        terminal.close();
      }
    });
  });

  it("clears and repaints through FullScreenWriter without resetting the terminal", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      output.resume();
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Keep the managed shell active");
        terminal.write("CLEAR-SCREEN-SENTINEL\n");
        const viewerBefore = (terminal as unknown as {
          disclosureViewer?: object;
        }).disclosureViewer;
        assert.ok(viewerBefore);
        const before = captured().length;

        terminal.clearScreen();
        const clearOutput = captured().slice(before);
        assert.doesNotMatch(clearOutput, /\u001Bc/u);
        assert.equal(
          (terminal as unknown as { disclosureViewer?: object }).disclosureViewer,
          viewerBefore,
        );
        assert.match(disclosureRegionText(terminal, "header"), /EASY CODE/u);
        assert.match(
          disclosureNodes(terminal).map(disclosureNodeText).join("\n"),
          /CLEAR-SCREEN-SENTINEL/u,
        );
        assert.equal((captured().match(/\u001B\[\?1049h/gu) ?? []).length, 1);
        assert.equal((captured().match(/\u001B\[\?1049l/gu) ?? []).length, 0);
        terminal.clearCurrentRequest();
      } finally {
        terminal.close();
      }
    });
  });

  it("keeps one busy steering editor across submissions and modal approval", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const terminal = new Terminal(input, output);
      const submissions: Array<{ text: string; labels: string[] }> = [];
      let releaseFirst!: () => void;
      const firstAcknowledgement = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let first = true;
      let interrupts = 0;
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Implement authentication", [], {
          initialImageCount: 2,
          captureImage: async (index) => steeringAttachment(index),
          onInterrupt: () => {
            interrupts += 1;
          },
          onSteer: async (submission) => {
            submissions.push({
              text: submission.text,
              labels: submission.images.map((image) => image.label),
            });
            if (first) {
              first = false;
              await firstAcknowledgement;
            }
          },
        });
        await settlePromptInput();

        input.write("\u001B[200~first\nsecond\u001B[201~\r");
        await settlePromptInput();
        assert.equal(terminalState(terminal).composer.pendingSubmissions, 1);

        input.write("preserved ");
        input.write(Buffer.from([0x16]));
        await settlePromptInput();
        assert.match(terminalState(terminal).composer.text, /preserved/u);
        assert.deepEqual(
          terminalState(terminal).composer.images.map((image) => image.label),
          ["Image #3"],
        );

        const approval: ApprovalRequest = {
          id: "steering-approval",
          title: "Run verification",
          description: "Run one workspace verification command.",
          risk: "workspace",
          commandPrefix: "node",
          commandPreview: "node --check src/app.js",
        };
        const choice = terminal.approve(approval);
        await settlePromptInput();
        input.write("\u001B[B\r");
        assert.equal(await choice, "allow_prefix");
        await settlePromptInput();

        // Auto-repeat from the modal must not submit or edit the restored
        // draft. The first printable input ends the transition barrier.
        input.write("x");
        await settlePromptInput();
        input.write("after\r");
        input.write(Buffer.from([0x03]));
        await settlePromptInput();
        assert.equal(interrupts, 1);
        assert.equal(terminalState(terminal).composer.pendingSubmissions, 2);
        assert.deepEqual(submissions, [{ text: "first\nsecond", labels: [] }]);

        releaseFirst();
        await settlePromptInput();
        await settlePromptInput();
        assert.deepEqual(submissions, [
          { text: "first\nsecond", labels: [] },
          { text: "preserved  [Image #3] xafter", labels: ["Image #3"] },
        ]);
        assert.equal(terminalState(terminal).composer.pendingSubmissions, 0);
        terminal.clearCurrentRequest();
      } finally {
        releaseFirst?.();
        terminal.close();
      }
    });
  });

  it("freezes new steering, drains submitted lines before seal, and resumes when steering wins", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const terminal = new Terminal(input, output);
      const submissions: string[] = [];
      let releaseDelivery!: () => void;
      const delivery = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      let first = true;
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Implement authentication", [], {
          onSteer: async (submission) => {
            submissions.push(submission.text);
            if (first) {
              first = false;
              await delivery;
            }
          },
        });
        await settlePromptInput();

        input.write("submitted before seal\r");
        const sealed = terminal.sealCurrentRequestSteering(async () => {
          assert.deepEqual(submissions, ["submitted before seal"]);
          return { throughSequence: 1 };
        });
        // The finalization barrier owns stdin synchronously. Text typed after
        // it begins must not be replayed into the resumed editor.
        input.write("discarded during seal\r");
        await settlePromptInput();
        let sealSettled = false;
        void sealed.then(() => {
          sealSettled = true;
        });
        assert.equal(sealSettled, false);

        releaseDelivery();
        assert.deepEqual(await sealed, { throughSequence: 1 });
        input.write("accepted after resume\r");
        await settlePromptInput();
        assert.deepEqual(submissions, [
          "submitted before seal",
          "accepted after resume",
        ]);
        terminal.clearCurrentRequest();
      } finally {
        releaseDelivery?.();
        terminal.close();
      }
    });
  });

  it("restores a pre-existing raw and flowing input state after busy ownership", async () => {
    await withInteractiveEnvironment(() => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      input.setRawMode(true);
      input.resume();
      const terminal = new Terminal(input, output);
      const initialDataListeners = input.listenerCount("data");
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Implement authentication");
        terminal.clearCurrentRequest();
        assert.equal(input.isRaw, true);
        assert.equal(input.readableFlowing, true);
        assert.equal(input.listenerCount("data"), initialDataListeners + 1);
        assert.ok(disclosureFrame(terminal));

        terminal.setCurrentRequest("Implement authentication again");
        terminal.emergencyRestore();
        assert.equal(input.listenerCount("data"), initialDataListeners);
        assert.equal(input.isRaw, false);
        assert.equal(disclosureFrame(terminal), undefined);

        terminal.setCurrentRequest("Implement authentication once more");
        assert.equal(input.listenerCount("data"), initialDataListeners + 1);
        terminal.close();
        assert.equal(input.listenerCount("data"), initialDataListeners);
        assert.equal(input.isRaw, false);
      } finally {
        terminal.close();
      }
    });
  });

  it("toggles clicked Thinking blocks live while Ctrl+T remains stable scrollback", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        const firstId = terminal.addReasoning("Inspect the authentication routes.");
        const secondId = terminal.addReasoning("Verify the registration form.");
        const markerEntries = terminalState(terminal).transcript.length;
        const primaryBeforeViewer = stripAnsi(captured());
        assert.equal(
          (primaryBeforeViewer.match(new RegExp(`▶ Thinking #${firstId}`, "gu")) ?? []).length,
          1,
        );
        assert.equal(
          (primaryBeforeViewer.match(new RegExp(`▶ Thinking #${secondId}`, "gu")) ?? []).length,
          1,
        );
        const prompt = terminal.readPrompt("> ", {
          captureImage: async (index) => ({
            id: `image_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            label: `Image #${index}`,
            mediaType: "image/png",
            storageKey: `attachments/test/image-${index}.png`,
            sha256: String(index).repeat(64).slice(0, 64),
            byteSize: 68,
            width: 1,
            height: 1,
          }),
        });

        input.write("draft");
        const exitsBeforeToggle =
          (captured().match(/\u001B\[\?1049l/gu) ?? []).length;
        input.write(vscodeToggleThinkingSequence(firstId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, firstId);
        assert.equal(terminalState(terminal).transcript.length, markerEntries);
        const expandedNode = disclosureNode(terminal, `thinking_${firstId}`);
        assert.equal(expandedNode.expanded, true);
        assert.match(expandedNode.body ?? "", /Inspect the authentication routes/u);
        assert.match(disclosureRegionText(terminal, "composer"), /│ > draft/u);
        assert.equal(lastCursorVisibility(captured()), "hidden");

        input.write(vscodeToggleThinkingSequence(firstId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.equal(terminalState(terminal).transcript.length, markerEntries);
        const collapsedNode = disclosureNode(terminal, `thinking_${firstId}`);
        assert.equal(collapsedNode.expanded, false);
        assert.match(collapsedNode.preview ?? "", /Inspect the authentication routes/u);
        assert.match(disclosureRegionText(terminal, "composer"), /│ > draft/u);
        assert.equal(
          (captured().match(/\u001B\[\?1049l/gu) ?? []).length,
          exitsBeforeToggle,
          "collapsing Thinking must not leave the persistent conversation view",
        );

        input.write(vscodeToggleThinkingSequence(secondId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, secondId);
        input.write(vscodeToggleThinkingSequence(firstId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, firstId);
        assert.equal(terminalState(terminal).transcript.length, markerEntries);

        // Collapse the selected row before exercising ordinary readline
        // shortcuts and stale-ID fallback. The persistent viewer stays active.
        input.write(vscodeToggleThinkingSequence(firstId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.ok(disclosureFrame(terminal));

        input.write(vscodeToggleThinkingSequence(999));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.ok(disclosureFrame(terminal));

        const beforeCtrlT = terminalState(terminal).transcript.length;
        input.write(Buffer.from([0x14]));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.equal(terminalState(terminal).transcript.length, beforeCtrlT);

        input.write("!\r");
        assert.equal((await prompt)?.text, "draft!");
      } finally {
        terminal.close();
      }
    });
  });

  it("keeps the idle Request editor usable while Thinking is expanded", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        const id = terminal.addReasoning(
          "Inspect the project and retain every line while the user edits.",
        );
        const prompt = terminal.readPrompt("> ", {
          captureImage: async (index) => steeringAttachment(index),
        });

        input.write("before ");
        input.write(vscodeToggleThinkingSequence(id));
        await settlePromptInput();
        input.write("\u001B[200~A\nB\u001B[201~ after\r");

        const submission = await prompt;
        assert.ok(submission);
        assert.match(submission.text, /^before /u);
        assert.match(submission.text, /A\nB/u);
        assert.match(submission.text, / after$/u);
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.equal(lastCursorVisibility(captured()), "hidden");
        assert.equal((captured().match(/\u001B\[\?1049h/gu) ?? []).length, 1);
        assert.equal((captured().match(/\u001B\[\?1049l/gu) ?? []).length, 0);
        assert.ok(disclosureFrame(terminal));
      } finally {
        terminal.close();
      }
    });
  });

  it("queues multiline and image adjustments without closing expanded Thinking", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      const submissions: Array<{ text: string; labels: string[] }> = [];
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Inspect this project", [], {
          captureImage: async (index) => steeringAttachment(index),
          onSteer: async (submission) => {
            submissions.push({
              text: submission.text,
              labels: submission.images.map((image) => image.label),
            });
            terminal.addQueuedAdjustment(
              submissions.length,
              submission.text,
              submission.images,
            );
          },
        });
        await settlePromptInput();
        const thinkingId = terminal.addReasoning("Keep this complete while steering.");
        input.write(vscodeToggleThinkingSequence(thinkingId));
        await settlePromptInput();

        input.write(
          "\u001B[200~first\nsecond\u001B[201~" +
            VSCODE_IMAGE_PASTE_SEQUENCE +
            " tail\r",
        );
        await settlePromptInput();
        await settlePromptInput();
        assert.equal(submissions.length, 1);
        assert.match(submissions[0]?.text ?? "", /first\nsecond/u);
        assert.match(submissions[0]?.text ?? "", /\[Image #1\]\s+tail/u);
        assert.deepEqual(submissions[0]?.labels, ["Image #1"]);
        assert.equal(terminalState(terminal).live.thinking?.id, thinkingId);
        assert.equal(terminalState(terminal).composer.text, "");

        input.write("second adjustment\r");
        await settlePromptInput();
        await settlePromptInput();
        assert.deepEqual(
          submissions.map((submission) => submission.text).slice(1),
          ["second adjustment"],
        );

        input.write(vscodeToggleThinkingSequence(thinkingId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.equal(lastCursorVisibility(captured()), "hidden");
        assert.ok(disclosureFrame(terminal));
        terminal.clearCurrentRequest();
      } finally {
        terminal.close();
      }
    });
  });

  it("keeps the managed composer caret when a busy disclosure completes", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Explain the project", [], {
          onSteer: async () => undefined,
        });
        await settlePromptInput();
        const id = terminal.addReasoning("Inspect the README before answering.");
        input.write(vscodeToggleThinkingSequence(id));
        await settlePromptInput();
        terminal.write("The complete answer remains stable.\n");
        terminal.clearCurrentRequest();

        const prompt = terminal.readPrompt("> ", {
          captureImage: async (index) => steeringAttachment(index),
        });
        input.write("next request\r");
        assert.equal((await prompt)?.text, "next request");
        assert.equal(lastCursorVisibility(captured()), "hidden");
        assert.ok(disclosureFrame(terminal));
        assert.equal((captured().match(/\u001B\[\?1049h/gu) ?? []).length, 1);
        assert.equal((captured().match(/\u001B\[\?1049l/gu) ?? []).length, 0);
        terminal.close();
        assert.equal(lastCursorVisibility(captured()), "shown");
        assert.equal((captured().match(/\u001B\[\?1049l/gu) ?? []).length, 1);
      } finally {
        terminal.close();
      }
    });
  });

  it("keeps completed-turn Thinking foldable in place above an active draft", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Explain the authentication changes");
        const reasoning = [
          `Inspect the authentication routes before changing any files. ${"context ".repeat(20)}`,
          "FULL-ONLY-SENTINEL: compare the existing session and registration flows.",
        ].join("\n");
        const completedTurnOffset = captured().length;
        const id = terminal.addReasoning(reasoning);
        terminal.write("ASSISTANT-OUTPUT-SENTINEL: authentication is ready.\n");
        terminal.clearCurrentRequest();

        const prompt = terminal.readPrompt("> ", {
          captureImage: async (index) => ({
            id: `image_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            label: `Image #${index}`,
            mediaType: "image/png",
            storageKey: `attachments/test/image-${index}.png`,
            sha256: String(index).repeat(64).slice(0, 64),
            byteSize: 68,
            width: 1,
            height: 1,
          }),
        });
        input.write("draft");
        await settlePromptInput();

        assert.ok(captured().length > completedTurnOffset);
        const collapsedNodes = disclosureNodes(terminal);
        const thinkingIndex = collapsedNodes.findIndex((node) =>
          node.id === `thinking:${id}`
        );
        const answerIndex = collapsedNodes.findIndex((node) =>
          disclosureNodeText(node).includes("ASSISTANT-OUTPUT-SENTINEL")
        );
        assert.ok(thinkingIndex >= 0 && thinkingIndex < answerIndex);
        assert.equal(collapsedNodes[thinkingIndex]?.expanded, false);
        assert.match(disclosureRegionText(terminal, "composer"), /│ > draft/u);

        output.emit("resize");
        await settlePromptInput();
        assertPersistentFrame(terminal, output);
        assert.match(disclosureRegionText(terminal, "composer"), /│ > draft/u);
        assert.equal(terminalState(terminal).composer.text, "draft");

        input.write(vscodeToggleThinkingSequence(id));
        await settlePromptInput();

        const openNode = disclosureNode(terminal, `thinking_${id}`);
        assert.equal(openNode.expanded, true);
        assert.match(openNode.body ?? "", /FULL-ONLY-SENTINEL/u);
        assert.match(openNode.title ?? "", new RegExp(`Thinking #${id}`, "u"));
        const completeTurn = disclosureNodes(terminal)
          .map(disclosureNodeText)
          .join("\n");
        assert.match(completeTurn, /> Explain the authentication changes/u);
        assert.match(completeTurn, /ASSISTANT-OUTPUT-SENTINEL/u);
        assert.ok(
          completeTurn.indexOf("> Explain the authentication changes") <
            completeTurn.indexOf(`Thinking #${id}`),
        );
        assert.ok(
          completeTurn.indexOf(`Thinking #${id}`) <
            completeTurn.indexOf("ASSISTANT-OUTPUT-SENTINEL"),
        );
        assert.equal(
          disclosureNodes(terminal).filter((node) =>
            node.id === `thinking:${id}`
          ).length,
          1,
          "the expanded body must replace, not duplicate, the collapsed marker",
        );
        assert.match(disclosureRegionText(terminal, "composer"), /│ > draft/u);

        // This is the same OSC emitted when the user clicks the expanded title.
        input.write(vscodeToggleThinkingSequence(id));
        await settlePromptInput();

        const restoredNode = disclosureNode(terminal, `thinking_${id}`);
        assert.equal(restoredNode.expanded, false);
        assert.doesNotMatch(restoredNode.preview ?? "", /FULL-ONLY-SENTINEL/u);
        assert.match(disclosureRegionText(terminal, "composer"), /│ > draft/u);
        assert.equal(terminalState(terminal).composer.text, "draft");
        assert.ok(disclosureFrame(terminal));

        input.write("!\r");
        assert.equal((await prompt)?.text, "draft!");
      } finally {
        terminal.close();
      }
    });
  });

  it("presents queued adjustments as ordinary user input while retaining read-only history", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Inspect this project");
        const thinkingId = terminal.addReasoning(
          "THINKING-DETAIL: keep this distinct from the answer.",
        );
        terminal.addQueuedAdjustment(
          7,
          "deploy this project\nand verify it",
          [steeringAttachment(3)],
        );
        await settlePromptInput();
        const adjustmentEntry = terminalState(terminal).transcript.find((entry) =>
          entry.id === "adjustment_message_7"
        );
        assert.ok(adjustmentEntry);
        assert.equal(adjustmentEntry.text, "deploy this project\nand verify it");
        assert.deepEqual(
          adjustmentEntry.images?.map((image) => image.label),
          ["Image #3"],
        );
        assert.doesNotMatch(adjustmentEntry.text, /Queued adjustment|\/adjustment 7/u);
        terminal.addReasoning("SECOND-THINKING-DETAIL");
        terminal.write("ASSISTANT-ROW-IN-CURRENT-TURN\n");

        input.write(vscodeToggleThinkingSequence(thinkingId));
        await settlePromptInput();
        const expandedThinking = disclosureNode(
          terminal,
          `thinking_${thinkingId}`,
        );
        assert.equal(expandedThinking.expanded, true);
        assert.match(expandedThinking.body ?? "", /THINKING-DETAIL/u);
        const completeTurn = disclosureNodes(terminal)
          .map(disclosureNodeText)
          .join("\n");
        assert.match(completeTurn, /> Inspect this project/u);
        assert.match(completeTurn, /ASSISTANT-ROW-IN-CURRENT-TURN/u);
        assert.ok(
          completeTurn.indexOf("> Inspect this project") <
            completeTurn.indexOf("> deploy this project"),
        );
        assert.ok(
          completeTurn.indexOf("THINKING-DETAIL") <
            completeTurn.indexOf("> deploy this project"),
        );
        assert.ok(
          completeTurn.indexOf("> deploy this project") <
            completeTurn.indexOf("SECOND-THINKING-DETAIL"),
        );
        assert.ok(
          completeTurn.indexOf("SECOND-THINKING-DETAIL") <
            completeTurn.indexOf("ASSISTANT-ROW-IN-CURRENT-TURN"),
        );
        assert.doesNotMatch(completeTurn, /Queued adjustment|\/adjustment 7/u);

        input.write(vscodeToggleThinkingSequence(thinkingId));
        await settlePromptInput();

        terminal.clearCurrentRequest();
        terminal.setCurrentRequest("Start the next task");
        const nextThinkingId = terminal.addReasoning("NEXT-TURN-THINKING");
        input.write(vscodeToggleThinkingSequence(nextThinkingId));
        await settlePromptInput();
        const nextTurnNode = disclosureNode(
          terminal,
          `thinking_${nextThinkingId}`,
        );
        assert.equal(nextTurnNode.expanded, true);
        assert.match(nextTurnNode.body ?? "", /NEXT-TURN-THINKING/u);
        input.write(vscodeToggleThinkingSequence(nextThinkingId));
        await settlePromptInput();

        assert.equal(terminal.showAdjustment(7), true);
        assert.equal(adjustmentEntry.text, "deploy this project\nand verify it");
        assert.deepEqual(
          adjustmentEntry.images?.map((image) => image.label),
          ["Image #3"],
        );
      } finally {
        terminal.close();
      }
    });
  });

  it("projects the complete current turn in order and expands only the selected Thinking row", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.columns = 110;
      output.rows = 32;
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.write("PRIOR-TURN-MUST-STAY-OUTSIDE-VIEWER\n");

        const submitted = terminal.readPrompt("> ", {
          captureImage: async (index) => steeringAttachment(index),
        });
        input.write("这个项目是做什么的\r");
        const request = await submitted;
        assert.ok(request);
        terminal.setCurrentRequest(request.text, request.images, {
          onSteer: async () => undefined,
        });
        await settlePromptInput();

        terminal.status("Auto mode selected code — inspect the workspace.");
        const firstThinking = terminal.addReasoning(
          "FIRST-THINKING-FULL-BODY: inspect README and package metadata.",
        );
        terminal.addQueuedAdjustment(1, "以及这个项目怎么使用");
        terminal.toolCompleted("read_file", true, "Read README.md lines 1-63");
        const secondThinking = terminal.addReasoning(
          "SECOND-THINKING-FULL-BODY: summarize installation steps.",
        );
        terminal.write("MODEL-ANSWER: this is the complete project explanation.\n");
        terminal.clearCurrentRequest();
        terminal.info("POST-TURN-IDLE-STATUS-MUST-STAY-OUTSIDE-VIEWER");

        const idlePrompt = terminal.readPrompt("> ", {
          captureImage: async (index) => steeringAttachment(index),
        });
        await settlePromptInput();
        assert.equal(terminal.toggleReasoning(firstThinking), true);
        await settlePromptInput();

        const nodes = disclosureNodes(terminal);
        const frame = disclosureFrame(terminal);
        assert.ok(frame);
        const expandedHeader = stripAnsi(frame.visibleRows
          .filter((row) => row.region === "header")
          .map((row) => row.text)
          .join("\n"));
        const normalHeader = renderSessionHeader(terminalState(terminal), {
          // ScreenWriter reserves the final physical TTY cell to avoid
          // ConPTY pending-autowrap; both normal and expanded views use it.
          columns: output.columns - 1,
          color: false,
        });
        assert.equal(
          expandedHeader,
          normalHeader,
          "expanded Thinking must reuse the normal EASY CODE session header",
        );
        terminal.setSessionInfo(session({
          commandExecutionMode: "unrestricted",
        }));
        await settlePromptInput();
        const dangerFrame = disclosureFrame(terminal);
        assert.ok(dangerFrame);
        const dangerFooter = stripAnsi(dangerFrame.visibleRows
          .filter((row) => row.region === "footer")
          .map((row) => row.text)
          .join("\n"));
        assert.match(dangerFooter, /! EASY CODE DANGER: FULL ACCESS/u);
        const completeTurn = nodes.map(disclosureNodeText);
        const completeDocument = completeTurn.join("\n");
        const orderedMarkers = [
          "PRIOR-TURN-MUST-STAY-OUTSIDE-VIEWER",
          "> 这个项目是做什么的",
          "Auto mode selected code",
          "FIRST-THINKING-FULL-BODY",
          "> 以及这个项目怎么使用",
          "✓ Tool: read_file",
          "SECOND-THINKING-FULL-BODY",
          "MODEL-ANSWER",
          "POST-TURN-IDLE-STATUS-MUST-STAY-OUTSIDE-VIEWER",
        ];
        let previous = -1;
        for (const marker of orderedMarkers) {
          const index = completeDocument.indexOf(marker);
          assert.ok(index > previous, `${marker} must retain full-session order`);
          previous = index;
        }
        const firstNode = disclosureNode(terminal, `thinking_${firstThinking}`);
        const secondNode = disclosureNode(terminal, `thinking_${secondThinking}`);
        assert.equal(firstNode.expanded, true);
        assert.equal(secondNode.expanded, false);
        assert.equal(
          nodes.filter((node) => node.id === `thinking:${firstThinking}`).length,
          1,
          "the selected Thinking marker must be replaced in place, not copied",
        );
        assert.equal(secondThinking, firstThinking + 1);

        input.write(vscodeToggleThinkingSequence(firstThinking));
        await settlePromptInput();
        input.write("next\r");
        assert.equal((await idlePrompt)?.text, "next");
      } finally {
        terminal.close();
      }
    });
  });

  it("commits each Thinking marker once at event time and only freezes it on the next request", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Inspect event ordering");
        const turnOffset = captured().length;
        const thinkingId = terminal.addReasoning("EVENT-TIME-THINKING-BODY");
        terminal.toolCompleted("read_file", true, "Read README.md lines 1-10");
        const secondThinkingId = terminal.addReasoning(
          "SECOND-EVENT-TIME-THINKING-BODY",
        );
        terminal.toolCompleted("update_file", true, "Updated README.md");
        terminal.write("EVENT-TIME-ANSWER\n");
        terminal.clearCurrentRequest();

        const stableTurn = stripAnsi(captured().slice(turnOffset));
        const markerOffset = stableTurn.indexOf(`▶ Thinking #${thinkingId}`);
        const toolOffset = stableTurn.indexOf("✓ Tool: read_file");
        const secondMarkerOffset = stableTurn.indexOf(
          `▶ Thinking #${secondThinkingId}`,
        );
        const secondToolOffset = stableTurn.indexOf("✓ Tool: update_file");
        const answerOffset = stableTurn.indexOf("EVENT-TIME-ANSWER");
        assert.ok(markerOffset >= 0);
        assert.ok(toolOffset > markerOffset);
        assert.ok(secondMarkerOffset > toolOffset);
        assert.ok(secondToolOffset > secondMarkerOffset);
        assert.ok(answerOffset > secondToolOffset);
        assert.equal(
          terminalState(terminal).transcript.filter((entry) =>
            entry.id === `thinking_${thinkingId}`
          ).length,
          1,
        );
        assert.equal(
          terminalState(terminal).transcript.filter((entry) =>
            entry.id === `thinking_${secondThinkingId}`
          ).length,
          1,
        );

        terminal.setCurrentRequest("Start the next request");
        assert.equal(
          terminalState(terminal).transcript.filter((entry) =>
            entry.id === `thinking_${thinkingId}`
          ).length,
          1,
          "freezing the previous turn must not append its marker again",
        );
        // A full-screen diff repaint may legitimately include an older row
        // when the new request returns the viewport to the live edge. The
        // append-only transcript remains the authoritative duplication check.
        assert.equal(
          terminal.toggleReasoning(thinkingId),
          false,
          "a marker becomes historical once the next request owns the UI",
        );
        terminal.clearCurrentRequest();
      } finally {
        terminal.close();
      }
    });
  });

  it("uses accepted plan feedback as the turn request without exposing the internal revision prompt", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        (terminal as unknown as {
          recordAcceptedPlanFeedback(feedback: string): void;
        }).recordAcceptedPlanFeedback("保留现有样式\n补充部署说明");
        terminal.setCurrentRequest(
          "[Plan adjustment]\nINTERNAL-REVISION-CONTROL-PROMPT",
        );
        const thinkingId = terminal.addReasoning("Revise the accepted plan.");
        terminal.write("PLAN-REVISION-ANSWER\n");
        terminal.clearCurrentRequest();

        const prompt = terminal.readPrompt("> ", {
          captureImage: async (index) => steeringAttachment(index),
        });
        await settlePromptInput();
        input.write(vscodeToggleThinkingSequence(thinkingId));
        await settlePromptInput();
        const completeTurn = disclosureNodes(terminal)
          .map(disclosureNodeText)
          .join("\n");
        assert.match(completeTurn, /> 保留现有样式\n  补充部署说明/u);
        assert.match(completeTurn, /PLAN-REVISION-ANSWER/u);
        assert.match(completeTurn, /Revise the accepted plan/u);
        assert.doesNotMatch(completeTurn, /INTERNAL-REVISION-CONTROL-PROMPT/u);

        input.write(vscodeToggleThinkingSequence(thinkingId));
        await settlePromptInput();
        input.write("next\r");
        assert.equal((await prompt)?.text, "next");
      } finally {
        terminal.close();
      }
    });
  });

  it("keeps short disclosures attached to Request and makes long bodies visibly scrollable", async () => {
    await withInteractiveEnvironment(async () => {
      const shortInput = new TtyInput();
      const shortOutput = new TtyOutput();
      shortOutput.columns = 100;
      shortOutput.rows = 28;
      const shortTerminal = new Terminal(shortInput, shortOutput);
      try {
        assert.equal(shortTerminal.beginShell(session()), true);
        shortTerminal.setCurrentRequest("Explain and deploy the project", [], {
          onSteer: async () => undefined,
        });
        await settlePromptInput();
        shortTerminal.addReasoning("Inspect the README first.");
        shortTerminal.addQueuedAdjustment(1, "怎么部署");
        const targetId = shortTerminal.addReasoning("Summarize the deployment steps.");
        shortInput.write(vscodeToggleThinkingSequence(targetId));
        await settlePromptInput();

        const frame = disclosureFrame(shortTerminal);
        assert.ok(frame);
        assertPersistentFrame(shortTerminal, shortOutput);
        assert.equal(
          disclosureNode(shortTerminal, `thinking_${targetId}`).expanded,
          true,
        );
        assert.match(
          disclosureNode(shortTerminal, `thinking_${targetId}`).body ?? "",
          /Summarize the deployment steps/u,
        );
        const firstComposer = frame.visibleRows.find((row) =>
          row.region === "composer"
        )?.screenRow ?? -1;
        const firstFooter = frame.visibleRows.find((row) =>
          row.region === "footer"
        )?.screenRow ?? -1;
        assert.ok(firstComposer > frame.viewport.transcriptStartRow);
        assert.ok(firstFooter > firstComposer);
      } finally {
        shortTerminal.close();
      }

      const longInput = new TtyInput();
      const longOutput = new TtyOutput();
      longOutput.columns = 100;
      longOutput.rows = 18;
      const longTerminal = new Terminal(longInput, longOutput);
      try {
        assert.equal(longTerminal.beginShell(session()), true);
        longTerminal.setCurrentRequest("Inspect a large result", [], {
          onSteer: async () => undefined,
        });
        await settlePromptInput();
        const targetId = longTerminal.addReasoning(
          Array.from({ length: 40 }, (_, index) => `complete detail ${index + 1}`)
            .join("\n"),
        );
        longInput.write(vscodeToggleThinkingSequence(targetId));
        await settlePromptInput();

        const frame = disclosureFrame(longTerminal);
        assert.ok(frame);
        assert.ok(
          (frame.viewport.targetTitleScreenRow ?? 0) >
            frame.viewport.transcriptStartRow,
          "an overflowing disclosure must retain preceding turn context",
        );
        assert.ok(
          (frame.viewport.targetTitleScreenRow ?? Number.POSITIVE_INFINITY) <=
            frame.viewport.transcriptStartRow + 3,
        );
        assert.equal(frame.viewport.atEnd, false);

        const initialOffset = frame.viewport.scrollOffset;
        // Mode 1007 converts a wheel tick to cursor-down while leaving mouse
        // buttons uncaptured. Feed that portable sequence directly here.
        longInput.write("\u001B[B");
        await settlePromptInput();
        const scrolled = disclosureFrame(longTerminal);
        assert.ok(scrolled);
        assert.equal(scrolled.viewport.scrollOffset, initialOffset + 1);
        assert.equal(scrolled.viewport.atStart, false);
      } finally {
        longTerminal.close();
      }
    });
  });

  it("avoids tail overscroll and keeps both ends of a long turn reachable", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.columns = 100;
      output.rows = 18;
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Inspect tail anchor", [], {
          onSteer: async () => undefined,
        });
        await settlePromptInput();
        terminal.write(
          `${Array.from({ length: 30 }, (_, index) =>
            `STABLE-CONTEXT-${index + 1}`).join("\n")}\n`,
        );
        const targetId = terminal.addReasoning("TAIL-SHORT-BODY");
        input.write(vscodeToggleThinkingSequence(targetId));
        await settlePromptInput();

        const initial = disclosureFrame(terminal);
        assert.ok(initial);
        const initialTranscriptRows = initial.visibleRows.filter((row) =>
          row.region === "transcript"
        );
        assert.equal(
          initialTranscriptRows.filter((row) => row.part === "blank").length,
          0,
          "a short tail body must not force blank overscroll below its title",
        );
        assert.equal(initial.viewport.atEnd, true);

        input.write("\u001B[5~".repeat(10));
        await settlePromptInput();
        const atStart = disclosureFrame(terminal);
        assert.ok(atStart);
        assert.equal(atStart.viewport.atStart, true);
        assert.match(
          stripAnsi(atStart.visibleRows.map((row) => row.text).join("\n")),
          /> Inspect tail anchor/u,
        );

        input.write("\u001B[6~".repeat(10));
        await settlePromptInput();
        const atEnd = disclosureFrame(terminal);
        assert.ok(atEnd);
        assert.equal(atEnd.viewport.atEnd, true);
        assert.match(
          stripAnsi(atEnd.visibleRows.map((row) => row.text).join("\n")),
          /TAIL-SHORT-BODY/u,
        );

        input.write(vscodeToggleThinkingSequence(targetId));
        await settlePromptInput();
        terminal.clearCurrentRequest();
      } finally {
        terminal.close();
      }
    });
  });

  it("keeps a long transcript stable while disclosures and the Request editor remain responsive", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Summarize a long verification run");
        terminal.addReasoning("Earlier Thinking content.");
        terminal.write(
          `${Array.from({ length: 25 }, (_, index) => `assistant row ${index + 1}`).join("\n")}\n`,
        );
        const targetId = terminal.addReasoning(
          Array.from(
            { length: 10 },
            (_, index) => `TARGET-THINKING-DETAIL-${index + 1}`,
          ).join("\n"),
        );
        terminal.write("answer tail 1\nanswer tail 2\nanswer tail 3\nanswer tail 4\n");
        terminal.clearCurrentRequest();

        const prompt = terminal.readPrompt("> ", {
          captureImage: async (index) => ({
            id: `image_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            label: `Image #${index}`,
            mediaType: "image/png",
            storageKey: `attachments/test/image-${index}.png`,
            sha256: String(index).repeat(64).slice(0, 64),
            byteSize: 68,
            width: 1,
            height: 1,
          }),
        });
        output.emit("resize");
        await settlePromptInput();
        assertPersistentFrame(terminal, output);
        assert.match(disclosureRegionText(terminal, "composer"), /╭─ Request/u);
        const completeBeforeExpand = disclosureNodes(terminal)
          .map(disclosureNodeText)
          .join("\n");
        assert.match(completeBeforeExpand, /assistant row 1/u);
        assert.match(completeBeforeExpand, /assistant row 25/u);
        assert.match(completeBeforeExpand, /answer tail 4/u);

        input.write(vscodeToggleThinkingSequence(targetId));
        await settlePromptInput();
        const expandedNode = disclosureNode(terminal, `thinking_${targetId}`);
        assert.equal(expandedNode.expanded, true);
        assert.match(expandedNode.body ?? "", /TARGET-THINKING-DETAIL-1/u);
        assert.match(disclosureRegionText(terminal, "composer"), /╭─ Request/u);
        const completeTurn = disclosureNodes(terminal)
          .map(disclosureNodeText)
          .join("\n");
        assert.match(completeTurn, /> Summarize a long verification run/u);
        assert.match(completeTurn, /assistant row 1/u);
        assert.match(completeTurn, /assistant row 25/u);
        assert.match(completeTurn, /answer tail 1/u);
        assert.match(completeTurn, /answer tail 4/u);

        input.write(vscodeToggleThinkingSequence(targetId));
        await settlePromptInput();

        input.write("\u001B[5~");
        await settlePromptInput();
        assert.equal(disclosureFrame(terminal)?.viewport.atEnd, false);
        input.write("still works\r");
        assert.equal((await prompt)?.text, "still works");
        assert.equal(disclosureFrame(terminal)?.viewport.atEnd, true);
        assert.match(
          disclosureNodes(terminal).map(disclosureNodeText).join("\n"),
          /> still works/u,
        );
      } finally {
        terminal.close();
      }
    });
  });

  it("commits a complete model answer to scrollback without live-row truncation", async () => {
    await withInteractiveEnvironment(async () => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.rows = 8;
      const captured = captureOutput(output);
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Return a long answer");
        terminal.addReasoning("Inspect enough context to answer accurately.");
        const answer = Array.from(
          { length: 30 },
          (_, index) => `COMPLETE-ANSWER-ROW-${index + 1}`,
        ).join("\n");

        const answerOffset = captured().length;
        terminal.write(`\n${answer}\n\n`);
        terminal.clearCurrentRequest();
        const committed = stripAnsi(captured().slice(answerOffset));
        for (let index = 1; index <= 30; index += 1) {
          assert.equal(
            (committed.match(new RegExp(
              `COMPLETE-ANSWER-ROW-${index}(?![0-9])`,
              "gu",
            )) ?? []).length,
            1,
            `answer row ${index} must be committed exactly once`,
          );
        }
        const answerStart = committed.indexOf("COMPLETE-ANSWER-ROW-1");
        const answerEnd = committed.indexOf("COMPLETE-ANSWER-ROW-30") +
          "COMPLETE-ANSWER-ROW-30".length;
        assert.ok(answerStart >= 0 && answerEnd > answerStart);
        assert.doesNotMatch(
          committed.slice(answerStart, answerEnd),
          /live row\(s\) hidden/u,
        );

        const prompt = terminal.readPrompt("> ", {
          captureImage: async (index) => steeringAttachment(index),
        });
        input.write("composer remains responsive\r");
        assert.equal((await prompt)?.text, "composer remains responsive");
      } finally {
        terminal.close();
      }
    });
  });

  it("hides a live Thinking panel when reasoning history is restored or cleared", async () => {
    await withInteractiveEnvironment(() => {
      const input = new TtyInput();
      const output = new TtyOutput();
      output.resume();
      const terminal = new Terminal(input, output);
      try {
        assert.equal(terminal.beginShell(session()), true);
        const id = terminal.addReasoning("Original thread reasoning.");
        assert.equal(terminal.toggleReasoning(id), true);
        assert.equal(terminalState(terminal).live.thinking?.id, id);

        assert.equal(terminal.restoreReasoning(["Restored thread reasoning."]), 1);
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.equal(terminal.toggleReasoning(1), false);
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.match(
          terminalState(terminal).transcript.at(-1)?.text ?? "",
          /Thinking block #1 is historical or unavailable; use \/thinking 1 to view retained content\./u,
        );

        terminal.clearReasoning();
        assert.equal(terminalState(terminal).live.thinking, null);
      } finally {
        terminal.close();
      }
    });
  });

  it("falls back to legacy output and non-interactive choices on non-TTY streams", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const captured = captureOutput(output);
    const terminal = new Terminal(input, output);
    try {
      assert.equal(terminal.beginShell(session()), false);
      terminal.status("Reading workspace");
      terminal.taskGraph(graph());
      terminal.subagents([agent()], graph(), 2);
      terminal.startActivity("This must not animate");
      assert.equal(
        await terminal.selectChoice("Choose", [{ id: "one", label: "One" }]),
        undefined,
      );

      const rendered = stripAnsi(captured());
      assert.match(rendered, /Reading workspace/u);
      assert.match(rendered, /Task DAG · 1\/3 completed/u);
      assert.match(rendered, /Child agents · 1\/2 active/u);
      assert.equal(terminal.isInlineShell(), false);
      assert.equal(terminalState(terminal).header.session, null);
      assert.deepEqual(terminalState(terminal).transcript, []);
      assert.equal(captured().includes("\r\u001B[2K"), false);
    } finally {
      terminal.close();
    }
  });
});
