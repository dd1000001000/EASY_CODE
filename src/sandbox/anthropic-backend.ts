import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkspaceManager } from "../workspace/manager.js";
import type {
  CommandExecutionBackend,
  PreparedCommand,
  SandboxExecutionMetadata,
  SandboxExecutionRequest,
  SandboxWorkerPayload,
} from "./types.js";
import {
  DefaultWindowsAclPreflight,
  type WindowsAclMutationProbe,
  type WindowsAclPreflight,
} from "./windows-acl-preflight.js";
import { WindowsSandboxProcessLock } from "./windows-process-lock.js";
import {
  DefaultWindowsSandboxReadProbe,
  type WindowsSandboxReadProbe,
  type WindowsSandboxReadStatus,
  windowsSandboxReadKey,
} from "./windows-sandbox-read-probe.js";

class AsyncGate {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
}

// SRT's Windows backend uses one machine-wide sandbox account/SID. Serializing
// within this EASY CODE process prevents concurrent child Worktrees from
// receiving overlapping ACL grants through that identity.
const SANDBOX_BROKER_RUNTIME_PARENT = path.join(os.tmpdir(), "easy-code-srt-runtime");
const WINDOWS_SANDBOX_SCRATCH_DIRECTORY = ".easy-code-srt-runtime";
const WINDOWS_SANDBOX_SCRATCH_MARKER = ".easy-code-scratch.json";
const WINDOWS_SANDBOX_SCRATCH_GRACE_MS = 60_000;
const WINDOWS_SANDBOX_COMMAND_NAME = /^command-[0-9a-f-]{36}$/iu;
const WINDOWS_SANDBOX_GC_NAME = /^gc-(command-[0-9a-f-]{36})-[0-9a-f-]{36}$/iu;
const WINDOWS_SANDBOX_GATE = new AsyncGate();
const WINDOWS_SANDBOX_PROCESS_LOCK = new WindowsSandboxProcessLock(
  path.join(SANDBOX_BROKER_RUNTIME_PARENT, "windows-acl.lock"),
);

export interface AnthropicSandboxBackendOptions {
  sensitiveReadPaths?: readonly string[];
  /** Dependency injection for the Windows effective-access preflight. */
  windowsAclPreflight?: WindowsAclPreflight;
  /** Dependency injection for the restricted-account read probe. */
  windowsSandboxReadProbe?: WindowsSandboxReadProbe;
  /** Dependency injection for platform-specific tests. */
  platform?: NodeJS.Platform;
}

function uniquePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(value);
    const directoryHint = /[\\/]$/u.test(value);
    const normalized = directoryHint ? `${resolved}${path.sep}` : resolved;
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function pathIsInside(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
  allowEqual = true,
): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalizedRoot = pathApi.resolve(root);
  const normalizedCandidate = pathApi.resolve(candidate);
  const relative = pathApi.relative(normalizedRoot, normalizedCandidate);
  if (!relative) return allowEqual;
  return relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

function collapseNestedPaths(
  values: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const ordered = [...values].sort((left, right) =>
    pathApi.resolve(left).length - pathApi.resolve(right).length
  );
  const roots: string[] = [];
  for (const candidate of ordered) {
    if (roots.some((root) => pathIsInside(root, candidate, platform))) continue;
    roots.push(candidate);
  }
  return roots;
}

/**
 * Windows and installed-program directories already grant read/execute to the
 * ordinary Users group. Asking SRT to add another ACE there is both redundant
 * and guaranteed to fail for TrustedInstaller-owned paths such as Program
 * Files. Keep this pure helper exported for the platform-independent tests.
 */
export function isWindowsSharedExecutablePath(
  filename: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const systemDrive = environmentValue(environment, "SystemDrive") ?? "C:";
  const roots = [
    environmentValue(environment, "SystemRoot") ?? `${systemDrive}\\Windows`,
    environmentValue(environment, "ProgramFiles") ?? `${systemDrive}\\Program Files`,
    environmentValue(environment, "ProgramFiles(x86)") ?? `${systemDrive}\\Program Files (x86)`,
    environmentValue(environment, "ProgramW6432") ?? `${systemDrive}\\Program Files`,
  ];
  const seen = new Set<string>();
  return roots.some((root) => {
    const normalized = path.win32.resolve(root).toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return pathIsInside(normalized, filename, "win32");
  });
}

async function canonicalExistingPaths(values: readonly string[]): Promise<string[]> {
  const canonical = await Promise.all(values.map(async (value) => {
    try {
      return await realpath(value);
    } catch {
      return path.resolve(value);
    }
  }));
  return uniquePaths(canonical);
}

function defaultSensitiveReadPaths(): string[] {
  const home = os.homedir();
  return uniquePaths([
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".config", "gcloud"),
  ]);
}

const WINDOWS_SENSITIVE_PROBE_ITEM_LIMIT = 512;
const WINDOWS_SENSITIVE_PROBE_SCAN_TIMEOUT_MS = 2_000;
const WINDOWS_READ_PROBE_BATCH_UTF8_BUDGET = 8_000;
const WINDOWS_READ_PROBE_TOTAL_TIMEOUT_MS = 12_000;

class WindowsSensitivePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsSensitivePreflightError";
  }
}

function throwSensitiveControlError(error: unknown): void {
  if (
    error instanceof WindowsSensitivePreflightError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    throw error;
  }
}

function abortSandboxPreparation(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Sandbox preparation was cancelled");
  error.name = "AbortError";
  throw error;
}

function assertSensitiveScanActive(deadlineMs: number, signal?: AbortSignal): void {
  abortSandboxPreparation(signal);
  if (Date.now() >= deadlineMs) {
    throw new WindowsSensitivePreflightError(
      "Windows sensitive-path preflight exceeded 2000ms before sandbox initialization",
    );
  }
}

async function collectWindowsSensitiveProbePaths(
  value: string,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<{
  paths: string[];
  complete: boolean;
}> {
  assertSensitiveScanActive(deadlineMs, signal);
  const root = withoutDirectoryHint(path.win32.resolve(value));
  if (root.startsWith("\\\\")) {
    throw new WindowsSensitivePreflightError(
      `Windows sensitive-path preflight accepts local paths only; network/device path rejected: ${root}`,
    );
  }
  let rootInfo;
  try {
    rootInfo = await lstat(root);
    assertSensitiveScanActive(deadlineMs, signal);
  } catch (error) {
    throwSensitiveControlError(error);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { paths: [], complete: false };
    }
    return { paths: [], complete: false };
  }
  if (rootInfo.isSymbolicLink()) return { paths: [], complete: false };

  const paths: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    assertSensitiveScanActive(deadlineMs, signal);
    const current = pending.pop()!;
    paths.push(current);
    if (paths.length > WINDOWS_SENSITIVE_PROBE_ITEM_LIMIT) {
      throw new WindowsSensitivePreflightError(
        `Windows sensitive-path preflight exceeded ${WINDOWS_SENSITIVE_PROBE_ITEM_LIMIT} local objects`,
      );
    }
    let info;
    try {
      info = current === root ? rootInfo : await lstat(current);
      assertSensitiveScanActive(deadlineMs, signal);
    } catch {
      // Re-run the guards outside the filesystem catch so cancellation and
      // the aggregate scan deadline cannot be converted into "incomplete".
      assertSensitiveScanActive(deadlineMs, signal);
      return { paths: [], complete: false };
    }
    if (info.isSymbolicLink()) return { paths: [], complete: false };
    if (!info.isDirectory()) continue;
    try {
      const directory = await opendir(current);
      assertSensitiveScanActive(deadlineMs, signal);
      for await (const child of directory) {
        assertSensitiveScanActive(deadlineMs, signal);
        if (paths.length + pending.length >= WINDOWS_SENSITIVE_PROBE_ITEM_LIMIT) {
          throw new WindowsSensitivePreflightError(
            `Windows sensitive-path preflight exceeded ${WINDOWS_SENSITIVE_PROBE_ITEM_LIMIT} local objects`,
          );
        }
        const childPath = path.win32.join(current, child.name);
        if (child.isSymbolicLink()) return { paths: [], complete: false };
        pending.push(childPath);
      }
    } catch (error) {
      throwSensitiveControlError(error);
      return { paths: [], complete: false };
    }
  }
  return { paths, complete: true };
}

function sandboxMetadata(request: SandboxExecutionRequest): SandboxExecutionMetadata {
  const network = request.policyDecision.capability === "shell_exec"
    ? "allowed"
    : request.policyDecision.capability === "registry_install"
      ? "registry-only"
      : "denied";
  return {
    backend: process.platform === "win32"
      ? "anthropic-srt-windows"
      : process.platform === "darwin"
        ? "anthropic-srt-macos"
        : "anthropic-srt-linux",
    enforced: true,
    filesystem: "workspace-write",
    network,
  };
}

function networkDomains(request: SandboxExecutionRequest): string[] {
  if (
    request.policyDecision.capability === "shell_exec"
  ) {
    return ["*"];
  }
  if (request.policyDecision.capability === "registry_install") {
    return ["registry.npmjs.org"];
  }
  return [];
}

function assertScratchPath(
  scratchRoot: string,
  workspaceRoot: string,
  platform: NodeJS.Platform,
): void {
  const temporaryRoot = path.resolve(
    platform === "win32"
      ? path.join(workspaceRoot, WINDOWS_SANDBOX_SCRATCH_DIRECTORY)
      : SANDBOX_BROKER_RUNTIME_PARENT,
  );
  const resolved = path.resolve(scratchRoot);
  const basename = path.basename(resolved);
  const sameParent = platform === "win32"
    ? path.dirname(resolved).toLowerCase() === temporaryRoot.toLowerCase()
    : path.dirname(resolved) === temporaryRoot;
  if (
    !sameParent ||
    (!WINDOWS_SANDBOX_COMMAND_NAME.test(basename) && !WINDOWS_SANDBOX_GC_NAME.test(basename))
  ) {
    throw new Error("Refusing to clean an invalid EASY CODE sandbox scratch path");
  }
}

interface WindowsSandboxScratchRecord {
  schemaVersion: 1;
  purpose: "easy-code-srt-command";
  token: string;
  pid: number;
  createdAt: string;
  workspaceRoot: string;
  scratchRoot: string;
}

function windowsScratchLeasePath(workspaceRoot: string, scratchRoot: string): string {
  const workspaceKey = windowsScratchWorkspaceKey(workspaceRoot);
  return path.join(
    SANDBOX_BROKER_RUNTIME_PARENT,
    "scratch-leases",
    `${workspaceKey}-${path.basename(scratchRoot)}.json`,
  );
}

function windowsScratchWorkspaceKey(workspaceRoot: string): string {
  return createHash("sha256")
    .update(path.win32.resolve(workspaceRoot).toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

async function assertWindowsScratchRuntimeRoot(workspaceRoot: string): Promise<string> {
  const runtimeRoot = path.join(workspaceRoot, WINDOWS_SANDBOX_SCRATCH_DIRECTORY);
  const info = await lstat(runtimeRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Windows sandbox scratch Runtime root cannot be a link");
  }
  const canonical = await realpath(runtimeRoot);
  if (!sameWindowsPath(canonical, runtimeRoot)) {
    throw new Error("Windows sandbox scratch Runtime root escaped the workspace");
  }
  return runtimeRoot;
}

async function assertWindowsScratchLeaseRoot(): Promise<string> {
  const leaseRoot = path.join(SANDBOX_BROKER_RUNTIME_PARENT, "scratch-leases");
  await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
  const info = await lstat(leaseRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Windows sandbox scratch lease root cannot be a link");
  }
  const canonicalParent = await realpath(path.dirname(leaseRoot));
  const expected = path.join(canonicalParent, path.basename(leaseRoot));
  if (!sameWindowsPath(await realpath(leaseRoot), expected)) {
    throw new Error("Windows sandbox scratch lease root was redirected");
  }
  return leaseRoot;
}

async function assertOrdinaryScratchDirectory(
  scratchRoot: string,
  workspaceRoot: string,
): Promise<void> {
  assertScratchPath(scratchRoot, workspaceRoot, "win32");
  await assertWindowsScratchRuntimeRoot(workspaceRoot);
  const info = await lstat(scratchRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Refusing to clean a non-directory or linked sandbox scratch path");
  }
  const canonical = await realpath(scratchRoot);
  if (!sameWindowsPath(canonical, scratchRoot)) {
    throw new Error("Refusing to clean a redirected sandbox scratch path");
  }
}

function parseScratchRecord(value: string): WindowsSandboxScratchRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<WindowsSandboxScratchRecord>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.purpose !== "easy-code-srt-command" ||
      typeof parsed.token !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(parsed.token) ||
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.workspaceRoot !== "string" ||
      typeof parsed.scratchRoot !== "string"
    ) return undefined;
    return parsed as WindowsSandboxScratchRecord;
  } catch {
    return undefined;
  }
}

function processMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function validateCurrentWindowsScratchOwnership(
  scratchRoot: string,
  workspaceRoot: string,
): Promise<string> {
  return validateWindowsScratchOwnershipAt(scratchRoot, scratchRoot, workspaceRoot);
}

async function validateWindowsScratchOwnershipAt(
  physicalScratchRoot: string,
  originalScratchRoot: string,
  workspaceRoot: string,
): Promise<string> {
  await assertOrdinaryScratchDirectory(physicalScratchRoot, workspaceRoot);
  assertScratchPath(originalScratchRoot, workspaceRoot, "win32");
  if (!WINDOWS_SANDBOX_COMMAND_NAME.test(path.basename(originalScratchRoot))) {
    throw new Error("Sandbox scratch ownership must reference an original command directory");
  }
  const markerPath = path.join(physicalScratchRoot, WINDOWS_SANDBOX_SCRATCH_MARKER);
  const leasePath = windowsScratchLeasePath(workspaceRoot, originalScratchRoot);
  const [markerInfo, leaseInfo] = await Promise.all([lstat(markerPath), lstat(leasePath)]);
  const [canonicalMarkerParent, canonicalLeaseParent] = await Promise.all([
    realpath(path.dirname(markerPath)),
    realpath(path.dirname(leasePath)),
  ]);
  if (
    !markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 8_192 ||
    !leaseInfo.isFile() || leaseInfo.isSymbolicLink() || leaseInfo.size > 8_192 ||
    !sameWindowsPath(
      await realpath(markerPath),
      path.join(canonicalMarkerParent, path.basename(markerPath)),
    ) ||
    !sameWindowsPath(
      await realpath(leasePath),
      path.join(canonicalLeaseParent, path.basename(leasePath)),
    )
  ) {
    throw new Error("Sandbox scratch ownership records are not ordinary files");
  }
  const [marker, lease] = await Promise.all([
    readFile(markerPath, "utf8").then(parseScratchRecord),
    readFile(leasePath, "utf8").then(parseScratchRecord),
  ]);
  if (
    !marker ||
    !lease ||
    JSON.stringify(marker) !== JSON.stringify(lease) ||
    marker.pid !== process.pid ||
    !sameWindowsPath(marker.workspaceRoot, workspaceRoot) ||
    !sameWindowsPath(marker.scratchRoot, originalScratchRoot)
  ) {
    throw new Error("Sandbox scratch ownership records do not match this process");
  }
  return leasePath;
}

async function pathIsMissing(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function removeDirectoryConfirmed(value: string): Promise<void> {
  await rm(value, { recursive: true, force: true });
  if (!(await pathIsMissing(value))) {
    throw new Error(`Sandbox scratch removal did not remove ${value}`);
  }
}

async function removeFileConfirmed(value: string): Promise<void> {
  await rm(value, { force: true });
  if (!(await pathIsMissing(value))) {
    throw new Error(`Sandbox lease removal did not remove ${value}`);
  }
}

async function cleanupStaleWindowsSandboxScratchRoots(workspaceRoot: string): Promise<void> {
  const runtimeRoot = path.join(workspaceRoot, WINDOWS_SANDBOX_SCRATCH_DIRECTORY);
  await mkdir(runtimeRoot, { recursive: true });
  await assertWindowsScratchRuntimeRoot(workspaceRoot);
  const leaseRoot = await assertWindowsScratchLeaseRoot();
  let entries;
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Windows sandbox scratch Runtime root could not be enumerated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const blocked: string[] = [];
  for (const entry of entries) {
    const commandMatch = WINDOWS_SANDBOX_COMMAND_NAME.exec(entry.name);
    const gcMatch = WINDOWS_SANDBOX_GC_NAME.exec(entry.name);
    if ((!commandMatch && !gcMatch) || !entry.isDirectory() || entry.isSymbolicLink()) {
      blocked.push(`${path.join(runtimeRoot, entry.name)}: unexpected Runtime scratch entry`);
      continue;
    }
    const scratchRoot = path.join(runtimeRoot, entry.name);
    const originalScratchRoot = path.join(runtimeRoot, gcMatch?.[1] ?? entry.name);
    const markerPath = path.join(scratchRoot, WINDOWS_SANDBOX_SCRATCH_MARKER);
    const leasePath = windowsScratchLeasePath(workspaceRoot, originalScratchRoot);
    let physicalScratchRoot = scratchRoot;
    try {
      await assertOrdinaryScratchDirectory(scratchRoot, workspaceRoot);
      const leaseInfo = await lstat(leasePath);
      if (!leaseInfo.isFile() || leaseInfo.isSymbolicLink() || leaseInfo.size > 8_192) {
        throw new Error("lease is not an ordinary bounded file");
      }
      const lease = parseScratchRecord(await readFile(leasePath, "utf8"));
      if (!lease) throw new Error("lease record is invalid");
      let marker: WindowsSandboxScratchRecord | undefined;
      try {
        const markerInfo = await lstat(markerPath);
        if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 8_192) {
          throw new Error("marker is not an ordinary bounded file");
        }
        marker = parseScratchRecord(await readFile(markerPath, "utf8"));
        if (!marker || JSON.stringify(marker) !== JSON.stringify(lease)) {
          throw new Error("marker and lease records do not match");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Lease-first creation can crash before the marker is written. The
        // trusted external lease still binds the exact direct child path.
      }
      if (
        !sameWindowsPath(lease.workspaceRoot, workspaceRoot) ||
        !sameWindowsPath(lease.scratchRoot, originalScratchRoot) ||
        processMayBeAlive(lease.pid) ||
        Date.now() - Date.parse(lease.createdAt) < WINDOWS_SANDBOX_SCRATCH_GRACE_MS
      ) {
        throw new Error("scratch owner is still live, inside the grace period, or mismatched");
      }
      const quarantine = commandMatch
        ? path.join(runtimeRoot, `gc-${entry.name}-${randomUUID()}`)
        : scratchRoot;
      if (commandMatch) {
        await rename(scratchRoot, quarantine);
        physicalScratchRoot = quarantine;
      }
      await assertOrdinaryScratchDirectory(quarantine, workspaceRoot);
      await removeDirectoryConfirmed(quarantine);
      await removeFileConfirmed(leasePath);
    } catch (error) {
      // A recognized scratch directory can contain the previous command's argv
      // and environment. If it remains, fail closed before granting the next
      // sandbox process workspace read access.
      const remains = await pathIsMissing(physicalScratchRoot)
        .then((missing) => !missing)
        .catch(() => true);
      if (remains) {
        blocked.push(
          `${physicalScratchRoot}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (blocked.length > 0) {
    throw new Error(
      `Windows sandbox scratch cleanup could not safely remove prior command data:\n${blocked.join("\n")}`,
    );
  }

  // Lease-only records contain no command data. Clean them globally so moved
  // or deleted workspaces do not leave permanent broker metadata.
  const leaseDeadline = Date.now() + 2_000;
  let leaseCount = 0;
  const leaseDirectory = await opendir(leaseRoot);
  for await (const entry of leaseDirectory) {
    leaseCount += 1;
    if (leaseCount > 1_024 || Date.now() >= leaseDeadline) break;
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const leasePath = path.join(leaseRoot, entry.name);
    try {
      const info = await lstat(leasePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8_192) continue;
      const lease = parseScratchRecord(await readFile(leasePath, "utf8"));
      if (!lease) continue;
      const normalizedWorkspace = path.win32.normalize(lease.workspaceRoot);
      if (
        !/^[A-Za-z]:\\/u.test(normalizedWorkspace) ||
        normalizedWorkspace.startsWith("\\\\")
      ) continue;
      const originalBasename = path.win32.basename(lease.scratchRoot);
      const expectedScratchRoot = path.win32.join(
        path.win32.resolve(lease.workspaceRoot),
        WINDOWS_SANDBOX_SCRATCH_DIRECTORY,
        originalBasename,
      );
      const expectedLeaseName = path.basename(
        windowsScratchLeasePath(lease.workspaceRoot, lease.scratchRoot),
      );
      if (
        entry.name.toLowerCase() !== expectedLeaseName.toLowerCase() ||
        !WINDOWS_SANDBOX_COMMAND_NAME.test(originalBasename) ||
        !sameWindowsPath(lease.scratchRoot, expectedScratchRoot) ||
        processMayBeAlive(lease.pid) ||
        Date.now() - Date.parse(lease.createdAt) < WINDOWS_SANDBOX_SCRATCH_GRACE_MS
      ) continue;
      if (!(await pathIsMissing(lease.scratchRoot))) continue;

      const leaseRuntimeRoot = path.win32.dirname(lease.scratchRoot);
      let matchingRelocatedScratch = false;
      try {
        const runtimeInfo = await lstat(leaseRuntimeRoot);
        if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) continue;
        const runtimeEntries = await readdir(leaseRuntimeRoot, { withFileTypes: true });
        matchingRelocatedScratch = runtimeEntries.some((candidate) =>
          candidate.isDirectory() &&
          !candidate.isSymbolicLink() &&
          candidate.name.toLowerCase().startsWith(`gc-${originalBasename.toLowerCase()}-`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      if (matchingRelocatedScratch) continue;
      await removeFileConfirmed(leasePath);
    } catch {
      // Malformed or redirected leases are retained for manual inspection.
    }
  }

}

async function createSandboxScratchRoot(
  workspaceRoot: string,
  platform: NodeJS.Platform,
): Promise<string> {
  if (platform === "win32") {
    // The dedicated SRT account cannot traverse the real user's profile, so a
    // %TEMP%-backed bridge fails before the target starts. A random direct
    // child of the already-granted workspace is reachable and is removed after
    // this one command.
    const runtimeRoot = path.join(workspaceRoot, WINDOWS_SANDBOX_SCRATCH_DIRECTORY);
    const leaseRoot = path.join(SANDBOX_BROKER_RUNTIME_PARENT, "scratch-leases");
    await Promise.all([
      mkdir(runtimeRoot, { recursive: true }),
      mkdir(leaseRoot, { recursive: true, mode: 0o700 }),
    ]);
    await assertWindowsScratchRuntimeRoot(workspaceRoot);
    await assertWindowsScratchLeaseRoot();
    const scratchRoot = path.join(runtimeRoot, `command-${randomUUID()}`);
    const record: WindowsSandboxScratchRecord = {
      schemaVersion: 1,
      purpose: "easy-code-srt-command",
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
      workspaceRoot: path.win32.resolve(workspaceRoot),
      scratchRoot: path.win32.resolve(scratchRoot),
    };
    const serialized = JSON.stringify(record);
    const leasePath = windowsScratchLeasePath(workspaceRoot, scratchRoot);
    let leaseCreated = false;
    let scratchDirectoryCreated = false;
    try {
      // The external lease is durable before the workspace directory appears,
      // so every crash state is either an orphan lease or a directory with a
      // matching trusted lease. Both are recoverable without deleting by name.
      await writeFile(leasePath, serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      leaseCreated = true;
      await mkdir(scratchRoot, { mode: 0o700 });
      scratchDirectoryCreated = true;
      await writeFile(path.join(scratchRoot, WINDOWS_SANDBOX_SCRATCH_MARKER), serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return scratchRoot;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      let scratchRemoved = false;
      try {
        if (await pathIsMissing(scratchRoot)) {
          scratchRemoved = true;
        } else if (scratchDirectoryCreated) {
          await assertOrdinaryScratchDirectory(scratchRoot, workspaceRoot);
          await removeDirectoryConfirmed(scratchRoot);
          scratchRemoved = true;
        } else {
          throw new Error(
            "Scratch path appeared without being created by this process; retaining the external lease",
          );
        }
      } catch (cleanupError) {
        // Retain the external lease when the directory cannot be proved gone;
        // it is the only trusted record that can authorize later crash cleanup.
        cleanupErrors.push(cleanupError);
      }
      if (leaseCreated && scratchRemoved) {
        try {
          await removeFileConfirmed(leasePath);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Windows sandbox scratch creation failed and cleanup was incomplete",
        );
      }
      throw error;
    }
  }
  await mkdir(SANDBOX_BROKER_RUNTIME_PARENT, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(SANDBOX_BROKER_RUNTIME_PARENT, "command-"));
}

async function protectedMetadataPaths(values: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(values.map(async (value) => {
    try {
      await stat(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // SRT uses a trailing separator to materialize a directory placeholder
        // instead of the old zero-byte file shape. Keeping the deny closes the
        // TOCTOU where a sandboxed command creates reserved metadata later.
        return `${value}${path.sep}`;
      }
      throw error;
    }
  }));
  return resolved;
}

async function existingPath(value: string): Promise<string | undefined> {
  try {
    await stat(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Preserve an unreadable path in the probe so AccessCheck can produce the
    // actionable path/owner inspection failure instead of silently skipping it.
    return value;
  }
}

function withoutDirectoryHint(value: string): string {
  const parsed = path.parse(value);
  let result = value;
  while (result.length > parsed.root.length && /[\\/]$/u.test(result)) {
    result = result.slice(0, -1);
  }
  return result;
}

async function nearestExistingPath(value: string): Promise<string> {
  let candidate = withoutDirectoryHint(path.resolve(value));
  while (true) {
    if (await existingPath(candidate)) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}

async function windowsAclMutationProbes(filesystem: {
  denyRead: readonly string[];
  allowRead: readonly string[];
  allowWrite: readonly string[];
  denyWrite: readonly string[];
}): Promise<WindowsAclMutationProbe[]> {
  const probes = new Map<string, { path: string; reasons: Set<string> }>();
  const add = (value: string, reason: string): void => {
    const key = path.resolve(value).toLowerCase();
    const current = probes.get(key) ?? { path: value, reasons: new Set<string>() };
    current.reasons.add(reason);
    probes.set(key, current);
  };
  const addGrant = async (value: string, reason: string): Promise<void> => {
    const concrete = await existingPath(withoutDirectoryHint(value));
    if (concrete) add(concrete, reason);
  };
  const addDeny = async (value: string, reason: string): Promise<void> => {
    const target = withoutDirectoryHint(value);
    const concreteTarget = await existingPath(target);
    if (concreteTarget) add(concreteTarget, reason);
    // SRT also places a FILE_DELETE_CHILD deny on the parent. For a missing
    // placeholder chain, the nearest existing ancestor is the only existing
    // DACL that must be changed before SRT can create the owned descendants.
    add(await nearestExistingPath(path.dirname(target)), `${reason} parent protection`);
  };
  await Promise.all([
    ...filesystem.allowRead.map((value) => addGrant(value, "allow-read grant")),
    ...filesystem.allowWrite.map((value) => addGrant(value, "allow-write grant")),
    ...filesystem.denyRead.map((value) => addDeny(value, "deny-read stamp")),
    ...filesystem.denyWrite.map((value) => addDeny(value, "deny-write stamp")),
  ]);
  return [...probes.values()].map((probe) => ({
    path: probe.path,
    reasons: [...probe.reasons],
  }));
}

export class AnthropicSandboxBackend implements CommandExecutionBackend {
  private readonly workerPath: string;
  private readonly bridgePath: string;
  private readonly sensitiveReadPaths: string[];
  private readonly defaultSensitiveReadPathKeys: ReadonlySet<string>;
  private readonly platform: NodeJS.Platform;
  private readonly windowsAclPreflight: WindowsAclPreflight;
  private readonly windowsSandboxReadProbe: WindowsSandboxReadProbe;

  constructor(
    private readonly workspace: WorkspaceManager,
    options: AnthropicSandboxBackendOptions = {},
  ) {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    this.workerPath = path.join(moduleDirectory, "sandbox-worker.js");
    this.bridgePath = path.join(moduleDirectory, "argv-bridge.js");
    const defaultSensitivePaths = defaultSensitiveReadPaths();
    this.defaultSensitiveReadPathKeys = new Set(
      defaultSensitivePaths.map((candidate) => windowsSandboxReadKey(candidate)),
    );
    this.sensitiveReadPaths = uniquePaths([
      ...defaultSensitivePaths,
      ...(options.sensitiveReadPaths ?? []),
    ]);
    this.platform = options.platform ?? process.platform;
    this.windowsAclPreflight = options.windowsAclPreflight ?? new DefaultWindowsAclPreflight();
    this.windowsSandboxReadProbe = options.windowsSandboxReadProbe ??
      new DefaultWindowsSandboxReadProbe();
  }

  private async stageSandboxBridge(scratchRoot: string): Promise<string> {
    const supportRoot = path.join(scratchRoot, "support");
    const stagedBridge = path.join(supportRoot, "argv-bridge.mjs");
    await mkdir(supportRoot, { recursive: true });
    await copyFile(this.bridgePath, stagedBridge);
    return stagedBridge;
  }

  private async externalExecutablePaths(
    executablePaths: readonly string[],
    scratchRoot: string,
  ): Promise<string[]> {
    const canonical = await canonicalExistingPaths(executablePaths);
    return canonical.filter((filename) => {
      if (pathIsInside(this.workspace.root, filename, this.platform)) return false;
      if (pathIsInside(scratchRoot, filename, this.platform)) return false;
      if (this.platform === "win32" && isWindowsSharedExecutablePath(filename)) return false;
      return true;
    });
  }

  private async windowsSensitiveProbeEntries(signal?: AbortSignal): Promise<Array<{
    policyPath: string;
    probePaths: string[];
    complete: boolean;
  }>> {
    const deadlineMs = Date.now() + WINDOWS_SENSITIVE_PROBE_SCAN_TIMEOUT_MS;
    const entries: Array<{
      policyPath: string;
      probePaths: string[];
      complete: boolean;
    }> = [];
    for (const candidate of this.sensitiveReadPaths) {
      // A workspace-contained secret always needs the explicit deny carve-out;
      // scanning it cannot make that decision cheaper or safer.
      if (pathIsInside(this.workspace.root, candidate, "win32")) {
        entries.push({ policyPath: candidate, probePaths: [], complete: false });
        continue;
      }
      const concrete = withoutDirectoryHint(candidate);
      if (
        this.defaultSensitiveReadPathKeys.has(windowsSandboxReadKey(candidate)) &&
        !existsSync(concrete)
      ) {
        // Built-in credential paths are re-evaluated before every command. For
        // a missing path, prove the nearest existing profile ancestor is
        // already inaccessible before omitting the expensive parent stamp.
        assertSensitiveScanActive(deadlineMs, signal);
        const ancestor = await nearestExistingPath(path.dirname(concrete));
        assertSensitiveScanActive(deadlineMs, signal);
        entries.push({ policyPath: candidate, probePaths: [ancestor], complete: true });
        continue;
      }
      const collected = await collectWindowsSensitiveProbePaths(
        candidate,
        deadlineMs,
        signal,
      );
      entries.push({
        policyPath: candidate,
        probePaths: collected.paths,
        complete: collected.complete,
      });
    }
    return entries;
  }

  private async windowsPathAccess(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, WindowsSandboxReadStatus>> {
    abortSandboxPreparation(signal);
    const unique = [...new Map(paths.map((candidate) => [
      windowsSandboxReadKey(candidate),
      path.win32.resolve(candidate),
    ] as const)).values()];
    const batches: string[][] = [];
    let current: string[] = [];
    for (const candidate of unique) {
      const next = [...current, candidate];
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > WINDOWS_READ_PROBE_BATCH_UTF8_BUDGET) {
        if (current.length === 0) {
          throw new Error(`Windows SRT read-probe path is too long: ${candidate}`);
        }
        batches.push(current);
        current = [candidate];
      } else {
        current = next;
      }
    }
    if (current.length > 0) batches.push(current);

    const result = new Map<string, WindowsSandboxReadStatus>();
    const aggregateController = new AbortController();
    let aggregateTimedOut = false;
    const aggregateDeadline = Date.now() + WINDOWS_READ_PROBE_TOTAL_TIMEOUT_MS;
    const forwardAbort = (): void => aggregateController.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const aggregateTimer = setTimeout(() => {
      aggregateTimedOut = true;
      aggregateController.abort();
    }, WINDOWS_READ_PROBE_TOTAL_TIMEOUT_MS);
    aggregateTimer.unref();
    try {
      for (const batch of batches) {
        abortSandboxPreparation(signal);
        if (aggregateTimedOut || Date.now() >= aggregateDeadline) {
          throw new WindowsSensitivePreflightError(
            "Windows SRT restricted-account preflight exceeded its 12000ms aggregate budget",
          );
        }
        try {
          const observed = await this.windowsSandboxReadProbe.pathAccess(
            batch,
            aggregateController.signal,
          );
          abortSandboxPreparation(signal);
          if (aggregateTimedOut || Date.now() >= aggregateDeadline) {
            throw new WindowsSensitivePreflightError(
              "Windows SRT restricted-account preflight exceeded its 12000ms aggregate budget",
            );
          }
          for (const [key, status] of observed) result.set(key, status);
        } catch (error) {
          abortSandboxPreparation(signal);
          if (aggregateTimedOut || Date.now() >= aggregateDeadline) {
            const timeout = new WindowsSensitivePreflightError(
              "Windows SRT restricted-account preflight exceeded its 12000ms aggregate budget",
            ) as WindowsSensitivePreflightError & { cause?: unknown };
            timeout.cause = error;
            throw timeout;
          }
          throwSensitiveControlError(error);
          const detail = error instanceof Error ? error.message : String(error);
          // Do not spend another 75 seconds starting the worker after this same
          // SRT backend has already failed its restricted-account preflight.
          const wrapped = new Error(
            `Windows SRT restricted-account preflight failed before sandbox initialization: ${detail}`,
          ) as Error & { cause?: unknown };
          wrapped.cause = error;
          throw wrapped;
        }
      }
      abortSandboxPreparation(signal);
      return result;
    } finally {
      clearTimeout(aggregateTimer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  private sensitiveDenyReadPaths(
    entries: readonly {
      policyPath: string;
      probePaths: readonly string[];
      complete: boolean;
    }[],
    accessByPath: ReadonlyMap<string, WindowsSandboxReadStatus> | undefined,
  ): string[] {
    if (this.platform !== "win32") return this.sensitiveReadPaths;
    return collapseNestedPaths(
      entries
        .filter(({ policyPath, probePaths, complete }) =>
          // A workspace grant will expose descendants even when the sandbox
          // account could not read them before initialization. Outside the
          // workspace, omit the expensive deny only after a real restricted-
          // account probe proves the nearest existing object is unreadable.
          pathIsInside(this.workspace.root, policyPath, "win32") ||
          !complete ||
          accessByPath === undefined ||
          probePaths.some((probePath) =>
            accessByPath.get(windowsSandboxReadKey(probePath)) !== "denied"))
        .map(({ policyPath }) => policyPath),
      "win32",
    );
  }

  private executableReadPaths(
    executablePaths: readonly string[],
    accessByPath: ReadonlyMap<string, WindowsSandboxReadStatus> | undefined,
  ): string[] {
    if (this.platform !== "win32") return [...executablePaths];
    return uniquePaths(executablePaths.flatMap((filename) => {
      const executableStatus = accessByPath?.get(windowsSandboxReadKey(filename));
      if (executableStatus === "readable") return [];
      // Never widen an executable grant to its parent directory. Interpreters
      // that need private sibling resources must expose those resources through
      // an explicit future runtime-closure policy rather than an implicit tree.
      return [filename];
    }));
  }

  describe(request?: SandboxExecutionRequest): SandboxExecutionMetadata {
    if (request) return sandboxMetadata(request);
    return {
      backend: this.platform === "win32"
        ? "anthropic-srt-windows"
        : process.platform === "darwin"
          ? "anthropic-srt-macos"
          : "anthropic-srt-linux",
      enforced: true,
      filesystem: "workspace-write",
      network: "denied",
    };
  }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    if (request.context.commandExecutionMode === "unrestricted") {
      throw new Error("Dangerous full access must use the dedicated host backend");
    }
    const releaseGate = process.platform === "win32"
      ? await WINDOWS_SANDBOX_GATE.acquire()
      : () => undefined;
    let releaseProcessLock: () => Promise<void> = async () => undefined;
    let scratchRoot = "";
    try {
      await mkdir(SANDBOX_BROKER_RUNTIME_PARENT, { recursive: true, mode: 0o700 });
      if (process.platform === "win32") {
        releaseProcessLock = await WINDOWS_SANDBOX_PROCESS_LOCK.acquire(
          request.context.signal,
        );
        await cleanupStaleWindowsSandboxScratchRoots(this.workspace.root);
      }
      scratchRoot = await createSandboxScratchRoot(this.workspace.root, this.platform);
      const scratchHome = path.join(scratchRoot, "home");
      const scratchTemp = path.join(scratchRoot, "tmp");
      const scratchConfig = path.join(scratchRoot, "config");
      const scratchCache = path.join(scratchRoot, "cache");
      await Promise.all([
        mkdir(scratchHome),
        mkdir(scratchTemp),
        mkdir(scratchConfig),
        mkdir(scratchCache),
      ]);

      const targetEnvironment: NodeJS.ProcessEnv = {
        ...request.command.environment,
        HOME: scratchHome,
        USERPROFILE: scratchHome,
        TEMP: scratchTemp,
        TMP: scratchTemp,
        TMPDIR: scratchTemp,
        APPDATA: scratchConfig,
        LOCALAPPDATA: scratchCache,
        XDG_CONFIG_HOME: scratchConfig,
        XDG_CACHE_HOME: scratchCache,
        EASY_CODE_SANDBOXED: "1",
      };
      const protectedMetadata = await protectedMetadataPaths([
        path.join(this.workspace.root, ".easycode"),
        path.join(this.workspace.root, ".git"),
      ]);
      const payloadPath = path.join(scratchRoot, "worker-payload.json");
      const scratchMarkerPath = path.join(scratchRoot, WINDOWS_SANDBOX_SCRATCH_MARKER);
      const stagedBridgePath = await this.stageSandboxBridge(scratchRoot);
      const externalExecutables = await this.externalExecutablePaths([
        process.execPath,
        request.command.executablePath,
      ], scratchRoot);
      const sensitiveProbeEntries = this.platform === "win32"
        ? await this.windowsSensitiveProbeEntries(request.context.signal)
        : [];
      const windowsPathAccess = this.platform === "win32"
        ? await this.windowsPathAccess([
          ...sensitiveProbeEntries.flatMap(({ probePaths }) => probePaths),
          ...externalExecutables,
        ], request.context.signal)
        : undefined;
      const executableReadPaths = this.executableReadPaths(
        externalExecutables,
        windowsPathAccess,
      );
      const sensitiveDenyRead = this.platform === "win32"
        ? this.sensitiveDenyReadPaths(sensitiveProbeEntries, windowsPathAccess)
        : this.sensitiveReadPaths;

      const payload: SandboxWorkerPayload = {
        version: 1,
        commandId: request.commandId,
        commandPreview: request.commandPreview,
        workspaceRoot: this.workspace.root,
        scratchRoot,
        bridgePath: stagedBridgePath,
        target: {
          executablePath: request.command.executablePath,
          args: [...request.command.args],
          cwdAbsolute: request.command.cwdAbsolute,
          environment: targetEnvironment,
        },
        filesystem: {
          // The target can read its own target-payload.json through the fixed
          // bridge, but it must not learn the parent-only commandId from this
          // worker payload and forge Runtime control markers.
          denyRead: uniquePaths([
            ...sensitiveDenyRead,
            ...(this.platform === "win32" ? [] : [SANDBOX_BROKER_RUNTIME_PARENT]),
            ...(this.platform === "win32" ? [scratchMarkerPath] : []),
            payloadPath,
          ]),
          // allowWrite grants read/execute as well, so workspace/scratch do not
          // need duplicate read ACEs. External executables are granted as
          // canonical files, never as Program Files or NVM directory trees.
          allowRead: executableReadPaths,
          allowWrite: uniquePaths([
            this.workspace.root,
            ...(this.platform === "win32" ? [] : [scratchRoot]),
          ]),
          // Paths outside allowWrite are already immutable to the sandbox user.
          // Only workspace metadata needs an explicit deny carve-out.
          denyWrite: uniquePaths([
            ...protectedMetadata,
            ...(this.platform === "win32" ? [scratchMarkerPath, payloadPath] : []),
          ]),
          allowGitConfig: false,
        },
        network: { allowedDomains: networkDomains(request) },
      };
      if (this.platform === "win32") {
        await this.windowsAclPreflight.check(
          await windowsAclMutationProbes(payload.filesystem),
          { repairTarget: this.workspace.root },
        );
      }
      await writeFile(payloadPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });

      let cleaned = false;
      let cleanupInFlight: Promise<void> | undefined;
      let cleanupTarget = scratchRoot;
      let cleanupLeasePath: string | undefined;
      let cleanupDirectoryRemoved = false;
      let resourcesReleased = false;
      const releaseResources = async (): Promise<void> => {
        if (resourcesReleased) return;
        resourcesReleased = true;
        try {
          await releaseProcessLock();
        } finally {
          releaseGate();
        }
      };
      const cleanupPrepared = async (): Promise<void> => {
        if (cleaned) return;
        if (cleanupInFlight) return cleanupInFlight;
        cleanupInFlight = (async () => {
          try {
            if (!cleanupDirectoryRemoved) {
              assertScratchPath(cleanupTarget, this.workspace.root, this.platform);
              if (this.platform === "win32") {
                cleanupLeasePath = await validateWindowsScratchOwnershipAt(
                  cleanupTarget,
                  scratchRoot,
                  this.workspace.root,
                );
                if (sameWindowsPath(cleanupTarget, scratchRoot)) {
                  const quarantine = path.join(
                    path.dirname(scratchRoot),
                    `gc-${path.basename(scratchRoot)}-${randomUUID()}`,
                  );
                  await rename(scratchRoot, quarantine);
                  // Persist the physical location before any later await so a
                  // failed rm remains retryable by this same cleanup closure.
                  cleanupTarget = quarantine;
                }
                await assertOrdinaryScratchDirectory(cleanupTarget, this.workspace.root);
                await removeDirectoryConfirmed(cleanupTarget);
              } else {
                await removeDirectoryConfirmed(cleanupTarget);
              }
              cleanupDirectoryRemoved = true;
            }
            if (cleanupLeasePath) await removeFileConfirmed(cleanupLeasePath);
            cleaned = true;
          } finally {
            await releaseResources();
          }
        })();
        try {
          await cleanupInFlight;
        } finally {
          cleanupInFlight = undefined;
        }
      };
      return {
        executablePath: process.execPath,
        args: [this.workerPath, payloadPath],
        cwdAbsolute: request.command.cwdAbsolute,
        // The broker needs ordinary OS discovery variables, but this is still
        // the Resolver's credential-free environment. The target gets the
        // tighter scratch HOME/TEMP environment stored in the payload.
        environment: {
          ...request.command.environment,
          EASY_CODE_SRT_WORKER: "1",
        },
        metadata: this.describe(request),
        cleanup: cleanupPrepared,
      };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        if (scratchRoot) {
          assertScratchPath(scratchRoot, this.workspace.root, this.platform);
          if (this.platform === "win32") {
            const leasePath = await validateCurrentWindowsScratchOwnership(
              scratchRoot,
              this.workspace.root,
            );
            await removeDirectoryConfirmed(scratchRoot);
            await removeFileConfirmed(leasePath);
          } else {
            await removeDirectoryConfirmed(scratchRoot);
          }
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      } finally {
        try {
          await releaseProcessLock();
        } finally {
          releaseGate();
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Sandbox preparation failed and scratch cleanup was incomplete",
        );
      }
      throw error;
    }
  }
}
