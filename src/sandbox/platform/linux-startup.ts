import type { SandboxReadiness, SandboxSetupResult } from "../startup.js";
import type { NativeStartupOptions, NativeStartupPlatform, ReadinessResult } from "./startup-types.js";

export class LinuxNativeStartup implements NativeStartupPlatform {
  readonly backendName = "Native OS sandbox (Linux bubblewrap/seccomp)";
  readonly probeCommand = ["/bin/sh", "-c", "printf EASY_CODE_NATIVE_OK"];
  readonly successDetail = "Native filesystem sandbox is active.";
  readonly startupTimeoutMs: number;
  constructor(options: NativeStartupOptions) { this.startupTimeoutMs = options.limits.sandboxStartupPosixMs; }
  async proxyState(): Promise<undefined> { return undefined; }
  async checkReadiness(): Promise<undefined> { return undefined; }
  checkProbe(): undefined { return undefined; }
  async probeSucceeded(): Promise<void> { /* No host proxy is needed. */ }
  probeFailed(message: string, result: ReadinessResult): SandboxReadiness {
    return result(/not found|ENOENT|bubblewrap|bwrap/iu.test(message) ? "dependencies_missing" : "probe_failed", [message.slice(0, 2000)]);
  }
  inspect(unlocked: () => Promise<SandboxReadiness>): Promise<SandboxReadiness> { return unlocked(); }
  async setup(readiness: SandboxReadiness): Promise<SandboxSetupResult> {
    return { status: "unavailable", message: "Install the platform dependency reported by the readiness check, then recheck. EASY CODE does not modify global kernel policy automatically.", readiness };
  }
}
