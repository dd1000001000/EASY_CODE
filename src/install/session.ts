import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoUninstall, assertPlainAncestors, maintenanceLock } from "./ownership.js";
import { currentProcessIdentity } from "../core/process-owner.js";

/** Cooperative shutdown, never kill an arbitrary PID obtained from a stale file. */
export function registerRuntimeSession(onStop: () => void, home = os.homedir()): () => void {
  assertNoUninstall(home);
  const directory = path.join(home, ".easy_code", "runtime-sessions");
  assertPlainAncestors(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID(); const file = path.join(directory, `${token}.json`);
  writeFileSync(file, JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), processIdentity: currentProcessIdentity() }), { flag: "wx", mode: 0o600 });
  try { assertNoUninstall(home); } catch (error) { unlinkSync(file); throw error; }
  let stopped = false;
  const timer = setInterval(() => {
    if (!stopped && existsSync(maintenanceLock(home))) { stopped = true; onStop(); }
  }, 250);
  timer.unref();
  const release = () => {
    clearInterval(timer);
    try { if (JSON.parse(readFileSync(file, "utf8")).token === token) unlinkSync(file); } catch { /* Already removed / preserve unknown ownership. */ }
    process.removeListener("exit", release);
  };
  process.once("exit", release);
  return release;
}
