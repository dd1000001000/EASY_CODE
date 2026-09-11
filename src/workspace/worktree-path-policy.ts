import path from "node:path";

/**
 * Leave room for editors and build tools that create temporary siblings next
 * to a checked-out file. Git itself can exceed MAX_PATH when long-path support
 * is enabled, but a child process launched inside the checkout may not.
 */
export const WINDOWS_WORKTREE_SAFE_PATH_CHARS = 240;

export interface WorktreePathAssessment {
  readonly safe: boolean;
  readonly safeLimit: number;
  readonly longestRelativePath: string;
  readonly longestAbsolutePath: string;
  readonly longestPathChars: number;
}

export class WorktreePathTooLongError extends Error {
  readonly assessment: WorktreePathAssessment;

  constructor(assessment: WorktreePathAssessment) {
    super(
      "Worktree path preflight failed: " +
        `predicted Windows path length ${assessment.longestPathChars} exceeds ` +
        `the safe limit ${assessment.safeLimit}: ${assessment.longestRelativePath || "."}. ` +
        "Shorten the repository path or remove generated/deeply nested tracked files.",
    );
    this.name = "WorktreePathTooLongError";
    this.assessment = assessment;
  }
}

export function assessWorktreePaths(
  worktreeRoot: string,
  repositoryRelativePaths: readonly string[],
  platform: NodeJS.Platform = process.platform,
  safeLimit = WINDOWS_WORKTREE_SAFE_PATH_CHARS,
): WorktreePathAssessment {
  const pathApi = platform === "win32" ? path.win32 : path;
  let longestRelativePath = "";
  let longestAbsolutePath = pathApi.resolve(worktreeRoot);
  let longestPathChars = longestAbsolutePath.length;

  for (const candidate of repositoryRelativePaths) {
    const relative = normalizeRepositoryRelativePath(candidate);
    if (!relative) continue;
    const absolute = pathApi.resolve(worktreeRoot, ...relative.split("/"));
    const contained = pathApi.relative(pathApi.resolve(worktreeRoot), absolute);
    if (
      contained === ".." ||
      contained.startsWith(`..${pathApi.sep}`) ||
      pathApi.isAbsolute(contained)
    ) {
      throw new Error(`Git returned an unsafe Worktree path: ${candidate}`);
    }
    if (absolute.length > longestPathChars) {
      longestRelativePath = relative;
      longestAbsolutePath = absolute;
      longestPathChars = absolute.length;
    }
  }

  return {
    safe: platform !== "win32" || longestPathChars <= safeLimit,
    safeLimit,
    longestRelativePath,
    longestAbsolutePath,
    longestPathChars,
  };
}

function normalizeRepositoryRelativePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!normalized) return "";
  if (
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) {
    throw new Error(`Git returned an unsafe Worktree path: ${value}`);
  }
  return normalized;
}
