import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import path from "node:path";

import type {
  BindValues,
  Database as WasmDatabase,
} from "node-sqlite3-wasm";

const require = createRequire(import.meta.url);
const { Database: WasmDatabaseConstructor } = require("node-sqlite3-wasm") as {
  Database: new (filename?: string) => WasmDatabase;
};

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement<
  Parameters extends unknown[] = unknown[],
  Result = Record<string, unknown>,
> {
  run(...parameters: Parameters): SqliteRunResult;
  all(...parameters: Parameters): Result[];
  get(...parameters: Parameters): Result | undefined;
}

export interface PragmaOptions {
  simple?: boolean;
}

export interface SqliteDatabaseOptions {
  lockTimeoutMs?: number;
}

interface TransactionToken {
  active: boolean;
}

/**
 * Small synchronous adapter around node-sqlite3-wasm.
 *
 * The WASM package exposes synchronous, file-backed SQLite without a native
 * Node ABI. Preparing afresh for each call also guarantees that its underlying
 * statements are finalized immediately instead of leaking WASM resources.
 */
export class SqliteDatabase {
  private readonly database: WasmDatabase;
  private readonly advisoryLock: DatabaseAdvisoryLock | undefined;
  private readonly lockTimeoutMs: number;
  private readonly transactionScope = new AsyncLocalStorage<TransactionToken>();
  private closed = false;

  constructor(filename: string, options: SqliteDatabaseOptions = {}) {
    this.lockTimeoutMs = normalizeLockTimeout(options.lockTimeoutMs);
    this.advisoryLock = filename === ":memory:"
      ? undefined
      : advisoryLockFor(filename);
    this.database = this.withDatabaseLock(
      () => new WasmDatabaseConstructor(filename),
    );
  }

  exec(sql: string): void {
    this.assertOpen();
    this.withDatabaseLock(() => this.database.exec(sql));
  }

  prepare<
    Parameters extends unknown[] = unknown[],
    Result = Record<string, unknown>,
  >(sql: string): SqliteStatement<Parameters, Result> {
    this.assertOpen();
    return {
      run: (...parameters: Parameters): SqliteRunResult => {
        this.assertOpen();
        return this.withDatabaseLock(() =>
          this.database.run(sql, bindings(parameters)),
        );
      },
      all: (...parameters: Parameters): Result[] => {
        this.assertOpen();
        return this.withDatabaseLock(() =>
          this.database.all(sql, bindings(parameters)) as Result[],
        );
      },
      get: (...parameters: Parameters): Result | undefined => {
        this.assertOpen();
        return this.withDatabaseLock(
          () => (this.database.get(sql, bindings(parameters)) ?? undefined) as
            | Result
            | undefined,
        );
      },
    };
  }

  pragma(source: string, options: PragmaOptions = {}): unknown {
    this.assertOpen();
    if (!source.trim() || /[;\u0000\r\n]/u.test(source)) {
      throw new Error("PRAGMA source must be one statement");
    }
    const rows = this.withDatabaseLock(
      () => this.database.all(`PRAGMA ${source}`) as Array<
        Record<string, unknown>
      >,
    );
    if (!options.simple) return rows;
    const first = rows[0];
    return first ? Object.values(first)[0] : undefined;
  }

  transaction<Parameters extends unknown[], Result>(
    callback: (...parameters: Parameters) => Result,
  ): (...parameters: Parameters) => Result {
    return (...parameters: Parameters): Result => {
      return this.withDatabaseLock(() => {
        this.assertOpen();
        if (this.database.inTransaction) {
          throw new Error("Nested SQLite transactions are not supported");
        }
        this.database.exec("BEGIN IMMEDIATE");
        const token: TransactionToken = { active: true };
        try {
          const result = this.transactionScope.run(
            token,
            () => callback(...parameters),
          );
          if (isPromiseLike(result)) {
            token.active = false;
            void Promise.resolve(result).catch(() => undefined);
            throw new Error("SQLite transaction callbacks must be synchronous");
          }
          this.database.exec("COMMIT");
          token.active = false;
          return result;
        } catch (error) {
          token.active = false;
          try {
            if (this.database.isOpen && this.database.inTransaction) {
              this.database.exec("ROLLBACK");
            }
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "SQLite transaction failed and rollback also failed",
            );
          }
          throw error;
        }
      });
    };
  }

  close(): void {
    if (this.closed) return;
    this.assertOpen();
    try {
      this.withDatabaseLock(() => this.database.close());
    } finally {
      if (!this.database.isOpen) this.closed = true;
    }
  }

  private assertOpen(): void {
    const transaction = this.transactionScope.getStore();
    if (transaction && !transaction.active) {
      throw new Error("SQLite transaction callback is no longer active");
    }
    if (this.closed || !this.database.isOpen) {
      throw new Error("SQLite database is closed");
    }
  }

  private withDatabaseLock<Result>(callback: () => Result): Result {
    return this.advisoryLock
      ? this.advisoryLock.runExclusive(callback, this.lockTimeoutMs)
      : callback();
  }
}

function bindings(parameters: readonly unknown[]): BindValues | undefined {
  if (parameters.length === 0) return undefined;
  if (parameters.length > 1) return [...parameters] as BindValues;

  const value = parameters[0];
  if (Array.isArray(value) || isNamedBindings(value)) {
    return value as BindValues;
  }
  return [value] as BindValues;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isNamedBindings(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    value instanceof Uint8Array
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface AdvisoryLockOwner {
  version: 1;
  pid: number;
  hostname: string;
  token: string;
  acquiredAt: string;
}

interface LockRecoveryMarker {
  version: 1;
  ownerToken: string;
  recoveredByToken: string;
  recoveredAt: string;
}

type OwnerState = "alive" | "dead" | "unknown";

const ADVISORY_LOCK_SUFFIX = ".easy-code-advisory-lock";
const OWNER_FILE = "owner.json";
const RECOVERED_FILE = "recovered.json";
const advisoryLocks = new Map<string, DatabaseAdvisoryLock>();
const sleepArray = new Int32Array(new SharedArrayBuffer(4));

class DatabaseAdvisoryLock {
  private depth = 0;

  readonly lockDirectory: string;
  readonly dependencyLockDirectory: string;

  constructor(readonly databasePath: string) {
    this.lockDirectory = `${databasePath}${ADVISORY_LOCK_SUFFIX}`;
    this.dependencyLockDirectory = `${databasePath}.lock`;
  }

  runExclusive<Result>(callback: () => Result, timeoutMs: number): Result {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return callback();
      } finally {
        this.depth -= 1;
      }
    }

    const owner = this.acquire(timeoutMs);
    this.depth = 1;
    let result: Result | undefined;
    let callbackFailed = false;
    let callbackError: unknown;
    try {
      result = callback();
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    }

    this.depth = 0;
    let releaseError: unknown;
    try {
      this.release(owner, timeoutMs);
    } catch (error) {
      releaseError = error;
    }

    if (callbackFailed) {
      if (releaseError !== undefined) {
        throw new AggregateError(
          [callbackError, releaseError],
          "SQLite operation failed and its advisory lock could not be released",
        );
      }
      throw callbackError;
    }
    if (releaseError !== undefined) throw releaseError;
    return result as Result;
  }

  private acquire(timeoutMs: number): AdvisoryLockOwner {
    const owner = newOwner();
    const stagingDirectory = `${this.lockDirectory}.staging-${owner.token}`;
    writeOwnerDirectory(stagingDirectory, owner);
    const deadline = Date.now() + timeoutMs;

    try {
      while (true) {
        let installed = false;
        try {
          renameSync(stagingDirectory, this.lockDirectory);
          installed = true;
        } catch (error) {
          if (existsSync(this.lockDirectory)) {
            const current = readOwner(this.lockDirectory);
            if (current && ownerState(current) === "dead") {
              // A fixed, permanent stale-T tombstone prevents a delayed
              // contender that also observed T from renaming a newer owner U.
              const staleDirectory = `${this.lockDirectory}.stale-${current.token}`;
              try {
                renameSync(this.lockDirectory, staleDirectory);
                continue;
              } catch {
                // Another contender changed the lock. Re-read it below.
              }
            }
          } else if (!existsSync(stagingDirectory)) {
            throw error;
          }

          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            const current = readOwner(this.lockDirectory);
            throw lockBusyError(this.databasePath, current);
          }
          sleepSync(Math.min(25, remaining));
        }

        if (installed) {
          try {
            this.prepareDependencyLock(owner);
            return owner;
          } catch (error) {
            removeOwnerDirectoryIfOwned(this.lockDirectory, owner.token);
            throw error;
          }
        }
      }
    } catch (error) {
      removeOwnerDirectoryIfOwned(stagingDirectory, owner.token);
      removeOwnerDirectoryIfOwned(this.lockDirectory, owner.token);
      throw error;
    }
  }

  private prepareDependencyLock(owner: AdvisoryLockOwner): void {
    const staleDirectories = findStaleDirectories(this.lockDirectory);
    const unrecovered: Array<{
      directory: string;
      owner: AdvisoryLockOwner;
    }> = [];
    for (const staleDirectory of staleDirectories) {
      const staleOwner = readOwner(staleDirectory);
      if (!staleOwner) {
        throw new Error(
          `Refusing SQLite lock recovery because ${staleDirectory} has invalid owner metadata`,
        );
      }
      const directoryToken = staleDirectoryToken(
        this.lockDirectory,
        staleDirectory,
      );
      if (directoryToken !== staleOwner.token) {
        throw new Error(
          `Refusing SQLite lock recovery because ${staleDirectory} does not match its owner token`,
        );
      }
      if (readRecoveryMarker(staleDirectory, staleOwner.token)) continue;
      if (ownerState(staleOwner) !== "dead") {
        throw new Error(
          `Refusing SQLite lock recovery because ${staleDirectory} does not belong to a confirmed dead process`,
        );
      }
      unrecovered.push({ directory: staleDirectory, owner: staleOwner });
    }

    if (existsSync(this.dependencyLockDirectory)) {
      if (unrecovered.length === 0) {
        throw new Error(
          `Refusing to remove unowned SQLite lock ${this.dependencyLockDirectory}`,
        );
      }
      removeEmptyDependencyLock(this.dependencyLockDirectory);
    }

    for (const stale of unrecovered) {
      writeRecoveryMarker(stale.directory, stale.owner.token, owner.token);
    }
  }

  private release(owner: AdvisoryLockOwner, timeoutMs: number): void {
    const current = readOwner(this.lockDirectory);
    if (!current || current.token !== owner.token) {
      throw new Error("SQLite advisory lock ownership changed before release");
    }
    const releaseDirectory = `${this.lockDirectory}.release-${owner.token}`;
    renameOwnedDirectory(
      this.lockDirectory,
      releaseDirectory,
      owner.token,
      timeoutMs,
    );
    const moved = readOwner(releaseDirectory);
    if (!moved || moved.token !== owner.token) {
      throw new Error("SQLite advisory lock ownership changed during release");
    }
    removeOwnerDirectoryIfOwned(releaseDirectory, owner.token);
  }
}

function renameOwnedDirectory(
  source: string,
  destination: string,
  expectedToken: string,
  timeoutMs: number,
): void {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const owner = readOwner(source);
    if (!owner || owner.token !== expectedToken) {
      throw new Error("SQLite advisory lock ownership changed before rename");
    }
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      if (!isTransientRenameError(error) || Date.now() >= deadline) throw error;
      sleepSync(Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  return (
    isFileSystemError(error, "EPERM") ||
    isFileSystemError(error, "EACCES") ||
    isFileSystemError(error, "EBUSY")
  );
}

function advisoryLockFor(filename: string): DatabaseAdvisoryLock {
  const resolved = path.resolve(filename);
  // The database file may not exist yet, but createStorage guarantees its
  // parent does. Canonicalizing that parent makes directory symlink/junction
  // aliases contend on one advisory lock instead of creating independent
  // locks for the same SQLite file.
  const canonicalFilename = path.join(
    realpathSync(path.dirname(resolved)),
    path.basename(resolved),
  );
  const key = process.platform === "win32"
    ? canonicalFilename.toLowerCase()
    : canonicalFilename;
  const existing = advisoryLocks.get(key);
  if (existing) return existing;
  const created = new DatabaseAdvisoryLock(canonicalFilename);
  advisoryLocks.set(key, created);
  return created;
}

function newOwner(): AdvisoryLockOwner {
  return {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    token: randomToken(),
    acquiredAt: new Date().toISOString(),
  };
}

function randomToken(): string {
  return randomBytes(16).toString("hex");
}

function writeOwnerDirectory(
  directory: string,
  owner: AdvisoryLockOwner,
): void {
  mkdirSync(directory, { mode: 0o700 });
  const ownerPath = path.join(directory, OWNER_FILE);
  try {
    const descriptor = openSync(ownerPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    removeOwnerDirectoryIfOwned(directory, owner.token);
    throw error;
  }
}

function readOwner(directory: string): AdvisoryLockOwner | undefined {
  try {
    const value = JSON.parse(
      readFileSync(path.join(directory, OWNER_FILE), "utf8"),
    ) as Partial<AdvisoryLockOwner>;
    if (
      value.version !== 1 ||
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.hostname !== "string" ||
      value.hostname.length === 0 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{32}$/u.test(value.token) ||
      typeof value.acquiredAt !== "string"
    ) {
      return undefined;
    }
    return value as AdvisoryLockOwner;
  } catch {
    return undefined;
  }
}

function ownerState(owner: AdvisoryLockOwner): OwnerState {
  if (owner.hostname.toLowerCase() !== hostname().toLowerCase()) {
    return "unknown";
  }
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    if (isFileSystemError(error, "ESRCH")) return "dead";
    if (isFileSystemError(error, "EPERM")) return "alive";
    return "unknown";
  }
}

function findStaleDirectories(lockDirectory: string): string[] {
  const parent = path.dirname(lockDirectory);
  const prefix = `${path.basename(lockDirectory)}.stale-`;
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        startsWithPathName(entry.name, prefix),
      )
      .map((entry) => path.join(parent, entry.name));
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw error;
  }
}

function staleDirectoryToken(
  lockDirectory: string,
  staleDirectory: string,
): string | undefined {
  const prefix = `${path.basename(lockDirectory)}.stale-`;
  const name = path.basename(staleDirectory);
  if (!startsWithPathName(name, prefix)) return undefined;
  return name.slice(prefix.length);
}

function startsWithPathName(value: string, prefix: string): boolean {
  if (process.platform === "win32") {
    return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
  }
  return value.startsWith(prefix);
}

function readRecoveryMarker(
  directory: string,
  expectedOwnerToken: string,
): LockRecoveryMarker | undefined {
  const markerPath = path.join(directory, RECOVERED_FILE);
  try {
    const metadata = lstatSync(markerPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Invalid SQLite recovery marker: ${markerPath}`);
    }
    const value = JSON.parse(readFileSync(markerPath, "utf8")) as
      Partial<LockRecoveryMarker>;
    if (
      value.version !== 1 ||
      value.ownerToken !== expectedOwnerToken ||
      typeof value.recoveredByToken !== "string" ||
      !/^[a-f0-9]{32}$/u.test(value.recoveredByToken) ||
      typeof value.recoveredAt !== "string"
    ) {
      throw new Error(`Invalid SQLite recovery marker: ${markerPath}`);
    }
    return value as LockRecoveryMarker;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function writeRecoveryMarker(
  directory: string,
  ownerToken: string,
  recoveredByToken: string,
): void {
  if (readRecoveryMarker(directory, ownerToken)) return;
  const marker: LockRecoveryMarker = {
    version: 1,
    ownerToken,
    recoveredByToken,
    recoveredAt: new Date().toISOString(),
  };
  const stagingPath = path.join(
    directory,
    `${RECOVERED_FILE}.staging-${recoveredByToken}`,
  );
  const markerPath = path.join(directory, RECOVERED_FILE);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(stagingPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(marker)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try {
    renameSync(stagingPath, markerPath);
  } catch (error) {
    try {
      unlinkSync(stagingPath);
    } catch (cleanupError) {
      if (!isFileSystemError(cleanupError, "ENOENT")) throw cleanupError;
    }
    if (!readRecoveryMarker(directory, ownerToken)) throw error;
  }
}

function removeEmptyDependencyLock(directory: string): void {
  let metadata;
  try {
    metadata = lstatSync(directory);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      `Refusing to remove SQLite lock that is not a plain directory: ${directory}`,
    );
  }
  if (readdirSync(directory).length !== 0) {
    throw new Error(`Refusing to remove non-empty SQLite lock: ${directory}`);
  }
  try {
    rmdirSync(directory);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
}

function removeOwnerDirectoryIfOwned(
  directory: string,
  expectedToken: string,
): void {
  const owner = readOwner(directory);
  if (!owner || owner.token !== expectedToken) return;
  const entries = readdirSync(directory, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0]?.name !== OWNER_FILE ||
    !entries[0].isFile()
  ) {
    throw new Error(`Refusing to remove unexpected advisory lock contents: ${directory}`);
  }
  unlinkSync(path.join(directory, OWNER_FILE));
  rmdirSync(directory);
}

function lockBusyError(
  databasePath: string,
  owner: AdvisoryLockOwner | undefined,
): Error {
  const ownerDescription = owner
    ? `pid ${owner.pid} on ${owner.hostname}`
    : "an owner whose identity cannot be verified";
  return new Error(
    `SQLite database is busy: ${databasePath} is locked by ${ownerDescription}`,
  );
}

function normalizeLockTimeout(value: number | undefined): number {
  if (value === undefined) return 5_000;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("lockTimeoutMs must be a non-negative finite number");
  }
  return Math.trunc(value);
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(sleepArray, 0, 0, milliseconds);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
