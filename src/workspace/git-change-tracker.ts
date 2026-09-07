import { realpath } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { sha256 } from "../utils/hash.js";
import { WorkspacePathGuard } from "./path-guard.js";
import {
  captureWorkspaceSnapshotEntry,
  type SnapshotOptions,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotEntry,
} from "./snapshot.js";

const GIT_OPERATION_TIMEOUT_MS = 15_000;
const GIT_MAX_OUTPUT_BYTES = 100_000_000;
const DEFAULT_CAPTURE_CONCURRENCY = 32;
const MAX_CAPTURE_CONCURRENCY = 128;

// These are transient cache locations even when a repository forgot to add
// them to .gitignore. The filter applies only to untracked paths: a tracked
// file remains source-controlled project state and must still be audited.
const TRANSIENT_UNTRACKED_SEGMENTS = new Set([
  ".cache",
  ".easy-code-srt-runtime",
  ".gradle",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pytest_cache",
  ".ruff_cache",
  ".svelte-kit",
  ".turbo",
  ".tox",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

export interface GitWorkspaceDescriptor {
  readonly repositoryRoot: string;
}

export interface GitCommandChangeBaseline {
  readonly kind: "git";
  readonly capturedAt: string;
  readonly head?: string;
  /** Actual bytes for paths already dirty/untracked before the command. */
  readonly files: ReadonlyMap<string, WorkspaceSnapshotEntry | undefined>;
  /** Last verified full state, used for clean tracked files without re-hashing. */
  readonly knownFiles: ReadonlyMap<string, WorkspaceSnapshotEntry>;
  readonly truncated: boolean;
}

export interface GitCommandComparison {
  readonly before: WorkspaceSnapshot;
  readonly after: WorkspaceSnapshot;
}

interface GitCandidateState {
  readonly head?: string;
  readonly tracked: Set<string>;
  readonly untracked: Set<string>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Git workspace change tracking was canceled");
  error.name = "AbortError";
  throw error;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
  ]) {
    delete environment[key];
  }
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_") ||
      key === "GIT_CONFIG_COUNT"
    ) {
      delete environment[key];
    }
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

function gitArguments(args: readonly string[]): string[] {
  return [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    ...args,
  ];
}

async function gitText(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const result = await execa("git", gitArguments(args), {
    cwd,
    env: gitEnvironment(),
    extendEnv: false,
    reject: false,
    timeout: GIT_OPERATION_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT_BYTES,
    signal,
  });
  throwIfAborted(signal);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 2_000);
    throw new Error(
      `Git workspace query failed (${String(result.exitCode)}): ${detail || args.join(" ")}`,
    );
  }
  return result.stdout;
}

async function gitBuffer(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfAborted(signal);
  const result = await execa("git", gitArguments(args), {
    cwd,
    env: gitEnvironment(),
    extendEnv: false,
    reject: false,
    timeout: GIT_OPERATION_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT_BYTES,
    signal,
    encoding: "buffer",
  });
  throwIfAborted(signal);
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8").trim().slice(0, 2_000);
    throw new Error(
      `Git workspace query failed (${String(result.exitCode)}): ${detail || args.join(" ")}`,
    );
  }
  return result.stdout;
}

async function gitExitCode(cwd: string, args: readonly string[]): Promise<number> {
  const result = await execa("git", gitArguments(args), {
    cwd,
    env: gitEnvironment(),
    extendEnv: false,
    reject: false,
    timeout: GIT_OPERATION_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT_BYTES,
  });
  return result.exitCode ?? 1;
}

async function currentHead(
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return (await gitText(cwd, ["rev-parse", "--verify", "-q", "HEAD"], signal)).trim() ||
      undefined;
  } catch (error) {
    throwIfAborted(signal);
    // An unborn repository has no HEAD commit. Confirm that Git still regards
    // the directory as a working tree before accepting that expected state.
    const inside = (await gitText(cwd, ["rev-parse", "--is-inside-work-tree"], signal)).trim();
    if (inside === "true") return undefined;
    throw error;
  }
}

function nulPaths(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function normalizeGitPath(
  guard: WorkspacePathGuard,
  filename: string,
): string | undefined {
  try {
    return guard.normalizeRelative(filename);
  } catch {
    // Git permits control characters and Runtime-reserved paths that file tools
    // intentionally cannot address. Do not let those paths escape the normal
    // workspace boundary through incremental tracking.
    return undefined;
  }
}

function isTransientUntrackedPath(
  filename: string,
  options: SnapshotOptions,
): boolean {
  const configured = new Set(
    [...(options.ignoredDirectoryNames ?? [])].map((entry) => entry.toLowerCase()),
  );
  const lowerFilename = filename.toLowerCase();
  if (lowerFilename.endsWith(".pyc") || lowerFilename.endsWith(".pyo")) return true;
  return filename.split("/").some((segment) => {
    const normalized = segment.toLowerCase();
    return TRANSIENT_UNTRACKED_SEGMENTS.has(normalized) || configured.has(normalized);
  });
}

function normalizedPathSet(
  guard: WorkspacePathGuard,
  values: readonly string[],
  options: SnapshotOptions,
  untracked: boolean,
): Set<string> {
  const paths = new Set<string>();
  for (const value of values) {
    const normalized = normalizeGitPath(guard, value);
    if (!normalized || (untracked && isTransientUntrackedPath(normalized, options))) continue;
    paths.add(normalized);
  }
  return paths;
}

async function ignoredUntrackedPaths(
  guard: WorkspacePathGuard,
  options: SnapshotOptions,
  signal?: AbortSignal,
): Promise<Set<string>> {
  // Ask Git for collapsed ignored roots first. This prevents a forgotten
  // node_modules/build exclusion from expanding into hundreds of thousands of
  // paths merely so Runtime can discard them afterwards.
  const collapsed = nulPaths(await gitText(
    guard.root,
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
      "--",
      ".",
    ],
    signal,
  ));
  const files = new Set<string>();
  const directories: string[] = [];
  for (const value of collapsed) {
    const directory = value.endsWith("/");
    const normalized = normalizeGitPath(
      guard,
      directory ? value.slice(0, -1) : value,
    );
    if (!normalized || isTransientUntrackedPath(normalized, options)) continue;
    if (directory) directories.push(normalized);
    else files.add(normalized);
  }

  // Expand only ignored directories that survived the explicit transient
  // filter. Direct ignored files such as .env/local config are already known.
  const pathspecBatchSize = 128;
  for (let offset = 0; offset < directories.length; offset += pathspecBatchSize) {
    throwIfAborted(signal);
    const pathspecs = directories
      .slice(offset, offset + pathspecBatchSize)
      .map((directory) => `:(literal)${directory}`);
    const expanded = await gitText(
      guard.root,
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--no-directory",
        "-z",
        "--",
        ...pathspecs,
      ],
      signal,
    );
    for (const filename of normalizedPathSet(
      guard,
      nulPaths(expanded),
      options,
      true,
    )) {
      files.add(filename);
    }
  }
  return files;
}

async function candidateState(
  descriptor: GitWorkspaceDescriptor,
  guard: WorkspacePathGuard,
  options: SnapshotOptions,
  signal?: AbortSignal,
): Promise<GitCandidateState> {
  const [head, working, staged, untracked, ignored] = await Promise.all([
    currentHead(descriptor.repositoryRoot, signal),
    gitText(
      guard.root,
      ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--relative", "--", "."],
      signal,
    ),
    gitText(
      guard.root,
      [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-renames",
        "--name-only",
        "-z",
        "--relative",
        "--",
        ".",
      ],
      signal,
    ),
    gitText(
      guard.root,
      ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
      signal,
    ),
    ignoredUntrackedPaths(guard, options, signal),
  ]);
  const tracked = normalizedPathSet(
    guard,
    [...nulPaths(working), ...nulPaths(staged)],
    options,
    false,
  );
  return {
    head,
    tracked,
    untracked: new Set([
      ...normalizedPathSet(guard, nulPaths(untracked), options, true),
      ...ignored,
    ]),
  };
}

function boundedPaths(
  paths: ReadonlySet<string>,
  options: SnapshotOptions,
): { paths: string[]; truncated: boolean } {
  const ordered = [...paths].sort((left, right) => left.localeCompare(right));
  const maxFiles = Math.max(0, options.maxFiles ?? 20_000);
  return {
    paths: ordered.slice(0, maxFiles),
    truncated: ordered.length > maxFiles,
  };
}

async function capturePaths(
  guard: WorkspacePathGuard,
  filenames: readonly string[],
  options: SnapshotOptions,
  signal?: AbortSignal,
): Promise<Map<string, WorkspaceSnapshotEntry | undefined>> {
  const requested = options.ioConcurrency ?? DEFAULT_CAPTURE_CONCURRENCY;
  const concurrency = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_CAPTURE_CONCURRENCY, Math.trunc(requested)))
    : DEFAULT_CAPTURE_CONCURRENCY;
  const captured = new Map<string, WorkspaceSnapshotEntry | undefined>();
  for (let offset = 0; offset < filenames.length; offset += concurrency) {
    throwIfAborted(signal);
    const batch = filenames.slice(offset, offset + concurrency);
    const entries = await Promise.all(
      batch.map((filename) => captureWorkspaceSnapshotEntry(guard, filename, signal)),
    );
    for (let index = 0; index < batch.length; index += 1) {
      captured.set(batch[index]!, entries[index]);
    }
  }
  return captured;
}

async function headChangedPaths(
  descriptor: GitWorkspaceDescriptor,
  guard: WorkspacePathGuard,
  before: string | undefined,
  after: string | undefined,
  options: SnapshotOptions,
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (before === after) return new Set();
  let output: string;
  if (before && after) {
    output = await gitText(
      guard.root,
      [
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--name-only",
        "-z",
        "--relative",
        before,
        after,
        "--",
        ".",
      ],
      signal,
    );
  } else {
    output = await gitText(
      guard.root,
      ["ls-tree", "-r", "--name-only", "-z", before ?? after!, "--", "."],
      signal,
    );
  }
  return normalizedPathSet(guard, nulPaths(output), options, false);
}

async function revisionEntry(
  descriptor: GitWorkspaceDescriptor,
  guard: WorkspacePathGuard,
  revision: string,
  filename: string,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshotEntry | undefined> {
  const listing = await gitText(
    guard.root,
    ["ls-tree", "-z", "-l", revision, "--", `:(literal)${filename}`],
    signal,
  );
  const record = listing.split("\0").find(Boolean);
  if (!record) return undefined;
  const tab = record.indexOf("\t");
  if (tab < 0) throw new Error("Git tree entry has an invalid shape");
  const metadata = record.slice(0, tab).trim().split(/\s+/u);
  const mode = metadata[0];
  const type = metadata[1];
  const objectId = metadata[2];
  if (!mode || !type || !objectId) throw new Error("Git tree entry is incomplete");
  if (type === "commit" || mode === "160000") {
    return {
      path: filename,
      kind: "symlink",
      hash: sha256(`gitlink:${objectId}`),
      size: 0,
      mtimeMs: 0,
    };
  }
  if (type !== "blob") return undefined;
  const content = await gitBuffer(descriptor.repositoryRoot, ["cat-file", "blob", objectId], signal);
  if (mode === "120000") {
    const target = content.toString("utf8");
    return {
      path: filename,
      kind: "symlink",
      hash: sha256(`symlink:${target}`),
      size: content.length,
      mtimeMs: 0,
    };
  }
  return {
    path: filename,
    kind: "file",
    hash: sha256(content),
    size: content.length,
    mtimeMs: 0,
  };
}

export async function discoverGitWorkspace(
  guard: WorkspacePathGuard,
): Promise<GitWorkspaceDescriptor | undefined> {
  try {
    const inside = (await gitText(guard.root, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return undefined;
    const reportedRoot = (await gitText(guard.root, ["rev-parse", "--show-toplevel"])).trim();
    const repositoryRoot = path.normalize(await realpath(reportedRoot));
    const relative = path.relative(repositoryRoot, guard.root);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined;
    }
    // A temporary workspace can live underneath a larger repository while its
    // entire directory is ignored by that repository. Git will never report
    // changes inside such a root, so it must use the filesystem fallback.
    if (relative) {
      const repositoryRelative = relative.split(path.sep).join("/");
      const ignored = await gitExitCode(repositoryRoot, [
        "check-ignore",
        "--quiet",
        "--no-index",
        "--",
        repositoryRelative,
      ]);
      if (ignored === 0) return undefined;
      if (ignored !== 1) return undefined;
    }
    return { repositoryRoot };
  } catch {
    return undefined;
  }
}

export async function captureGitCommandBaseline(
  descriptor: GitWorkspaceDescriptor,
  guard: WorkspacePathGuard,
  knownFiles: ReadonlyMap<string, WorkspaceSnapshotEntry>,
  options: SnapshotOptions = {},
  signal?: AbortSignal,
): Promise<GitCommandChangeBaseline> {
  const state = await candidateState(descriptor, guard, options, signal);
  const candidates = new Set([...state.tracked, ...state.untracked]);
  const bounded = boundedPaths(candidates, options);
  return {
    kind: "git",
    capturedAt: new Date().toISOString(),
    ...(state.head ? { head: state.head } : {}),
    files: await capturePaths(guard, bounded.paths, options, signal),
    knownFiles,
    truncated: bounded.truncated,
  };
}

export async function compareGitCommandBaseline(
  descriptor: GitWorkspaceDescriptor,
  guard: WorkspacePathGuard,
  baseline: GitCommandChangeBaseline,
  options: SnapshotOptions = {},
  signal?: AbortSignal,
): Promise<GitCommandComparison> {
  const current = await candidateState(descriptor, guard, options, signal);
  const committed = await headChangedPaths(
    descriptor,
    guard,
    baseline.head,
    current.head,
    options,
    signal,
  );
  const candidates = new Set([
    ...baseline.files.keys(),
    ...current.tracked,
    ...current.untracked,
    ...committed,
  ]);
  const bounded = boundedPaths(candidates, options);
  const currentFiles = await capturePaths(guard, bounded.paths, options, signal);
  const beforeFiles = new Map<string, WorkspaceSnapshotEntry>();
  const afterFiles = new Map<string, WorkspaceSnapshotEntry>();

  for (const filename of bounded.paths) {
    let previous: WorkspaceSnapshotEntry | undefined;
    if (baseline.files.has(filename)) {
      previous = baseline.files.get(filename);
    } else {
      previous = baseline.knownFiles.get(filename);
      if (!previous && baseline.head) {
        previous = await revisionEntry(
          descriptor,
          guard,
          baseline.head,
          filename,
          signal,
        );
      }
    }
    if (previous) beforeFiles.set(filename, previous);
    const next = currentFiles.get(filename);
    if (next) afterFiles.set(filename, next);
  }

  const capturedAt = new Date().toISOString();
  const truncated = baseline.truncated || bounded.truncated;
  return {
    before: {
      capturedAt: baseline.capturedAt,
      files: beforeFiles,
      truncated,
    },
    after: {
      capturedAt,
      files: afterFiles,
      truncated,
    },
  };
}

/** Hash every Git-relevant path for startup/checkpoint/final consistency. */
export async function captureGitWorkspaceSnapshot(
  descriptor: GitWorkspaceDescriptor,
  guard: WorkspacePathGuard,
  options: SnapshotOptions = {},
  signal?: AbortSignal,
  previouslyVerifiedPaths: Iterable<string> = [],
): Promise<WorkspaceSnapshot> {
  // The descriptor is deliberately used even though both commands can run in
  // the workspace subdirectory: a failed repository query must trigger the
  // manager's filesystem fallback rather than return a partial snapshot.
  await gitText(descriptor.repositoryRoot, ["rev-parse", "--is-inside-work-tree"], signal);
  const [trackedOutput, untrackedOutput, ignored] = await Promise.all([
    gitText(guard.root, ["ls-files", "--cached", "-z", "--", "."], signal),
    gitText(
      guard.root,
      ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
      signal,
    ),
    ignoredUntrackedPaths(guard, options, signal),
  ]);
  const tracked = normalizedPathSet(guard, nulPaths(trackedOutput), options, false);
  const untracked = normalizedPathSet(guard, nulPaths(untrackedOutput), options, true);
  // A file tool can intentionally write a normally ignored/generated path.
  // Keep explicitly verified manifest entries in consistency scans so such a
  // file is not falsely reported as deleted merely because Git omits it.
  const verified = normalizedPathSet(guard, [...previouslyVerifiedPaths], options, false);
  const bounded = boundedPaths(
    new Set([...tracked, ...untracked, ...ignored, ...verified]),
    options,
  );
  const captured = await capturePaths(guard, bounded.paths, options, signal);
  const files = new Map<string, WorkspaceSnapshotEntry>();
  for (const filename of bounded.paths) {
    const entry = captured.get(filename);
    if (entry) files.set(filename, entry);
  }
  return {
    capturedAt: new Date().toISOString(),
    files,
    truncated: bounded.truncated,
  };
}
