import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToUI } from "node:timers/promises";
import type { AgentTool, FileChangeRecord, ToolContext, ToolExecutionResult } from "../core/types.js";
import { withWorkspaceChangeSink, type WorkspaceManager } from "../workspace/manager.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import { coordinationPath, type CoordinationStore, type FileObservation } from "./store.js";

interface Snapshot {
  files: Map<string, string>;
  incomplete: Set<string>;
}
/** Whether a path existed before and after one tool call. */
interface Presence {
  before: boolean;
  after: boolean;
}
interface ObservedCall {
  context: ToolContext;
  tool: string;
  callId: string;
  pending: Map<string, Presence>;
}
const INTERNAL_DIRECTORIES = new Set([".git", ".easy-code-runtime", ".easycode"]);
// Bounded so an external-tool scan of a large folder cannot exhaust file descriptors.
const LSTAT_BATCH = 64;
function inside(root: string, file: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}

/** Presence implied by one recorded change; failed or conflicting writes did not happen. */
function changePresence(change: Readonly<FileChangeRecord>): Presence | undefined {
  if (change.status === "failed" || change.status === "conflict") return undefined;
  switch (change.operation) {
    case "create":
      return { before: false, after: true };
    case "update":
      return { before: true, after: true };
    case "generated":
      return { before: change.beforeHash !== undefined, after: true };
    case "delete":
    case "deleted_by_command":
      return { before: true, after: false };
  }
}

/**
 * Index which Threads changed which workspace files during their tool calls.
 *
 * Built-in tools already report every workspace change they make (file tools
 * directly, commands through their before/after delta), so their observations
 * come from those records without scanning the workspace. External tools do
 * not report changes; only they fall back to a metadata scan around the call.
 * Metadata observation, not attribution: no source content is stored or sent.
 */
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

  private excludedDirectories(): Set<string> {
    return new Set(
      [...INTERNAL_DIRECTORIES, ...this.limits.coordinationExcludeDirectories].map((v) => v.toLowerCase()),
    );
  }

  private protectedRoots(): string[] {
    return [...this.workspace.pathGuard.protectedPaths(), ...this.excludedRoots].map(coordinationPath);
  }

  private async snapshot(): Promise<Snapshot> {
    const snapshot: Snapshot = { files: new Map(), incomplete: new Set() };
    const excluded = this.excludedDirectories();
    const protectedRoots = this.protectedRoots();
    const started = Date.now();
    let scanned = 0;
    const exhausted = () =>
      scanned >= this.limits.coordinationScanMaxFiles || Date.now() - started > this.limits.coordinationScanTimeoutMs;
    const visit = async (directory: string): Promise<void> => {
      const key = coordinationPath(directory);
      if (protectedRoots.some((root) => inside(root, key))) return;
      if (exhausted()) {
        snapshot.incomplete.add(key);
        return;
      }
      const files: Array<{ filename: string; fileKey: string }> = [];
      const directories: string[] = [];
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const filename = path.join(directory, entry.name);
          const fileKey = coordinationPath(filename);
          if (protectedRoots.some((root) => inside(root, fileKey))) continue;
          if (exhausted()) {
            snapshot.incomplete.add(key);
            break;
          }
          if (entry.isDirectory()) {
            if (!excluded.has(entry.name.toLowerCase())) directories.push(filename);
          } else if (entry.isFile()) {
            scanned++;
            files.push({ filename, fileKey });
          }
        }
      } catch {
        snapshot.incomplete.add(key);
        return;
      }
      for (let offset = 0; offset < files.length; offset += LSTAT_BATCH) {
        await Promise.all(
          files.slice(offset, offset + LSTAT_BATCH).map(async ({ filename, fileKey }) => {
            try {
              const stat = await lstat(filename, { bigint: true });
              if (stat.isFile())
                snapshot.files.set(fileKey, `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`);
            } catch {
              snapshot.incomplete.add(fileKey);
            }
          }),
        );
      }
      for (const child of directories) await visit(child);
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

  private note(call: ObservedCall, file: string, presence: Presence): void {
    const existing = call.pending.get(file);
    call.pending.set(file, existing ? { before: existing.before, after: presence.after } : presence);
  }

  /** Accept a reported change unless it lies in a runtime, generated or excluded location. */
  private noteRecordedChange(
    call: ObservedCall,
    workspace: WorkspaceManager,
    change: Readonly<FileChangeRecord>,
  ): void {
    const presence = changePresence(change);
    if (!presence) return;
    const absolute = workspace.pathGuard.resolveLexical(change.path);
    const file = coordinationPath(absolute);
    if (this.protectedRoots().some((root) => inside(root, file))) return;
    const excluded = this.excludedDirectories();
    const directories = path.relative(workspace.rootForPath(absolute), absolute).split(path.sep).slice(0, -1);
    if (directories.some((name) => excluded.has(name.toLowerCase()))) return;
    this.note(call, file, presence);
  }

  private async noteScannedChanges(before: Snapshot, call: ObservedCall): Promise<void> {
    const after = await this.snapshot();
    const incomplete = [...before.incomplete, ...after.incomplete];
    for (const file of new Set([...before.files.keys(), ...after.files.keys()])) {
      if (incomplete.some((root) => inside(root, file))) continue;
      if (before.files.get(file) === after.files.get(file)) continue;
      this.note(call, file, { before: before.files.has(file), after: after.files.has(file) });
    }
    if (incomplete.length) this.report(`${incomplete.length} paths could not be fully scanned`);
  }

  private async flush(call: ObservedCall): Promise<void> {
    const changes: FileObservation[] = [];
    for (const [file, { before, after }] of call.pending) {
      if (!before && !after) continue;
      changes.push({
        threadId: call.context.threadId,
        turnId: call.context.turnId,
        callId: call.callId,
        agentId: call.context.agentId ?? call.context.threadId,
        tool: call.tool,
        path: file,
        operation: !before ? "created" : !after ? "deleted" : "modified",
      });
    }
    call.pending.clear();
    // Keep bulk changes from monopolizing the UI thread or SQLite's cross-process lock.
    for (let offset = 0; offset < changes.length; offset += 256) {
      this.store.record(changes.slice(offset, offset + 256));
      if (offset + 256 < changes.length) await yieldToUI();
    }
  }

  private track(work: Promise<void>): void {
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  private flushSafely(call: ObservedCall): Promise<void> {
    return this.flush(call).catch((error) => this.report(error));
  }

  async execute(tool: AgentTool, input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    if (!this.limits.coordinationEnabled) return tool.execute(input, context);
    const call: ObservedCall = {
      context,
      tool: tool.name,
      callId: context.toolCallId ?? `observation_${randomUUID()}`,
      pending: new Map(),
    };
    let returned = false;
    let lateFlush: Promise<void> | undefined;
    const sink = (workspace: WorkspaceManager, change: Readonly<FileChangeRecord>): void => {
      try {
        this.noteRecordedChange(call, workspace, change);
      } catch (error) {
        this.report(error);
        return;
      }
      // A continuation the call started (for example a background command)
      // reported a change after the call returned; index it on its own.
      if (returned && !lateFlush) {
        lateFlush = yieldToUI().then(() => {
          lateFlush = undefined;
          return this.flushSafely(call);
        });
        this.track(lateFlush);
      }
    };
    let before: Snapshot | undefined;
    if (tool.metadata?.identity.sourceKind !== "builtin") {
      try {
        before = await this.snapshot();
      } catch (error) {
        this.report(error);
      }
    }
    try {
      const result = await withWorkspaceChangeSink(sink, () => tool.execute(input, context));
      const data = result.data as { commandId?: string; status?: string } | undefined;
      if (tool.name === "start_command" && data?.status === "running" && data.commandId) {
        const done = this.settled?.(data.commandId);
        if (done) {
          // Lets drain() wait for the command; changes it reports are flushed on settlement.
          const complete = () => this.flushSafely(call);
          this.track(done.then(complete, complete));
        }
      }
      return result;
    } finally {
      returned = true;
      if (before) await this.noteScannedChanges(before, call).catch((error) => this.report(error));
      await this.flushSafely(call);
    }
  }

  async drain(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background]);
  }
}
