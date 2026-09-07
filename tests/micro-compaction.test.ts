import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import type { ChatMessage, SessionState } from "../src/core/types.js";
import {
  MICRO_COMPACTION_MIN_TOOL_RESULT_CHARS,
  MICRO_COMPACTION_PLACEHOLDER_PREFIX,
  microCompactToolResults,
  projectModelInputMessages,
  pruneConsumedReasoning,
} from "../src/context/micro-compaction.js";
import { ContextManager } from "../src/context/manager.js";
import { sha256 } from "../src/utils/hash.js";

function call(id: string, name: string): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{
      id,
      type: "function",
      function: { name, arguments: "{}" },
    }],
  };
}

function longResult(label: string): string {
  return `${label}:${"x".repeat(MICRO_COMPACTION_MIN_TOOL_RESULT_CHARS)}`;
}

function stateWith(messages: ChatMessage[]): SessionState {
  const now = new Date().toISOString();
  return {
    threadId: "thread_micro_compaction",
    mode: "code",
    provider: "qwen",
    model: "mock",
    thinkingEffort: "medium",
    workspaceRoot: process.cwd(),
    constraints: [],
    messages,
    filesRead: new Map(),
    changes: [],
    commands: [],
    commandApprovalPrefixes: [],
    workingSummary: "",
    compactedMessageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe("MicroCompaction", () => {
  it("replaces only long compactable results consumed by a later assistant", () => {
    const oldContent = longResult("old read");
    const pendingContent = longResult("pending command");
    const messages: ChatMessage[] = [
      { role: "user", content: "inspect then test" },
      call("call_read", "read_file"),
      { role: "tool", tool_call_id: "call_read", name: "read_file", content: oldContent },
      { role: "assistant", content: "I read the file; now I will run its tests." },
      call("call_test", "run_command"),
      { role: "tool", tool_call_id: "call_test", name: "run_command", content: pendingContent },
    ];
    const durableSnapshot = structuredClone(messages);

    const projected = microCompactToolResults(messages);

    assert.equal(projected.length, messages.length);
    assert.equal(projected[1], messages[1]);
    assert.equal(projected[4], messages[4]);
    assert.equal(projected[2]?.role, "tool");
    assert.match(projected[2]?.content ?? "", /^\[Old tool result cleared/u);
    assert.match(projected[2]?.content ?? "", /tool_call_id=call_read/u);
    assert.match(projected[2]?.content ?? "", /original_chars=/u);
    assert.match(projected[2]?.content ?? "", new RegExp(`sha256=${sha256(oldContent)}`, "u"));
    assert.equal(projected[5]?.content, pendingContent);
    assert.deepEqual(messages, durableSnapshot);
  });

  it("preserves tool protocol fields and resolves legacy results without a name", () => {
    const messages: ChatMessage[] = [
      call("call_legacy", "read_file"),
      { role: "tool", tool_call_id: "call_legacy", content: longResult("legacy") },
      { role: "assistant", content: "consumed", reasoning_content: "private reasoning" },
    ];

    const projected = microCompactToolResults(messages);
    const projectedResult = projected[1];

    assert.equal(projectedResult?.role, "tool");
    if (projectedResult?.role !== "tool") throw new Error("expected a tool result");
    assert.equal(projectedResult.tool_call_id, "call_legacy");
    assert.equal(projectedResult.name, undefined);
    assert.match(projectedResult.content, /tool=read_file/u);
    assert.deepEqual(
      projected.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
      ["call_legacy"],
    );
    assert.deepEqual(
      projected.flatMap((message) =>
        message.role === "assistant"
          ? (message.tool_calls ?? []).map((toolCall) => toolCall.id)
          : []),
      ["call_legacy"],
    );
  });

  it("retains short and non-compactable historical results", () => {
    const shortRead = "small read result";
    const largeMemoryResult = longResult("memory result");
    const messages: ChatMessage[] = [
      call("call_short", "read_file"),
      { role: "tool", tool_call_id: "call_short", name: "read_file", content: shortRead },
      call("call_memory", "manage_memory"),
      {
        role: "tool",
        tool_call_id: "call_memory",
        name: "manage_memory",
        content: largeMemoryResult,
      },
      { role: "assistant", content: "consumed both" },
    ];

    const projected = microCompactToolResults(messages);

    assert.equal(projected[1]?.content, shortRead);
    assert.equal(projected[3]?.content, largeMemoryResult);
  });

  it("records a deterministic, redacted read-file reference without source contents", () => {
    const payload = JSON.stringify({
      ok: true,
      summary: "Read src/private.ts lines 10-20",
      data: {
        path: "src/private.ts",
        content: `const token = sk-${"a".repeat(24)};\n${"source line\n".repeat(220)}`,
        startLine: 10,
        endLine: 20,
        totalLines: 300,
        contentHash: "a".repeat(64),
        truncated: true,
      },
    });
    const messages: ChatMessage[] = [
      call("call_read", "read_file"),
      { role: "tool", tool_call_id: "call_read", name: "read_file", content: payload },
      { role: "assistant", content: "consumed" },
    ];

    const first = microCompactToolResults(messages)[1]?.content ?? "";
    const second = microCompactToolResults(messages)[1]?.content ?? "";

    assert.equal(first, second);
    assert.match(first, /kind=file_read/u);
    assert.match(first, /path=src\/private\.ts/u);
    assert.match(first, /lines=10-20\/300/u);
    assert.match(first, new RegExp(`file_hash=${"a".repeat(64)}`, "u"));
    assert.match(first, /truncated=true/u);
    assert.match(first, new RegExp(`sha256=${sha256(payload)}`, "u"));
    assert.doesNotMatch(first, /source line/u);
    assert.doesNotMatch(first, /sk-[a-z0-9]/iu);
  });

  it("summarizes commands from structured metadata without retaining argv or output", () => {
    const payload = JSON.stringify({
      ok: false,
      summary: "Command failed with password=super-secret-value",
      data: {
        commandId: "command_123",
        status: "timed_out",
        exitCode: null,
        durationMs: 60_000,
        stdout: { text: "sensitive stdout", totalBytes: 52_000, truncated: true },
        stderr: { text: "sensitive stderr", totalBytes: 31, truncated: false },
        workspaceDelta: { created: ["a"], updated: ["b", "c"], deleted: [], truncated: false },
        failure: { kind: "timeout", code: "wall_clock", retryable: true },
        executed: { program: "secret-program", args: ["--password", "secret"], cwd: "private" },
        padding: "x".repeat(MICRO_COMPACTION_MIN_TOOL_RESULT_CHARS),
      },
    });
    const projected = microCompactToolResults([
      call("call_command", "run_command"),
      { role: "tool", tool_call_id: "call_command", name: "run_command", content: payload },
      { role: "assistant", content: "consumed" },
    ]);
    const reference = projected[1]?.content ?? "";

    assert.match(reference, /kind=command/u);
    assert.match(reference, /command_id=command_123/u);
    assert.match(reference, /status=timed_out/u);
    assert.match(reference, /exit_code=null/u);
    assert.match(reference, /stdout_bytes=52000/u);
    assert.match(reference, /workspace_delta=1\/2\/0/u);
    assert.match(reference, /failure_kind=timeout/u);
    assert.match(reference, /retryable=true/u);
    assert.doesNotMatch(reference, /secret-program|sensitive stdout|super-secret-value/u);
  });

  it("summarizes search, file mutation, task, and child results by stable metadata", () => {
    const cases: Array<{ name: string; data: unknown; expected: RegExp[] }> = [
      {
        name: "grep",
        data: { matches: [{ text: "secret body" }, { text: "another" }], totalCount: 9, truncated: true },
        expected: [/kind=search/u, /matches=2/u, /total=9/u, /truncated=true/u],
      },
      {
        name: "update_file",
        data: {
          path: "src/app.ts",
          beforeHash: "b".repeat(64),
          contentHash: "c".repeat(64),
          editsApplied: 3,
          bytesWritten: 4_096,
        },
        expected: [/kind=file_mutation/u, /operation=update/u, /path=src\/app\.ts/u, /edits_applied=3/u],
      },
      {
        name: "manage_tasks",
        data: {
          graph: {
            id: "graph_1",
            status: "active",
            currentTask: "implement",
            completed: 2,
            total: 5,
            startableTasks: ["test"],
            tasks: [{ description: "private task body" }],
          },
        },
        expected: [/kind=task_graph/u, /graph_id=graph_1/u, /completed=2/u, /total=5/u, /startable=1/u],
      },
      {
        name: "manage_subagents",
        data: {
          timedOut: false,
          observedAgentId: "subagent_1",
          result: { taskId: "child_1", outcome: "completed", summary: "private child result" },
          agents: [{ status: "completed" }, { status: "running" }, { status: "running" }],
          concurrency: { active: 2, limit: 4 },
        },
        expected: [
          /kind=subagent/u,
          /agent_id=subagent_1/u,
          /task_id=child_1/u,
          /outcome=completed/u,
          /agent_statuses="completed:1,running:2"/u,
          /active=2/u,
          /limit=4/u,
        ],
      },
      {
        name: "submit_task_result",
        data: { taskId: "child_1", outcome: "completed", evidenceCount: 2 },
        expected: [/kind=task_result/u, /task_id=child_1/u, /outcome=completed/u, /evidence_count=2/u],
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const payload = JSON.stringify({
        ok: true,
        data: testCase.data,
        padding: "x".repeat(MICRO_COMPACTION_MIN_TOOL_RESULT_CHARS),
      });
      const reference = microCompactToolResults([
        call(`call_${index}`, testCase.name),
        { role: "tool", tool_call_id: `call_${index}`, name: testCase.name, content: payload },
        { role: "assistant", content: "consumed" },
      ])[1]?.content ?? "";
      for (const expected of testCase.expected) assert.match(reference, expected);
      assert.doesNotMatch(reference, /private task body|private child result|secret body/u);
    }
  });

  it("uses an opaque non-JSON synopsis without echoing malformed tool output", () => {
    const content = `not-json password=super-secret-value ${"x".repeat(MICRO_COMPACTION_MIN_TOOL_RESULT_CHARS)}`;
    const reference = microCompactToolResults([
      call("call_bad", "read_file"),
      { role: "tool", tool_call_id: "call_bad", name: "read_file", content },
      { role: "assistant", content: "consumed" },
    ])[1]?.content ?? "";

    assert.match(reference, /kind=opaque/u);
    assert.match(reference, /format=non_json/u);
    assert.match(reference, new RegExp(`sha256=${sha256(content)}`, "u"));
    assert.doesNotMatch(reference, /super-secret-value|not-json/u);
  });

  it("sanitizes untrusted legacy tool-call identifiers in a reference", () => {
    const messages: ChatMessage[] = [
      call("call\u001b[2J password=super-secret-value", "read_file"),
      {
        role: "tool",
        tool_call_id: "call\u001b[2J password=super-secret-value",
        content: longResult("legacy"),
      },
      { role: "assistant", content: "consumed" },
    ];
    const reference = microCompactToolResults(messages)[1]?.content ?? "";

    assert.doesNotMatch(reference, /\u001b|super-secret-value/u);
    assert.match(reference, /\[REDACTED\]/u);
  });

  it("uses the lightweight projection for provider builds and pressure estimates", () => {
    const oldContent = longResult("source").repeat(8);
    const messages: ChatMessage[] = [
      { role: "user", content: "read this" },
      call("call_read", "read_file"),
      { role: "tool", tool_call_id: "call_read", name: "read_file", content: oldContent },
      { role: "assistant", content: "The relevant definition is understood." },
      { role: "user", content: "continue" },
    ];
    const state = stateWith(messages);
    const manager = new ContextManager();
    const before = structuredClone(messages);

    const built = manager.build({ systemPrompt: "system", state, maxContextChars: 50_000 });
    const projectedResult = built.find(
      (message) => message.role === "tool" && message.tool_call_id === "call_read",
    );

    assert.equal(projectedResult?.role, "tool");
    assert.equal(
      projectedResult?.content.startsWith(MICRO_COMPACTION_PLACEHOLDER_PREFIX),
      true,
    );
    assert.ok(manager.estimateShortTermChars(state) < oldContent.length / 4);
    assert.deepEqual(state.messages, before);
  });

  it("keeps only the latest unresolved tool-call reasoning in model input", () => {
    const oldCall = call("call_old", "read_file");
    if (oldCall.role !== "assistant") throw new Error("expected assistant call");
    oldCall.reasoning_content = "old private reasoning";
    const activeCall = call("call_active", "run_command");
    if (activeCall.role !== "assistant") throw new Error("expected assistant call");
    activeCall.reasoning_content = "active tool reasoning";
    const messages: ChatMessage[] = [
      { role: "user", content: "inspect and test" },
      oldCall,
      { role: "tool", tool_call_id: "call_old", name: "read_file", content: "result" },
      { role: "assistant", content: "I consumed it.", reasoning_content: "answer reasoning" },
      { role: "user", content: "continue" },
      activeCall,
      { role: "tool", tool_call_id: "call_active", name: "run_command", content: "pending" },
    ];
    const durableSnapshot = structuredClone(messages);

    const projected = pruneConsumedReasoning(messages);

    assert.equal(
      projected[1]?.role === "assistant" ? projected[1].reasoning_content : undefined,
      undefined,
    );
    assert.equal(
      projected[3]?.role === "assistant" ? projected[3].reasoning_content : undefined,
      undefined,
    );
    assert.equal(
      projected[5]?.role === "assistant" ? projected[5].reasoning_content : undefined,
      "active tool reasoning",
    );
    assert.deepEqual(projectModelInputMessages(projected), projectModelInputMessages(messages));
    assert.deepEqual(messages, durableSnapshot);
  });

  it("removes all reasoning when the latest assistant message is not a tool request", () => {
    const oldCall = call("call_old", "read_file");
    if (oldCall.role !== "assistant") throw new Error("expected assistant call");
    oldCall.reasoning_content = "old tool reasoning";
    const messages: ChatMessage[] = [
      oldCall,
      { role: "tool", tool_call_id: "call_old", name: "read_file", content: "result" },
      { role: "assistant", content: "finished", reasoning_content: "final reasoning" },
      { role: "user", content: "next request" },
    ];

    const projected = projectModelInputMessages(messages);
    assert.equal(
      projected.some((message) =>
        message.role === "assistant" && message.reasoning_content !== undefined
      ),
      false,
    );
  });

  it("excludes consumed reasoning from both pressure estimates and provider builds", () => {
    const consumedReasoning = "private".repeat(10_000);
    const messages: ChatMessage[] = [
      { role: "user", content: "first request" },
      { role: "assistant", content: "first answer", reasoning_content: consumedReasoning },
      { role: "user", content: "follow-up" },
    ];
    const state = stateWith(messages);
    const manager = new ContextManager();

    assert.ok(manager.estimateShortTermChars(state) < consumedReasoning.length / 10);
    const built = manager.build({ systemPrompt: "system", state, maxContextChars: 20_000 });
    const assistant = built.find((message) => message.role === "assistant");
    assert.equal(assistant?.role, "assistant");
    assert.equal(
      assistant?.role === "assistant" ? assistant.reasoning_content : undefined,
      undefined,
    );
    assert.equal(messages[1]?.role === "assistant" ? messages[1].reasoning_content : undefined,
      consumedReasoning);
  });

  it("bounds the retained active tool reasoning within the provider budget", () => {
    const activeCall = call("call_active", "run_command");
    if (activeCall.role !== "assistant") throw new Error("expected assistant call");
    activeCall.reasoning_content = "reasoning".repeat(2_000);
    const state = stateWith([
      { role: "user", content: "run the verification" },
      activeCall,
    ]);
    const built = new ContextManager().build({
      systemPrompt: "system",
      state,
      maxContextChars: 4_096,
    });
    const projectedCall = built.find((message) =>
      message.role === "assistant" && message.tool_calls?.[0]?.id === "call_active"
    );
    const requestChars = built.reduce((total, message) => {
      const toolCalls = message.role === "assistant" && message.tool_calls
        ? JSON.stringify(message.tool_calls).length
        : 0;
      const reasoning = message.role === "assistant"
        ? message.reasoning_content?.length ?? 0
        : 0;
      return total + (message.content?.length ?? 0) + toolCalls + reasoning + 32;
    }, 0);

    assert.equal(projectedCall?.role, "assistant");
    assert.ok(
      projectedCall?.role === "assistant" &&
      (projectedCall.reasoning_content?.length ?? 0) > 0,
    );
    assert.ok(
      projectedCall?.role === "assistant" &&
      (projectedCall.reasoning_content?.length ?? 0) < activeCall.reasoning_content.length,
    );
    assert.ok(requestChars <= 4_096);
  });
});
