import { randomBytes } from "node:crypto";
import { copyFile, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The Windows sandbox accounts (CodexSandboxOffline/Online) are machine-wide,
 * but every CODEX_HOME keeps its own copy of their passwords, and every
 * elevated setup sets new random passwords and rewrites the shared firewall
 * rules. EASY CODE and another Codex install (the Codex desktop app or CLI,
 * which use ~/.codex) therefore invalidated each other on every setup, and
 * Codex answers a failed sandbox logon by silently starting a new elevated
 * setup, which is a UAC prompt in the middle of a command.
 *
 * Reconciling keeps the newest credentials on both sides:
 * - when EASY CODE's setup is the newest, its credentials are copied into the
 *   other home, so the other Codex keeps working without a setup of its own;
 * - when another home's setup is newer, EASY CODE's passwords and its proxy
 *   firewall exceptions are gone, so it reports that setup is required
 *   instead of letting a command start one.
 *
 * Both sides store DPAPI machine-scope blobs in the same JSON format, so a
 * copy is valid as long as the format versions match.
 */

const USERS_FILE = path.join(".sandbox-secrets", "sandbox_users.json");

interface UsersRecord {
  readonly version: number;
  readonly offline: string;
  readonly online: string;
}

export type SharedAccountState =
  { readonly kind: "current" } | { readonly kind: "reset_elsewhere"; readonly home: string; readonly at: Date };

/**
 * Codex homes other installs use: `CODEX_HOME` when set, and the default
 * ~/.codex. `EASY_CODE_SHARE_SANDBOX_ACCOUNTS=off` keeps EASY CODE out of them.
 */
export function otherCodexHomes(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.EASY_CODE_SHARE_SANDBOX_ACCOUNTS?.trim().toLowerCase() === "off") return [];
  const candidates = [env.CODEX_HOME?.trim(), path.join(os.homedir(), ".codex")].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

async function readUsers(home: string): Promise<{ file: string; content: Buffer; mtime: Date } | undefined> {
  const file = path.join(home, USERS_FILE);
  try {
    const [content, info] = await Promise.all([readFile(file), stat(file)]);
    return { file, content, mtime: info.mtime };
  } catch {
    return undefined;
  }
}

function parseUsers(content: Buffer): UsersRecord | undefined {
  try {
    const value = JSON.parse(content.toString("utf8")) as {
      version?: unknown;
      offline?: { username?: unknown };
      online?: { username?: unknown };
    };
    if (
      typeof value.version !== "number" ||
      typeof value.offline?.username !== "string" ||
      typeof value.online?.username !== "string"
    )
      return undefined;
    return {
      version: value.version,
      offline: value.offline.username.toLowerCase(),
      online: value.online.username.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

function sameAccounts(first: UsersRecord, second: UsersRecord): boolean {
  return first.version === second.version && first.offline === second.offline && first.online === second.online;
}

function samePath(first: string, second: string): boolean {
  return path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase();
}

/** Replace `target` atomically, keeping the source's mtime so the copy never looks like a newer setup. */
async function copyKeepingTime(source: string, target: string, mtime: Date): Promise<void> {
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await copyFile(source, temporary);
    await utimes(temporary, mtime, mtime);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Compare EASY CODE's sandbox credentials (`home` may be a project home whose
 * secrets point at the shared base home) with other Codex homes. Pushes ours
 * where they are newer and reports a newer setup made elsewhere. Homes that
 * were never set up, or use another credential format, are left alone.
 */
export async function reconcileWindowsSandboxAccounts(
  home: string,
  others: readonly string[] = otherCodexHomes(),
): Promise<SharedAccountState> {
  const ours = await readUsers(home);
  const ourRecord = ours && parseUsers(ours.content);
  if (!ours || !ourRecord) return { kind: "current" };
  let newest: { home: string; at: Date } | undefined;
  for (const other of others) {
    if (samePath(other, home)) continue;
    const theirs = await readUsers(other);
    const theirRecord = theirs && parseUsers(theirs.content);
    if (!theirs || !theirRecord || !sameAccounts(ourRecord, theirRecord) || theirs.content.equals(ours.content))
      continue;
    if (theirs.mtime.getTime() > ours.mtime.getTime()) {
      if (!newest || theirs.mtime.getTime() > newest.at.getTime()) newest = { home: other, at: theirs.mtime };
    } else {
      await copyKeepingTime(ours.file, theirs.file, ours.mtime).catch(() => undefined);
    }
  }
  return newest ? { kind: "reset_elsewhere", ...newest } : { kind: "current" };
}

/** Why EASY CODE needs setup again after another install's setup. */
export function resetElsewhereMessage(state: Extract<SharedAccountState, { kind: "reset_elsewhere" }>): string {
  return (
    `Another Codex installation (${state.home}) re-ran Windows sandbox setup at ${state.at.toLocaleString()}, ` +
    "which replaced the shared sandbox account passwords and firewall rules. " +
    "EASY CODE must run sandbox setup again (administrator approval) before it can run commands."
  );
}
