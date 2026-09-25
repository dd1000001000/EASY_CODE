import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { resolveEasyCodePaths } from "../config/defaults.js";
import { NativeAppServerClient } from "./app-server-client.js";
import { nativePermissionProfile, nativeProjectPermissionProfile } from "./native-policy.js";
import { nativeSandboxEnvironment, nativeSandboxEntrypoint, nativeSandboxHome, nativeSandboxRuntimeVersion } from "./native-runtime.js";
import { ensureNativeProjectPermissionHome } from "./permission-home.js";
import { sandboxIsReady, type SandboxReadiness, type SandboxSetupResult, type SandboxStartupService } from "./startup.js";
import type { NativeStartupPlatform, ReadinessResult } from "./platform/startup-types.js";
import { startupError } from "./platform/startup-types.js";
import { WindowsNativeStartup } from "./platform/windows-startup.js";
import { MacNativeStartup } from "./platform/macos-startup.js";
import { LinuxNativeStartup } from "./platform/linux-startup.js";

/** Owns the common probe lifecycle; each host implementation owns its policy and setup. */
export class NativeSandboxStartupService implements SandboxStartupService {
  private readonly platform: NativeStartupPlatform | undefined;

  constructor(
    private readonly limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS,
    private readonly dataDir?: string,
    report: (message: string) => void = () => undefined,
    private readonly projectRoots?: readonly string[],
  ) {
    const options = { limits, dataDir: dataDir ?? resolveEasyCodePaths().dataDir, report };
    switch (process.platform) {
      case "win32": this.platform = new WindowsNativeStartup(options); break;
      case "darwin": this.platform = new MacNativeStartup(options); break;
      case "linux": this.platform = new LinuxNativeStartup(options); break;
      default: this.platform = undefined;
    }
  }

  private result: ReadinessResult = (status, details, canSetup = false) => ({
    status, platform: process.platform,
    backend: this.platform?.backendName ?? "Native OS sandbox (unsupported)",
    details, canSetup, warnings: [],
  });

  private async sandboxHome(): Promise<string> {
    const baseHome = nativeSandboxHome(this.dataDir);
    return this.projectRoots?.length
      ? ensureNativeProjectPermissionHome(baseHome, this.projectRoots)
      : baseHome;
  }

  private async inspectUnlocked(): Promise<SandboxReadiness> {
    const platform = this.platform;
    if (!platform) return this.result("unsupported", [`Unsupported native sandbox platform: ${process.platform}`]);
    const home = await this.sandboxHome();
    let temporaryRoot: string | undefined;
    try {
      await mkdir(home, { recursive: true, mode: 0o700 });
      if (!this.projectRoots?.length) {
        temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "easy-code-native-readiness-"));
      }
      const probeRoot = this.projectRoots?.[0] ?? temporaryRoot!;
      const proxy = await platform.proxyState();
      const service = new NativeAppServerClient(nativeSandboxEntrypoint(), home, process.env, proxy?.proxyURL, proxy?.ports);
      try {
        await service.initialize(this.limits.sandboxStartupWindowsMs);
        const notReady = await platform.checkReadiness(service, this.result);
        if (notReady) return notReady;
        const probe = await service.request("command/exec", {
          command: platform.probeCommand, cwd: probeRoot,
          ...(proxy ? { env: nativeSandboxEnvironment(home, process.env, proxy.proxyURL, proxy.ports) } : {}),
          ...(this.projectRoots?.length ? nativeProjectPermissionProfile() : nativePermissionProfile()), timeoutMs: 15_000,
        }, platform.startupTimeoutMs);
        if (probe?.exitCode !== 0) throw new Error(String(probe?.stderr ?? "readiness command failed"));
        const rejected = platform.checkProbe(probe.stdout, this.result);
        if (rejected) return rejected;
        await platform.probeSucceeded(proxy);
        return this.result("ready", [
          `Installed native runtime ${nativeSandboxRuntimeVersion()} passed an enforced command probe.`,
          platform.successDetail,
        ]);
      } finally { await service.close(); }
    } catch (error) {
      return platform.probeFailed(startupError(error), this.result);
    } finally {
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  inspect(): Promise<SandboxReadiness> {
    return this.platform?.inspect(() => this.inspectUnlocked(), this.result)
      ?? Promise.resolve(this.result("unsupported", [`Unsupported native sandbox platform: ${process.platform}`]));
  }

  async setup(readiness?: SandboxReadiness): Promise<SandboxSetupResult> {
    readiness ??= await this.inspect();
    if (readiness.status === "ready") return { status: "already_ready", message: "Native sandbox is already ready.", readiness };
    if (!this.platform) return { status: "unavailable", message: "This native sandbox platform is unsupported.", readiness };
    return this.platform.setup(readiness, () => this.inspectUnlocked(), this.result, await this.sandboxHome());
  }

  /** Prepare the actual project home before a model or child agent can issue
   * commands. A failed or declined elevation never falls through to exec. */
  async prepare(): Promise<SandboxReadiness> {
    const readiness = await this.inspect();
    if (sandboxIsReady(readiness) || process.platform !== "win32" ||
      readiness.status !== "setup_required" || !readiness.canSetup) return readiness;
    return (await this.setup(readiness)).readiness;
  }
}
