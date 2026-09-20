import { hostPlatform } from "../core/host-platform.js";
import { terminateWindowsProcessTree } from "./platform/windows.js";
import { terminateMacProcessTree } from "./platform/macos.js";
import { terminateLinuxProcessTree } from "./platform/linux.js";

export interface KillableSubprocess {
  pid?: number;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number, options?: { forceKillAfterTimeout?: number | false }): void;
}

/** @internal Dependency overrides used only by focused lifecycle tests. */
export interface ProcessTreeTerminationTestHooks {
  platform?: NodeJS.Platform;
  taskkillTimeoutMs?: number;
  spawnTaskkill?: typeof import("node:child_process").spawn;
}

export interface TerminationResult { confirmed: boolean; method: string; }

/** Terminate a command and its descendants without invoking a shell. */
export function terminateProcessTree(
  subprocess: KillableSubprocess,
  graceMs = 1_500,
  testHooks: ProcessTreeTerminationTestHooks = {},
): Promise<TerminationResult> {
  switch (hostPlatform(testHooks.platform)) {
    case "win32": return terminateWindowsProcessTree(subprocess, testHooks);
    case "darwin": return terminateMacProcessTree(subprocess, graceMs);
    case "linux": return terminateLinuxProcessTree(subprocess, graceMs);
  }
}
