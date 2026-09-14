import { readFileSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** PID alone is reusable. This identity describes one OS process incarnation. */
export interface ProcessIdentity { started: string; executable?: string }
export type ProcessSnapshot = { state: "absent" | "unknown" } |
  { state: "present"; identity: ProcessIdentity; name: string };
export interface ProcessOwner { pid: unknown; hostname: unknown; processIdentity?: unknown }
export type OwnerState = "active" | "inactive" | "unknown";

export function validProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const item = value as ProcessIdentity;
  return typeof item.started === "string" && item.started.length > 0 && item.started.length <= 256 &&
    (item.executable === undefined || typeof item.executable === "string" && item.executable.length > 0);
}

/** Read-only, bounded OS metadata. Never reads argv, signals or terminates a process. */
export function inspectProcess(pid: number): ProcessSnapshot {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
  if (pid === process.pid && ownIdentity) return { state: "present", identity: ownIdentity, name: path.basename(process.execPath) };
  try {
    if (process.platform === "linux") {
      let stat: string;
      try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); }
      catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown" }; }
      const end = stat.lastIndexOf(")");
      const start = stat.slice(end + 2).split(" ")[19]; // stat field 22, after pid/comm
      if (end < 0 || !start || !/^\d+$/u.test(start)) return { state: "unknown" };
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      let executable: string | undefined;
      try { executable = readlinkSync(`/proc/${pid}/exe`); } catch { /* preserve unknown executable */ }
      return { state: "present", name: stat.slice(stat.indexOf("(") + 1, end),
        identity: { started: `linux:${boot}:${start}`, ...(executable ? { executable } : {}) } };
    }
    if (process.platform === "win32") {
      const program = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
        "if($null -eq $p){'null'}else{[pscustomobject]@{name=$p.Name;started=$p.CreationDate.ToUniversalTime().Ticks.ToString();executable=$p.ExecutablePath}|ConvertTo-Json -Compress}";
      const result = spawnSync(program, ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 65536 });
      if (result.status !== 0 || result.error) return { state: "unknown" };
      const row = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
      if (row === null) return { state: "absent" };
      if (!row || typeof row.name !== "string" || !/^\d+$/u.test(row.started)) return { state: "unknown" };
      return { state: "present", name: row.name, identity: { started: `win32:${row.started}`,
        ...(typeof row.executable === "string" && row.executable ? { executable: row.executable } : {}) } };
    }
    if (process.platform === "darwin") {
      const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
        { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 5000, maxBuffer: 65536 });
      if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return { state: "absent" };
      if (result.status !== 0 || result.error) return { state: "unknown" };
      const match = /^\s*(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(result.stdout.trim());
      if (!match) return { state: "unknown" };
      return { state: "present", name: path.basename(match[2]!), identity: { started: `darwin:${match[1]}`, executable: match[2]! } };
    }
  } catch { /* Unreadable/malformed metadata is not proof of process exit. */ }
  return { state: "unknown" };
}

let ownIdentity: ProcessIdentity | undefined;
export function currentProcessIdentity(): ProcessIdentity | undefined {
  if (!ownIdentity) { const result = inspectProcess(process.pid); if (result.state === "present") ownIdentity = result.identity; }
  return ownIdentity;
}

export function processOwnerState(owner: ProcessOwner, probe: (pid: number) => ProcessSnapshot = inspectProcess): OwnerState {
  if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) return "unknown";
  // A recorded foreign host must never be compared with this host's PID
  // namespace. For an incomplete local record, an absent PID is definitive;
  // a present PID remains unknown because its incarnation was not recorded.
  if (owner.hostname !== undefined && owner.hostname !== null && owner.hostname !== os.hostname()) return "unknown";
  const actual = probe(Number(owner.pid));
  if (actual.state === "absent") return "inactive";
  if (actual.state !== "present") return "unknown";
  if (owner.processIdentity !== undefined && owner.processIdentity !== null) {
    if (!validProcessIdentity(owner.processIdentity)) return "unknown";
    if (owner.processIdentity.started !== actual.identity.started) return "inactive";
    if (owner.processIdentity.executable && actual.identity.executable) {
      const normalize = (value: string) => process.platform === "win32" ? path.win32.normalize(value).toLowerCase() : value;
      if (normalize(owner.processIdentity.executable) !== normalize(actual.identity.executable)) return "inactive";
    }
    return "active";
  }
  return "unknown";
}

/** A fresh cache per inspection pass, not a process-lifetime PID cache. */
export function processOwnerProbe(): (owner: ProcessOwner) => OwnerState {
  const cache = new Map<number, ProcessSnapshot>();
  return owner => processOwnerState(owner, pid => {
    if (!cache.has(pid)) cache.set(pid, inspectProcess(pid));
    return cache.get(pid)!;
  });
}
