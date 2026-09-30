import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToUI } from "node:timers/promises";
import type { AgentTool, ToolContext, ToolExecutionResult } from "../core/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import { coordinationPath, type CoordinationStore, type FileObservation } from "./store.js";

interface Snapshot {
  files: Map<string, string>;
  incomplete: Set<string>;
}
const INTERNAL_DIRECTORIES = new Set([".git", ".easy-code-runtime", ".easycode"]);
function inside(root: string, file: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}

/** Metadata observation, not attribution. No source content is stored or sent. */
export class WorkspaceToolObserver {
  private readonly background = new Set<Promise<void>>();
  get hasPending(): boolean {
    return this.background.size > 0;
  }
  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly store: CoordinationStore,
    private readonly limits: Readonly<RuntimeLimits>,
    private readonly warn: (message: string) => void,
    private readonly settled?: (id: string) => Promise<void> | undefined,
    private readonly excludedRoots: readonly string[] = [],
  ) {}

  private async snapshot(): Promise<Snapshot> {
    const snapshot: Snapshot = { files: new Map(), incomplete: new Set() };
    const excluded = new Set(
      [...INTERNAL_DIRECTORIES, ...this.limits.coordinationExcludeDirectories].map((v) => v.toLowerCase()),
    );
    const protectedRoots = [...this.workspace.pathGuard.protectedPaths(), ...this.excludedRoots].map(coordinationPath);
    const started = Date.now();
    let scanned = 0;
    const visit = async (directory: string): Promise<void> => {
      const key = coordinationPath(directory);
      if (protectedRoots.some((root) => inside(root, key))) return;
      if (
        scanned >= this.limits.coordinationScanMaxFiles ||
        Date.now() - started > this.limits.coordinationScanTimeoutMs
      ) {
        snapshot.incomplete.add(key);
        return;
      }
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const filename = path.join(directory, entry.name);
          const fileKey = coordinationPath(filename);
          if (protectedRoots.some((root) => inside(root, fileKey))) continue;
          if (
            scanned >= this.limits.coordinationScanMaxFiles ||
            Date.now() - started > this.limits.coordinationScanTimeoutMs
          ) {
            snapshot.incomplete.add(key);
            break;
          }
          if (entry.isDirectory()) {
            if (!excluded.has(entry.name.toLowerCase())) await visit(filename);
          } else if (entry.isFile()) {
            scanned++;
            try {
              const stat = await lstat(filename, { bigint: true });
              if (stat.isFile())
                snapshot.files.set(fileKey, `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`);
            } catch {
              snapshot.incomplete.add(fileKey);
            }
          }
        }
      } catch {
        snapshot.incomplete.add(key);
      }
    };
    for (const root of this.workspace.writableRoots) await visit(root);
    return snapshot;
  }

  private report(error: unknown): void {
    try {
      this.warn(`Workspace change observation incomplete: ${String(error)}`);
    } catch {
      /* UI is not authoritative. */
    }
  }

  private async finish(before: Snapshot, context: ToolContext, tool: string, callId: string): Promise<void> {
    try {
      const after = await this.snapshot();
      const incomplete = [...before.incomplete, ...after.incomplete];
      const changes: FileObservation[] = [];
      for (const file of new Set([...before.files.keys(), ...after.files.keys()])) {
        if (incomplete.some((root) => inside(root, file))) continue;
        if (before.files.get(file) === after.files.get(file)) continue;
        changes.push({
          threadId: context.threadId,
          turnId: context.turnId,
          callId,
          agentId: context.agentId ?? context.threadId,
          tool,
          path: file,
          operation: !before.files.has(file) ? "created" : !after.files.has(file) ? "deleted" : "modified",
        });
      }
      // Keep bulk changes from monopolizing the UI thread or SQLite's cross-process lock.
      for (let offset = 0; offset < changes.length; offset += 256) {
        this.store.record(changes.slice(offset, offset + 256));
        if (offset + 256 < changes.length) await yieldToUI();
      }
      if (incomplete.length) this.report(`${incomplete.length} paths could not be fully scanned`);
    } catch (error) {
      this.report(error);
    }
  }

  async execute(tool: AgentTool, input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    if (!this.limits.coordinationEnabled) return tool.execute(input, context);
    let before: Snapshot | undefined;
    try {
      before = await this.snapshot();
    } catch (error) {
      this.report(error);
    }
    const callId = context.toolCallId ?? `observation_${randomUUID()}`;
    try {
      const result = await tool.execute(input, context);
      const data = result.data as { commandId?: string; status?: string } | undefined;
      if (before && tool.name === "start_command" && data?.status === "running" && data.commandId) {
        const done = this.settled?.(data.commandId);
        if (done) {
          const baseline = before;
          const complete = () => this.finish(baseline, context, tool.name, callId);
          const work = done.then(complete, complete);
          this.background.add(work);
          void work.finally(() => this.background.delete(work));
        }
      }
      return result;
    } finally {
      if (before) await this.finish(before, context, tool.name, callId);
    }
  }

  async drain(): Promise<void> {
    await Promise.all([...this.background]);
  }
}
