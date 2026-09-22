import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { resolveEasyCodePaths } from "../config/defaults.js";
import { hostPlatform } from "../core/host-platform.js";
import { CommandResolver } from "../command/resolver.js";
import type { CommandNetworkGateOptions } from "../command/network-gate.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { CommandExecutionBackend, PreparedCommand, SandboxExecutionRequest } from "./types.js";
import { executionCapabilities } from "./capabilities.js";
import { nativeSandboxEntrypoint, nativeSandboxEnvironment, nativeSandboxHome } from "./native-runtime.js";
import type { NativeBackendPlatform } from "./platform/backend-types.js";
import { WindowsNativeBackend } from "./platform/windows-backend.js";
import { MacNativeBackend } from "./platform/macos-backend.js";
import { LinuxNativeBackend } from "./platform/linux-backend.js";
import { SandboxFailure } from "./failure.js";
import { ensureNativeProjectPermissionHome } from "./permission-home.js";

export interface NativeSandboxBackendOptions {
  limits?: Readonly<RuntimeLimits>; dataDir?: string; readOnly?: boolean;
}

export class NativeSandboxBackend implements CommandExecutionBackend {
  private readonly limits: Readonly<RuntimeLimits>;
  private readonly home: string;
  private readonly platform: NativeBackendPlatform;
  private readonly serviceSessions = new Map<string, { socketPath: string; socketDir: string; secret: string }>();

  constructor(private readonly workspace: WorkspaceManager, private readonly options: NativeSandboxBackendOptions = {}) {
    this.limits = options.limits ?? DEFAULT_RUNTIME_LIMITS;
    const dataDir = options.dataDir ?? resolveEasyCodePaths().dataDir;
    this.home = nativeSandboxHome(dataDir);
    const platformOptions = { limits: this.limits, dataDir, home: this.home, workspaceRoot: workspace.root };
    switch (hostPlatform()) {
      case "win32": this.platform = new WindowsNativeBackend(platformOptions); break;
      case "darwin": this.platform = new MacNativeBackend(platformOptions); break;
      case "linux": this.platform = new LinuxNativeBackend(platformOptions); break;
    }
  }

  describe(request?: SandboxExecutionRequest) {
    return { backend: "native" as const, enforced: true, filesystem: "host" as const,
      network: request?.networkProxyURL ? "brokered" as const : "denied" as const,
      capabilities: executionCapabilities("native") };
  }

  workspaceRelativeCwd(command: import("../command/types.js").ResolvedCommand): string | undefined {
    try { return this.workspace.pathGuard.toRelative(command.cwdAbsolute); }
    catch { return undefined; }
  }

  resolveCommand(input: import("../command/types.js").RunCommandInput, context: import("../core/types.js").ToolContext) {
    void context;
    return new CommandResolver(this.workspace).resolve(input, { networkEnabled: true });
  }

  createNetworkGate(options: CommandNetworkGateOptions) { return this.platform.createNetworkGate(options); }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    if (request.policyDecision.effect !== "allow" || request.context.signal?.aborted)
      throw new SandboxFailure("environment_busy", "Native command was not authorized");
    const linux = hostPlatform() === "linux";
    const existing = linux ? this.serviceSessions.get(request.context.threadId) : undefined;
    const proxyPorts = await this.platform.authorizedProxyPorts(request.networkProxyPorts);
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const scratch = path.join(this.workspace.root, ".easy-code-runtime");
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(scratch, "command-"));
    const tempRoot = path.join(root, "tmp");
    const payload = path.join(root, "payload.json");
    const service = linux && request.backgroundKind === "service" && !existing;
    let session: { socketPath: string; socketDir: string; secret: string } | undefined;
    let home = this.home;
    try {
      home = await ensureNativeProjectPermissionHome(this.home, this.workspace.writableRoots);
      await mkdir(tempRoot, { mode: 0o700 });
      if (service) {
        const socketDir = await mkdtemp(path.join(os.tmpdir(), "easy-code-service-"));
        session = { socketDir, socketPath: path.join(socketDir, "control.sock"), secret: randomBytes(32).toString("hex") };
      }
      await writeFile(payload, JSON.stringify({
        commandId: request.commandId, entrypoint: nativeSandboxEntrypoint(), home,
        tempRoot, timeoutMs: request.timeoutMs ?? this.limits.commandTimeoutMs,
        startupMs: this.platform.startupTimeoutMs,
        cleanupMs: this.limits.sandboxCleanupTimeoutMs, target: request.command, readOnly: this.options.readOnly,
        ...(session ? { bridgeSocketPath: session.socketPath } : {}),
        ...(existing ? { bridgeSocketPath: existing.socketPath } : {}),
        ...(request.networkProxyURL ? { proxyURL: request.networkProxyURL } : {}),
        ...(proxyPorts?.length ? { proxyPorts } : {}),
      }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      if (session) await rm(session.socketDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    if (session) this.serviceSessions.set(request.context.threadId, session);
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      try { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
      catch (error) { await this.platform.recoverCleanup(root, request, proxyPorts, error); }
      if (session && this.serviceSessions.get(request.context.threadId) === session) {
        this.serviceSessions.delete(request.context.threadId);
        await rm(session.socketDir, { recursive: true, force: true, maxRetries: 3 });
      }
      cleaned = true;
    };
    return {
      executablePath: process.execPath, args: [fileURLToPath(new URL(
        session ? "native-service-worker.js" : existing ? "native-bridge-worker.js" : "native-worker.js", import.meta.url)), payload], cwdAbsolute: this.workspace.root,
      environment: { ...nativeSandboxEnvironment(home), ...(session || existing ? {
        EASY_CODE_SERVICE_SECRET: (session ?? existing)!.secret,
      } : {}) }, metadata: this.describe(request), controlPipe: true,
      cooperativeTermination: this.platform.cooperativeTermination,
      sandboxManagedTimeout: this.platform.sandboxManagedTimeout,
      windowsJobContainment: this.platform.windowsJobContainment,
      cleanupAfterTermination: true, cleanupAfterWorkerExit: true, cleanup,
    };
  }
}
