import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertPlainAncestors, maintenanceLock, readOwnedResources } from "../install/ownership.js";
import { children, readJson, type UninstallAction, type UninstallPlan } from "./plan.js";
import { alive } from "./system.js";

const require = createRequire(import.meta.url);
export async function activeOwners(plan: UninstallPlan, confirmed: readonly string[] = []): Promise<string[]> {
  const active: string[] = [];
  const setupFile = path.join(plan.home, ".easy_code", "podman-setup.lock");
  if (existsSync(setupFile)) {
    const entry = await readJson(setupFile);
    if (entry.hostname !== os.hostname() || alive(entry.pid)) active.push("Podman setup PID " + entry.pid);
  }
  for (const file of await children(path.join(plan.home, ".easy_code", "runtime-sessions"))) {
    const entry = await readJson(path.join(plan.home, ".easy_code", "runtime-sessions", file));
    if (entry.hostname !== os.hostname() || alive(entry.pid)) active.push("Runtime PID " + entry.pid);
  }
  for (const data of plan.roots.data) {
    const dbPath = path.join(data, "easy-code.db");
    if (existsSync(dbPath)) {
      assertPlainAncestors(dbPath);
      const { Database } = require("node-sqlite3-wasm");
      let db;
      try {
        db = new Database(dbPath, { fileMustExist: true, readOnly: true });
        const table = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='thread_leases'");
        if (table) for (const row of db.all("SELECT owner_pid, owner_hostname FROM thread_leases")) {
          if (row.owner_hostname !== os.hostname() || alive(row.owner_pid)) active.push("Thread PID " + row.owner_pid);
        }
      } catch {
        if (!confirmed.includes("corrupt-store:" + dbPath))
          active.push("Cannot verify thread leases in " + dbPath + "; close all sessions before confirming full uninstall.");
      }
      finally { db?.close(); }
    }
    for (const directory of await children(path.join(data, "podman"))) {
      const lease = path.join(data, "podman", directory, "command.lease");
      if (!existsSync(lease)) continue;
      const entry = await readJson(lease);
      if (alive(entry.pid)) active.push("Command/snapshot PID " + entry.pid);
    }
  }
  return [...new Set(active)];
}
export interface ExecuteOptions {
  confirmations?: readonly string[];
  log?: (message: string) => void;
  onAction?: (action: UninstallAction) => void;
  activity?: () => Promise<string[]>;
  shutdownTimeoutMs?: number;
}
export async function executeUninstall(plan: UninstallPlan, options: ExecuteOptions = {}): Promise<void> {
  if (plan.blockers.length) throw new Error("Uninstall blocked:\n" + plan.blockers.join("\n"));
  const confirmations = new Set(options.confirmations ?? []);
  for (const item of plan.actions) if (item.confirmation && !confirmations.has(item.confirmation))
    throw new Error("Removal plan was not fully confirmed for " + item.target + "; confirm full uninstall before executing it.");
  const log = options.log ?? (() => undefined);
  const lockPath = maintenanceLock(plan.home);
  const statePath = path.join(plan.home, ".easy-code-uninstall-state.json");
  assertPlainAncestors(lockPath); assertPlainAncestors(statePath);
  const token = randomUUID();
  // A stale lock is never silently erased based on an unreliable PID match.
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error("Another uninstall or an unfinished uninstall lock exists: " + lockPath); });
  const completed: string[] = [];
  const state = { product: "easy-code-agent", version: 1, token,
    resources: [...plan.resources, ...(["data", "config", "cache"] as const).flatMap(kind => plan.roots[kind].map(value => ({ kind, path: value })))],
    completed, failed: "" };
  const persist = async () => {
    assertPlainAncestors(statePath);
    const temporary = statePath + "." + token + ".tmp";
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, statePath);
  };
  try {
    await lock.writeFile(JSON.stringify({ product: "easy-code-agent", pid: process.pid, hostname: os.hostname(), token }));
    await lock.sync();
    await persist();
    const activity = options.activity ?? (() => activeOwners(plan, options.confirmations));
    const deadline = Date.now() + (options.shutdownTimeoutMs ?? 30000);
    let owners = await activity();
    if (owners.length) log("Requesting running EASY CODE sessions to stop; waiting for command/child cleanup.");
    while (owners.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      owners = await activity();
    }
    if (owners.length) throw new Error("Close these active/unknown sessions before uninstalling:\n" + owners.join("\n"));
    const known = new Set(plan.resources.map(resource => JSON.stringify(resource)));
    for (const resource of readOwnedResources(plan.home)) {
      if (!known.has(JSON.stringify(resource))) throw new Error("New resources were registered after preview. Run uninstall again to review the updated inventory.");
    }
    for (const item of [...plan.actions].sort((a, b) => a.phase - b.phase)) {
      if (options.onAction) options.onAction(item);
      else log(item.description + ": " + item.target);
      state.failed = item.id; await persist();
      await item.execute();
      completed.push(item.id); state.failed = ""; await persist();
    }
    await unlink(statePath);
    log("Uninstall completed. Deleted data is not recoverable without a backup; user projects and shared software were preserved.");
  } catch (error) {
    log("Uninstall incomplete; remaining work recorded in " + statePath);
    throw error;
  } finally {
    await lock.close();
    const current = await readJson(lockPath).catch(() => undefined);
    if (current?.token === token) await unlink(lockPath);
  }
}
