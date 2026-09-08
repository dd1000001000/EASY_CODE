import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import path from "node:path";

import { ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES } from "../models/catalog.js";
import { encodeSandboxControl } from "./control.js";
import { assertWindowsAclCleanup } from "./windows-cleanup.js";
import { resolveTrustedSystemExecutable } from "./startup.js";
import { allowBrokeredNetworkHost } from "../command/network-destination.js";
import type {
  SandboxBackendName,
  SandboxWorkerControl,
  SandboxWorkerPayload,
} from "./types.js";

const workerStartedAt = Date.now();
let isolationTouched = false;
let cleanupReported = false;

if (process.env.SRT_DEBUG) {
  const originalConsoleError = console.error.bind(console);
  console.error = (...values: unknown[]): void => {
    originalConsoleError(
      `[EASY CODE sandbox worker +${String(Date.now() - workerStartedAt)}ms]`,
      ...values,
    );
  };
}

function debugWorker(stage: string): void {
  if (!process.env.SRT_DEBUG) return;
  process.stderr.write(
    `[EASY CODE sandbox worker +${String(Date.now() - workerStartedAt)}ms] ${stage}\n`,
  );
}

function backendName(): SandboxBackendName {
  return process.platform === "win32"
    ? "anthropic-srt-windows"
    : process.platform === "darwin"
      ? "anthropic-srt-macos"
      : "anthropic-srt-linux";
}

function posixQuote(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/gu, `'"'"'`)}'`).join(" ");
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function writeControl(commandId: string, control: SandboxWorkerControl): void {
  // The target receives only fd 0/1/2. Control records cannot be forged through
  // target output or lost to ordinary output clipping.
  writeSync(3, encodeSandboxControl(commandId, control));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertScratchFile(scratchRoot: string, filename: string, label: string): void {
  const relative = path.relative(path.resolve(scratchRoot), path.resolve(filename));
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${label} must be a file inside the command scratch root`);
  }
}

async function waitForChild(
  executablePath: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; commandId: string },
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    // Record intent before spawning, so a crash between spawn and its callback
    // never proves that the requested command was unstarted.
    writeControl(options.commandId, { type: "execution_dispatched" });
    const child = spawn(executablePath, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
      detached: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        writeControl(options.commandId, { type: "execution_exited", exitCode: code });
        resolve(code);
      }
      else resolve(signal ? 128 : 1);
    });
  });
}

async function main(): Promise<void> {
  if (process.platform === "win32" && process.env.EASY_CODE_JOB_HANDSHAKE === "1") {
    // Parent must attach this worker to its Job Object before any untrusted spawn.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Missing command job authorization")), 20000);
      process.stdin.once("data", (chunk: Buffer) => {
        clearTimeout(timer);
        if (chunk.toString().trim() !== "GO") reject(new Error("Invalid command job authorization")); else resolve();
      });
      process.stdin.once("end", () => { clearTimeout(timer); reject(new Error("Command supervisor disconnected")); });
    });
  }
  const payloadPath = process.argv[2];
  if (!payloadPath) throw new Error("Missing EASY CODE sandbox worker payload");
  const payload = JSON.parse(await readFile(payloadPath, "utf8")) as SandboxWorkerPayload;
  if (
    payload.version !== 1 ||
    !payload.commandId ||
    !payload.target?.executablePath ||
    !payload.bridgePath
  ) {
    throw new Error("Invalid EASY CODE sandbox worker payload");
  }
  writeControl(payload.commandId, { type: "stage", stage: "worker_started" });
  debugWorker("worker_started");
  assertScratchFile(payload.scratchRoot, payload.bridgePath, "Sandbox bridge");

  const srt = await import("@anthropic-ai/sandbox-runtime");
  writeControl(payload.commandId, { type: "stage", stage: "runtime_loaded" });
  debugWorker("runtime_loaded");
  const { SandboxManager } = srt;
  if (!SandboxManager.isSupportedPlatform()) {
    throw new Error(`Anthropic Sandbox Runtime does not support ${process.platform}`);
  }
  let linuxPaths:
    | { bwrapPath: string; socatPath: string; ripgrepPath: string }
    | undefined;
  if (process.platform !== "win32") {
    if (process.platform === "linux") {
      const bwrapPath = await resolveTrustedSystemExecutable(["/usr/bin/bwrap", "/bin/bwrap"]);
      const socatPath = await resolveTrustedSystemExecutable(["/usr/bin/socat", "/bin/socat"]);
      const ripgrepPath = await resolveTrustedSystemExecutable(["/usr/bin/rg", "/bin/rg"]);
      if (!bwrapPath || !socatPath || !ripgrepPath) {
        throw new Error(
          "Linux sandbox dependencies must resolve from trusted system paths; run `easy-code sandbox setup`.",
        );
      }
      linuxPaths = { bwrapPath, socatPath, ripgrepPath };
    }
    const dependencies = await SandboxManager.checkDependenciesAsync(
      linuxPaths ? { command: linuxPaths.ripgrepPath } : undefined,
    );
    const dependencyErrors = linuxPaths
      ? dependencies.errors.filter((value) => {
          const lower = value.toLowerCase();
          return !lower.includes("bubblewrap") &&
            !lower.includes("bwrap") &&
            !lower.includes("socat");
        })
      : dependencies.errors;
    if (dependencyErrors.length || dependencies.warnings.length) {
      throw new Error(
        [...dependencyErrors, ...dependencies.warnings].join("; "),
      );
    }
  }

  const targetPayloadPath = path.join(payload.scratchRoot, "target-payload.json");
  await writeFile(targetPayloadPath, JSON.stringify(payload.target), {
    encoding: "utf8",
    mode: 0o600,
  });
  const command = process.platform === "win32"
    ? `& ${powershellQuote(process.execPath)} ${powershellQuote(payload.bridgePath)} ${powershellQuote(targetPayloadPath)}`
    : posixQuote([process.execPath, payload.bridgePath, targetPayloadPath]);
  const config = {
    network: {
      allowedDomains: payload.network.allowedDomains,
      deniedDomains: [],
      strictAllowlist: !payload.network.proxyURL,
      ...(payload.network.proxyURL ? { parentProxy: { http: payload.network.proxyURL, https: payload.network.proxyURL, noProxy: "" } } : {}),
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: payload.filesystem,
    credentials: {
      envVars: ALL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES.map((name) => ({
        name,
        mode: "deny" as const,
      })),
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    allowPty: false,
    git: { safeDirectories: [payload.workspaceRoot] },
    ...(linuxPaths
      ? {
          bwrapPath: linuxPaths.bwrapPath,
          socatPath: linuxPaths.socatPath,
          ripgrep: { command: linuxPaths.ripgrepPath },
        }
      : {}),
    ...(process.platform === "win32"
      ? { windows: { srtWin: { path: srt.VENDORED_SRT_WIN_EXE } } }
      : {}),
  };

  let initialized = false;
  const windowsSid = process.platform === "win32"
    ? (await srt.getWindowsSandboxUserStatusAsync({ srtWin: { exe: srt.VENDORED_SRT_WIN_EXE, prependArgs: [] } })).sid
    : undefined;
  if (process.platform === "win32" && !windowsSid) throw new Error("Sandbox identity could not be established before initialization");
  try {
    writeControl(payload.commandId, { type: "stage", stage: "initialize_start" });
    debugWorker("initialize_start");
    isolationTouched = true;
    // The trusted parent gate owns approval, DNS pinning and command lifetime.
    // With no gate (Benchmark), unmatched destinations remain unconditionally denied.
    await SandboxManager.initialize(config, payload.network.proxyURL ? async ({ host }) => allowBrokeredNetworkHost(host) : undefined);
    initialized = true;
    writeControl(payload.commandId, { type: "stage", stage: "initialize_complete" });
    debugWorker("initialize_complete");
    writeControl(payload.commandId, { type: "stage", stage: "wrap_start" });
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      command,
      process.platform === "win32" ? "powershell" : undefined,
      undefined,
      undefined,
      payload.target.cwdAbsolute,
      { commandId: payload.commandId, commandText: payload.commandPreview },
    );
    writeControl(payload.commandId, { type: "stage", stage: "wrap_complete" });
    debugWorker("wrap_complete");
    writeControl(payload.commandId, { type: "ready", backend: backendName() });
    let exitCode: number;
    try {
      debugWorker("target_spawn_start");
      exitCode = await waitForChild(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: payload.target.cwdAbsolute,
        env: wrapped.env,
        commandId: payload.commandId,
      });
      debugWorker(`target_exit_${String(exitCode)}`);
    } catch (error) {
      writeControl(payload.commandId, {
        type: "target_spawn_error",
        message: errorMessage(error),
      });
      throw error;
    }
    const violationText = SandboxManager.annotateStderrWithSandboxFailures(
      payload.commandId,
      "",
    );
    if (violationText.trim()) process.stderr.write(`${violationText.trim()}\n`);
    process.exitCode = exitCode;
  } finally {
    try {
      if (process.platform === "win32" && process.env.EASY_CODE_JOB_HANDSHAKE === "1") {
        // Keep ACL/network restrictions in place until the trusted parent has
        // removed every descendant other than this idle cleanup worker.
        await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error("Cleanup authorization timed out")),15000);
          process.stdin.once("data",(chunk:Buffer)=>{clearTimeout(timer);if(chunk.toString().trim()==="CLEANUP")resolve();else reject(new Error("Invalid cleanup authorization"));});
          writeControl(payload.commandId,{type:"cleanup_requested"});
        });
      }
      if (initialized) SandboxManager.cleanupAfterCommand();
      debugWorker("reset_start");
      if (windowsSid) {
        const options = { sandboxUserSid: windowsSid, holderPid: process.pid, srtWin: { exe: srt.VENDORED_SRT_WIN_EXE, prependArgs: [] } };
        assertWindowsAclCleanup(srt.revokeWindowsAcl(options));
        assertWindowsAclCleanup(srt.restoreWindowsAcl(options));
      }
      await SandboxManager.reset();
      writeControl(payload.commandId, { type: "cleanup_complete" });
      cleanupReported = true;
      debugWorker("reset_complete");
    } catch (error) {
      writeControl(payload.commandId, { type: "cleanup_error", message: errorMessage(error) });
      cleanupReported = true;
      process.exitCode = 125;
    }
  }
}

async function reportFailure(error: unknown): Promise<void> {
  const payloadPath = process.argv[2];
  let commandId = "unknown";
  if (payloadPath) {
    try {
      const payload = JSON.parse(await readFile(payloadPath, "utf8")) as Partial<SandboxWorkerPayload>;
      if (typeof payload.commandId === "string") commandId = payload.commandId;
    } catch {
      // Keep the non-secret fallback identifier.
    }
  }
  const message = errorMessage(error);
  if (!isolationTouched && !cleanupReported) writeControl(commandId, { type: "cleanup_complete" });
  writeControl(commandId, { type: "sandbox_error", message });
  process.stderr.write(`EASY CODE sandbox unavailable: ${message}\n`);
  process.exitCode = 125;
}

void main().catch(reportFailure);
