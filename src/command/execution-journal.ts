import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../core/types.js";
import { currentProcessIdentity } from "../core/process-owner.js";

const ownedLeases = new Set<string>();

/** An unfinished lease survives a crash. It is never interpreted as safe to retry. */
export class ExecutionJournal {
  constructor(private readonly directory?: string) {}

  assertRecovered(): void {
    if (!this.directory || !existsSync(this.directory)) return;
    if (existsSync(path.join(this.directory, "recovery.lock")) || readdirSync(this.directory).some(name => name.endsWith(".lease") && !ownedLeases.has(path.join(this.directory!, name)))) {
      throw new Error("Unfinished command lease found; execution/cleanup is unknown. Inspect the environment before resuming mutations");
    }
  }

  begin(commandId: string, context: ToolContext): void {
    if (!this.directory) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, `${commandId}.lease`);
    const fd = openSync(filename, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ version: 2, commandId, threadId: context.threadId, turnId: context.turnId,
        hostname: os.hostname(), ownerPid: process.pid, processIdentity: currentProcessIdentity(), state: "preparing", events: this.file(commandId) }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    ownedLeases.add(filename);
    this.record(commandId, "preparing", { threadId: context.threadId });
  }

  file(commandId: string): string | undefined {
    if (!/^[a-zA-Z0-9_-]+$/u.test(commandId)) throw new Error("Invalid command lifecycle ID");
    return this.directory ? path.join(this.directory, `${commandId}.events.jsonl`) : undefined;
  }

  record(commandId: string, type: string, payload: unknown): void {
    const file = this.file(commandId); if (!file) return;
    const descriptor = openSync(file, "a", 0o600);
    try { writeSync(descriptor, JSON.stringify({ version: 1, commandId, type, payload, at: new Date().toISOString() }) + "\n"); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
  }

  complete(commandId: string): void {
    if (!this.directory) return;
    const filename = path.join(this.directory, `${commandId}.lease`);
    this.record(commandId, "finalized", {});
    unlinkSync(filename);
    ownedLeases.delete(filename);
  }
}
