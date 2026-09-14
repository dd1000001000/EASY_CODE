import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Host-written inventory only. Never stores secrets or authorizes deletion by itself. */
export interface OwnedResource {
  kind: "data" | "config" | "cache" | "credential" | "extension";
  path?: string;
  name?: string;
  identity?: string;
  connection?: string;
  method?: string;
  /** A durable create intent precedes OS changes; ready binds the actual OS ID. */
  state?: "creating" | "ready";
  generation?: string;
}
export function maintenanceLock(home = os.homedir()): string { return path.join(home, ".easy-code-uninstall.lock"); }
export function assertNoUninstall(home = os.homedir()): void {
  if (existsSync(maintenanceLock(home))) throw new Error("EASY CODE uninstall is in progress. Finish it before starting new work.");
}
export function assertPlainAncestors(target: string): void {
  let current = path.resolve(target);
  while (true) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing redirected path: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
const recorded = new Set<string>();
export function recordOwnedResource(resource: OwnedResource, home = os.homedir()): void {
  const key = JSON.stringify([home, resource]);
  if (recorded.has(key)) return;
  assertNoUninstall(home);
  const directory = path.join(home, ".easy_code");
  const file = path.join(directory, "install-resources.jsonl");
  assertPlainAncestors(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const descriptor = openSync(file, "a", 0o600);
  try { writeSync(descriptor, `${JSON.stringify({ product: "easy-code-agent", version: 1, ...resource })}\n`); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  recorded.add(key);
}
export function readOwnedResources(home = os.homedir()): OwnedResource[] {
  const file = path.join(home, ".easy_code", "install-resources.jsonl");
  assertPlainAncestors(file);
  if (!existsSync(file)) return [];
  if (lstatSync(file).size > 16 * 1024 * 1024) throw new Error("Installation inventory exceeds its safety limit");
  return readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).flatMap(line => {
    const entry = JSON.parse(line);
    const currentKinds = ["data", "config", "cache", "credential", "extension"];
    const retiredKinds = ["machine", "machine-connection", "image", "podman-install", "wsl-distribution"];
    if (entry.product !== "easy-code-agent" || entry.version !== 1 ||
      ![...currentKinds, ...retiredKinds].includes(entry.kind) ||
      Object.entries(entry).some(([key, value]) => !["product", "version", "kind"].includes(key) && typeof value !== "string"))
      throw new Error("Invalid installation inventory; no destructive fallback is allowed");
    // Retired container-era receipts are inert compatibility input. Their
    // paths are removed only through the ordinary bounded data-directory plan.
    return currentKinds.includes(entry.kind) ? [entry as OwnedResource] : [];
  });
}
