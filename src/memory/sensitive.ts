const SENSITIVE_TESTS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret|authorization)\s*[:=]\s*["']?[^\s"']{6,}/i,
  /:\/\/[^\s/:@]+:[^\s/@]+@/,
];

export function containsSensitiveInformation(value: string): boolean {
  return SENSITIVE_TESTS.some((pattern) => pattern.test(value));
}

/** A placeholder left by an earlier rule; the assignment rule reads it as one unit, so it is never split. */
const PLACEHOLDER_SOURCE = String.raw`Bearer \[REDACTED\]|\[REDACTED(?: [A-Z]+)*\]`;
const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE, "gi");
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret|authorization)(\s*[:=]\s*)(["']?)((?:${PLACEHOLDER_SOURCE}|[^\s"'])+)`,
  "gi",
);

/** `name = value` with the value redacted; a value holding exactly one placeholder collapses to it, keeping the opening quote. */
function redactAssignment(match: string, name: string, separator: string, quote: string, value: string): string {
  const placeholders = value.match(PLACEHOLDER) ?? [];
  if (placeholders.length === 0 && value.length < 6) return match;
  return `${name}${separator}${quote}${placeholders.length === 1 ? placeholders[0] : "[REDACTED]"}`;
}

export function redactSensitiveInformation(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED API KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi, "[REDACTED TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED ACCESS KEY]")
    .replace(SECRET_ASSIGNMENT, redactAssignment)
    .replace(/:\/\/([^\s/:@]+):([^\s/@]+)@/g, "://$1:[REDACTED]@");
}
