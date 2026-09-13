import path from "node:path";
import { lstat, open, realpath, rm } from "node:fs/promises";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import { checkedPodman, podmanRunner, type PodmanRunner } from "./podman-client.js";

export type PodmanResourceKind = "container" | "volume" | "image";
export interface PodmanResources { containers: unknown[]; volumes: unknown[]; images: unknown[] }
/** Explicit user maintenance, never an Agent tool or a global prune operation. */
export class PodmanResourceManager {
  private readonly run: PodmanRunner;
  constructor(private readonly stateRoot: string, limits: Readonly<RuntimeLimits>, run?: PodmanRunner) {
    this.run = run ?? podmanRunner(limits);
  }
  async list(): Promise<PodmanResources> {
    const read = async (args: string[]) => {
      const values: unknown = JSON.parse(await checkedPodman(this.run, args));
      if (!Array.isArray(values)) throw new Error("Invalid Podman resource list");
      return values;
    };
    const [containers, volumes, images] = await Promise.all([
      read(["ps", "--all", "--filter", "label=io.easy-code.owner", "--format", "json"]),
      read(["volume", "ls", "--filter", "label=io.easy-code.owner", "--format", "json"]),
      read(["images", "--filter", "label=io.easy-code.owner", "--format", "json"]),
    ]);
    return { containers, volumes, images };
  }
  async remove(kind: PodmanResourceKind, id: string): Promise<void> {
    const valid = kind === "container" ? /^(?:easy-code-[a-f0-9]{32}|easy-code-review-probe-[a-f0-9-]{36})$/u.test(id)
      : kind === "volume" ? /^easy-code-review-[a-f0-9]{48}$/u.test(id)
      : kind === "image" && /^localhost\/easy-code-review:[a-f0-9]{32}(?:-[a-f0-9]{16})?$/u.test(id);
    if (!valid) throw new Error("Select an exact EASY CODE resource name from sandbox resources; arbitrary IDs are not accepted");
    const inspect = async () => {
      const rows = JSON.parse(await checkedPodman(this.run, [kind, "inspect", id]));
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Invalid resource inspection");
      return rows[0];
    };
    const original = await inspect();
    const owner = (original.Labels ?? original.Config?.Labels)?.["io.easy-code.owner"];
    if (typeof owner !== "string" || !/^[a-f0-9]{64}$/u.test(owner)) throw new Error("Resource has no verified EASY CODE owner");
    const directory = path.resolve(this.stateRoot, owner);
    const root = await realpath(this.stateRoot);
    if ((await lstat(directory)).isSymbolicLink() || path.dirname(await realpath(directory)) !== root)
      throw new Error("Redirected/unowned Podman state directory");
    // The exact same lock is used by dispatch and review snapshotting. Existing
    // leases, including crashed/unknown execution, are never erased here.
    const lockPath = path.join(directory, "command.lease");
    const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error("Unfinished command/snapshot lease exists; inspect it before resource cleanup"); });
    let removalStarted = false, confirmed = false;
    try {
      await lock.writeFile(JSON.stringify({ operation: "resource_cleanup", kind, id, owner, pid: process.pid }));
      await lock.sync();
      const current = await inspect();
      const currentOwner = (current.Labels ?? current.Config?.Labels)?.["io.easy-code.owner"];
      if (currentOwner !== owner || (original.Id ?? original.ID ?? original.Name) !== (current.Id ?? current.ID ?? current.Name))
        throw new Error("Resource changed during cleanup");
      if (kind === "container" && (current.State?.Running || current.State?.Paused ||
        !["exited", "stopped", "configured", "created"].includes(current.State?.Status)))
        throw new Error("Only stopped containers may be removed; running or unknown state is preserved");
      // No --force: engine references protect volumes/images still used by a
      // main task, another review or a concurrently starting actor.
      if (kind !== "container") {
        const refs = JSON.parse(await checkedPodman(this.run, ["ps", "--all", "--filter", `${kind === "volume" ? "volume" : "ancestor"}=${id}`, "--format", "json"]));
        if (!Array.isArray(refs) || refs.length) throw new Error("Resource is referenced by a container; remove the stopped container first");
      }
      removalStarted = true;
      await checkedPodman(this.run, [kind === "image" ? "rmi" : kind === "volume" ? "volume" : "rm",
        ...(kind === "volume" ? ["rm"] : []), id]);
      const remaining = await this.run([kind, "exists", id]);
      if (remaining.exitCode !== 1) throw new Error("Resource removal could not be confirmed; do not retry blindly");
      confirmed = true;
    } catch (error) {
      // A rejected removal of a still-identical object is not an unknown
      // cleanup. Only lost/ambiguous engine state retains our maintenance lease.
      if (removalStarted) {
        try {
          const current = await inspect();
          confirmed = (original.Id ?? original.ID ?? original.Name) === (current.Id ?? current.ID ?? current.Name) &&
            (current.Labels ?? current.Config?.Labels)?.["io.easy-code.owner"] === owner;
        } catch { /* Keep the lease for inspection. */ }
      }
      throw error;
    } finally { await lock.close(); if (!removalStarted || confirmed) await rm(lockPath); }
  }
}
