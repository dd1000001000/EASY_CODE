import { ProviderError } from "../providers/errors.js";
import { TaskBudgetExceeded } from "./task-budget.js";

/** Classification never grants another retry. The owning protocol controls its allowance. */
export function failureCategory(error: unknown, signal?: AbortSignal):
  "api" | "capacity" | "canceled" | "budget" | "runtime" {
  if (signal?.aborted || error instanceof Error && error.name === "AbortError") return "canceled";
  if (error instanceof TaskBudgetExceeded) return "budget";
  if (error instanceof Error && error.message.startsWith("context_capacity_insufficient:")) return "capacity";
  if (error instanceof ProviderError) {
    if ([400, 413, 422].includes(error.statusCode ?? 400) &&
        /context_length_exceeded|context_window_exceeded|maximum context length|context (?:window|length).*(?:exceed|limit)|prompt (?:is )?too long|input (?:is )?too long/i.test(`${error.code} ${error.message}`)) return "capacity";
    return "api";
  }
  return "runtime";
}

/** Only exhausted transient transport errors permit a best-effort auxiliary summary.
 * Authentication, cancellation, budgets and persistence failures remain visible. */
export function canSalvageAuxiliaryFailure(error: unknown, signal?: AbortSignal): boolean {
  return failureCategory(error, signal) === "api" && retryableApiFailure(error);
}

export function retryableApiFailure(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.retryable && ![400, 401, 403, 404, 413, 422].includes(error.statusCode ?? 0);
}
