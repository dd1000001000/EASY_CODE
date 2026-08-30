import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { FileVersion, ToolContext } from "../core/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { ExistingPathKind, ResolveExistingOptions } from "../workspace/path-guard.js";

/**
 * A file-tool target after Runtime, rather than the model, has resolved its
 * identity. `workspaceRelative` is present only when the ordinary workspace
 * bookkeeping boundary accepts the path. Host targets remain process-local so
 * an unrestricted read cannot become a durable authorization after Resume.
 */
export interface FileToolTarget {
  absolutePath: string;
  displayPath: string;
  versionKey: string;
  workspaceRelative?: string;
}

interface HostReadAuthorization {
  version: FileVersion;
  epoch: number;
}

const hostReadVersions = new WeakMap<WorkspaceManager, Map<string, HostReadAuthorization>>();

function comparable(filename: string): string {
  const normalized = path.normalize(filename);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function validateHostPath(input: string): void {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  if (input.includes("\0") || input.includes("\r") || input.includes("\n")) {
    throw new Error("Path contains forbidden control characters");
  }
}

export function hasUnrestrictedHostAccess(context: ToolContext): boolean {
  return context.commandExecutionMode === "unrestricted" &&
    (context.isUnrestrictedHostAccessActive?.() ?? true);
}

function hostLexicalPath(manager: WorkspaceManager, input: string): string {
  validateHostPath(input);
  if (!path.isAbsolute(input)) {
    throw new Error("Host file access requires an absolute path in unrestricted mode");
  }
  return path.normalize(path.resolve(input));
}

function workspaceRelativeForBookkeeping(
  manager: WorkspaceManager,
  absolutePath: string,
): string | undefined {
  try {
    const relative = manager.pathGuard.toRelative(absolutePath);
    // normalizeRelative also rejects Runtime-owned .git and trust-control
    // paths. Unrestricted mode may access them, but they must not enter the
    // normal workspace authorization or Resume projections.
    return manager.pathGuard.normalizeRelative(relative);
  } catch {
    return undefined;
  }
}

function targetFromAbsolute(
  manager: WorkspaceManager,
  absolutePath: string,
): FileToolTarget {
  const normalized = path.normalize(absolutePath);
  const workspaceRelative = workspaceRelativeForBookkeeping(manager, normalized);
  return {
    absolutePath: normalized,
    displayPath: workspaceRelative ?? normalized,
    versionKey: comparable(normalized),
    ...(workspaceRelative ? { workspaceRelative } : {}),
  };
}

function assertKind(info: Awaited<ReturnType<typeof stat>>, kind: ExistingPathKind): void {
  if (kind === "file" && !info.isFile()) {
    throw new Error("Path does not refer to a regular file");
  }
  if (kind === "directory" && !info.isDirectory()) {
    throw new Error("Path does not refer to a directory");
  }
}

export async function resolveExistingFileToolTarget(
  manager: WorkspaceManager,
  context: ToolContext,
  input: string,
  options: ResolveExistingOptions = {},
): Promise<FileToolTarget> {
  if (!hasUnrestrictedHostAccess(context) || !path.isAbsolute(input)) {
    const relative = manager.pathGuard.normalizeRelative(input);
    const absolutePath = await manager.pathGuard.resolveExisting(relative, options);
    return {
      absolutePath,
      displayPath: relative,
      versionKey: comparable(absolutePath),
      workspaceRelative: relative,
    };
  }

  const lexical = hostLexicalPath(manager, input);
  const linkInfo = await lstat(lexical);
  if (linkInfo.isSymbolicLink() && options.allowFinalSymlink === false) {
    throw new Error("Writing through a symbolic link is not allowed");
  }
  const canonical = path.normalize(await realpath(lexical));
  assertKind(await stat(canonical), options.kind ?? "any");
  return targetFromAbsolute(manager, canonical);
}

export async function resolveCreateFileToolTarget(
  manager: WorkspaceManager,
  context: ToolContext,
  input: string,
): Promise<FileToolTarget> {
  if (!hasUnrestrictedHostAccess(context) || !path.isAbsolute(input)) {
    const relative = manager.pathGuard.normalizeRelative(input);
    const absolutePath = await manager.pathGuard.resolveForCreate(relative, true);
    return {
      absolutePath,
      displayPath: relative,
      versionKey: comparable(absolutePath),
      workspaceRelative: relative,
    };
  }

  const lexical = hostLexicalPath(manager, input);
  let ancestor = path.dirname(lexical);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonicalAncestor = path.normalize(await realpath(ancestor));
      if (!(await stat(canonicalAncestor)).isDirectory()) {
        throw new Error("An ancestor of the target is not a directory");
      }
      const canonicalParent = path.join(canonicalAncestor, ...missingSegments);
      return targetFromAbsolute(
        manager,
        path.join(canonicalParent, path.basename(lexical)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new Error("Could not find an existing host filesystem ancestor");
    }
    missingSegments.unshift(path.basename(ancestor));
    ancestor = parent;
  }
}

export async function prepareCreateFileToolTarget(
  context: ToolContext,
  target: FileToolTarget,
): Promise<void> {
  assertHostFileMutationStillAllowed(context, target);
  const parent = path.dirname(target.absolutePath);
  await mkdir(parent, { recursive: true });
  assertHostFileMutationStillAllowed(context, target);
  const canonicalParent = path.normalize(await realpath(parent));
  if (comparable(path.join(canonicalParent, path.basename(target.absolutePath))) !== target.versionKey) {
    throw new Error("File path changed while creation was being prepared");
  }
}

function externalVersions(manager: WorkspaceManager): Map<string, HostReadAuthorization> {
  let versions = hostReadVersions.get(manager);
  if (!versions) {
    versions = new Map();
    hostReadVersions.set(manager, versions);
  }
  return versions;
}

export function recordFileToolRead(
  manager: WorkspaceManager,
  target: FileToolTarget,
  hash: string,
  context: ToolContext,
): FileVersion {
  if (target.workspaceRelative) {
    return manager.recordRead(target.workspaceRelative, hash);
  }
  const version: FileVersion = {
    path: target.displayPath,
    hash,
    readAt: new Date().toISOString(),
  };
  externalVersions(manager).set(target.versionKey, {
    version,
    epoch: context.unrestrictedHostAccessEpoch?.() ?? 0,
  });
  return { ...version };
}

export function getFileToolReadVersion(
  manager: WorkspaceManager,
  target: FileToolTarget,
  context: ToolContext,
): FileVersion | undefined {
  if (target.workspaceRelative) {
    return manager.getReadVersion(target.workspaceRelative);
  }
  const authorization = externalVersions(manager).get(target.versionKey);
  if (!authorization) return undefined;
  if (authorization.epoch !== (context.unrestrictedHostAccessEpoch?.() ?? 0)) {
    return undefined;
  }
  return { ...authorization.version };
}

export function invalidateFileToolReadVersion(
  manager: WorkspaceManager,
  target: FileToolTarget,
): void {
  if (target.workspaceRelative) {
    manager.invalidateReadVersion(target.workspaceRelative);
    return;
  }
  externalVersions(manager).delete(target.versionKey);
}

export async function refreshWorkspaceForFileToolTarget(
  manager: WorkspaceManager,
  target: FileToolTarget,
): Promise<void> {
  if (target.workspaceRelative) await manager.refreshManifest();
}

let hostMutationTail: Promise<void> = Promise.resolve();

/** Serialize host file mutations across main and Worktree child managers. */
export async function acquireHostFileMutationLock(
  target: FileToolTarget,
  signal?: AbortSignal,
): Promise<() => void> {
  if (target.workspaceRelative) return () => undefined;
  if (signal?.aborted) throw new Error("Host file mutation was canceled before it started");
  const previous = hostMutationTail;
  let release!: () => void;
  hostMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (!signal) {
    await previous;
  } else {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        void previous.then(() => release());
        reject(new Error("Host file mutation was canceled while waiting for the lock"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void previous.then(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

export function assertHostFileMutationStillAllowed(
  context: ToolContext,
  target: FileToolTarget,
): void {
  if (context.signal?.aborted) {
    throw new Error("Host file mutation was canceled before it committed");
  }
  if (!target.workspaceRelative && !hasUnrestrictedHostAccess(context)) {
    throw new Error("Unrestricted host access was revoked before the file mutation committed");
  }
}
