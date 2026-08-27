import path from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";

/**
 * Resolve an existing path canonically, or resolve the nearest existing parent
 * canonically and append the still-missing suffix. This keeps future data
 * directories subject to the same symlink-aware workspace boundary check.
 */
export async function canonicalizePotentialPath(input: string): Promise<string> {
  let cursor = path.resolve(input);
  const missing: string[] = [];
  while (true) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(path.basename(cursor));
      cursor = parent;
      continue;
    }
    // realpath errors on a dangling link are intentionally propagated: its
    // eventual target cannot be proven outside the workspace.
    const canonical = await realpath(cursor);
    if (info.isSymbolicLink() && missing.length === 0) return canonical;
    return path.resolve(canonical, ...missing);
  }
}

/**
 * Resolve the private data directory through its nearest existing ancestor and
 * reject it when that canonical destination is inside the user workspace.
 * Returning the resolved path lets callers keep using the exact destination
 * that was checked instead of traversing a mutable symlink again.
 */
export async function resolveDataDirectoryOutsideWorkspace(
  dataDir: string,
  workspaceRoot: string,
): Promise<string> {
  const [canonicalDataDir, canonicalWorkspace] = await Promise.all([
    canonicalizePotentialPath(dataDir),
    canonicalizePotentialPath(workspaceRoot),
  ]);
  if (isSameOrInside(canonicalDataDir, canonicalWorkspace)) {
    throw new Error(
      "EASY CODE data directory must be outside the workspace so private sessions, " +
        "screenshots, and databases cannot pollute Git. Change EASY_CODE_DATA_DIR " +
        "or the user-level data_dir setting.",
    );
  }
  return canonicalDataDir;
}

/** Reject private EASY CODE state that would be created inside the user workspace. */
export async function assertDataDirectoryOutsideWorkspace(
  dataDir: string,
  workspaceRoot: string,
): Promise<void> {
  await resolveDataDirectoryOutsideWorkspace(dataDir, workspaceRoot);
}

/**
 * Create and re-verify a private data directory before any database or image
 * files are written. The second canonical check closes the ordinary
 * missing-path/symlink race as far as Node's path-based filesystem API allows.
 */
export async function prepareDataDirectoryOutsideWorkspace(
  dataDir: string,
  workspaceRoot: string,
): Promise<string> {
  const candidate = await resolveDataDirectoryOutsideWorkspace(dataDir, workspaceRoot);
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("EASY CODE data directory must be a real directory, not a symlink or junction.");
  }
  return resolveDataDirectoryOutsideWorkspace(await realpath(candidate), workspaceRoot);
}

function isSameOrInside(candidate: string, root: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
