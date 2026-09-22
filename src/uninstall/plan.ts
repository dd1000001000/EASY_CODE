import { existsSync, lstatSync } from "node:fs";
import { lstat, readdir, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertPlainAncestors,
  readOwnedResources,
  type OwnedResource,
} from "../install/ownership.js";
import { readJson } from "../install/metadata.js";

export { readJson } from "../install/metadata.js";

export interface UninstallAction {
  id: string;
  phase: number;
  target: string;
  description: string;
  /** Internal scope token covered by the command's single confirmation. */
  confirmation?: string;
  execute(): Promise<void>;
}

export interface UninstallPlan {
  actions: UninstallAction[];
  warnings: string[];
  blockers: string[];
  roots: { data: string[]; config: string[]; cache: string[] };
  resources: OwnedResource[];
  home: string;
}

export interface PlanOptions {
  home?: string;
  /** Explicit current roots are used by tests and recovery tooling only. */
  paths?: { data: string; config: string; cache: string };
  resources?: OwnedResource[];
}

export function identity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function inside(root: string, target: string): boolean {
  const relative = path.relative(identity(root), identity(target));
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function children(directory: string): Promise<string[]> {
  assertPlainAncestors(directory);
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function requireSafeTarget(target: string, home: string): void {
  const resolved = identity(target);
  if ([path.parse(resolved).root, identity(home), identity(process.cwd())].includes(resolved)) {
    throw new Error(`Refusing broad/project-root deletion: ${target}`);
  }
  assertPlainAncestors(path.dirname(target));
}

/** Remove exactly the object inspected during preview; leaf links are unlinked. */
export async function removeOwnedPath(
  target: string,
  home: string,
  expected: { dev: number; ino: number },
): Promise<void> {
  requireSafeTarget(target, home);
  let current;
  try {
    current = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`Target changed since preview: ${target}`);
  }
  if (current.isSymbolicLink()) await unlink(target);
  else await rm(target, { recursive: current.isDirectory(), force: false });
}

export async function addPath(
  plan: UninstallPlan,
  target: string,
  phase = 60,
  description = "Permanently delete EASY CODE data",
): Promise<void> {
  const resolved = path.resolve(target);
  if (plan.actions.some((item) => item.id === `path:${identity(resolved)}`)) return;
  requireSafeTarget(resolved, plan.home);
  let stat;
  try {
    stat = await lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  plan.actions.push({
    id: `path:${identity(resolved)}`,
    phase,
    target: resolved,
    description,
    execute: () => removeOwnedPath(resolved, plan.home, stat),
  });
}

function uniqueAbsoluteRoots(resources: readonly OwnedResource[], kind: "data" | "config" | "cache"): string[] {
  const roots = resources
    .filter((resource) => resource.kind === kind && resource.state !== "removed")
    .map((resource) => resource.path)
    .filter((value): value is string => typeof value === "string" && path.isAbsolute(value));
  return [...new Map(roots.map((root) => [identity(root), path.resolve(root)])).values()];
}

function filesystemIdentity(target: string): string | undefined {
  if (!existsSync(target)) return undefined;
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return undefined;
  return `fs:${stat.dev}:${stat.ino}`;
}

interface OwnedRootCandidate {
  readonly root: string;
  readonly kind: "data" | "config" | "cache";
}

/**
 * Delete an owned ancestor once instead of scheduling stale descendant actions.
 * Every candidate is identity-checked before this collapse grants authority.
 */
function minimalDeletionRoots(
  candidates: readonly OwnedRootCandidate[],
): OwnedRootCandidate[] {
  const ordered = [...candidates].sort((left, right) =>
    left.root.length - right.root.length || identity(left.root).localeCompare(identity(right.root)));
  const selected: OwnedRootCandidate[] = [];
  for (const candidate of ordered) {
    if (selected.some((parent) =>
      identity(parent.root) === identity(candidate.root) || inside(parent.root, candidate.root))) continue;
    selected.push(candidate);
  }
  return selected;
}

/** Build an uninstall plan exclusively from the current installation manifest. */
export async function buildFilePlan(options: PlanOptions = {}): Promise<UninstallPlan> {
  const home = path.resolve(options.home ?? os.homedir());
  const plan: UninstallPlan = {
    home,
    actions: [],
    warnings: [],
    blockers: [],
    roots: { data: [], config: [], cache: [] },
    resources: [],
  };
  try {
    plan.resources = options.resources ?? readOwnedResources(home);
  } catch (error) {
    plan.blockers.push(`Installation manifest: ${String(error)}`);
    return plan;
  }

  const candidates: OwnedRootCandidate[] = [];
  for (const kind of ["data", "config", "cache"] as const) {
    const explicit = options.paths?.[kind];
    plan.roots[kind] = explicit
      ? [path.resolve(explicit)]
      : uniqueAbsoluteRoots(plan.resources, kind);
    for (const root of plan.roots[kind]) {
      try {
        const receipt = plan.resources.find(resource => resource.kind === kind &&
          resource.path && identity(resource.path) === identity(root));
        if (!options.paths && receipt?.state === "ready") {
          const currentIdentity = filesystemIdentity(root);
          // A previously owned path may already be absent after a partial or
          // interrupted installation/uninstall. There is nothing destructive
          // to authorize in that case. If an object exists, however, its
          // durable identity must still match the receipt exactly.
          if (currentIdentity !== undefined && receipt.identity !== currentIdentity) {
            throw new Error(`Installation resource identity does not match: ${root}`);
          }
        }
        candidates.push({ root, kind });
      } catch (error) {
        plan.blockers.push(String(error));
      }
    }
  }

  if (plan.blockers.length === 0) {
    for (const candidate of minimalDeletionRoots(candidates)) {
      await addPath(
        plan,
        candidate.root,
        candidate.kind === "config" ? 80 : 60,
        `Permanently delete EASY CODE ${candidate.kind}`,
      );
    }
  }

  if (!options.paths && plan.resources.length === 0 && existsSync(path.join(home, ".easy_code"))) {
    plan.blockers.push(
      "The current installation manifest is missing. Remove the unregistered development data manually or reinstall EASY CODE before uninstalling.",
    );
  }
  return plan;
}
