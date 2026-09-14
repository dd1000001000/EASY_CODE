import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { resolveEasyCodePaths } from "../config/defaults.js";
import { CommandResolver } from "../command/resolver.js";
import {
  createCommandNetworkGate,
  ensureSharedCommandNetworkGateServer,
  type CommandNetworkGateOptions,
} from "../command/network-gate.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { CommandExecutionBackend, PreparedCommand, SandboxExecutionRequest } from "./types.js";
import { executionCapabilities } from "./capabilities.js";
import { nativeSandboxEntrypoint, nativeSandboxEnvironment, nativeSandboxHome, nativeSandboxWorker } from "./native-runtime.js";
import { NativeAppServerClient } from "./app-server-client.js";
import { nativePermissionProfile } from "./native-policy.js";
import { SandboxFailure } from "./failure.js";
import { acquireWindowsProxyPortLease, type WindowsProxyPortLease } from "./windows-proxy-registry.js";

function inside(root: string, value: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export interface NativeSandboxBackendOptions {
  limits?: Readonly<RuntimeLimits>; dataDir?: string; readOnly?: boolean;
}

export class NativeSandboxBackend implements CommandExecutionBackend {
  private readonly limits: Readonly<RuntimeLimits>;
  private readonly home: string;
  private readonly dataDir: string;
  private proxyLease?: Promise<WindowsProxyPortLease>;
  constructor(private readonly workspace: WorkspaceManager, private readonly options: NativeSandboxBackendOptions = {}) {
    this.limits = options.limits ?? DEFAULT_RUNTIME_LIMITS;
    this.dataDir = options.dataDir ?? resolveEasyCodePaths().dataDir;
    this.home = nativeSandboxHome(this.dataDir);
  }
  describe(request?: SandboxExecutionRequest) {
    return { backend: "native" as const, enforced: true, filesystem: "host" as const,
      network: request?.networkProxyURL ? "brokered" as const : "denied" as const,
      capabilities: executionCapabilities("native") };
  }
  workspaceRelativeCwd(command: import("../command/types.js").ResolvedCommand): string | undefined {
    if (!inside(this.workspace.root, command.cwdAbsolute)) return undefined;
    return path.relative(this.workspace.root, command.cwdAbsolute) || ".";
  }
  resolveCommand(input: import("../command/types.js").RunCommandInput, context: import("../core/types.js").ToolContext) {
    void context;
    return new CommandResolver(this.workspace).resolve(input, { networkEnabled: true });
  }
  private windowsProxyLease(): Promise<WindowsProxyPortLease> {
    this.proxyLease ??= acquireWindowsProxyPortLease({
      dataDir: this.dataDir,
      portStart: this.limits.nativeSandboxProxyPortStart,
      portSlots: this.limits.nativeSandboxProxyPortSlots,
      bind: ensureSharedCommandNetworkGateServer,
    });
    return this.proxyLease;
  }
  async createNetworkGate(options: CommandNetworkGateOptions) {
    if (process.platform !== "win32") return createCommandNetworkGate(options);
    const lease = await this.windowsProxyLease();
    const ports = await lease.authorizedPorts();
    if (!ports.includes(lease.port)) {
      throw new SandboxFailure("environment_busy",
        "This EASY CODE process proxy port has not completed Windows sandbox setup; restart setup before running network commands");
    }
    const gate = await createCommandNetworkGate({ ...options, listenPort: lease.port });
    return { ...gate, proxyPorts: ports };
  }
  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    if (request.policyDecision.effect !== "allow" || request.context.signal?.aborted) throw new SandboxFailure("environment_busy", "Native command was not authorized");
    let proxyPorts = request.networkProxyPorts;
    if (process.platform === "win32") {
      const lease = await this.windowsProxyLease();
      proxyPorts = await lease.authorizedPorts();
      if (!proxyPorts.includes(lease.port)) {
        throw new SandboxFailure("environment_busy",
          "This EASY CODE process has not completed its one-time Windows sandbox setup; run easy-code sandbox setup before commands");
      }
    }
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const scratch = path.join(this.workspace.root, ".easy-code-srt-runtime");
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(scratch, "command-"));
    const tempRoot = path.join(root, "tmp"); await mkdir(tempRoot, { mode: 0o700 });
    const payload = path.join(root, "payload.json");
    await writeFile(payload, JSON.stringify({ commandId: request.commandId, entrypoint: nativeSandboxEntrypoint(), home: this.home,
      tempRoot, timeoutMs: request.timeoutMs ?? this.limits.commandTimeoutMs,
      startupMs: process.platform === "win32" ? this.limits.sandboxStartupWindowsMs : this.limits.sandboxStartupPosixMs,
      cleanupMs: this.limits.sandboxCleanupTimeoutMs, target: request.command, readOnly: this.options.readOnly,
      ...(request.networkProxyURL ? { proxyURL: request.networkProxyURL } : {}),
      ...(proxyPorts?.length ? { proxyPorts } : {}) }), { flag: "wx", mode: 0o600 });
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      try { await rm(root, { recursive: true, force: true, maxRetries: 3 }); cleaned = true; return; }
      catch (error) {
        if (process.platform !== "win32") throw error;
        // A Windows sandbox user may create a private ACL child. Re-enter the
        // same sandbox identity to remove only this Runtime-created temp root.
        const service = new NativeAppServerClient(nativeSandboxEntrypoint(), this.home, process.env,
          request.networkProxyURL, proxyPorts);
        try {
          await service.initialize(this.limits.sandboxStartupWindowsMs);
          const code = "const fs=require('node:fs');fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:3})";
          const result = await service.request("command/exec", { command: [process.execPath, "-e", code, root], cwd: this.workspace.root,
            ...(request.networkProxyURL || proxyPorts?.length ? { env: nativeSandboxEnvironment(this.home, process.env,
              request.networkProxyURL, proxyPorts) } : {}),
            ...nativePermissionProfile(),
            timeoutMs: this.limits.sandboxCleanupTimeoutMs }, this.limits.sandboxCleanupTimeoutMs + 5_000);
          if (result?.exitCode !== 0) throw error;
          cleaned = true;
        } finally { await service.close(); }
      }
    };
    return { executablePath: process.execPath, args: [nativeSandboxWorker(), payload], cwdAbsolute: this.workspace.root,
      environment: nativeSandboxEnvironment(this.home), metadata: this.describe(request), controlPipe: true,
      cooperativeTermination: process.platform !== "win32", sandboxManagedTimeout: process.platform === "win32",
      windowsJobContainment: process.platform === "win32" ? false : undefined, cleanupAfterTermination: true,
      cleanupAfterWorkerExit: true, cleanup };
  }
}
