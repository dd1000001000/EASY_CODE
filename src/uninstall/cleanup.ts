import { lstat, open, readFile, readdir, rm, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadEasyCodeConfig } from "../config/loader.js";
import { resolveEasyCodePaths, type EasyCodePaths } from "../config/defaults.js";
import { getEasyCodeHome } from "../prompt-bundle/paths.js";
import {
  EASY_CODE_DATA_ROOT_MARKER,
  isEasyCodeDataRootMarker,
} from "../storage/data-root.js";

const MEMORY_DIRECTORY_NAMES = new Set([
  "artifacts",
  "attachments",
  "subagent-artifacts",
  "subagent-environments",
  "threads",
]);

const DATABASE_ENTRY_PATTERN =
  /^easy-code\.db(?:-journal|-shm|-wal|\.lock|\.easy-code-advisory-lock(?:\..+)?)?$/u;
const ACTIVE_DATABASE_LOCK_PATTERN =
  /^easy-code\.db\.easy-code-advisory-lock(?:$|\.(?:staging|release)-)/u;

export interface EasyCodeCleanupOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly defaultPaths?: EasyCodePaths;
  /** Test-only override for every data directory whose EASY CODE entries are removed. */
  readonly dataDirectories?: readonly string[];
}

export interface EasyCodeCleanupResult {
  readonly removed: readonly string[];
  readonly absent: readonly string[];
  readonly preserved: readonly string[];
  readonly warnings: readonly string[];
}

function pathIdentity(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function addUniquePath(target: Map<string, string>, value: string): void {
  const resolved = path.resolve(value);
  target.set(pathIdentity(resolved), resolved);
}

function exactChild(parent: string, child: string, expectedName: string): boolean {
  return (
    pathIdentity(path.dirname(child)) === pathIdentity(parent) &&
    path.basename(child) === expectedName
  );
}

async function removeExactEntry(
  target: string,
  parent: string,
  expectedName: string,
  result: { removed: string[]; absent: string[] },
): Promise<void> {
  if (!exactChild(parent, target, expectedName)) {
    throw new Error(`Refusing to remove an unexpected EASY CODE path: ${target}`);
  }
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      result.absent.push(target);
      return;
    }
    throw error;
  }
  // Never pass a symlink or Windows junction to a recursive remover. Unlinking
  // the directory entry guarantees an attacker-controlled target is untouched.
  if (metadata.isSymbolicLink()) {
    await unlink(target);
  } else {
    await rm(target, { recursive: metadata.isDirectory(), force: false });
  }
  result.removed.push(target);
}

async function configuredDataDirectories(
  options: EasyCodeCleanupOptions,
  defaultPaths: EasyCodePaths,
  warnings: string[],
): Promise<string[]> {
  if (options.dataDirectories) {
    return [...new Set(options.dataDirectories.map((value) => path.resolve(value)))];
  }

  const directories = new Map<string, string>();
  addUniquePath(directories, defaultPaths.dataDir);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const environmentDataDirectory = env.EASY_CODE_DATA_DIR?.trim();
  if (environmentDataDirectory) {
    addUniquePath(directories, path.resolve(cwd, environmentDataDirectory));
  }

  try {
    const config = await loadEasyCodeConfig({
      cwd,
      env,
      credentialStore: false,
      workspaceRoot: cwd,
      // User configuration is relevant, but a project-local configuration
      // must never influence a machine-level uninstall operation.
      workspaceConfigPath: path.join(
        os.tmpdir(),
        `easy-code-uninstall-no-workspace-${process.pid}.toml`,
      ),
    });
    addUniquePath(directories, config.dataDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(
      `Could not inspect the configured data directory; default and environment paths were still cleaned: ${message}`,
    );
  }
  return [...directories.values()];
}

async function cleanupDataDirectory(
  dataDirectory: string,
  defaultDataDirectory: string,
  result: {
    removed: string[];
    absent: string[];
    preserved: string[];
    warnings: string[];
  },
  ownershipPreflighted = false,
): Promise<void> {
  const root = path.resolve(dataDirectory);
  let entries;
  try {
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Refusing to clean a non-directory EASY CODE data root: ${root}`);
    }
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      result.absent.push(root);
      return;
    }
    throw error;
  }

  const ownershipValid = await dataRootIsOwned(root, defaultDataDirectory, entries);
  if (!ownershipValid && ownershipPreflighted) {
    throw new Error(`EASY CODE data-root ownership changed during uninstall: ${root}`);
  }
  if (!ownershipValid) {
    result.warnings.push(
      `Skipped custom data directory without a valid EASY CODE ownership marker: ${root}`,
    );
    result.preserved.push(root);
    return;
  }

  const activeLock = entries.find((entry) => ACTIVE_DATABASE_LOCK_PATTERN.test(entry.name));
  if (activeLock) {
    throw new Error(
      `EASY CODE memory is in use at ${root}; close every running EASY CODE process and retry uninstall`,
    );
  }

  for (const entry of entries) {
    if (entry.name === EASY_CODE_DATA_ROOT_MARKER) continue;
    const isMemoryDirectory = MEMORY_DIRECTORY_NAMES.has(entry.name);
    const isDatabaseEntry = DATABASE_ENTRY_PATTERN.test(entry.name);
    if (!isMemoryDirectory && !isDatabaseEntry) {
      result.preserved.push(path.join(root, entry.name));
      continue;
    }
    await removeExactEntry(path.join(root, entry.name), root, entry.name, result);
  }

  const remaining = await readdir(root);
  if (remaining.length === 1 && remaining[0] === EASY_CODE_DATA_ROOT_MARKER) {
    await removeExactEntry(
      path.join(root, EASY_CODE_DATA_ROOT_MARKER),
      root,
      EASY_CODE_DATA_ROOT_MARKER,
      result,
    );
  } else if (remaining.includes(EASY_CODE_DATA_ROOT_MARKER)) {
    result.preserved.push(path.join(root, EASY_CODE_DATA_ROOT_MARKER));
  }

  // Remove the dedicated data root only when no preserved entries remain.
  // Managed Worktrees and unknown/custom entries intentionally keep it alive.
  try {
    await rmdir(root);
    result.removed.push(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
  }
}

async function dataRootIsOwned(
  root: string,
  defaultDataDirectory: string,
  entries: readonly {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }[],
): Promise<boolean> {
  if (pathIdentity(root) === pathIdentity(defaultDataDirectory)) return true;
  const markerEntry = entries.find((entry) => entry.name === EASY_CODE_DATA_ROOT_MARKER);
  if (markerEntry?.isFile() && !markerEntry.isSymbolicLink()) {
    try {
      if (isEasyCodeDataRootMarker(
        JSON.parse(await readFile(path.join(root, EASY_CODE_DATA_ROOT_MARKER), "utf8")) as unknown,
      )) return true;
    } catch {
      // Continue to the legacy ownership proof below.
    }
  }

  // Before ownership markers existed, createStorage always created this exact
  // SQLite/threads/artifacts triple. Verify the SQLite magic and real directory
  // entries so an upgraded installation can still erase its older custom root
  // without treating an arbitrary configured folder as recursively owned.
  const database = entries.find((entry) => entry.name === "easy-code.db");
  const threads = entries.find((entry) => entry.name === "threads");
  const artifacts = entries.find((entry) => entry.name === "artifacts");
  if (
    !database?.isFile() || database.isSymbolicLink() ||
    !threads?.isDirectory() || threads.isSymbolicLink() ||
    !artifacts?.isDirectory() || artifacts.isSymbolicLink()
  ) return false;
  const descriptor = await open(path.join(root, "easy-code.db"), "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await descriptor.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.equals(Buffer.from("SQLite format 3\0", "binary"));
  } finally {
    await descriptor.close();
  }
}

async function preflightDataDirectory(
  dataDirectory: string,
  defaultDataDirectory: string,
  warnings: string[],
  preserved: string[],
): Promise<boolean> {
  const root = path.resolve(dataDirectory);
  let entries;
  try {
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Refusing to clean a non-directory EASY CODE data root: ${root}`);
    }
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (!await dataRootIsOwned(root, defaultDataDirectory, entries)) {
    warnings.push(
      `Skipped custom data directory without a valid EASY CODE ownership marker: ${root}`,
    );
    preserved.push(root);
    return false;
  }
  const activeLock = entries.find((entry) => ACTIVE_DATABASE_LOCK_PATTERN.test(entry.name));
  if (activeLock) {
    throw new Error(
      `EASY CODE memory is in use at ${root}; close every running EASY CODE process and retry uninstall`,
    );
  }
  return true;
}

/**
 * Delete the fixed Prompt Bundle plus every discoverable short/long-term
 * memory store for the current OS user.
 *
 * API keys, user configuration, workspace files, model caches, VS Code
 * extensions, managed Worktrees and handoff branches are deliberately kept.
 */
export async function cleanupEasyCodeUserData(
  options: EasyCodeCleanupOptions = {},
): Promise<EasyCodeCleanupResult> {
  const removed: string[] = [];
  const absent: string[] = [];
  const preserved: string[] = [];
  const warnings: string[] = [];
  const home = path.resolve(options.homeDirectory ?? os.homedir());
  const promptHome = options.homeDirectory
    ? path.join(home, ".easy_code")
    : getEasyCodeHome();

  const defaultPaths = options.defaultPaths ?? resolveEasyCodePaths();
  const dataDirectories = await configuredDataDirectories(options, defaultPaths, warnings);
  const readyDataDirectories: string[] = [];
  for (const dataDirectory of dataDirectories) {
    if (await preflightDataDirectory(
      dataDirectory,
      defaultPaths.dataDir,
      warnings,
      preserved,
    )) {
      readyDataDirectories.push(dataDirectory);
    }
  }

  const mutable = { removed, absent };
  await removeExactEntry(promptHome, home, ".easy_code", mutable);
  // Remove an early/design spelling as well, but never migrate or create it.
  await removeExactEntry(path.join(home, ".easy-code"), home, ".easy-code", mutable);

  for (const dataDirectory of readyDataDirectories) {
    await cleanupDataDirectory(dataDirectory, defaultPaths.dataDir, {
      removed,
      absent,
      preserved,
      warnings,
    }, true);
  }

  return Object.freeze({
    removed: Object.freeze([...removed]),
    absent: Object.freeze([...absent]),
    preserved: Object.freeze([...preserved]),
    warnings: Object.freeze([...warnings]),
  });
}
