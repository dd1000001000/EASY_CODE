import type { ProviderName } from "../core/types.js";
import { ProviderError, redactSensitiveText, type ProviderProgress } from "./errors.js";
import { describeTransportTimeout, HttpTransportError } from "./http-transport.js";
import { SseDecodingError } from "./sse.js";

/** The deadlines an attempt ran under, used to explain a transport timeout. */
export interface AttemptDeadlines {
  streamIdleTimeoutMs: number;
  bufferedTimeoutMs: number;
}

/** One provider request attempt. Each retry starts a fresh attempt with its own stream state and identity. */
export interface ProviderAttempt<T> {
  run(): Promise<T>;
  /** How far a failed attempt got, reported on retryable timeouts. */
  progress(): ProviderProgress;
  /** Called after a failure has been normalized, before any retry. */
  onFailure(): void;
}

export interface RetryLoopOptions {
  provider: ProviderName;
  apiKey: string | undefined;
  maxRetries: number;
  signal: AbortSignal | undefined;
  deadlines: AttemptDeadlines;
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
}

/**
 * Run provider attempts until one succeeds, a failure is not retryable, or the retry budget is spent.
 * Owns cancellation, backoff (honoring a provider's Retry-After) and error normalization.
 */
export async function runWithRetries<T>(options: RetryLoopOptions, startAttempt: () => ProviderAttempt<T>): Promise<T> {
  const { maxRetries, signal } = options;
  let lastError: ProviderError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw providerError(options, "Request was canceled", "aborted");
    const current = startAttempt();
    try {
      return await current.run();
    } catch (error) {
      const normalized = normalizeProviderError(options, error, signal, current.progress(), options.deadlines);
      lastError = normalized;
      current.onFailure();
      if (!normalized.retryable || attempt >= maxRetries) throw normalized;
      try {
        await options.sleep(normalized.retryAfterMs ?? retryDelayMs(attempt, options.random()), signal);
      } catch (sleepError) {
        throw normalizeProviderError(options, sleepError, signal);
      }
    }
  }
  throw lastError ?? providerError(options, "Provider request failed", "request_failed");
}

function providerError(
  options: Pick<RetryLoopOptions, "provider" | "apiKey">,
  message: string,
  code: string,
): ProviderError {
  return new ProviderError(message, { provider: options.provider, code, secrets: [options.apiKey] });
}

/** Map a transport, stream-decoding or unknown failure onto a ProviderError with its retry classification. */
export function normalizeProviderError(
  options: Pick<RetryLoopOptions, "provider" | "apiKey">,
  error: unknown,
  signal: AbortSignal | undefined,
  progress?: ProviderProgress,
  deadlines?: AttemptDeadlines,
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof SseDecodingError) return providerError(options, error.message, "invalid_response");
  if (signal?.aborted) return providerError(options, "Request was canceled", "aborted");
  if (error instanceof HttpTransportError) {
    if (error.kind === "aborted") return providerError(options, "Request was canceled", "aborted");
    if (
      error.kind === "stream_header_timeout" ||
      error.kind === "stream_semantic_idle_timeout" ||
      error.kind === "buffered_total_timeout"
    ) {
      return new ProviderError(deadlines ? describeTransportTimeout(error, deadlines) : error.message, {
        provider: options.provider,
        code: error.kind,
        retryable: true,
        progress,
      });
    }
    if (error.kind === "response_too_large") return providerError(options, error.message, "response_too_large");
    return new ProviderError(`Provider network error: ${error.message}`, {
      provider: options.provider,
      code: "network_error",
      retryable: true,
      secrets: [options.apiKey],
    });
  }
  return new ProviderError(`Provider request failed: ${redactSensitiveText(error, [options.apiKey])}`, {
    provider: options.provider,
    code: "request_failed",
    retryable: true,
    secrets: [options.apiKey],
  });
}

/** HTTP statuses worth retrying: timeouts, conflicts, rate limits and server errors. */
export function retryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

/** Retry-After as a delay in milliseconds, capped at 30 seconds. */
export function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 30_000);
  }
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.min(date - Date.now(), 30_000));
  }
  return undefined;
}

/** Exponential backoff from 500ms, capped at 5s, with ±20% jitter. */
export function retryDelayMs(attempt: number, random: number): number {
  return Math.round(Math.min(500 * 2 ** attempt, 5_000) * (0.8 + random * 0.4));
}

export function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HttpTransportError("aborted", "Request was canceled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new HttpTransportError("aborted", "Request was canceled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
