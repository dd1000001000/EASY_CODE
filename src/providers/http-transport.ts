import type { IncomingHttpHeaders, RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type TransportErrorKind =
  | "aborted"
  | "stream_idle_timeout"
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

export interface JsonPostRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** Idle deadlines are renewed by response activity; total deadlines never move. */
  timeoutMode: "stream_idle" | "buffered_total";
  maxResponseBytes: number;
  signal?: AbortSignal;
  /** Called after response headers arrive and before any body bytes. */
  onResponseStart?: (response: Pick<JsonPostResponse, "statusCode" | "headers">) => void;
  /** Raw response bytes in arrival order. Intended for bounded SSE parsing. */
  onResponseChunk?: (chunk: Buffer) => void;
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
 * performs no redirects, and enforces either a renewable stream-idle timeout
 * or a fixed buffered-response deadline plus a body cap.
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const armTimer = (): void => {
      clearTimer();
      timer = setTimeout(() => {
        const idle = input.timeoutMode === "stream_idle";
        request.destroy(
          new HttpTransportError(
            idle ? "stream_idle_timeout" : "buffered_total_timeout",
            idle
              ? `Provider stream was idle for ${input.timeoutMs}ms`
              : `Buffered provider request exceeded ${input.timeoutMs}ms`,
          ),
        );
      }, input.timeoutMs);
    };
    const noteActivity = (): void => {
      if (input.timeoutMode === "stream_idle") armTimer();
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
        input.onResponseStart?.({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
        });
        noteActivity();
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
        noteActivity();
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
          input.onResponseChunk?.(buffer);
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

    armTimer();

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
