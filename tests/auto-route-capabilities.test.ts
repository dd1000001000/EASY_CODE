import assert from "node:assert/strict";
import type { AgentTool, BuiltinToolName } from "../src/core/types.js";
import { autoRouteCapabilitySummary } from "../src/runtime/auto-route-capabilities.js";
import { snapshotToolSet } from "./tool-set.js";
import { describe, it } from "./harness.js";

function tool(name: BuiltinToolName): AgentTool {
  return {
    name,
    mutating: false,
    definition: { type: "function", function: {
      name, description: `Fixture for ${name}`,
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
    } },
    async execute() { return { ok: true, summary: "fixture" }; },
  };
}

describe("Auto route capability summary", () => {
  it("describes capability categories and current conditions without exposing tool names", () => {
    const planTools = snapshotToolSet([
      tool("read_file"), tool("read_image"), tool("web_search"), tool("fetch_webpage"),
      tool("run_command"), tool("read_memory"), tool("propose_plan"),
    ]).tools;
    const codeTools = snapshotToolSet([
      tool("read_file"), tool("read_image"), tool("web_search"), tool("fetch_webpage"),
      tool("create_file"), tool("run_command"), tool("fetch_artifact"),
      tool("save_remote_mcp_server"), tool("manage_subagents"), tool("read_memory"),
    ]).tools;
    const summary = autoRouteCapabilitySummary({ planTools, codeTools, connectedMcpServers: 2 });
    const rendered = JSON.stringify(summary);
    assert.match(summary.planCapabilities, /Search the public Web/u);
    assert.match(summary.codeCapabilities, /Create, change, and remove/u);
    assert.match(summary.codeCapabilities, /task graphs/u);
    assert.match(summary.currentConditions, /Public Web search\/page reading: Plan and Code/u);
    assert.match(summary.currentConditions, /Connected MCP servers: 2/u);
    assert.doesNotMatch(rendered, /read_file|read_image|web_search|fetch_webpage|manage_subagents/u);
  });

  it("reports conditional capabilities as unavailable when filtering removed them", () => {
    const planTools = snapshotToolSet([tool("propose_plan")]).tools;
    const codeTools = snapshotToolSet([tool("read_file")]).tools;
    const summary = autoRouteCapabilitySummary({ planTools, codeTools, connectedMcpServers: 0 });
    assert.match(summary.currentConditions, /Public Web search\/page reading: unavailable/u);
    assert.match(summary.currentConditions, /Image understanding: unavailable/u);
    assert.match(summary.currentConditions, /Task graphs and child agents: unavailable/u);
    assert.match(summary.currentConditions, /Connected MCP servers: 0/u);
  });
});
