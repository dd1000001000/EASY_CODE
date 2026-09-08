import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256 } from "../utils/hash.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { WorkspacePathGuard } from "../workspace/path-guard.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const validationBaselineSchema = z.object({
  version: z.literal(1), complete: z.boolean(), digest: hash,
  files: z.array(z.object({ path: z.string().min(1).max(1024), hash }).strict()).max(16000),
}).strict().superRefine((value, context) => {
  if (value.digest !== sha256(JSON.stringify([value.complete, value.files])) ||
      value.files.some((file, i) => file.path.includes("\\") || file.path.startsWith("/") ||
        file.path.split("/").includes("..") || i > 0 && value.files[i - 1]!.path >= file.path)) {
    context.addIssue({ code: "custom", message: "Invalid validation baseline identity" });
  }
});
export type ValidationBaseline = z.infer<typeof validationBaselineSchema>;
const ignored = new Set([".git", ".easycode", ".easy_code", ".easy-code-srt-runtime", "node_modules", ".venv", "venv", ".tox", "__pycache__", ".pytest_cache", ".mypy_cache", "site-packages", "dist", "dist-test", ".cache", "cache"]);
function configFile(name: string): boolean {
  return /^(?:conftest\.py|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|package\.json|(?:jest|vitest|playwright)\.config\.[^.]+|(?:run)?tests?\.[^.]+|manage\.py|Makefile)$/iu.test(name);
}
function relevant(name: string): boolean {
  return configFile(path.posix.basename(name)) || /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|$)/iu.test(name) ||
    /(?:^|\/)(?:test_.+|.+_test)\.py$/iu.test(name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(name);
}

/** Bounded read-only inventory, captured before agent mutations. A partial scan
 * can never certify an unchanged testing standard. It is not a sandbox proof. */
export async function captureValidationBaseline(root: string, limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS): Promise<ValidationBaseline> {
  const files: ValidationBaseline["files"] = [];
  let guard: WorkspacePathGuard;
  try { guard = new WorkspacePathGuard(root); }
  catch { return { version: 1, complete: false, files, digest: sha256(JSON.stringify([false, files])) }; }
  let complete = true, entries = 0, bytes = 0;
  const pending = [""];
  while (pending.length && entries < limits.validationScanMaxEntries) {
    const dir = pending.pop()!;
    let children;
    try { children = await readdir(dir ? await guard.resolveExisting(dir, { kind: "directory", allowFinalSymlink: false }) : guard.root, { withFileTypes: true }); }
    catch { complete = false; continue; }
    for (const child of children) {
      if (++entries > limits.validationScanMaxEntries) { complete = false; break; }
      if (ignored.has(child.name) || child.name.startsWith(".easy-code-")) continue;
      const relative = dir ? `${dir}/${child.name}` : child.name;
      if (relative.length > 1024 || /[\x00-\x1f\x7f]/u.test(relative)) { complete = false; continue; }
      if (child.isSymbolicLink()) { complete = false; continue; }
      if (child.isDirectory()) { pending.push(relative); continue; }
      if (!child.isFile() || !relevant(relative)) continue;
      if (files.length >= limits.validationBaselineMaxFiles) { complete = false; continue; }
      try {
        const filename = await guard.resolveExisting(relative, { kind: "file", allowFinalSymlink: false });
        const before = await lstat(filename);
        if (!before.isFile() || bytes + before.size > limits.validationScanMaxBytes) { complete = false; continue; }
        bytes += before.size;
        const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) { complete = false; continue; }
          const buffer = Buffer.alloc(before.size);
          let read = 0;
          while (read < buffer.length) {
            const next = await handle.read(buffer, read, buffer.length - read, read);
            if (!next.bytesRead) break;
            read += next.bytesRead;
          }
          const after = await handle.stat();
          if (read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) { complete = false; continue; }
          files.push({ path: relative, hash: sha256(buffer) });
        } finally { await handle.close(); }
      } catch { complete = false; }
    }
  }
  if (pending.length) complete = false;
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { version: 1, complete, files, digest: sha256(JSON.stringify([complete, files])) };
}

export function compareValidationBaseline(baseline: ValidationBaseline, before: ValidationBaseline, after: ValidationBaseline) {
  const pre = new Map(before.files.map(file => [file.path, file.hash]));
  const post = new Map(after.files.map(file => [file.path, file.hash]));
  const original = new Map(baseline.files.map(file => [file.path, file.hash]));
  const changed = new Set(baseline.files.filter(file =>
    (pre.has(file.path) || before.complete) && pre.get(file.path) !== file.hash ||
    (post.has(file.path) || after.complete) && post.get(file.path) !== file.hash).map(file => file.path));
  // Adding tests is allowed. Adding a configuration that changes collection is not comparable.
  for (const file of [...before.files, ...after.files]) if (!original.has(file.path) && configFile(path.posix.basename(file.path))) changed.add(file.path);
  return { status: changed.size ? "changed" as const : baseline.complete && before.complete && after.complete ? "unchanged" as const : "unknown" as const,
    baselineDigest: baseline.digest, changedPaths: [...changed].sort().slice(0, 32) };
}
