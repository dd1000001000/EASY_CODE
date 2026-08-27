import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../utils/hash.js";
import { WorkspacePathGuard } from "./path-guard.js";

export interface WorkspaceSnapshotEntry {
  path: string;
  kind: "file" | "symlink";
  hash: string;
  size: number;
  mtimeMs: number;
}

export interface WorkspaceSnapshot {
  capturedAt: string;
  files: Map<string, WorkspaceSnapshotEntry>;
  truncated: boolean;
}

export interface WorkspaceDelta {
  created: WorkspaceSnapshotEntry[];
  updated: Array<{ before: WorkspaceSnapshotEntry; after: WorkspaceSnapshotEntry }>;
  deleted: WorkspaceSnapshotEntry[];
  truncated: boolean;
}

export interface SnapshotOptions {
  ignoredDirectoryNames?: ReadonlySet<string>;
  maxFiles?: number;
}

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".easycode",
  "node_modules",
]);

async function hashFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filename);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export async function captureWorkspaceSnapshot(
  guard: WorkspacePathGuard,
  options: SnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const ignored = options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORIES;
  const maxFiles = options.maxFiles ?? 20_000;
  const files = new Map<string, WorkspaceSnapshotEntry>();
  let truncated = false;

  const visit = async (directory: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.size >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.name === "." || entry.name === "..") continue;
      if (entry.isDirectory() && ignored.has(entry.name)) continue;

      const absolute = path.join(directory, entry.name);
      guard.assertInside(absolute);
      const relative = guard.toRelative(absolute);
      let info;
      try {
        info = await lstat(absolute);
      } catch {
        continue;
      }

      if (info.isSymbolicLink()) {
        let target = "<unreadable>";
        try {
          target = await readlink(absolute);
        } catch {
          // The metadata still records that the link exists.
        }
        files.set(relative, {
          path: relative,
          kind: "symlink",
          hash: sha256(`symlink:${target}`),
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
        continue;
      }

      if (info.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!info.isFile()) continue;

      try {
        files.set(relative, {
          path: relative,
          kind: "file",
          hash: await hashFile(absolute),
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // A concurrently removed file is reflected by the next authoritative scan.
      }
    }
  };

  await visit(guard.root);
  return { capturedAt: new Date().toISOString(), files, truncated };
}

export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): WorkspaceDelta {
  const created: WorkspaceSnapshotEntry[] = [];
  const updated: Array<{ before: WorkspaceSnapshotEntry; after: WorkspaceSnapshotEntry }> = [];
  const deleted: WorkspaceSnapshotEntry[] = [];

  for (const [filename, next] of after.files) {
    const previous = before.files.get(filename);
    if (!previous) {
      created.push(next);
    } else if (previous.hash !== next.hash || previous.kind !== next.kind) {
      updated.push({ before: previous, after: next });
    }
  }

  for (const [filename, previous] of before.files) {
    if (!after.files.has(filename)) deleted.push(previous);
  }

  const byPath = (left: { path: string }, right: { path: string }): number =>
    left.path.localeCompare(right.path);
  created.sort(byPath);
  deleted.sort(byPath);
  updated.sort((left, right) => left.after.path.localeCompare(right.after.path));

  return {
    created,
    updated,
    deleted,
    truncated: before.truncated || after.truncated,
  };
}

