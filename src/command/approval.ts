import path from "node:path";

/** Keep Thread checkpoints and approval prompts bounded even in long sessions. */
export const MAX_COMMAND_APPROVAL_PREFIXES = 128;
export const MAX_COMMAND_APPROVAL_PREFIX_CHARS = 4_096;

const UNSAFE_PREFIX_CHARACTERS =
  /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

export type CommandApprovalPlatform = "win32" | "posix";

function approvalPlatform(platform: NodeJS.Platform): CommandApprovalPlatform {
  return platform === "win32" ? "win32" : "posix";
}

/**
 * Canonicalize one Runtime-resolved executable identity for equality checks.
 *
 * This is intentionally lexical: CommandResolver performs filesystem lookup
 * and realpath canonicalization before issuing the value. Re-resolving here
 * would introduce a TOCTOU race and make journal recovery depend on the file
 * still being present.
 */
export function normalizeCommandApprovalPrefix(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_COMMAND_APPROVAL_PREFIX_CHARS ||
    value.trim() !== value ||
    UNSAFE_PREFIX_CHARACTERS.test(value)
  ) {
    throw new Error("Invalid command approval prefix");
  }

  const selected = approvalPlatform(platform);
  const pathApi = selected === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(value)) {
    throw new Error("Command approval prefix must be an absolute executable path");
  }

  const normalized = pathApi.normalize(value);
  if (
    normalized.length === 0 ||
    normalized.length > MAX_COMMAND_APPROVAL_PREFIX_CHARS ||
    normalized === pathApi.parse(normalized).root
  ) {
    throw new Error("Invalid command approval prefix");
  }
  // Windows executable lookup and filesystem identity are case-insensitive in
  // the supported environment; POSIX executable identities remain case-sensitive.
  return selected === "win32" ? normalized.toLowerCase() : normalized;
}

/** Validate, normalize, and de-duplicate one persisted Thread grant list. */
export function validateCommandApprovalPrefixes(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!Array.isArray(value) || value.length > MAX_COMMAND_APPROVAL_PREFIXES) {
    throw new Error("Invalid command approval prefix list");
  }
  const prefixes: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") {
      throw new Error("Invalid command approval prefix list");
    }
    const normalized = normalizeCommandApprovalPrefix(candidate, platform);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    prefixes.push(normalized);
  }
  return prefixes;
}

/**
 * Return whether the exact normalized executable identity has been granted.
 * Arguments, siblings, and longer paths never match this check.
 */
export function isCommandApprovalPrefixGranted(
  prefixes: readonly string[],
  commandPrefix: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const approved = validateCommandApprovalPrefixes(prefixes, platform);
  const candidate = normalizeCommandApprovalPrefix(commandPrefix, platform);
  return approved.some((prefix) => prefix === candidate);
}

/** Append one normalized identity without mutating or duplicating the input. */
export function grantCommandApprovalPrefix(
  prefixes: readonly string[],
  commandPrefix: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const approved = validateCommandApprovalPrefixes(prefixes, platform);
  const candidate = normalizeCommandApprovalPrefix(commandPrefix, platform);
  if (approved.some((prefix) => prefix === candidate)) return approved;
  if (approved.length >= MAX_COMMAND_APPROVAL_PREFIXES) {
    throw new Error(`Command approval prefix limit is ${MAX_COMMAND_APPROVAL_PREFIXES}`);
  }
  return [...approved, candidate];
}
