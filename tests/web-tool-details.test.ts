import assert from "node:assert/strict";
import type { AgentTool, SessionState, ToolExecutionResult } from "../src/core/types.js";
import { toolDisplayDetails } from "../src/runtime/tool-display-details.js";
import { describe, it } from "./harness.js";

const state = { taskGraph: { tasks: [{ id: "backend", title: "Inspect backend" }] } } as SessionState;
const result: ToolExecutionResult = { ok: true, summary: "done" };
const show = (name: string, input: unknown, output: ToolExecutionResult = result, tool?: AgentTool) =>
  toolDisplayDetails(tool, name, JSON.stringify(input), output, state);

describe("Web tool detail targets", () => {
  it("shows the requested file path for file and image operations", () => {
    for (const name of ["read_file", "create_file", "update_file", "delete_file", "read_image"]) {
      assert.deepEqual(show(name, { path: "src/components/Editor.vue", content: "private content" }), [
        { label: "File", value: "src/components/Editor.vue" },
      ]);
    }
    assert.deepEqual(show("search_files", { path: "src/components", query: "Editor" }), [
      { label: "Search path", value: "src/components" },
    ]);
  });

  it("shows a command while redacting credential arguments", () => {
    const details = show("run_command", { program: "ls", args: ["-l", "--token", "very-secret-value"] });
    assert.equal(details[0]?.value, "ls -l --token [REDACTED]");
    assert.ok(!JSON.stringify(details).includes("very-secret-value"));
  });

  it("uses the executed command for a poll and has a safe fallback", () => {
    assert.equal(show("poll_command", { commandId: "command_1" }, {
      ...result, data: { executed: { program: "npm", args: ["test"] } },
    })[0]?.value, "npm test");
    assert.equal(show("cancel_command", { commandId: "command_1" })[0]?.value, "Original command unavailable");
  });

  it("uses pre-change skill names and the requested scope", () => {
    assert.deepEqual(show("modify_skill", { name: "review-code", scope: "project" }), [
      { label: "Skill", value: "review-code" }, { label: "Scope", value: "project" },
    ]);
  });

  it("resolves task and subagent titles", () => {
    assert.equal(show("manage_tasks", { action: "complete", taskId: "backend" })[1]?.value, "Inspect backend");
    assert.equal(show("manage_subagents", { action: "spawn", taskId: "backend" })[1]?.value, "Inspect backend");
    assert.equal(show("submit_task_result", { outcome: "completed" }, {
      ...result, data: { taskId: "backend", taskTitle: "Inspect backend" },
    })[0]?.value, "Inspect backend");
  });

  it("shows the exact MCP server and invoked tool without arguments", () => {
    const tool = { metadata: { identity: {
      id: "mcp:robinhood:mcp_robinhood_catalog_call_123", sourceId: "mcp", displayName: "robinhood: catalog_call",
    } } } as AgentTool;
    assert.deepEqual(show("mcp_robinhood_catalog_call_123", {
      name: "get_accounts", argumentsJson: '{"access_token":"secret"}',
    }, result, tool), [
      { label: "MCP server", value: "robinhood" }, { label: "MCP tool", value: "get_accounts" },
    ]);
  });

  it("uses direct MCP identity rather than a same-named input field", () => {
    const tool = { metadata: { identity: {
      id: "mcp:robinhood:mcp_robinhood_get_accounts_123", sourceId: "mcp", displayName: "robinhood: Accounts",
    } }, approvalTarget: () => ({ name: "get_accounts", label: "robinhood / get_accounts" }) } as unknown as AgentTool;
    assert.equal(show("mcp_robinhood_get_accounts_123", { name: "misleading_argument" }, result, tool)[1]?.value,
      "get_accounts");
  });
});
