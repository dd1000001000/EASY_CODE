import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodeSandboxControl } from "./control.js";
import { resolveTrustedSystemExecutable } from "./startup.js";
import type {
  SandboxBackendName,
  SandboxWorkerControl,
  SandboxWorkerPayload,
} from "./types.js";

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
  process.stderr.write(encodeSandboxControl(commandId, control));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForChild(
  executablePath: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
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
      if (typeof code === "number") resolve(code);
      else resolve(signal ? 128 : 1);
    });
  });
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) throw new Error("Missing EASY CODE sandbox worker payload");
  const payload = JSON.parse(await readFile(payloadPath, "utf8")) as SandboxWorkerPayload;
  if (payload.version !== 1 || !payload.commandId || !payload.target?.executablePath) {
    throw new Error("Invalid EASY CODE sandbox worker payload");
  }

  const srt = await import("@anthropic-ai/sandbox-runtime");
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
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const bridgePath = path.join(moduleDirectory, "argv-bridge.js");
  const command = process.platform === "win32"
    ? `& ${powershellQuote(process.execPath)} ${powershellQuote(bridgePath)} ${powershellQuote(targetPayloadPath)}`
    : posixQuote([process.execPath, bridgePath, targetPayloadPath]);
  const config = {
    network: {
      allowedDomains: payload.network.allowedDomains,
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: payload.filesystem,
    credentials: {
      envVars: [
        "QWEN_API_KEY",
        "DASHSCOPE_API_KEY",
        "DEEPSEEK_API_KEY",
        "ZAI_API_KEY",
        "GLM_API_KEY",
        "ZHIPUAI_API_KEY",
      ].map((name) => ({ name, mode: "deny" as const })),
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
  try {
    await SandboxManager.initialize(config);
    initialized = true;
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      command,
      process.platform === "win32" ? "powershell" : undefined,
      undefined,
      undefined,
      payload.target.cwdAbsolute,
      { commandId: payload.commandId, commandText: payload.commandPreview },
    );
    writeControl(payload.commandId, { type: "ready", backend: backendName() });
    let exitCode: number;
    try {
      exitCode = await waitForChild(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: payload.target.cwdAbsolute,
        env: wrapped.env,
      });
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
    if (initialized) SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
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
  writeControl(commandId, { type: "sandbox_error", message });
  process.stderr.write(`EASY CODE sandbox unavailable: ${message}\n`);
  process.exitCode = 125;
}

void main().catch(reportFailure);
