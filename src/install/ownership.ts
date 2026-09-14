import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_PROTOCOL, requireCurrentProtocol } from "../protocol/versions.js";

export type OwnedResourceKind = "data" | "config" | "cache" | "credential" | "extension";
export type OwnedResourceState = "creating" | "ready" | "removing" | "removed";

/** Input accepted before an operating-system resource has a durable receipt. */
export interface OwnedResourceRegistration {
  kind: OwnedResourceKind;
  path?: string;
  name?: string;
  identity?: string;
  connection?: string;
  method?: string;
  generation?: string;
}

/** A current manifest receipt. It records ownership but never grants deletion authority by itself. */
export interface OwnedResource extends OwnedResourceRegistration {
  id: string;
  state: OwnedResourceState;
  createdAt: string;
  updatedAt: string;
}

interface InstallationManifest {
  product: "easy-code-agent";
  version: typeof CURRENT_PROTOCOL.installationManifest;
  installationId: string;
  createdAt: string;
  updatedAt: string;
  resources: OwnedResource[];
}

export function maintenanceLock(home = os.homedir()): string {
  return path.join(home, ".easy-code-uninstall.lock");
}

export function installationManifestPath(home = os.homedir()): string {
  return path.join(home, ".easy_code", "installation-manifest.json");
}

export function assertNoUninstall(home = os.homedir()): void {
  if (existsSync(maintenanceLock(home))) {
    throw new Error("EASY CODE uninstall is in progress. Finish it before starting new work.");
  }
}

export function assertPlainAncestors(target: string): void {
  let current = path.resolve(target);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing redirected path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export type OwnedResourceInput = OwnedResourceRegistration | OwnedResource;

function resourceKey(resource: OwnedResourceRegistration): string {
  return JSON.stringify([resource.kind, resource.path ?? "", resource.name ?? "",
    resource.connection ?? "", resource.method ?? ""]);
}

function resourceId(resource: OwnedResourceRegistration): string {
  return `resource_${createHash("sha256").update(resourceKey(resource)).digest("hex").slice(0, 24)}`;
}

function withFilesystemIdentity(resource: OwnedResourceRegistration): OwnedResourceRegistration {
  if (!resource.path || resource.identity || !existsSync(resource.path)) return resource;
  const stat = lstatSync(resource.path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to register a redirected installation resource: ${resource.path}`);
  }
  return { ...resource, identity: `fs:${stat.dev}:${stat.ino}` };
}

function validateResource(value: unknown): OwnedResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid installation resource");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["id", "kind", "path", "name", "identity", "connection", "method", "state", "generation", "createdAt", "updatedAt"]);
  if (Object.keys(input).some(key => !allowed.has(key)) ||
      !["data", "config", "cache", "credential", "extension"].includes(String(input.kind)) ||
      typeof input.id !== "string" || !/^resource_[a-f0-9]{24}$/u.test(input.id) ||
      !["creating", "ready", "removing", "removed"].includes(String(input.state)) ||
      typeof input.createdAt !== "string" || typeof input.updatedAt !== "string" ||
      Object.entries(input).some(([key, item]) => !["kind", "state"].includes(key) && item !== undefined && typeof item !== "string")) {
    throw new Error("Invalid installation resource");
  }
  return { ...input } as unknown as OwnedResource;
}

function emptyManifest(): InstallationManifest {
  const now = new Date().toISOString();
  return { product: "easy-code-agent", version: CURRENT_PROTOCOL.installationManifest,
    installationId: `installation_${randomUUID()}`, createdAt: now, updatedAt: now, resources: [] };
}

function readManifest(home: string, optional = true): InstallationManifest {
  const file = installationManifestPath(home);
  assertPlainAncestors(file);
  if (!existsSync(file)) {
    if (optional) return emptyManifest();
    throw new Error("Installation manifest is missing");
  }
  if (lstatSync(file).size > 16 * 1024 * 1024) throw new Error("Installation manifest exceeds its safety limit");
  const input = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  requireCurrentProtocol("installationManifest", input.version);
  if (input.product !== "easy-code-agent" || typeof input.installationId !== "string" ||
      typeof input.createdAt !== "string" || typeof input.updatedAt !== "string" || !Array.isArray(input.resources)) {
    throw new Error("Invalid installation manifest; no destructive fallback is allowed");
  }
  return { product: "easy-code-agent", version: CURRENT_PROTOCOL.installationManifest,
    installationId: input.installationId, createdAt: input.createdAt, updatedAt: input.updatedAt,
    resources: input.resources.map(validateResource) };
}

function writeManifest(home: string, manifest: InstallationManifest): void {
  const file = installationManifestPath(home);
  assertPlainAncestors(file);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

function upsertResource(resource: OwnedResourceInput, state: OwnedResourceState, home: string): OwnedResource {
  assertNoUninstall(home);
  const manifest = readManifest(home);
  const identified = withFilesystemIdentity(resource);
  const id = "id" in resource ? resource.id : resourceId(identified);
  const now = new Date().toISOString();
  const existing = manifest.resources.find(item => item.id === id);
  const next: OwnedResource = {
    ...existing,
    ...identified,
    id,
    state,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const index = manifest.resources.findIndex(item => item.id === id);
  if (index >= 0) manifest.resources[index] = next;
  else manifest.resources.push(next);
  writeManifest(home, manifest);
  return next;
}

/** Record intent before a side effect whose OS identity is not known yet. */
export function beginOwnedResource(resource: OwnedResourceInput, home = os.homedir()): OwnedResource {
  return upsertResource(resource, "creating", home);
}

/** Complete a creating receipt after the side effect and identity are known. */
export function completeOwnedResource(resource: OwnedResourceInput, home = os.homedir()): OwnedResource {
  return upsertResource(resource, "ready", home);
}

/** Convenience for resources that already exist when ownership is registered. */
export function recordOwnedResource(resource: OwnedResourceInput, home = os.homedir()): void {
  completeOwnedResource(resource, home);
}

export function transitionOwnedResource(id: string, state: "removing" | "removed", home = os.homedir()): void {
  const manifest = readManifest(home, false);
  const existing = manifest.resources.find(item => item.id === id);
  if (!existing) throw new Error(`Unknown installation resource: ${id}`);
  const now = new Date().toISOString();
  const index = manifest.resources.findIndex(item => item.id === id);
  manifest.resources[index] = { ...existing, state, updatedAt: now };
  writeManifest(home, manifest);
}

export function readOwnedResources(home = os.homedir()): OwnedResource[] {
  const file = installationManifestPath(home);
  if (!existsSync(file)) return [];
  return readManifest(home, false).resources.filter(resource => resource.state !== "removed");
}
