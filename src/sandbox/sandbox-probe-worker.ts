import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function powershellQuote(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForExit(
  executablePath: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      cwd,
      env: environment,
      shell: false,
      stdio: "ignore",
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
  if (process.platform !== "win32") {
    throw new Error("The isolated ACL probe worker is only valid on Windows");
  }
  if (process.env.EASY_CODE_SANDBOX_PROBE_WORKER !== "1") {
    throw new Error("The isolated ACL probe worker must be launched by EASY CODE");
  }

  const runtime = await import("@anthropic-ai/sandbox-runtime");
  if (!runtime.SandboxManager.isSupportedPlatform()) {
    throw new Error("Anthropic Sandbox Runtime does not support this Windows host");
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), "easy-code-sandbox-doctor-"));
  let initialized = false;
  try {
    const protectedDirectory = path.join(scratch, "protected");
    await mkdir(protectedDirectory);
    await runtime.SandboxManager.initialize({
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
        allowRead: [scratch, path.dirname(process.execPath)],
        allowWrite: [scratch],
        // This child directory forces SRT through the real ACL stamp/restore
        // path that previously froze the interactive EASY CODE process.
        denyWrite: [protectedDirectory],
        allowGitConfig: false,
      },
      credentials: { envVars: [] },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
      allowPty: false,
      git: { safeDirectories: [] },
      windows: { srtWin: { path: runtime.VENDORED_SRT_WIN_EXE } },
    });
    initialized = true;

    const command = `& ${powershellQuote(process.execPath)} -e ${powershellQuote("process.exit(0)")}`;
    const wrapped = await runtime.SandboxManager.wrapWithSandboxArgv(
      command,
      "powershell",
      undefined,
      undefined,
      scratch,
      { commandId: "easy-code-sandbox-doctor", commandText: "sandbox readiness probe" },
    );
    const executablePath = wrapped.argv[0];
    if (!executablePath) throw new Error("Sandbox probe did not return an executable");
    const environment = { ...wrapped.env };
    for (const name of [
      "QWEN_API_KEY",
      "DASHSCOPE_API_KEY",
      "DEEPSEEK_API_KEY",
      "ZAI_API_KEY",
      "GLM_API_KEY",
      "ZHIPUAI_API_KEY",
    ]) delete environment[name];
    const exitCode = await waitForExit(
      executablePath,
      wrapped.argv.slice(1),
      scratch,
      environment,
    );
    if (exitCode !== 0) {
      throw new Error(`Sandboxed process probe failed with exit code ${String(exitCode)}`);
    }
  } finally {
    try {
      if (initialized) runtime.SandboxManager.cleanupAfterCommand();
    } finally {
      try {
        await runtime.SandboxManager.reset();
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  }
}

void main().catch((error) => {
  process.stderr.write(`EASY CODE isolated Windows sandbox probe failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
