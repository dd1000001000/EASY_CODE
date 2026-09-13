import { existsSync } from "node:fs";
import path from "node:path";
import { podmanConnectionsFile, podmanEnvironment, podmanExecutable } from "../sandbox/podman-client.js";
import { machineEndpoint, machineIdentity, matchesMachineEndpoint, rootMachineEndpoint, type PodmanMachineEndpoint } from "../sandbox/podman-connection.js";
import { readJson, type UninstallPlan } from "./plan.js";
import { checked, createSystemRunner, runSystem, type SystemRunner } from "./system.js";
import { assertMachineRemoved, finishMachineRemoval, removeMachineConnections, verifiedOrphanConnections, machineConnectionReceipts,
  verifiedLiveMachineConnections } from "../sandbox/podman-machine-state.js";

const ownerOf = (item: any): string | undefined => (item.Labels ?? item.Config?.Labels)?.["io.easy-code.owner"];
const validOwner = (item: any): boolean => /^[a-f0-9]{64}$/u.test(ownerOf(item) ?? "");
export { machineIdentity } from "../sandbox/podman-connection.js";
export async function addPodman(plan: UninstallPlan, run: SystemRunner = runSystem, platform = process.platform, executable = podmanExecutable(),
  connectionsFile?: string): Promise<void> {
  const native = run === runSystem;
  if (native) {
    const environment = podmanEnvironment();
    if (connectionsFile && connectionsFile !== environment.PODMAN_CONNECTIONS_CONF) throw new Error("Registry does not match the uninstall command environment");
    connectionsFile = environment.PODMAN_CONNECTIONS_CONF;
    run = createSystemRunner(environment);
  }
  const version = await run(executable, ["--version"]).catch(() => undefined);
  const knownMachine = plan.resources.filter(r => r.kind === "machine");
  const hasLocalState = plan.roots.data.some(root => existsSync(path.join(root, "podman")));
  if (!version || version.exitCode !== 0) {
    if (knownMachine.length || hasLocalState) plan.blockers.push("Podman is unavailable; sandbox removal cannot be confirmed. Restore the engine before uninstalling.");
    return;
  }
  try {
    // Custom runners must supply their own registry; fixture/alternate engines
    // must never acquire ownership proof from this user's unrelated host file.
    const orphanProof = { home: plan.home, connectionsFile };
    const desktop = platform === "win32" || platform === "darwin";
    const machines: any[] = desktop ? JSON.parse(await checked(run, executable, ["machine", "list", "--format", "json"])) : [];
    if (!Array.isArray(machines)) throw new Error("Invalid machine inventory");
    const names = desktop ? [...new Set(["easy-code", ...knownMachine.map(m => m.name!).filter(Boolean)])] : [""];
    for (const machine of machines) if (!names.includes(machine.Name)) plan.warnings.push("Preserving unrelated Podman machine: " + machine.Name);
    const handled = new Set<string>();
    for (const name of names) {
      if (name && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(name)) throw new Error("Invalid registered machine name");
      if (desktop && !machines.some(m => m.Name === name)) {
        const proof = { ...orphanProof, receipts: machineConnectionReceipts(plan.resources, name, orphanProof.connectionsFile, platform) };
        const orphaned = await verifiedOrphanConnections(run, executable, name, platform, proof);
        if (orphaned.length) {
          await assertMachineRemoved(run, executable, name, platform);
          const expected = new Map(orphaned.map(row => [row.Name, { uri: row.URI, identity: row.Identity }]));
          plan.actions.push({ id: "orphan-connections:" + name, phase: 24, target: orphaned.map(row => row.Name).join(", "),
            description: "Remove verified connections left by an already deleted Podman machine",
            execute: () => removeMachineConnections(run, executable, name, platform, expected, proof) });
          handled.add(name);
        }
        continue;
      }
      let endpoint: PodmanMachineEndpoint | undefined;
      const command = (args: string[]) => checked(run, executable, [...(endpoint ? ["--url", endpoint.uri, "--identity", endpoint.identity] : []), ...args]);
      const readEndpoint = (machine: any) => machineEndpoint(machine, platform,
        () => checked(run, executable, ["machine", "ssh", name, "id", "-u"]));
      const verifyConnections = (expected: PodmanMachineEndpoint) =>
        verifiedLiveMachineConnections(run, executable, name, platform, expected, connectionsFile);
      let machine: any;
      if (desktop) {
        const rows = JSON.parse(await checked(run, executable, ["machine", "inspect", name]));
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0].Name !== name || rows[0].Rootful !== false) throw new Error("Unverified/rootful machine: " + name);
        machine = rows[0];
        const receipt = knownMachine.filter(r => r.name === name).at(-1);
        if (receipt?.identity && receipt.identity !== machineIdentity(machine)) throw new Error("Machine identity changed: " + name);
        if (machine.State === "stopped") {
          const proof = machineIdentity(machine);
          plan.actions.push({ id: "machine:" + name, phase: 20, target: name,
            description: "Start stopped machine after confirmation, inspect ownership, then remove its exclusive resources",
            ...(!receipt?.identity ? { confirmation: "machine:" + name } : {}),
            execute: async () => {
              const current = JSON.parse(await checked(run, executable, ["machine", "inspect", name]));
              if (current.length !== 1 || machineIdentity(current[0]) !== proof || current[0].State !== "stopped") throw new Error("Stopped machine changed after preview");
              const help = await checked(run, executable, ["machine", "start", "--help"]);
              await checked(run, executable, ["machine", "start", ...(help.includes("--update-connection") ? ["--update-connection=false"] : []), name]);
              try {
                const fresh: UninstallPlan = { ...plan, actions: [], blockers: [], warnings: [] };
                await addPodman(fresh, run, platform, executable, orphanProof.connectionsFile);
                if (fresh.blockers.length) throw new Error(fresh.blockers.join("\n"));
                const removal = fresh.actions.find(a => a.id === "machine:" + name);
                if (!removal || removal.description.startsWith("Start stopped")) throw new Error("Machine did not become inspectable");
                await removal.execute();
              } catch (error) {
                // Restore its prior stopped state when verification rejects deletion.
                const remaining = JSON.parse(await checked(run, executable, ["machine", "list", "--format", "json"]));
                if (Array.isArray(remaining) && remaining.some(m => m.Name === name && m.Running))
                  await checked(run, executable, ["machine", "stop", name]);
                throw error;
              }
            } });
          handled.add(name);
          continue;
        }
        if (machine.State !== "running") throw new Error("Machine is changing state; retry after it settles: " + name);
        endpoint = await readEndpoint(machine);
        const connections = await verifyConnections(endpoint);
        if (!connections.some(row => row.Name === name)) plan.warnings.push(`Connection ${name} is missing; inspecting its verified local machine endpoint directly. No connection was created.`);
        if (connections.some(row => !matchesMachineEndpoint(row, row.Name === name ? endpoint! : rootMachineEndpoint(endpoint!), platform)))
          plan.warnings.push(`Machine ${name} has verified stale connection ports; these owned aliases will be removed with the machine after confirmation. Preview makes no changes.`);
      }
      const inventory = async () => {
        const info = JSON.parse(await command(["info", "--format", "json"]));
        if (info.host?.security?.rootless !== true && info.Host?.Security?.Rootless !== true) throw new Error("Rootful/unknown engine; no uninstall mutations allowed");
        const containers = JSON.parse(await command(["ps", "--all", "--format", "json"]));
        const volumes = JSON.parse(await command(["volume", "ls", "--format", "json"]));
        const images = JSON.parse(await command(["images", "--format", "json"]));
        if (![containers, volumes, images].every(Array.isArray)) throw new Error("Invalid engine inventory");
        return { containers: containers as any[], volumes: volumes as any[], images: images as any[] };
      };
      const original = await inventory();
      const ownedContainers: any[] = [];
      for (const container of original.containers) {
        if (!validOwner(container)) continue;
        const owner = ownerOf(container)!;
        const states = await Promise.all(plan.roots.data.map(root => readJson(path.join(root, "podman", owner, "task.json")).catch(() => undefined)));
        const names: string[] = container.Names ?? [];
        if (!states.some(s => s?.owner === owner && names.includes(s.name))) {
          // Temporary review helpers are identified by labels and exact runtime naming.
          if (!names.some(n => /^easy-code-review-probe-[a-f0-9-]{36}$/u.test(n))) throw new Error("Container ownership state missing: " + container.Id);
        }
        ownedContainers.push(container);
      }
      const ownedVolumes = original.volumes.filter(validOwner);
      const ownedImages = original.images.filter(validOwner);
      const foreignImages = original.images.filter(image => !validOwner(image) && (image.RepoTags ?? image.Names ?? []).some((tag: string) =>
        !["localhost/easy-code-sandbox:0.1.0", "docker.io/library/python:3.13-bookworm"].includes(tag) &&
        !plan.resources.some(r => r.kind === "image" && r.name === tag && r.identity === image.Id)));
      if (desktop && (original.containers.length !== ownedContainers.length || original.volumes.length !== ownedVolumes.length || foreignImages.length)) {
        plan.blockers.push("Machine " + name + " contains foreign/unverified resources; move or inspect them before full removal.");
        continue;
      }
      const signature = (state: typeof original) => JSON.stringify([
        state.containers.map(c => JSON.stringify([c.Id ?? c.ID, c.Names, c.Labels])).sort(),
        state.volumes.map(v => JSON.stringify([v.Name, v.Labels])).sort(),
        state.images.map(i => JSON.stringify([i.Id ?? i.ID, i.RepoTags ?? i.Names, i.Labels])).sort(),
      ]);
      if (desktop) {
        const proof = machineIdentity(machine);
        handled.add(name);
        plan.actions.push({ id: "machine:" + name, phase: 20, target: name,
          description: "Stop/remove dedicated Podman machine, connection, containers, volumes, images and build cache",
          ...(!knownMachine.some(r => r.name === name && r.identity) ? { confirmation: "machine:" + name } : {}),
          execute: async () => {
            const rows = JSON.parse(await checked(run, executable, ["machine", "inspect", name]));
            if (rows.length !== 1 || machineIdentity(rows[0]) !== proof || rows[0].Rootful !== false || rows[0].State !== "running") throw new Error("Machine changed after preview");
            const currentEndpoint = await readEndpoint(rows[0]);
            if (!matchesMachineEndpoint({ URI: currentEndpoint.uri, Identity: currentEndpoint.identity }, endpoint!, platform))
              throw new Error("Machine endpoint changed after preview");
            const connections = await verifyConnections(currentEndpoint);
            if (signature(await inventory()) !== signature(original)) throw new Error("Machine resources changed after preview; preview again.");
            // Uninstall does not need to retarget or recreate aliases first.
            // Keep their actual verified endpoints for partial-removal cleanup,
            // so a missing root alias/old port cannot strand another uninstall.
            const aliases = new Map(connections.map(row => [row.Name, { uri: row.URI, identity: row.Identity }]));
            await checked(run, executable, ["machine", "stop", name]);
            const removal = await run(executable, ["machine", "rm", "--force", name]);
            await finishMachineRemoval(run, executable, name, platform, currentEndpoint, removal, aliases);
          } });
      } else {
        for (const [kind, items] of [["container", ownedContainers], ["volume", ownedVolumes], ["image", ownedImages]] as const) {
          for (const item of items) {
            const id = kind === "volume" ? item.Name : item.Id ?? item.ID;
            const owner = ownerOf(item);
            plan.actions.push({ id: kind + ":" + id, phase: kind === "container" ? 20 : kind === "volume" ? 21 : 22,
              target: id, description: "Remove owned Podman " + kind, execute: async () => {
                const rows = JSON.parse(await command([kind, "inspect", id]));
                if (rows.length !== 1 || ownerOf(rows[0]) !== owner) throw new Error("Resource ownership changed");
                if (kind === "container" && rows[0].State?.Running) await command(["stop", "--time", "10", id]);
                await command(kind === "container" ? ["rm", id] : kind === "volume" ? ["volume", "rm", id] : ["rmi", id]);
                const status = await run(executable, [kind, "exists", id]);
                if (status.exitCode !== 1) throw new Error("Resource removal not confirmed");
              } });
          }
        }
        // Remove only exact recorded base-image tags; shared parent layers/cache remain engine-owned.
        for (const record of plan.resources.filter(r => r.kind === "image" && r.name && r.identity)) {
          const match = original.images.find(i => i.Id === record.identity && (i.RepoTags ?? i.Names ?? []).includes(record.name));
          if (!match || validOwner(match)) continue;
          plan.actions.push({ id: "image-tag:" + record.name, phase: 23, target: record.name!, description: "Remove EASY CODE base-image tag",
            execute: async () => {
              const rows = JSON.parse(await command(["image", "inspect", record.name!]));
              if (rows.length !== 1 || rows[0].Id !== record.identity) throw new Error("Base image changed");
              await command(["rmi", record.name!]);
            } });
        }
      }
    }
    const install = plan.resources.find(r => r.kind === "podman-install");
    if (install && desktop && machines.every(m => handled.has(m.Name))) {
      const connections = JSON.parse(await checked(run, executable, ["system", "connection", "list", "--format", "json"]));
      if (!Array.isArray(connections)) throw new Error("Invalid connection inventory");
      if (connections.some(c => !handled.has(c.Name) && ![...handled].some(name => c.Name === name + "-root"))) {
        plan.warnings.push("Podman has other remote connections; shared software is preserved.");
        return;
      }
      if (install.method === "winget" || install.method === "brew") {
        plan.actions.push({ id: "podman-software", phase: 85, target: "Podman", description: "Uninstall Podman installed exclusively by EASY CODE",
          execute: async () => {
            const remaining = JSON.parse(await checked(run, executable, ["machine", "list", "--format", "json"]));
            const connections = JSON.parse(await checked(run, executable, ["system", "connection", "list", "--format", "json"]));
            if (!Array.isArray(remaining) || !Array.isArray(connections) || remaining.length || connections.length) throw new Error("Podman has other users/connections; software retained");
            if (install.method === "winget") await checked(run, "winget", ["uninstall", "--id", "RedHat.Podman", "--exact", "--source", "winget", "--silent"]);
            else {
              if (!["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].includes(install.path ?? "")) throw new Error("Unverified package manager path");
              await checked(run, install.path!, ["uninstall", "podman"]);
            }
          } });
      } else plan.warnings.push("Podman installer is not safely reversible automatically; software retained: " + install.method);
    } else plan.warnings.push("Shared/pre-existing Podman software and WSL are preserved.");
  } catch (error) {
    plan.blockers.push("Sandbox inventory: " + String(error));
    if (native) {
      try { plan.warnings.push(`Podman executable: ${executable}; connections file: ${podmanConnectionsFile()}`); } catch { /* retain original failure */ }
    }
  }
}
