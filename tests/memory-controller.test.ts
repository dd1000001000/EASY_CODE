import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { tokenWindows } from "../src/memory/text-windows.js";
import { memoryQueries, selectMemoryContext } from "../src/context/memory-controller.js";
import { tokenBudget, requestTokens, budgetedRequest } from "../src/context/token-budget.js";
import { ContextArtifactIndex, renderPinnedCurrentState } from "../src/context/artifact-index.js";
import { runtimeContinuityMessage } from "../src/context/runtime-state.js";
import { MemoryManager } from "../src/memory/memory-manager.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { toolResultForModel } from "../src/tools/errors.js";
import { sha256 } from "../src/utils/hash.js";
import { ContextManager } from "../src/context/manager.js";
import { evaluateCompactionBenefit } from "../src/context/compaction-policy.js";
import type { EmbeddingProvider } from "../src/memory/vector-index.js";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "easy-code-memory-control-"));
  const storage = createStorage(directory);
  const state = new ThreadStore(storage).create({ threadId: "memory_control", workspaceRoot: directory,
    mode: "code", provider: "deepseek", model: "test", thinkingEffort: "high" });
  return { directory, storage, state, dispose() { storage.close(); rmSync(directory, { recursive: true, force: true }); } };
}

describe("unified memory control", () => {
  it("windows all text including tail facts and surrogate pairs within tokenizer capacity", () => {
    const source = "前文😀".repeat(130) + " needle-at-the-tail";
    const count = (value: string) => Array.from(value).length + 2;
    const windows = tokenWindows(source, count, 128);
    assert.equal(windows.map((window) => window.text).join(""), source);
    assert.ok(windows.every((window) => count(window.text) <= 128));
    assert.match(windows.at(-1)!.text, /needle-at-the-tail/u);
    assert.equal(windows[0]!.start, 0);
    for (let index = 1; index < windows.length; index += 1) assert.equal(windows[index]!.start, windows[index - 1]!.end);
  });

  it("uses distinct failure/path intents even when the user request is very long", () => {
    const f = fixture();
    try {
      f.state.goal = "goal ".repeat(1000);
      f.state.commands.push({ id: "command_1", program: "pytest", args: [], cwd: f.directory,
        status: "exited", exitCode: 1, summary: "unique_rollback_failure", timestamp: new Date().toISOString(), durationMs: 1 });
      const queries = memoryQueries(f.state, "request ".repeat(1000));
      assert.ok(queries.length <= 4);
      assert.ok(queries.every((query) => query.length <= 320));
      assert.ok(queries.some((query) => query.includes("unique_rollback_failure")));
    } finally { f.dispose(); }
  });

  it("indexes tokenizer-sized windows and excludes thinking from the retrieval corpus", async () => {
    const f = fixture();
    try {
      const provider: EmbeddingProvider = { dimension: 2, model: "test", revision: "1", pooling: "mean", version: 2,
        splitText: async (text) => tokenWindows(text, (value) => Array.from(value).length + 2, 128),
        embed: async (texts) => texts.map(() => Float32Array.from([1, 0])) };
      const content = "long source ".repeat(100) + "tail_fact";
      f.state.messages.push({ role: "assistant", content, reasoning_content: "never-index-this-thinking" });
      const index = new ContextArtifactIndex(f.storage, provider);
      const result = await index.checkpoint("workspace_test", f.state);
      assert.ok(result.indexedChunks > 5);
      const rows = f.storage.db.prepare<[], { content: string }>("SELECT content FROM context_artifacts ORDER BY chunk_index").all();
      assert.equal(rows.map((row) => row.content).join(""), content);
      assert.ok(rows.every((row) => Array.from(row.content).length + 2 <= 128));
      const hits = await index.search("workspace_test", f.state.threadId, "tail_fact", { beforeMessageIndex: 1 });
      assert.ok(hits.some((hit) => hit.content.includes("tail_fact")));
      assert.ok(hits.every((hit) => !hit.content.includes("never-index-this-thinking")));
      const store = new MemoryManager(f.storage).evidenceStore;
      const hit = hits.find((item) => item.content.includes("tail_fact"))!;
      const recalled = store.read("workspace_test", f.state.threadId, hit.id) as { content: string; historical: boolean };
      assert.equal(recalled.content, hit.content);
      assert.equal(recalled.historical, true);
      assert.throws(() => store.read("workspace_other", f.state.threadId, hit.id), /not found/u);
      assert.throws(() => store.read("workspace_test", "another_thread", hit.id), /not found/u);
      assert.throws(() => store.read("workspace_test", f.state.threadId, hit.id, hit.content.length + 1), /offset/u);
    } finally { f.dispose(); }
  });

  it("captures evidence before model clipping and supports scoped immutable paging", () => {
    const f = fixture();
    try {
      const manager = new MemoryManager(f.storage);
      const result = { ok: true, summary: "captured", data: { text: "x".repeat(10000) + "tail_fact" } };
      const id = manager.evidenceStore.capture("workspace_test", f.state.threadId, "call_1", "read_file", result);
      const projected = JSON.parse(toolResultForModel({ ...result, evidenceId: id }, 256));
      assert.equal(projected.evidenceId, id);
      assert.equal(projected.data.truncated, true);
      const read = manager.evidenceStore.read("workspace_test", f.state.threadId, id, 9900) as { content: string; sourceTruncated: boolean };
      assert.match(read.content, /tail_fact/u);
      assert.equal(read.sourceTruncated, false);
      assert.throws(() => manager.evidenceStore.read("different_workspace", f.state.threadId, id), /not found/u);
      assert.throws(() => manager.evidenceStore.read("workspace_test", "different_thread", id), /not found/u);
      assert.equal(manager.evidenceStore.capture("workspace_test", f.state.threadId, "call_1", "read_file", result), id);
      assert.throws(() => manager.evidenceStore.capture("workspace_test", f.state.threadId, "call_1", "read_file", { ...result, data: "changed" }), /collision/u);
    } finally { f.dispose(); }
  });

  it("validates memory sources, retains revisions, and excludes changed-file facts", async () => {
    const f = fixture();
    try {
      const manager = new MemoryManager(f.storage);
      const source = "export const database = 'sqlite';";
      writeFileSync(path.join(f.directory, "config.ts"), source);
      const ref = manager.evidenceStore.capture("workspace_test", f.state.threadId, "read_1", "read_file",
        { ok: true, summary: "config", data: { path: "config.ts", contentHash: sha256(source), content: source } });
      const input = { workspaceId: "workspace_test", threadId: f.state.threadId, turnId: "turn_1", sourceState: f.state,
        outcome: "success" as const, userInput: "Inspect the database", mutations: [{ action: "remember" as const,
          category: "architecture" as const, content: "The database configuration uses SQLite", reason: "Read configuration", sourceRefs: [ref] }] };
      const saved = manager.applyModelMutations(input);
      assert.equal(saved.applied, 1);
      assert.equal((await manager.searchHybrid("workspace_test", "SQLite", { workspaceRoot: f.directory })).length, 1);
      writeFileSync(path.join(f.directory, "config.ts"), "export const database = 'postgres';");
      assert.equal((await manager.searchHybrid("workspace_test", "SQLite", { workspaceRoot: f.directory })).length, 0);
      assert.equal(manager.get("workspace_test", saved.memoryIds[0]!)?.status, "needs_verification");
      const revisions = f.storage.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM memory_revisions").get();
      assert.equal(revisions?.n, 2);
      assert.throws(() => manager.applyModelMutations({ ...input, mutations: [{ ...input.mutations[0]!, sourceRefs: [] }] }), /sourceRefs/u);
      assert.throws(() => manager.applyModelMutations({ ...input, mutations: [{ ...input.mutations[0]!, sourceRefs: ["evidence_missing"] }] }), /missing/u);
    } finally { f.dispose(); }
  });

  it("shares an optional-data budget and excludes duplicate and stale evidence", () => {
    const f = fixture();
    try {
      f.state.filesRead.set("a.ts", { path: "a.ts", hash: "new", readAt: new Date().toISOString() });
      const hit = { id: "hit_1", source: "tool" as const, title: "Read a.ts", content: "old source", contentHash: "hash",
        messageIndex: 0, score: 1, metadata: { filePath: "a.ts", fileHash: "old", startOffset: 0, endOffset: 10, sourceTruncated: false } };
      const current = { ...hit, id: "hit_2", contentHash: "newhash", metadata: { ...hit.metadata, fileHash: "new" } };
      const selected = selectMemoryContext({ state: f.state, memories: [], evidence: [hit, current, current], tokenBudget: 1000 });
      assert.equal(selected.evidence.length, 1);
      assert.equal(selected.dropped.stale, 1);
      assert.equal(selected.dropped.duplicate, 1);
      assert.equal(selectMemoryContext({ state: f.state, memories: [], evidence: [current], tokenBudget: 1 }).evidence.length, 0);
    } finally { f.dispose(); }
  });

  it("renders control state only once while preserving its full authoritative copy", () => {
    const f = fixture();
    try {
      f.state.goal = "unique-current-goal";
      f.state.constraints = ["unique-current-constraint"];
      const continuity = runtimeContinuityMessage(f.state);
      const workspace = renderPinnedCurrentState(f.state, undefined, true);
      assert.match(continuity, /unique-current-goal/u);
      assert.match(continuity, /unique-current-constraint/u);
      assert.doesNotMatch(workspace, /unique-current-goal|unique-current-constraint/u);
    } finally { f.dispose(); }
  });

  it("budgets the full request and reserves future output and tool growth separately", () => {
    const budget = tokenBudget(32000);
    assert.equal(budget.inputCapacity + budget.outputReserve + budget.toolReserve + budget.safetyReserve, 32000);
    const plain = requestTokens([{ role: "assistant", content: "result" }]);
    const thinking = requestTokens([{ role: "assistant", content: "result", reasoning_content: "reasoning ".repeat(100) }]);
    assert.ok(thinking > plain);
    assert.throws(() => tokenBudget(2000), /4096/u);
    assert.equal(budgetedRequest({ messages: [], maxTokens: 256 }, budget).maxTokens, 256);
    assert.equal(budgetedRequest({ messages: [] }, budget).maxTokens, budget.outputReserve);
    assert.throws(() => budgetedRequest({ messages: [{ role: "user", content: "汉".repeat(40000) }] }, budget), /context_capacity_insufficient/u);
  });

  it("returns lexical evidence without waiting for background embedding and can close during backfill", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: EmbeddingProvider = { dimension: 2, model: "test", revision: "1", pooling: "mean", version: 2,
      embed: async (texts) => { await gate; return texts.map(() => Float32Array.from([1, 0])); } };
    const index = new ContextArtifactIndex(f.storage, provider, undefined, { backgroundVectors: true });
    try {
      f.state.messages.push({ role: "user", content: "A searchable historical deployment fact" });
      await index.checkpoint("workspace_test", f.state);
      const hits = await index.search("workspace_test", f.state.threadId, "deployment", { beforeMessageIndex: 1 });
      assert.equal(hits.length, 1);
      index.close();
      f.dispose();
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } catch (error) {
      release();
      throw error;
    }
  });

  it("rejects a compact-only win when restored memory would exceed the post-compaction target", () => {
    const f = fixture();
    try {
      f.state.messages.push({ role: "user", content: "history ".repeat(6000) });
      const manager = new ContextManager();
      manager.configureTokenBudget(16000);
      const input = { state: f.state, candidateMessages: f.state.messages, summary: "Verified work and pending tasks.",
        compactedMessageCount: 1, maxContextChars: 100000, historyEndExclusive: 1, required: true };
      assert.equal(evaluateCompactionBenefit(manager, { ...input,
        nextRequest: { systemPrompt: "rules", runtimeContext: "", tools: [] } }).accepted, true);
      const rejected = evaluateCompactionBenefit(manager, { ...input,
        nextRequest: { systemPrompt: "rules", runtimeContext: "汉".repeat(7000), tools: [] } });
      assert.equal(rejected.accepted, false);
      assert.equal(rejected.rejectionReason, "unsafe_post_compaction_pressure");
    } finally { f.dispose(); }
  });

  it("keeps accepted summary versions independently and makes them historical retrieval candidates", async () => {
    const f = fixture();
    try {
      const provider: EmbeddingProvider = { dimension: 2, model: "test", revision: "1", pooling: "mean", version: 2,
        embed: async (texts) => texts.map(() => Float32Array.from([1, 0])) };
      const index = new ContextArtifactIndex(f.storage, provider);
      f.state.messages.push({ role: "user", content: "Investigate deployment" });
      f.state.workingSummary = "Historical deployment uses blue-green releases";
      f.state.compactedMessageCount = 1;
      f.state.contextCompactionMetadata = { formatVersion: 2, sourceStartMessageIndex: 0,
        sourceEndMessageIndex: 1, compactedMessageCount: 1, sourceHistoryHash: `sha256:${sha256(JSON.stringify(f.state.messages))}`,
        acceptedAt: new Date().toISOString(), beforeProjectedChars: 10000, afterProjectedChars: 100,
        savedChars: 9900, savingsRatio: 0.99, postCompactionUtilization: 0.1, safeWaterlineReached: true };
      await index.checkpoint("workspace_test", f.state);
      await index.checkpoint("workspace_test", f.state);
      const count = () => f.storage.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM context_summary_snapshots").get()!.n;
      assert.equal(count(), 1);
      f.state.workingSummary = "Historical deployment has a verified rollback path";
      await index.checkpoint("workspace_test", f.state);
      assert.equal(count(), 2);
      const hits = await index.search("workspace_test", f.state.threadId, "blue-green", { beforeMessageIndex: 1 });
      assert.ok(hits.some((hit) => hit.metadata?.kind === "accepted_summary" && hit.content.includes("blue-green")));
    } finally { f.dispose(); }
  });
});
