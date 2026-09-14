import { existsSync, lstatSync, readFileSync } from "node:fs";
import { lstat, readdir, readFile, realpath, rm, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import envPaths from "env-paths";
import { parse as parseToml } from "toml";
import { assertPlainAncestors, readOwnedResources, type OwnedResource } from "../install/ownership.js";
import { readJson } from "../install/metadata.js";
export { readJson } from "../install/metadata.js";

export interface UninstallAction {
  id: string; phase: number; target: string; description: string;
  /** Internal scope token covered by the CLI's single full-uninstall consent. */
  confirmation?: string;
  execute(): Promise<void>;
}
export interface UninstallPlan {
  actions: UninstallAction[]; warnings: string[]; blockers: string[];
  roots: { data: string[]; config: string[]; cache: string[] };
  resources: OwnedResource[]; home: string;
}
export interface PlanOptions {
  home?: string;
  paths?: { data: string; config: string; cache: string };
  env?: NodeJS.ProcessEnv;
  resources?: OwnedResource[];
  temporaryRoot?: string;
}
export function identity(p: string): string { const value = path.resolve(p); return process.platform === "win32" ? value.toLowerCase() : value; }
export function inside(root: string, target: string): boolean {
  const rel = path.relative(identity(root), identity(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}
export async function children(directory: string): Promise<string[]> {
  assertPlainAncestors(directory);
  try { return await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export function requireSafeTarget(target: string, home: string): void {
  const full = identity(target);
  if ([path.parse(full).root, identity(home), identity(process.cwd())].includes(full))
    throw new Error("Refusing broad/project-root deletion: " + target);
  assertPlainAncestors(path.dirname(target));
}
/** Leaf links are unlinked, never traversed. Ancestor links are always rejected. */
export async function removeOwnedPath(target: string, home: string, expected: { dev: number; ino: number }): Promise<void> {
  requireSafeTarget(target, home);
  let stat;
  try { stat = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("Target changed since preview: " + target);
  if (stat.isSymbolicLink()) await unlink(target);
  else await rm(target, { recursive: stat.isDirectory(), force: false });
}
export async function addPath(plan: UninstallPlan, target: string, phase = 60): Promise<void> {
  if (plan.actions.some(item => item.id === "path:" + identity(target))) return;
  requireSafeTarget(target, plan.home);
  let stat;
  try { stat = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  plan.actions.push({ id: "path:" + identity(target), phase, target, description: "Permanently delete EASY CODE data",
    execute: () => removeOwnedPath(target, plan.home, stat) });
}
const dataEntries = new Set(["threads", "artifacts", "attachments", "subagent-artifacts", "subagent-environments",
  "validation-baselines", "review-command-leases", "command-leases", "command-quarantine", "native-sandbox", "podman"]);
async function identifiedReviewCopy(directory: string, name: string): Promise<boolean> {
  try {
    const binding = await readJson(path.join(directory, "binding.json"));
    if (binding?.id !== name.slice("easy-code-".length) ||
      typeof binding.snapshotId !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(binding.snapshotId)) return false;
    const canonical = await realpath(directory);
    for (const role of ["author", "reviewer"] as const) {
      const root = binding.roots?.[role];
      if (typeof root !== "string" || !path.isAbsolute(root)) return false;
      // Normalize Windows 8.3 aliases, but never accept redirected review roots.
      assertPlainAncestors(root);
      if (!(await lstat(root)).isDirectory() ||
        identity(await realpath(root)) !== identity(path.join(canonical, role))) return false;
    }
    return true;
  } catch { return false; }
}
export async function buildFilePlan(options: PlanOptions = {}): Promise<UninstallPlan> {
  const home = path.resolve(options.home ?? os.homedir());
  const paths = options.paths ?? envPaths("easy-code", { suffix: "" });
  const env = options.env ?? process.env;
  const plan: UninstallPlan = { home, actions: [], warnings: [], blockers: [], roots: { data: [], config: [], cache: [] }, resources: [] };
  try { plan.resources = options.resources ?? readOwnedResources(home); }
  catch (error) { plan.blockers.push(String(error)); }
  const recovery = path.join(home, ".easy-code-uninstall-state.json");
  if (existsSync(recovery)) {
    try { const previous = await readJson(recovery); if (previous.product === "easy-code-agent" && Array.isArray(previous.resources)) plan.resources.push(...previous.resources); }
    catch (error) { plan.blockers.push("Unreadable uninstall recovery state: " + String(error)); }
  }
  for (const kind of ["data", "config", "cache"] as const) {
    plan.roots[kind].push(path.resolve(paths[kind]));
    const override = env["EASY_CODE_" + kind.toUpperCase() + "_DIR"];
    if (override) plan.roots[kind].push(path.resolve(override));
    for (const record of plan.resources) if (record.kind === kind && record.path && path.isAbsolute(record.path)) plan.roots[kind].push(record.path);
  }
  // Only user configuration; a project's config never supplies uninstall targets.
  for (const directory of [...plan.roots.config]) {
    const file = path.join(directory, "config.toml");
    if (!existsSync(file)) continue;
    try {
      assertPlainAncestors(file);
      if (lstatSync(file).size > 1024 * 1024) throw new Error("oversized config");
      const config = parseToml(readFileSync(file, "utf8"));
      for (const kind of ["data", "config", "cache"] as const) {
        const value = config[kind + "_dir"] ?? config[kind + "Dir"] ?? config.paths?.[kind + "_dir"] ?? config.paths?.[kind + "Dir"];
        if (typeof value === "string" && path.isAbsolute(value)) plan.roots[kind].push(value);
      }
    } catch { plan.warnings.push("Cannot parse " + file + "; using registered/default locations, without initializing the Agent."); }
  }
  for (const kind of ["data", "config", "cache"] as const) {
    plan.roots[kind] = [...new Map(plan.roots[kind].map(p => [identity(p), p])).values()];
    for (const root of plan.roots[kind]) {
      try {
        requireSafeTarget(root, home);
        const entries = await children(root);
        if (!entries.length) continue;
        const isDefault = identity(root) === identity(paths[kind]);
        if (!isDefault && kind === "data") {
          const marker = await readJson(path.join(root, ".easy-code-data-root.json")).catch(() => undefined);
          if (marker?.product !== "easy-code-agent" || marker.formatVersion !== 1) {
            plan.blockers.push("Unverified custom data directory: " + root); continue;
          }
        }
        for (const name of entries) {
          if (name === "worktrees" || name === ".easy-code-data-root.json") continue;
          const known = kind === "data" ? dataEntries.has(name) || /^easy-code\.db(?:$|-(?:journal|shm|wal)$|\.lock$|\.easy-code-advisory-lock(?:$|\.(?:staging|release|stale)-[A-Za-z0-9_-]+$))/u.test(name)
            : kind === "config" ? ["config.toml", "artifact-catalog.json"].includes(name)
            : ["models", "approved-artifacts", "download-authorizations"].includes(name);
          if (known && kind === "cache" && name === "models" && !isDefault) {
            await addPath(plan, path.join(root, name, "paraphrase-multilingual-MiniLM-L12-v2"));
          } else if (known) await addPath(plan, path.join(root, name));
          else plan.warnings.push("Preserving unrecognized entry: " + path.join(root, name));
        }
        const stat = await lstat(root);
        plan.actions.push({ id: "empty:" + identity(root), phase: 70, target: root, description: "Remove empty EASY CODE directory",
          execute: async () => {
            assertPlainAncestors(root);
            if (!existsSync(root)) return;
            const now = await lstat(root); if (now.ino !== stat.ino || now.dev !== stat.dev) throw new Error("Root changed: " + root);
            const remaining = await children(root);
            if (remaining.length === 1 && remaining[0] === ".easy-code-data-root.json") await unlink(path.join(root, remaining[0]));
            try { await rmdir(root); } catch (error) { if (!["ENOTEMPTY", "ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
          } });
      } catch (error) { plan.blockers.push(String(error)); }
    }
  }
  for (const name of [".easy_code", ".easy-code"]) {
    try { await addPath(plan, path.join(home, name), 80); } catch (error) { plan.blockers.push(String(error)); }
  }
  // Fixed application temporary roots and fully identified legacy review copies.
  // No drive-wide glob or broad "easy-code*" deletion.
  try {
    const temporary = await realpath(options.temporaryRoot ?? os.tmpdir());
    const legacy = path.join(temporary, "easy-code-srt-runtime");
    if (existsSync(legacy)) {
      await addPath(plan, legacy);
      const action = plan.actions.find(a => a.target === legacy);
      if (action) action.confirmation = "legacy-temp:" + legacy;
    }
    for (const name of await children(temporary)) {
      if (!/^easy-code-review_[a-f0-9-]{36}$/u.test(name)) continue;
      const directory = path.join(temporary, name);
      if (!await identifiedReviewCopy(directory, name)) {
        plan.warnings.push("Preserving unidentified temporary review directory: " + directory); continue;
      }
      await addPath(plan, directory);
    }
  } catch (error) { plan.blockers.push("Temporary-resource inventory: " + String(error)); }
  return plan;
}
