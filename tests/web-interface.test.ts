import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EasyCodeApp } from "../src/app.js";
import { RuntimeAssembly } from "../src/app/runtime-assembly.js";
import type { ApprovalRequest, EventRecord, SessionState } from "../src/core/types.js";
import type { AgentRuntimeDependencies } from "../src/runtime/agent-types.js";
import { ToolDiffStore } from "../src/threads/turn-diff-store.js";
import { projectWebHistory } from "../src/web-server/history.js";
import { WEB_HISTORY_PAGE_SIZE, WebInteraction } from "../src/web-server/interaction.js";
import { EasyCodeWebServer } from "../src/web-server/server.js";
import { describe, it } from "./harness.js";

function event(sequence: number, type: EventRecord["type"], payload: unknown): EventRecord {
  return {
    schemaVersion: 1,
    eventId: `event_${sequence}`,
    threadId: "thread_test",
    sequence,
    timestamp: "2026-09-20T00:00:00.000Z",
    type,
    payload,
  };
}

describe("Web conversation projection", () => {
  it("restores automatic compaction duration and marks an unfinished attempt as interrupted", () => {
    const base = { operationId: "auto-1", mode: "automatic", turnId: "turn-1", beforeChars: 0, startedAt: 1000 };
    const started = { ...event(1, "context.auto.started", { ...base, phase: "summarizing" }), turnId: "turn-1" };
    const finished = {
      ...event(2, "context.auto.finished", { ...base, phase: "completed", completedAt: 13000 }),
      turnId: "turn-1",
    };
    const entries = projectWebHistory([started, finished], "zh_cn");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.text, "自动压缩完成 · 耗时 12s");
    assert.equal(projectWebHistory([started, finished])[0]?.text, "Auto-compaction complete · took 12s");
    assert.equal(entries[0]?.turnId, "turn-1");
    assert.equal(entries[0]?.compaction?.completedAt, 13000);
    const interrupted = projectWebHistory([started]);
    assert.equal(interrupted[0]?.compaction?.phase, "cancelled");
  });
  it("restores sanitized expanded tool details without exposing result evidence", () => {
    const entries = projectWebHistory([
      event(1, "tool.result", {
        tool: "run_command",
        message: { content: "private output" },
        toolDetails: [{ label: "Command", value: "ls -l" }],
      }),
    ]);
    assert.deepEqual(entries[0]?.toolDetails, [{ label: "Command", value: "ls -l" }]);
    assert.ok(!JSON.stringify(entries).includes("private output"));
  });
  it("keeps user, reasoning, answer, and tool evidence in event order", () => {
    const entries = projectWebHistory([
      event(1, "message.user", { message: { role: "user", content: "Fix the issue" } }),
      event(2, "message.assistant", {
        role: "assistant",
        reasoning_content: "Investigate first",
        content: "I will inspect.",
      }),
      event(3, "tool.call", { id: "call_read", function: { name: "read_file" } }),
      event(4, "tool.result", { callId: "call_read", tool: "read_file", message: { content: "file contents" } }),
      event(5, "message.assistant", { role: "assistant", reasoning_content: "Now fix", content: "Done." }),
    ]);
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["user", "thinking", "assistant", "tool", "thinking", "assistant"],
    );
    assert.equal(entries[3]?.toolName, "read_file");
    assert.equal(entries[3]?.toolStatus, "failed");
    assert.equal(entries.at(-1)?.text, "Done.");
    assert.equal(entries[1]?.text, "Investigate first");
    assert.ok(!entries.some((entry) => entry.text.includes("file contents")));
  });
  it("restores turn timing and marks only the last assistant message as final", () => {
    const turnId = "turn_timed";
    const timed = (sequence: number, type: EventRecord["type"], payload: unknown, second: number): EventRecord => ({
      ...event(sequence, type, payload),
      turnId,
      timestamp: `2026-09-20T00:00:${String(second).padStart(2, "0")}.000Z`,
      ...(type === "turn.completed" ? { phase: "completed" as const } : {}),
    });
    const entries = projectWebHistory([
      timed(1, "message.user", { message: { role: "user", content: "Fix it" } }, 1),
      timed(2, "message.assistant", { role: "assistant", content: "I will inspect." }, 2),
      timed(3, "tool.call", { id: "call", function: { name: "read_file" } }, 3),
      timed(4, "tool.result", { callId: "call", tool: "read_file" }, 4),
      timed(5, "message.assistant", { role: "assistant", content: "Done." }, 5),
      timed(6, "turn.completed", { reason: "success" }, 9),
    ]);
    assert.ok(
      entries.every(
        (entry) => entry.turnId === turnId && entry.turnStartedAt === Date.parse("2026-09-20T00:00:01.000Z"),
      ),
    );
    assert.equal(entries.filter((entry) => entry.answerState === "confirmed").length, 1);
    assert.equal(entries.at(-1)?.answerState, "confirmed");
    assert.equal(entries.at(-1)?.turnCompletedAt, Date.parse("2026-09-20T00:00:09.000Z"));
    assert.equal(entries.at(-1)?.turnSummary, undefined);
  });
  it("restores a recorded turn summary on the turn's final answer", () => {
    const turnId = "turn_summary";
    const entries = projectWebHistory([
      { ...event(1, "message.user", { message: { role: "user", content: "Fix it" } }), turnId },
      { ...event(2, "message.assistant", { role: "assistant", content: "Done." }), turnId },
      { ...event(3, "turn.completed", { reason: "success" }), turnId, phase: "completed" as const },
      {
        ...event(4, "turn.summary", {
          durationMs: 8_000,
          inputTokens: 1_200,
          outputTokens: 80,
          changedFiles: [
            {
              path: "src/app.ts",
              change: "created",
              lines: { added: 12, removed: 0 },
              hasDiff: true,
            },
            {
              path: "old\u001B[2J.ts",
              change: "deleted",
              lines: { added: "many", removed: 3 },
              hasDiff: "yes",
            },
            { path: "unknown.ts", change: "renamed" },
            { nonsense: true },
          ],
        }),
        turnId,
      },
    ]);
    assert.deepEqual(entries.at(-1)?.turnSummary, {
      // The page loads each file's diff from this request on demand.
      threadId: "thread_test",
      turnId,
      durationMs: 8_000,
      inputTokens: 1_200,
      outputTokens: 80,
      changedFiles: [
        { path: "src/app.ts", change: "created", lines: { added: 12, removed: 0 }, hasDiff: true },
        // Malformed counts and diff flags are dropped, the file kept.
        { path: "old.ts", change: "deleted" },
      ],
    });
    assert.equal(entries[0]?.turnSummary, undefined);
  });
  it("restores an explicit final phase before the turn completion event exists", () => {
    const turnId = "turn_finalizing";
    const entries = projectWebHistory([
      { ...event(1, "message.user", { message: { role: "user", content: "Explain" } }), turnId },
      { ...event(2, "message.assistant", { role: "assistant", content: "The answer", phase: "final_answer" }), turnId },
    ]);
    assert.equal(entries.at(-1)?.answerState, "finalizing");
    assert.equal(entries.at(-1)?.turnCompletedAt, undefined);
  });
  it("pairs MCP calls and results as one logical tool without revealing result evidence", () => {
    const entries = projectWebHistory([
      event(1, "tool.call", { id: "call_mcp", function: { name: "mcp__server__search" } }),
      {
        ...event(2, "tool.result", {
          callId: "call_mcp",
          tool: "mcp__server__search",
          message: { content: "secret response" },
        }),
        phase: "completed",
      },
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.toolName, "mcp__server__search");
    assert.equal(entries[0]?.toolStatus, "completed");
    assert.ok(!JSON.stringify(entries).includes("secret response"));
  });
});

describe("file changes of tool calls", () => {
  it("lets a reopened conversation open each file-tool call whose diff was saved", () => {
    const inTurn = (record: EventRecord): EventRecord => ({ ...record, turnId: "turn_1" });
    const asked: string[] = [];
    const entries = projectWebHistory(
      [
        inTurn(event(1, "tool.call", { id: "call_edit", function: { name: "update_file" } })),
        inTurn(event(2, "tool.result", { callId: "call_edit", tool: "update_file" })),
        inTurn(event(3, "tool.call", { id: "call_old", function: { name: "update_file" } })),
        inTurn(event(4, "tool.result", { callId: "call_old", tool: "update_file" })),
        inTurn({ ...event(5, "tool.result", { callId: "call_failed", tool: "create_file" }), phase: "failed" }),
        inTurn(event(6, "tool.result", { callId: "call_alone", tool: "create_file" })),
      ].map((record) => (record.type === "tool.result" && !record.phase ? { ...record, phase: "completed" } : record)),
      "en_us",
      (ref) => {
        asked.push(ref.callId);
        return ref.callId !== "call_old";
      },
    );
    assert.deepEqual(
      entries.map((entry) => entry.toolDiff?.callId),
      ["call_edit", undefined, undefined, "call_alone"],
    );
    assert.deepEqual(entries[0]?.toolDiff, { threadId: "thread_test", turnId: "turn_1", callId: "call_edit" });
    // Failed calls changed nothing, so their diffs are never looked up.
    assert.deepEqual(asked, ["call_edit", "call_old", "call_alone"]);
  });

  it("saves what a file-tool call changed under its call and hands the reference to the page", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "easy-code-tool-diff-"));
    try {
      const shown: unknown[] = [];
      const assembly = new RuntimeAssembly({
        config: { dataDir },
        workspace: {},
        terminal: {
          toolCompleted: () => undefined,
          fileDiff: (_presentation: unknown, saved: unknown) => shown.push(saved),
        },
        syncWorkspaceState: () => undefined,
        save: () => undefined,
      } as unknown as ConstructorParameters<typeof RuntimeAssembly>[0]);
      const complete = (
        assembly as unknown as {
          onToolCompleted(...args: Parameters<NonNullable<AgentRuntimeDependencies["onToolCompleted"]>>): Promise<void>;
        }
      ).onToolCompleted.bind(assembly);
      const state = { threadId: "thread_test" } as SessionState;
      const edit = (before: string, after: string) => ({
        ok: true,
        summary: "Updated",
        presentation: { type: "file_diff", path: "src/app.ts", before, after } as const,
      });
      await complete(state, "update_file", edit("a\n", "b\n"), undefined, [], { turnId: "turn_1", callId: "call_1" });
      // Nothing changed, so there is nothing to open.
      await complete(state, "update_file", edit("a\n", "a\n"), undefined, [], { turnId: "turn_1", callId: "call_2" });
      assert.deepEqual(shown, [{ threadId: "thread_test", turnId: "turn_1", callId: "call_1" }, undefined]);
      assert.deepEqual(new ToolDiffStore(dataDir).read("thread_test", "turn_1", "call_1")?.hunks[0]?.lines, [
        "-a",
        "+b",
      ]);
      assert.equal(new ToolDiffStore(dataDir).has("thread_test", "turn_1", "call_2"), false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("marks the call that just completed with its saved diff and never sends file text", () => {
    const host = new WebInteraction();
    const sent: string[] = [];
    host.subscribe((change) => sent.push(JSON.stringify(change.patch ?? null)));
    host.setSessionInfo({
      threadId: "thread_test",
      workspaceRoot: "/workspace",
      mode: "code",
      provider: "glm",
      model: "glm-test",
      thinkingEffort: "none",
    });
    const presentation = {
      type: "file_diff",
      path: "src/app.ts",
      before: "old body",
      after: "PRIVATE_FILE_TEXT",
    } as const;
    const saved = { threadId: "thread_test", turnId: "turn_1", callId: "call_1" };
    const edit = () =>
      host.toolCompleted("update_file", true, "Updated", undefined, [{ label: "File", value: "src/app.ts" }]);
    const last = () => host.snapshot().view.entries.at(-1);

    edit();
    host.fileDiff(presentation, saved);
    assert.deepEqual(last()?.toolDiff, saved);
    // A diff that was not saved, or belongs to another conversation, opens nothing.
    edit();
    host.fileDiff(presentation);
    assert.equal(last()?.toolDiff, undefined);
    edit();
    host.fileDiff(presentation, { ...saved, threadId: "thread_other" });
    assert.equal(last()?.toolDiff, undefined);
    // Each completed call takes one diff; a later one does not overwrite it.
    host.fileDiff(presentation, { ...saved, callId: "call_late" });
    assert.equal(last()?.toolDiff, undefined);
    assert.ok(!sent.some((patch) => patch.includes("PRIVATE_FILE_TEXT")));
    host.close();
  });
});

describe("Web interaction host", () => {
  it("keeps automatic compaction alongside the current model reply", () => {
    const host = new WebInteraction();
    host.setLanguage("zh_cn");
    host.presentUser("Continue");
    host.setCurrentRequest("Continue");
    const turnId = host.snapshot().view.entries[0]?.turnId;
    host.compactionProgress({
      operationId: "auto-1",
      mode: "automatic",
      turnId: "runtime-turn",
      phase: "summarizing",
      beforeChars: 0,
      startedAt: 1000,
    });
    host.compactionProgress({
      operationId: "auto-1",
      mode: "automatic",
      turnId: "runtime-turn",
      phase: "completed",
      beforeChars: 0,
      startedAt: 1000,
      completedAt: 13000,
    });
    assert.equal(host.snapshot().view.entries[1]?.turnId, turnId);
    assert.equal(host.snapshot().view.entries[1]?.text, "自动压缩完成 · 耗时 12s");
    host.close();
  });
  it("updates one transcript entry throughout compaction and starts a new entry for the next operation", () => {
    const host = new WebInteraction();
    const appended: boolean[] = [];
    host.subscribe((change) => {
      if (change.patch?.kind === "entry.append") appended.push(Boolean(change.patch.entry.compaction));
    });
    const base = { operationId: "compact-1", beforeChars: 1000 };
    host.compactionProgress({ ...base, phase: "preparing" });
    const id = host.snapshot().view.entries[0]?.id;
    host.compactionProgress({ ...base, phase: "summarizing" });
    assert.equal(host.snapshot().view.entries.length, 1);
    assert.equal(host.snapshot().view.entries[0]?.text, "Compacting");
    assert.equal(host.snapshot().view.entries[0]?.compaction?.phase, "summarizing");
    host.compactionProgress({ ...base, phase: "completed", afterChars: 200, outcome: "compacted" });
    assert.equal(host.snapshot().view.entries.length, 1);
    assert.equal(host.snapshot().view.entries[0]?.id, id);
    assert.equal(host.snapshot().view.entries[0]?.compaction?.afterChars, 200);
    assert.equal(
      host.snapshot().view.entries[0]?.text,
      "Compaction complete · 1,000 → 200 chars · 800 chars removed (80.0%)",
    );
    host.compactionProgress({ ...base, operationId: "compact-2", phase: "preparing" });
    assert.equal(host.snapshot().view.entries.length, 2);
    assert.deepEqual(appended, [true, true]);
    host.close();
  });
  it("sends a finished request's summary as a live patch and keeps it on the turn's last entry", () => {
    const host = new WebInteraction();
    const patches: unknown[] = [];
    host.subscribe((change) => {
      if (change.patch?.kind === "turn.completed") patches.push(change.patch.summary);
    });
    host.turnCompleted({
      threadId: "thread_test",
      turnId: "turn_test",
      durationMs: 45_000,
      inputTokens: 900,
      outputTokens: 120,
      changedFiles: [
        { path: "src/app.ts", absolutePath: path.resolve("src/app.ts"), change: "modified", hasDiff: true },
        { path: "bad\u001B[2Jname.ts", absolutePath: path.resolve("bad.ts"), change: "deleted" },
      ],
    });
    const summary = {
      threadId: "thread_test",
      turnId: "turn_test",
      durationMs: 45_000,
      inputTokens: 900,
      outputTokens: 120,
      changedFiles: [
        { path: "src/app.ts", change: "modified", hasDiff: true },
        { path: "badname.ts", change: "deleted" },
      ],
    };
    assert.deepEqual(patches, [summary]);
    // Without a finished turn on screen there is no entry to carry it.
    assert.deepEqual(host.snapshot().view.entries, []);

    host.presentUser("Fix it");
    host.finalizeStreamedAnswer("Done.", { startedAt: 1_000, completedAt: 46_000 });
    host.turnCompleted({ durationMs: 45_000, changedFiles: [] });
    const answer = host.snapshot().view.entries.at(-1);
    assert.equal(answer?.text, "Done.");
    assert.deepEqual(answer?.turnSummary, { durationMs: 45_000, changedFiles: [] });
    host.close();
  });
  it("does not duplicate a proposed plan or expose its transport JSON", () => {
    const host = new WebInteraction();
    host.showPlan({
      id: "plan_web_single_source",
      revision: 1,
      proposedByTurnId: "turn_web_single_source",
      proposedAt: "2026-09-21T00:00:00.000Z",
      title: "Build the feature",
      overview: "Implement and verify the requested behavior.",
      steps: [{ title: "Implement", description: "Change the code.", verification: "Run tests." }],
    });
    assert.deepEqual(host.snapshot().view.entries, []);
    host.close();
  });
  it("keeps transient Runtime status out of browser history", () => {
    const host = new WebInteraction();
    host.status("Step 2: requesting model");
    host.status("Tool: read_file");
    host.status("Internal context maintenance completed.");
    assert.deepEqual(host.snapshot().view.entries, []);
    host.close();
  });
  it("automatically approves only the current command and plan after their unattended timeout", async () => {
    const host = new WebInteraction(15);
    const request: ApprovalRequest = {
      id: "approval_timeout",
      title: "Run tool",
      description: "Read file",
      risk: "read",
      commandPrefix: "once:v1:read",
    };
    const approval = host.approve(request);
    assert.equal(host.snapshot().view.decision?.kind, "approval");
    assert.equal(await approval, "allow_once");
    assert.equal(host.snapshot().view.decision, null);
    const plan = host.reviewPlan();
    assert.equal(host.snapshot().view.decision?.kind, "plan");
    assert.deepEqual(
      host.snapshot().view.decision?.choices?.map((choice) => choice.id),
      ["approve", "reject", "adjust"],
    );
    assert.deepEqual(await plan, { action: "approve" });
    host.close();
  });
  it("times a tool approval only while visible, and cancels on explicit dismissal or abort", async () => {
    const host = new WebInteraction(15);
    const blocker = host.selectChoice("Settings", [{ id: "keep", label: "Keep" }]);
    const tool = host.selectChoice(
      "Allow tool?",
      [
        { id: "allow_once", label: "Allow once" },
        { id: "reject", label: "Reject" },
      ],
      "allow_once",
      { idleTimeoutMs: 15, idleChoiceId: "allow_once" },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(host.snapshot().view.decision?.title, "Settings");
    assert.equal(host.resolveDecision(host.snapshot().view.decision!.id, "keep"), true);
    assert.equal(await blocker, "keep");
    assert.equal(host.snapshot().view.decision?.title, "Allow tool?");
    assert.equal(await tool, "allow_once");

    const canceled = host.selectChoice(
      "Allow tool?",
      [
        { id: "allow_once", label: "Allow once" },
        { id: "reject", label: "Reject" },
      ],
      "allow_once",
      { idleTimeoutMs: 15, idleChoiceId: "allow_once" },
    );
    assert.equal(host.resolveDecision(host.snapshot().view.decision!.id, undefined), true);
    assert.equal(await canceled, undefined);

    const controller = new AbortController();
    const aborted = host.selectChoice(
      "Allow tool?",
      [
        { id: "allow_once", label: "Allow once" },
        { id: "reject", label: "Reject" },
      ],
      "allow_once",
      { idleTimeoutMs: 15, idleChoiceId: "allow_once", signal: controller.signal },
    );
    controller.abort();
    assert.equal(await aborted, undefined);
    assert.equal(host.snapshot().view.decision, null);
    host.close();
  });
  it("pages stable history and keeps a lightweight index of every user message", () => {
    const host = new WebInteraction();
    for (let index = 0; index < WEB_HISTORY_PAGE_SIZE + 15; index += 1) {
      host.presentUser(`Message ${index}`);
    }
    const recent = host.historyPage();
    assert.equal(recent.entries.length, WEB_HISTORY_PAGE_SIZE);
    assert.equal(recent.hasEarlier, true);
    assert.equal(recent.hasLater, false);
    assert.equal(host.historyState(recent).markers.length, WEB_HISTORY_PAGE_SIZE + 15);
    const earlier = host.historyPage({ before: recent.entries[0]!.id });
    assert.equal(earlier.entries.length, 15);
    assert.equal(earlier.hasEarlier, false);
    assert.equal(earlier.hasLater, true);
    const newer = host.historyPage({ after: earlier.entries.at(-1)!.id });
    assert.equal(newer.entries[0]?.id, recent.entries[0]?.id);
    assert.equal(newer.hasLater, false);
    const around = host.historyPage({ around: earlier.entries[0]!.id });
    assert.equal(around.entries[0]?.text, "Message 0");
    assert.throws(() => host.historyPage({ before: "missing" }), /cursor/u);
    const epoch = host.historyState().epoch;
    host.clearScreen();
    assert.notEqual(host.historyState().epoch, epoch);
    assert.deepEqual(host.historyPage().entries, []);
    host.close();
  });
  it("clears orphaned activity and reviewer status when a request ends", () => {
    const host = new WebInteraction();
    host.startActivity("Running", "tool");
    host.startReview();
    host.clearCurrentRequest();
    assert.deepEqual(host.snapshot().view.activities, []);
    assert.equal(host.snapshot().view.review, null);
    host.close();
  });
  it("removes a completed DAG from the live monitor without erasing conversation history", () => {
    const host = new WebInteraction();
    host.presentUser("Run the task");
    const base = {
      id: "graph",
      goal: "Finish",
      currentTask: null,
      startableTasks: [],
      completed: 0,
      total: 0,
      tasks: [],
    };
    host.taskGraph({ ...base, status: "active" });
    assert.ok(host.snapshot().view.tasks);
    host.taskGraph({ ...base, status: "completed" });
    assert.equal(host.snapshot().view.tasks, null);
    assert.equal(host.snapshot().view.entries[0]?.text, "Run the task");
    host.close();
  });
  it("keeps tool target details separate from the collapsed summary", () => {
    const host = new WebInteraction();
    host.toolCompleted("run_command", true, "completed", undefined, [{ label: "Command", value: "ls -l" }]);
    const entry = host.snapshot().view.entries[0];
    assert.equal(entry?.text, "✓ run_command — completed");
    assert.deepEqual(entry?.toolDetails, [{ label: "Command", value: "ls -l" }]);
    host.close();
  });
  it("does not publish file change previews in the Web conversation", () => {
    const host = new WebInteraction();
    const patches: string[] = [];
    const unsubscribe = host.subscribe((change) => patches.push(change.patch?.kind ?? "state"));
    host.fileDiff({
      type: "file_diff",
      operation: "update",
      path: "src/app.ts",
      before: "private old code",
      after: "private new code",
    });
    assert.deepEqual(host.snapshot().view.entries, []);
    assert.deepEqual(patches, []);
    unsubscribe();
    host.close();
  });
  it("updates a running Web tool row in place when it completes", () => {
    const host = new WebInteraction();
    const patches: string[] = [];
    const unsubscribe = host.subscribe((change) => patches.push(change.patch?.kind ?? "state"));
    const activity = host.startActivity("Running Tool: read_file", "tool", "read_file");
    const running = host.snapshot().view.entries[0];
    assert.equal(running?.toolStatus, "running");
    host.stopActivity(activity);
    host.toolCompleted("read_file", true, "Read README.md");
    const completed = host.snapshot().view.entries;
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.id, running?.id);
    assert.equal(completed[0]?.toolStatus, "completed");
    assert.match(completed[0]?.text ?? "", /Read README\.md/u);
    assert.ok(patches.includes("entry.replace"));
    unsubscribe();
    host.close();
  });
  it("reuses an unfinished tool row after restoring a running conversation", () => {
    const host = new WebInteraction();
    host.loadHistory([
      {
        id: "ongoing",
        kind: "tool",
        text: "Calling mcp__server__search",
        toolName: "mcp__server__search",
        toolStatus: "running",
        timestamp: 0,
      },
    ]);
    const activity = host.startActivity("Running Tool: mcp__server__search", "tool", "mcp__server__search");
    host.stopActivity(activity);
    host.toolCompleted("mcp__server__search", true, "Found matches");
    assert.equal(host.snapshot().view.entries.length, 1);
    assert.equal(host.snapshot().view.entries[0]?.id, "ongoing");
    assert.equal(host.snapshot().view.entries[0]?.toolStatus, "completed");
    host.close();
  });
  it("keeps a long tool run together across history page boundaries", () => {
    const host = new WebInteraction();
    host.loadHistory([
      { id: "user", kind: "user", text: "Inspect", timestamp: 0 },
      ...Array.from({ length: WEB_HISTORY_PAGE_SIZE + 9 }, (_, index) => ({
        id: `tool_${index}`,
        kind: "tool" as const,
        text: `✓ read_file ${index}`,
        timestamp: index + 1,
      })),
      { id: "answer", kind: "assistant", text: "Done", timestamp: 100 },
    ]);
    const page = host.historyPage();
    assert.equal(page.entries.filter((entry) => entry.kind === "tool").length, WEB_HISTORY_PAGE_SIZE + 9);
    assert.equal(page.entries.at(-1)?.id, "answer");
    host.close();
  });
  it("publishes a one-time title change as a live patch", () => {
    const host = new WebInteraction();
    host.resetForNewThread({ threadId: "thread_test", workspaceRoot: "C:\\work" } as Parameters<
      WebInteraction["resetForNewThread"]
    >[0]);
    const patches: unknown[] = [];
    const unsubscribe = host.subscribe((change) => patches.push(change.patch));
    host.threadTitleChanged("Inspect backend");
    assert.ok(
      patches.some(
        (patch) =>
          (patch as { kind?: string; title?: string }).kind === "thread.title" &&
          (patch as { title?: string }).title === "Inspect backend",
      ),
    );
    unsubscribe();
    host.close();
  });
  it("reconciles streamed content without duplicate final answers", () => {
    const host = new WebInteraction();
    host.presentUser("Explain it");
    host.setCurrentRequest("Explain it");
    host.modelStream({ kind: "started", streamId: "one", sequence: 0 });
    host.modelStream({ kind: "reasoning_delta", streamId: "one", sequence: 1, text: "think" });
    host.modelStream({ kind: "text_delta", streamId: "one", sequence: 2, text: "partial" });
    assert.equal(host.snapshot().view.entries.at(-1)?.answerState, "streaming");
    host.addReasoning("complete thought");
    host.finalizeStreamedAnswer("complete answer");
    assert.deepEqual(
      host.snapshot().view.entries.map((item) => [item.kind, item.text]),
      [
        ["user", "Explain it"],
        ["thinking", "complete thought"],
        ["assistant", "complete answer"],
      ],
    );
    const entries = host.snapshot().view.entries;
    assert.ok(entries.every((item) => item.turnId === entries[0]?.turnId));
    assert.equal(entries.at(-1)?.answerState, "confirmed");
    assert.ok((entries.at(-1)?.turnCompletedAt ?? 0) >= (entries[0]?.turnStartedAt ?? Infinity));
    host.close();
  });
  it("uses an explicit provider phase for early final-answer presentation", () => {
    const host = new WebInteraction();
    host.presentUser("Explain it");
    host.setCurrentRequest("Explain it");
    host.modelStream({ kind: "started", streamId: "phase", sequence: 1 });
    host.modelStream({ kind: "assistant_phase", streamId: "phase", sequence: 2, phase: "final_answer" });
    host.modelStream({ kind: "text_delta", streamId: "phase", sequence: 3, text: "Final" });
    assert.equal(host.snapshot().view.entries.at(-1)?.answerState, "finalizing");
    host.finalizeStreamedAnswer("Final answer");
    assert.equal(host.snapshot().view.entries.at(-1)?.answerState, "confirmed");
    host.close();
  });
  it("revokes a provisional final phase when the same response starts a tool call", () => {
    const host = new WebInteraction();
    host.presentUser("Fix it");
    host.setCurrentRequest("Fix it");
    host.modelStream({ kind: "started", streamId: "invalid", sequence: 1 });
    host.modelStream({ kind: "assistant_phase", streamId: "invalid", sequence: 2, phase: "final_answer" });
    host.modelStream({ kind: "text_delta", streamId: "invalid", sequence: 3, text: "I am done" });
    host.modelStream({
      kind: "tool_call_delta",
      streamId: "invalid",
      sequence: 4,
      index: 0,
      id: "call",
      name: "read_file",
      arguments: "{}",
    });
    assert.equal(host.snapshot().view.entries.at(-1)?.answerState, "streaming");
    host.close();
  });

  it("offers only valid approval choices and rejects a canceled decision", async () => {
    const host = new WebInteraction();
    const approval: ApprovalRequest = {
      id: "approval_1",
      title: "Run tool",
      description: "Read a file",
      risk: "read",
      commandPrefix: "once:v1:read",
    };
    const decision = host.approve(approval);
    const pending = host.snapshot().view.decision;
    assert.equal(pending?.kind, "approval");
    assert.equal(
      pending?.choices?.some((choice) => choice.id === "allow_prefix"),
      false,
    );
    assert.equal(host.resolveDecision(pending!.id, "allow_prefix"), false);
    assert.equal(host.resolveDecision(pending!.id, undefined), true);
    assert.equal(await decision, "reject");
    host.close();
  });

  it("marks the current choice for the composer picker without changing selection behavior", async () => {
    const host = new WebInteraction();
    const selected = host.selectChoice(
      "Select provider",
      [
        { id: "glm", label: "GLM" },
        { id: "deepseek", label: "DeepSeek" },
      ],
      "glm",
    );
    const pending = host.snapshot().view.decision;
    assert.equal(pending?.initialId, "glm");
    assert.equal(host.resolveDecision(pending!.id, "deepseek"), true);
    assert.equal(await selected, "deepseek");
    host.close();
  });
  it("localizes app-owned Web decision copy without changing stable choice IDs", async () => {
    const host = new WebInteraction();
    host.setLanguage("zh_cn");
    const selected = host.selectProvider([{ provider: "glm", label: "GLM", apiKeyConfigured: true }], "glm");
    const pending = host.snapshot().view.decision;
    assert.equal(pending?.title, "选择供应商");
    assert.equal(pending?.choices?.[0]?.detail, "已配置 API Key");
    assert.equal(pending?.choices?.[0]?.id, "glm");
    assert.equal(host.resolveDecision(pending!.id, "glm"), true);
    assert.equal(await selected, "glm");
    host.close();
  });
});

describe("loopback Web service", () => {
  it("handles static-file stream errors without crashing the service", () => {
    const serverUrl = new URL("../src/web-server/server.js", import.meta.url).href;
    const interactionUrl = new URL("../src/web-server/interaction.js", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      import { Readable } from "node:stream";
      import { syncBuiltinESMExports } from "node:module";
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "easy-code-static-error-"));
      const filename = path.join(directory, "index.html");
      await fs.promises.writeFile(filename, "<title>test</title>");
      const originalRead = fs.createReadStream;
      fs.createReadStream = (target, options) => target === filename
        ? new Readable({ read() { this.destroy(new Error("simulated static read failure")); } })
        : originalRead(target, options);
      syncBuiltinESMExports();
      const { EasyCodeWebServer } = await import(${JSON.stringify(serverUrl)});
      const { WebInteraction } = await import(${JSON.stringify(interactionUrl)});
      const interaction = new WebInteraction();
      const service = new EasyCodeWebServer(undefined, interaction, directory, directory);
      try {
        const origin = await service.start(false);
        await assert.rejects(async () => { const response = await fetch(origin); await response.text(); });
        assert.equal((await fetch(origin, { method: "HEAD" })).status, 200);
      } finally {
        await service.stop();
        interaction.close();
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    `,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("makes all shutdown callers wait for every host and releases ports when closing fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-web-shutdown-"));
    const interaction = new WebInteraction();
    const service = new EasyCodeWebServer(undefined, interaction, directory, directory);
    const ports = [new WebInteraction(), new WebInteraction()];
    const failure = new Error("simulated close failure");
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let closedPorts = 0;
    let completed = false;
    const hosts = (service as unknown as { hosts: Map<string, unknown> }).hosts;
    for (const [index, port] of ports.entries()) {
      const close = port.close.bind(port);
      port.close = () => {
        closedPorts += 1;
        close();
      };
      hosts.set(`thread_${index}`, {
        app: {
          cancelActiveRequest: () => false,
          closeAsync: async () => {
            if (index === 0) throw failure;
            entered();
            await blocked;
            completed = true;
          },
        },
        port,
        staged: new Map(),
        stagedResources: new Map(),
        unsubscribe: () => undefined,
      });
    }
    let settled = 0;
    const observe = (work: Promise<void>) =>
      work.then(
        () => {
          settled += 1;
          return undefined;
        },
        (error: unknown) => {
          settled += 1;
          return error;
        },
      );
    const first = observe(service.stop());
    try {
      await closing;
      const second = observe(service.stop());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, 0);
      assert.equal(completed, false);
      release();
      assert.deepEqual(await Promise.all([first, second]), [failure, failure]);
      assert.equal(completed, true);
      assert.equal(closedPorts, 2);
    } finally {
      release();
      await service.stop().catch(() => undefined);
      interaction.close();
      for (const port of ports) port.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires the local bootstrap token and cookie for session APIs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-web-test-"));
    const projectRoot = path.join(directory, "project");
    await mkdir(projectRoot);
    await writeFile(path.join(directory, "index.html"), "<!doctype html><title>test</title>");
    const host = new WebInteraction();
    const imageId = "image_12345678-1234-4123-8123-123456789abc";
    let discarded = 0;
    let discardedResource = 0;
    let modelSelections = 0;
    let approvalSelections = 0;
    let orchestrationSelections = 0;
    let modeSelections = 0;
    let compacting = false;
    const app = {
      dataDirectory: () => directory,
      sessionInfo: () => ({ workspaceRoot: directory, threadId: "thread_test" }),
      allThreads: () => [],
      closeAsync: async () => {},
      startHostedSession() {},
      workspaceMentionPaths: () => ["src/app.ts", "README.md"],
      cancelActiveRequest: () => false,
      isRequestActive: () => compacting,
      isCompacting: () => compacting,
      threadEvents: () => [],
      workspaceThreads: () => [],
      pendingPlan: () => undefined,
      nextHostedImageLabel: () => "Image #1",
      importHostedImage: async () => ({
        id: imageId,
        label: "Image #1",
        mediaType: "image/png",
        storageKey: `attachments/${"a".repeat(32)}/${imageId}.png`,
        sha256: "0".repeat(64),
        byteSize: 4,
        width: 1,
        height: 1,
      }),
      discardHostedImage: async () => {
        discarded += 1;
      },
      hostedDocumentMaxBytes: () => 50 * 1024 * 1024,
      importHostedDocument: async (data: Buffer, filename: string, mediaType: string) => ({
        id: "resource_12345678-1234-4123-8123-123456789abc",
        filename,
        kind: "document" as const,
        mediaType,
        uri: "thread-resource://resource_12345678-1234-4123-8123-123456789abc/content.md",
        byteSize: data.byteLength,
        createdAt: new Date(0).toISOString(),
      }),
      discardHostedResource: async () => {
        discardedResource += 1;
      },
      selectHostedModel: async () => {
        modelSelections += 1;
      },
      selectHostedApproval: async () => {
        approvalSelections += 1;
      },
      selectHostedOrchestration: async () => {
        orchestrationSelections += 1;
      },
      selectHostedMode: async () => {
        modeSelections += 1;
      },
    } as unknown as EasyCodeApp;
    const service = new EasyCodeWebServer(app, host, directory, directory);
    try {
      const origin = await service.start(false);
      const page = await fetch(origin);
      assert.equal(page.status, 200);
      // Shiki's regex engine is WASM: the page may compile it, but scripts still may not eval.
      const policy = page.headers.get("content-security-policy") ?? "";
      assert.match(policy, /script-src 'self' 'wasm-unsafe-eval';/u);
      assert.doesNotMatch(policy, /'unsafe-eval'/u);
      assert.equal((await fetch(`${origin}/api/state`)).status, 401);
      const wrongOrigin = await fetch(`${origin}/api/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
        },
        body: JSON.stringify({ token: "not-the-token" }),
      });
      assert.equal(wrongOrigin.status, 403);
      const token = (service as unknown as { token: string }).token;
      const authenticated = await fetch(`${origin}/api/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ token }),
      });
      assert.equal(authenticated.status, 200);
      const cookie = authenticated.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      const initialState = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
      assert.equal(initialState.status, 200);
      assert.equal((await fetch(`${origin}/api/mentions?threadId=thread_test`)).status, 401);
      const mentions = await fetch(`${origin}/api/mentions?threadId=thread_test`, { headers: { Cookie: cookie } });
      assert.deepEqual(await mentions.json(), { paths: ["src/app.ts", "README.md"] });
      const initialProjects = ((await initialState.json()) as { projects: { id: string; name: string }[] }).projects;
      assert.equal(initialProjects.length, 0);
      for (let index = 0; index < WEB_HISTORY_PAGE_SIZE + 5; index += 1) host.presentUser(`History ${index}`);
      const pagedState = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
      const pagedSnapshot = (await pagedState.json()) as {
        view: { entries: { id: string }[] };
        history: { epoch: string; hasEarlier: boolean; markers: { id: string }[] };
      };
      assert.equal(pagedSnapshot.view.entries.length, WEB_HISTORY_PAGE_SIZE);
      assert.equal(pagedSnapshot.history.markers.length, WEB_HISTORY_PAGE_SIZE + 5);
      const query = new URLSearchParams({
        threadId: "thread_test",
        epoch: pagedSnapshot.history.epoch,
        before: pagedSnapshot.view.entries[0]!.id,
      });
      const older = await fetch(`${origin}/api/history?${query}`, { headers: { Cookie: cookie } });
      assert.equal(older.status, 200);
      assert.equal(((await older.json()) as { entries: { id: string }[] }).entries.length, 5);
      query.set("epoch", "stale");
      assert.equal((await fetch(`${origin}/api/history?${query}`, { headers: { Cookie: cookie } })).status, 400);
      assert.equal((await fetch(`${origin}/api/commands`)).status, 401);
      const commandResponse = await fetch(`${origin}/api/commands`, { headers: { Cookie: cookie } });
      assert.equal(commandResponse.status, 200);
      const commandEntries = ((await commandResponse.json()) as { commands: { name: string; description: string }[] })
        .commands;
      const commandNames = commandEntries.map((command) => command.name);
      assert.equal(commandEntries.length, 10);
      assert.ok(commandNames.includes("compact"));
      for (const command of commandEntries)
        assert.ok(command.description.length > 10, `/${command.name} needs an English description`);
      for (const name of [
        "model",
        "provider",
        "approval",
        "orchestration",
        "mode",
        "image",
        "clear",
        "workspace",
        "sessions",
        "new",
        "resume",
        "exit",
        "tasks",
        "agents",
        "commands",
        "thinking",
        "adjustment",
      ])
        assert.ok(!commandNames.includes(name), `/${name} should not be offered in Web`);
      assert.ok(!commandNames.includes("changes"));
      const post = (route: string, payload: unknown) =>
        fetch(`${origin}${route}`, {
          method: "POST",
          headers: { Cookie: cookie!, Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      compacting = true;
      assert.equal((await post("/api/message", { threadId: "thread_test", text: "Continue" })).status, 400);
      assert.equal((await post("/api/message", { threadId: "thread_test", text: "/compact" })).status, 400);
      assert.equal((await post("/api/adjustment", { threadId: "thread_test", text: "Continue" })).status, 400);
      assert.equal((await post("/api/decision", { threadId: "thread_test", id: "decision" })).status, 400);
      compacting = false;
      assert.equal((await post("/api/adjustment", { threadId: "thread_test", text: "/compact" })).status, 400);
      const changedLanguage = await post("/api/command", { text: "/language zh_cn" });
      assert.equal(changedLanguage.status, 200);
      assert.equal(((await changedLanguage.json()) as { language: string }).language, "zh_cn");
      const localizedState = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
      assert.equal(((await localizedState.json()) as { language: string }).language, "zh_cn");
      assert.equal((await post("/api/command", { text: "/language fr_fr" })).status, 400);
      assert.equal((await post("/api/command", { text: "/mode code" })).status, 400);
      // Only the read routes answer GET; everything else is POST, and the JSON body is validated
      // before an unknown route is rejected.
      const get = (route: string) => fetch(`${origin}${route}`, { headers: { Cookie: cookie! } });
      assert.equal((await get("/api/unknown")).status, 405);
      assert.equal((await get("/api/message")).status, 405);
      assert.equal((await post("/api/unknown", {})).status, 404);
      assert.equal((await post("/api/state", {})).status, 404);
      const plainText = await fetch(`${origin}/api/unknown`, {
        method: "POST",
        headers: { Cookie: cookie!, Origin: origin, "Content-Type": "text/plain" },
        body: "not json",
      });
      assert.equal(plainText.status, 400);
      assert.equal((await post("/api/message", { threadId: "thread_test", text: "/language en_us" })).status, 200);
      for (const name of [
        "model",
        "provider",
        "approval",
        "orchestration",
        "mode",
        "image",
        "clear",
        "workspace",
        "sessions",
      ])
        assert.equal((await post("/api/message", { threadId: "thread_test", text: `/${name}` })).status, 400);
      assert.equal((await post("/api/message", { threadId: "thread_test", text: "/mode code" })).status, 400);
      assert.equal((await post("/api/adjustment", { threadId: "thread_test", text: "/model" })).status, 400);
      assert.equal(
        (await post("/api/adjustment", { threadId: "thread_test", text: "/orchestration off" })).status,
        400,
      );
      assert.equal((await post("/api/adjustment", { threadId: "thread_test", text: "/mode code" })).status, 400);
      assert.equal((await post("/api/ui/model", { threadId: "thread_test" })).status, 202);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await post("/api/ui/approval", { threadId: "thread_test" })).status, 202);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await post("/api/ui/orchestration", { threadId: "thread_test" })).status, 202);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await post("/api/ui/mode", { threadId: "thread_test" })).status, 202);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(modelSelections, 1);
      assert.equal(approvalSelections, 1);
      assert.equal(orchestrationSelections, 1);
      assert.equal(modeSelections, 1);
      const uploaded = await fetch(`${origin}/api/image`, {
        method: "POST",
        headers: {
          Cookie: cookie!,
          Origin: origin,
          "Content-Type": "image/png",
          "X-Easy-Code-Thread-Id": "thread_test",
        },
        body: Buffer.from([1, 2, 3, 4]),
      });
      assert.equal(uploaded.status, 200);
      const discardedResponse = await fetch(`${origin}/api/image/discard`, {
        method: "POST",
        headers: {
          Cookie: cookie!,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ threadId: "thread_test", id: imageId }),
      });
      assert.equal(discardedResponse.status, 200);
      assert.deepEqual(await discardedResponse.json(), { discarded: true });
      assert.equal(discarded, 1);
      const uploadedResource = await fetch(`${origin}/api/resource`, {
        method: "POST",
        headers: {
          Cookie: cookie!,
          Origin: origin,
          "Content-Type": "text/plain",
          "X-Easy-Code-Thread-Id": "thread_test",
          "X-Easy-Code-Filename": encodeURIComponent("notes.txt"),
        },
        body: Buffer.from("resource text"),
      });
      assert.equal(uploadedResource.status, 200);
      const resourceId = ((await uploadedResource.json()) as { resource: { id: string; uri: string } }).resource.id;
      const discardedResourceResponse = await post("/api/resource/discard", {
        threadId: "thread_test",
        id: resourceId,
      });
      assert.equal(discardedResourceResponse.status, 200);
      assert.deepEqual(await discardedResourceResponse.json(), { discarded: true });
      assert.equal(discardedResource, 1);
      const added = await fetch(`${origin}/api/project/add`, {
        method: "POST",
        headers: {
          Cookie: cookie!,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Test project" }),
      });
      assert.equal(added.status, 200, await added.clone().text());
      const project = ((await added.json()) as { project: { id: string } }).project;
      const attached = await post("/api/project/folder/add", { projectId: project.id, path: projectRoot });
      assert.equal(attached.status, 200, await attached.clone().text());
      const attachedProject = ((await attached.json()) as { project: { primaryFolderId: string } }).project;
      const edited = await post("/api/project/edit", {
        projectId: project.id,
        name: "Renamed workspace",
        retainedFolderIds: [attachedProject.primaryFolderId],
        addedFolderPaths: [],
        primaryFolderId: attachedProject.primaryFolderId,
      });
      assert.equal(edited.status, 200, await edited.clone().text());
      const stateAfterRename = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
      assert.equal(
        ((await stateAfterRename.json()) as { projects: { name: string }[] }).projects[0]?.name,
        "Renamed workspace",
      );
      assert.equal((await fetch(`${origin}/api/state`, { headers: { Cookie: "easy_code_web=wrong" } })).status, 401);
    } finally {
      await service.stop();
      host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("still closes a deleted conversation whose staged-file cleanup fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-web-teardown-"));
    const interaction = new WebInteraction();
    const hostedPort = new WebInteraction();
    let closedApps = 0;
    let closedPorts = 0;
    const app = {
      sessionInfo: () => ({ workspaceRoot: directory, threadId: "thread_test" }),
      isRequestActive: () => false,
      discardHostedImage: async () => {
        throw new Error("simulated staged image failure");
      },
      closeAsync: async () => {
        closedApps += 1;
      },
    } as unknown as EasyCodeApp;
    const originalClose = hostedPort.close.bind(hostedPort);
    hostedPort.close = () => {
      closedPorts += 1;
      originalClose();
    };
    const service = new EasyCodeWebServer(app, interaction, directory, directory);
    const internals = service as unknown as {
      app: EasyCodeApp | undefined;
      hosts: Map<string, unknown>;
      prepareDelete(threadId: string): Promise<void>;
    };
    internals.hosts.set("thread_test", {
      app,
      port: hostedPort,
      staged: new Map([["image_test", { id: "image_test" }]]),
      stagedResources: new Map(),
      unsubscribe: () => undefined,
    });
    try {
      await assert.rejects(internals.prepareDelete("thread_test"), /simulated staged image failure/u);
      // The host already left the index, so this was the only chance to close it.
      assert.equal(internals.hosts.has("thread_test"), false);
      assert.equal(closedApps, 1);
      assert.equal(closedPorts, 1);
      assert.equal(internals.app, undefined);
    } finally {
      await service.stop();
      interaction.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts empty, keeps project registration separate from Thread creation, and gates sending", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-empty-web-"));
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "easy-code-empty-project-"));
    await writeFile(path.join(directory, "index.html"), "<!doctype html><title>test</title>");
    const host = new WebInteraction();
    let created = 0;
    const service = new EasyCodeWebServer(
      undefined,
      host,
      directory,
      directory,
      async (root, _threadId, threadPort) => {
        created += 1;
        return {
          dataDirectory: () => directory,
          sessionInfo: () => ({ workspaceRoot: root, threadId: "thread_new" }),
          startHostedSession: () =>
            threadPort.resetForNewThread({ workspaceRoot: root, threadId: "thread_new" } as Parameters<
              WebInteraction["resetForNewThread"]
            >[0]),
          threadEvents: () => [],
          allThreads: () => [],
          closeAsync: async () => {},
          cancelActiveRequest: () => false,
          isRequestActive: () => false,
          isCompacting: () => false,
          pendingPlan: () => undefined,
        } as unknown as EasyCodeApp;
      },
    );
    try {
      const origin = await service.start(false);
      const token = (service as unknown as { token: string }).token;
      const login = await fetch(`${origin}/api/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ token }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      const state = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
      const snapshot = (await state.json()) as { view: { session: unknown }; projects: unknown[]; threads: unknown[] };
      assert.equal(snapshot.view.session, null);
      assert.deepEqual(snapshot.projects, []);
      assert.deepEqual(snapshot.threads, []);
      const post = (route: string, payload: unknown, contentType = "application/json") =>
        fetch(`${origin}${route}`, {
          method: "POST",
          headers: { Cookie: cookie!, Origin: origin, "Content-Type": contentType },
          body: contentType === "application/json" ? JSON.stringify(payload) : Buffer.from([1, 2, 3, 4]),
        });
      assert.equal((await post("/api/message", { text: "hello" })).status, 409);
      assert.equal((await post("/api/adjustment", { text: "hello" })).status, 409);
      assert.equal((await post("/api/image", {}, "image/png")).status, 409);
      const projectResponse = await post("/api/project/add", { name: "Empty project" });
      assert.equal(projectResponse.status, 200);
      const project = ((await projectResponse.json()) as { project: { id: string } }).project;
      assert.equal(created, 0);
      const afterAdd = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
      const added = (await afterAdd.json()) as { view: { session: unknown }; projects: unknown[] };
      assert.equal(added.view.session, null);
      assert.equal(added.projects.length, 1);
      assert.equal((await post("/api/message", { text: "still blocked" })).status, 409);
      assert.equal((await post("/api/thread", { action: "new", projectId: project.id })).status, 400);
      assert.equal((await post("/api/project/folder/add", { projectId: project.id, path: projectRoot })).status, 200);
      assert.equal((await post("/api/thread", { action: "new", projectId: project.id })).status, 200);
      assert.equal(created, 1);
      const opened = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
      assert.equal(
        ((await opened.json()) as { view: { session: { threadId: string } } }).view.session.threadId,
        "thread_new",
      );
    } finally {
      await service.stop();
      host.close();
      await rm(directory, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps a running conversation alive while opening and sending in another", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-parallel-web-"));
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "easy-code-parallel-project-"));
    await writeFile(path.join(directory, "index.html"), "<!doctype html><title>test</title>");
    let created = 0;
    let releaseFirst: (() => void) | undefined;
    const firstWork = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const service = new EasyCodeWebServer(
      undefined,
      new WebInteraction(),
      directory,
      directory,
      async (root, _threadId, port) => {
        const threadId = `thread_parallel_${++created}`;
        const session = { workspaceRoot: root, threadId };
        return {
          dataDirectory: () => directory,
          sessionInfo: () => session,
          startHostedSession: () =>
            port.resetForNewThread(session as Parameters<WebInteraction["resetForNewThread"]>[0]),
          threadEvents: () => [],
          allThreads: () => [],
          pendingPlan: () => undefined,
          closeAsync: async () => {},
          cancelActiveRequest: () => false,
          isRequestActive: () => false,
          isCompacting: () => false,
          submitUserMessage: async () => {
            if (threadId === "thread_parallel_1") await firstWork;
            return {};
          },
        } as unknown as EasyCodeApp;
      },
    );
    try {
      const origin = await service.start(false);
      const token = (service as unknown as { token: string }).token;
      const login = await fetch(`${origin}/api/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ token }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      const post = (route: string, payload: unknown) =>
        fetch(`${origin}${route}`, {
          method: "POST",
          headers: { Cookie: cookie!, Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      const added = await post("/api/project/add", { name: "Parallel project" });
      const projectId = ((await added.json()) as { project: { id: string } }).project.id;
      assert.equal((await post("/api/project/folder/add", { projectId, path: projectRoot })).status, 200);
      assert.equal((await post("/api/thread", { action: "new", projectId })).status, 200);
      assert.equal((await post("/api/message", { threadId: "thread_parallel_1", text: "First task" })).status, 202);
      assert.equal((await post("/api/thread", { action: "new", projectId })).status, 200);
      const state = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie! } });
      const snapshot = (await state.json()) as { view: { session: { threadId: string } }; runningThreadIds: string[] };
      assert.equal(snapshot.view.session.threadId, "thread_parallel_2");
      assert.ok(snapshot.runningThreadIds.includes("thread_parallel_1"));
      assert.equal((await post("/api/message", { threadId: "thread_parallel_2", text: "Second task" })).status, 202);
      releaseFirst?.();
    } finally {
      releaseFirst?.();
      await service.stop();
      await rm(directory, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
