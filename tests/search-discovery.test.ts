import { snapshotToolSet } from "../src/tools/catalog.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SearchFilesTool } from "../src/tools/search-files.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { defaultRuntimeLimits } from "../src/config/runtime-limits.js";
import { observeToolResult, parseProgressObservation } from "../src/progress/observation.js";
import { createProgressGuardState, foldProgressObservation } from "../src/progress/guard.js";
import { validateCommandRequest } from "../src/command/request-validation.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import { ContextManager } from "../src/context/manager.js";
import type { SessionState, ToolContext, ToolExecutionResult } from "../src/core/types.js";
import { describe, it } from "./harness.js";

const data = (result: ToolExecutionResult) => result.data as Record<string, any>;
async function fixture(run: (root: string, search: SearchFilesTool, context: ToolContext) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-discovery-"));
  try {
    const context: ToolContext = { workspaceRoot: root, mode: "code", threadId: "discovery", turnId: "turn",
      limits: defaultRuntimeLimits(), requestApproval: async () => { throw new Error("Listing must not ask for approval"); },
      commandTimeoutMs: 1000, maxOutputChars: 64000, approvalPolicy: "never" };
    await run(root, new SearchFilesTool(new WorkspaceManager(root)), context);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("project discovery regression", () => {
  it("lists one directory level without scanning environments or asking for command approval", async () => fixture(async (root, tool, ctx) => {
    await mkdir(path.join(root, "python", "Lib", "site-packages"), { recursive: true });
    await writeFile(path.join(root, "python", "Lib", "site-packages", "README.md"), "dependency");
    await writeFile(path.join(root, "README.md"), "project");
    const result = await tool.execute({ mode: "list" }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(data(result).matches.map((entry: any) => [entry.path, entry.kind]).sort(), [["README.md", "file"], ["python", "directory"]]);
    assert.equal(data(result).scannedEntries, 2);
    assert.equal(data(result).truncated, false);
    assert.match(result.summary, /Listed 2 entries/u);
  }));
  it("supports common brace filters and rejects unsupported glob syntax explicitly", async () => fixture(async (root, tool, ctx) => {
    await writeFile(path.join(root, "README.md"), "project");
    await writeFile(path.join(root, "package.json"), "{}");
    await writeFile(path.join(root, "code.ts"), "code");
    const result = await tool.execute({ glob: "*.{json,md,toml,yaml,yml}" }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(data(result).matches.map((entry: any) => entry.path).sort(), ["README.md", "package.json"]);
    for (const glob of ["*.{md,{json,txt}}", "*.{md}", "*.{md,}", "*.{md,json", "*.[jt]s", "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}", "{../x,*.md}"]) {
      assert.equal((await tool.execute({ glob }, ctx)).ok, false, glob);
    }
    assert.equal((await tool.execute({ mode: "list", query: "text" }, ctx)).ok, false);
  }));
  it("excludes dependency/cache trees but allows explicit inspection", async () => fixture(async (root, tool, ctx) => {
    for (const directory of ["python/Lib/site-packages", "python/Lib/dist-packages", ".cache", "cache"]) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, "README.md"), "dependency");
    }
    await writeFile(path.join(root, "README.md"), "project");
    const result = await tool.execute({ glob: "README*" }, ctx);
    assert.deepEqual(data(result).matches, [{ path: "README.md" }]);
    assert.equal(data(result).omissions.defaultExcluded, 4);
    const listed = data(await tool.execute({ mode: "list" }, ctx)).matches;
    assert.ok(listed.some((entry: any) => entry.path === "cache" && entry.excludedFromSearch === true));
    assert.equal(data(await tool.execute({ path: "python/Lib/site-packages", glob: "README*" }, ctx)).matches.length, 1);
  }));
  it("visits root files before descending and distinguishes depth/entry caps from absence", async () => fixture(async (root, tool, ctx) => {
    await mkdir(path.join(root, "aaa", "deep"), { recursive: true });
    await writeFile(path.join(root, "aaa", "deep", "README.md"), "deep");
    await writeFile(path.join(root, "README.md"), "root");
    const result = await tool.execute({ glob: "README*" }, { ...ctx, limits: { ...ctx.limits!, searchMaxEntries: 2 } });
    assert.deepEqual(data(result).matches, [{ path: "README.md" }]);
    assert.equal(data(result).stopReason, "entry_limit");
    assert.match(result.summary, /partial.*narrow path/u);
    const shallow = await tool.execute({ glob: "README*", maxDepth: 1 }, ctx);
    assert.deepEqual(data(shallow).matches, [{ path: "README.md" }]);
    assert.equal(data(shallow).omissions.depthLimited, 1);
    assert.equal(data(shallow).truncated, true);
    const limited = await tool.execute({ maxDepth: 100 }, { ...ctx, limits: { ...ctx.limits!, searchMaxDepth: 1 } });
    assert.equal(data(limited).maxDepth, 1);
  }));
  it("records bounded neutral search evidence, warns once repeated and rebuilds it by replay", async () => fixture(async (root, tool, ctx) => {
    const result = await tool.execute({ glob: "README*" }, ctx);
    const observations = [1, 2, 3].map((index) => observeToolResult({ sourceEventId: `event${index}`,
      sourceCallId: `call${index}`, scopeKey: "scope", responseOrdinal: index, tool: "search_files", result }));
    let state = createProgressGuardState();
    for (const observation of observations) {
      assert.equal(observation.kind, "neutral");
      assert.ok(JSON.stringify(observation).length < 1500);
      state = foldProgressObservation(state, observation).state;
    }
    assert.equal(state.searchWarning?.count, 3);
    assert.equal(state.incidents.length, 0);
    assert.equal(state.readCoverage.totalReads, 0);
    assert.deepEqual(state, observations.map((value) => parseProgressObservation(JSON.parse(JSON.stringify(value))))
      .reduce((previous, observation) => foldProgressObservation(previous, observation).state, createProgressGuardState()));
    assert.deepEqual(foldProgressObservation(state, observations[2]!).state.searchWarning, state.searchWarning);
    await writeFile(path.join(root, "README.md"), "new evidence");
    const changed = observeToolResult({ sourceEventId: "new", sourceCallId: "new", scopeKey: "scope", responseOrdinal: 4,
      tool: "search_files", result: await tool.execute({ glob: "README*" }, ctx) });
    state = foldProgressObservation(state, changed).state;
    assert.equal(state.searchWarning, undefined);
    assert.equal(state.recentSearches?.length, 1);
    assert.throws(() => parseProgressObservation({ ...changed, searchRepeatLimit: 1 }));
    assert.throws(() => parseProgressObservation({ ...changed, tool: "read_file" }));
  }));
  it("uses the configured repeat threshold and isolates task scopes", async () => fixture(async (_root, tool, ctx) => {
    const result = await tool.execute({ mode: "list" }, { ...ctx, limits: { ...ctx.limits!, searchRepeatWarningCount: 2 } });
    let state = createProgressGuardState();
    for (const [index, scopeKey] of ["a", "b", "a"].entries()) {
      state = foldProgressObservation(state, observeToolResult({ sourceEventId: `e${index}`, sourceCallId: `c${index}`,
        scopeKey, responseOrdinal: index, tool: "search_files", result })).state;
      if (index < 2) assert.equal(state.searchWarning, undefined);
    }
    assert.equal(state.searchWarning?.scopeKey, "a");
    assert.equal(state.searchWarning?.count, 2);
  }));
  it("offers a valid cmd builtin correction without weakening shell policy", () => {
    const failure = validateCommandRequest({ program: "cmd", args: ["/c", "dir", "/b"] });
    assert.match(failure!.recommendation, /search_files/u);
    assert.match(failure!.recommendation, /args=\["\/c", "dir \/b"\]/u);
    assert.equal(validateCommandRequest({ program: "cmd", args: ["/c", "dir /b"] }), undefined);
    assert.ok(validateCommandRequest({ program: "cmd", args: ["/k", "dir"] }));
  });
  it("injects the search hint into the next model request without a reviewer or task termination", async () => fixture(async (root, tool) => {
    const current: SessionState = { threadId: "discovery", mode: "code", provider: "qwen", model: "mock", thinkingEffort: "medium",
      workspaceRoot: root, constraints: [], messages: [], filesRead: new Map(), changes: [], commands: [],
      commandApprovalPrefixes: [], workingSummary: "", compactedMessageCount: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    let calls = 0;
    const runtime = new AgentRuntime({ limits: defaultRuntimeLimits(), toolCatalog: snapshotToolSet([tool]), contextManager: new ContextManager(),
      buildSystemPrompt: async () => "Inspect the project", getWorkspaceSummary: async () => "", searchMemories: async () => [],
      appendEvent: async () => undefined, requestApproval: async () => false,
      provider: { name: "qwen", model: "mock", complete: async (request) => {
        calls += 1;
        if (calls <= 3) return { message: { role: "assistant", content: null, tool_calls: [{ id: `search${calls}`, type: "function",
          function: { name: "search_files", arguments: '{"glob":"README*"}' } }] } };
        assert.match(request.messages.map((message) => message.content ?? "").join("\n"), /Runtime observed 3 identical searches/u);
        return { message: { role: "assistant", content: "No project description was found in the searched scope." } };
      } } });
    const result = await runtime.run(current, "What is this project?", { maxSteps: 5, maxContextChars: 250000,
      maxOutputChars: 16000, commandTimeoutMs: 1000, approvalPolicy: "never" });
    assert.equal(result.reason, "success");
    assert.equal(calls, 4);
    assert.equal(current.progressGuard?.incidents.length, 0);
  }));
});
