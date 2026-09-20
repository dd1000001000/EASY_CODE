import type { KillableSubprocess, TerminationResult } from "../lifecycle.js";

function processGroupIsAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processGroupIsAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(25, remaining)); });
  }
  return true;
}

export async function terminatePosixProcessTree(
  subprocess: KillableSubprocess,
  graceMs: number,
): Promise<TerminationResult> {
  const pid = subprocess.pid;
  if (!pid) return { confirmed: true, method: "not-started" };
  let usedProcessGroup = false;
  try { process.kill(-pid, "SIGTERM"); usedProcessGroup = true; }
  catch {
    try { subprocess.kill("SIGTERM", { forceKillAfterTimeout: graceMs }); }
    catch { return { confirmed: false, method: "signal-failed" }; }
  }
  if (!usedProcessGroup) return { confirmed: false, method: "direct-child-only" };
  if (await waitForProcessGroupExit(pid, graceMs)) return { confirmed: true, method: "process-group" };
  try { process.kill(-pid, "SIGKILL"); }
  catch {
    try { subprocess.kill("SIGKILL", { forceKillAfterTimeout: false }); }
    catch { return { confirmed: false, method: "signal-failed" }; }
  }
  return { confirmed: await waitForProcessGroupExit(pid, graceMs), method: "process-group" };
}
