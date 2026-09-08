import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import type { ToolContext } from "../core/types.js";

const ownedLeases = new Set<string>();

/** An unfinished lease survives a crash. It is never interpreted as safe to retry. */
export class ExecutionJournal {
  constructor(private readonly directory?: string) {}

  assertRecovered(): void {
    if (!this.directory || !existsSync(this.directory)) return;
    if (readdirSync(this.directory).some(name => name.endsWith(".lease") && !ownedLeases.has(path.join(this.directory!, name)))) {
      throw new Error("Unfinished command lease found; execution/cleanup is unknown. Inspect the environment before resuming mutations");
    }
  }

  begin(commandId: string, context: ToolContext): void {
    if (!this.directory) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, `${commandId}.lease`);
    const fd = openSync(filename, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ commandId, threadId: context.threadId, turnId: context.turnId, ownerPid: process.pid, state: "preparing" }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    ownedLeases.add(filename);
  }

  complete(commandId: string): void {
    if (!this.directory) return;
    const filename = path.join(this.directory, `${commandId}.lease`);
    unlinkSync(filename);
    ownedLeases.delete(filename);
  }
}
