import assert from "node:assert/strict";

import type { CommandRuntime } from "../src/command/runtime.js";
import type { DownloadBroker } from "../src/downloads/broker.js";
import type { TaskNode } from "../src/core/types.js";
import { loadPromptBundleCatalog } from "../src/prompt-bundle/index.js";
import { autoRouteToolDefinitions } from "../src/runtime/auto-router.js";
import type { MemoryManager } from "../src/memory/memory-manager.js";
import type { SubagentControl } from "../src/subagents/types.js";
import {
  CompactContextTool,
  CancelCommandTool,
  CreateFileTool,
  DeleteFileTool,
  FetchArtifactTool,
  MemoryToolSession,
  ManageSubagentsTool,
  DisableMcpServerTool,
  ListMcpServersTool,
  RemoveMcpServerTool,
  SaveLocalMcpServerTool,
  SaveRemoteMcpServerTool,
  ManageTasksTool,
  NameThreadTool,
  ProposePlanTool,
  PollCommandTool,
  ReadFileTool,
  ReadDocumentTool,
  ReadImageTool,
  ReadMemoryTool,
  RecallContextTool,
  SearchContextTool,
  RunCommandTool,
  SearchFilesTool,
  StartCommandTool,
  cancelCommandInputSchema,
  pollCommandInputSchema,
  runCommandInputSchema,
  startCommandInputSchema,
  SubmitTaskResultTool,
  SendParentMessageTool,
  UpdateFileTool,
  WriteMemoryTool,
  assertDocumentedToolSchema,
  computeToolDefinitionCatalogHash,
  documentToolSchema,
} from "../src/tools/index.js";
import type { WorkspaceManager } from "../src/workspace/manager.js";
import { describe, it } from "./harness.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import { McpConfigStore } from "../src/mcp/config.js";
import { SkillStore } from "../src/skills/store.js";
import { ThreadTitleStore } from "../src/threads/thread-title.js";
import type { EasyCodeStorage } from "../src/storage/database.js";
import { CreateSkillTool, DeleteSkillTool, ListSkillsTool, ModifySkillTool, ReadSkillTool } from "../src/tools/skill-tools.js";
import { WebSearchTool } from "../src/tools/web-search.js";
import { FetchWebpageTool } from "../src/tools/fetch-webpage.js";
import { DocumentConverter, ThreadDocumentService, ThreadResourceStore } from "../src/resources/index.js";

function actualDefinitions() {
  const workspace = {} as WorkspaceManager;
  const resourceStore = new ThreadResourceStore(process.cwd());
  const skills = new SkillStore(process.cwd());
  const memorySession = new MemoryToolSession();
  const task = {
    id: "bound_task",
    status: "in_progress",
    completionChecks: ["verified"],
  } as unknown as TaskNode;
  return [
    new CompactContextTool().definition,
    new CreateFileTool(workspace).definition,
    new CreateSkillTool(workspace, skills).definition,
    new DeleteFileTool(workspace).definition,
    new DeleteSkillTool(workspace, skills).definition,
    new FetchArtifactTool({} as DownloadBroker).definition,
    new FetchWebpageTool(workspace,
      new ThreadDocumentService(new DocumentConverter(process.cwd()), resourceStore)).definition,
    new ReadMemoryTool(workspace, memorySession).definition,
    new WriteMemoryTool({ limits: DEFAULT_RUNTIME_LIMITS } as MemoryManager, workspace, memorySession).definition,
    new ManageSubagentsTool({} as SubagentControl).definition,
    new ListMcpServersTool(workspace, new McpConfigStore()).definition,
    new ListSkillsTool(workspace, skills).definition,
    new ModifySkillTool(workspace, skills).definition,
    new SaveLocalMcpServerTool(workspace, new McpConfigStore()).definition,
    new SaveRemoteMcpServerTool(workspace, new McpConfigStore()).definition,
    new DisableMcpServerTool(workspace, new McpConfigStore()).definition,
    new RemoveMcpServerTool(workspace, new McpConfigStore()).definition,
    new ManageTasksTool().definition,
    new NameThreadTool(new ThreadTitleStore({} as EasyCodeStorage)).definition,
    new ProposePlanTool().definition,
    new ReadFileTool(workspace).definition,
    new ReadDocumentTool(workspace,
      new ThreadDocumentService(new DocumentConverter(process.cwd()), resourceStore)).definition,
    new ReadSkillTool(workspace, skills).definition,
    new ReadImageTool(workspace).definition,
    new RecallContextTool().definition,
    new SearchContextTool().definition,
    new SearchFilesTool(workspace).definition,
    new RunCommandTool(workspace, {} as CommandRuntime).definition,
    new StartCommandTool(workspace, {} as CommandRuntime).definition,
    new PollCommandTool(workspace, {} as CommandRuntime).definition,
    new CancelCommandTool(workspace, {} as CommandRuntime).definition,
    new SubmitTaskResultTool(task).definition,
    new SendParentMessageTool({ agentId: "child", childThreadId: "child_thread", parentThreadId: "parent_thread",
      taskId: "bound_task", taskTitle: "Bound task" }, () => {
      throw new Error("unused");
    }).definition,
    new UpdateFileTool(workspace).definition,
    new WebSearchTool(workspace).definition,
    ...autoRouteToolDefinitions(),
  ];
}

describe("Prompt Bundle tool metadata", () => {
  it("strictly covers every property in every actual tool schema", () => {
    const definitions = actualDefinitions();
    const names = definitions.map((definition) => definition.function.name).sort();
    assert.deepEqual(names, [
      "cancel_command",
      "compact_context",
      "create_file",
      "create_skill",
      "delete_file",
      "delete_skill",
      "disable_mcp_server",
      "fetch_artifact",
      "fetch_webpage",
      "list_mcp_servers",
      "list_skills",
      "manage_subagents",
      "manage_tasks",
      "modify_skill",
      "name_thread",
      "poll_command",
      "propose_plan",
      "read_document",
      "read_file",
      "read_image",
      "read_memory",
      "read_skill",
      "recall_context",
      "remove_mcp_server",
      "respond_directly",
      "run_command",
      "save_local_mcp_server",
      "save_remote_mcp_server",
      "search_context",
      "search_files",
      "select_mode",
      "send_parent_message",
      "start_command",
      "submit_task_result",
      "update_file",
      "web_search",
      "write_memory",
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

  it("documents properties nested in JSON Schema composition branches", () => {
    const documented = documentToolSchema("read_file", {
      allOf: [
        {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: ["path"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: { startLine: { type: "integer" } },
              required: ["startLine"],
            },
          ],
        },
        {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: { endLine: { type: "integer" } },
              required: ["endLine"],
            },
          ],
        },
      ],
    });
    const parameters = documented.parameters as {
      allOf: Array<{
        oneOf?: Array<{ properties: Record<string, { description?: string }> }>;
        anyOf?: Array<{ properties: Record<string, { description?: string }> }>;
      }>;
    };

    assert.equal(
      typeof parameters.allOf[0]?.oneOf?.[0]?.properties.path?.description,
      "string",
    );
    assert.equal(
      typeof parameters.allOf[0]?.oneOf?.[1]?.properties.startLine?.description,
      "string",
    );
    assert.equal(
      typeof parameters.allOf[1]?.anyOf?.[0]?.properties.endLine?.description,
      "string",
    );
    assertDocumentedToolSchema("read_file", documented);
  });

  it("publishes flat provider-compatible command lifecycle schemas", () => {
    const workspace = {} as WorkspaceManager;
    const runtime = {} as CommandRuntime;
    const functions = [
      new RunCommandTool(workspace, runtime).definition.function,
      new StartCommandTool(workspace, runtime).definition.function,
      new PollCommandTool(workspace, runtime).definition.function,
      new CancelCommandTool(workspace, runtime).definition.function,
    ];
    for (const functionDefinition of functions) {
      const parameters = functionDefinition.parameters as {
        type: string;
        additionalProperties: boolean;
        properties: Record<string, { enum?: string[]; description?: string }>;
        required: string[];
        oneOf?: unknown;
        anyOf?: unknown;
        allOf?: unknown;
      };
      assert.equal(parameters.type, "object");
      assert.equal(parameters.additionalProperties, false);
      assert.equal(parameters.oneOf, undefined);
      assert.equal(parameters.anyOf, undefined);
      assert.equal(parameters.allOf, undefined);
      for (const property of Object.values(parameters.properties)) {
        assert.equal(typeof property.description, "string");
        assert.notEqual(property.description, "");
      }
      assertDocumentedToolSchema(functionDefinition.name, functionDefinition);
    }
    assert.deepEqual(functions.map((item) => item.name), [
      "run_command",
      "start_command",
      "poll_command",
      "cancel_command",
    ]);
    assert.deepEqual(
      [...Object.keys((functions[0]?.parameters as { properties: object }).properties), "backgroundKind"],
      Object.keys((functions[1]?.parameters as { properties: object }).properties),
    );
    assert.deepEqual(
      (functions[1]?.parameters as { properties: Record<string, { enum?: string[] }> }).properties.backgroundKind?.enum,
      ["job", "service"],
    );
    assert.deepEqual(
      (functions[0]?.parameters as { required: string[] }).required,
      (functions[1]?.parameters as { required: string[] }).required,
    );
    assert.deepEqual(
      Object.keys((functions[2]?.parameters as { properties: object }).properties).sort(),
      ["commandId", "waitMs"],
    );
    assert.deepEqual(
      Object.keys((functions[3]?.parameters as { properties: object }).properties),
      ["commandId"],
    );

    const commandId = "command_00000000-0000-4000-8000-000000000000";
    assert.equal(runCommandInputSchema.safeParse({
      program: "node",
      args: ["--version"],
      intent: "inspect",
    }).success, true);
    assert.equal(startCommandInputSchema.safeParse({
      program: "node",
      intent: "test",
    }).success, true);
    assert.equal(runCommandInputSchema.safeParse({
      program: "npm",
      args: ["run", "lint"],
      intent: "verify",
      verificationKind: "lint",
    }).success, true);
    assert.equal(runCommandInputSchema.safeParse({
      program: "npm",
      args: ["test"],
      intent: "verify",
    }).success, true, "verify defaults to custom without a correction call");
    assert.equal(runCommandInputSchema.safeParse({
      program: "node",
      args: ["--version"],
      intent: "inspect",
      verificationKind: "smoke_test",
    }).success, true, "inapplicable verification metadata is ignored, not an execution error");
    const runParameters = functions[0]?.parameters as {
      properties: Record<string, { enum?: string[] }>;
    };
    assert.ok(runParameters.properties.intent?.enum?.includes("verify"));
    assert.deepEqual(runParameters.properties.verificationKind?.enum, [
      "unit_test",
      "integration_test",
      "build",
      "typecheck",
      "lint",
      "format_check",
      "smoke_test",
      "benchmark",
      "custom",
    ]);
    assert.equal(pollCommandInputSchema.safeParse({ commandId, waitMs: 30_000 }).success, true);
    assert.equal(cancelCommandInputSchema.safeParse({ commandId }).success, true);
    for (const input of [
      { action: "run", program: "node", intent: "inspect" },
      { action: "start", program: "node", intent: "test" },
      { action: "status", commandId },
      { action: "cancel", commandId },
    ]) {
      assert.equal(runCommandInputSchema.safeParse(input).success, false, JSON.stringify(input));
    }
  });
});
