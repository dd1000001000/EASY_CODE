import { spawn } from "node:child_process";
import path from "node:path";

const TASKKILL_TIMEOUT_MS = 5_000;

export interface KillableSubprocess {
  pid?: number;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number, options?: { forceKillAfterTimeout?: number | false }): void;
}

/** @internal Dependency overrides used only by focused lifecycle tests. */
export interface ProcessTreeTerminationTestHooks {
  platform?: NodeJS.Platform;
  taskkillTimeoutMs?: number;
  spawnTaskkill?: typeof spawn;
}

function runTaskkill(
  pid: number,
  force: boolean,
  spawnTaskkill: typeof spawn,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnTaskkill(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), args, {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(succeeded);
    };
    timer = setTimeout(() => {
      // taskkill is only a best-effort helper. A broken or constrained host
      // must never let the helper keep command cancellation pending forever.
      finish(false);
      try {
        child.kill("SIGKILL");
      } catch {
        // The helper may have exited without delivering a close event.
      }
    }, Math.max(1, timeoutMs));
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processGroupIsAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(25, remaining));
    });
  }
  return true;
}

/** Terminate a command and its descendants without invoking a shell. */
export interface TerminationResult { confirmed: boolean; method: string; }

export async function terminateProcessTree(
  subprocess: KillableSubprocess,
  graceMs = 1_500,
  testHooks: ProcessTreeTerminationTestHooks = {},
): Promise<TerminationResult> {
  const pid = subprocess.pid;
  if (!pid) return { confirmed: true, method: "not-started" };

  if ((testHooks.platform ?? process.platform) === "win32") {
    // Let taskkill enumerate and terminate the whole tree before touching the
    // direct child. Killing a cmd/npm shim first can orphan its real Node child
    // and leave that process holding the workspace as cwd. Awaiting taskkill is
    // also required because Node can report direct-child exit before Windows
    // releases all process/directory handles.
    const treeTerminated = await runTaskkill(
      pid,
      true,
      testHooks.spawnTaskkill ?? spawn,
      testHooks.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS,
    );
    if (treeTerminated) return { confirmed: true, method: "system-taskkill-tree" };

    // Constrained hosts may block taskkill. Direct-child termination is the
    // fallback that still guarantees the command promise can settle.
    try {
      subprocess.kill("SIGTERM", { forceKillAfterTimeout: false });
    } catch {
      // The process may already have exited.
    }
    return { confirmed: false, method: "direct-child-only" };
  }

  let usedProcessGroup = false;
  try {
    // POSIX commands are started in their own process group.
    process.kill(-pid, "SIGTERM");
    usedProcessGroup = true;
  } catch {
    try {
      subprocess.kill("SIGTERM", { forceKillAfterTimeout: graceMs });
    } catch {
      return { confirmed: false, method: "signal-failed" };
    }
  }
  if (!usedProcessGroup) return { confirmed: false, method: "direct-child-only" };
  if (await waitForProcessGroupExit(pid, graceMs)) return { confirmed: true, method: "process-group" };

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      subprocess.kill("SIGKILL", { forceKillAfterTimeout: false });
    } catch {
      return { confirmed: false, method: "signal-failed" };
    }
  }
  return { confirmed: await waitForProcessGroupExit(pid, graceMs), method: "process-group" };
}
