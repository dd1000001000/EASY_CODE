import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { FileVersion, ToolContext } from "../core/types.js";
import type { VerifiedWorkspaceFileState, WorkspaceManager } from "../workspace/manager.js";
import type { ResolveExistingOptions } from "../workspace/path-guard.js";

export interface FileToolTarget {
  absolutePath: string;
  displayPath: string;
  versionKey: string;
  workspaceRelative?: string;
}

/** Legacy interface: approval posture never grants host filesystem authority. */
export function hasUnrestrictedHostAccess(_context: ToolContext): boolean { return false; }

function workspacePath(target: FileToolTarget): string {
  if (!target.workspaceRelative) throw new Error("Host file access is not permitted");
  return target.workspaceRelative;
}

function comparable(filename: string): string {
  const normalized = path.normalize(filename);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function resolveExistingFileToolTarget(
  manager: WorkspaceManager, _context: ToolContext, input: string, options: ResolveExistingOptions = {},
): Promise<FileToolTarget> {
  const relative = manager.pathGuard.normalizeRelative(input);
  const absolutePath = await manager.pathGuard.resolveExisting(relative, options);
  return { absolutePath, displayPath: relative, versionKey: comparable(absolutePath), workspaceRelative: relative };
}

export async function resolveCreateFileToolTarget(
  manager: WorkspaceManager, _context: ToolContext, input: string,
): Promise<FileToolTarget> {
  const relative = manager.pathGuard.normalizeRelative(input);
  const absolutePath = await manager.pathGuard.resolveForCreate(relative, true);
  return { absolutePath, displayPath: relative, versionKey: comparable(absolutePath), workspaceRelative: relative };
}

export async function prepareCreateFileToolTarget(context: ToolContext, target: FileToolTarget): Promise<void> {
  assertHostFileMutationStillAllowed(context, target);
  const parent = path.dirname(target.absolutePath);
  await mkdir(parent, { recursive: true });
  assertHostFileMutationStillAllowed(context, target);
  const canonicalParent = path.normalize(await realpath(parent));
  if (comparable(path.join(canonicalParent, path.basename(target.absolutePath))) !== target.versionKey) {
    throw new Error("File path changed while creation was being prepared");
  }
}

export function recordFileToolRead(
  manager: WorkspaceManager, target: FileToolTarget, hash: string, _context: ToolContext,
): FileVersion { return manager.recordRead(workspacePath(target), hash); }

export function getFileToolReadVersion(
  manager: WorkspaceManager, target: FileToolTarget, _context: ToolContext,
): FileVersion | undefined { return manager.getReadVersion(workspacePath(target)); }

export function invalidateFileToolReadVersion(manager: WorkspaceManager, target: FileToolTarget): void {
  manager.invalidateReadVersion(workspacePath(target));
}

export async function refreshWorkspaceForFileToolTarget(
  manager: WorkspaceManager, target: FileToolTarget, state?: VerifiedWorkspaceFileState,
): Promise<void> { manager.updateManifestForVerifiedFile(workspacePath(target), state); }

/** Workspace mutations are serialized by the shared Runtime workspace lock. */
export async function acquireHostFileMutationLock(target: FileToolTarget, signal?: AbortSignal): Promise<() => void> {
  workspacePath(target);
  signal?.throwIfAborted();
  return () => undefined;
}

export function assertHostFileMutationStillAllowed(context: ToolContext, target: FileToolTarget): void {
  workspacePath(target);
  if (context.mode === "plan") throw new Error("Plan mode is read-only");
  if (context.signal?.aborted) throw new Error("File mutation was canceled before it committed");
}
