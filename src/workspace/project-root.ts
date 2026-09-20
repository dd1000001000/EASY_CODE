import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/** Physical checkout root, not a thread or Git remote identity. */
export function projectRootFromWorkspace(workspaceRoot: string): string {
  const workspace = path.normalize(realpathSync(path.resolve(workspaceRoot)));
  let candidate = workspace;
  for (;;) {
    try {
      const git = lstatSync(path.join(candidate, ".git"));
      if (git.isDirectory() || git.isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return workspace;
    candidate = parent;
  }
}
