import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOCAL_DECISION_PROTOCOL = "easy-code-laya-ipc-v1";
export const MAX_IPC_LINE_BYTES = 8 * 1024 * 1024;

export interface SharedLayaOptions {
  dataDir: string;
  python: string;
  workerPath: string;
}

export interface SharedLayaEndpoint {
  identity: string;
  address: string;
  directory?: string;
}

/** The exact worker, Python environment, user and data root define one pool. */
export function sharedLayaEndpoint(options: SharedLayaOptions): SharedLayaEndpoint {
  const workerDigest = createHash("sha256").update(readFileSync(options.workerPath)).digest("hex");
  const identity = createHash("sha256").update(JSON.stringify({
    protocol: LOCAL_DECISION_PROTOCOL,
    user: os.userInfo().username,
    home: os.homedir(),
    dataDir: path.resolve(options.dataDir),
    python: path.resolve(options.python),
    workerDigest,
  })).digest("hex").slice(0, 24);
  if (process.platform === "win32")
    return { identity, address: `\\\\.\\pipe\\easy-code-laya-${identity}` };
  const directory = path.join(os.tmpdir(), `easy-code-laya-${process.getuid?.() ?? "user"}-${identity}`);
  return { identity, address: path.join(directory, "service.sock"), directory };
}

/** A private parent keeps Unix socket names and input away from other users. */
export async function ensurePrivateSocketDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0)
    throw new Error("Local Laya IPC directory is not private to this user");
}

/** Do not retain provider credentials in a model service that outlives a CLI. */
export function localModelEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "SystemRoot", "WINDIR", "HOME", "USERPROFILE",
    "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "TMP", "TEMP", "TMPDIR",
    "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "LD_LIBRARY_PATH", "CUDA_VISIBLE_DEVICES"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.PYTHONIOENCODING = "utf-8";
  env.USE_TF = "0";
  env.HF_HUB_OFFLINE = "1";
  env.TRANSFORMERS_OFFLINE = "1";
  return env;
}
