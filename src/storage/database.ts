import { mkdirSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../utils/hash.js";
import { ensureEasyCodeDataRootMarker } from "./data-root.js";
import { runMigrations } from "./migrations.js";
import { SqliteDatabase } from "./sqlite-database.js";

export interface EasyCodeStorage {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly threadsDir: string;
  readonly artifactsDir: string;
  readonly db: SqliteDatabase;
  close(): void;
}

export function workspaceIdFromRoot(workspaceRoot: string): string {
  let normalized = path.resolve(workspaceRoot).replace(/\\/g, "/");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return `workspace_${sha256(normalized).slice(0, 24)}`;
}

export function createStorage(dataDir: string): EasyCodeStorage {
  if (typeof dataDir !== "string" || dataDir.trim().length === 0) {
    throw new Error("dataDir must be a non-empty path");
  }

  const resolvedDataDir = path.resolve(dataDir);
  mkdirSync(resolvedDataDir, { recursive: true });
  ensureEasyCodeDataRootMarker(resolvedDataDir);
  const threadsDir = path.join(resolvedDataDir, "threads");
  const artifactsDir = path.join(resolvedDataDir, "artifacts");
  mkdirSync(threadsDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  const databasePath = path.join(resolvedDataDir, "easy-code.db");
  const db = new SqliteDatabase(databasePath);
  // The cross-platform WASM VFS uses SQLite's rollback journal. It deliberately
  // avoids native Node ABI modules, which keeps npm installation compiler-free.
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  runMigrations(db);

  let closed = false;
  return {
    dataDir: resolvedDataDir,
    databasePath,
    threadsDir,
    artifactsDir,
    db,
    close(): void {
      if (closed) return;
      db.close();
      closed = true;
    },
  };
}
