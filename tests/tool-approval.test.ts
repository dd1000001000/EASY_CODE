import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Client, Tool as McpTool } from "@modelcontextprotocol/client";
import { EasyCodeApp } from "../src/app.js";
import { Terminal } from "../src/cli/terminal.js";
import { ApprovalQueue } from "../src/command/approval-agent.js";
import type { ToolContext } from "../src/core/types.js";
import { createMcpCatalogTools } from "../src/mcp/source.js";
import { createStorage } from "../src/storage/database.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { snapshotToolSet } from "../src/tools/catalog.js";
import { ToolExecutionGateway, type ToolExecutionAuthorizationRequest } from "../src/tools/execution-gateway.js";
import { toolApprovalIdentity } from "../src/tools/approval.js";
import { builtinToolMetadata, toolRequiresApproval } from "../src/tools/capabilities.js";
import { reviewToolApproval } from "../src/tools/approval-agent.js";
import { TaskBudget } from "../src/runtime/task-budget.js";
import { describe, it } from "./harness.js";

class ApprovalTerminal extends Terminal {
  readonly decisions: string[] = [];
  readonly titles: string[] = [];
  override async selectChoice(title: string): Promise<string | undefined> {
    this.titles.push(title);
    return this.decisions.shift();
  }
  override info(): void {}
}

function mcpFixture() {
  const calls: string[] = [];
  const client = { async callTool(input: { name: string }) {
    calls.push(input.name);
    return { content: [{ type: "text", text: input.name }] };
  } } as unknown as Pick<Client, "callTool">;
  const listed = ["get_accounts", "place_order"].map(name => ({ name,
    inputSchema: { type: "object" } })) as McpTool[];
  const tools = createMcpCatalogTools("robinhood", listed, client, "config-v1");
  const catalog = snapshotToolSet(tools);
  const gateway = new ToolExecutionGateway(catalog);
  const wrapper = tools[2]!;
  const prepare = (name: string, argumentsJson = "{}") => gateway.prepare(wrapper.name,
    JSON.stringify({ name, argumentsJson }))!;
  return { calls, tools, catalog, prepare };
}

function context(root: string, threadId: string): ToolContext {
  return { workspaceRoot: root, mode: "code", threadId, turnId: "turn_1",
    approvalPolicy: "safe", commandExecutionMode: "manual", requestApproval: async () => false,
    commandTimeoutMs: 1_000, maxOutputChars: 10_000 };
}

describe("tool approval identity and durable grants", () => {
  it("covers local workspace and configuration tools without a second command approval", () => {
    const requires = (name: "read_file" | "update_file" | "list_mcp_servers" | "run_command" | "compact_context") =>
      toolRequiresApproval({ name, mutating: false, metadata: builtinToolMetadata(name),
        definition: { type: "function", function: { name, description: name,
          parameters: { type: "object", properties: {} } } },
        execute: async () => ({ ok: true, summary: "done" }) });
    assert.equal(requires("read_file"), true);
    assert.equal(requires("update_file"), true);
    assert.equal(requires("list_mcp_servers"), true);
    assert.equal(requires("run_command"), false);
    assert.equal(requires("compact_context"), false);
  });

  it("keeps a local file read behind the same execution gateway", async () => {
    let executions = 0;
    const name = "read_file";
    const tool = { name, mutating: false, metadata: builtinToolMetadata(name),
      definition: { type: "function" as const, function: { name, description: name,
        parameters: { type: "object", properties: {} } } },
      execute: async () => { executions++; return { ok: true, summary: "read" }; } };
    const snapshot = snapshotToolSet([tool]);
    const prepared = new ToolExecutionGateway(snapshot).prepare(name, "{}")!;
    await assert.rejects(() => new ToolExecutionGateway(snapshot).invoke(prepared,
      context(process.cwd(), "thread")), /authorization bridge/u);
    assert.equal(executions, 0);
    const labels: string[] = [];
    const gateway = new ToolExecutionGateway(snapshot, async request => {
      labels.push(request.tool.name); return true;
    });
    assert.equal((await gateway.invoke(prepared, context(process.cwd(), "thread"))).ok, true);
    assert.deepEqual(labels, ["read_file"]);
    assert.equal(executions, 1);
  });

  it("shows concrete catalog operations and never shares a grant with another MCP tool", async () => {
    const fixture = mcpFixture();
    const read = fixture.prepare("get_accounts");
    const trade = fixture.prepare("place_order");
    const readIdentity = toolApprovalIdentity(read.tool, read.input, read.binding, "C:/workspace");
    const tradeIdentity = toolApprovalIdentity(trade.tool, trade.input, trade.binding, "C:/workspace");
    assert.equal(readIdentity.label, "robinhood / get_accounts");
    assert.equal(tradeIdentity.label, "robinhood / place_order");
    assert.notEqual(readIdentity.key, tradeIdentity.key);
    assert.notEqual(readIdentity.key, toolApprovalIdentity(read.tool, read.input,
      read.binding, "C:/different-workspace").key);
    const changed = snapshotToolSet(createMcpCatalogTools("robinhood", [
      { name: "get_accounts", inputSchema: { type: "object" } },
      { name: "place_order", inputSchema: { type: "object" } },
    ] as McpTool[], { callTool: async () => ({ content: [] }) } as never, "config-v2"));
    const newBinding = changed.bindings.get(read.tool.name);
    assert.notEqual(readIdentity.key, toolApprovalIdentity(changed.tools[2]!, read.input,
      newBinding, "C:/workspace").key);
  });

  it("offers once, same-tool, and reject without executing a denied call", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "easy-code-tool-approval-"));
    const storage = createStorage(directory);
    const threads = new ThreadStore(storage);
    const workspaceRoot = path.join(directory, "workspace");
    const first = threads.create({ threadId: "tool-thread", workspaceRoot,
      mode: "code", provider: "deepseek", model: "test" });
    const terminal = new ApprovalTerminal(new PassThrough(), new PassThrough());
    const app = Object.create(EasyCodeApp.prototype) as EasyCodeApp;
    const fixture = mcpFixture();
    Object.defineProperties(app, {
      state: { value: first, writable: true }, threadStore: { value: threads },
      terminal: { value: terminal }, approvalQueue: { value: new ApprovalQueue() },
      commandExecutionMode: { value: "manual", writable: true }, dirty: { value: false, writable: true },
    });
    const authorize = (app as unknown as { authorizeCatalogToolCall(request: Readonly<ToolExecutionAuthorizationRequest>): Promise<boolean> })
      .authorizeCatalogToolCall.bind(app);
    const gateway = new ToolExecutionGateway(fixture.catalog, authorize);
    const invoke = (name: string, argumentsJson = "{}") => gateway.invoke(fixture.prepare(name, argumentsJson),
      context(workspaceRoot, first.threadId));
    try {
      terminal.decisions.push("allow_same_tool", "reject", "allow_once");
      const labels: string[] = [];
      const prepared = fixture.prepare("get_accounts");
      await gateway.invoke(prepared, context(workspaceRoot, first.threadId), async (label, execute) => {
        labels.push(label); return execute();
      });
      assert.deepEqual(labels, ["robinhood / get_accounts"]);
      assert.equal((await invoke("get_accounts", '{"account":"other"}')).ok, true);
      assert.equal(terminal.titles.length, 1, "same-tool grant should cover different arguments");
      await assert.rejects(() => invoke("place_order"), /not authorized/u);
      assert.deepEqual(fixture.calls, ["get_accounts", "get_accounts"]);
      assert.equal((await invoke("place_order")).ok, true);
      assert.equal(terminal.titles.length, 3, "once approval is not reusable");
      assert.equal(threads.recover(first.threadId).toolApprovalGrants?.length, 1);
      const fresh = threads.create({ threadId: "another-thread", workspaceRoot,
        mode: "code", provider: "deepseek", model: "test" });
      Object.defineProperty(app, "state", { value: fresh });
      terminal.decisions.push("reject");
      await assert.rejects(() => gateway.invoke(prepared, context(workspaceRoot, fresh.threadId)), /not authorized/u);
      assert.equal(terminal.titles.length, 4);
      Object.defineProperty(app, "commandExecutionMode", { value: "auto_approve" });
      Object.defineProperty(app, "reviewCatalogToolApproval", { value: async () => ({
        decision: "reject", reason: "Ask the user", }), writable: true });
      terminal.decisions.push("allow_once");
      assert.equal((await gateway.invoke(fixture.prepare("place_order"), {
        ...context(workspaceRoot, fresh.threadId), commandExecutionMode: "auto_approve",
      })).ok, true);
      assert.equal(terminal.titles.length, 5, "reviewer rejection must fall back to the user");
      Object.defineProperty(app, "reviewCatalogToolApproval", { value: async () => ({
        decision: "allow_same_tool", reason: "Authorized read", }) });
      assert.equal((await gateway.invoke(prepared, {
        ...context(workspaceRoot, fresh.threadId), commandExecutionMode: "auto_approve",
      })).ok, true);
      assert.equal(terminal.titles.length, 5, "reviewer approval should not ask the user again");
      assert.equal(threads.recover(fresh.threadId).toolApprovalGrants?.length, 1);
    } finally {
      terminal.close(); storage.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not lose a child-thread grant when a stale Runtime checkpoint is saved", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "easy-code-tool-grant-"));
    const storage = createStorage(directory);
    try {
      const threads = new ThreadStore(storage);
      const state = threads.create({ threadId: "child", workspaceRoot: path.join(directory, "workspace"),
        mode: "code", provider: "deepseek", model: "test" });
      const key = `sha256:${"a".repeat(64)}`;
      threads.recordToolApprovalGrant(state.threadId, key);
      threads.save(state);
      assert.deepEqual(threads.recover(state.threadId).toolApprovalGrants, [key]);
    } finally {
      storage.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not execute when the reusable grant cannot be durably recorded", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "easy-code-tool-grant-failure-"));
    const storage = createStorage(directory);
    const threads = new ThreadStore(storage);
    const state = threads.create({ threadId: "grant-failure", workspaceRoot: path.join(directory, "workspace"),
      mode: "code", provider: "deepseek", model: "test" });
    const terminal = new ApprovalTerminal(new PassThrough(), new PassThrough());
    terminal.decisions.push("allow_same_tool");
    const app = Object.create(EasyCodeApp.prototype) as EasyCodeApp;
    Object.defineProperties(app, { state: { value: state }, threadStore: { value: threads },
      terminal: { value: terminal }, approvalQueue: { value: new ApprovalQueue() },
      commandExecutionMode: { value: "manual" } });
    const original = threads.recordToolApprovalGrant.bind(threads);
    threads.recordToolApprovalGrant = () => { throw new Error("journal unavailable"); };
    const fixture = mcpFixture();
    const authorize = (app as unknown as { authorizeCatalogToolCall(request: Readonly<ToolExecutionAuthorizationRequest>): Promise<boolean> })
      .authorizeCatalogToolCall.bind(app);
    try {
      const gateway = new ToolExecutionGateway(fixture.catalog, authorize);
      await assert.rejects(() => gateway.invoke(fixture.prepare("get_accounts"),
        context(state.workspaceRoot, state.threadId)), /journal unavailable/u);
      assert.deepEqual(fixture.calls, []);
      assert.deepEqual(threads.recover(state.threadId).toolApprovalGrants, []);
    } finally {
      threads.recordToolApprovalGrant = original;
      terminal.close(); storage.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps tool approval Agent decisions bounded and escalates rejection", async () => {
    const identity = { key: `sha256:${"b".repeat(64)}`, label: "robinhood / get_accounts",
      input: {}, effects: ["external_write"], description: "Get accounts" };
    for (const decision of ["allow_once", "allow_same_tool", "reject"] as const) {
      const result = await reviewToolApproval(identity, "Inspect accounts", {
        provider: { name: "deepseek", model: "test", complete: async () => ({ message: { role: "assistant",
          content: JSON.stringify({ decision, reason: "Checked user request" }) } }) },
        budget: new TaskBudget(1, 0), systemPrompt: "Review the operation",
        maxInputChars: 10_000, maxOutputTokens: 256,
      });
      assert.equal(result.decision, decision);
    }
  });
});
