import path from "node:path";
import { machineIdentity, matchesMachineEndpoint, matchesMachineExceptPort, normalizeIdentity, rootMachineEndpoint, type PodmanMachineEndpoint } from "./podman-connection.js";
import type { PodmanResult } from "./podman-client.js";
import type { OwnedResource } from "../install/ownership.js";
import { readJson } from "../install/metadata.js";

export type MachineControlRunner = (program: string, args: string[]) => Promise<PodmanResult>;
async function checked(run: MachineControlRunner, program: string, args: string[]): Promise<string> {
  const result = await run(program, args);
  if (result.exitCode !== 0) throw new Error(`${program} ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout).slice(-1600)}`);
  return result.stdout.trim();
}

interface Connection { Name: string; URI: string; Identity: string; IsMachine?: boolean; ReadWrite?: boolean; Default?: boolean }
async function connectionInventory(run: MachineControlRunner, executable: string): Promise<Connection[]> {
  const rows = JSON.parse(await checked(run, executable, ["system", "connection", "list", "--format", "json"]));
  if (!Array.isArray(rows) || rows.some(row => typeof row?.Name !== "string") ||
    new Set(rows.map(row => row.Name)).size !== rows.length) throw new Error("Invalid Podman connection inventory");
  return rows;
}
export async function machineConnections(run: MachineControlRunner, executable: string, name: string): Promise<Connection[]> {
  return (await connectionInventory(run, executable)).filter(row => row.Name === name || row.Name === name + "-root");
}

export async function assertMachineRemoved(run: MachineControlRunner, executable: string, name: string, platform: NodeJS.Platform): Promise<void> {
  const machines = JSON.parse(await checked(run, executable, ["machine", "list", "--format", "json"]));
  if (!Array.isArray(machines) || machines.some(machine => typeof machine?.Name !== "string" || machine.Name === name))
    throw new Error("Machine removal not confirmed: " + name);
  if (platform === "win32") {
    // Podman may delete its metadata even when the provider failed. Query WSL
    // without launching, stopping or unregistering any distribution.
    const distros = (await checked(run, "wsl.exe", ["--list", "--quiet"])).replace(/\u0000/gu, "").split(/\r?\n/u).map(s => s.trim());
    if (distros.some(distro => distro.toLowerCase() === ("podman-" + name).toLowerCase()))
      throw new Error("WSL distribution still exists; machine removal not confirmed: podman-" + name);
  }
}

/** IsMachine is a Podman creation hint, not ownership: connection add does not
 * set it. A host receipt proves our endpoint; legacy migration additionally
 * requires the standard machine key and a matching writable registry entry. */
export function validateOrphanConnections(rows: readonly Connection[], name: string, home: string, platform: NodeJS.Platform,
  receipts: ReadonlyMap<string, PodmanMachineEndpoint> = new Map(), registryVerified = false): void {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const identity = normalizeIdentity(paths.join(home, ".local", "share", "containers", "podman", "machine", "machine"), platform);
  let port: string | undefined;
  for (const row of rows) {
    let url: URL;
    try { url = new URL(row.URI); } catch { throw new Error("Unverified orphan connection: " + row.Name); }
    const root = row.Name === name + "-root";
    const reasons: string[] = [];
    const receipt = receipts.get(row.Name);
    if (row.Name !== name && !root) reasons.push("name does not belong to the selected machine");
    if (row.IsMachine !== undefined && typeof row.IsMachine !== "boolean") reasons.push("invalid IsMachine=" + JSON.stringify(row.IsMachine));
    if (!registryVerified && !receipt && row.IsMachine !== true) reasons.push("missing registry/receipt ownership evidence (IsMachine=" + JSON.stringify(row.IsMachine) + ")");
    if (row.ReadWrite !== true) reasons.push("ReadWrite=" + JSON.stringify(row.ReadWrite) + " (expected true)");
    if (receipt && !matchesMachineEndpoint(row, receipt, platform)) reasons.push("recorded endpoint/identity changed");
    if (typeof row.Identity !== "string" || !paths.isAbsolute(row.Identity) || !receipt && normalizeIdentity(row.Identity, platform) !== identity)
      reasons.push("identity path mismatch: expected " + JSON.stringify(identity) + ", received " + JSON.stringify(row.Identity));
    if (url.protocol !== "ssh:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) < 1 || Number(url.port) > 65535 ||
      url.password || url.search || url.hash) reasons.push("endpoint is not a plain local SSH machine endpoint");
    if (root ? url.username !== "root" || url.pathname !== "/run/podman/podman.sock"
      : url.username === "root" || !/^[a-z_][a-z0-9_-]*[$]?$/iu.test(url.username) || !/^\/run\/user\/[1-9][0-9]*\/podman\/podman\.sock$/u.test(url.pathname))
      reasons.push("SSH username or socket path does not match the connection role");
    if (port !== undefined && port !== url.port) reasons.push("root/rootless connection ports differ");
    if (reasons.length) throw new Error("Unverified orphan connection " + row.Name + ": " + reasons.join("; ") + ". No connection was removed.");
    port = url.port;
  }
}

export interface OrphanConnectionProof { home: string; connectionsFile?: string; receipts?: ReadonlyMap<string, PodmanMachineEndpoint> }

export function machineConnectionReceipts(resources: readonly OwnedResource[], name: string, file: string | undefined,
  platform: NodeJS.Platform): Map<string, PodmanMachineEndpoint> {
  const receipts = new Map<string, PodmanMachineEndpoint>();
  for (const resource of resources) {
    if (resource.kind !== "machine-connection" || resource.connection !== name || !resource.path || !file ||
      normalizeIdentity(resource.path, platform) !== normalizeIdentity(file, platform) ||
      ![name, name + "-root"].includes(resource.name ?? "")) continue;
    let endpoint;
    try { endpoint = JSON.parse(resource.identity ?? ""); } catch { throw new Error("Invalid recorded machine connection: " + resource.name); }
    if (typeof endpoint?.uri !== "string" || typeof endpoint?.identity !== "string") throw new Error("Invalid recorded machine endpoint");
    receipts.set(resource.name!, endpoint);
  }
  return receipts;
}

async function verifyRegistry(rows: readonly Connection[], file: string, platform: NodeJS.Platform): Promise<void> {
  if (rows.length) {
    const reason = "Unverified orphan connection " + rows[0]!.Name + ": ";
    let registry: any;
    try { registry = await readJson(file); }
    catch { throw new Error(reason + "cannot safely read connection registry " + file + ". No connection was changed."); }
    const entries = registry?.Connection?.Connections;
    const paths = platform === "win32" ? path.win32 : path.posix;
    for (const row of rows) {
      const entry = entries && typeof entries === "object" && !Array.isArray(entries) && Object.prototype.hasOwnProperty.call(entries, row.Name)
        ? entries[row.Name] : undefined;
      if (!entry || entry.URI !== row.URI ||
        typeof entry.Identity !== "string" || !paths.isAbsolute(entry.Identity) ||
        typeof row.Identity !== "string" || !paths.isAbsolute(row.Identity) ||
        normalizeIdentity(entry.Identity, platform) !== normalizeIdentity(row.Identity, platform))
        throw new Error("Podman inventory source mismatch for " + row.Name + ": CLI endpoint " + JSON.stringify(row.URI) +
          " does not match registry " + file + " entry " + JSON.stringify(entry?.URI ?? null) +
          "; identity matches=" + String(typeof entry?.Identity === "string" && typeof row.Identity === "string" &&
            normalizeIdentity(entry.Identity, platform) === normalizeIdentity(row.Identity, platform)) + ". No connection was removed.");
      if (entry.IsMachine !== undefined && typeof entry.IsMachine !== "boolean") throw new Error("Invalid registry IsMachine for " + row.Name);
    }
  }
}

async function rejectOtherMachinePorts(run: MachineControlRunner, executable: string, name: string,
  rows: readonly Connection[], requireAbsent = false): Promise<void> {
  if (!rows.length) return;
  // A standard Podman key is shared across VMs, so it is not sufficient proof.
  const machines = JSON.parse(await checked(run, executable, ["machine", "list", "--format", "json"]));
  if (!Array.isArray(machines) || machines.some(machine => typeof machine?.Name !== "string" || requireAbsent && machine.Name === name))
    throw new Error("Machine absence changed during connection reconciliation: " + name);
  for (const other of machines.filter(machine => machine.Name !== name)) {
    const inspected = JSON.parse(await checked(run, executable, ["machine", "inspect", other.Name]));
    if (!Array.isArray(inspected) || inspected.length !== 1 || inspected[0]?.Name !== other.Name || !Number.isInteger(inspected[0]?.SSHConfig?.Port))
      throw new Error("Cannot verify another machine's endpoint; stale aliases were preserved: " + other.Name);
    if (rows.some(row => Number(new URL(row.URI).port) === inspected[0].SSHConfig.Port))
      throw new Error("Connection points at another Podman machine; preserved: " + other.Name);
  }
}

/** Read-only classification shared by install and uninstall preview. A live
 * VM supplies the key, user and socket identity; only its forwarding port may
 * differ. Legacy aliases need no IsMachine flag or exact old-port receipt. */
export async function verifiedLiveMachineConnections(run: MachineControlRunner, executable: string, name: string,
  platform: NodeJS.Platform, endpoint: PodmanMachineEndpoint, connectionsFile?: string): Promise<Connection[]> {
  const rows = await machineConnections(run, executable, name);
  const stale: Connection[] = [];
  for (const row of rows) {
    const target = row.Name === name ? endpoint : rootMachineEndpoint(endpoint);
    if (matchesMachineEndpoint(row, target, platform)) continue;
    if (!connectionsFile || row.ReadWrite !== true || !matchesMachineExceptPort(row, target, platform))
      throw new Error(`Connection ${row.Name} does not match the inspected machine: expected ${target.uri}, received ${JSON.stringify(row.URI)}; ` +
        `identity matches=${typeof row.Identity === "string" && normalizeIdentity(row.Identity, platform) === normalizeIdentity(target.identity, platform)}. ` +
        "No existing connection was overwritten; endpoint/identity conflict requires inspection.");
    stale.push(row);
  }
  if (connectionsFile) await verifyRegistry(rows, connectionsFile, platform);
  await rejectOtherMachinePorts(run, executable, name, stale);
  return rows;
}

/** Reconcile connection indexes, not VM identity. All aliases are validated
 * before writes; each write rechecks the VM and registry. Existing defaults,
 * other aliases and keys are preserved. No machine/command is replayed. */
export async function reconcileLiveMachineConnections(run: MachineControlRunner, executable: string, machine: any,
  platform: NodeJS.Platform, endpoint: PodmanMachineEndpoint, options: {
    connectionsFile?: string; createMissing: boolean; report?: (message: string) => void;
  }): Promise<void> {
  const name: string = machine.Name;
  const before = await connectionInventory(run, executable);
  const previousDefault = before.find(row => row.Default)?.Name;
  const inspect = async () => {
    const current = JSON.parse(await checked(run, executable, ["machine", "inspect", name]));
    if (!Array.isArray(current) || current.length !== 1 || machineIdentity(current[0]) !== machineIdentity(machine) ||
      current[0].State !== "running" || current[0].Rootful !== false ||
      current[0].SSHConfig?.Port !== machine.SSHConfig.Port || current[0].SSHConfig?.RemoteUsername !== machine.SSHConfig.RemoteUsername)
      throw new Error("Machine changed during connection reconciliation: " + name);
    return verifiedLiveMachineConnections(run, executable, name, platform, endpoint, options.connectionsFile);
  };
  let approved = await inspect();
  const signature = (rows: Connection[]) => JSON.stringify(rows.map(row =>
    [row.Name, row.URI, typeof row.Identity === "string" ? normalizeIdentity(row.Identity, platform) : row.Identity, row.ReadWrite]).sort());
  for (const [alias, target] of new Map([[name, endpoint], [name + "-root", rootMachineEndpoint(endpoint)]])) {
    const latest = await inspect();
    if (signature(latest) !== signature(approved)) throw new Error("Connections changed during reconciliation; preview/setup again: " + name);
    const current = latest.find(row => row.Name === alias);
    if (current && matchesMachineEndpoint(current, target, platform) || !current && !options.createMissing) continue;
    if (current) options.report?.(`Updating verified stale connection ${alias}: ${current.URI} -> ${target.uri}. VM and keys are preserved.`);
    else options.report?.(`Restoring missing connection ${alias} from the existing machine; no VM, image or key is recreated.`);
    // Podman's add atomically updates this exact registry entry without changing
    // an existing default. Never remove the whole registry or use --all.
    await checked(run, executable, ["system", "connection", "add", "--identity", target.identity, alias, target.uri]);
    const after = await inspect();
    if (!after.some(row => row.Name === alias && matchesMachineEndpoint(row, target, platform)))
      throw new Error("Connection was not persisted in the selected registry: " + alias);
    if (signature(after.filter(row => row.Name !== alias)) !== signature(approved.filter(row => row.Name !== alias)))
      throw new Error("Another connection changed during reconciliation; inspect before continuing: " + name);
    approved = after;
    if (previousDefault && !(await connectionInventory(run, executable)).some(row => row.Name === previousDefault && row.Default))
      throw new Error("Podman changed another default connection unexpectedly; inspect system connections before continuing");
  }
}

export async function verifiedOrphanConnections(run: MachineControlRunner, executable: string, name: string, platform: NodeJS.Platform,
  proof: OrphanConnectionProof): Promise<Connection[]> {
  const rows = await machineConnections(run, executable, name);
  if (proof.connectionsFile) await verifyRegistry(rows, proof.connectionsFile, platform);
  validateOrphanConnections(rows, name, proof.home, platform, proof.receipts, Boolean(proof.connectionsFile));
  await rejectOtherMachinePorts(run, executable, name, rows, true);
  return rows;
}

/** Operates on aliases only, after machine/provider removal. Revalidate every
 * remaining target before each removal; never delete a changed/foreign alias. */
export async function removeMachineConnections(run: MachineControlRunner, executable: string, name: string, platform: NodeJS.Platform,
  expected: ReadonlyMap<string, PodmanMachineEndpoint>, orphanProof?: OrphanConnectionProof): Promise<void> {
  const inspect = async () => {
    await assertMachineRemoved(run, executable, name, platform);
    const rows = orphanProof ? await verifiedOrphanConnections(run, executable, name, platform, orphanProof)
      : await machineConnections(run, executable, name);
    for (const row of rows) {
      const endpoint = expected.get(row.Name);
      if (!endpoint || row.ReadWrite === false || !matchesMachineEndpoint(row, endpoint, platform))
        throw new Error("Machine connection changed or belongs to a different endpoint: " + row.Name);
    }
    return rows;
  };
  await inspect();
  for (const alias of expected.keys()) {
    if (!(await inspect()).some(row => row.Name === alias)) continue;
    await checked(run, executable, ["system", "connection", "remove", alias]);
  }
  if ((await inspect()).length) throw new Error("Machine connection removal not confirmed: " + name);
}

export async function reconcileAbsentMachine(run: MachineControlRunner, executable: string, name: string, platform: NodeJS.Platform,
  proof: OrphanConnectionProof, report: (message: string) => void = () => {}): Promise<void> {
  await assertMachineRemoved(run, executable, name, platform);
  const rows = await verifiedOrphanConnections(run, executable, name, platform, proof);
  if (!rows.length) return;
  report(`Reconciling ${rows.length} verified stale connection(s) for absent machine ${name}.`);
  await removeMachineConnections(run, executable, name, platform,
    new Map(rows.map(row => [row.Name, { uri: row.URI, identity: row.Identity }])), proof);
}

export async function finishMachineRemoval(run: MachineControlRunner, executable: string, name: string, platform: NodeJS.Platform,
  endpoint: PodmanMachineEndpoint, result: PodmanResult, verifiedAliases?: ReadonlyMap<string, PodmanMachineEndpoint>): Promise<void> {
  if (result.exitCode !== 0) {
    // Recover only this exact Podman failure, never timeouts/permission errors,
    // provider-removal errors or aggregates containing another cleanup failure.
    const missing = result.stderr.trim().match(/^Error: failed to remove machines files: unable to find connection named "([^"]+)"$/u);
    if (!missing || ![name, name + "-root"].includes(missing[1]!))
      throw new Error("Podman machine rm failed: " + (result.stderr || result.stdout).slice(-1600));
  }
  await removeMachineConnections(run, executable, name, platform,
    verifiedAliases ?? new Map([[name, endpoint], [name + "-root", rootMachineEndpoint(endpoint)]]));
}
