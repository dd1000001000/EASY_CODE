import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { resolveEasyCodePaths } from "../config/defaults.js";
import { ensureSharedCommandNetworkGateServer } from "../command/network-gate.js";
import { NativeAppServerClient } from "./app-server-client.js";
import { nativePermissionProfile } from "./native-policy.js";
import {
  nativeSandboxEnvironment,
  nativeSandboxEntrypoint,
  nativeSandboxHome,
  nativeSandboxRuntimeVersion,
} from "./native-runtime.js";
import type { SandboxReadiness, SandboxSetupResult, SandboxStartupService } from "./startup.js";
import {
  acquireWindowsProxyPortLease,
  withWindowsProxyProvisioningLock,
  type WindowsProxyPortLease,
} from "./windows-proxy-registry.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class NativeSandboxStartupService implements SandboxStartupService {
  private proxyLease?: Promise<WindowsProxyPortLease>;
  constructor(private readonly limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS,
    private readonly dataDir?: string, private readonly report: (message: string) => void = () => undefined) {}

  private result(status: SandboxReadiness["status"], details: string[], canSetup = false): SandboxReadiness {
    const platformName = process.platform === "win32" ? "Windows elevated" : process.platform === "darwin" ? "macOS Seatbelt" : "Linux bubblewrap/seccomp";
    return { status, platform: process.platform, backend: `Native OS sandbox (${platformName})`, details, canSetup, warnings: [] };
  }

  private resolvedDataDir(): string { return this.dataDir ?? resolveEasyCodePaths().dataDir; }

  /** Bind one broker for this CLI before inspecting Windows policy. Main,
   * child and reviewer agents in the process later reuse this listener. */
  private async windowsProxyState(): Promise<{ lease: WindowsProxyPortLease; proxyURL: string; ports: readonly number[] } | undefined> {
    if (process.platform !== "win32") return undefined;
    this.proxyLease ??= acquireWindowsProxyPortLease({
      dataDir: this.resolvedDataDir(),
      portStart: this.limits.nativeSandboxProxyPortStart,
      portSlots: this.limits.nativeSandboxProxyPortSlots,
      bind: ensureSharedCommandNetworkGateServer,
    });
    const lease = await this.proxyLease;
    return { lease, proxyURL: `http://127.0.0.1:${lease.port}`, ports: await lease.setupPorts() };
  }

  private async runWindowsSetup(entrypoint: string, home: string): Promise<void> {
    const proxy = await this.windowsProxyState();
    const service = new NativeAppServerClient(entrypoint, home, process.env, proxy?.proxyURL, proxy?.ports);
    try {
      await service.initialize(this.limits.sandboxStartupWindowsMs);
      const completion = service.waitFor("windowsSandbox/setupCompleted", params => params?.mode === "elevated",
        this.limits.nativeSandboxSetupTimeoutMs);
      const started = await service.request("windowsSandbox/setupStart", { mode: "elevated" }, this.limits.sandboxStartupWindowsMs);
      if (started?.started !== true) throw new Error("Windows sandbox setup did not start");
      const result = await completion;
      if (result?.success !== true) throw new Error(String(result?.error ?? "Windows native sandbox setup failed"));
    } finally {
      await service.close();
    }
  }

  private setupFailure(message: string, readiness: SandboxReadiness): SandboxSetupResult {
    return {
      status: "failed",
      message,
      readiness: this.result("setup_required", [...readiness.details, `Setup failed: ${message}`], true),
    };
  }

  private async inspectUnlocked(): Promise<SandboxReadiness> {
    if (!["win32", "darwin", "linux"].includes(process.platform)) return this.result("unsupported", [`Unsupported native sandbox platform: ${process.platform}`]);
    const home = nativeSandboxHome(this.dataDir);
    let root: string | undefined;
    try {
      await mkdir(home, { recursive: true, mode: 0o700 });
      root = await mkdtemp(path.join(os.tmpdir(), "easy-code-native-readiness-"));
      const proxy = await this.windowsProxyState();
      const service = new NativeAppServerClient(nativeSandboxEntrypoint(), home, process.env, proxy?.proxyURL, proxy?.ports);
      try {
        await service.initialize(this.limits.sandboxStartupWindowsMs);
        if (process.platform === "win32") {
          const configured = await service.request("windowsSandbox/readiness", {}, this.limits.sandboxStartupWindowsMs);
          if (configured?.status !== "ready") return this.result("setup_required", [`Windows sandbox status: ${String(configured?.status ?? "unknown")}`], true);
        }
        const probe = process.platform === "win32"
          ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe")]
          : ["/bin/sh", "-c", "printf EASY_CODE_NATIVE_OK"];
        const result = await service.request("command/exec", { command: probe, cwd: root,
          ...(proxy ? { env: nativeSandboxEnvironment(home, process.env, proxy.proxyURL, proxy.ports) } : {}),
          ...nativePermissionProfile(), timeoutMs: 15_000 },
          process.platform === "win32" ? this.limits.sandboxStartupWindowsMs : this.limits.sandboxStartupPosixMs);
        if (result?.exitCode !== 0) throw new Error(String(result?.stderr ?? "readiness command failed"));
        if (process.platform === "win32" && !/\\codexsandboxoffline\s*$/iu.test(String(result.stdout ?? "").trim()))
          return this.result("setup_required", ["The dedicated Windows offline identity is not active. Elevated setup is required."], true);
        await proxy?.lease.markAuthorized();
        return this.result("ready", [`Installed native runtime ${nativeSandboxRuntimeVersion()} passed an enforced command probe.`,
          process.platform === "win32" ? "Dedicated offline identity is active." : "Native filesystem sandbox is active."]);
      } finally { await service.close(); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result(process.platform === "win32" ? "setup_required" : /not found|ENOENT|bubblewrap|bwrap/iu.test(message)
        ? "dependencies_missing" : "probe_failed", [message.slice(0, 2000)], process.platform === "win32");
    } finally { if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined); }
  }

  async inspect(): Promise<SandboxReadiness> {
    if (process.platform !== "win32") return this.inspectUnlocked();
    try {
      const proxy = await this.windowsProxyState();
      const authorized = await proxy!.lease.authorizedPorts();
      if (authorized.includes(proxy!.lease.port)) return this.inspectUnlocked();
      // A first probe may cause the native runtime to reconcile durable WFP
      // policy. Serialize it with setup so two fresh shells cannot publish
      // competing port sets and both incorrectly mark themselves authorized.
      return withWindowsProxyProvisioningLock(this.resolvedDataDir(), () => this.inspectUnlocked(),
        this.limits.nativeSandboxSetupTimeoutMs + this.limits.sandboxStartupWindowsMs);
    } catch (error) {
      return this.result("setup_required", [errorMessage(error).slice(0, 2000)], true);
    }
  }

  async setup(readiness?: SandboxReadiness): Promise<SandboxSetupResult> {
    const home = nativeSandboxHome(this.dataDir);
    readiness ??= await this.inspect();
    if (readiness.status === "ready") return { status: "already_ready", message: "Native sandbox is already ready.", readiness };
    if (process.platform !== "win32") return { status: "unavailable",
      message: "Install the platform dependency reported by the readiness check, then recheck. EASY CODE does not modify global kernel policy automatically.", readiness };
    await mkdir(home, { recursive: true, mode: 0o700 });
    this.report("Requesting one administrator-approved Windows sandbox setup for this EASY CODE process port.");
    return withWindowsProxyProvisioningLock(this.resolvedDataDir(), async () => {
      // Another CLI may have completed the same durable union while this process
      // waited for the setup lock. Recheck before opening an elevation prompt.
      const current = await this.inspectUnlocked();
      if (current.status === "ready") return { status: "already_ready" as const,
        message: "Native sandbox is already ready.", readiness: current };
      try {
        await this.runWindowsSetup(nativeSandboxEntrypoint(), home);
      } catch (error) {
        return this.setupFailure(errorMessage(error), current);
      }
      const after = await this.inspectUnlocked();
      return { status: after.status === "ready" ? "completed" : "failed",
        message: after.status === "ready" ? "Windows native sandbox is ready." : "Windows setup completed but the enforcement probe did not pass.", readiness: after };
    }, this.limits.nativeSandboxSetupTimeoutMs + this.limits.sandboxStartupWindowsMs);
  }
}
