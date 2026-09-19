import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import toml from "toml";
import { z } from "zod";
import { assertNoUninstall, assertPlainAncestors } from "../install/ownership.js";

const serverId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const credentialRef = z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/u);

const localServerSchema = z.object({
  transport: z.literal("stdio").default("stdio"),
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(16384)).max(128).default([]),
  cwd: z.string().min(1).max(4096).default("."),
  env: z.record(envName, credentialRef).refine(value => Object.keys(value).length <= 32,
    "MCP server may reference at most 32 environment variables").default({}),
  enabled: z.boolean().default(false),
}).strict();

const remoteUrl = z.string().url().max(4096).refine(value => {
  const parsed = new URL(value);
  return (parsed.protocol === "https:" || (parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) &&
    !parsed.username && !parsed.password && !parsed.hash && !parsed.search;
}, "Remote MCP URL must use HTTPS (or loopback HTTP) and contain no credentials or fragment");

const remoteServerSchema = z.object({
  transport: z.enum(["http", "sse"]),
  url: remoteUrl,
  auth: z.enum(["none", "bearer", "oauth"]).default("none"),
  bearerTokenEnvVar: envName.optional(),
  enabled: z.boolean().default(false),
}).strict().refine(value => value.auth !== "bearer" || Boolean(value.bearerTokenEnvVar),
  "Bearer authentication requires bearerTokenEnvVar");

export const mcpServerSchema = z.union([localServerSchema, remoteServerSchema]);

const mcpConfigSchema = z.object({
  version: z.literal(2),
  servers: z.record(serverId, mcpServerSchema).default({}),
}).strict();

export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type LocalMcpServerConfig = z.infer<typeof localServerSchema>;
export type RemoteMcpServerConfig = z.infer<typeof remoteServerSchema>;
export type McpServerInput = (Omit<LocalMcpServerConfig, "enabled" | "transport"> & { transport?: "stdio" }) |
  Omit<RemoteMcpServerConfig, "enabled">;
export type McpConfiguration = z.infer<typeof mcpConfigSchema>;
export const USER_MCP_CONFIG_PATH = path.join(os.homedir(), ".easy_code", "mcp.toml");

function quote(value: string): string {
  return JSON.stringify(value);
}

function serialize(config: McpConfiguration): string {
  const lines = ["# Managed by EASY CODE. Environment values are references, never secret values.", "version = 2"];
  for (const id of Object.keys(config.servers).sort()) {
    const server = config.servers[id]!;
    lines.push("", `[servers.${id}]`, `transport = ${quote(server.transport)}`);
    if (server.transport === "stdio") {
      lines.push(`command = ${quote(server.command)}`, `args = [${server.args.map(quote).join(", ")}]`,
        `cwd = ${quote(server.cwd)}`, `enabled = ${server.enabled}`);
      if (Object.keys(server.env).length) {
        lines.push("", `[servers.${id}.env]`);
        for (const name of Object.keys(server.env).sort()) lines.push(`${name} = ${quote(server.env[name]!)}`);
      }
    } else {
      lines.push(`url = ${quote(server.url)}`, `auth = ${quote(server.auth)}`,
        ...(server.bearerTokenEnvVar ? [`bearerTokenEnvVar = ${quote(server.bearerTokenEnvVar)}`] : []),
        `enabled = ${server.enabled}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The only writer for the user-level MCP configuration. Never reads workspace TOML. */
export class McpConfigStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath = USER_MCP_CONFIG_PATH) {}

  async read(): Promise<McpConfiguration> {
    assertNoUninstall();
    assertPlainAncestors(this.filePath);
    let source: string;
    try { source = await readFile(this.filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, servers: {} };
      throw error;
    }
    const parsed = toml.parse(source) as Record<string, unknown>;
    if (parsed.version === 1 && parsed.servers && typeof parsed.servers === "object") {
      parsed.version = 2;
      for (const entry of Object.values(parsed.servers)) {
        if (entry && typeof entry === "object") (entry as Record<string, unknown>).transport ??= "stdio";
      }
    }
    return mcpConfigSchema.parse(parsed);
  }

  private update<T>(change: (config: McpConfiguration) => T | Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => {
      const config = await this.read();
      const result = await change(config);
      await this.write(config);
      return result;
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async upsert(id: string, input: McpServerInput): Promise<McpServerConfig> {
    const name = serverId.parse(id);
    const server = mcpServerSchema.parse({ ...input, enabled: false });
    await this.update(config => { config.servers[name] = server; });
    return server;
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerConfig> {
    const name = serverId.parse(id);
    return this.update(config => {
      const server = config.servers[name];
      if (!server) throw new Error(`MCP server ${name} does not exist`);
      server.enabled = enabled;
      return server;
    });
  }

  async remove(id: string): Promise<void> {
    const name = serverId.parse(id);
    await this.update(config => { delete config.servers[name]; });
  }

  private async write(config: McpConfiguration): Promise<void> {
    mcpConfigSchema.parse(config);
    assertNoUninstall();
    assertPlainAncestors(this.filePath);
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    assertPlainAncestors(this.filePath);
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(serialize(config), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
