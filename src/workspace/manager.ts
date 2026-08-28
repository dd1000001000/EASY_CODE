import type { FileChangeRecord, FileVersion } from "../core/types.js";
import { WorkspacePathGuard } from "./path-guard.js";
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  type SnapshotOptions,
  type WorkspaceDelta,
  type WorkspaceSnapshot,
} from "./snapshot.js";

export interface ManifestSummary {
  workspaceRoot: string;
  capturedAt: string;
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
  paths: string[];
}

export interface WorkspaceManagerOptions extends SnapshotOptions {
  manifestSummaryLimit?: number;
}

export interface WorkspaceRestoreSummary {
  /** Read authorizations that still match the current workspace bytes. */
  restoredReadVersions: number;
  /** Saved read authorizations rejected because the path is missing or changed. */
  staleReadVersions: number;
  /** Historical file-tool/command audit entries restored into the live manager. */
  restoredChanges: number;
  /** Invalid or duplicate historical audit entries omitted during rehydration. */
  discardedChanges: number;
}

/** Owns the workspace manifest, read versions and current ChangeSet. */
export class WorkspaceManager {
  readonly pathGuard: WorkspacePathGuard;
  private readonly options: WorkspaceManagerOptions;
  private readonly readVersions = new Map<string, FileVersion>();
  private readonly changes: FileChangeRecord[] = [];
  private manifest?: WorkspaceSnapshot;

  constructor(workspaceRoot: string, options: WorkspaceManagerOptions = {}) {
    this.pathGuard = new WorkspacePathGuard(workspaceRoot);
    this.options = options;
  }

  static async create(
    workspaceRoot: string,
    options: WorkspaceManagerOptions = {},
  ): Promise<WorkspaceManager> {
    const manager = new WorkspaceManager(workspaceRoot, options);
    await manager.refreshManifest();
    return manager;
  }

  get root(): string {
    return this.pathGuard.root;
  }

  recordRead(filename: string, hash: string): FileVersion {
    const relative = this.pathGuard.normalizeRelative(filename);
    const version: FileVersion = {
      path: relative,
      hash,
      readAt: new Date().toISOString(),
    };
    this.readVersions.set(relative, version);
    return { ...version };
  }

  getReadVersion(filename: string): FileVersion | undefined {
    const relative = this.pathGuard.normalizeRelative(filename);
    const version = this.readVersions.get(relative);
    return version ? { ...version } : undefined;
  }

  getReadVersions(): FileVersion[] {
    return [...this.readVersions.values()].map((entry) => ({ ...entry }));
  }

  /**
   * Rehydrate thread-scoped workspace state after `/resume`.
   *
   * A saved read version is an authorization boundary for update/delete tools,
   * so it is restored only when the fresh startup manifest proves that the
   * file still has exactly the hash the agent read previously. Historical
   * changes are audit records rather than authorizations and can be restored
   * independently. Invalid paths are ignored instead of making an otherwise
   * usable thread impossible to resume.
   */
  restorePersistedState(
    readVersions: ReadonlyMap<string, FileVersion>,
    changes: readonly FileChangeRecord[],
  ): WorkspaceRestoreSummary {
    this.readVersions.clear();
    this.changes.length = 0;

    let restoredReadVersions = 0;
    let staleReadVersions = 0;
    const manifestFiles = this.manifest?.files ?? new Map();
    for (const [savedPath, savedVersion] of readVersions) {
      try {
        const relative = this.pathGuard.normalizeRelative(savedPath);
        const versionPath = this.pathGuard.normalizeRelative(savedVersion.path);
        const current = manifestFiles.get(relative);
        if (
          relative !== versionPath ||
          !current ||
          current.kind !== "file" ||
          current.hash !== savedVersion.hash
        ) {
          staleReadVersions += 1;
          continue;
        }
        this.readVersions.set(relative, {
          path: relative,
          hash: savedVersion.hash,
          readAt: savedVersion.readAt,
        });
        restoredReadVersions += 1;
      } catch {
        staleReadVersions += 1;
      }
    }

    const knownChanges = new Set<string>();
    for (const change of changes) {
      try {
        const relative = this.pathGuard.normalizeRelative(change.path);
        const restored = { ...change, path: relative };
        const key = fileChangeIdentity(restored);
        if (knownChanges.has(key)) continue;
        knownChanges.add(key);
        this.changes.push(restored);
      } catch {
        // Old/corrupt audit paths must not escape the resumed workspace.
      }
    }

    return {
      restoredReadVersions,
      staleReadVersions,
      restoredChanges: this.changes.length,
      discardedChanges: Math.max(0, changes.length - this.changes.length),
    };
  }

  invalidateReadVersion(filename: string): void {
    const relative = this.pathGuard.normalizeRelative(filename);
    this.readVersions.delete(relative);
  }

  recordChange(change: FileChangeRecord): void {
    this.changes.push({ ...change });
  }

  getChangeSet(): FileChangeRecord[] {
    return this.changes.map((change) => ({ ...change }));
  }

  async captureSnapshot(): Promise<WorkspaceSnapshot> {
    return captureWorkspaceSnapshot(this.pathGuard, this.options);
  }

  async refreshManifest(): Promise<ManifestSummary> {
    this.manifest = await this.captureSnapshot();
    return this.getManifestSummary();
  }

  getManifestSnapshot(): WorkspaceSnapshot | undefined {
    if (!this.manifest) return undefined;
    return {
      capturedAt: this.manifest.capturedAt,
      truncated: this.manifest.truncated,
      files: new Map(this.manifest.files),
    };
  }

  getManifestSummary(limit = this.options.manifestSummaryLimit ?? 200): ManifestSummary {
    const snapshot = this.manifest ?? {
      capturedAt: new Date(0).toISOString(),
      files: new Map(),
      truncated: false,
    };
    const entries = [...snapshot.files.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    return {
      workspaceRoot: this.root,
      capturedAt: snapshot.capturedAt,
      fileCount: entries.length,
      totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
      truncated: snapshot.truncated || entries.length > limit,
      paths: entries.slice(0, limit).map((entry) => entry.path),
    };
  }

  applyCommandSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDelta {
    const delta = diffWorkspaceSnapshots(before, after);
    const timestamp = new Date().toISOString();

    for (const entry of delta.created) {
      this.readVersions.delete(entry.path);
      this.recordChange({
        path: entry.path,
        operation: "generated",
        afterHash: entry.hash,
        source: "command",
        status: "verified",
        timestamp,
      });
    }
    for (const entry of delta.updated) {
      this.readVersions.delete(entry.after.path);
      this.recordChange({
        path: entry.after.path,
        operation: "generated",
        beforeHash: entry.before.hash,
        afterHash: entry.after.hash,
        source: "command",
        status: "verified",
        timestamp,
      });
    }
    for (const entry of delta.deleted) {
      this.readVersions.delete(entry.path);
      this.recordChange({
        path: entry.path,
        operation: "deleted_by_command",
        beforeHash: entry.hash,
        source: "command",
        status: "policy_violation",
        timestamp,
      });
    }

    this.manifest = after;
    return delta;
  }
}

function fileChangeIdentity(change: Readonly<FileChangeRecord>): string {
  return [
    change.timestamp,
    change.path,
    change.operation,
    change.beforeHash ?? "",
    change.afterHash ?? "",
    change.source,
    change.status,
  ].join("|");
}
