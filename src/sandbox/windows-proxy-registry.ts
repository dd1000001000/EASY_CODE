import { open, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  currentProcessIdentity,
  processOwnerState,
  type ProcessIdentity,
} from "../core/process-owner.js";

interface ProxyPortLeaseRecord {
  port: number;
  pid: number;
  hostname: string;
  processIdentity?: ProcessIdentity;
}

interface ProxyPortRegistry {
  version: 1;
  provisionedPorts: number[];
  leases: ProxyPortLeaseRecord[];
}

export interface WindowsProxyPortLease {
  readonly port: number;
  /** Ports already proven to be present in the durable Windows WFP policy. */
  authorizedPorts(): Promise<readonly number[]>;
  /** Authorized ports plus this process's newly allocated port for setup. */
  setupPorts(): Promise<readonly number[]>;
  /** Persist only after the native sandbox enforcement probe succeeds. */
  markAuthorized(): Promise<void>;
}

export interface AcquireWindowsProxyPortOptions {
  dataDir: string;
  portStart: number;
  portSlots: number;
  bind(port: number): Promise<void>;
}

const processLeases = new Map<string, Promise<WindowsProxyPortLease>>();

const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

function emptyRegistry(): ProxyPortRegistry {
  return { version: 1, provisionedPorts: [], leases: [] };
}

function normalizeRegistry(value: unknown, portStart: number, portSlots: number): ProxyPortRegistry {
  if (!value || typeof value !== "object") return emptyRegistry();
  const candidate = value as Partial<ProxyPortRegistry>;
  if (candidate.version !== 1 || !Array.isArray(candidate.provisionedPorts) || !Array.isArray(candidate.leases)) {
    return emptyRegistry();
  }
  const maximum = portStart + portSlots - 1;
  const provisionedPorts = [...new Set(candidate.provisionedPorts.filter(port =>
    Number.isInteger(port) && port >= portStart && port <= maximum))].sort((a, b) => a - b);
  const leases = candidate.leases.filter((lease): lease is ProxyPortLeaseRecord => {
    if (!lease || typeof lease !== "object") return false;
    return Number.isInteger(lease.port) && lease.port >= portStart && lease.port <= maximum &&
      Number.isInteger(lease.pid) && lease.pid > 0 && typeof lease.hostname === "string";
  });
  return { version: 1, provisionedPorts, leases };
}

async function readRegistry(file: string, portStart: number, portSlots: number): Promise<ProxyPortRegistry> {
  try {
    return normalizeRegistry(JSON.parse(await readFile(file, "utf8")), portStart, portSlots);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw new Error(`Windows sandbox proxy registry is unreadable: ${String(error)}`);
  }
}

async function writeRegistry(file: string, value: ProxyPortRegistry): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function acquireRegistryLock(file: string, timeoutMs = 5_000): Promise<() => Promise<void>> {
  const token = randomBytes(16).toString("hex");
  const owner = { token, pid: process.pid, hostname: os.hostname(), processIdentity: currentProcessIdentity() };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(owner)); }
      finally { await handle.close(); }
      return async () => {
        try {
          const current = JSON.parse(await readFile(file, "utf8")) as { token?: unknown };
          if (current.token !== token) throw new Error("Windows sandbox proxy registry lock ownership changed");
          await rm(file, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const existing = JSON.parse(await readFile(file, "utf8")) as { pid: unknown; hostname: unknown; processIdentity?: unknown };
        if (processOwnerState(existing) === "inactive") {
          await rm(file, { force: true });
          continue;
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      await wait(100);
    }
  }
  throw new Error("Timed out acquiring the Windows sandbox proxy registry lock");
}

async function portAppearsAvailable(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise(resolve => {
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function acquire(options: AcquireWindowsProxyPortOptions): Promise<WindowsProxyPortLease> {
  const directory = path.join(options.dataDir, "native-sandbox");
  const registryFile = path.join(directory, "proxy-ports.json");
  const lockFile = path.join(directory, "proxy-ports.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireRegistryLock(lockFile);
  let port: number;
  try {
    const registry = await readRegistry(registryFile, options.portStart, options.portSlots);
    registry.leases = registry.leases.filter(lease => processOwnerState(lease) !== "inactive");
    const own = registry.leases.find(lease => lease.pid === process.pid &&
      lease.hostname === os.hostname() && processOwnerState(lease) === "active");
    if (own) {
      port = own.port;
      await options.bind(port);
    } else {
      const occupied = new Set(registry.leases.map(lease => lease.port));
      const candidates = [
        ...registry.provisionedPorts.filter(candidate => !occupied.has(candidate)),
        ...Array.from({ length: options.portSlots }, (_, index) => options.portStart + index)
          .filter(candidate => !registry.provisionedPorts.includes(candidate) && !occupied.has(candidate)),
      ];
      let selected: number | undefined;
      for (const candidate of candidates) {
        if (!await portAppearsAvailable(candidate)) continue;
        try {
          await options.bind(candidate);
          selected = candidate;
          break;
        } catch (error) {
          if (!/already in use|EADDRINUSE/iu.test(String(error))) throw error;
        }
      }
      if (selected === undefined) {
        throw new Error(`No free Windows sandbox proxy port remains in ${options.portStart}-${options.portStart + options.portSlots - 1}`);
      }
      port = selected;
      // A newly selected port is only allocated here. It becomes durable
      // policy state after the startup service completes a real enforcement
      // probe and calls markAuthorized().
      registry.leases.push({ port, pid: process.pid, hostname: os.hostname(),
        ...(() => { const identity = currentProcessIdentity(); return identity ? { processIdentity: identity } : {}; })() });
    }
    await writeRegistry(registryFile, registry);
  } finally {
    await release();
  }

  return {
    port,
    authorizedPorts: async () => {
      const registry = await readRegistry(registryFile, options.portStart, options.portSlots);
      return registry.provisionedPorts;
    },
    setupPorts: async () => {
      const registry = await readRegistry(registryFile, options.portStart, options.portSlots);
      return registry.provisionedPorts.includes(port) ? registry.provisionedPorts
        : [...registry.provisionedPorts, port].sort((a, b) => a - b);
    },
    markAuthorized: async () => {
      const unlock = await acquireRegistryLock(lockFile);
      try {
        const registry = await readRegistry(registryFile, options.portStart, options.portSlots);
        if (!registry.provisionedPorts.includes(port)) {
          registry.provisionedPorts.push(port);
          registry.provisionedPorts.sort((a, b) => a - b);
          await writeRegistry(registryFile, registry);
        }
      } finally { await unlock(); }
    },
  };
}

/** Acquire one process-wide port. Previously provisioned inactive slots are
 * reused, so the durable WFP allowlist grows only to peak concurrent CLI use. */
export function acquireWindowsProxyPortLease(options: AcquireWindowsProxyPortOptions): Promise<WindowsProxyPortLease> {
  const key = path.resolve(options.dataDir).toLowerCase();
  const existing = processLeases.get(key);
  if (existing) return existing;
  const created = acquire(options).catch(error => {
    if (processLeases.get(key) === created) processLeases.delete(key);
    throw error;
  });
  processLeases.set(key, created);
  return created;
}

/** Serialize only the durable WFP setup transaction. Port allocation uses its
 * own short lock, so another CLI can start and wait without corrupting state. */
export async function withWindowsProxyProvisioningLock<T>(
  dataDir: string,
  action: () => Promise<T>,
  timeoutMs = 10 * 60_000,
): Promise<T> {
  const directory = path.join(dataDir, "native-sandbox");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireRegistryLock(path.join(directory, "proxy-provisioning.lock"), timeoutMs);
  try { return await action(); }
  finally { await release(); }
}
