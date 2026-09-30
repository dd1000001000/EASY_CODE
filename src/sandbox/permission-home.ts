import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { SandboxFailure } from "./failure.js";
import { nativeProjectPermissionConfig } from "./native-policy.js";

const SANDBOX_SECRETS_DIR = ".sandbox-secrets";
const SANDBOX_USERS_FILE = "sandbox_users.json";
const SANDBOX_STATE_DIR = ".sandbox";
const SETUP_MARKER_FILE = "setup_marker.json";

/** Create one immutable Codex home for the exact logical-project root set. */
export async function ensureNativeProjectPermissionHome(
  baseHome: string,
  writableRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const profile = nativeProjectPermissionConfig(writableRoots);
  const identity = createHash("sha256").update(profile).digest("hex").slice(0, 20);
  const home = path.join(baseHome, `project-home-v3-${identity}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const configPath = path.join(home, "config.toml");
  try {
    await writeFile(configPath, profile, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || (await readFile(configPath, "utf8")) !== profile) {
      throw new SandboxFailure(
        "state_persistence",
        "Project sandbox permission profile could not be safely initialized",
      );
    }
  }
  if (platform === "win32") await shareWindowsSandboxSetup(baseHome, home).catch(() => undefined);
  return home;
}

/** The Windows sandbox accounts are machine-wide, but Codex keeps their
 * DPAPI-protected passwords and setup marker under each CODEX_HOME and rotates
 * the passwords on every elevated setup. Per-project homes therefore each
 * demanded their own UAC prompt and invalidated every other home. Point all
 * project homes at the base home's credentials so the install-time setup
 * serves every project. Best effort: on failure the home keeps its own state. */
export async function shareWindowsSandboxSetup(baseHome: string, home: string): Promise<void> {
  const shared = path.join(baseHome, SANDBOX_SECRETS_DIR);
  const local = path.join(home, SANDBOX_SECRETS_DIR);
  await mkdir(shared, { recursive: true, mode: 0o700 });
  await linkSharedSecrets(shared, local);
  await syncNewestFile(
    path.join(baseHome, SANDBOX_STATE_DIR, SETUP_MARKER_FILE),
    path.join(home, SANDBOX_STATE_DIR, SETUP_MARKER_FILE),
  );
}

async function linkSharedSecrets(shared: string, local: string): Promise<void> {
  const existing = await lstat(local).catch(ignoreMissing);
  if (existing?.isSymbolicLink()) {
    if (samePath(await realpath(local), await realpath(shared))) return;
    await unlink(local);
  } else if (existing) {
    // Credentials from before sharing: the most recent setup set the live password.
    await syncNewestFile(path.join(local, SANDBOX_USERS_FILE), path.join(shared, SANDBOX_USERS_FILE));
    const retired = `${local}.retired-${randomBytes(6).toString("hex")}`;
    await rename(local, retired);
    await rm(retired, { recursive: true, force: true }).catch(() => undefined);
  }
  try {
    await symlink(shared, local, "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** Copy whichever file was written last over the other, keeping its mtime so
 * the copy never looks newer than a later elevated setup in another home. */
async function syncNewestFile(first: string, second: string): Promise<void> {
  const [a, b] = await Promise.all([stat(first).catch(ignoreMissing), stat(second).catch(ignoreMissing)]);
  if (!a && !b) return;
  const [source, target, sourceStat] = !b || (a && a.mtimeMs > b.mtimeMs) ? [first, second, a!] : [second, first, b];
  if (a && b && (await readFile(first)).equals(await readFile(second))) return;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await copyFile(source, temporary);
    await utimes(temporary, sourceStat.atime, sourceStat.mtime);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function samePath(first: string, second: string): boolean {
  return path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase();
}

function ignoreMissing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}
