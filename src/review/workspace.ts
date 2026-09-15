import path from "node:path";
import os from "node:os";
import { mkdir, readFile, writeFile, lstat, readlink, realpath, symlink } from "node:fs/promises";
import { execa } from "execa";
import { WorkspaceManager } from "../workspace/manager.js";
import type { WorkspaceSnapshot, WorkspaceSnapshotEntry } from "../workspace/snapshot.js";
import { sha256 } from "../utils/hash.js";
import type { ValidationBaseline } from "../progress/validation-standard.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";

export function reviewFingerprint(snapshot: WorkspaceSnapshot): string {
  if (snapshot.truncated) throw new Error("Incomplete workspace inventory; review cannot certify this snapshot");
  return `sha256:${sha256(JSON.stringify({ files: [...snapshot.files.values()]
    .map(entry => [entry.path, entry.kind, entry.hash, entry.size]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }))}`;
}

const REVIEW_DEPENDENCY_DIRECTORIES = ["node_modules", ".venv", "venv"] as const;
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function reviewPathKey(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function readSnapshotEntry(
  workspace: WorkspaceManager,
  entry: WorkspaceSnapshotEntry,
  changedPaths: ReadonlySet<string>,
): Promise<{ content: Buffer; mode: number; materializedSymlink: boolean }> {
  if (entry.kind === "file") {
    const source = await workspace.pathGuard.resolveExisting(entry.path, { kind: "file" });
    const content = await readFile(source);
    if (sha256(content) !== entry.hash) throw new Error("Source changed while copying review snapshot");
    return { content, mode: (await lstat(source)).mode & 0o111 ? 0o700 : 0o600, materializedSymlink: false };
  }

  if (changedPaths.has(reviewPathKey(entry.path))) {
    throw new Error(`Changed symbolic links cannot enter a review snapshot: ${entry.path}`);
  }
  const lexical = workspace.pathGuard.resolveLexical(entry.path);
  const canonicalParent = path.normalize(await realpath(path.dirname(lexical)));
  workspace.pathGuard.assertInside(canonicalParent);
  const linkPath = path.join(canonicalParent, path.basename(lexical));
  const linkInfo = await lstat(linkPath);
  if (!linkInfo.isSymbolicLink()) throw new Error(`Review snapshot link changed type: ${entry.path}`);
  const linkTarget = await readlink(linkPath);
  if (sha256(`symlink:${linkTarget}`) !== entry.hash) throw new Error(`Review snapshot link changed: ${entry.path}`);
  if (path.isAbsolute(linkTarget) || /^[a-zA-Z]:[\\/]/u.test(linkTarget) || /^(?:\\\\|\/\/)/u.test(linkTarget)) {
    throw new Error(`Review snapshot link must use a relative workspace target: ${entry.path}`);
  }
  const target = path.resolve(canonicalParent, linkTarget);
  workspace.pathGuard.assertInside(target);
  const canonicalTarget = path.normalize(await realpath(target));
  workspace.pathGuard.assertInside(canonicalTarget);
  const targetInfo = await lstat(canonicalTarget);
  if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
    throw new Error(`Review snapshot link must resolve to an internal regular file: ${entry.path}`);
  }
  return {
    content: await readFile(canonicalTarget),
    mode: targetInfo.mode & 0o111 ? 0o700 : 0o600,
    materializedSymlink: true,
  };
}

/** No shared checkout and no git control files. Explicit temporary copies are
 * retained for recovery; never use a model-selected path or silently recopy a
 * modified experiment as the original baseline. */
export async function createReviewCopies(workspace: WorkspaceManager, id: string, expected: string,
  maxBytes = 128 * 1024 * 1024, validationBaseline?: ValidationBaseline,
  options: { readBaseline?: (hash: string) => Promise<Buffer | undefined>; limits?: Readonly<RuntimeLimits>; signal?: AbortSignal;
    offline?: boolean; changedPaths?: readonly string[] } = {}) {
  if (!/^review_[a-f0-9-]{36}$/u.test(id)) throw new Error("Invalid Runtime review identity");
  const snapshot = await workspace.captureSnapshot();
  if (reviewFingerprint(snapshot) !== expected) throw new Error("Workspace changed before review snapshot");
  const directory = path.join(await realpath(os.tmpdir()), `easy-code-${id}`);
  await mkdir(directory, { mode: 0o700 }); // EEXIST is not permission to trust old content.
  const roots = { author: path.join(directory, "author"), reviewer: path.join(directory, "reviewer") };
  await Promise.all(Object.values(roots).map(root => mkdir(root, { mode: 0o700 })));
  let bytes = 0;
  const restoredTests: string[] = [];
  const materializedSymlinks: string[] = [];
  const changedPaths = new Set((options.changedPaths ?? []).map(reviewPathKey));
  const baselines = { author: {} as Record<string, string>, reviewer: {} as Record<string, string> };
  for (const entry of snapshot.files.values()) {
    const { content, mode, materializedSymlink } = await readSnapshotEntry(workspace, entry, changedPaths);
    if (materializedSymlink) materializedSymlinks.push(entry.path);
    bytes += content.byteLength;
    if (bytes > maxBytes) throw new Error("Review snapshot exceeds configured copy budget");
    let originalTest: Buffer | undefined;
    const gitPath = entry.path.replace(/\\/gu, "/");
    const originalHash = entry.kind === "file" ? validationBaseline?.files.find(file => file.path === gitPath)?.hash : undefined;
    if (originalHash && originalHash !== entry.hash) {
      originalTest = await options.readBaseline?.(originalHash);
      if (originalTest && sha256(originalTest) !== originalHash) throw new Error("Invalid archived test baseline");
      if (!originalTest) {
      const prior = await execa("git", ["show", `HEAD:${gitPath}`], { cwd: workspace.root, encoding: "buffer",
        stripFinalNewline: false, reject: false, timeout: 20000, maxBuffer: maxBytes });
      if (prior.exitCode === 0 && sha256(prior.stdout) === originalHash) {
        originalTest = prior.stdout;
      }
      }
      if (originalTest) restoredTests.push(entry.path);
    }
    for (const who of ["author", "reviewer"] as const) {
      const root = roots[who];
      const target = path.resolve(root, entry.path);
      const relative = path.relative(root, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid snapshot path");
      await mkdir(path.dirname(target), { recursive: true });
      const copy = who === "reviewer" && originalTest ? originalTest : content;
      await writeFile(target, copy, { flag: "wx", mode });
      baselines[who][entry.path] = sha256(copy);
    }
  }
  // Deleted tests also need their real pre-agent bytes, including dirty/non-Git baselines.
  for (const file of validationBaseline?.files ?? []) if (!Object.keys(baselines.reviewer).some(p => p.replace(/\\/gu, "/") === file.path)) {
    const content = await options.readBaseline?.(file.hash);
    if (!content || sha256(content) !== file.hash) continue;
    const target = path.resolve(roots.reviewer, file.path);
    if (path.relative(roots.reviewer, target).startsWith("..")) throw new Error("Invalid baseline path");
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content, { flag: "wx", mode: 0o600 });
    baselines.reviewer[path.normalize(file.path)] = file.hash; restoredTests.push(file.path);
  }
  // Keep large dependency trees out of the source copy. Native sandbox path
  // resolution prevents writes through these links to the original workspace;
  // they exist only so independent tests can use the already installed toolchain.
  const dependencyLinks = { author: {} as Record<string, string>, reviewer: {} as Record<string, string> };
  if (!options.offline) for (const name of REVIEW_DEPENDENCY_DIRECTORIES) {
    const source = path.join(workspace.root, name);
    let target: string;
    try {
      if (!(await lstat(source)).isDirectory()) continue;
      target = await realpath(source);
    } catch { continue; }
    if (!isInside(workspace.root, target)) throw new Error(`Review dependency leaves the workspace: ${name}`);
    for (const who of ["author", "reviewer"] as const) {
      await symlink(target, path.join(roots[who], name), process.platform === "win32" ? "junction" : "dir");
      dependencyLinks[who][name] = target;
    }
  }
  if (reviewFingerprint(await workspace.captureSnapshot()) !== expected) throw new Error("Workspace changed during review copy");
  await writeFile(path.join(directory, "binding.json"), JSON.stringify({ id, snapshotId: expected, roots, baselines,
    restoredTests, materializedSymlinks, dependencyLinks }), { flag: "wx", mode: 0o600 });
  return { directory, roots, baselines, restoredTests, materializedSymlinks, dependencyLinks };
}

export async function restoreReviewCopies(directory: string, id: string, snapshotId: string) {
  const expected = path.join(await realpath(os.tmpdir()), `easy-code-${id}`);
  if (path.resolve(directory) !== expected || (await lstat(directory)).isSymbolicLink()) throw new Error("Invalid review directory");
  const binding = JSON.parse(await readFile(path.join(directory, "binding.json"), "utf8"));
  if (binding.id !== id || binding.snapshotId !== snapshotId) throw new Error("Review snapshot binding mismatch");
  const roots = { author: path.join(directory, "author"), reviewer: path.join(directory, "reviewer") };
  for (const root of Object.values(roots)) if (await realpath(root) !== root) throw new Error("Redirected review copy");
  if (!binding.baselines?.author || !binding.baselines?.reviewer || !Array.isArray(binding.restoredTests) ||
    !Array.isArray(binding.materializedSymlinks)) throw new Error("Missing review baseline manifest");
  const dependencyLinks = (binding.dependencyLinks ?? { author: {}, reviewer: {} }) as Record<"author" | "reviewer", Record<string, string>>;
  for (const who of ["author", "reviewer"] as const) for (const [name, expected] of Object.entries(dependencyLinks[who] ?? {})) {
    if (!REVIEW_DEPENDENCY_DIRECTORIES.includes(name as typeof REVIEW_DEPENDENCY_DIRECTORIES[number]) ||
      !path.isAbsolute(expected) || await realpath(path.join(roots[who], name)) !== expected)
      throw new Error("Review dependency binding mismatch");
  }
  return { directory, roots, baselines: binding.baselines as Record<"author" | "reviewer", Record<string, string>>,
    restoredTests: binding.restoredTests as string[], materializedSymlinks: binding.materializedSymlinks as string[], dependencyLinks };
}

export async function reviewDiff(workspace: WorkspaceManager): Promise<string> {
  const result = await execa("git", ["-c", "diff.external=", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
    { cwd: workspace.root, reject: false, timeout: 20000, maxBuffer: 16 * 1024 * 1024,
      env: { GIT_EXTERNAL_DIFF: undefined, GIT_DIFF_OPTS: undefined } });
  return result.exitCode === 0 ? result.stdout : "Diff unavailable (not a valid Git baseline). Read the supplied snapshot and recorded changes; do not assume an empty diff.";
}
