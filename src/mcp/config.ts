import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import toml from "toml";
import { z } from "zod";
import { assertNoUninstall, assertPlainAncestors } from "../install/ownership.js";

const serverId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u).refine(value =>
  !["host", "content-length", "connection", "transfer-encoding", "proxy-authorization"].includes(value.toLowerCase()),
"Transport-owned MCP headers cannot be overridden");
const settingValue = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ fromEnv: envName }).strict(),
]);
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

const localServerSchema = z.object({
  transport: z.literal("stdio").default("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).default("."),
  env: z.record(envName, settingValue).default({}),
  executableHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  enabled: z.boolean().default(false),
}).strict();

const remoteUrl = z.string().url().refine(value => {
  const parsed = new URL(value);
  return (parsed.protocol === "https:" || (parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) &&
    !parsed.username && !parsed.password && !parsed.hash;
}, "Remote MCP URL must use HTTPS (or loopback HTTP) and contain no credentials or fragment");

const remoteServerSchema = z.object({
  transport: z.enum(["http", "sse"]),
  url: remoteUrl,
  auth: z.enum(["none", "bearer", "oauth"]).default("none"),
  bearerTokenEnvVar: envName.optional(),
  headers: z.record(headerName, settingValue).default({}),
  query: z.record(z.string().min(1).max(256), settingValue).default({}),
  enabled: z.boolean().default(false),
}).strict().refine(value => value.auth !== "bearer" || Boolean(value.bearerTokenEnvVar),
  "Bearer authentication requires bearerTokenEnvVar");

export const mcpServerSchema = z.union([localServerSchema, remoteServerSchema]);

const mcpConfigSchema = z.object({
  version: z.literal(3),
  servers: z.record(serverId, mcpServerSchema).default({}),
}).strict();

export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type LocalMcpServerConfig = z.infer<typeof localServerSchema>;
export type RemoteMcpServerConfig = z.infer<typeof remoteServerSchema>;
export type McpSettingValue = z.infer<typeof settingValue>;
export type McpServerInput = (Omit<LocalMcpServerConfig, "enabled" | "transport"> & { transport?: "stdio" }) |
  (Omit<RemoteMcpServerConfig, "enabled" | "headers" | "query"> & {
    headers?: RemoteMcpServerConfig["headers"];
    query?: RemoteMcpServerConfig["query"];
  });
export type McpConfiguration = z.infer<typeof mcpConfigSchema>;
export const USER_MCP_CONFIG_PATH = path.join(os.homedir(), ".easy_code", "mcp.toml");

export function resolveMcpSetting(value: McpSettingValue, label: string): string {
  if ("value" in value) return value.value;
  const resolved = process.env[value.fromEnv];
  if (resolved === undefined) throw new Error(`MCP environment reference ${value.fromEnv} for ${label} is not set`);
  return resolved;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function setting(value: z.infer<typeof settingValue>): string {
  return "value" in value ? `{ value = ${quote(value.value)} }` : `{ fromEnv = ${quote(value.fromEnv)} }`;
}

function serialize(config: McpConfiguration): string {
  const lines = ["# Managed by EASY CODE. Prefer environment references for secrets; literal values are stored as written.", "version = 3"];
  for (const id of Object.keys(config.servers).sort()) {
    const server = config.servers[id]!;
    lines.push("", `[servers.${id}]`, `transport = ${quote(server.transport)}`);
    if (server.transport === "stdio") {
      lines.push(`command = ${quote(server.command)}`, `args = [${server.args.map(quote).join(", ")}]`,
        `cwd = ${quote(server.cwd)}`,
        ...(server.executableHash ? [`executableHash = ${quote(server.executableHash)}`] : []),
        `enabled = ${server.enabled}`);
      if (Object.keys(server.env).length) {
        lines.push("", `[servers.${id}.env]`);
        for (const name of Object.keys(server.env).sort()) lines.push(`${name} = ${setting(server.env[name]!)}`);
      }
    } else {
      lines.push(`url = ${quote(server.url)}`, `auth = ${quote(server.auth)}`,
        ...(server.bearerTokenEnvVar ? [`bearerTokenEnvVar = ${quote(server.bearerTokenEnvVar)}`] : []),
        `enabled = ${server.enabled}`);
      if (Object.keys(server.headers).length) {
        lines.push("", `[servers.${id}.headers]`);
        for (const name of Object.keys(server.headers).sort()) lines.push(`${quote(name)} = ${setting(server.headers[name]!)}`);
      }
      if (Object.keys(server.query).length) {
        lines.push("", `[servers.${id}.query]`);
        for (const name of Object.keys(server.query).sort()) lines.push(`${quote(name)} = ${setting(server.query[name]!)}`);
      }
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
    try {
      if ((await stat(this.filePath)).size > MAX_CONFIG_BYTES) {
        throw new Error("MCP configuration exceeds the 8 MiB safety limit");
      }
      source = await readFile(this.filePath, "utf8");
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 3, servers: {} };
      throw error;
    }
    if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) throw new Error("MCP configuration exceeds the 8 MiB safety limit");
    return mcpConfigSchema.parse(toml.parse(source));
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

  async setEnabled(id: string, enabled: boolean, executableHash?: string): Promise<McpServerConfig> {
    const name = serverId.parse(id);
    return this.update(config => {
      const server = config.servers[name];
      if (!server) throw new Error(`MCP server ${name} does not exist`);
      if (server.transport === "stdio" && executableHash !== undefined) {
        server.executableHash = z.string().regex(/^[a-f0-9]{64}$/u).parse(executableHash);
      }
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
    const source = serialize(config);
    if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) throw new Error("MCP configuration exceeds the 8 MiB safety limit");
    assertNoUninstall();
    assertPlainAncestors(this.filePath);
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    assertPlainAncestors(this.filePath);
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(source, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
