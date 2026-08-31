import assert from "node:assert/strict";

import type { CommandRuntime } from "../src/command/runtime.js";
import type { TaskNode } from "../src/core/types.js";
import { loadPromptBundleCatalog } from "../src/prompt-bundle/index.js";
import { autoRouteToolDefinitions } from "../src/runtime/auto-router.js";
import type { MemoryManager } from "../src/memory/memory-manager.js";
import type { SubagentControl } from "../src/subagents/types.js";
import {
  CompactContextTool,
  CreateFileTool,
  DeleteFileTool,
  ManageMemoryTool,
  ManageSubagentsTool,
  ManageTasksTool,
  ProposePlanTool,
  ReadFileTool,
  ReadImageTool,
  RunCommandTool,
  SubmitTaskResultTool,
  UpdateFileTool,
  assertDocumentedToolSchema,
  computeToolDefinitionCatalogHash,
  documentToolSchema,
} from "../src/tools/index.js";
import type { WorkspaceManager } from "../src/workspace/manager.js";
import { describe, it } from "./harness.js";

function actualDefinitions() {
  const workspace = {} as WorkspaceManager;
  const task = {
    id: "bound_task",
    status: "in_progress",
    completionChecks: ["verified"],
  } as unknown as TaskNode;
  return [
    new CompactContextTool().definition,
    new CreateFileTool(workspace).definition,
    new DeleteFileTool(workspace).definition,
    new ManageMemoryTool({} as MemoryManager, workspace).definition,
    new ManageSubagentsTool({} as SubagentControl).definition,
    new ManageTasksTool().definition,
    new ProposePlanTool().definition,
    new ReadFileTool(workspace).definition,
    new ReadImageTool(workspace).definition,
    new RunCommandTool(workspace, {} as CommandRuntime).definition,
    new SubmitTaskResultTool(task).definition,
    new UpdateFileTool(workspace).definition,
    ...autoRouteToolDefinitions(),
  ];
}

describe("Prompt Bundle tool metadata", () => {
  it("strictly covers every property in all 14 actual tool schemas", () => {
    const definitions = actualDefinitions();
    const names = definitions.map((definition) => definition.function.name).sort();
    assert.deepEqual(names, [
      "compact_context",
      "create_file",
      "delete_file",
      "manage_memory",
      "manage_subagents",
      "manage_tasks",
      "propose_plan",
      "read_file",
      "read_image",
      "respond_directly",
      "run_command",
      "select_mode",
      "submit_task_result",
      "update_file",
    ]);
    assert.deepEqual(loadPromptBundleCatalog().listTools(), names);
    for (const definition of definitions) {
      assertDocumentedToolSchema(definition.function.name, definition.function);
      assert.match(
        loadPromptBundleCatalog().getTool(definition.function.name).contractVersion,
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u,
      );
    }
    assert.match(computeToolDefinitionCatalogHash(definitions), /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      computeToolDefinitionCatalogHash(definitions),
      computeToolDefinitionCatalogHash([...definitions].reverse()),
    );
  });

  it("rejects missing descriptions and descriptions for unknown schema keys", () => {
    assert.throws(
      () => documentToolSchema("read_file", {
        type: "object",
        properties: { path: { type: "string" }, rogue: { type: "string" } },
      }),
      /no description for schema property rogue/u,
    );
    assert.throws(
      () => documentToolSchema("read_file", {
        type: "object",
        properties: { path: { type: "string" } },
      }),
      /unknown schema properties: endLine, startLine/u,
    );
  });
});
