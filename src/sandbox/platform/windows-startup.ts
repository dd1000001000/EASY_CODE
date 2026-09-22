import path from "node:path";
import { mkdir } from "node:fs/promises";
import { ensureSharedCommandNetworkGateServer } from "../../command/network-gate.js";
import { NativeAppServerClient } from "../app-server-client.js";
import { nativeSandboxEntrypoint, nativeSandboxHome } from "../native-runtime.js";
import { acquireWindowsProxyPortLease, withWindowsProxyProvisioningLock, type WindowsProxyPortLease } from "../windows-proxy-registry.js";
import type { SandboxReadiness, SandboxSetupResult } from "../startup.js";
import type { NativeStartupOptions, NativeStartupPlatform, NativeProxyState, ReadinessResult } from "./startup-types.js";
import { startupError } from "./startup-types.js";

export class WindowsNativeStartup implements NativeStartupPlatform {
  readonly backendName = "Native OS sandbox (Windows elevated)";
  readonly startupTimeoutMs: number;
  readonly probeCommand = [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe")];
  readonly successDetail = "Dedicated offline identity is active.";
  private lease?: Promise<WindowsProxyPortLease>;

  constructor(private readonly options: NativeStartupOptions) {
    this.startupTimeoutMs = options.limits.sandboxStartupWindowsMs;
  }

  async proxyState(): Promise<NativeProxyState> {
    this.lease ??= acquireWindowsProxyPortLease({
      dataDir: this.options.dataDir,
      portStart: this.options.limits.nativeSandboxProxyPortStart,
      portSlots: this.options.limits.nativeSandboxProxyPortSlots,
      bind: ensureSharedCommandNetworkGateServer,
    });
    const lease = await this.lease;
    return { lease, proxyURL: `http://127.0.0.1:${lease.port}`, ports: await lease.setupPorts() };
  }

  async checkReadiness(service: NativeAppServerClient, result: ReadinessResult): Promise<SandboxReadiness | undefined> {
    const configured = await service.request("windowsSandbox/readiness", {}, this.startupTimeoutMs);
    return configured?.status === "ready" ? undefined
      : result("setup_required", [`Windows sandbox status: ${String(configured?.status ?? "unknown")}`], true);
  }

  checkProbe(stdout: unknown, result: ReadinessResult): SandboxReadiness | undefined {
    return /\\codexsandboxoffline\s*$/iu.test(String(stdout ?? "").trim()) ? undefined
      : result("setup_required", ["The dedicated Windows offline identity is not active. Elevated setup is required."], true);
  }

  async probeSucceeded(proxy: NativeProxyState | undefined): Promise<void> { await proxy?.lease.markAuthorized(); }

  probeFailed(message: string, result: ReadinessResult): SandboxReadiness {
    return result("setup_required", [message.slice(0, 2000)], true);
  }

  async inspect(unlocked: () => Promise<SandboxReadiness>, result: ReadinessResult): Promise<SandboxReadiness> {
    try {
      const proxy = await this.proxyState();
      const authorized = await proxy.lease.authorizedPorts();
      if (authorized.includes(proxy.lease.port)) return unlocked();
      // Serialize inspection while an explicit setup transaction may be
      // reconciling the fixed WFP proxy-port pool in another process.
      return withWindowsProxyProvisioningLock(this.options.dataDir, unlocked,
        this.options.limits.nativeSandboxSetupTimeoutMs + this.startupTimeoutMs);
    } catch (error) {
      return result("setup_required", [startupError(error).slice(0, 2000)], true);
    }
  }

  async setup(readiness: SandboxReadiness, unlocked: () => Promise<SandboxReadiness>, result: ReadinessResult): Promise<SandboxSetupResult> {
    const home = nativeSandboxHome(this.options.dataDir);
    await mkdir(home, { recursive: true, mode: 0o700 });
    this.options.report("Requesting one administrator-approved Windows sandbox setup for the fixed EASY CODE proxy-port pool.");
    return withWindowsProxyProvisioningLock(this.options.dataDir, async () => {
      const current = await unlocked();
      if (current.status === "ready") return { status: "already_ready" as const,
        message: "Native sandbox is already ready.", readiness: current };
      try {
        const proxy = await this.proxyState();
        const service = new NativeAppServerClient(nativeSandboxEntrypoint(), home, process.env, proxy.proxyURL, proxy.ports);
        try {
          await service.initialize(this.startupTimeoutMs);
          const completion = service.waitFor("windowsSandbox/setupCompleted", params => params?.mode === "elevated",
            this.options.limits.nativeSandboxSetupTimeoutMs);
          const started = await service.request("windowsSandbox/setupStart", { mode: "elevated" }, this.startupTimeoutMs);
          if (started?.started !== true) throw new Error("Windows sandbox setup did not start");
          const done = await completion;
          if (done?.success !== true) throw new Error(String(done?.error ?? "Windows native sandbox setup failed"));
        } finally { await service.close(); }
      } catch (error) {
        const message = startupError(error);
        return { status: "failed" as const, message,
          readiness: result("setup_required", [...current.details, `Setup failed: ${message}`], true) };
      }
      const after = await unlocked();
      return { status: after.status === "ready" ? "completed" as const : "failed" as const,
        message: after.status === "ready" ? "Windows native sandbox is ready." : "Windows setup completed but the enforcement probe did not pass.", readiness: after };
    }, this.options.limits.nativeSandboxSetupTimeoutMs + this.startupTimeoutMs);
  }
}
