import { z } from "zod";
import type { AgentTool, ToolContext, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import { McpConfigStore } from "../mcp/config.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace, toolFailure, toolSuccess } from "./base.js";
import { documentToolSchema } from "./metadata.js";

const serverId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const envReferenceSchema = z.object({
  name: envName,
  source: z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/u),
}).strict();

const listInputSchema = z.object({}).strict();
const idInputSchema = z.object({ id: serverId }).strict();
const saveLocalInputSchema = z.object({
  id: serverId,
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.array(envReferenceSchema).optional(),
}).strict();
const saveRemoteInputSchema = z.object({
  id: serverId,
  transport: z.enum(["http", "sse"]),
  url: z.string().url(),
  auth: z.enum(["none", "bearer", "oauth"]).optional(),
  bearerTokenEnvVar: envName.optional(),
}).strict();

const idProperty = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" };

function definition(name: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      strict: false,
      ...documentToolSchema(name, {
        type: "object", additionalProperties: false, properties, required,
      }),
    },
  };
}

abstract class McpConfigTool {
  constructor(
    protected readonly workspace: WorkspaceManager,
    protected readonly store: McpConfigStore,
    protected readonly onChanged?: (id: string) => Promise<void>,
  ) {}

  protected async assertAccess(context: ToolContext): Promise<void> {
    await assertMatchingWorkspace(this.workspace, context);
    if (context.agentRole && context.agentRole !== "main_agent") {
      throw new Error("Only the main agent may manage user MCP configuration");
    }
  }
}

/** Read-only configuration listing; never starts or enables a server. */
export class ListMcpServersTool extends McpConfigTool implements AgentTool {
  readonly name = "list_mcp_servers" as const;
  readonly mutating = false;
  readonly inputSchema = listInputSchema;
  readonly definition = definition(this.name, {}, []);

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await this.assertAccess(context);
      this.inputSchema.parse(input);
      const config = await this.store.read();
      return toolSuccess("Listed user MCP servers without starting them", {
        servers: Object.entries(config.servers).map(([id, server]) => ({
          id, transport: server.transport,
          ...(server.transport === "stdio"
            ? { command: server.command, args: server.args, cwd: server.cwd, env: Object.keys(server.env) }
            : { url: server.url, auth: server.auth, bearerTokenEnvVar: server.bearerTokenEnvVar }),
          enabled: server.enabled,
        })),
      });
    } catch (error) {
      return toolFailure(error, "MCP configuration listing failed");
    }
  }
}

/** Save a disabled local server; execution still requires a separate /mcp approval. */
export class SaveLocalMcpServerTool extends McpConfigTool implements AgentTool {
  readonly name = "save_local_mcp_server" as const;
  readonly mutating = true;
  readonly inputSchema = saveLocalInputSchema;
  readonly definition = definition(this.name, {
    id: idProperty,
    command: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    cwd: { type: "string", minLength: 1 },
    env: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: { name: { type: "string" }, source: { type: "string" } },
        required: ["name", "source"],
      },
    },
  }, ["id", "command"]);

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await this.assertAccess(context);
      const request = this.inputSchema.parse(input);
      const env: Record<string, string> = {};
      for (const item of request.env ?? []) {
        if (item.name in env) throw new Error(`Duplicate environment name ${item.name}`);
        env[item.name] = item.source;
      }
      await this.store.upsert(request.id, { transport: "stdio", command: request.command,
        args: request.args ?? [], cwd: request.cwd ?? ".", env });
      await this.onChanged?.(request.id);
      return toolSuccess(`Saved MCP server ${request.id} as disabled; user activation is required before it can run`);
    } catch (error) {
      return toolFailure(error, "MCP configuration change failed");
    }
  }
}

/** Save a disabled remote server; authorization and connection remain user-controlled. */
export class SaveRemoteMcpServerTool extends McpConfigTool implements AgentTool {
  readonly name = "save_remote_mcp_server" as const;
  readonly mutating = true;
  readonly inputSchema = saveRemoteInputSchema;
  readonly definition = definition(this.name, {
    id: idProperty,
    transport: { type: "string", enum: ["http", "sse"] },
    url: { type: "string", format: "uri" },
    auth: { type: "string", enum: ["none", "bearer", "oauth"] },
    bearerTokenEnvVar: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
  }, ["id", "transport", "url"]);

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await this.assertAccess(context);
      const request = this.inputSchema.parse(input);
      await this.store.upsert(request.id, { transport: request.transport, url: request.url,
        auth: request.auth ?? "none", bearerTokenEnvVar: request.bearerTokenEnvVar });
      await this.onChanged?.(request.id);
      return toolSuccess(`Saved MCP server ${request.id} as disabled; user activation is required before it can run`);
    } catch (error) {
      return toolFailure(error, "MCP configuration change failed");
    }
  }
}

export class DisableMcpServerTool extends McpConfigTool implements AgentTool {
  readonly name = "disable_mcp_server" as const;
  readonly mutating = true;
  readonly inputSchema = idInputSchema;
  readonly definition = definition(this.name, { id: idProperty }, ["id"]);

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await this.assertAccess(context);
      const { id } = this.inputSchema.parse(input);
      await this.store.setEnabled(id, false);
      await this.onChanged?.(id);
      return toolSuccess(`Disabled MCP server ${id}`);
    } catch (error) {
      return toolFailure(error, "MCP configuration change failed");
    }
  }
}

export class RemoveMcpServerTool extends McpConfigTool implements AgentTool {
  readonly name = "remove_mcp_server" as const;
  readonly mutating = true;
  readonly inputSchema = idInputSchema;
  readonly definition = definition(this.name, { id: idProperty }, ["id"]);

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await this.assertAccess(context);
      const { id } = this.inputSchema.parse(input);
      await this.store.remove(id);
      await this.onChanged?.(id);
      return toolSuccess(`Removed MCP server ${id}`);
    } catch (error) {
      return toolFailure(error, "MCP configuration change failed");
    }
  }
}
