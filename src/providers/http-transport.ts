import type { IncomingHttpHeaders, RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type TransportErrorKind =
  | "aborted"
  | "timeout"
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
  maxResponseBytes: number;
  signal?: AbortSignal;
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
 * Small Node 16-compatible JSON transport. It intentionally supports only HTTP(S),
 * performs no redirects, and enforces a total wall-clock timeout and body cap.
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

    const finish = (
      callback: () => void,
      timer: ReturnType<typeof setTimeout>,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const request = requestImpl(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.length;
        if (responseBytes > input.maxResponseBytes) {
          const error = new HttpTransportError(
            "response_too_large",
            `Provider response exceeded ${input.maxResponseBytes} bytes`,
          );
          finish(() => reject(error), timer);
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
          timer,
        );
      });
      response.on("error", (error) => {
        const transportError =
          error instanceof HttpTransportError
            ? error
            : new HttpTransportError("network", error.message);
        finish(() => reject(transportError), timer);
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
          timer,
        );
      });
    });

    const timer = setTimeout(() => {
      request.destroy(
        new HttpTransportError(
          "timeout",
          `Provider request timed out after ${input.timeoutMs}ms`,
        ),
      );
    }, input.timeoutMs);

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
      finish(() => reject(transportError), timer);
    });
    request.write(input.body);
    request.end();
  });
