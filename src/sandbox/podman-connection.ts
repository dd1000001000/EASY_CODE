import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export interface PodmanMachineEndpoint { uri: string; identity: string }

/** Stable VM identity deliberately excludes the mutable SSH forwarding port. */
export function machineIdentity(item: any): string {
  return JSON.stringify([item.Name, item.Created, item.ConfigDir?.Path, item.SSHConfig?.IdentityPath]);
}

export function normalizeIdentity(p: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  let current = paths.normalize(p), suffix: string[] = [];
  // Resolve equivalent Windows long/8.3 paths, including already removed keys.
  if (platform === process.platform) {
    while (true) {
      try { current = paths.join(realpathSync.native(current), ...suffix); break; }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        const parent = paths.dirname(current);
        if (parent === current) { current = paths.normalize(p); break; }
        suffix.unshift(paths.basename(current)); current = parent;
      }
    }
  }
  return platform === "win32" ? current.toLowerCase() : current;
}

/** Derive a local rootless endpoint from VM metadata, not a mutable alias. */
export async function machineEndpoint(machine: any, platform: NodeJS.Platform, readUid: () => Promise<string>,
  exists: (file: string) => boolean = existsSync): Promise<PodmanMachineEndpoint> {
  const ssh = machine?.SSHConfig;
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (machine?.Rootful !== false || !ssh || typeof ssh.RemoteUsername !== "string" ||
      !/^[a-z_][a-z0-9_-]*[$]?$/iu.test(ssh.RemoteUsername) || ssh.RemoteUsername === "root" ||
      !Number.isInteger(ssh.Port) || ssh.Port < 1 || ssh.Port > 65535 ||
      typeof ssh.IdentityPath !== "string" || !paths.isAbsolute(ssh.IdentityPath) ||
      /[\u0000-\u001f]/u.test(ssh.IdentityPath) || !exists(ssh.IdentityPath))
    throw new Error(`Machine ${machine?.Name} has no usable non-root SSH identity; its VM and keys were not replaced`);
  const uid = (await readUid()).trim();
  if (!/^[1-9][0-9]*$/u.test(uid) || !Number.isSafeInteger(Number(uid)))
    throw new Error(`Machine ${machine.Name} did not report a valid rootless UID; no connection was changed`);
  return { uri: `ssh://${ssh.RemoteUsername}@127.0.0.1:${ssh.Port}/run/user/${uid}/podman/podman.sock`, identity: ssh.IdentityPath };
}

export function matchesMachineEndpoint(entry: { URI?: string; Identity?: string }, endpoint: PodmanMachineEndpoint,
  platform: NodeJS.Platform): boolean {
  return entry.URI === endpoint.uri && typeof entry.Identity === "string" &&
    normalizeIdentity(entry.Identity, platform) === normalizeIdentity(endpoint.identity, platform);
}

/** Only the local port may drift; username, socket, host and key must agree. */
export function matchesMachineExceptPort(entry: { URI?: string; Identity?: string }, endpoint: PodmanMachineEndpoint,
  platform: NodeJS.Platform): boolean {
  try {
    const actual = new URL(entry.URI!), expected = new URL(endpoint.uri);
    if (actual.protocol !== "ssh:" || actual.hostname !== "127.0.0.1" || !actual.port ||
      actual.password || actual.search || actual.hash) return false;
    actual.port = expected.port;
    return matchesMachineEndpoint({ URI: actual.href, Identity: entry.Identity }, endpoint, platform);
  } catch { return false; }
}

export function rootMachineEndpoint(endpoint: PodmanMachineEndpoint): PodmanMachineEndpoint {
  const url = new URL(endpoint.uri);
  url.username = "root"; url.pathname = "/run/podman/podman.sock";
  return { uri: url.href, identity: endpoint.identity };
}
