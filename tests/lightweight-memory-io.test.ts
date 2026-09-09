import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { SearchFilesTool } from "../src/tools/search-files.js";
import { ReadFileTool } from "../src/tools/read-file.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { ContextManager } from "../src/context/manager.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { projectToolResult } from "../src/tools/output-projection.js";
import { selectMemoryContext, optionalMemoryTokenBudget, expandedMemoryRecall } from "../src/context/memory-controller.js";
import { assertDurableMemory } from "../src/memory/admission.js";
import type { ChatMessage, LongTermMemory, SessionState, ToolContext, ToolExecutionResult } from "../src/core/types.js";

const limits = defaultRuntimeLimits();
function state(root = process.cwd()): SessionState {
  return { threadId: "lightweight-io", mode: "code", provider: "qwen", model: "mock", thinkingEffort: "medium",
    workspaceRoot: root, constraints: [], messages: [], filesRead: new Map(), changes: [], commands: [],
    commandApprovalPrefixes: [], workingSummary: "", compactedMessageCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
function context(root: string): ToolContext {
  return { workspaceRoot: root, mode: "code", threadId: "lightweight-io", turnId: "turn", limits,
    requestApproval: async () => false, commandTimeoutMs: 1000, maxOutputChars: 64000, approvalPolicy: "never" };
}
async function workspace(test: (root: string, manager: WorkspaceManager) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-light-io-"));
  try { await test(root, await WorkspaceManager.create(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const memory = (id: string, content: string) => ({ id, content, status: "active", category: "architecture" }) as LongTermMemory;
const evidence = (content: string, score = 1) => ({ id: "evidence", content, contentHash: "hash", score,
  source: "tool" as const, title: "read", messageIndex: 1 });
function command(text: string, status = "running", exitCode: number | null = null): ToolExecutionResult {
  return { ok: exitCode === 0 || status === "running", summary: "Command result", evidenceId: "evidence_test", data: {
    commandId: "command_00000000-0000-4000-8000-000000000001", status, exitCode,
    stdout: { text, totalBytes: Buffer.byteLength(text), truncated: false },
    stderr: { text: "", totalBytes: 0, truncated: false }, workspaceDelta: { created: [], updated: [], deleted: [], truncated: false },
  } };
}
function message(result: ToolExecutionResult): ChatMessage {
  return { role: "tool", name: "poll_command", tool_call_id: "poll", content: JSON.stringify(result) };
}
const data = (result: ToolExecutionResult) => result.data as Record<string, any>;

describe("lightweight optional memory", () => {
  it("starts with 2000 optional tokens and expands only within the configured capacity", () => {
    assert.equal(optionalMemoryTokenBudget(250000), 2000);
    assert.equal(optionalMemoryTokenBudget(250000, undefined, limits, true), Math.floor(250000 / 24));
    assert.equal(optionalMemoryTokenBudget(250000, 1000000, limits, true), 12000);
    assert.equal(optionalMemoryTokenBudget(250000, 16000, limits, true), 1280);
    assert.equal(expandedMemoryRecall(state()), false);
  });
  it("lets directly relevant evidence compete ahead of unrelated long-term records", () => {
    const result = selectMemoryContext({ state: state(), memories: [memory("old", "Project uses SQLite")],
      evidence: [evidence("Authentication JWT refresh expiration")], tokenBudget: 2000,
      queries: ["JWT refresh expiration"], limits: { ...limits, memoryMaxItems: 1 } });
    assert.equal(result.evidence.length, 1);
    assert.equal(result.memories.length, 0);
    assert.equal(selectMemoryContext({ state: state(), memories: [memory("old", "Uses SQLite")],
      evidence: [], tokenBudget: 2000, queries: ["JWT"] }).memories.length, 0);
  });
  it("deduplicates exact facts but not negations or distinct file versions", () => {
    const content = "Authentication tokens expire after 30 minutes";
    const selected = selectMemoryContext({ state: state(), memories: [memory("m", content)],
      evidence: [evidence(content)], tokenBudget: 2000 });
    assert.equal(selected.memories.length + selected.evidence.length, 1);
    assert.equal(selectMemoryContext({ state: state(), memories: [memory("m", content)], evidence: [],
      tokenBudget: 2000, presentText: [content] }).memories.length, 0);
    assert.equal(selectMemoryContext({ state: state(), memories: [memory("m", content)], evidence: [],
      tokenBudget: 2000, presentText: ["Authentication tokens do not expire after 30 minutes"] }).memories.length, 1);
    const first = { ...evidence(content), metadata: { filePath: "a.ts", fileHash: "v1", startOffset: 0, endOffset: 50, sourceTruncated: false } };
    assert.equal(selectMemoryContext({ state: state(), memories: [], evidence: [first,
      { ...first, id: "new", metadata: { ...first.metadata, fileHash: "v2" } }], tokenBudget: 2000 }).evidence.length, 2);
  });
  it("rejects task diaries without deleting or rewriting stable facts", () => {
    assert.throws(() => assertDurableMemory("This task changed authentication and 10 tests passed"), /Journal/u);
    assert.doesNotThrow(() => assertDurableMemory("The project uses SQLite for local persistence"));
    assert.throws(() => assertDurableMemory("a".repeat(1000), { ...limits, maxDurableMemoryTokens: 64 }), /maxDurableMemoryTokens/u);
  });
});

describe("bounded file discovery and coherent reads", () => {
  it("locates filenames and literal matches without granting read-before-write", async () => workspace(async (root, manager) => {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.ts"), "first\nfunction createRuntime() {}\nlast\n");
    const search = new SearchFilesTool(manager);
    const files = await search.execute({ glob: "**/*.ts" }, context(root));
    assert.equal(files.ok, true);
    assert.equal(data(files).matches[0].path, "src/a.ts");
    const hit = await search.execute({ path: "src", query: "createRuntime" }, context(root));
    assert.equal(data(hit).matches[0].line, 2);
    assert.equal(manager.getReadVersion("src/a.ts"), undefined);
    assert.equal((await search.execute({ path: "../outside" }, context(root))).ok, false);
    assert.equal((await search.execute({ glob: "../*.ts" }, context(root))).ok, false);
  }));
  it("skips defaults and reports omissions; explicit dependency targets remain readable", async () => workspace(async (root, manager) => {
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "node_modules", "a.txt"), "needle");
    await mkdir(path.join(root, ".easycode"));
    await writeFile(path.join(root, ".easycode", "config.toml"), "private");
    const search = new SearchFilesTool(manager);
    const normal = await search.execute({ query: "needle" }, context(root));
    assert.equal(data(normal).matches.length, 0);
    assert.ok(data(normal).omissions.defaultExcluded >= 2);
    assert.equal(data(await search.execute({ path: "node_modules", query: "needle" }, context(root))).matches.length, 1);
    assert.equal((await search.execute({ path: ".easycode/config.toml" }, context(root))).ok, false);
  }));
  it("bounds matches, scans, binary input and cancellation", async () => workspace(async (root, manager) => {
    await writeFile(path.join(root, "a.txt"), "needle\nneedle\nneedle");
    await writeFile(path.join(root, "b.bin"), Buffer.from([0, 1, 2]));
    const search = new SearchFilesTool(manager);
    const ctx = { ...context(root), limits: { ...limits, searchMaxMatches: 1 } };
    const result = await search.execute({ path: "a.txt", query: "needle" }, ctx);
    assert.equal(data(result).matches.length, 1);
    assert.equal(data(result).truncated, true);
    assert.equal(data(result).stopReason, "match_limit");
    assert.equal(data(await search.execute({ path: "b.bin", query: "needle" }, ctx)).omissions.binary, 1);
    const controller = new AbortController(); controller.abort();
    assert.equal((await search.execute({}, { ...ctx, signal: controller.signal })).ok, false);
    const tiny = await search.execute({ path: "a.txt", query: "needle" }, { ...ctx, resultCharBudget: 1024 });
    assert.equal(data(tiny).truncated, true);
    assert.equal(data(tiny).matches.length, 0);
  }));
  it("does not traverse symlinks or revive revoked host access", async () => workspace(async (root, manager) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "easy-search-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "needle");
      await symlink(outside, path.join(root, "linked"), "junction");
      const result = await new SearchFilesTool(manager).execute({ query: "needle" }, context(root));
      assert.equal(data(result).matches.length, 0);
      assert.equal(data(result).omissions.symlinks, 1);
      assert.equal((await new SearchFilesTool(manager).execute({ path: outside }, {
        ...context(root), commandExecutionMode: "unrestricted", isUnrestrictedHostAccessActive: () => false,
      })).ok, false);
    } finally { await rm(outside, { recursive: true, force: true }); }
  }));
  it("defaults to 100 lines, allows 1000, and returns whole lines with continuation metadata", async () => workspace(async (root, manager) => {
    await writeFile(path.join(root, "large.ts"), Array.from({ length: 1200 }, (_, index) => `const name${index} = ${index};`).join("\n"));
    const reader = new ReadFileTool(manager);
    assert.equal(data(await reader.execute({ path: "large.ts" }, context(root))).endLine, 100);
    const whole = await reader.execute({ path: "large.ts", endLine: 1200 }, context(root));
    assert.equal(data(whole).endLine, 1000);
    assert.equal(data(whole).nextStartLine, 1001);
    assert.ok(data(whole).content.length > 16000);
    const bounded = await reader.execute({ path: "large.ts", endLine: 1000 }, { ...context(root), resultTokenBudget: 512 });
    assert.ok(data(bounded).endLine < 100);
    assert.equal(data(bounded).content.split("\n").length, data(bounded).endLine);
    assert.equal(data(bounded).nextStartLine, data(bounded).endLine + 1);
    assert.equal(manager.getReadVersion("large.ts")?.hash, data(whole).contentHash);
  }));
  it("delivers large read bodies through Runtime without the generic 16000-char collapse", async () => workspace(async (root, manager) => {
    await writeFile(path.join(root, "large.ts"), Array.from({ length: 1000 }, (_, index) => `const name${index} = 'long but relevant code';`).join("\n"));
    let calls = 0;
    const current = state(root);
    const runtime = new AgentRuntime({ limits, tools: [new ReadFileTool(manager)], contextManager: new ContextManager(),
      buildSystemPrompt: async () => "Read code", getWorkspaceSummary: async () => "", searchMemories: async () => [],
      appendEvent: async () => undefined, requestApproval: async () => false,
      provider: { name: "qwen", model: "mock", complete: async (request) => {
        calls += 1;
        if (calls === 1) return { message: { role: "assistant", content: null, tool_calls: [{ id: "read", type: "function",
          function: { name: "read_file", arguments: '{"path":"large.ts","endLine":1000}' } }] } };
        const result = request.messages.find((item) => item.role === "tool")!;
        assert.ok(result.content!.length > 16000);
        const content = JSON.parse(result.content!).data;
        assert.ok(content.content.length > 16000);
        assert.ok(content.content.includes("name0"));
        return { message: { role: "assistant", content: "Inspected" } };
      } } });
    const result = await runtime.run(current, "Read the implementation", { maxSteps: 3, maxContextChars: 250000,
      maxOutputChars: 16000, commandTimeoutMs: 1000, approvalPolicy: "never" });
    assert.equal(result.reason, "success");
    assert.equal(calls, 2);
  }));
  it("reports an over-budget single line without granting a new read version", async () => workspace(async (root, manager) => {
    await writeFile(path.join(root, "single.txt"), "x".repeat(100000));
    const result = await new ReadFileTool(manager).execute({ path: "single.txt" }, context(root));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /no partial line/u);
    assert.equal(manager.getReadVersion("single.txt"), undefined);
  }));
});

describe("command result projections", () => {
  it("returns only append-only deltas and recovers from durable messages without altering raw evidence", () => {
    const raw = command("starting\n");
    const before = JSON.stringify(raw);
    const first = projectToolResult(raw, limits, { intent: "inspect" });
    assert.equal(JSON.stringify(raw), before);
    const history = JSON.parse(JSON.stringify([message(first)])) as ChatMessage[];
    const next = projectToolResult(command("starting\nnew line\n"), limits, { previousMessages: history });
    assert.equal(data(next).stdout.text, "new line\n");
    assert.equal(data(next).outputMode, "delta");
    const unchanged = projectToolResult(command("starting\nnew line\n"), limits, { previousMessages: [message(next)] });
    assert.equal(data(unchanged).stdout.text, "");
    assert.equal(data(unchanged).intent, "inspect");
  });
  it("falls back to marked snapshots for gaps, redaction changes and absent active cursors", () => {
    const first = projectToolResult(command("password=partial"), limits);
    const next = projectToolResult(command("[REDACTED]"), limits, { previousMessages: [message(first)] });
    assert.equal(data(next).outputGap, true);
    assert.equal(data(next).stdout.text, "[REDACTED]");
    const reset = projectToolResult(command("still running"), limits, { previousMessages: [] });
    assert.equal(data(reset).outputMode, "snapshot");
    const clipped = command("head ... tail"); (data(clipped).stdout as any).truncated = true;
    const projected = projectToolResult(clipped, limits, { previousMessages: [message(first)] });
    assert.equal(data(projected).outputGap, true);
    assert.equal(data(projected).stdout.truncated, true);
  });
  it("summarizes complete verification output but retains query answers and unknown/truncated output", () => {
    const log = "progress\n".repeat(1000) + "================ 12 passed in 1.00s ================\n";
    const result = projectToolResult(command(log, "exited", 0), limits, { intent: "test" });
    assert.match(data(result).stdout.text, /12 passed/u);
    assert.ok(data(result).stdout.text.length < 300);
    assert.equal(data(result).verificationSummary.framework, "pytest");
    assert.equal(data(result).verificationSummary.source, "reported_output_not_requirement_verification");
    const inspected = projectToolResult(command(log, "exited", 0), limits, { intent: "inspect" });
    assert.equal(data(inspected).verificationSummary, undefined);
    assert.ok(data(inspected).stdout.text.length > 2000);
    const noTests = projectToolResult(command("No tests found\n", "exited", 0), limits, { intent: "test" });
    assert.match(data(noTests).stdout.text, /No tests found/u);
    const raw = command(log, "exited", 0); data(raw).stdout.truncated = true;
    assert.equal(data(projectToolResult(raw, limits, { intent: "test" })).verificationSummary, undefined);
    assert.equal(data(projectToolResult(command("custom answer", "exited", 0), limits, { intent: "test" })).verificationSummary, undefined);
  });
  it("the first terminal result summarizes cumulative evidence, not just the last poll delta", () => {
    const early = "E AssertionError: expected 7, got 8\n";
    const first = projectToolResult(command(early), limits, { intent: "test" });
    const final = projectToolResult(command(early + "========== 1 failed in 1.00s ==========\n", "exited", 1), limits,
      { previousMessages: [message(first)] });
    assert.equal(data(final).outputMode, "terminal_snapshot");
    assert.match(data(final).stdout.text, /expected 7, got 8/u);
    assert.equal(data(final).exitCode, 1);
  });
});
