import { execa } from "execa";
import os from "node:os";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import type { RuntimeLimits } from "../config/runtime-limits.js";

export interface PodmanResult { exitCode: number; stdout: string; stderr: string }
export type PodmanRunner = (args: string[], options?: { input?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<PodmanResult>;

/** Fresh installs may update the system PATH but not this npm/Node process. */
export function podmanExecutable(): string {
  const candidates = process.platform === "win32"
    ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "RedHat", "Podman", "podman.exe")]
    : process.platform === "darwin" ? ["/opt/podman/bin/podman", "/opt/homebrew/bin/podman", "/usr/local/bin/podman"] : ["/usr/bin/podman"];
  return candidates.find(existsSync) ?? "podman";
}

/** Never change or silently use another application's default remote connection. */
export function podmanArguments(args: string[], limits: Readonly<RuntimeLimits>, platform = process.platform): string[] {
  return platform === "win32" || platform === "darwin" ? ["--connection", limits.podmanMachineName, ...args] : args;
}

/** Only the host control plane calls Podman. Never pass this environment to exec. */
export function podmanEnvironment(excludeRoots: readonly string[] = [process.cwd()]): NodeJS.ProcessEnv {
  const names = ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
    "LOCALAPPDATA", "APPDATA", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK"];
  const env = Object.fromEntries(names.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  // Compatible with Podman 5 and 6; --provider on machine init is 6-only.
  if (process.platform === "win32") env.CONTAINERS_MACHINE_PROVIDER = "wsl";
  for (const key of ["PATH", "Path"]) if (env[key]) env[key] = env[key]!.split(path.delimiter).filter(entry => {
    entry = entry.replace(/^"|"$/gu, "");
    if (!entry || !path.isAbsolute(entry)) return false;
    let canonical = entry; try { canonical = realpathSync.native(entry); } catch { /* missing PATH directory cannot resolve a binary */ }
    return !excludeRoots.some(root => { const rel = path.relative(root, canonical); return rel === "" || rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); });
  }).join(path.delimiter);
  return env;
}

export function podmanRunner(limits: Readonly<RuntimeLimits>, excludeRoots?: readonly string[]): PodmanRunner {
  return async (args, options = {}) => {
    const result = await execa(podmanExecutable(), podmanArguments(args, limits), { cwd: os.tmpdir(), env: podmanEnvironment(excludeRoots), extendEnv: false, shell: false,
      windowsHide: true, reject: false, timeout: options.timeoutMs ?? limits.podmanControlTimeoutMs,
      maxBuffer: 1024 * 1024, ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.signal ? { signal: options.signal } : {}) });
    return { exitCode: result.exitCode ?? 125, stdout: result.stdout, stderr: result.stderr };
  };
}

export async function checkedPodman(run: PodmanRunner, args: string[], options?: Parameters<PodmanRunner>[1]): Promise<string> {
  const result = await run(args, options);
  if (result.exitCode !== 0) throw new Error(`Podman ${args[0]} failed (${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 1600)}`);
  return result.stdout.trim();
}

export async function inspectTaskContainer(run: PodmanRunner, name: string): Promise<Record<string, any> | undefined> {
  const result = await run(["container", "inspect", name]);
  if (result.exitCode !== 0) {
    // An unreachable machine must never be mistaken for a missing container.
    const exists = await run(["container", "exists", name]);
    if (exists.exitCode === 1) return undefined;
    throw new Error(`Podman container state is unknown: ${result.stderr.slice(0, 1000)}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]?.Id) throw new Error("Invalid Podman inspect response");
  return parsed[0];
}

export async function stopTaskContainer(run: PodmanRunner, name: string, owner: string): Promise<void> {
  let value = await inspectTaskContainer(run, name);
  if (!value) return;
  if (value.Config?.Labels?.["io.easy-code.owner"] !== owner) throw new Error("Refusing to stop an unowned container");
  if (value.State?.Running || value.State?.Paused) {
    await checkedPodman(run, ["stop", "--time", "1", name]);
    value = await inspectTaskContainer(run, name);
  }
  if (value && (value.State?.Running || value.State?.Paused || !["exited", "stopped", "configured", "created"].includes(value.State?.Status)))
    throw new Error("Podman did not confirm that all container processes stopped");
}
