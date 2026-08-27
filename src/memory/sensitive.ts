const SENSITIVE_TESTS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|authorization)\s*[:=]\s*["']?[^\s"']{6,}/i,
  /:\/\/[^\s/:@]+:[^\s/@]+@/,
];

export function containsSensitiveInformation(value: string): boolean {
  return SENSITIVE_TESTS.some((pattern) => pattern.test(value));
}

export function redactSensitiveInformation(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED API KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi, "[REDACTED TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED ACCESS KEY]")
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|authorization)(\s*[:=]\s*)["']?[^\s"']{6,}/gi,
      "$1$2[REDACTED]",
    )
    .replace(/:\/\/([^\s/:@]+):([^\s/@]+)@/g, "://$1:[REDACTED]@");
}

