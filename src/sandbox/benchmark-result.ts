import { z } from "zod";
import type { SandboxWorkerControl } from "./types.js";

export const benchmarkOutcomeSchema = z.enum(["exited", "timed_out", "canceled", "output_limit", "spawn_failed", "unknown"]);
export const benchmarkResultSchema = z.object({ version: z.literal(2), exitCode: z.number().int(),
  outcome: benchmarkOutcomeSchema, cleanup: z.enum(["confirmed", "failed", "unknown"]), workerRestored: z.boolean(),
  executionError: z.string().optional(), cleanupError: z.string().optional(), reviewEnvironmentUnchanged: z.boolean().optional(),
}).strict();
/** Output bounds describe execution, never descendant cleanup. Missing evidence fails closed. */
export function benchmarkResultControls(raw: unknown): SandboxWorkerControl[] {
  const value = benchmarkResultSchema.parse(raw);
  return [{ type: "execution_exited", exitCode: value.exitCode, outcome: value.outcome },
    value.cleanup === "confirmed" && value.workerRestored
      ? { type: "cleanup_complete" }
      : { type: "cleanup_error", message: value.cleanupError ?? "Benchmark cleanup or worker restoration is unconfirmed" }];
}
