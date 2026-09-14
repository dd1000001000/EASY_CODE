import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { NativeAppServerClient } from "./app-server-client.js";
import { nativePermissionProfile } from "./native-policy.js";
import {
  nativeSandboxBootstrapEntrypoint,
  nativeSandboxEntrypoint,
  nativeSandboxHome,
  nativeSandboxRuntimeVersion,
} from "./native-runtime.js";
import type { SandboxReadiness, SandboxSetupResult, SandboxStartupService } from "./startup.js";
import { prepareWindowsSandboxStorage } from "./windows-bootstrap.js";

const WINDOWS_SANDBOX_BIN_LOCK_REGRESSION_VERSIONS = new Set(["0.154.0"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function needsWindowsBootstrapCompatibility(error: unknown, runtimeVersion: string): boolean {
  return WINDOWS_SANDBOX_BIN_LOCK_REGRESSION_VERSIONS.has(runtimeVersion)
    && /helper_sandbox_lock_failed:[\s\S]*lock sandbox bin dir/iu.test(errorMessage(error));
}

export class NativeSandboxStartupService implements SandboxStartupService {
  constructor(private readonly limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS,
    private readonly dataDir?: string, private readonly report: (message: string) => void = () => undefined) {}

  private result(status: SandboxReadiness["status"], details: string[], canSetup = false): SandboxReadiness {
    const platformName = process.platform === "win32" ? "Windows elevated" : process.platform === "darwin" ? "macOS Seatbelt" : "Linux bubblewrap/seccomp";
    return { status, platform: process.platform, backend: `Native OS sandbox (${platformName})`, details, canSetup, warnings: [] };
  }

  private async runWindowsSetup(entrypoint: string, home: string): Promise<void> {
    const service = new NativeAppServerClient(entrypoint, home);
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

  async inspect(): Promise<SandboxReadiness> {
    if (!["win32", "darwin", "linux"].includes(process.platform)) return this.result("unsupported", [`Unsupported native sandbox platform: ${process.platform}`]);
    const home = nativeSandboxHome(this.dataDir);
    let root: string | undefined;
    try {
      await mkdir(home, { recursive: true, mode: 0o700 });
      root = await mkdtemp(path.join(os.tmpdir(), "easy-code-native-readiness-"));
      const service = new NativeAppServerClient(nativeSandboxEntrypoint(), home);
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
          ...nativePermissionProfile(), timeoutMs: 15_000 },
          process.platform === "win32" ? this.limits.sandboxStartupWindowsMs : this.limits.sandboxStartupPosixMs);
        if (result?.exitCode !== 0) throw new Error(String(result?.stderr ?? "readiness command failed"));
        if (process.platform === "win32" && !/\\codexsandboxoffline\s*$/iu.test(String(result.stdout ?? "").trim()))
          return this.result("setup_required", ["The dedicated Windows offline identity is not active. Elevated setup is required."], true);
        return this.result("ready", [`Installed native runtime ${nativeSandboxRuntimeVersion()} passed an enforced command probe.`,
          process.platform === "win32" ? "Dedicated offline identity is active." : "Native filesystem sandbox is active."]);
      } finally { await service.close(); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.result(process.platform === "win32" ? "setup_required" : /not found|ENOENT|bubblewrap|bwrap/iu.test(message)
        ? "dependencies_missing" : "probe_failed", [message.slice(0, 2000)], process.platform === "win32");
    } finally { if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined); }
  }

  async setup(readiness?: SandboxReadiness): Promise<SandboxSetupResult> {
    const home = nativeSandboxHome(this.dataDir);
    if (process.platform === "win32") {
      try {
        const migration = await prepareWindowsSandboxStorage(home);
        if (migration.legacyAclRemoved) this.report("Removed a retired SRT deny ACL from EASY CODE's native sandbox storage.");
      } catch (error) {
        const before = readiness ?? this.result("setup_required", ["Windows native sandbox storage is not prepared."], true);
        return this.setupFailure(errorMessage(error), before);
      }
    }
    readiness ??= await this.inspect();
    if (readiness.status === "ready") return { status: "already_ready", message: "Native sandbox is already ready.", readiness };
    if (process.platform !== "win32") return { status: "unavailable",
      message: "Install the platform dependency reported by the readiness check, then recheck. EASY CODE does not modify global kernel policy automatically.", readiness };
    await mkdir(home, { recursive: true, mode: 0o700 });
    this.report("Requesting administrator-approved Windows native sandbox setup.");
    try {
      await this.runWindowsSetup(nativeSandboxEntrypoint(), home);
    } catch (error) {
      const primaryMessage = errorMessage(error);
      const runtimeVersion = nativeSandboxRuntimeVersion();
      if (!needsWindowsBootstrapCompatibility(error, runtimeVersion)) {
        return this.setupFailure(primaryMessage, readiness);
      }
      this.report(`Native runtime ${runtimeVersion} hit its known fresh-install bootstrap regression; using the bundled compatibility bootstrap once.`);
      try {
        // The directory is private, generated sandbox state. Resetting it here
        // avoids retaining a partially locked directory owned by the elevated
        // helper. Journal, configuration and project data live elsewhere.
        await rm(home, { recursive: true, force: true });
        await prepareWindowsSandboxStorage(home);
        await mkdir(home, { recursive: true, mode: 0o700 });
        await this.runWindowsSetup(nativeSandboxBootstrapEntrypoint(), home);
      } catch (fallbackError) {
        return this.setupFailure(
          `${primaryMessage}; compatibility bootstrap failed: ${errorMessage(fallbackError)}`,
          readiness,
        );
      }
    }
    const after = await this.inspect();
    return { status: after.status === "ready" ? "completed" : "failed",
      message: after.status === "ready" ? "Windows native sandbox is ready." : "Windows setup completed but the enforcement probe did not pass.", readiness: after };
  }
}
