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
  viewport: Readonly<{
    transcriptStartRow: number;
    targetTitleScreenRow?: number;
  }>;
  visibleRows: readonly Readonly<{
    screenRow: number;
    region: "header" | "transcript" | "composer" | "footer";
    part: string;
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
      const captured = captureOutput(output);
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

        const rendered = stripAnsi(captured());
        assert.match(rendered, /EASY CODE/u);
        assert.match(rendered, /DeepSeek\/v4-pro/u);
        assert.match(rendered, /Tasks 2\/3/u);
        assert.match(rendered, /Implement backend/u);
        assert.match(rendered, /Agents 1\/4/u);
        assert.match(rendered, /backend-auth/u);
        assert.match(rendered, /Waiting for deepseek-v4-pro/u);

        const progressOffset = rendered.lastIndexOf("Progress");
        const activityOffset = rendered.lastIndexOf("Waiting for deepseek-v4-pro");
        const composerOffset = rendered.lastIndexOf("Working on: Add login and registration");
        const tasksOffset = rendered.lastIndexOf("Tasks 2/3");
        const agentsOffset = rendered.lastIndexOf("Agents 1/4");
        const footerOffset = rendered.lastIndexOf("auto  deepseek/v4-pro");
        assert.ok(progressOffset >= 0 && progressOffset < composerOffset);
        assert.ok(composerOffset < tasksOffset);
        assert.ok(tasksOffset < agentsOffset);
        assert.ok(agentsOffset < activityOffset);
        assert.ok(activityOffset < footerOffset);
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

        const initial = stripAnsi(captured());
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
        const activeSuffix = stripAnsi(captured().slice(liveOnlyOffset));
        assert.doesNotMatch(activeSuffix, /Progress|Tool: read_file/u);
        assert.match(activeSuffix, /⠋ Waiting for deepseek.* · 0s/u);
        const composerBottomOffset = activeSuffix.lastIndexOf("╰");
        const tasksOffset = activeSuffix.lastIndexOf("Tasks 2/3");
        const agentsOffset = activeSuffix.lastIndexOf("Agents 1/4");
        const activityOffset = activeSuffix.lastIndexOf("⠋ Waiting for deepseek");
        assert.ok(composerBottomOffset >= 0 && composerBottomOffset < tasksOffset);
        assert.ok(tasksOffset < agentsOffset);
        assert.ok(agentsOffset < activityOffset);
        assert.doesNotMatch(
          activeSuffix.slice(activityOffset),
          /auto  deepseek\/v4-pro/u,
        );
        terminal.stopActivity();

        input.write("A request long enough to wrap across several terminal rows");
        await new Promise<void>((resolve) => setImmediate(resolve));
        terminal.status(
          "Model usage accounting could not be saved: temporary database issue",
        );
        const plainOutput = stripAnsi(captured());
        const statusOffset = plainOutput.indexOf(
          "Model usage accounting could not be saved",
        );
        assert.ok(statusOffset >= 0);
        const afterStatus = plainOutput.slice(statusOffset);
        assert.match(afterStatus, /╭─ Request /u);
        assert.match(
          afterStatus,
          /╰─+╯\r?\nTasks 2\/3[\s\S]*Agents 1\/4[\s\S]*auto\s+deepseek\/v4-pro/u,
        );

        output.columns = 44;
        output.emit("resize");
        assert.match(stripAnsi(captured()), new RegExp(`╰${"─".repeat(41)}╯`, "u"));

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
        assert.equal(input.rawModeTransitions.at(-1), false);
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
      const captured = captureOutput(output);
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

        const plainAfterSubmit = stripAnsi(captured());
        const transcriptOffset = plainAfterSubmit.lastIndexOf("> first line\n  second line");
        assert.ok(transcriptOffset >= 0);
        assert.doesNotMatch(plainAfterSubmit.slice(transcriptOffset), /╭─ Request /u);

        const busyOffset = captured().length;
        terminal.setCurrentRequest("Process the pasted request");
        const busyOutput = stripAnsi(captured().slice(busyOffset));
        assert.equal(
          (busyOutput.match(/Working on: Process the pasted request/gu) ?? []).length,
          1,
          busyOutput,
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
      output.resume();
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
        assert.equal(input.readableFlowing, true);
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
        assert.equal(interrupts, 2);

        terminal.clearCurrentRequest();
        assert.equal(input.isRaw, false);
        assert.equal(input.readableFlowing, false);
        assert.equal(input.listenerCount("data"), initialDataListeners);

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
      try {
        assert.equal(terminal.beginShell(session()), true);
        terminal.setCurrentRequest("Implement authentication");
        const id = terminal.addReasoning("Inspect the authentication routes.");

        const choice = terminal.selectChoice("Continue?", [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ]);
        await settlePromptInput();
        input.write(`${vscodeToggleThinkingSequence(id)}\r`);
        assert.equal(await choice, "yes");
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);

        // Once the modal releases stdin, the busy owner resumes immediately.
        assert.equal(input.isRaw, true);
        input.write(vscodeToggleThinkingSequence(id));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, id);
        terminal.clearCurrentRequest();
        assert.equal(input.isRaw, false);
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

        // Auto-repeat from the modal must not submit or edit the restored
        // draft. The first printable input ends the transition barrier.
        input.write("\u001B[B\r\u001B[57353u\u001B[13u");
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
          { text: "preserved  [Image #3] after", labels: ["Image #3"] },
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
        assert.equal(input.listenerCount("data"), initialDataListeners);

        terminal.setCurrentRequest("Implement authentication again");
        terminal.emergencyRestore();
        assert.equal(input.listenerCount("data"), initialDataListeners);

        terminal.setCurrentRequest("Implement authentication once more");
        terminal.close();
        assert.equal(input.listenerCount("data"), initialDataListeners);
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
        const openOffset = captured().length;
        input.write(vscodeToggleThinkingSequence(firstId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, firstId);
        assert.equal(terminalState(terminal).transcript.length, markerEntries);
        assert.match(
          stripAnsi(captured()),
          new RegExp(
            `↕ Thinking #${firstId}[^\n]*· /thinking ${firstId}`,
            "u",
          ),
        );
        const openFrame = stripAnsi(captured().slice(openOffset));
        const expandedBody = openFrame.indexOf("Inspect the authentication routes.");
        const requestCard = openFrame.indexOf("╭─ Request");
        assert.ok(expandedBody >= 0);
        assert.ok(requestCard > expandedBody);
        assert.match(openFrame, /╭─ Request[^\n]*[\s\S]*│ > draft/u);

        const closeOffset = captured().length;
        input.write(vscodeToggleThinkingSequence(firstId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.equal(terminalState(terminal).transcript.length, markerEntries);
        const closeFrame = stripAnsi(captured().slice(closeOffset));
        assert.match(closeFrame, new RegExp(`▶ Thinking #${firstId}`, "u"));
        assert.equal(closeFrame.includes(`↕ Thinking #${firstId}`), false);
        assert.match(closeFrame, /╭─ Request[^\n]*\n│ > draft/u);

        input.write(vscodeToggleThinkingSequence(secondId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, secondId);
        input.write(vscodeToggleThinkingSequence(firstId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, firstId);
        assert.equal(terminalState(terminal).transcript.length, markerEntries);

        // Leave the managed viewer before exercising the ordinary readline
        // shortcuts and stale-ID fallback below.
        input.write(vscodeToggleThinkingSequence(firstId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);

        input.write(vscodeToggleThinkingSequence(999));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.equal(terminalState(terminal).transcript.at(-1)?.kind, "info");
        assert.match(
          terminalState(terminal).transcript.at(-1)?.text ?? "",
          /Thinking block #999 is historical or unavailable; use \/thinking 999 to view retained content\./u,
        );

        const beforeCtrlT = terminalState(terminal).transcript.length;
        input.write(Buffer.from([0x14]));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.equal(terminalState(terminal).transcript.length, beforeCtrlT + 1);
        assert.match(
          terminalState(terminal).transcript.at(-1)?.text ?? "",
          new RegExp(
            `▼ Thinking #${secondId}[\\s\\S]*Verify the registration form\\.`,
            "u",
          ),
        );

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
        assert.equal(lastCursorVisibility(captured()), "shown");
        assert.equal(
          (captured().match(/\u001B\[\?1049h/gu) ?? []).length,
          (captured().match(/\u001B\[\?1049l/gu) ?? []).length,
        );
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
        assert.equal(lastCursorVisibility(captured()), "shown");
        terminal.clearCurrentRequest();
      } finally {
        terminal.close();
      }
    });
  });

  it("restores a real idle caret when a busy disclosure closes on completion", async () => {
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
        assert.equal(lastCursorVisibility(captured()), "shown");
        assert.equal(
          (captured().match(/\u001B\[\?1049h/gu) ?? []).length,
          (captured().match(/\u001B\[\?1049l/gu) ?? []).length,
        );
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
        const id = terminal.addReasoning(reasoning);
        const completedTurnOffset = captured().length;
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

        const completedTurn = stripAnsi(captured().slice(completedTurnOffset));
        const stableAnswerOffset = completedTurn.indexOf(
          "ASSISTANT-OUTPUT-SENTINEL",
        );
        const liveDisclosureOffset = completedTurn.indexOf(`Thinking #${id}`);
        const liveRequestOffset = completedTurn.indexOf("╭─ Request");
        assert.ok(stableAnswerOffset >= 0);
        assert.ok(liveDisclosureOffset > stableAnswerOffset);
        assert.ok(liveRequestOffset > liveDisclosureOffset);

        const collapsedOffset = captured().length;
        output.emit("resize");
        await settlePromptInput();
        const collapsedFrame = stripAnsi(captured().slice(collapsedOffset));
        const collapsedThinkingOffset = collapsedFrame.indexOf(`▶ Thinking #${id}`);
        const collapsedRequestOffset = collapsedFrame.indexOf("╭─ Request");
        assert.ok(collapsedThinkingOffset >= 0);
        assert.ok(collapsedRequestOffset > collapsedThinkingOffset);
        assert.equal(collapsedFrame.includes("ASSISTANT-OUTPUT-SENTINEL"), false);
        assert.doesNotMatch(collapsedFrame, /FULL-ONLY-SENTINEL/u);
        assert.match(collapsedFrame, /╭─ Request[^\n]*\n│ > draft/u);

        const openOffset = captured().length;
        input.write(vscodeToggleThinkingSequence(id));
        await settlePromptInput();

        const openFrame = stripAnsi(captured().slice(openOffset));
        const expandedOffset = openFrame.indexOf(`Thinking #${id}`);
        const requestOffset = openFrame.indexOf("╭─ Request");
        assert.ok(expandedOffset >= 0);
        assert.match(openFrame, new RegExp(`(?:▼|↕) Thinking #${id}`, "u"));
        assert.match(openFrame, /FULL-ONLY-SENTINEL/u);
        assert.match(openFrame, new RegExp(`/thinking ${id}`, "u"));
        assert.ok(requestOffset > expandedOffset);
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
        assert.equal(openFrame.includes(`▶ Thinking #${id}`), false);
        assert.equal(
          (openFrame.match(new RegExp(`Thinking #${id}`, "gu")) ?? []).length,
          1,
          "the expanded body must replace, not duplicate, the collapsed marker",
        );
        assert.match(openFrame, /╭─ Request[^\n]*[\s\S]*│ > draft/u);

        const closeOffset = captured().length;
        // This is the same OSC emitted when the user clicks the expanded title.
        input.write(vscodeToggleThinkingSequence(id));
        await settlePromptInput();

        const closeFrame = stripAnsi(captured().slice(closeOffset));
        const previewOffset = closeFrame.indexOf(`▶ Thinking #${id}`);
        const restoredRequestOffset = closeFrame.indexOf("╭─ Request");
        assert.ok(previewOffset >= 0);
        assert.ok(restoredRequestOffset > previewOffset);
        assert.equal(closeFrame.includes("ASSISTANT-OUTPUT-SENTINEL"), false);
        assert.equal(closeFrame.includes("FULL-ONLY-SENTINEL"), false);
        assert.equal(
          (closeFrame.match(new RegExp(`Thinking #${id}`, "gu")) ?? []).length,
          1,
        );
        assert.match(closeFrame, /╭─ Request[^\n]*\n│ > draft/u);

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
        const queuedOffset = captured().length;
        terminal.addQueuedAdjustment(
          7,
          "deploy this project\nand verify it",
          [steeringAttachment(3)],
        );
        await settlePromptInput();
        const queued = stripAnsi(captured().slice(queuedOffset));
        assert.match(queued, /> deploy this project\n  and verify it \[Image #3\]/u);
        assert.doesNotMatch(queued, /Queued adjustment|\/adjustment 7/u);
        terminal.addReasoning("SECOND-THINKING-DETAIL");
        terminal.write("ASSISTANT-ROW-IN-CURRENT-TURN\n");

        const openOffset = captured().length;
        input.write(vscodeToggleThinkingSequence(thinkingId));
        await settlePromptInput();
        const expanded = stripAnsi(captured().slice(openOffset));
        assert.match(expanded, /> deploy this project\s+and verify it \[Image #3\]/u);
        assert.match(expanded, /THINKING-DETAIL/u);
        assert.match(expanded, /SECOND-THINKING-DETAIL/u);
        assert.ok(
          expanded.indexOf("THINKING-DETAIL") <
            expanded.indexOf("> deploy this project"),
        );
        assert.ok(
          expanded.indexOf("> deploy this project") <
            expanded.indexOf("SECOND-THINKING-DETAIL"),
        );
        const completeTurn = disclosureNodes(terminal)
          .map(disclosureNodeText)
          .join("\n");
        assert.match(completeTurn, /> Inspect this project/u);
        assert.match(completeTurn, /ASSISTANT-ROW-IN-CURRENT-TURN/u);
        assert.ok(
          completeTurn.indexOf("> Inspect this project") <
            completeTurn.indexOf("THINKING-DETAIL"),
        );
        assert.ok(
          completeTurn.indexOf("SECOND-THINKING-DETAIL") <
            completeTurn.indexOf("ASSISTANT-ROW-IN-CURRENT-TURN"),
        );
        assert.doesNotMatch(expanded, /Queued adjustment|\/adjustment 7/u);

        input.write(vscodeToggleThinkingSequence(thinkingId));
        await settlePromptInput();

        terminal.clearCurrentRequest();
        terminal.setCurrentRequest("Start the next task");
        const nextThinkingId = terminal.addReasoning("NEXT-TURN-THINKING");
        const nextTurnOffset = captured().length;
        input.write(vscodeToggleThinkingSequence(nextThinkingId));
        await settlePromptInput();
        const nextTurnView = stripAnsi(captured().slice(nextTurnOffset));
        assert.match(nextTurnView, /NEXT-TURN-THINKING/u);
        assert.doesNotMatch(nextTurnView, /deploy this project/u);
        input.write(vscodeToggleThinkingSequence(nextThinkingId));
        await settlePromptInput();

        const historyOffset = captured().length;
        assert.equal(terminal.showAdjustment(7), true);
        const history = stripAnsi(captured().slice(historyOffset));
        assert.match(history, /deploy this project\nand verify it/u);
        assert.match(history, /Attachments: \[Image #3\]/u);
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
        input.write(vscodeToggleThinkingSequence(firstThinking));
        await settlePromptInput();

        const nodes = disclosureNodes(terminal);
        const completeTurn = nodes.map(disclosureNodeText);
        assert.deepEqual(
          nodes.map((node) => node.kind),
          ["text", "text", "thinking", "text", "text", "thinking", "text"],
        );
        assert.match(completeTurn[0] ?? "", /> 这个项目是做什么的/u);
        assert.match(completeTurn[1] ?? "", /Auto mode selected code/u);
        assert.match(completeTurn[2] ?? "", /FIRST-THINKING-FULL-BODY/u);
        assert.match(completeTurn[3] ?? "", /> 以及这个项目怎么使用/u);
        assert.match(completeTurn[4] ?? "", /✓ Tool: read_file/u);
        assert.match(completeTurn[5] ?? "", /SECOND-THINKING-FULL-BODY/u);
        assert.match(completeTurn[6] ?? "", /MODEL-ANSWER/u);
        assert.equal(completeTurn.join("\n").includes("PRIOR-TURN"), false);
        assert.equal(completeTurn.join("\n").includes("POST-TURN-IDLE"), false);
        assert.equal(nodes[2]?.expanded, true);
        assert.equal(nodes[5]?.expanded, false);
        assert.equal(
          (completeTurn.join("\n").match(/Thinking #1/gu) ?? []).length,
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

  it("keeps short disclosure documents attached to Request and starts long bodies at the top", async () => {
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
        const transcriptRows = frame.visibleRows.filter((row) =>
          row.region === "transcript" && row.part !== "blank"
        );
        const composerStart = frame.visibleRows.find((row) =>
          row.region === "composer"
        )?.screenRow;
        assert.ok(transcriptRows.length > 0);
        assert.equal(
          transcriptRows.at(-1)?.screenRow,
          (composerStart ?? 0) - 1,
          "a short current-turn document must sit directly above Request",
        );
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
        assert.equal(
          frame.viewport.targetTitleScreenRow,
          frame.viewport.transcriptStartRow,
          "an overflowing disclosure must start its selected title at the transcript top",
        );
      } finally {
        longTerminal.close();
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
        const redrawOffset = captured().length;
        output.emit("resize");
        await settlePromptInput();
        const redraw = stripAnsi(captured().slice(redrawOffset));
        assert.match(redraw, new RegExp(`▶ Thinking #${targetId}`, "u"));
        assert.equal(redraw.includes("assistant row 1"), false);
        assert.equal(redraw.includes("answer tail 4"), false);
        assert.match(redraw, /╭─ Request/u);

        const expandedOffset = captured().length;
        input.write(vscodeToggleThinkingSequence(targetId));
        await settlePromptInput();
        const expanded = stripAnsi(captured().slice(expandedOffset));
        assert.match(expanded, new RegExp(`↕ Thinking #${targetId}`, "u"));
        assert.match(expanded, /TARGET-THINKING-DETAIL-1/u);
        assert.match(expanded, /╭─ Request/u);
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

        input.write("still works\r");
        assert.equal((await prompt)?.text, "still works");
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
