import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/client";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { resolveEasyCodePaths } from "../config/defaults.js";
import { CommandResolver } from "../command/resolver.js";
import { ensureSharedCommandNetworkGateServer } from "../command/network-gate.js";
import { NativeAppServerClient } from "../sandbox/app-server-client.js";
import { nativeProjectPermissionProfile } from "../sandbox/native-policy.js";
import { nativeSandboxEntrypoint, nativeSandboxHome } from "../sandbox/native-runtime.js";
import { ensureNativeProjectPermissionHome } from "../sandbox/permission-home.js";
import { assertProjectSandboxReady } from "../sandbox/project-readiness.js";
import { acquireWindowsProxyPortLease } from "../sandbox/windows-proxy-registry.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { resolveMcpSetting, type LocalMcpServerConfig } from "./config.js";

const WRITE_MS = 10_000;
type ExecutionEnd = { confirmed: true; exitCode: number } | { confirmed: false; error: string };

/** MCP stdio over the existing OS-enforced command/exec stream, never host spawn. */
export class SandboxedMcpStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onDisconnected?: () => void;

  private readonly processId = `mcp-${randomUUID()}`;
  private readonly buffer: ReadBuffer;
  private service?: NativeAppServerClient;
  private stopNotifications?: () => void;
  private execution?: Promise<ExecutionEnd>;
  private active = false;
  private closed = false;

  get isActive(): boolean { return this.active && !this.closed; }

  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly config: LocalMcpServerConfig,
    private readonly dataDir = resolveEasyCodePaths().dataDir,
    private readonly limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS,
    private readonly approvedExecutableHash?: string,
  ) {
    this.buffer = new ReadBuffer({ maxBufferSize: limits.mcpStdioMaxMessageBytes });
  }

  async start(): Promise<void> {
    if (this.service || this.closed) throw new Error("MCP transport cannot be restarted");
    if (existsSync(this.quarantinePath())) {
      throw new Error("Command environment is quarantined; inspect sandbox cleanup before connecting an MCP server");
    }
    const resolved = await new CommandResolver(this.workspace).resolve({
      program: this.config.command, args: this.config.args, cwd: this.config.cwd, intent: "run",
    });
    if (this.approvedExecutableHash && resolved.executableHash !== this.approvedExecutableHash) {
      throw new Error("MCP executable changed after approval; reconnect and approve the current binary");
    }
    const env = { ...resolved.environment };
    for (const [name, value] of Object.entries(this.config.env)) {
      env[name] = resolveMcpSetting(value, `environment variable ${name}`);
    }
    let proxyPorts: readonly number[] = [];
    if (process.platform === "win32") {
      const lease = await acquireWindowsProxyPortLease({
        dataDir: this.dataDir,
        portStart: this.limits.nativeSandboxProxyPortStart,
        portSlots: this.limits.nativeSandboxProxyPortSlots,
        bind: ensureSharedCommandNetworkGateServer,
      });
      proxyPorts = await lease.authorizedPorts();
      if (!proxyPorts.includes(lease.port)) throw new Error("Windows sandbox setup is incomplete; run easy-code sandbox setup");
    }
    const baseHome = nativeSandboxHome(this.dataDir);
    await mkdir(baseHome, { recursive: true, mode: 0o700 });
    const home = await ensureNativeProjectPermissionHome(baseHome, this.workspace.writableRoots);
    const service = new NativeAppServerClient(nativeSandboxEntrypoint(), home, undefined, undefined, proxyPorts);
    this.service = service;
    try {
      await service.initialize(this.limits.mcpStartupTimeoutMs);
      await assertProjectSandboxReady(service, this.limits.mcpStartupTimeoutMs);
      this.stopNotifications = service.onNotification(notification => {
        if (notification?.method !== "command/exec/outputDelta" ||
            notification.params?.processId !== this.processId) return;
        const encoded = notification.params?.deltaBase64;
        if (typeof encoded !== "string" || encoded.length > this.limits.mcpStdioMaxMessageBytes * 2) {
          this.onerror?.(new Error("MCP server emitted an oversized output delta"));
          void this.close();
          return;
        }
        const bytes = Buffer.from(encoded, "base64");
        if (notification.params?.stream === "stderr") {
          return;
        }
        try {
          this.buffer.append(bytes);
          for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) {
            this.onmessage?.(message);
          }
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          void this.close();
        }
      });
      const target = resolved.launch ?? { executablePath: resolved.executablePath, args: resolved.args };
      // CommandResolver already produced an argv-safe, hash-bound launch plan.
      // Reuse it unchanged so Windows .cmd/.bat, npx and PowerShell-backed MCP
      // launchers work without a second shell reconstruction here.
      this.execution = service.request("command/exec", {
        command: [target.executablePath, ...target.args],
        cwd: resolved.cwdAbsolute,
        env,
        processId: this.processId,
        streamStdin: true,
        streamStdoutStderr: true,
        disableOutputCap: true,
        disableTimeout: true,
        ...nativeProjectPermissionProfile(),
      }, 24 * 60 * 60 * 1000).then<ExecutionEnd, ExecutionEnd>(
        result => Number.isSafeInteger(result?.exitCode)
          ? { confirmed: true, exitCode: result.exitCode }
          : { confirmed: false, error: "Command response had no exit code" },
        error => ({ confirmed: false, error: error instanceof Error ? error.message : String(error) }),
      );
      void this.execution.then(outcome => {
        if (this.closed) return;
        this.onerror?.(new Error(outcome.confirmed
          ? `MCP server exited (${outcome.exitCode})`
          : `MCP server outcome is uncertain: ${outcome.error}`));
        void this.close().catch(error => this.onerror?.(error instanceof Error ? error : new Error(String(error))));
      });
      // The exec response is deliberately deferred until exit. Probe the
      // connection-scoped process handle before handing transport to the SDK.
      const deadline = Date.now() + this.limits.mcpStartupTimeoutMs;
      for (;;) {
        if (this.closed) throw new Error("MCP server exited during startup");
        try {
          await service.request("command/exec/write", { processId: this.processId, deltaBase64: "" }, WRITE_MS);
          this.active = true;
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await delay(50);
        }
      }
    } catch (error) {
      try { await this.close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "MCP startup and cleanup failed"); }
      throw error;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.active || !this.service || this.closed) throw new Error("MCP server is not connected");
    const line = serializeMessage(message);
    if (Buffer.byteLength(line) > this.limits.mcpStdioMaxMessageBytes) {
      throw new Error(`MCP request exceeds the configured ${this.limits.mcpStdioMaxMessageBytes}-byte transport safety limit`);
    }
    await this.service.request("command/exec/write", {
      processId: this.processId,
      deltaBase64: Buffer.from(line).toString("base64"),
    }, WRITE_MS);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const wasActive = this.active;
    this.closed = true;
    this.active = false;
    this.stopNotifications?.();
    const service = this.service;
    this.service = undefined;
    let outcome: ExecutionEnd | undefined;
    if (service) {
      if (this.execution) {
        await service.request("command/exec/terminate", { processId: this.processId }, 2_000).catch(() => undefined);
        let timeout: NodeJS.Timeout | undefined;
        try {
          outcome = await Promise.race([
            this.execution,
            new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), 10_000); }),
          ]);
        } finally { if (timeout) clearTimeout(timeout); }
      }
      await service.close();
    }
    this.buffer.clear();
    try {
      if (this.execution && (!outcome || !outcome.confirmed) && wasActive) {
        await this.quarantine("MCP sandbox process termination could not be confirmed");
        throw new Error("MCP sandbox cleanup is uncertain; command execution was quarantined");
      }
    } finally {
      this.onclose?.();
      this.onDisconnected?.();
    }
  }

  private async quarantine(reason: string): Promise<void> {
    const filename = this.quarantinePath();
    const directory = path.dirname(filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(filename, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ version: 3, code: "mcp_cleanup_unknown",
        workspace: this.workspace.root, backend: "native", reason, at: new Date().toISOString() }));
      await handle.sync();
    } finally { await handle.close(); }
  }

  private quarantinePath(): string {
    return path.join(this.dataDir, "command-quarantine",
      `${this.workspace.projectId ?? workspaceIdFromRoot(this.workspace.root)}.json`);
  }
}
