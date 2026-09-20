import { spawn } from "node:child_process";
import path from "node:path";
import type { KillableSubprocess, ProcessTreeTerminationTestHooks, TerminationResult } from "../lifecycle.js";
import { containWindowsWorker, type WindowsCommandJob } from "../windows-job.js";
import type { CommandWorkerPlatform, WorkerProcess } from "./worker-types.js";
import type { PreparedCommand } from "../../sandbox/types.js";
import type { RuntimeLimits } from "../../config/runtime-limits.js";

const TASKKILL_TIMEOUT_MS = 5_000;

function runTaskkill(pid: number, spawnTaskkill: typeof spawn, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnTaskkill(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
    } catch { resolve(false); return; }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(succeeded);
    };
    timer = setTimeout(() => {
      finish(false);
      try { child.kill("SIGKILL"); } catch { /* The helper may already have exited. */ }
    }, Math.max(1, timeoutMs));
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

export async function terminateWindowsProcessTree(
  subprocess: KillableSubprocess,
  hooks: ProcessTreeTerminationTestHooks,
): Promise<TerminationResult> {
  const pid = subprocess.pid;
  if (!pid) return { confirmed: true, method: "not-started" };
  // Terminate the tree before its direct child so a cmd/npm shim cannot orphan Node.
  if (await runTaskkill(pid, hooks.spawnTaskkill ?? spawn, hooks.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS))
    return { confirmed: true, method: "system-taskkill-tree" };
  try { subprocess.kill("SIGTERM", { forceKillAfterTimeout: false }); } catch { /* Already exited. */ }
  return { confirmed: false, method: "direct-child-only" };
}

export class WindowsCommandWorker implements CommandWorkerPlatform {
  readonly detached = false;
  private job?: WindowsCommandJob;

  startupTimeoutMs(limits: Readonly<RuntimeLimits>): number { return limits.sandboxStartupWindowsMs; }

  launchEnvironment(prepared: PreparedCommand): NodeJS.ProcessEnv {
    return { ...prepared.environment, ...(prepared.controlPipe && prepared.windowsJobContainment !== false
      ? { EASY_CODE_JOB_HANDSHAKE: "1" } : {}) };
  }
  stdinMode(prepared: PreparedCommand): "pipe" | "ignore" { return prepared.controlPipe ? "pipe" : "ignore"; }
  needsAttachment(prepared: PreparedCommand): boolean {
    return Boolean(prepared.controlPipe && !prepared.externalLifecycle && prepared.windowsJobContainment !== false);
  }
  async attach(process: WorkerProcess): Promise<void> {
    if (!process.pid) throw new Error("Worker did not start");
    this.job = await containWindowsWorker(process.pid);
  }
  continueWorker(process: WorkerProcess): void { process.stdin?.write("GO\n"); }
  hasSupervisor(): boolean { return this.job !== undefined; }
  cooperativeStop(process: WorkerProcess): boolean { process.stdin?.write("TERMINATE\n"); return true; }
  quiesce(): Promise<void> {
    if (!this.job) throw new Error("Missing Windows job supervisor at cleanup");
    return this.job.quiesce();
  }
  async cleanupRequested(process: WorkerProcess): Promise<void> {
    await this.quiesce();
    process.stdin?.end("CLEANUP\n");
  }
  forceStop(process: WorkerProcess): Promise<TerminationResult> {
    return this.job?.stop() ?? terminateWindowsProcessTree(process, {});
  }
  stopAttached(): Promise<TerminationResult> | undefined { return this.job?.stop(); }
}
