import type { ProviderName } from "../core/types.js";

export interface ProviderErrorOptions {
  provider: ProviderName;
  code: string;
  statusCode?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  secrets?: readonly (string | undefined)[];
}

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly code: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    super(redactSensitiveText(message, options.secrets));
    this.name = "ProviderError";
    this.provider = options.provider;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Redact common credential shapes before an error crosses the provider boundary. */
export function redactSensitiveText(
  input: unknown,
  secrets: readonly (string | undefined)[] = [],
): string {
  let value = input instanceof Error ? input.message : String(input);

  for (const secret of secrets) {
    if (secret) value = value.split(secret).join("[REDACTED]");
  }

  value = value
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );

  return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
}
