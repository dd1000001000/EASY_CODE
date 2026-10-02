import type { FileChangeRecord } from "../core/types.js";
import type { TurnChangedFile } from "../ui/contracts.js";

/** Did this change bring the file into existence (a file tool's create, or a command's new file)? */
function createsFile(change: Readonly<FileChangeRecord>): boolean {
  return change.operation === "create" || (change.operation === "generated" && change.beforeHash === undefined);
}

function deletesFile(change: Readonly<FileChangeRecord>): boolean {
  return change.operation === "delete" || change.operation === "deleted_by_command";
}

/**
 * The files one request left changed, each once, in first-touched order: new
 * when the request's first change created it, deleted when its last change
 * removed it. A file both created and removed within the request is left out,
 * as is one whose path no longer resolves inside the workspace.
 */
export function turnChangedFiles(
  changes: readonly Readonly<FileChangeRecord>[],
  resolve: (relative: string) => string,
): TurnChangedFile[] {
  const first = new Map<string, Readonly<FileChangeRecord>>();
  const last = new Map<string, Readonly<FileChangeRecord>>();
  for (const change of changes) {
    if (change.status === "failed" || change.status === "policy_violation" || change.status === "conflict") continue;
    if (!first.has(change.path)) first.set(change.path, change);
    last.set(change.path, change);
  }
  const files: TurnChangedFile[] = [];
  for (const [path, change] of last) {
    const created = createsFile(first.get(path)!);
    const deleted = deletesFile(change);
    if (created && deleted) continue;
    let absolutePath: string;
    try {
      absolutePath = resolve(path);
    } catch {
      continue;
    }
    files.push({ path, absolutePath, change: deleted ? "deleted" : created ? "created" : "modified" });
  }
  return files;
}
