import type { KillableSubprocess, TerminationResult } from "../lifecycle.js";
import { terminatePosixProcessTree } from "./posix.js";
import type { CommandWorkerPlatform, WorkerProcess } from "./worker-types.js";
import type { PreparedCommand } from "../../sandbox/types.js";
import type { RuntimeLimits } from "../../config/runtime-limits.js";

export function terminateMacProcessTree(process: KillableSubprocess, graceMs: number): Promise<TerminationResult> {
  return terminatePosixProcessTree(process, graceMs);
}

export class MacCommandWorker implements CommandWorkerPlatform {
  readonly detached = true;
  startupTimeoutMs(limits: Readonly<RuntimeLimits>): number { return limits.sandboxStartupPosixMs; }
  launchEnvironment(prepared: PreparedCommand) { return prepared.environment; }
  stdinMode(): "ignore" { return "ignore"; }
  needsAttachment(): boolean { return false; }
  async attach(): Promise<void> { /* POSIX worker starts in its own process group. */ }
  continueWorker(): void { /* No handshake. */ }
  hasSupervisor(): boolean { return false; }
  cooperativeStop(process: WorkerProcess): boolean {
    if (!process.pid) return false;
    try { globalThis.process.kill(process.pid, "SIGTERM"); return true; } catch { return false; }
  }
  async quiesce(): Promise<void> { throw new Error("No macOS job supervisor"); }
  async cleanupRequested(): Promise<void> { throw new Error("Unexpected cleanup request on macOS"); }
  forceStop(process: WorkerProcess) { return terminateMacProcessTree(process, 1_500); }
  stopAttached(): undefined { return undefined; }
}
