import type { PreparedCommand } from "../../sandbox/types.js";
import type { RuntimeLimits } from "../../config/runtime-limits.js";
import type { KillableSubprocess, TerminationResult } from "../lifecycle.js";

export type WorkerProcess = KillableSubprocess & {
  stdin?: { write(chunk: string): unknown; end(chunk?: string): unknown } | null;
};

/** Only platform-owned process operations live here; the command state machine stays shared. */
export interface CommandWorkerPlatform {
  readonly detached: boolean;
  startupTimeoutMs(limits: Readonly<RuntimeLimits>): number;
  launchEnvironment(prepared: PreparedCommand): NodeJS.ProcessEnv;
  stdinMode(prepared: PreparedCommand): "pipe" | "ignore";
  needsAttachment(prepared: PreparedCommand): boolean;
  attach(process: WorkerProcess): Promise<void>;
  continueWorker(process: WorkerProcess): void;
  hasSupervisor(): boolean;
  cooperativeStop(process: WorkerProcess): boolean;
  quiesce(): Promise<void>;
  cleanupRequested(process: WorkerProcess): Promise<void>;
  forceStop(process: WorkerProcess): Promise<TerminationResult>;
  stopAttached(): Promise<TerminationResult> | undefined;
}
