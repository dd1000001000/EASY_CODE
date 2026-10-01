import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { Terminal } from "../src/cli/terminal.js";
import type { SubagentView } from "../src/subagents/types.js";
import type { TaskGraphView } from "../src/tasks/task-graph.js";
import type { UISessionInfo } from "../src/ui/contracts.js";
import { stripAnsi } from "../src/ui/render/layout.js";
import { describe, it } from "./harness.js";

const CREATED_AT = "2026-08-29T00:00:00.000Z";

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

class TtyOutput extends PassThrough {
  readonly isTTY = true;
  readonly columns = 80;
  readonly rows = 24;
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
  process.env.CI = "";
  process.env.TERM = "xterm-256color";
  try {
    return await run();
  } finally {
    restoreEnvironment("CI", previousCI);
    restoreEnvironment("TERM", previousTerm);
  }
}

function session(): UISessionInfo {
  return {
    threadId: "thread_fallback",
    workspaceRoot: "F:\\projects\\course-system",
    mode: "auto",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    thinkingEffort: "medium",
    contextTokens: 82_400,
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
    id: "task_graph_fallback",
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
    taskGraphId: "task_graph_fallback",
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

describe("line-mode terminal fallback", () => {
  it("uses plain output and non-interactive choices on non-TTY streams", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const captured = captureOutput(output);
    const terminal = new Terminal(input, output);
    try {
      assert.equal(terminal.beginShell(session()), false);
      terminal.status("Reading workspace");
      terminal.taskGraph(graph());
      terminal.subagents([agent()], graph(), 2);
      assert.equal(terminal.startActivity("This must not animate"), undefined);
      assert.equal(await terminal.selectChoice("Choose", [{ id: "one", label: "One" }]), undefined);

      const rendered = stripAnsi(captured());
      assert.match(rendered, /Reading workspace/u);
      assert.match(rendered, /Task DAG · 1\/3 completed/u);
      assert.match(rendered, /Child agents · 1\/2 active/u);
      assert.equal(terminal.isInlineShell(), false);
      assert.equal(captured().includes("\r\u001B[2K"), false);
    } finally {
      terminal.close();
    }
  });

  it("never takes over a TTY: the interactive shell belongs to Ink", async () => {
    await withInteractiveEnvironment(() => {
      const terminal = new Terminal(new TtyInput(), new TtyOutput());
      try {
        assert.equal(terminal.beginShell(session()), false);
        assert.equal(terminal.isInlineShell(), false);
      } finally {
        terminal.close();
      }
    });
  });

  it("prints answers once instead of streaming previews", () => {
    const output = new PassThrough();
    const captured = captureOutput(output);
    const terminal = new Terminal(new PassThrough(), output);
    try {
      terminal.modelStream({ kind: "started", streamId: "stream_1", sequence: 1 });
      terminal.modelStream({ kind: "text_delta", streamId: "stream_1", sequence: 2, text: "partial" });
      assert.equal(terminal.finalizeStreamedAnswer("partial answer"), false);
      assert.equal(captured(), "");
    } finally {
      terminal.close();
    }
  });

  it("keeps the spinner on one line and clears it before durable output", async () => {
    await withInteractiveEnvironment(() => {
      const output = new TtyOutput();
      const captured = captureOutput(output);
      const terminal = new Terminal(new TtyInput(), output);
      try {
        const id = terminal.startActivity("Waiting for the model");
        assert.ok(id);
        assert.match(stripAnsi(captured()), /Waiting for the model · 0s/u);
        terminal.info("Done");
        const raw = captured();
        const clearedAt = raw.lastIndexOf("\r\u001B[2K");
        assert.ok(clearedAt > raw.indexOf("Waiting for the model"), "the spinner row is erased");
        assert.ok(clearedAt < raw.indexOf("Done"), "the erase precedes the durable line");
        assert.match(stripAnsi(raw), /Done\n$/u);
      } finally {
        terminal.close();
      }
    });
  });
});
