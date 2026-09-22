import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client, type AuthProvider, type CallToolResult, type OAuthClientProvider,
  type CreateMessageRequest, type CreateMessageResult, type ElicitRequest, type ElicitResult,
  type Prompt, type Resource, type ResourceTemplateType, type Tool as McpTool,
} from "@modelcontextprotocol/client";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import type { AgentTool, ToolContext, ToolContent, ToolExecutionResult, ToolRuntimeMetadata } from "../core/types.js";
import { toolFailure } from "../tools/base.js";
import type { ToolSource } from "../tools/catalog.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { McpServerConfig } from "./config.js";
import { RemoteMcpTransport } from "./remote.js";
import { SandboxedMcpStdioTransport } from "./sandbox-stdio.js";

type ManagedTransport = SandboxedMcpStdioTransport | RemoteMcpTransport;
interface Connection {
  readonly client: Client;
  readonly transport: ManagedTransport;
  readonly serverVersion: string;
  tools: McpTool[];
  prompts: Prompt[];
  resources: Resource[];
  resourceTemplates: ResourceTemplateType[];
  supportsPrompts: boolean;
  supportsResources: boolean;
}
interface DesiredConnection {
  readonly config: McpServerConfig;
  readonly approvedExecutableHash?: string;
  readonly authProvider?: AuthProvider | OAuthClientProvider;
  failures: number;
}
export interface McpConnectionEvents {
  onCatalogChanged?: (serverId: string) => void;
  onProgress?: (serverId: string, update: { message?: string; progress?: number; total?: number }) => void;
  onLog?: (serverId: string, message: unknown) => void;
  onReconnectError?: (serverId: string, error: unknown) => void;
  onSampling?: (serverId: string, params: CreateMessageRequest["params"]) => Promise<CreateMessageResult>;
  onElicitation?: (serverId: string, params: ElicitRequest["params"]) => Promise<ElicitResult>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function serverContract(config: McpServerConfig): string {
  const { enabled: _enabled, ...contract } = config;
  return hash(contract);
}
function toolContract(serverVersion: string, tool: McpTool): string {
  return hash({ serverVersion, name: tool.name, inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema, description: tool.description, annotations: tool.annotations });
}
function toolName(serverId: string, name: string): string {
  const slug = `${serverId}_${name}`.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 42);
  const suffix = createHash("sha256").update(`${serverId}\0${name}`).digest("hex").slice(0, 8);
  return `mcp_${slug}_${suffix}`;
}
function requestOptions(context: ToolContext) {
  return {
    timeout: context.limits?.mcpIdleTimeoutMs ?? DEFAULT_RUNTIME_LIMITS.mcpIdleTimeoutMs,
    resetTimeoutOnProgress: true,
    ...(context.signal ? { signal: context.signal } : {}),
    onprogress: (update: { progress: number; total?: number; message?: string }) => {
      context.reportProgress?.({ progress: update.progress,
        ...(typeof update.total === "number" ? { total: update.total } : {}),
        ...(typeof update.message === "string" ? { message: update.message } : {}) });
    },
  };
}
function imageExtension(mimeType: string): string | undefined {
  return ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" } as
    Record<string, string>)[mimeType.toLowerCase()];
}

/** Preserve the complete MCP result in evidence while materializing supported rich content. */
async function mcpResult(result: CallToolResult, context: ToolContext): Promise<ToolExecutionResult> {
  const content: ToolContent[] = [];
  const imageAttachments = [];
  let temporaryDirectory: string | undefined;
  try {
    for (let index = 0; index < result.content.length; index++) {
      const item = result.content[index] as unknown;
      if (!object(item) || typeof item.type !== "string") continue;
      if (item.type === "text" && typeof item.text === "string") {
        content.push({ type: "text", text: item.text });
      } else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
        const extension = imageExtension(item.mimeType);
        if (extension && context.attachImage) {
          temporaryDirectory ??= await mkdtemp(path.join(os.tmpdir(), "easy-code-mcp-"));
          const filename = path.join(temporaryDirectory, `image-${index}${extension}`);
          await writeFile(filename, Buffer.from(item.data, "base64"), { flag: "wx", mode: 0o600 });
          const attachment = await context.attachImage({ absolutePath: filename,
            sourceName: `mcp-image-${index}${extension}` });
          imageAttachments.push(attachment);
          content.push({ type: "image", attachmentId: attachment.id });
        } else {
          content.push({ type: "structured", value: { type: "image", mimeType: item.mimeType,
            byteLength: Buffer.byteLength(item.data, "base64"), storedInEvidence: true } });
        }
      } else if (item.type === "audio" && typeof item.data === "string") {
        content.push({ type: "structured", value: { type: "audio", mimeType: item.mimeType,
          byteLength: Buffer.byteLength(item.data, "base64"), storedInEvidence: true } });
      } else if (item.type === "resource_link" && typeof item.uri === "string") {
        content.push({ type: "resource", uri: item.uri,
          ...(typeof item.title === "string" ? { title: item.title } : {}) });
      } else if (item.type === "resource" && object(item.resource)) {
        const resource = item.resource;
        if (typeof resource.uri === "string") content.push({ type: "resource", uri: resource.uri });
        if (typeof resource.text === "string") content.push({ type: "text", text: resource.text });
        else if (typeof resource.blob === "string") content.push({ type: "structured", value: {
          type: "resource_blob", uri: resource.uri, mimeType: resource.mimeType,
          byteLength: Buffer.byteLength(resource.blob, "base64"), storedInEvidence: true,
        } });
      } else content.push({ type: "structured", value: item });
    }
    if (result.structuredContent !== undefined) content.push({ type: "structured", value: result.structuredContent });
    return { ok: result.isError !== true,
      summary: result.isError ? "MCP tool returned an error" : "MCP tool completed",
      content, ...(imageAttachments.length ? { imageAttachments } : {}),
      data: { mcpContent: result.content, structuredContent: result.structuredContent } };
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function metadata(serverId: string, name: string, version: string, mutating: boolean): ToolRuntimeMetadata {
  return { identity: { id: `mcp:${serverId}:${name}`, name, displayName: `${serverId}: ${name}`,
      sourceId: "mcp", sourceKind: "external", sourceVersion: version },
    effects: [mutating ? "external_write" : "external_read"], allowedModes: ["auto", "code"],
    allowedRoles: ["main_agent"], requiresOrchestration: false, requiresVision: false,
    validationSensitive: mutating, idempotent: !mutating, controlPlane: false, resultClass: "generic" };
}
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { type: "function" as const, function: { name, description,
    parameters: { type: "object", properties, required, additionalProperties: false }, strict: false } };
}

export function createMcpTool(serverId: string, tool: McpTool, client: Pick<Client, "callTool">,
  serverVersion = "1"): AgentTool {
  const name = toolName(serverId, tool.name);
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  if (!schema || schema.type !== "object") throw new Error(`MCP tool ${serverId}/${tool.name} has a non-object input schema`);
  const contractHash = toolContract(serverVersion, tool);
  const displayName = `${serverId}: ${tool.title ?? tool.name}`.replace(/[\u0000-\u001F\u007F]/gu, " ");
  return { name, metadata: { ...metadata(serverId, name, serverVersion, true),
      identity: { id: `mcp:${serverId}:${name}`, name, displayName,
        sourceId: "mcp", sourceKind: "external", sourceVersion: serverVersion } },
    mutating: true,
    approvalTarget: input => ({ name: tool.name, label: `${serverId} / ${tool.name}`,
      description: tool.description, input, contractHash }),
    definition: { type: "function", function: { name,
      description: String(tool.description || tool.title || tool.name), parameters: schema, strict: false } },
    async execute(input, context): Promise<ToolExecutionResult> {
      try {
        if (!object(input)) throw new Error("MCP tool input must be an object");
        const result = await client.callTool({ name: tool.name, arguments: input },
          { ...requestOptions(context), toolDefinition: tool });
        return await mcpResult(result, context);
      } catch (error) { return toolFailure(error, `MCP tool ${serverId}/${tool.name} failed`); }
    } };
}

/** A large catalog is searched on demand instead of being copied into every model request. */
export function createMcpCatalogTools(serverId: string, tools: readonly McpTool[],
  client: Pick<Client, "callTool">, serverVersion = "1"): AgentTool[] {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const searchName = toolName(serverId, "catalog_search");
  const inspectName = toolName(serverId, "catalog_inspect");
  const callName = toolName(serverId, "catalog_call");
  return [
    { name: searchName, metadata: metadata(serverId, searchName, serverVersion, false), mutating: false,
      definition: definition(searchName, `Search available tools from MCP server ${serverId}.`, {
        query: { type: "string" }, offset: { type: "integer", minimum: 0 } }, ["query"]),
      async execute(input): Promise<ToolExecutionResult> {
        const args = input as { query?: unknown; offset?: unknown };
        if (typeof args?.query !== "string" || (args.offset !== undefined &&
          (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)))
          return toolFailure(new Error("Expected query and nonnegative offset"), "MCP catalog search failed");
        const query = args.query.toLowerCase();
        const found = tools.filter(tool => `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase().includes(query));
        const offset = Number(args.offset ?? 0);
        return { ok: true, summary: `Found ${found.length} matching MCP tools`, data: {
          tools: found.slice(offset, offset + 20).map(tool => ({ name: tool.name, title: tool.title,
            description: tool.description })), nextOffset: offset + 20 < found.length ? offset + 20 : null,
          total: found.length } };
      } },
    { name: inspectName, metadata: metadata(serverId, inspectName, serverVersion, false), mutating: false,
      definition: definition(inspectName, `Read a tool schema from MCP server ${serverId} in pages.`, {
        name: { type: "string" }, offset: { type: "integer", minimum: 0 } }, ["name"]),
      async execute(input, context): Promise<ToolExecutionResult> {
        const args = input as { name?: unknown; offset?: unknown };
        if (typeof args?.name !== "string" || (args.offset !== undefined &&
          (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)))
          return toolFailure(new Error("Expected tool name and nonnegative offset"), "MCP tool inspection failed");
        const tool = byName.get(args.name);
        if (!tool) return toolFailure(new Error("Unknown MCP tool"), "MCP tool inspection failed");
        const serialized = JSON.stringify({ name: tool.name, title: tool.title,
          description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema });
        const offset = Number(args.offset ?? 0);
        if (offset > serialized.length) return toolFailure(new Error("Offset exceeds tool schema"), "MCP tool inspection failed");
        const room = context.resultCharBudget ?? context.maxOutputChars ?? DEFAULT_RUNTIME_LIMITS.maxToolResultChars;
        const end = Math.min(serialized.length, offset + Math.max(1, room));
        return { ok: true, summary: `MCP tool schema ${tool.name}`, data: {
          content: serialized.slice(offset, end), offset, nextOffset: end < serialized.length ? end : null,
          totalChars: serialized.length } };
      } },
    { name: callName, metadata: metadata(serverId, callName, serverVersion, true), mutating: true,
      approvalTarget: input => {
        const args = input as { name?: unknown; argumentsJson?: unknown };
        if (typeof args?.name !== "string" || typeof args.argumentsJson !== "string")
          throw new Error("Expected a known MCP tool name and JSON arguments");
        const tool = byName.get(args.name);
        if (!tool) throw new Error("Unknown MCP tool");
        const parsed: unknown = JSON.parse(args.argumentsJson);
        if (!object(parsed)) throw new Error("MCP tool arguments must be a JSON object");
        return { name: args.name, label: `${serverId} / ${args.name}`,
          description: tool.description, input: parsed, contractHash: toolContract(serverVersion, tool) };
      },
      definition: definition(callName, `Call an inspected tool on MCP server ${serverId}; this requires approval.`, {
        name: { type: "string" }, argumentsJson: { type: "string" } }, ["name", "argumentsJson"]),
      async execute(input, context): Promise<ToolExecutionResult> {
        try {
          const args = input as { name?: unknown; argumentsJson?: unknown };
          if (typeof args?.name !== "string" || typeof args.argumentsJson !== "string")
            throw new Error("Expected a known MCP tool name and JSON arguments");
          const tool = byName.get(args.name);
          if (!tool) throw new Error("Unknown MCP tool");
          const parsed: unknown = JSON.parse(args.argumentsJson);
          if (!object(parsed)) throw new Error("MCP tool arguments must be a JSON object");
          return await mcpResult(await client.callTool({ name: args.name, arguments: parsed },
            { ...requestOptions(context), toolDefinition: tool }), context);
        } catch (error) { return toolFailure(error, `MCP tool call on ${serverId} failed`); }
      } },
  ];
}

function capabilityTools(serverId: string, connection: Connection): AgentTool[] {
  const tools: AgentTool[] = [];
  if (connection.supportsResources) {
    const listName = toolName(serverId, "list_resources");
    const readName = toolName(serverId, "read_resource");
    tools.push({ name: listName, metadata: metadata(serverId, listName, connection.serverVersion, false), mutating: false,
      definition: definition(listName, `List resources and resource templates from MCP server ${serverId}.`, {}),
      async execute(): Promise<ToolExecutionResult> {
        return { ok: true, summary: `Listed resources from ${serverId}`, data: {
          resources: connection.resources, resourceTemplates: connection.resourceTemplates } };
      } },
    { name: readName, metadata: metadata(serverId, readName, connection.serverVersion, true), mutating: true,
      approvalTarget: input => ({ name: "resources/read", label: `${serverId} / read resource`, input,
        contractHash: hash({ serverVersion: connection.serverVersion, operation: "resources/read" }) }),
      definition: definition(readName, `Read a resource from MCP server ${serverId}.`, { uri: { type: "string" } }, ["uri"]),
      async execute(input, context): Promise<ToolExecutionResult> {
        try {
          const uri = object(input) && typeof input.uri === "string" ? input.uri : undefined;
          if (!uri) throw new Error("Resource URI is required");
          const result = await connection.client.readResource({ uri }, requestOptions(context));
          const content: ToolContent[] = [];
          for (const item of result.contents) {
            content.push({ type: "resource", uri: item.uri });
            if ("text" in item) content.push({ type: "text", text: item.text });
            else content.push({ type: "structured", value: { type: "resource_blob", uri: item.uri,
              mimeType: item.mimeType, byteLength: Buffer.byteLength(item.blob, "base64"), storedInEvidence: true } });
          }
          return { ok: true, summary: `Read MCP resource ${uri}`, content, data: { mcpContent: result.contents } };
        } catch (error) { return toolFailure(error, `MCP resource read on ${serverId} failed`); }
      } });
  }
  if (connection.supportsPrompts) {
    const listName = toolName(serverId, "list_prompts");
    const getName = toolName(serverId, "get_prompt");
    tools.push({ name: listName, metadata: metadata(serverId, listName, connection.serverVersion, false), mutating: false,
      definition: definition(listName, `List prompts from MCP server ${serverId}.`, {}),
      async execute(): Promise<ToolExecutionResult> {
        return { ok: true, summary: `Listed prompts from ${serverId}`, data: { prompts: connection.prompts } };
      } },
    { name: getName, metadata: metadata(serverId, getName, connection.serverVersion, true), mutating: true,
      approvalTarget: input => ({ name: "prompts/get", label: `${serverId} / get prompt`, input,
        contractHash: hash({ serverVersion: connection.serverVersion, operation: "prompts/get" }) }),
      definition: definition(getName, `Render a prompt from MCP server ${serverId}.`, {
        name: { type: "string" }, arguments: { type: "object", additionalProperties: { type: "string" } } }, ["name"]),
      async execute(input, context): Promise<ToolExecutionResult> {
        try {
          if (!object(input) || typeof input.name !== "string") throw new Error("Prompt name is required");
          const args = object(input.arguments) ? Object.fromEntries(Object.entries(input.arguments).map(([key, value]) => {
            if (typeof value !== "string") throw new Error(`Prompt argument ${key} must be text`);
            return [key, value];
          })) : undefined;
          const result = await connection.client.getPrompt({ name: input.name, ...(args ? { arguments: args } : {}) },
            requestOptions(context));
          const content: ToolContent[] = [];
          for (const message of result.messages) {
            const block = message.content as unknown;
            if (object(block) && block.type === "text" && typeof block.text === "string")
              content.push({ type: "text", text: `[${message.role}] ${block.text}` });
            else content.push({ type: "structured", value: { role: message.role, content: block } });
          }
          return { ok: true, summary: result.description ?? `Rendered MCP prompt ${input.name}`,
            content, data: { mcpContent: result.messages } };
        } catch (error) { return toolFailure(error, `MCP prompt request on ${serverId} failed`); }
      } });
  }
  return tools;
}

/** Owns live MCP sessions, dynamic catalogs, cancellation, and reconnect policy. */
export class McpConnections {
  private readonly connections = new Map<string, Connection>();
  private readonly desired = new Map<string, DesiredConnection>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  constructor(private readonly workspace: WorkspaceManager, private readonly dataDir?: string,
    private readonly limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS,
    private readonly events: McpConnectionEvents = {}) {}

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
    const desired: DesiredConnection = { config, approvedExecutableHash, authProvider, failures: 0 };
    this.desired.set(serverId, desired);
    try { return await this.establish(serverId, desired); }
    catch (error) {
      if (config.enabled && this.desired.get(serverId) === desired) this.scheduleReconnect(serverId, desired);
      else this.desired.delete(serverId);
      throw error;
    }
  }
  private async establish(serverId: string, desired: DesiredConnection): Promise<number> {
    const existing = this.connections.get(serverId);
    if (existing) await this.closeConnection(serverId, existing);
    const transport = desired.config.transport === "stdio"
      ? new SandboxedMcpStdioTransport(this.workspace, desired.config, this.dataDir,
        this.limits, desired.approvedExecutableHash)
      : new RemoteMcpTransport(desired.config, desired.authProvider);
    let connection: Connection | undefined;
    const changed = () => this.events.onCatalogChanged?.(serverId);
    const client = new Client({ name: "easy-code", version: "0.1.0" }, {
      capabilities: { roots: { listChanged: true },
        ...(this.events.onSampling ? { sampling: {} } : {}),
        ...(this.events.onElicitation ? { elicitation: { form: {}, url: {} } } : {}) },
      versionNegotiation: { mode: "auto", probe: { timeoutMs: this.limits.mcpStartupTimeoutMs } },
      listMaxPages: 4096,
      listChanged: {
        tools: { onChanged: (error, tools) => { if (!error && tools && connection) { connection.tools = [...tools]; changed(); } } },
        prompts: { onChanged: (error, prompts) => { if (!error && prompts && connection) { connection.prompts = [...prompts]; changed(); } } },
        resources: { onChanged: (error, resources) => {
          if (!error && resources && connection) {
            connection.resources = [...resources];
            void client.listResourceTemplates(undefined, { cacheMode: "refresh",
              timeout: this.limits.mcpIdleTimeoutMs }).then(result => {
                if (connection) connection.resourceTemplates = [...result.resourceTemplates];
                changed();
              }).catch(refreshError => this.events.onReconnectError?.(serverId, refreshError));
            changed();
          }
        } },
      },
    });
    client.setRequestHandler("roots/list", async () => ({ roots: this.workspace.folders.map(folder => ({
      uri: pathToFileURL(folder.path).href, name: folder.key })) }));
    if (this.events.onSampling) {
      client.setRequestHandler("sampling/createMessage", async request =>
        this.events.onSampling!(serverId, request.params));
    }
    if (this.events.onElicitation) {
      client.setRequestHandler("elicitation/create", async request =>
        this.events.onElicitation!(serverId, request.params));
    }
    client.setNotificationHandler("notifications/message", notification => {
      this.events.onLog?.(serverId, notification.params);
    });
    try {
      await client.connect(transport, { timeout: this.limits.mcpStartupTimeoutMs });
      const options = { timeout: this.limits.mcpIdleTimeoutMs, resetTimeoutOnProgress: true };
      const capabilities = client.getServerCapabilities();
      const [tools, prompts, resources, templates] = await Promise.all([
        client.listTools(undefined, options),
        capabilities?.prompts ? client.listPrompts(undefined, options) : Promise.resolve({ prompts: [] }),
        capabilities?.resources ? client.listResources(undefined, options) : Promise.resolve({ resources: [] }),
        capabilities?.resources ? client.listResourceTemplates(undefined, options)
          : Promise.resolve({ resourceTemplates: [] }) ]);
      const names = new Set<string>();
      for (const tool of tools.tools) {
        if (names.has(tool.name)) throw new Error(`Duplicate MCP tool name ${tool.name}`);
        names.add(tool.name);
      }
      connection = { client, transport, serverVersion: serverContract(desired.config), tools: [...tools.tools],
        prompts: [...prompts.prompts], resources: [...resources.resources],
        resourceTemplates: [...templates.resourceTemplates], supportsPrompts: Boolean(capabilities?.prompts),
        supportsResources: Boolean(capabilities?.resources) };
      this.connections.set(serverId, connection);
      desired.failures = 0;
      transport.onDisconnected = () => {
        if (this.connections.get(serverId) === connection) this.connections.delete(serverId);
        changed();
        if (this.desired.get(serverId) === desired) this.scheduleReconnect(serverId, desired);
      };
      changed();
      return connection.tools.length;
    } catch (error) {
      await transport.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      throw error;
    }
  }
  private scheduleReconnect(serverId: string, desired: DesiredConnection): void {
    if (this.reconnectTimers.has(serverId)) return;
    const waitMs = Math.min(30_000, 500 * 2 ** Math.min(desired.failures++, 6));
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(serverId);
      if (this.desired.get(serverId) !== desired) return;
      void this.establish(serverId, desired).catch(error => {
        this.events.onReconnectError?.(serverId, error);
        if (this.desired.get(serverId) === desired) this.scheduleReconnect(serverId, desired);
      });
    }, waitMs);
    timer.unref?.();
    this.reconnectTimers.set(serverId, timer);
  }
  listTools(): AgentTool[] {
    return [...this.connections].filter(([, connection]) => connection.transport.isActive).flatMap(([id, connection]) => {
      const callable = connection.tools.length <= 48
        ? connection.tools.map(tool => createMcpTool(id, tool, connection.client, connection.serverVersion))
        : createMcpCatalogTools(id, connection.tools, connection.client, connection.serverVersion);
      return [...callable, ...capabilityTools(id, connection)];
    });
  }
  private async closeConnection(serverId: string, connection: Connection): Promise<void> {
    if (this.connections.get(serverId) === connection) this.connections.delete(serverId);
    connection.transport.onDisconnected = undefined;
    try { await connection.transport.close(); }
    finally { await connection.client.close().catch(() => undefined); }
  }
  async disconnect(serverId: string): Promise<void> {
    this.desired.delete(serverId);
    const timer = this.reconnectTimers.get(serverId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(serverId);
    const connection = this.connections.get(serverId);
    if (connection) await this.closeConnection(serverId, connection);
    this.events.onCatalogChanged?.(serverId);
  }
  async close(): Promise<void> {
    await Promise.all([...new Set([...this.connections.keys(), ...this.desired.keys()])].map(id => this.disconnect(id)));
  }
}

export class McpToolSource implements ToolSource {
  readonly id = "mcp";
  readonly kind = "external";
  readonly priority = 200;
  constructor(private readonly connections: McpConnections) {}
  async listTools(): Promise<readonly AgentTool[]> { return this.connections.listTools(); }
}
