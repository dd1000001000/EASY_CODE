import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workspaceIdFromRoot } from "../storage/database.js";
import { assertNoUninstall, assertPlainAncestors } from "../install/ownership.js";
import { ExecutionJournal } from "../command/execution-journal.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import { currentProcessIdentity, processOwnerProbe } from "../core/process-owner.js";

export interface RecoveryItem {
  commandId: string;
  status: "recoverable" | "blocked" | "recovered";
  reason: string;
}
export interface RecoveryReport {
  items: RecoveryItem[];
  quarantine: "absent" | "preserved" | "cleared";
}

const entries = async (directory: string): Promise<string[]> => readdir(directory).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
const optionalJson = async (file: string): Promise<any | undefined> => {
  assertPlainAncestors(file);
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};

/**
 * Reconciles only durable Runtime bookkeeping. Native sandbox processes have no
 * persistent container to inspect. An interrupted command is never replayed and
 * is cleared only when its owner is inactive and the trusted worker had already
 * recorded both a final outcome and cleanup before the interruption.
 */
export class SandboxRecovery {
  constructor(private readonly dataDir: string, private readonly limits: Readonly<RuntimeLimits>) { void this.limits; }

  async inspect(workspace: string, apply = false): Promise<RecoveryReport> {
    assertNoUninstall();
    workspace = path.resolve(workspace);
    const lifecycle = path.join(this.dataDir, "command-leases", workspaceIdFromRoot(workspace));
    assertPlainAncestors(lifecycle);
    const lockPath = path.join(lifecycle, "recovery.lock");
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    if (apply) {
      await mkdir(lifecycle, { recursive: true, mode: 0o700 });
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: os.hostname(), processIdentity: currentProcessIdentity() }));
      await lock.sync();
    }
    try {
      const report: RecoveryReport = { items: [], quarantine: "absent" };
      const probe = processOwnerProbe();
      for (const name of (await entries(lifecycle)).filter(value => value.endsWith(".lease"))) {
        const commandId = name.slice(0, -6);
        const leasePath = path.join(lifecycle, name);
        const item: RecoveryItem = { commandId, status: "blocked", reason: "Missing trusted native lifecycle evidence" };
        report.items.push(item);
        if (!/^[a-zA-Z0-9_-]+$/u.test(commandId)) continue;
        const lease = await optionalJson(leasePath);
        if (!lease || lease.version !== 2 || lease.commandId !== commandId) continue;
        if (probe({ ...lease, pid: lease.ownerPid }) !== "inactive") {
          item.reason = "Owner process is alive or unknown; no lease was removed";
          continue;
        }
        const eventFile = path.join(lifecycle, `${commandId}.events.jsonl`);
        const source = await readFile(eventFile, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        if (!source.endsWith("\n")) {
          item.reason = "Truncated lifecycle journal preserved";
          continue;
        }
        const events = source.split("\n").filter(Boolean).map(line => JSON.parse(line));
        if (events.some(event => event.commandId !== commandId)) throw new Error("Mismatched command lifecycle evidence");
        const reverseEvents = [...events].reverse();
        const cleanup = reverseEvents.find((event: any) => event.type === "cleanup_complete");
        const final = reverseEvents.find((event: any) => event.type === "finished" || event.type === "finalized");
        if (!cleanup || !final) {
          item.reason = "The command outcome or cleanup is unknown; inspect the workspace before resuming mutations";
          continue;
        }
        item.status = "recoverable";
        item.reason = "Owner is inactive and trusted lifecycle records prove cleanup and a final outcome; the command will not be replayed";
        if (apply) {
          new ExecutionJournal(lifecycle).record(commandId, "recovered", { backend: "native", replayed: false });
          await rm(leasePath);
          item.status = "recovered";
        }
      }
      const quarantine = path.join(this.dataDir, "command-quarantine", `${workspaceIdFromRoot(workspace)}.json`);
      const marker = await optionalJson(quarantine);
      if (marker) {
        report.quarantine = "preserved";
        if (apply && marker.version === 2 && marker.backend === "native" && path.resolve(marker.workspace) === workspace &&
          !(await entries(lifecycle)).some(name => name.endsWith(".lease"))) {
          await rm(quarantine);
          report.quarantine = "cleared";
        }
      }
      return report;
    } finally {
      if (lock) { await lock.close(); await rm(lockPath, { force: true }); }
    }
  }
}
