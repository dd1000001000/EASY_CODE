import { spawn } from "node:child_process";

export interface KillableSubprocess {
  pid?: number;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number, options?: { forceKillAfterTimeout?: number | false }): void;
}

function runTaskkill(pid: number, force: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const child = spawn("taskkill.exe", args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(succeeded);
    };
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
export async function terminateProcessTree(
  subprocess: KillableSubprocess,
  graceMs = 1_500,
): Promise<void> {
  const pid = subprocess.pid;
  if (!pid || subprocess.killed) return;

  if (process.platform === "win32") {
    // Let taskkill enumerate and terminate the whole tree before touching the
    // direct child. Killing a cmd/npm shim first can orphan its real Node child
    // and leave that process holding the workspace as cwd. Awaiting taskkill is
    // also required because Node can report direct-child exit before Windows
    // releases all process/directory handles.
    const treeTerminated = await runTaskkill(pid, true);
    if (treeTerminated) return;

    // Constrained hosts may block taskkill. Direct-child termination is the
    // fallback that still guarantees the command promise can settle.
    try {
      subprocess.kill("SIGTERM", { forceKillAfterTimeout: false });
    } catch {
      // The process may already have exited.
    }
    return;
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
      return;
    }
  }
  if (!usedProcessGroup || await waitForProcessGroupExit(pid, graceMs)) return;

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      subprocess.kill("SIGKILL", { forceKillAfterTimeout: false });
    } catch {
      return;
    }
  }
  await waitForProcessGroupExit(pid, graceMs);
}
