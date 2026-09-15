import { z } from "zod";
import type { SandboxWorkerControl } from "./types.js";

export const benchmarkOutcomeSchema = z.enum(["exited", "timed_out", "canceled", "output_limit", "spawn_failed", "unknown"]);
export const benchmarkExecutionSchema = z.object({
  version: z.literal(2),
  exitCode: z.number().int(),
  outcome: benchmarkOutcomeSchema,
  executionError: z.string().optional(),
}).strict();
export const benchmarkResultSchema = z.object({ version: z.literal(2), exitCode: z.number().int(),
  outcome: benchmarkOutcomeSchema, cleanup: z.enum(["confirmed", "failed", "unknown"]), workerRestored: z.boolean(),
  executionError: z.string().optional(), cleanupError: z.string().optional(), reviewEnvironmentUnchanged: z.boolean().optional(),
}).strict();
/** Target completion and worker restoration are separate lifecycle facts. The
 * controller publishes execution before it restarts the worker, so a slow
 * cleanup cannot turn a completed command into a command timeout. */
export function benchmarkExecutionControl(raw: unknown): SandboxWorkerControl {
  const value = benchmarkExecutionSchema.parse(raw);
  return { type: "execution_exited", exitCode: value.exitCode, outcome: value.outcome };
}

export function benchmarkCleanupControl(raw: unknown): SandboxWorkerControl {
  const value = benchmarkResultSchema.parse(raw);
  return value.cleanup === "confirmed" && value.workerRestored
    ? { type: "cleanup_complete" }
    : { type: "cleanup_error", message: value.cleanupError ?? "Benchmark cleanup or worker restoration is unconfirmed" };
}

/** Convenience for tests and non-streaming consumers. */
export function benchmarkResultControls(raw: unknown): SandboxWorkerControl[] {
  const value = benchmarkResultSchema.parse(raw);
  return [benchmarkExecutionControl({ version: value.version, exitCode: value.exitCode,
    outcome: value.outcome, ...(value.executionError ? { executionError: value.executionError } : {}) }),
  benchmarkCleanupControl(value)];
}
