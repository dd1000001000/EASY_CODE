import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES } from "../models/catalog.js";
import { createDefaultWindowsSandboxProcessLock } from "./windows-process-lock.js";

const WINDOWS_STARTUP_PROBE_LOCK_WAIT_MS = 20_000;
export const WINDOWS_STARTUP_PROBE_TARGET_TIMEOUT_MS = 10_000;

export interface WindowsStartupProbeRuntime {
  readonly SandboxManager: {
    initialize(config: Record<string, unknown>): Promise<void>;
    wrapWithSandboxArgv(
      command: string,
      binShell?: string,
      customConfig?: Record<string, unknown>,
      signal?: AbortSignal,
      cwd?: string,
      options?: { commandId?: string; commandText?: string },
    ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
    cleanupAfterCommand(): void;
    reset(): Promise<void>;
  };
  readonly VENDORED_SRT_WIN_EXE: string;
}

export interface WindowsStartupProbePlan {
  readonly protectedDirectory: string;
  readonly command: string;
  readonly binShell: string;
  readonly config: Record<string, unknown> & {
    readonly filesystem: {
      readonly denyRead: readonly string[];
      readonly allowRead: readonly string[];
      readonly allowWrite: readonly string[];
      readonly denyWrite: readonly string[];
      readonly allowGitConfig: false;
    };
  };
}

interface WindowsStartupProbeLock {
  acquire(signal?: AbortSignal): Promise<() => Promise<void>>;
}

export interface WindowsStartupProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  /** Test seam; production resolves the fixed System32 cmd.exe path. */
  readonly trustedSystemShellPath?: string;
  /** Test seam; production uses the same process-wide ACL lease as commands. */
  readonly processLock?: WindowsStartupProbeLock;
  readonly createScratch?: () => Promise<string>;
  readonly removeScratch?: (scratch: string) => Promise<void>;
  readonly runProcess?: (
    executablePath: string,
    args: readonly string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    timeoutMs: number,
  ) => Promise<number>;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  expectedName: string,
): string | undefined {
  const direct = environment[expectedName];
  if (direct) return direct;
  const normalizedName = expectedName.toLowerCase();
  for (const [name, value] of Object.entries(environment)) {
    if (name.toLowerCase() === normalizedName && value) return value;
  }
  return undefined;
}

/** Resolve only the OS-owned cmd.exe; never fall back to PATH or ComSpec. */
export async function resolveTrustedWindowsProbeShell(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configuredRoot = environmentValue(environment, "SystemRoot") ??
    environmentValue(environment, "WINDIR") ??
    "C:\\Windows";
  if (!/^[A-Za-z]:[\\/]/u.test(configuredRoot)) {
    throw new Error(
      `Windows sandbox probe requires a local absolute SystemRoot; got ${JSON.stringify(configuredRoot)}`,
    );
  }
  const systemRoot = path.win32.normalize(configuredRoot);
  const candidate = path.win32.join(systemRoot, "System32", "cmd.exe");
  let canonicalRoot: string;
  let executablePath: string;
  try {
    [canonicalRoot, executablePath] = await Promise.all([
      realpath(systemRoot),
      realpath(candidate),
    ]);
  } catch {
    throw new Error(
      `Windows sandbox probe cannot resolve the trusted system command at ${candidate}`,
    );
  }
  const relative = path.win32.relative(canonicalRoot, executablePath);
  const expectedRelative = path.win32.join("System32", "cmd.exe");
  if (relative === ".." || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) {
    throw new Error(
      `Windows sandbox probe rejected a system command outside canonical SystemRoot: ${executablePath}`,
    );
  }
  if (relative.toLowerCase() !== expectedRelative.toLowerCase()) {
    throw new Error(
      `Windows sandbox probe rejected an unexpected canonical system command: ${executablePath}`,
    );
  }
  try {
    await access(executablePath, fsConstants.X_OK);
  } catch {
    throw new Error(
      `Windows sandbox probe cannot execute the trusted system command at ${executablePath}`,
    );
  }
  return executablePath;
}

export function createWindowsStartupProbePlan(
  scratch: string,
  trustedSystemShellPath: string,
  srtWinPath: string,
): WindowsStartupProbePlan {
  const protectedDirectory = path.join(scratch, "protected");
  return {
    protectedDirectory,
    // cmd.exe is already readable/executable by ordinary local users. Keeping
    // the command in the trusted system shell means readiness never needs an
    // ACL grant on process.execPath or its installation directory.
    command: "exit /b 0",
    binShell: trustedSystemShellPath,
    config: {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        strictAllowlist: true,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
      filesystem: {
        denyRead: [],
        // allowWrite already grants read/execute. Keep allowRead empty so the
        // readiness check cannot accidentally widen into an executable tree.
        allowRead: [],
        allowWrite: [scratch],
        // Force SRT through its real deny stamp/restore path.
        denyWrite: [protectedDirectory],
        allowGitConfig: false,
      },
      credentials: { envVars: [] },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
      allowPty: false,
      git: { safeDirectories: [] },
      windows: { srtWin: { path: srtWinPath } },
    },
  };
}

async function waitForExit(
  executablePath: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let timedOut = false;
    const child = spawn(executablePath, [...args], {
      cwd,
      env: environment,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      detached: false,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The parent worker still owns the final process-tree deadline.
      }
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Sandboxed process probe timed out after ${String(timeoutMs)}ms`));
        return;
      }
      if (typeof code === "number") resolve(code);
      else resolve(signal ? 128 : 1);
    });
  });
}

/** Run the destructive part of the Windows readiness check under the ACL lease. */
export async function runWindowsSandboxStartupProbe(
  runtime: WindowsStartupProbeRuntime,
  options: WindowsStartupProbeOptions = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new Error("The isolated ACL probe worker is only valid on Windows");
  }

  const environment = options.environment ?? process.env;
  const trustedSystemShellPath = options.trustedSystemShellPath ??
    await resolveTrustedWindowsProbeShell(environment);
  const processLock: WindowsStartupProbeLock = options.processLock ??
    createDefaultWindowsSandboxProcessLock({
      waitTimeoutMs: WINDOWS_STARTUP_PROBE_LOCK_WAIT_MS,
    });
  const createScratch = options.createScratch ??
    (async () => await mkdtemp(path.join(os.tmpdir(), "easy-code-sandbox-doctor-")));
  const removeScratch = options.removeScratch ??
    (async (scratch) => await rm(scratch, { recursive: true, force: true }));
  const runProcess = options.runProcess ?? waitForExit;
  const scratch = await createScratch();
  const plan = createWindowsStartupProbePlan(
    scratch,
    trustedSystemShellPath,
    runtime.VENDORED_SRT_WIN_EXE,
  );
  let releaseProcessLock: (() => Promise<void>) | undefined;
  try {
    await mkdir(plan.protectedDirectory);
    releaseProcessLock = await processLock.acquire(options.signal);
    let initialized = false;
    try {
      await runtime.SandboxManager.initialize(plan.config);
      initialized = true;

      const wrapped = await runtime.SandboxManager.wrapWithSandboxArgv(
        plan.command,
        plan.binShell,
        undefined,
        options.signal,
        scratch,
        { commandId: "easy-code-sandbox-doctor", commandText: "sandbox readiness probe" },
      );
      const executablePath = wrapped.argv[0];
      if (!executablePath) throw new Error("Sandbox probe did not return an executable");
      const targetEnvironment = { ...wrapped.env };
      for (const name of ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES) {
        delete targetEnvironment[name];
      }
      const exitCode = await runProcess(
        executablePath,
        wrapped.argv.slice(1),
        scratch,
        targetEnvironment,
        WINDOWS_STARTUP_PROBE_TARGET_TIMEOUT_MS,
      );
      if (exitCode !== 0) {
        throw new Error(`Sandboxed process probe failed with exit code ${String(exitCode)}`);
      }
    } finally {
      try {
        if (initialized) runtime.SandboxManager.cleanupAfterCommand();
      } finally {
        // initialize() can fail after a partial ACL batch. SRT performs its own
        // rollback, and reset() is the final best-effort release before the
        // shared EASY CODE lease is returned.
        await runtime.SandboxManager.reset();
      }
    }
  } finally {
    try {
      await removeScratch(scratch);
    } finally {
      await releaseProcessLock?.();
    }
  }
}
