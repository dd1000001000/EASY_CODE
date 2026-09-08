import path from "node:path";
import type { ProgressReviewReportSnapshot } from "./types.js";

/** Binding is descriptive, never an execution capability. Normal command
 * authorization, sandboxing, and testing-standard checks still apply. */
export function matchesReviewExperiment(report: ProgressReviewReportSnapshot, input: unknown, root: string): boolean {
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { return false; } }
  if (!report.experimentProgram || report.experimentArgsJson === undefined || report.experimentCwd === undefined ||
      !input || typeof input !== "object") return false;
  const command = input as { program?: unknown; args?: unknown; cwd?: unknown };
  try {
    return command.program === report.experimentProgram &&
      JSON.stringify(command.args ?? []) === JSON.stringify(JSON.parse(report.experimentArgsJson)) &&
      (command.cwd === undefined || typeof command.cwd === "string") &&
      path.resolve(root, command.cwd as string ?? ".") === path.resolve(root, report.experimentCwd || ".");
  } catch { return false; }
}
