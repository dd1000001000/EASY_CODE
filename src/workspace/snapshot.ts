import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
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
  /** Maximum number of filesystem metadata/content reads run concurrently. */
  ioConcurrency?: number;
  /** Cancels an in-progress traversal or file hash without returning partial state. */
  signal?: AbortSignal;
}

/** @internal Dependency override used only by focused snapshot tests. */
export interface WorkspaceSnapshotTestHooks {
  hashFile?: (filename: string) => Promise<string>;
  beforeHash?: (filename: string) => Promise<void>;
}

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".easycode",
  ".easy_code",
  "node_modules",
]);
const RUNTIME_SCRATCH_DIRECTORY = ".easy-code-srt-runtime";
// Workspace snapshots are taken before and after every command. Hashing each
// file serially makes otherwise instant commands pay the full repository scan
// latency twice, which is especially visible on container overlay filesystems.
// Keep the batch deliberately bounded so large workspaces cannot exhaust file
// descriptors while still allowing independent reads to overlap.
const SNAPSHOT_IO_CONCURRENCY = 32;
const MAX_SNAPSHOT_IO_CONCURRENCY = 128;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Workspace snapshot was canceled");
  error.name = "AbortError";
  throw error;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  // dev/ino are populated by Node on the supported platforms (including
  // Windows). The metadata comparison also rejects an in-place rewrite that
  // races this scan, so a later authoritative scan can capture stable bytes.
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function hashStableRegularFile(
  filename: string,
  expected: Stats,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  // O_NOFOLLOW closes the POSIX lstat/open race. O_NONBLOCK prevents a path
  // replaced with a FIFO/device from hanging the scan. Windows does not expose
  // equivalent open flags through Node, so the handle/path identity checks
  // below provide the corresponding fail-closed boundary there.
  const safeFlags = constants.O_RDONLY |
    (process.platform === "win32"
      ? 0
      : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const handle = await open(filename, safeFlags);
  try {
    const opened = await handle.stat();
    const currentPath = await lstat(filename);
    if (
      !opened.isFile() ||
      !currentPath.isFile() ||
      currentPath.isSymbolicLink() ||
      !sameFileIdentity(expected, opened) ||
      !sameFileIdentity(opened, currentPath)
    ) {
      throw new Error("Workspace file changed type or identity during snapshot");
    }

    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false, signal });
    for await (const chunk of stream) {
      throwIfAborted(signal);
      hash.update(chunk as Buffer);
    }
    const after = await handle.stat();
    const finalPath = await lstat(filename);
    if (
      !after.isFile() ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      !sameFileIdentity(opened, after) ||
      !sameFileIdentity(after, finalPath)
    ) {
      throw new Error("Workspace file changed while it was being hashed");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function captureWorkspaceSnapshot(
  guard: WorkspacePathGuard,
  options: SnapshotOptions = {},
  testHooks: WorkspaceSnapshotTestHooks = {},
): Promise<WorkspaceSnapshot> {
  const ignored = options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORIES;
  const maxFiles = options.maxFiles ?? 20_000;
  const requestedIoConcurrency = options.ioConcurrency ?? SNAPSHOT_IO_CONCURRENCY;
  const ioConcurrency = Number.isFinite(requestedIoConcurrency)
    ? Math.max(1, Math.min(MAX_SNAPSHOT_IO_CONCURRENCY, Math.trunc(requestedIoConcurrency)))
    : SNAPSHOT_IO_CONCURRENCY;
  const signal = options.signal;
  const files = new Map<string, WorkspaceSnapshotEntry>();
  const pending: Array<Promise<WorkspaceSnapshotEntry | undefined>> = [];
  let pendingError: unknown;
  let truncated = false;

  const flushPending = async (): Promise<void> => {
    throwIfAborted(signal);
    if (pending.length === 0) return;
    const captured = await Promise.all(pending.splice(0));
    if (pendingError) {
      const error = pendingError;
      pendingError = undefined;
      throw error;
    }
    for (const entry of captured) {
      if (entry) files.set(entry.path, entry);
    }
  };

  const makeRoom = async (): Promise<boolean> => {
    throwIfAborted(signal);
    // A failed or concurrently removed file doesn't consume maxFiles. Resolve
    // the pending batch before deciding that the deterministic traversal limit
    // has actually been reached.
    if (files.size + pending.length >= maxFiles) await flushPending();
    if (files.size < maxFiles) return true;
    truncated = true;
    return false;
  };

  const enqueue = async (
    capture: () => Promise<WorkspaceSnapshotEntry | undefined>,
  ): Promise<void> => {
    throwIfAborted(signal);
    // Attach a rejection handler immediately. A fast AbortSignal can reject a
    // hash before the bounded batch is flushed; leaving that promise naked
    // until Promise.all would trigger an unhandled rejection in Node.
    pending.push(capture().catch((error: unknown) => {
      pendingError ??= error;
      return undefined;
    }));
    if (pending.length >= ioConcurrency) await flushPending();
  };

  const visit = async (directory: string): Promise<void> => {
    throwIfAborted(signal);
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    let nextEntry = 0;
    while (nextEntry < entries.length) {
      const batch: Array<{
        entry: (typeof entries)[number];
        absolute: string;
        relative: string;
      }> = [];
      while (nextEntry < entries.length && batch.length < ioConcurrency) {
        if (!(await makeRoom())) return;
        const entry = entries[nextEntry];
        nextEntry += 1;
        if (!entry || entry.name === "." || entry.name === "..") continue;
        // Linked worktrees store `.git` as a regular control file, not a
        // directory. Never hash or expose either form as workspace content.
        if (entry.name.toLowerCase() === ".git") continue;
        // Sandbox command payloads can briefly live here on Windows. This is a
        // Runtime control directory, never project state, and remains excluded
        // even when a caller supplies a custom ignoredDirectoryNames set.
        if (
          directory === guard.root &&
          entry.name.toLowerCase() === RUNTIME_SCRATCH_DIRECTORY
        ) continue;
        if (entry.isDirectory() && ignored.has(entry.name)) continue;

        const absolute = path.join(directory, entry.name);
        guard.assertInside(absolute);
        batch.push({ entry, absolute, relative: guard.toRelative(absolute) });
      }

      const inspected = await Promise.all(batch.map(async (candidate) => {
        throwIfAborted(signal);
        try {
          return { ...candidate, info: await lstat(candidate.absolute) };
        } catch {
          return { ...candidate, info: undefined };
        }
      }));

      for (const candidate of inspected) {
        // Preserve the original depth-first limit semantics even though the
        // metadata for this small batch was prefetched concurrently.
        if (!(await makeRoom())) return;
        const { absolute, relative, info } = candidate;
        if (!info) continue;

        if (info.isSymbolicLink()) {
          await enqueue(async () => {
            let target = "<unreadable>";
            try {
              target = await readlink(absolute);
            } catch {
              // The metadata still records that the link exists.
            }
            return {
              path: relative,
              kind: "symlink",
              hash: sha256(`symlink:${target}`),
              size: info.size,
              mtimeMs: info.mtimeMs,
            };
          });
          continue;
        }

        if (info.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!info.isFile()) continue;

        await enqueue(async () => {
          try {
            await testHooks.beforeHash?.(absolute);
            throwIfAborted(signal);
            return {
              path: relative,
              kind: "file",
              hash: testHooks.hashFile
                ? await testHooks.hashFile(absolute)
                : await hashStableRegularFile(absolute, info, signal),
              size: info.size,
              mtimeMs: info.mtimeMs,
            };
          } catch {
            throwIfAborted(signal);
            // A concurrently removed file is reflected by the next authoritative scan.
            return undefined;
          }
        });
      }
    }
  };

  await visit(guard.root);
  await flushPending();
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
