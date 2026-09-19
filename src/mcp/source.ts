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
  const content: { type: "text"; text: string }[] = [];
  let remaining = 48_000;
  let omitted = 0;
  for (const item of result.content) {
    if (item.type !== "text") { omitted++; continue; }
    if (remaining <= 0) { omitted++; continue; }
    const text = item.text.slice(0, remaining);
    remaining -= text.length;
    content.push({ type: "text", text });
    if (text.length !== item.text.length) omitted++;
  }
  if (omitted) content.push({ type: "text", text: `[${omitted} non-text or oversized MCP result item(s) omitted]` });
  return {
    ok: result.isError !== true,
    summary: result.isError ? "MCP tool returned an error" : "MCP tool completed",
    content,
  };
}

export function createMcpTool(serverId: string, tool: McpTool, client: Pick<Client, "callTool">): AgentTool {
  const name = toolName(serverId, tool.name);
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  if (!schema || schema.type !== "object" || JSON.stringify(schema).length > 32_000) {
    throw new Error(`MCP tool ${serverId}/${tool.name} has an unsupported input schema`);
  }
  const displayName = `${serverId}: ${tool.title ?? tool.name}`.replace(/[\u0000-\u001F\u007F]/gu, " ").slice(0, 256);
  const metadata: ToolRuntimeMetadata = {
    identity: { id: `mcp:${serverId}:${name}`, name, displayName,
      sourceId: "mcp", sourceKind: "external", sourceVersion: "1" },
    // Server annotations are untrusted. Every MCP call crosses approval.
    effects: ["external_write"], allowedModes: ["auto", "code"], allowedRoles: ["main_agent"],
    requiresOrchestration: false, requiresVision: false,
    validationSensitive: true, idempotent: false, controlPlane: false, resultClass: "generic",
  };
  return {
    name, metadata, mutating: true,
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

  async connect(serverId: string, config: McpServerConfig,
    approvedExecutableHash?: string, authProvider?: AuthProvider | OAuthClientProvider): Promise<number> {
    const existing = this.connections.get(serverId);
    if (existing) await this.disconnect(serverId);
    const transport = config.transport === "stdio"
      ? new SandboxedMcpStdioTransport(this.workspace, config, this.dataDir,
        undefined, approvedExecutableHash)
      : new RemoteMcpTransport(config, authProvider);
    const client = new Client({ name: "easy-code", version: "0.1.0" });
    try {
      await within(client.connect(transport), 30_000, "MCP handshake");
      const listing = await client.listTools(undefined, { timeout: 30_000 });
      if (listing.tools.length > 128) throw new Error("MCP server advertised more than 128 tools");
      if (JSON.stringify(listing.tools).length > 512_000) throw new Error("MCP server tool catalog is too large");
      const names = new Set<string>();
      for (const tool of listing.tools) {
        const wrapped = createMcpTool(serverId, tool, client);
        if (names.has(wrapped.name)) throw new Error(`Duplicate MCP tool name ${wrapped.name}`);
        names.add(wrapped.name);
      }
      this.connections.set(serverId, { client, transport, tools: listing.tools });
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
    return [...this.connections].filter(([, connection]) => connection.transport.isActive).flatMap(([id, connection]) =>
      connection.tools.map(tool => createMcpTool(id, tool, connection.client)));
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
