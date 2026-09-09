import { setTimeout as delay } from "node:timers/promises";
import type { ModelProvider, ModelRequest, ProviderResponse, ProviderUsage } from "../core/types.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { ProviderError } from "../providers/errors.js";
import { failureCategory, retryableApiFailure } from "./failure-policy.js";
import { requestTokens } from "../context/token-budget.js";

/** Only transport/API failures retry here. Content repair and commands are separate. */
export function isContextCapacityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.startsWith("context_capacity_insufficient:")) return true;
  if (!(error instanceof ProviderError) || (error.statusCode !== undefined && ![400, 413, 422].includes(error.statusCode))) return false;
  return /context_length_exceeded|context_window_exceeded|maximum context length|context (?:window|length).*(?:exceed|limit)|prompt (?:is )?too long|input (?:is )?too long/i.test(`${error.code} ${error.message}`);
}

export interface ApiAttempt {
  attempt: number;
  retry: boolean;
  outcome: "completed" | "failed";
  usage?: ProviderUsage;
  failure?: { category: ReturnType<typeof failureCategory>; execution: "not_started";
    recovery: "retry_api" | "reset_context" | "propagate"; apiRetries: number; capacityRetries: number };
}
const managed = new WeakSet<ModelProvider>();
export function markRetryManaged(provider: ModelProvider): void { managed.add(provider); }

export async function completeWithApiRetries(provider: ModelProvider, request: ModelRequest, options: {
  limits?: Readonly<RuntimeLimits>;
  reserve?: (request: ModelRequest) => (usage?: ProviderUsage) => void;
  onAttempt?: (attempt: number) => void | Promise<void>;
  onSettled?: (attempt: ApiAttempt) => void | Promise<void>;
  resetContext?: (request: ModelRequest) => Promise<ModelRequest>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {}): Promise<ProviderResponse> {
  // A caller such as Auto/legacy reviewer can receive the main Runtime wrapper.
  // Never layer another transport retry loop or duplicate its budget debit.
  if (managed.has(provider)) return provider.complete(request);
  const limits = options.limits ?? DEFAULT_RUNTIME_LIMITS;
  let apiRetries = 0, capacityRetries = 0;
  for (let ordinal = 1; ; ordinal++) {
    request.signal?.throwIfAborted();
    await options.onAttempt?.(ordinal);
    const settle = options.reserve?.(request);
    let response: ProviderResponse;
    let failure: unknown;
    let failed = false;
    try {
      response = await abortable(provider.complete({ ...request, maxRetries: 0 }), request.signal);
    } catch (error) { failed = true; failure = error; }
    // Persistence/usage callback failures must not be mistaken for API failures.
    if (!failed) {
      settle?.(response!.usage);
      await options.onSettled?.({ attempt: ordinal, retry: ordinal > 1, outcome: "completed", usage: response!.usage });
      return response!;
    }
    settle?.();
    const category = failureCategory(failure, request.signal);
    await options.onSettled?.({ attempt: ordinal, retry: ordinal > 1, outcome: "failed", failure: {
      category, execution: "not_started", apiRetries, capacityRetries,
      recovery: category === "capacity" && options.resetContext && capacityRetries < limits.contextMaxCapacityRetries
        ? "reset_context" : category === "api" && retryableApiFailure(failure) &&
          apiRetries < limits.maxProviderRetries && (failure.retryAfterMs ?? 0) <= limits.providerRetryWaitMs ? "retry_api" : "propagate",
    } });
    request.signal?.throwIfAborted();
    if (isContextCapacityError(failure)) {
      if (!options.resetContext || capacityRetries >= limits.contextMaxCapacityRetries) throw failure;
      capacityRetries++;
      const reduced = await options.resetContext(request);
      if (requestTokens(reduced.messages, reduced.tools) >= requestTokens(request.messages, request.tools)) throw failure;
      request = reduced;
      continue;
    }
    if (!retryableApiFailure(failure) || apiRetries >= limits.maxProviderRetries) throw failure;
    const wait = failure.retryAfterMs ?? Math.min(500 * 2 ** apiRetries, 5000);
    if (wait > limits.providerRetryWaitMs) throw failure;
    apiRetries++;
    await (options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal })))(wait, request.signal);
  }
}

async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error("Model request canceled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

export function incompleteModelOutput(response: ProviderResponse): string | undefined {
  if (response.finishReason === "length") return "Model output was truncated (finishReason=length); submit a complete response. No incomplete tool call was executed.";
  if (!response.message.tool_calls?.length && !response.message.content?.trim())
    return "Model returned no usable text or tool call. Thinking alone is not a completed task.";
  return undefined;
}
