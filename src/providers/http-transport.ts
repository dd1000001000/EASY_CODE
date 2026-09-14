import type { IncomingHttpHeaders, RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type TransportErrorKind =
  | "aborted"
  | "stream_header_timeout"
  | "stream_semantic_idle_timeout"
  | "buffered_total_timeout"
  | "network"
  | "response_too_large";

export class HttpTransportError extends Error {
  readonly kind: TransportErrorKind;

  constructor(kind: TransportErrorKind, message: string) {
    super(message);
    this.name = "HttpTransportError";
    this.kind = kind;
  }
}

/**
 * Preserve an adapter's useful low-level detail while always reporting the
 * effective configured deadline. Custom transports do not necessarily include
 * the duration in their error text.
 */
export function describeTransportTimeout(
  error: HttpTransportError,
  deadlines: { streamIdleTimeoutMs: number; bufferedTimeoutMs: number },
): string {
  const durationMs = error.kind === "buffered_total_timeout"
    ? deadlines.bufferedTimeoutMs
    : deadlines.streamIdleTimeoutMs;
  if (error.message.includes(`${durationMs}ms`)) return error.message;
  const label = error.kind === "stream_header_timeout"
    ? "response-header timeout"
    : error.kind === "stream_semantic_idle_timeout"
      ? "semantic stream idle timeout"
      : "buffered total timeout";
  return `${error.message} (effective ${label}: ${durationMs}ms)`;
}

export interface JsonPostRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** Stream deadlines renew only after the protocol parser confirms semantic progress. */
  timeoutMode: "stream_semantic_idle" | "buffered_total";
  /** Fixed total deadline used when a requested stream returns a buffered response. */
  bufferedTimeoutMs?: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  /** Selects the actual response framing after validated headers arrive. */
  onResponseStart?: (response: Pick<JsonPostResponse, "statusCode" | "headers">) => "stream" | "buffered";
  /** Returns true only when parsing this chunk produced new semantic model progress. */
  onResponseChunk?: (chunk: Buffer) => boolean;
}

export interface JsonPostResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export type JsonPostTransport = (
  request: JsonPostRequest,
) => Promise<JsonPostResponse>;

/**
 * Small Node 20-compatible JSON transport. It intentionally supports only HTTP(S),
 * performs no redirects, and keeps framing-specific timeout policy separate
 * from protocol parsing. Raw bytes never renew a semantic stream deadline.
 */
export const postJsonWithNode: JsonPostTransport = (
  input,
): Promise<JsonPostResponse> =>
  new Promise((resolve, reject) => {
    if (input.url.protocol !== "http:" && input.url.protocol !== "https:") {
      reject(
        new HttpTransportError(
          "network",
          `Unsupported URL protocol: ${input.url.protocol}`,
        ),
      );
      return;
    }
    if (input.signal?.aborted) {
      reject(new HttpTransportError("aborted", "Request was canceled"));
      return;
    }

    const options: RequestOptions = {
      protocol: input.url.protocol,
      hostname: input.url.hostname,
      port: input.url.port || undefined,
      path: `${input.url.pathname}${input.url.search}`,
      method: "POST",
      headers: {
        ...input.headers,
        "content-length": String(Buffer.byteLength(input.body)),
      },
    };
    const requestImpl =
      input.url.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    let responseBytes = 0;
    const startedAt = Date.now();
    let responseFraming: "awaiting_headers" | "stream" | "buffered" = "awaiting_headers";

    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const timeoutError = (kind: Extract<TransportErrorKind,
      "stream_header_timeout" | "stream_semantic_idle_timeout" | "buffered_total_timeout">,
      durationMs: number): HttpTransportError => new HttpTransportError(
        kind,
        kind === "stream_header_timeout"
          ? `Provider response headers did not arrive within ${durationMs}ms`
          : kind === "stream_semantic_idle_timeout"
            ? `Provider stream made no semantic progress for ${durationMs}ms`
            : `Buffered provider request exceeded ${durationMs}ms`,
      );
    const armTimer = (durationMs: number, kind: Extract<TransportErrorKind,
      "stream_header_timeout" | "stream_semantic_idle_timeout" | "buffered_total_timeout">): void => {
      clearTimer();
      timer = setTimeout(() => {
        request.destroy(timeoutError(kind, durationMs));
      }, durationMs);
    };
    const armBufferedDeadline = (): void => {
      const totalMs = input.timeoutMode === "buffered_total"
        ? input.timeoutMs
        : input.bufferedTimeoutMs;
      if (!Number.isSafeInteger(totalMs) || (totalMs ?? 0) <= 0) {
        request.destroy(new HttpTransportError(
          "network",
          "A streamed request that falls back to buffering requires a positive buffered timeout",
        ));
        return;
      }
      const remainingMs = totalMs! - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        request.destroy(timeoutError("buffered_total_timeout", totalMs!));
        return;
      }
      armTimer(remainingMs, "buffered_total_timeout");
    };

    const finish = (
      callback: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      input.signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const request = requestImpl(options, (response) => {
      if (settled) { response.destroy(); return; }
      const chunks: Buffer[] = [];
      try {
        const selected = input.onResponseStart?.({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
        }) ?? "buffered";
        responseFraming = input.timeoutMode === "stream_semantic_idle" && selected === "stream"
          ? "stream"
          : "buffered";
        if (responseFraming === "stream") {
          armTimer(input.timeoutMs, "stream_semantic_idle_timeout");
        } else if (input.timeoutMode === "stream_semantic_idle") {
          armBufferedDeadline();
        }
      } catch (error) {
        const callbackError = error instanceof Error
          ? error
          : new HttpTransportError("network", String(error));
        finish(() => reject(callbackError));
        response.destroy();
        return;
      }
      response.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.length;
        if (responseBytes > input.maxResponseBytes) {
          const error = new HttpTransportError(
            "response_too_large",
            `Provider response exceeded ${input.maxResponseBytes} bytes`,
          );
          finish(() => reject(error));
          response.destroy();
          return;
        }
        try {
          const semanticProgress = input.onResponseChunk?.(buffer) === true;
          if (responseFraming === "stream" && semanticProgress) {
            armTimer(input.timeoutMs, "stream_semantic_idle_timeout");
          }
        } catch (error) {
          const callbackError = error instanceof Error
            ? error
            : new HttpTransportError("network", String(error));
          finish(() => reject(callbackError));
          response.destroy();
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        finish(
          () =>
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
        );
      });
      response.on("error", (error) => {
        const transportError =
          error instanceof HttpTransportError
            ? error
            : new HttpTransportError("network", error.message);
        finish(() => reject(transportError));
      });
      response.on("aborted", () => {
        finish(
          () =>
            reject(
              new HttpTransportError(
                "network",
                "Provider closed the response before completion",
              ),
            ),
        );
      });
    });

    if (input.timeoutMode === "stream_semantic_idle") {
      armTimer(input.timeoutMs, "stream_header_timeout");
    } else {
      armBufferedDeadline();
    }

    const onAbort = (): void => {
      request.destroy(new HttpTransportError("aborted", "Request was canceled"));
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    // Close the small race between the initial check and listener registration.
    if (input.signal?.aborted) onAbort();

    request.on("error", (error) => {
      const transportError =
        error instanceof HttpTransportError
          ? error
          : new HttpTransportError("network", error.message);
      finish(() => reject(transportError));
    });
    request.write(input.body);
    request.end();
  });
