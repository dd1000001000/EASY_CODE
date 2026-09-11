import assert from "node:assert/strict";

import { ContextManager } from "../src/context/manager.js";
import type {
  AgentTool,
  ModelProvider,
  SessionState,
  ToolRuntimeMetadata,
} from "../src/core/types.js";
import { AgentRuntime } from "../src/runtime/agent.js";
import {
  availableAgentTools,
  builtinToolMetadata,
  isToolAvailable,
  evaluateToolPolicy,
  toolMetadata,
} from "../src/tools/capabilities.js";
import {
  StaticToolSource,
  ToolCatalog,
  snapshotToolSet,
} from "../src/tools/catalog.js";
import { ToolExecutionGateway } from "../src/tools/execution-gateway.js";
import { describe, it } from "./harness.js";

function definition(name: string, description = name) {
  return {
    type: "function" as const,
    function: { name, description, parameters: { type: "object", additionalProperties: false } },
  };
}

function builtin(name: string, mutating = false): AgentTool {
  return { name, mutating, definition: definition(name), execute: async () => ({ ok: true, summary: name }) };
}

function externalMetadata(name: string, sourceId = "fixture"): ToolRuntimeMetadata {
  return {
    identity: { id: `${sourceId}:${name}`, name, displayName: name, sourceId, sourceKind: "external", sourceVersion: "1" },
    effects: ["external_read"], allowedModes: ["auto", "code"], allowedRoles: ["main_agent"],
    taskWork: false, progressExperiment: false, requiresOrchestration: false, requiresVision: false,
    validationSensitive: false, idempotent: true, controlPlane: false, resultClass: "generic",
  };
}

function external(
  name: string,
  sourceId = "fixture",
  description = name,
  effects: ToolRuntimeMetadata["effects"] = ["external_read"],
): AgentTool {
  const metadata = externalMetadata(name, sourceId);
  return {
    name,
    mutating: false,
    metadata: { ...metadata, effects },
    definition: definition(name, description),
    execute: async (input) => ({ ok: true, summary: `${name}:${JSON.stringify(input)}` }),
  };
}

function state(): SessionState {
  const now = new Date().toISOString();
  return {
    threadId: "thread_dynamic_tool", mode: "code", provider: "fixture", model: "fixture",
    thinkingEffort: "low", workspaceRoot: process.cwd(), constraints: [], messages: [], filesRead: new Map(),
    changes: [], commands: [], commandApprovalPrefixes: [], workingSummary: "", compactedMessageCount: 0,
    createdAt: now, updatedAt: now,
  };
}

describe("extensible tool capabilities", () => {
  it("preserves the existing builtin mode and role boundaries declaratively", () => {
    const names = ["read_file", "read_image", "propose_plan", "manage_tasks", "submit_task_result"];
    const tools = names.map((name) => builtin(name));
    assert.deepEqual(availableAgentTools(tools, {
      mode: "plan", role: "main_agent", orchestrationAvailable: true, visionAvailable: true,
    }).map((tool) => tool.name), ["read_file", "read_image", "propose_plan"]);
    assert.deepEqual(availableAgentTools(tools, {
      mode: "code", role: "main_agent", orchestrationAvailable: true, visionAvailable: false,
    }).map((tool) => tool.name), ["read_file", "manage_tasks"]);
    assert.deepEqual(availableAgentTools(tools, {
      mode: "code", role: "subagent", orchestrationAvailable: false, visionAvailable: true,
    }).map((tool) => tool.name), ["read_file", "submit_task_result"]);
    assert.equal(builtinToolMetadata("run_command").validationSensitive, true);
    assert.equal(builtinToolMetadata("read_file").progressExperiment, true);
  });

  it("requires host-owned metadata for an external source and defaults legacy tools conservatively", async () => {
    const catalog = new ToolCatalog();
    catalog.registerSource(new StaticToolSource("fixture", [builtin("untrusted_dynamic")], "external"));
    await assert.rejects(() => catalog.snapshot(), /must have Runtime-owned capability metadata/u);

    const legacy = builtin("legacy_custom");
    assert.equal(toolMetadata(legacy).identity.sourceKind, "legacy");
    assert.equal(isToolAvailable(legacy, { mode: "plan", role: "main_agent", orchestrationAvailable: true }), false);
    assert.equal(isToolAvailable(legacy, { mode: "code", role: "subagent", orchestrationAvailable: true }), false);
    assert.equal(isToolAvailable(legacy, { mode: "code", role: "main_agent", orchestrationAvailable: true }), true);
    const writeTool = external("write_remote", "fixture", "write_remote", ["external_write"]);
    assert.equal(evaluateToolPolicy(writeTool, {
      mode: "code", role: "main_agent", orchestrationAvailable: true,
    }).requiresApproval, true);
  });
});

describe("dynamic ToolCatalog", () => {
  it("publishes stable ordered snapshots, bindings, and revisions", async () => {
    let description = "first";
    const catalog = new ToolCatalog();
    catalog.registerSource(new StaticToolSource("builtin", [builtin("read_file")]));
    catalog.registerSource({ id: "fixture", kind: "external", listTools: async () => [
      external("z_tool", "fixture"), external("a_tool", "fixture", description),
    ] });
    const first = await catalog.snapshot();
    assert.deepEqual(first.tools.map((tool) => tool.name), ["read_file", "a_tool", "z_tool"]);
    assert.equal(first.revision, 1);
    assert.equal(first.bindings.get("a_tool")?.sourceId, "fixture");
    assert.match(first.hash, /^sha256:[a-f0-9]{64}$/u);
    assert.match(first.bindings.get("a_tool")?.metadataHash ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.equal("set" in first.bindings, false);
    assert.notEqual(
      snapshotToolSet([external("one"), external("two")]).hash,
      snapshotToolSet([external("two"), external("one")]).hash,
    );
    const unchanged = await catalog.snapshot();
    assert.equal(unchanged.hash, first.hash);
    assert.equal(unchanged.revision, 1);
    description = "changed";
    const changed = await catalog.snapshot();
    assert.notEqual(changed.hash, first.hash);
    assert.equal(changed.revision, 2);
  });

  it("rejects duplicate model names across sources", async () => {
    const catalog = new ToolCatalog();
    catalog.registerSource(new StaticToolSource("fixture", [external("same")], "external"));
    catalog.registerSource(new StaticToolSource("second", [external("same", "second")], "external"));
    await assert.rejects(() => catalog.snapshot(), /Duplicate model-facing tool name same/u);
  });

  it("prepares and invokes a source-bound tool without knowing its name", async () => {
    const tool = external("future_connector_tool");
    const snapshot = snapshotToolSet([tool], 7);
    const gateway = new ToolExecutionGateway(snapshot);
    const prepared = gateway.prepare(tool.name, "{\"value\":1}");
    assert.ok(prepared);
    assert.equal(prepared.binding?.catalogRevision, 7);
    const result = await gateway.invoke(prepared, {
      workspaceRoot: process.cwd(), mode: "code", threadId: "thread", turnId: "turn",
      approvalPolicy: "never", requestApproval: async () => false,
      commandTimeoutMs: 1000, maxOutputChars: 1000,
    });
    assert.equal(result.summary, "future_connector_tool:{\"value\":1}");
  });

  it("fails closed for an external write until a Runtime authorization bridge is installed", async () => {
    let executions = 0;
    const base = external("future_write", "fixture", "future_write", ["external_write"]);
    const tool: AgentTool = { ...base, execute: async () => {
      executions += 1;
      return { ok: true, summary: "written" };
    } };
    const snapshot = snapshotToolSet([tool]);
    const prepared = new ToolExecutionGateway(snapshot).prepare(tool.name, "{}");
    assert.ok(prepared);
    const context = {
      workspaceRoot: process.cwd(), mode: "code" as const, threadId: "thread", turnId: "turn",
      approvalPolicy: "never" as const, requestApproval: async () => false,
      commandTimeoutMs: 1000, maxOutputChars: 1000,
    };
    await assert.rejects(
      () => new ToolExecutionGateway(snapshot).invoke(prepared, context),
      /requires a Runtime authorization bridge/u,
    );
    assert.equal(executions, 0);

    const authorized = new ToolExecutionGateway(snapshot, async (request) => {
      assert.equal(request.binding?.toolId, "fixture:future_write");
      return true;
    });
    assert.equal((await authorized.invoke(prepared, context)).summary, "written");
    assert.equal(executions, 1);
  });

  it("starts a dynamic source once and closes it once", async () => {
    let starts = 0;
    let closes = 0;
    const catalog = new ToolCatalog();
    catalog.registerSource({
      id: "fixture", kind: "external",
      start: async () => { starts += 1; },
      listTools: async () => [external("lifecycle_tool")],
      close: async () => { closes += 1; },
    });
    await catalog.snapshot();
    await catalog.snapshot();
    await catalog.close();
    assert.equal(starts, 1);
    assert.equal(closes, 1);
  });

  it("normalizes bounded rich content at the execution boundary", async () => {
    const base = external("rich_tool");
    const tool: AgentTool = { ...base, execute: async () => ({
      ok: true,
      summary: "rich",
      content: [
        { type: "text", text: "token sk-123456789012345678901234" },
        { type: "structured", value: { answer: 42 } },
        { type: "resource", uri: "https://example.test/item", title: "Item" },
      ],
    }) };
    const gateway = new ToolExecutionGateway(snapshotToolSet([tool]));
    const prepared = gateway.prepare(tool.name, "{}");
    assert.ok(prepared);
    const result = await gateway.invoke(prepared, {
      workspaceRoot: process.cwd(), mode: "code", threadId: "thread", turnId: "turn",
      approvalPolicy: "never", requestApproval: async () => false,
      commandTimeoutMs: 1000, maxOutputChars: 1000,
    });
    assert.doesNotMatch(JSON.stringify(result.content), /sk-123456789012345678901234/u);
    assert.deepEqual(result.content?.[1], { type: "structured", value: { answer: 42 } });
  });

  it("lets AgentRuntime expose and execute a dynamic external tool with an auditable binding", async () => {
    const tool = external("future_connector_tool");
    const catalog = snapshotToolSet([tool]);
    let calls = 0;
    const provider: ModelProvider = { name: "fixture", model: "fixture", complete: async (request) => {
      calls += 1;
      assert.deepEqual(request.tools?.map((item) => item.function.name), ["future_connector_tool"]);
      return calls === 1
        ? { message: { role: "assistant", content: null, tool_calls: [{
            id: "call_external", type: "function", function: { name: "future_connector_tool", arguments: "{}" },
          }] } }
        : { message: { role: "assistant", content: "done" } };
    } };
    const events: Array<{ type: string; payload: unknown }> = [];
    const runtime = new AgentRuntime({
      provider, tools: [], toolCatalog: catalog, contextManager: new ContextManager(),
      buildSystemPrompt: async () => "rules", getWorkspaceSummary: async () => "workspace",
      searchMemories: async () => [], appendEvent: async (event) => { events.push(event); },
      requestApproval: async () => false,
    });
    const result = await runtime.run(state(), "Use the dynamic tool", {
      maxSteps: 3, maxContextChars: 100_000, maxOutputChars: 8_000,
      commandTimeoutMs: 1_000, approvalPolicy: "never",
    });
    assert.equal(result.reason, "success");
    const toolResult = events.find((event) => event.type === "tool.result")?.payload as {
      toolBinding?: { toolId?: string; sourceId?: string; schemaHash?: string };
    };
    assert.equal(toolResult.toolBinding?.toolId, "fixture:future_connector_tool");
    assert.equal(toolResult.toolBinding?.sourceId, "fixture");
    assert.match(toolResult.toolBinding?.schemaHash ?? "", /^sha256:/u);
  });
});
