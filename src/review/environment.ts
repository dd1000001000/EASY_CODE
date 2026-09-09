import path from "node:path";
import { lstat, readdir, realpath, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { sha256 } from "../utils/hash.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";

const dependencyNames = ["node_modules", ".venv", "venv", "dist", "build"];
/** Explicit dependencies, not a writable link back to the original checkout. */
export async function copyReviewDependencies(source: string, roots: string[], limits: Readonly<RuntimeLimits>, signal?: AbortSignal) {
  const hashes: Record<string, string> = {};
  let bytes = 0, files = 0;
  const deadline = Date.now() + limits.reviewPreparationTimeoutMs;
  const visit = async (relative: string, ancestors: Set<string>) => {
    signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error("Review dependency preparation timed out");
    const origin = path.join(source, relative), info = await lstat(origin), resolved = await realpath(origin);
    const local = path.relative(source, resolved);
    // Venv interpreter links may resolve to a system interpreter, but arbitrary
    // external packages/credentials are never imported into the review copy.
    const systemPython = info.isSymbolicLink() && /(?:^|[/\\])(?:bin|Scripts)[/\\]python(?:[\d.]*)?(?:\.exe)?$/iu.test(relative) &&
      /^\/(?:usr\/bin|usr\/local\/bin)\/python[\d.]*$/u.test(resolved);
    if ((local.startsWith("..") || path.isAbsolute(local)) && !systemPython) throw new Error(`Dependency escapes workspace: ${relative}`);
    const stat = await lstat(resolved);
    if (info.isSymbolicLink() && !systemPython) {
      if (++files > limits.reviewDependencyMaxFiles) throw new Error("Review dependencies exceed configured preparation budget");
      hashes[relative] = sha256(`link:${local}`);
      // npm .bin scripts depend on their real module location; flattening a
      // symlink changes require('../...') semantics. Bind it inside EACH copy.
      for (const root of roots) {
        const target = path.join(root, relative), destination = path.join(root, local);
        await mkdir(path.dirname(target), { recursive: true });
        const link = process.platform === "win32" && stat.isDirectory() ? destination : path.relative(path.dirname(target), destination);
        await symlink(link, target, stat.isDirectory() ? process.platform === "win32" ? "junction" : "dir" : "file");
      }
      return;
    }
    if (stat.isDirectory()) {
      if (ancestors.has(resolved)) throw new Error(`Cyclic dependency link: ${relative}`);
      const next = new Set(ancestors).add(resolved);
      for (const entry of await readdir(origin)) {
        if ([".git", ".easycode", ".easy_code"].includes(entry)) continue;
        await visit(path.join(relative, entry), next);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported dependency file: ${relative}`);
    if (++files > limits.reviewDependencyMaxFiles || (bytes += stat.size) > limits.reviewDependencyMaxBytes)
      throw new Error("Review dependencies exceed configured preparation budget");
    const content = await readFile(origin); hashes[relative] = sha256(content);
    for (const root of roots) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      try { await writeFile(target, content, { flag: "wx", mode: stat.mode & 0o111 ? 0o700 : 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || sha256(await readFile(target)) !== hashes[relative]) throw error; }
    }
  };
  for (const name of dependencyNames) {
    try { await lstat(path.join(source, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    await visit(name, new Set());
  }
  return hashes;
}

export async function dependenciesUnchanged(root: string, hashes: Record<string, string>, limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS): Promise<boolean> {
  try {
    const current = await copyReviewDependencies(root, [], limits);
    return Object.keys(current).length === Object.keys(hashes).length && Object.entries(hashes).every(([name, hash]) => current[name] === hash);
  } catch { return false; }
}
