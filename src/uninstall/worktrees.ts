import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { assertPlainAncestors } from "../install/ownership.js";
import { CURRENT_PROTOCOL } from "../protocol/versions.js";
import { children, identity, inside, readJson, type UninstallPlan } from "./plan.js";
import { checked, runSystem, type SystemRunner } from "./system.js";

export async function addWorktrees(plan: UninstallPlan, run: SystemRunner = runSystem): Promise<void> {
  const samePath = (a: string, b: string): boolean => {
    const resolve = (value: string) => identity(existsSync(value) ? realpathSync.native(value) : value);
    return resolve(a) === resolve(b);
  };
  const seen = new Set<string>();
  for (const data of plan.roots.data) {
    for (const file of await children(path.join(data, "subagent-environments"))) {
      if (!file.endsWith(".json")) continue;
      try {
        const persisted = await readJson(path.join(data, "subagent-environments", file));
        const env = persisted.environment;
        if (persisted.schemaVersion !== CURRENT_PROTOCOL.worktreeDescriptor || !env || env.kind !== "worktree") continue;
        const root = env.worktreeRoot, repository = env.repositoryRoot;
        if (typeof root !== "string" || typeof repository !== "string" || !path.isAbsolute(root) || !path.isAbsolute(repository) ||
          identity(root) === identity(repository) || inside(root, repository) || inside(repository, root))
          throw new Error("Invalid worktree ownership metadata");
        if (typeof env.id !== "string" || !/^[A-Za-z0-9._-]{1,160}$/u.test(env.id)) throw new Error("Invalid environment ID");
        const hash = (value: string) => createHash("sha256").update(value).digest("hex");
        const repoIdentity = identity(repository).replace(/\\/gu, "/");
        const parent = path.basename(path.dirname(root));
        const child = path.basename(root);
        const compact = parent === "r-" + hash(repoIdentity).slice(0, 16) && child === "e-" + hash(env.id).slice(0, 20);
        if (!compact) throw new Error("Worktree path does not match the current Runtime layout: " + root);
        if (seen.has(identity(root))) continue; seen.add(identity(root));
        assertPlainAncestors(root); assertPlainAncestors(repository);
        if (!existsSync(repository)) throw new Error("Original repository unavailable: " + repository);
        const git = (args: string[]) => checked(run, "git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args], repository);
        const entries = (await git(["worktree", "list", "--porcelain", "-z"])).split("\0\0");
        const registered = entries.find(entry => entry.split("\0").some(line => line.startsWith("worktree ") && samePath(line.slice(9), root)));
        if (!registered) {
          if (existsSync(root)) throw new Error("Directory is not a registered Worktree: " + root);
          continue;
        }
        // Detached Runtime worktrees only. Never remove a user-owned branch checkout.
        if (!registered.split("\0").includes("detached")) throw new Error("Managed Worktree now has a user branch: " + root);
        const head = await checked(run, "git", ["rev-parse", "HEAD"], root);
        const dirty = await checked(run, "git", ["status", "--porcelain", "--untracked-files=all"], root);
        const merged = await run("git", ["merge-base", "--is-ancestor", head, "HEAD"], repository);
        if (![0, 1].includes(merged.exitCode)) throw new Error("Cannot determine unintegrated Worktree commits: " + root);
        const discard = Boolean(dirty) || merged.exitCode === 1;
        plan.actions.push({ id: "worktree:" + identity(root), phase: 30, target: root,
          description: "Remove registered detached Worktree" + (discard ? " (contains unintegrated work)" : ""),
          ...(discard ? { confirmation: root } : {}),
          execute: async () => {
            assertPlainAncestors(root); assertPlainAncestors(repository);
            const current = await git(["worktree", "list", "--porcelain", "-z"]);
            const entry = current.split("\0\0").find(value => value.split("\0").some(line => line.startsWith("worktree ") && samePath(line.slice(9), root)));
            if (!entry) { if (existsSync(root)) throw new Error("Worktree registration changed"); return; }
            if (!entry.split("\0").includes("detached") || await checked(run, "git", ["rev-parse", "HEAD"], root) !== head ||
              await checked(run, "git", ["status", "--porcelain", "--untracked-files=all"], root) !== dirty)
              throw new Error("Worktree changed after preview: " + root);
            await git(["worktree", "remove", ...(discard ? ["--force"] : []), "--", root]);
          } });
        if (typeof env.id === "string" && /^[a-zA-Z0-9._-]+$/u.test(env.id)) {
          const prefix = "refs/easy-code/environments/" + env.id + "/";
          for (const line of (await git(["for-each-ref", "--format=%(refname) %(objectname)", prefix])).split(/\r?\n/u).filter(Boolean)) {
            const [ref, oid] = line.split(" ");
            if (!ref?.startsWith(prefix) || !/^[a-f0-9]{40,64}$/u.test(oid ?? "")) throw new Error("Invalid Runtime snapshot ref");
            plan.actions.push({ id: repository + ":" + ref, phase: 31, target: ref, description: "Remove Runtime-only snapshot ref",
              execute: async () => {
                const current = await git(["for-each-ref", "--format=%(objectname)", ref!]);
                if (!current) return;
                if (current !== oid) throw new Error("Snapshot ref changed after preview");
                await git(["update-ref", "-d", ref!, oid!]);
              } });
          }
        }
      } catch (error) { plan.blockers.push(String(error)); }
    }
    const worktrees = path.join(data, "worktrees");
    // Do not recursively erase unmanaged/unregistered copies.
    for (const group of await children(worktrees)) {
      for (const entry of await children(path.join(worktrees, group))) {
        const full = path.join(worktrees, group, entry);
        if (!seen.has(identity(full))) plan.blockers.push("Unregistered Worktree content must be inspected: " + full);
      }
      plan.actions.push({ id: "worktree-group:" + path.join(worktrees, group), phase: 35, target: path.join(worktrees, group),
        description: "Remove empty Worktree group", execute: async () => {
          const { rmdir } = await import("node:fs/promises");
          assertPlainAncestors(path.join(worktrees, group));
          try { await rmdir(path.join(worktrees, group)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        } });
    }
    if (existsSync(worktrees)) plan.actions.push({ id: "worktree-root:" + worktrees, phase: 36, target: worktrees,
      description: "Remove empty Worktree root", execute: async () => {
        const { rmdir } = await import("node:fs/promises"); assertPlainAncestors(worktrees);
        try { await rmdir(worktrees); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } });
  }
}
