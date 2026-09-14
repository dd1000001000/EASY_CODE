import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertPlainAncestors, maintenanceLock, readOwnedResources } from "../install/ownership.js";
import { children, readJson, type UninstallAction, type UninstallPlan } from "./plan.js";
import { processOwnerProbe, currentProcessIdentity } from "../core/process-owner.js";

const require = createRequire(import.meta.url);
export async function activeOwners(plan: UninstallPlan, confirmed: readonly string[] = []): Promise<string[]> {
  const active: string[] = [];
  const ownerState = processOwnerProbe();
  for (const file of await children(path.join(plan.home, ".easy_code", "runtime-sessions"))) {
    const entry = await readJson(path.join(plan.home, ".easy_code", "runtime-sessions", file));
    if (ownerState(entry) !== "inactive") active.push("Runtime PID " + entry.pid);
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
        const hasIdentity = table && db.all("PRAGMA table_info(thread_leases)").some((column: { name: string }) => column.name === "owner_process_identity");
        if (table) for (const row of db.all(`SELECT owner_pid, owner_hostname, ${hasIdentity ? "owner_process_identity" : "NULL AS owner_process_identity"} FROM thread_leases`)) {
          if (ownerState({ pid: row.owner_pid, hostname: row.owner_hostname,
            processIdentity: row.owner_process_identity ? JSON.parse(row.owner_process_identity) : undefined }) !== "inactive") active.push("Thread PID " + row.owner_pid);
        }
      } catch {
        if (!confirmed.includes("corrupt-store:" + dbPath))
          active.push("Cannot verify thread leases in " + dbPath + "; close all sessions before confirming full uninstall.");
      }
      finally { db?.close(); }
    }
    for (const workspace of await children(path.join(data, "command-leases"))) {
      for (const name of await children(path.join(data, "command-leases", workspace))) {
        if (!name.endsWith(".lease")) continue;
        const entry = await readJson(path.join(data, "command-leases", workspace, name));
        if (ownerState({ ...entry, pid: entry.ownerPid }) !== "inactive") active.push("Command PID " + entry.ownerPid);
      }
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
  const state = { product: "easy-code-agent", version: 2, token,
    resources: [...plan.resources, ...(["data", "config", "cache"] as const).flatMap(kind => plan.roots[kind].map(value => ({ kind, path: value })))],
    completed, failed: "", failures: [] as Array<{ id: string; reason: string }> };
  const persist = async () => {
    assertPlainAncestors(statePath);
    const temporary = statePath + "." + token + ".tmp";
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, statePath);
  };
  try {
    await lock.writeFile(JSON.stringify({ product: "easy-code-agent", pid: process.pid, hostname: os.hostname(), token, processIdentity: currentProcessIdentity() }));
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
      // Phase 60 begins data deletion. Keep recovery records, configuration and
      // CLI when any resource/integration failed; independent earlier steps may finish.
      if (state.failures.length && item.phase >= 60) continue;
      if (options.onAction) options.onAction(item);
      else log(item.description + ": " + item.target);
      state.failed = item.id; await persist();
      try { await item.execute(); completed.push(item.id); state.failed = ""; }
      catch (error) { state.failures.push({ id: item.id, reason: String(error).slice(0, 1600) }); log(`Pending: ${item.description}: ${String(error).slice(0, 800)}`); }
      await persist();
    }
    if (state.failures.length) throw new Error(`Uninstall has ${state.failures.length} pending step(s); recovery data and CLI preserved:\n${state.failures.map(item => item.reason).join("\n")}`);
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
