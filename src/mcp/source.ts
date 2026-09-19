import { createHash } from "node:crypto";
import { Client, type AuthProvider, type OAuthClientProvider, type Tool as McpTool } from "@modelcontextprotocol/client";
import type { AgentTool, ToolRuntimeMetadata, ToolExecutionResult } from "../core/types.js";
import { toolFailure } from "../tools/base.js";
import type { ToolSource } from "../tools/catalog.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { McpServerConfig } from "./config.js";
import { SandboxedMcpStdioTransport } from "./sandbox-stdio.js";
import { RemoteMcpTransport } from "./remote.js";

type ManagedTransport = SandboxedMcpStdioTransport | RemoteMcpTransport;

interface Connection {
  readonly client: Client;
  readonly transport: ManagedTransport;
  readonly tools: readonly McpTool[];
  readonly approvalVersion: string;
}

async function within<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toolName(serverId: string, name: string): string {
  const slug = `${serverId}_${name}`.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 42);
  const hash = createHash("sha256").update(`${serverId}\0${name}`).digest("hex").slice(0, 8);
  return `mcp_${slug}_${hash}`;
}

function boundedResult(result: Awaited<ReturnType<Client["callTool"]>>): ToolExecutionResult {
  const preview: string[] = [];
  let remaining = 48_000;
  let omitted = 0;
  for (const item of result.content) {
    if (item.type !== "text") { omitted++; continue; }
    if (remaining <= 0) { omitted++; continue; }
    const text = item.text.slice(0, remaining);
    remaining -= text.length;
    preview.push(text);
    if (text.length !== item.text.length) omitted++;
  }
  const content = [{ type: "text" as const, text: preview.join("") }];
  if (omitted) content.push({ type: "text", text: `[${omitted} MCP result item(s) not shown here; use the tool evidence ID with recall_context to read the complete result]` });
  return {
    ok: result.isError !== true,
    summary: `${result.isError ? "MCP tool returned an error" : "MCP tool completed"}${omitted ? "; complete result is available via evidenceId and recall_context" : ""}`,
    content,
    // The gateway captures data before its model-facing projection is clipped.
    // Do not silently discard large text, images, or structured MCP content.
    data: { mcpContent: result.content, structuredContent: result.structuredContent },
  };
}

export function createMcpTool(serverId: string, tool: McpTool, client: Pick<Client, "callTool">,
  approvalVersion = "1"): AgentTool {
  const name = toolName(serverId, tool.name);
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  if (!schema || schema.type !== "object" || JSON.stringify(schema).length > 32_000) {
    throw new Error(`MCP tool ${serverId}/${tool.name} has an unsupported input schema`);
  }
  const displayName = `${serverId}: ${tool.title ?? tool.name}`.replace(/[\u0000-\u001F\u007F]/gu, " ").slice(0, 256);
  const metadata: ToolRuntimeMetadata = {
    identity: { id: `mcp:${serverId}:${name}`, name, displayName,
      sourceId: "mcp", sourceKind: "external", sourceVersion: approvalVersion },
    // Server annotations are untrusted. Every MCP call crosses approval.
    effects: ["external_write"], allowedModes: ["auto", "code"], allowedRoles: ["main_agent"],
    requiresOrchestration: false, requiresVision: false,
    validationSensitive: true, idempotent: false, controlPlane: false, resultClass: "generic",
  };
  return {
    name, metadata, mutating: true,
    approvalTarget: input => ({ name: tool.name, label: `${serverId} / ${tool.name}`,
      description: tool.description, input }),
    definition: { type: "function", function: { name, description: String(tool.description || tool.title || tool.name).slice(0, 4096),
      parameters: schema, strict: false } },
    async execute(input): Promise<ToolExecutionResult> {
      try {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("MCP tool input must be an object");
        const result = await client.callTool({ name: tool.name, arguments: input as Record<string, unknown> },
          { timeout: 120_000 });
        return boundedResult(result);
      } catch (error) {
        return toolFailure(error, `MCP tool ${serverId}/${tool.name} failed`);
      }
    },
  };
}

/** A large catalog is searched on demand instead of being copied into every model request. */
export function createMcpCatalogTools(serverId: string, tools: readonly McpTool[],
  client: Pick<Client, "callTool">, approvalVersion = "1"): AgentTool[] {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const metadata = (name: string, mutating: boolean): ToolRuntimeMetadata => ({
    identity: { id: `mcp:${serverId}:${name}`, name, displayName: `${serverId}: ${name}`,
      sourceId: "mcp", sourceKind: "external", sourceVersion: approvalVersion },
    effects: [mutating ? "external_write" : "external_read"], allowedModes: ["auto", "code"],
    allowedRoles: ["main_agent"], requiresOrchestration: false, requiresVision: false,
    validationSensitive: mutating, idempotent: !mutating, controlPlane: false, resultClass: "generic",
  });
  const definition = (name: string, description: string, properties: Record<string, unknown>,
    required: string[] = []) => ({ type: "function" as const, function: { name, description,
      parameters: { type: "object", properties, required, additionalProperties: false }, strict: false } });
  const searchName = toolName(serverId, "catalog_search");
  const inspectName = toolName(serverId, "catalog_inspect");
  const callName = toolName(serverId, "catalog_call");
  return [
    { name: searchName, metadata: metadata(searchName, false), mutating: false,
      definition: definition(searchName, `Search available tools from MCP server ${serverId}.`, {
        query: { type: "string" }, offset: { type: "integer", minimum: 0 },
      }, ["query"]),
      async execute(input): Promise<ToolExecutionResult> {
        const args = input as { query?: unknown; offset?: unknown };
        if (typeof args?.query !== "string" ||
          (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0))) {
          return toolFailure(new Error("Expected query and nonnegative offset"), "MCP catalog search failed");
        }
        const query = args.query.toLowerCase();
        const found = tools.filter(tool => `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase().includes(query));
        const offset = Number(args.offset ?? 0);
        return { ok: true, summary: `Found ${found.length} matching MCP tools`, data: {
          tools: found.slice(offset, offset + 20).map(tool => ({ name: tool.name, title: tool.title,
            description: String(tool.description ?? "").slice(0, 300) })),
          nextOffset: offset + 20 < found.length ? offset + 20 : null, total: found.length,
        } };
      } },
    { name: inspectName, metadata: metadata(inspectName, false), mutating: false,
      definition: definition(inspectName, `Read a tool schema from MCP server ${serverId} in pages.`, {
        name: { type: "string" }, offset: { type: "integer", minimum: 0 },
      }, ["name"]),
      async execute(input): Promise<ToolExecutionResult> {
        const args = input as { name?: unknown; offset?: unknown };
        if (typeof args?.name !== "string" ||
          (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0))) {
          return toolFailure(new Error("Expected tool name and nonnegative offset"), "MCP tool inspection failed");
        }
        const tool = byName.get(args.name);
        if (!tool) return toolFailure(new Error("Unknown MCP tool"), "MCP tool inspection failed");
        const serialized = JSON.stringify({ name: tool.name, title: tool.title,
          description: tool.description, inputSchema: tool.inputSchema });
        const offset = Number(args.offset ?? 0);
        if (offset > serialized.length) return toolFailure(new Error("Offset exceeds tool schema"), "MCP tool inspection failed");
        const end = Math.min(serialized.length, offset + 12_000);
        return { ok: true, summary: `MCP tool schema ${tool.name}`, data: {
          content: serialized.slice(offset, end), offset, nextOffset: end < serialized.length ? end : null,
          totalChars: serialized.length,
        } };
      } },
    { name: callName, metadata: metadata(callName, true), mutating: true,
      approvalTarget: input => {
        const args = input as { name?: unknown; argumentsJson?: unknown };
        if (typeof args?.name !== "string" || !byName.has(args.name) || typeof args.argumentsJson !== "string") {
          throw new Error("Expected a known MCP tool name and JSON arguments");
        }
        const parsed: unknown = JSON.parse(args.argumentsJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("MCP tool arguments must be a JSON object");
        }
        return { name: args.name, label: `${serverId} / ${args.name}`,
          description: byName.get(args.name)?.description, input: parsed };
      },
      definition: definition(callName, `Call an inspected tool on MCP server ${serverId}; this requires approval.`, {
        name: { type: "string" }, argumentsJson: { type: "string" },
      }, ["name", "argumentsJson"]),
      async execute(input): Promise<ToolExecutionResult> {
        try {
          const args = input as { name?: unknown; argumentsJson?: unknown };
          if (typeof args?.name !== "string" || !byName.has(args.name) || typeof args.argumentsJson !== "string") {
            throw new Error("Expected a known MCP tool name and JSON arguments");
          }
          const parsed: unknown = JSON.parse(args.argumentsJson);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("MCP tool arguments must be a JSON object");
          }
          return boundedResult(await client.callTool({ name: args.name,
            arguments: parsed as Record<string, unknown> }, { timeout: 120_000 }));
        } catch (error) { return toolFailure(error, `MCP tool call on ${serverId} failed`); }
      } },
  ];
}

/** Connections are explicit user actions; catalog snapshots never launch servers. */
export class McpConnections {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly workspace: WorkspaceManager, private readonly dataDir?: string) {}

  hasConnections(): boolean { return this.connections.size > 0; }
  status(serverId: string): { connected: boolean; toolCount: number } {
    const connection = this.connections.get(serverId);
    return { connected: Boolean(connection?.transport.isActive),
      toolCount: connection?.transport.isActive ? connection.tools.length : 0 };
  }

  connectedServers(): ReadonlyArray<{ id: string; toolCount: number }> {
    return [...this.connections].filter(([, connection]) => connection.transport.isActive)
      .map(([id, connection]) => ({ id, toolCount: connection.tools.length }));
  }

  async connect(serverId: string, config: McpServerConfig,
    approvedExecutableHash?: string, authProvider?: AuthProvider | OAuthClientProvider): Promise<number> {
    const existing = this.connections.get(serverId);
    if (existing) await this.disconnect(serverId);
    const transport = config.transport === "stdio"
      ? new SandboxedMcpStdioTransport(this.workspace, config, this.dataDir,
        undefined, approvedExecutableHash)
      : new RemoteMcpTransport(config, authProvider);
    const client = new Client({ name: "easy-code", version: "0.1.0" }, { listMaxPages: 4096 });
    try {
      await within(client.connect(transport), 30_000, "MCP handshake");
      const listing = await client.listTools(undefined, { timeout: 30_000 });
      const names = new Set<string>();
      for (const tool of listing.tools) {
        if (names.has(tool.name)) throw new Error(`Duplicate MCP tool name ${tool.name}`);
        names.add(tool.name);
      }
      const { enabled: _enabled, ...approvalConfig } = config;
      const approvalVersion = `sha256:${createHash("sha256").update(JSON.stringify({ config: approvalConfig,
        tools: listing.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema,
          description: tool.description, annotations: tool.annotations })) })).digest("hex")}`;
      this.connections.set(serverId, { client, transport, tools: listing.tools, approvalVersion });
      transport.onDisconnected = () => { this.connections.delete(serverId); };
      return listing.tools.length;
    } catch (error) {
      let cleanupError: unknown;
      try { await transport.close(); } catch (failedCleanup) { cleanupError = failedCleanup; }
      await client.close().catch(() => undefined);
      if (cleanupError) throw new AggregateError([error, cleanupError], "MCP connection and cleanup failed");
      throw error;
    }
  }

  listTools(): AgentTool[] {
    return [...this.connections].filter(([, connection]) => connection.transport.isActive).flatMap(([id, connection]) => {
      const direct = connection.tools.length <= 48 && connection.tools.every(tool => {
        const schema = tool.inputSchema as Record<string, unknown> | undefined;
        return schema?.type === "object" && JSON.stringify(schema).length <= 32_000 &&
          String(tool.description || tool.title || tool.name).length <= 4096;
      });
      return direct ? connection.tools.map(tool => createMcpTool(id, tool, connection.client, connection.approvalVersion))
        : createMcpCatalogTools(id, connection.tools, connection.client, connection.approvalVersion);
    });
  }

  async disconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    this.connections.delete(serverId);
    try { await connection.transport.close(); }
    finally { await connection.client.close().catch(() => undefined); }
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.keys()].map(id => this.disconnect(id)));
  }
}

export class McpToolSource implements ToolSource {
  readonly id = "mcp";
  readonly kind = "external";
  readonly priority = 200;
  constructor(private readonly connections: McpConnections) {}
  async listTools(): Promise<readonly AgentTool[]> { return this.connections.listTools(); }
}
