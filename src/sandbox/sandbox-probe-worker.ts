import {
  runWindowsSandboxStartupProbe,
  type WindowsStartupProbeRuntime,
} from "./windows-startup-probe.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The isolated ACL probe worker is only valid on Windows");
  }
  if (process.env.EASY_CODE_SANDBOX_PROBE_WORKER !== "1") {
    throw new Error("The isolated ACL probe worker must be launched by EASY CODE");
  }

  const runtime = await import("@anthropic-ai/sandbox-runtime") as unknown as
    WindowsStartupProbeRuntime & {
      readonly SandboxManager: WindowsStartupProbeRuntime["SandboxManager"] & {
        isSupportedPlatform(): boolean;
      };
    };
  if (!runtime.SandboxManager.isSupportedPlatform()) {
    throw new Error("Anthropic Sandbox Runtime does not support this Windows host");
  }
  await runWindowsSandboxStartupProbe(runtime);
}

void main().catch((error) => {
  process.stderr.write(`EASY CODE isolated Windows sandbox probe failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
