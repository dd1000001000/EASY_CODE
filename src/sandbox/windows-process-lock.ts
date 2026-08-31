import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface WindowsProcessLockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface WindowsProcessLockOptions {
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  incompleteOwnerGraceMs?: number;
  createToken?: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

const DEFAULT_WAIT_TIMEOUT_MS = 25 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_INCOMPLETE_OWNER_GRACE_MS = 5_000;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows can report EPERM for an existing process owned by another
    // security context. Treat that process as alive rather than stealing its
    // machine-wide SRT lease.
    return errorCode(error) === "EPERM";
  }
}

function parseOwner(value: string): WindowsProcessLockOwner | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<WindowsProcessLockOwner>;
    if (
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.token !== "string" ||
      !parsed.token ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return undefined;
    }
    return parsed as WindowsProcessLockOwner;
  } catch {
    return undefined;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Windows sandbox lock wait was canceled"));
      return;
    }
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), ms);
    const onAbort = (): void => {
      finish(() => reject(signal?.reason ?? new Error("Windows sandbox lock wait was canceled")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * SRT for Windows owns one machine-level sandbox identity and one ACL state
 * database. This filesystem lease serializes ACL grant/stamp/reset across
 * independent EASY CODE processes; the in-memory gate alone cannot do that.
 */
export class WindowsSandboxProcessLock {
  private readonly ownerPath: string;
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly incompleteOwnerGraceMs: number;
  private readonly createToken: () => string;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(
    private readonly lockPath: string,
    options: WindowsProcessLockOptions = {},
  ) {
    this.ownerPath = path.join(lockPath, "owner.json");
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.incompleteOwnerGraceMs =
      options.incompleteOwnerGraceMs ?? DEFAULT_INCOMPLETE_OWNER_GRACE_MS;
    this.createToken = options.createToken ?? (() => `${process.pid}-${Date.now()}-${Math.random()}`);
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  }

  async acquire(signal?: AbortSignal): Promise<() => Promise<void>> {
    const deadline = Date.now() + this.waitTimeoutMs;
    const token = this.createToken();
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Windows sandbox lock wait was canceled");
      }
      try {
        await mkdir(this.lockPath);
        const owner: WindowsProcessLockOwner = {
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString(),
        };
        try {
          await writeFile(this.ownerPath, JSON.stringify(owner), {
            encoding: "utf8",
            flag: "wx",
          });
        } catch (error) {
          await rm(this.lockPath, { recursive: true, force: true });
          throw error;
        }
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try {
            const current = parseOwner(await readFile(this.ownerPath, "utf8"));
            if (current?.token !== token || current.pid !== process.pid) return;
            await rm(this.lockPath, { recursive: true, force: true });
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }

      await this.recoverAbandonedLock();
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting ${this.waitTimeoutMs}ms for another EASY CODE process ` +
          "to release the Windows SRT ACL lease",
        );
      }
      await delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
    }
  }

  private async recoverAbandonedLock(): Promise<void> {
    let ownerText: string | undefined;
    try {
      ownerText = await readFile(this.ownerPath, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return;
    }
    const owner = ownerText === undefined ? undefined : parseOwner(ownerText);
    if (owner && this.isProcessAlive(owner.pid)) return;

    // There is a small window between mkdir(lockPath) and writing owner.json.
    // Never steal that directory until the grace period expires.
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = Date.now() - (await stat(this.lockPath)).mtimeMs;
    } catch {
      return;
    }
    if (!owner && ageMs < this.incompleteOwnerGraceMs) return;

    // Re-read immediately before deletion so a newly acquired owner cannot be
    // removed based on the stale observation above.
    try {
      const latestText = await readFile(this.ownerPath, "utf8");
      if (ownerText !== latestText) return;
      const latest = parseOwner(latestText);
      if (latest && this.isProcessAlive(latest.pid)) return;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return;
      if (ownerText !== undefined) return;
    }
    await rm(this.lockPath, { recursive: true, force: true });
  }
}
