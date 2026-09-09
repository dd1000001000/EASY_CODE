import path from "node:path";
import os from "node:os";
import { mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { execa } from "execa";
import { WorkspaceManager } from "../workspace/manager.js";
import type { WorkspaceSnapshot } from "../workspace/snapshot.js";
import { sha256 } from "../utils/hash.js";
import type { ValidationBaseline } from "../progress/validation-standard.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { copyReviewDependencies } from "./environment.js";

export function reviewFingerprint(snapshot: WorkspaceSnapshot): string {
  if (snapshot.truncated) throw new Error("Incomplete workspace inventory; review cannot certify this snapshot");
  return `sha256:${sha256(JSON.stringify({ files: [...snapshot.files.values()]
    .map(entry => [entry.path, entry.kind, entry.hash, entry.size]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }))}`;
}

/** No shared checkout and no git control files. Explicit temporary copies are
 * retained for recovery; never use a model-selected path or silently recopy a
 * modified experiment as the original baseline. */
export async function createReviewCopies(workspace: WorkspaceManager, id: string, expected: string,
  maxBytes = 128 * 1024 * 1024, validationBaseline?: ValidationBaseline,
  options: { readBaseline?: (hash: string) => Promise<Buffer | undefined>; limits?: Readonly<RuntimeLimits>; signal?: AbortSignal; offline?: boolean } = {}) {
  if (!/^review_[a-f0-9-]{36}$/u.test(id)) throw new Error("Invalid Runtime review identity");
  const snapshot = await workspace.captureSnapshot();
  if (reviewFingerprint(snapshot) !== expected) throw new Error("Workspace changed before review snapshot");
  const directory = path.join(await realpath(os.tmpdir()), `easy-code-${id}`);
  await mkdir(directory, { mode: 0o700 }); // EEXIST is not permission to trust old content.
  const roots = { author: path.join(directory, "author"), reviewer: path.join(directory, "reviewer") };
  await Promise.all(Object.values(roots).map(root => mkdir(root, { mode: 0o700 })));
  let bytes = 0;
  const restoredTests: string[] = [];
  const baselines = { author: {} as Record<string, string>, reviewer: {} as Record<string, string> };
  for (const entry of snapshot.files.values()) {
    if (entry.kind !== "file") throw new Error(`Review snapshot requires an ordinary file: ${entry.path}`);
    const source = await workspace.pathGuard.resolveExisting(entry.path);
    const content = await readFile(source);
    const mode = (await lstat(source)).mode & 0o111 ? 0o700 : 0o600;
    if (sha256(content) !== entry.hash) throw new Error("Source changed while copying review snapshot");
    bytes += content.byteLength;
    if (bytes > maxBytes) throw new Error("Review snapshot exceeds configured copy budget");
    let originalTest: Buffer | undefined;
    const gitPath = entry.path.replace(/\\/gu, "/");
    const originalHash = validationBaseline?.files.find(file => file.path === gitPath)?.hash;
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
  const dependencyHashes = options.offline ? {} : await copyReviewDependencies(workspace.root, Object.values(roots), options.limits ?? DEFAULT_RUNTIME_LIMITS, options.signal);
  if (reviewFingerprint(await workspace.captureSnapshot()) !== expected) throw new Error("Workspace changed during review copy");
  await writeFile(path.join(directory, "binding.json"), JSON.stringify({ id, snapshotId: expected, roots, baselines, restoredTests, dependencyHashes }), { flag: "wx", mode: 0o600 });
  return { directory, roots, baselines, restoredTests, dependencyHashes };
}

export async function restoreReviewCopies(directory: string, id: string, snapshotId: string) {
  const expected = path.join(await realpath(os.tmpdir()), `easy-code-${id}`);
  if (path.resolve(directory) !== expected || (await lstat(directory)).isSymbolicLink()) throw new Error("Invalid review directory");
  const binding = JSON.parse(await readFile(path.join(directory, "binding.json"), "utf8"));
  if (binding.id !== id || binding.snapshotId !== snapshotId) throw new Error("Review snapshot binding mismatch");
  const roots = { author: path.join(directory, "author"), reviewer: path.join(directory, "reviewer") };
  for (const root of Object.values(roots)) if (await realpath(root) !== root) throw new Error("Redirected review copy");
  if (!binding.baselines?.author || !binding.baselines?.reviewer || !Array.isArray(binding.restoredTests)) throw new Error("Missing review baseline manifest");
  return { directory, roots, baselines: binding.baselines as Record<"author" | "reviewer", Record<string, string>>,
    restoredTests: binding.restoredTests as string[], dependencyHashes: (binding.dependencyHashes ?? {}) as Record<string, string> };
}

export async function reviewDiff(workspace: WorkspaceManager): Promise<string> {
  const result = await execa("git", ["-c", "diff.external=", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
    { cwd: workspace.root, reject: false, timeout: 20000, maxBuffer: 16 * 1024 * 1024,
      env: { GIT_EXTERNAL_DIFF: undefined, GIT_DIFF_OPTS: undefined } });
  return result.exitCode === 0 ? result.stdout : "Diff unavailable (not a valid Git baseline). Read the supplied snapshot and recorded changes; do not assume an empty diff.";
}
