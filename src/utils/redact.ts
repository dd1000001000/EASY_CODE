const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:Bearer\s+)[A-Za-z0-9._~+/-]{12,}={0,2}/gi,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi,
  /\bAKIA[0-9A-Z]{16}\b/g
];

const DANGEROUS_TERMINAL_SEQUENCE = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/g;

export function redactSensitive(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export function sanitizeTerminalOutput(value: string): string {
  return redactSensitive(value).replace(DANGEROUS_TERMINAL_SEQUENCE, "");
}

export function looksSensitive(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}
