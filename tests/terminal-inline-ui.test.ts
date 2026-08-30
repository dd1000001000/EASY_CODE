import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { Terminal } from "../src/cli/terminal.js";
import { vscodeToggleThinkingSequence } from "../src/cli/prompt-input.js";
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
        assert.ok(progressOffset >= 0 && progressOffset < activityOffset);
        assert.ok(activityOffset < composerOffset);
        assert.ok(composerOffset < tasksOffset);
        assert.ok(tasksOffset < agentsOffset);
        assert.ok(agentsOffset < footerOffset);
      } finally {
        terminal.stopActivity();
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
        assert.deepEqual(input.rawModeTransitions, [true, false]);
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
        assert.doesNotMatch(activeSuffix, /Progress|Tool: read_file|Waiting for deepseek-v4-pro/u);
        const composerBottomOffset = activeSuffix.lastIndexOf("╰");
        const tasksOffset = activeSuffix.lastIndexOf("Tasks 2/3");
        const agentsOffset = activeSuffix.lastIndexOf("Agents 1/4");
        const footerOffset = activeSuffix.lastIndexOf("auto  deepseek/v4-pro");
        assert.ok(composerBottomOffset >= 0 && composerBottomOffset < tasksOffset);
        assert.ok(tasksOffset < agentsOffset);
        assert.ok(agentsOffset < footerOffset);
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
        assert.match(stripAnsi(captured()), new RegExp(`╰${"─".repeat(42)}╯`, "u"));

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
        input.write(vscodeToggleThinkingSequence(firstId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, firstId);
        assert.equal(terminalState(terminal).transcript.length, markerEntries);
        assert.match(
          stripAnsi(captured()),
          new RegExp(
            `↕ Thinking #${firstId} · Ctrl/Cmd\\+click to close · /thinking ${firstId}`,
            "u",
          ),
        );

        input.write(vscodeToggleThinkingSequence(firstId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.equal(terminalState(terminal).transcript.length, markerEntries);

        input.write(vscodeToggleThinkingSequence(secondId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, secondId);
        input.write(vscodeToggleThinkingSequence(firstId));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking?.id, firstId);
        assert.equal(terminalState(terminal).transcript.length, markerEntries);

        input.write(vscodeToggleThinkingSequence(999));
        await settlePromptInput();
        assert.equal(terminalState(terminal).live.thinking, null);
        assert.equal(terminalState(terminal).transcript.at(-1)?.kind, "info");
        assert.match(
          terminalState(terminal).transcript.at(-1)?.text ?? "",
          /Thinking block #999 is not available in this thread\./u,
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
        assert.equal(terminal.toggleReasoning(1), true);
        assert.equal(
          terminalState(terminal).live.thinking?.body,
          "Restored thread reasoning.",
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
