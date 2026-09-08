import path from "node:path";
import { reusableExecutableGrant } from "./security.js";
import { isCommandGrant, decodeCommandGrant, commandGrantMatches } from "./command-grant.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";

/** Keep Thread checkpoints and approval prompts bounded even in long sessions. */
export const MAX_COMMAND_APPROVAL_PREFIXES = 128;
export const MAX_COMMAND_APPROVAL_PREFIX_CHARS = 16_384;

const UNSAFE_PREFIX_CHARACTERS =
  /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

const NETWORK_PREFIX = "network:v1:";
interface NetworkPrefix { executable: string; args: string[]; digest: string }

function decodeNetworkPrefix(value: string, platform: NodeJS.Platform): NetworkPrefix {
  const parsed = JSON.parse(Buffer.from(value.slice(NETWORK_PREFIX.length), "base64url").toString("utf8")) as NetworkPrefix;
  if (!parsed || Object.keys(parsed).sort().join(",") !== "args,digest,executable" ||
      typeof parsed.executable !== "string" || parsed.executable.startsWith(NETWORK_PREFIX) ||
      typeof parsed.digest !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.digest) || !Array.isArray(parsed.args) || parsed.args.length > 16 ||
      parsed.args.some(a => typeof a !== "string" || a.length > 256 || UNSAFE_PREFIX_CHARACTERS.test(a))) {
    throw new Error("Invalid network approval prefix");
  }
  return { executable: parsed.executable === "tool:fetch_artifact" ? parsed.executable : normalizeCommandApprovalPrefix(parsed.executable, platform),
    args: parsed.args, digest: parsed.digest };
}

export function networkCommandApprovalPrefix(executable: string, args: string[], digest: string,
  platform: NodeJS.Platform = process.platform): string {
  return normalizeCommandApprovalPrefix(NETWORK_PREFIX + Buffer.from(JSON.stringify({ executable, args, digest })).toString("base64url"), platform);
}

export function canGrantCommandPrefix(prefix: string): boolean {
  if (isCommandGrant(prefix)) { try { normalizeCommandApprovalPrefix(prefix); return true; } catch { return false; } }
  // Legacy UI labels may be noncanonical; the application validates before
  // persisting any actual grant. Encoded network capabilities must parse here.
  if (!prefix.startsWith(NETWORK_PREFIX)) return reusableExecutableGrant(prefix);
  try { normalizeCommandApprovalPrefix(prefix); return prefix.startsWith(NETWORK_PREFIX) || reusableExecutableGrant(prefix); }
  catch { return false; }
}

export function formatCommandApprovalPrefix(prefix: string): string {
  if (isCommandGrant(prefix)) { const v = decodeCommandGrant(prefix); return redactSensitiveInformation(`${JSON.stringify([v.executable, ...(v.exact ? [] : v.args)])} (${v.exact ? `exact argv SHA256=${v.args[0]}` : "argv prefix"}; ${v.scope}; cwd=${JSON.stringify(v.cwd)}; network=${v.network}; script contents may change)`); }
  if (!prefix.startsWith(NETWORK_PREFIX)) return JSON.stringify([prefix]);
  const decoded = decodeNetworkPrefix(prefix, process.platform);
  return `${JSON.stringify([decoded.executable, ...decoded.args])} (network prefix: includes downloads, uploads and remote changes; same executable bytes)`;
}

export function commandPrefixApprovalLabel(prefix: string): string {
  if (isCommandGrant(prefix)) return `Yes, allow this permission prefix for this Thread and its children: ${formatCommandApprovalPrefix(prefix)}`;
  return prefix.startsWith(NETWORK_PREFIX)
    ? `Yes, authorize this network prefix for the Thread: ${formatCommandApprovalPrefix(prefix)}`
    : `Yes, authorize this exact executable for the Thread: ${formatCommandApprovalPrefix(prefix)}`;
}

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
  if (isCommandGrant(value)) { decodeCommandGrant(value); return value; }
  if (value.startsWith(NETWORK_PREFIX)) {
    const normalized = NETWORK_PREFIX + Buffer.from(JSON.stringify(decodeNetworkPrefix(value, platform))).toString("base64url");
    if (normalized.length > MAX_COMMAND_APPROVAL_PREFIX_CHARS) throw new Error("Network approval prefix is too long");
    return normalized;
  }
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
  if (isCommandGrant(candidate)) return approved.filter(isCommandGrant).some(p => commandGrantMatches(p, candidate));
  if (candidate.startsWith(NETWORK_PREFIX)) {
    const requested = decodeNetworkPrefix(candidate, platform);
    return approved.filter(p => p.startsWith(NETWORK_PREFIX)).some(p => {
      const grant = decodeNetworkPrefix(p, platform);
      return grant.executable === requested.executable && grant.digest === requested.digest &&
        grant.args.length <= requested.args.length && grant.args.every((arg, i) => arg === requested.args[i]);
    });
  }
  return reusableExecutableGrant(candidate) && approved.some((prefix) => prefix === candidate);
}

/** Append one normalized identity without mutating or duplicating the input. */
export function grantCommandApprovalPrefix(
  prefixes: readonly string[],
  commandPrefix: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const approved = validateCommandApprovalPrefixes(prefixes, platform);
  const candidate = normalizeCommandApprovalPrefix(commandPrefix, platform);
  if (!isCommandGrant(candidate) && !candidate.startsWith(NETWORK_PREFIX) && !reusableExecutableGrant(candidate)) throw new Error("Shells, interpreters and package managers require per-invocation approval");
  if (approved.some((prefix) => prefix === candidate)) return approved;
  if (approved.length >= MAX_COMMAND_APPROVAL_PREFIXES) {
    throw new Error(`Command approval prefix limit is ${MAX_COMMAND_APPROVAL_PREFIXES}`);
  }
  return [...approved, candidate];
}
