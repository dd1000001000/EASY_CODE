import { createCommandNetworkGate, ensureSharedCommandNetworkGateServer, type CommandNetworkGateOptions } from "../../command/network-gate.js";
import { SandboxFailure } from "../failure.js";
import { NativeAppServerClient } from "../app-server-client.js";
import { nativePermissionProfile } from "../native-policy.js";
import { nativeSandboxEntrypoint, nativeSandboxEnvironment } from "../native-runtime.js";
import { acquireWindowsProxyPortLease, type WindowsProxyPortLease } from "../windows-proxy-registry.js";
import type { SandboxExecutionRequest } from "../types.js";
import type { NativeBackendPlatform, NativeBackendPlatformOptions } from "./backend-types.js";

export class WindowsNativeBackend implements NativeBackendPlatform {
  readonly startupTimeoutMs: number;
  readonly cooperativeTermination = false;
  readonly sandboxManagedTimeout = true;
  readonly windowsJobContainment = false;
  private lease?: Promise<WindowsProxyPortLease>;

  constructor(private readonly options: NativeBackendPlatformOptions) {
    this.startupTimeoutMs = options.limits.sandboxStartupWindowsMs;
  }

  private proxyLease(): Promise<WindowsProxyPortLease> {
    this.lease ??= acquireWindowsProxyPortLease({
      dataDir: this.options.dataDir,
      portStart: this.options.limits.nativeSandboxProxyPortStart,
      portSlots: this.options.limits.nativeSandboxProxyPortSlots,
      bind: ensureSharedCommandNetworkGateServer,
    });
    return this.lease;
  }

  async createNetworkGate(options: CommandNetworkGateOptions) {
    const lease = await this.proxyLease();
    const ports = await lease.authorizedPorts();
    if (!ports.includes(lease.port)) throw new SandboxFailure("environment_busy",
      "This EASY CODE process proxy port has not completed Windows sandbox setup; restart setup before running network commands");
    const gate = await createCommandNetworkGate({ ...options, listenPort: lease.port });
    return { ...gate, proxyPorts: ports };
  }

  async authorizedProxyPorts(): Promise<readonly number[]> {
    const lease = await this.proxyLease();
    const ports = await lease.authorizedPorts();
    if (!ports.includes(lease.port)) throw new SandboxFailure("environment_busy",
      "This EASY CODE process has not completed its one-time Windows sandbox setup; run easy-code sandbox setup before commands");
    return ports;
  }

  async recoverCleanup(root: string, request: SandboxExecutionRequest, proxyPorts: readonly number[] | undefined, originalError: unknown): Promise<void> {
    // A Windows sandbox user may create a private ACL child. Re-enter the same
    // sandbox identity to remove only this Runtime-created temporary root.
    const service = new NativeAppServerClient(nativeSandboxEntrypoint(), this.options.home, process.env,
      request.networkProxyURL, proxyPorts);
    try {
      await service.initialize(this.startupTimeoutMs);
      const code = "const fs=require('node:fs');fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:3})";
      const result = await service.request("command/exec", {
        command: [process.execPath, "-e", code, root], cwd: this.options.workspaceRoot,
        ...(request.networkProxyURL || proxyPorts?.length ? { env: nativeSandboxEnvironment(this.options.home,
          process.env, request.networkProxyURL, proxyPorts) } : {}),
        ...nativePermissionProfile(), timeoutMs: this.options.limits.sandboxCleanupTimeoutMs,
      }, this.options.limits.sandboxCleanupTimeoutMs + 5_000);
      if (result?.exitCode !== 0) throw originalError;
    } finally { await service.close(); }
  }
}
