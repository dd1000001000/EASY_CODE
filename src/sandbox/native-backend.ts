import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { resolveEasyCodePaths } from "../config/defaults.js";
import { hostPlatform } from "../core/host-platform.js";
import { CommandResolver } from "../command/resolver.js";
import type { CommandNetworkGateOptions } from "../command/network-gate.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { CommandExecutionBackend, PreparedCommand, SandboxExecutionRequest } from "./types.js";
import { executionCapabilities } from "./capabilities.js";
import { nativeSandboxEntrypoint, nativeSandboxEnvironment, nativeSandboxHome, nativeSandboxWorker } from "./native-runtime.js";
import type { NativeBackendPlatform } from "./platform/backend-types.js";
import { WindowsNativeBackend } from "./platform/windows-backend.js";
import { MacNativeBackend } from "./platform/macos-backend.js";
import { LinuxNativeBackend } from "./platform/linux-backend.js";
import { SandboxFailure } from "./failure.js";

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
  private readonly platform: NativeBackendPlatform;

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
    if (!inside(this.workspace.root, command.cwdAbsolute)) return undefined;
    return path.relative(this.workspace.root, command.cwdAbsolute) || ".";
  }

  resolveCommand(input: import("../command/types.js").RunCommandInput, context: import("../core/types.js").ToolContext) {
    void context;
    return new CommandResolver(this.workspace).resolve(input, { networkEnabled: true });
  }

  createNetworkGate(options: CommandNetworkGateOptions) { return this.platform.createNetworkGate(options); }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    if (request.policyDecision.effect !== "allow" || request.context.signal?.aborted)
      throw new SandboxFailure("environment_busy", "Native command was not authorized");
    const proxyPorts = await this.platform.authorizedProxyPorts(request.networkProxyPorts);
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const scratch = path.join(this.workspace.root, ".easy-code-runtime");
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(scratch, "command-"));
    const tempRoot = path.join(root, "tmp");
    await mkdir(tempRoot, { mode: 0o700 });
    const payload = path.join(root, "payload.json");
    await writeFile(payload, JSON.stringify({
      commandId: request.commandId, entrypoint: nativeSandboxEntrypoint(), home: this.home,
      tempRoot, timeoutMs: request.timeoutMs ?? this.limits.commandTimeoutMs,
      startupMs: this.platform.startupTimeoutMs,
      cleanupMs: this.limits.sandboxCleanupTimeoutMs, target: request.command, readOnly: this.options.readOnly,
      ...(request.networkProxyURL ? { proxyURL: request.networkProxyURL } : {}),
      ...(proxyPorts?.length ? { proxyPorts } : {}),
    }), { flag: "wx", mode: 0o600 });
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      try { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
      catch (error) { await this.platform.recoverCleanup(root, request, proxyPorts, error); }
      cleaned = true;
    };
    return {
      executablePath: process.execPath, args: [nativeSandboxWorker(), payload], cwdAbsolute: this.workspace.root,
      environment: nativeSandboxEnvironment(this.home), metadata: this.describe(request), controlPipe: true,
      cooperativeTermination: this.platform.cooperativeTermination,
      sandboxManagedTimeout: this.platform.sandboxManagedTimeout,
      windowsJobContainment: this.platform.windowsJobContainment,
      cleanupAfterTermination: true, cleanupAfterWorkerExit: true, cleanup,
    };
  }
}
