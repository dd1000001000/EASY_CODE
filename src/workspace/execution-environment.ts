import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import type {
  ExecutionEnvironmentSnapshot,
  ResultArtifact,
  ResultArtifactRef,
  SubagentIsolationMode,
  WorktreeBaseMode,
} from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import { WorkspaceManager } from "./manager.js";
import { WorkspacePathGuard } from "./path-guard.js";

const MAX_INCLUDED_FILES = 2_000;
const MAX_INCLUDED_BYTES = 128 * 1024 * 1024;
const ENVIRONMENT_SCHEMA_VERSION = 1;

interface PersistedEnvironment {
  schemaVersion: number;
  environment: ExecutionEnvironmentSnapshot;
}

interface PersistedArtifact {
  schemaVersion: number;
  artifact: ResultArtifact;
}

export interface ExecutionEnvironmentManagerOptions {
  readonly logicalWorkspaceRoot: string;
  readonly dataDir: string;
  readonly defaultIsolation?: SubagentIsolationMode;
  readonly baseMode?: WorktreeBaseMode;
  readonly worktreeRoot?: string;
  readonly maxManagedWorktrees?: number;
}

export interface ProvisionExecutionEnvironmentInput {
  readonly agentId: string;
  readonly parentThreadId?: string;
  readonly childThreadId?: string;
  readonly taskId?: string;
  readonly environmentId?: string;
  readonly requestedIsolation?: SubagentIsolationMode;
  /** Accepted dependency results. Divergent Worktree commits are merged before start. */
  readonly dependencyArtifacts?: readonly ResultArtifactRef[];
}

export interface ActiveExecutionEnvironment {
  readonly descriptor: ExecutionEnvironmentSnapshot;
  readonly workspace: WorkspaceManager;
}

export interface FinalizeExecutionEnvironmentInput {
  readonly agentId: string;
  readonly taskId: string;
  readonly accepted: boolean;
  readonly parentArtifactIds?: readonly string[];
}

export type HandoffDestination =
  | { readonly type: "local" }
  | { readonly type: "branch"; readonly branchName?: string };

export class WorktreeConflictError extends Error {
  readonly environment: ExecutionEnvironmentSnapshot;
  readonly files: readonly string[];

  constructor(
    message: string,
    environment: ExecutionEnvironmentSnapshot,
    files: readonly string[],
  ) {
    super(message);
    this.name = "WorktreeConflictError";
    this.environment = cloneEnvironment(environment);
    this.files = [...files];
  }
}

/**
 * Runtime-owned execution environments for child agents.
 *
 * A shared environment preserves the legacy serialized-write behavior. A
 * managed worktree is detached, bound to one child session, checkpointed with
 * hidden refs, and can be reconstructed after the directory is cleaned up.
 */
export class ExecutionEnvironmentManager {
  readonly logicalWorkspaceRoot: string;
  readonly worktreeRoot: string;
  private readonly dataDir: string;
  private readonly defaultIsolation: SubagentIsolationMode;
  private readonly baseMode: WorktreeBaseMode;
  private readonly environmentDir: string;
  private readonly artifactDir: string;
  private readonly maxManagedWorktrees: number;

  constructor(options: ExecutionEnvironmentManagerOptions) {
    this.logicalWorkspaceRoot = path.normalize(
      realpathSync.native(path.resolve(options.logicalWorkspaceRoot)),
    );
    this.dataDir = path.resolve(options.dataDir);
    this.defaultIsolation = options.defaultIsolation ?? "auto";
    this.baseMode = options.baseMode ?? "current-snapshot";
    this.worktreeRoot = path.resolve(
      options.worktreeRoot ?? path.join(this.dataDir, "worktrees"),
    );
    if (pathsOverlap(this.logicalWorkspaceRoot, this.worktreeRoot)) {
      throw new Error("Managed Worktree storage must be outside the logical workspace");
    }
    this.environmentDir = path.join(this.dataDir, "subagent-environments");
    this.artifactDir = path.join(this.dataDir, "subagent-artifacts");
    this.maxManagedWorktrees = options.maxManagedWorktrees ?? 15;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.worktreeRoot, { recursive: true }),
      mkdir(this.environmentDir, { recursive: true }),
      mkdir(this.artifactDir, { recursive: true }),
    ]);
    const managedRootInfo = await lstat(this.worktreeRoot);
    if (managedRootInfo.isSymbolicLink()) {
      throw new Error("Managed Worktree root cannot be a symbolic link or junction");
    }
    if (pathsOverlap(this.logicalWorkspaceRoot, await realpath(this.worktreeRoot))) {
      throw new Error("Managed Worktree storage resolves inside the logical workspace");
    }
  }

  async provision(
    input: ProvisionExecutionEnvironmentInput,
  ): Promise<ActiveExecutionEnvironment> {
    await this.initialize();
    const requestedIsolation = input.requestedIsolation ?? this.defaultIsolation;
    const repository = await discoverRepository(this.logicalWorkspaceRoot);
    const kind = requestedIsolation === "shared"
      ? "shared"
      : repository
        ? "worktree"
        : requestedIsolation === "worktree"
          ? undefined
          : "shared";
    if (!kind) {
      throw new Error("Worktree isolation requires the workspace to be inside a Git repository");
    }
    const dependencyArtifacts = [...(input.dependencyArtifacts ?? [])];
    for (const artifact of dependencyArtifacts) {
      if (artifact.status === "conflicted" || artifact.status === "retained") {
        throw new Error(`Dependency artifact ${artifact.id} is not ready for DAG lineage`);
      }
    }
    if (
      kind === "shared" &&
      dependencyArtifacts.some((artifact) => artifact.environmentKind === "worktree")
    ) {
      throw new Error(
        "A shared child cannot consume an isolated Worktree result before explicit integration",
      );
    }

    const now = new Date().toISOString();
    const id = input.environmentId ?? `environment_${randomUUID()}`;
    if (kind === "shared") {
      const descriptor: ExecutionEnvironmentSnapshot = {
        id,
        agentId: input.agentId,
        ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        ...(input.childThreadId ? { childThreadId: input.childThreadId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        kind,
        status: "ready",
        logicalWorkspaceRoot: this.logicalWorkspaceRoot,
        executionRoot: this.logicalWorkspaceRoot,
        requestedIsolation,
        baseMode: this.baseMode,
        createdAt: now,
        updatedAt: now,
      };
      await this.persistEnvironment(descriptor);
      return {
        descriptor: cloneEnvironment(descriptor),
        workspace: await WorkspaceManager.create(descriptor.executionRoot),
      };
    }

    const repositoryRoot = repository as string;
    if (pathsOverlap(repositoryRoot, await realpath(this.worktreeRoot))) {
      throw new Error(
        "Managed Worktree storage must be outside the complete Git repository",
      );
    }
    await this.assertWorktreeCapacity(id);
    const relativeWorkspace = path.relative(repositoryRoot, this.logicalWorkspaceRoot);
    if (
      relativeWorkspace === ".." ||
      relativeWorkspace.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeWorkspace)
    ) {
      throw new Error("Logical workspace is not contained by its Git repository root");
    }
    const repositoryId = sha256(normalizePathIdentity(repositoryRoot)).slice(0, 24);
    const managedRoot = path.join(this.worktreeRoot, repositoryId, safePathSegment(id));
    const executionRoot = relativeWorkspace
      ? path.join(managedRoot, relativeWorkspace)
      : managedRoot;
    const descriptor: ExecutionEnvironmentSnapshot = {
      id,
      agentId: input.agentId,
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      ...(input.childThreadId ? { childThreadId: input.childThreadId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      kind,
      status: "provisioning",
      logicalWorkspaceRoot: this.logicalWorkspaceRoot,
      executionRoot,
      requestedIsolation,
      baseMode: this.baseMode,
      repositoryRoot,
      worktreeRoot: managedRoot,
      createdAt: now,
      updatedAt: now,
    };
    await this.persistEnvironment(descriptor);

    try {
      const dependencyKinds = new Set(
        dependencyArtifacts.map((artifact) => artifact.environmentKind),
      );
      if (dependencyKinds.size > 1) {
        throw new Error(
          "A Worktree child cannot silently combine shared and isolated dependency results; integrate or hand off them first",
        );
      }
      for (const artifact of dependencyArtifacts) {
        if (
          artifact.environmentKind === "worktree" && !artifact.resultCommit
        ) {
          throw new Error(`Dependency artifact ${artifact.id} is not ready for DAG lineage`);
        }
      }
      const dependencyCommits = uniqueNonEmpty(
        dependencyArtifacts.flatMap((artifact) =>
          artifact.environmentKind === "worktree" && artifact.resultCommit
            ? [artifact.resultCommit]
            : [],
        ),
      );
      const selectedBase = dependencyCommits[0] ??
        await resolveBaseCommit(repositoryRoot, this.baseMode);
      descriptor.baseCommit = selectedBase;
      await mkdir(path.dirname(managedRoot), { recursive: true });
      await git(repositoryRoot, ["worktree", "add", "--detach", managedRoot, selectedBase]);

      if (dependencyCommits.length > 1) {
        await mergeDependencyCommits(managedRoot, dependencyCommits.slice(1), descriptor);
      } else if (dependencyCommits.length === 0 && this.baseMode === "current-snapshot") {
        await applyCurrentWorkspaceSnapshot(repositoryRoot, managedRoot);
      }

      await copyWorktreeIncludes(repositoryRoot, managedRoot);
      descriptor.baselineCommit = await checkpointWorktree(
        managedRoot,
        "EASY CODE internal baseline snapshot",
      );
      const dependencyBases = uniqueNonEmpty(
        dependencyArtifacts.flatMap((artifact) =>
          artifact.environmentKind === "worktree" && artifact.baseCommit
            ? [artifact.baseCommit]
            : [],
        ),
      );
      if (
        dependencyArtifacts.some(
          (artifact) =>
            artifact.environmentKind === "worktree" && !artifact.baseCommit,
        )
      ) {
        throw new Error("A Worktree dependency is missing its handoff base snapshot");
      }
      if (dependencyBases.length > 1) {
        const trees = await Promise.all(dependencyBases.map(async (commit) =>
          (await git(repositoryRoot, ["rev-parse", `${commit}^{tree}`])).trim(),
        ));
        if (new Set(trees).size !== 1) {
          throw new Error(
            "Dependency artifacts do not share one logical handoff baseline",
          );
        }
      }
      descriptor.handoffBaseCommit = dependencyBases[0] ?? descriptor.baselineCommit;
      descriptor.snapshotRef = environmentRef(id, "baseline");
      await git(repositoryRoot, [
        "update-ref",
        descriptor.snapshotRef,
        descriptor.baselineCommit,
      ]);
      descriptor.status = "ready";
      descriptor.updatedAt = new Date().toISOString();
      await this.persistEnvironment(descriptor);
      return {
        descriptor: cloneEnvironment(descriptor),
        workspace: await WorkspaceManager.create(executionRoot),
      };
    } catch (error) {
      descriptor.status = error instanceof WorktreeConflictError ? "conflicted" : "failed";
      descriptor.updatedAt = new Date().toISOString();
      await this.persistEnvironment(descriptor).catch(() => undefined);
      throw error;
    }
  }

  /** Restore the exact child checkout or reconstruct it from the durable Git ref. */
  async restore(environmentId: string): Promise<ActiveExecutionEnvironment> {
    const descriptor = await this.loadEnvironment(environmentId);
    if (descriptor.kind === "shared") {
      return {
        descriptor,
        workspace: await WorkspaceManager.create(descriptor.logicalWorkspaceRoot),
      };
    }
    if (!descriptor.repositoryRoot || !descriptor.worktreeRoot) {
      throw new Error(`Worktree environment ${environmentId} is missing repository metadata`);
    }

    if (existsSync(descriptor.worktreeRoot)) {
      await verifyManagedWorktree(descriptor.repositoryRoot, descriptor.worktreeRoot);
    } else {
      const restoreCommit = descriptor.resultCommit ??
        descriptor.baselineCommit ??
        descriptor.baseCommit;
      if (!restoreCommit) {
        throw new Error(`Worktree environment ${environmentId} has no restorable snapshot`);
      }
      await mkdir(path.dirname(descriptor.worktreeRoot), { recursive: true });
      await git(descriptor.repositoryRoot, [
        "worktree",
        "add",
        "--detach",
        descriptor.worktreeRoot,
        restoreCommit,
      ]);
    }
    descriptor.status = descriptor.resultCommit ? "result_ready" : "ready";
    descriptor.updatedAt = new Date().toISOString();
    await this.persistEnvironment(descriptor);
    return {
      descriptor: cloneEnvironment(descriptor),
      workspace: await WorkspaceManager.create(descriptor.executionRoot),
    };
  }

  async markRunning(environmentId: string): Promise<ExecutionEnvironmentSnapshot> {
    const descriptor = await this.loadEnvironment(environmentId);
    descriptor.status = "running";
    descriptor.updatedAt = new Date().toISOString();
    await this.persistEnvironment(descriptor);
    return descriptor;
  }

  /** Persist in-progress Worktree bytes so a missing checkout can be rebuilt on resume. */
  async checkpoint(
    environment: ActiveExecutionEnvironment,
    status: "ready" | "running" =
      environment.descriptor.status === "running" ? "running" : "ready",
  ): Promise<ExecutionEnvironmentSnapshot> {
    const descriptor = cloneEnvironment(environment.descriptor);
    await this.assertEnvironmentDescriptor(descriptor);
    if (descriptor.kind === "worktree") {
      if (!descriptor.worktreeRoot || !descriptor.repositoryRoot) {
        throw new Error(`Worktree environment ${descriptor.id} is incomplete`);
      }
      await verifyManagedWorktree(descriptor.repositoryRoot, descriptor.worktreeRoot);
      descriptor.resultCommit = await checkpointWorktree(
        descriptor.worktreeRoot,
        `EASY CODE resumable checkpoint for ${descriptor.id}`,
      );
      descriptor.snapshotRef = environmentRef(descriptor.id, "result");
      await git(descriptor.repositoryRoot, [
        "update-ref",
        descriptor.snapshotRef,
        descriptor.resultCommit,
      ]);
    }
    descriptor.status = status;
    descriptor.updatedAt = new Date().toISOString();
    await this.persistEnvironment(descriptor);
    return cloneEnvironment(descriptor);
  }

  async finalize(
    environment: ActiveExecutionEnvironment,
    input: FinalizeExecutionEnvironmentInput,
  ): Promise<ResultArtifact> {
    const descriptor = cloneEnvironment(environment.descriptor);
    await this.assertEnvironmentDescriptor(descriptor);
    if (
      (descriptor.agentId !== undefined && descriptor.agentId !== input.agentId) ||
      (descriptor.taskId !== undefined && descriptor.taskId !== input.taskId)
    ) {
      throw new Error(`Execution environment ${descriptor.id} is bound to another child task`);
    }
    const now = new Date().toISOString();
    let changedFiles: string[];
    let artifactBaseCommit: string | undefined;

    if (descriptor.kind === "worktree") {
      if (!descriptor.worktreeRoot || !descriptor.repositoryRoot) {
        throw new Error(`Worktree environment ${descriptor.id} is incomplete`);
      }
      await verifyManagedWorktree(descriptor.repositoryRoot, descriptor.worktreeRoot);
      const baseline = descriptor.handoffBaseCommit ??
        descriptor.baselineCommit ??
        descriptor.baseCommit;
      if (!baseline) throw new Error(`Worktree environment ${descriptor.id} has no baseline`);
      artifactBaseCommit = baseline;
      descriptor.resultCommit = await checkpointWorktree(
        descriptor.worktreeRoot,
        `EASY CODE result for ${input.agentId} / ${input.taskId}`,
      );
      descriptor.snapshotRef = environmentRef(descriptor.id, "result");
      await git(descriptor.repositoryRoot, [
        "update-ref",
        descriptor.snapshotRef,
        descriptor.resultCommit,
      ]);
      changedFiles = nulList(await git(
        descriptor.repositoryRoot,
        ["diff", "--name-only", "-z", baseline, descriptor.resultCommit, "--"],
      ));
      descriptor.status = input.accepted ? "result_ready" : "retained";
    } else {
      changedFiles = [...new Set(
        environment.workspace.getChangeSet().map((change) => change.path),
      )].sort((left, right) => left.localeCompare(right));
      descriptor.status = input.accepted ? "handed_off" : "retained";
    }
    descriptor.updatedAt = now;
    await this.persistEnvironment(descriptor);

    const artifact: ResultArtifact = {
      id: `artifact_${randomUUID()}`,
      agentId: input.agentId,
      taskId: input.taskId,
      environmentId: descriptor.id,
      environmentKind: descriptor.kind,
      status: descriptor.kind === "shared"
        ? input.accepted ? "delivered" : "retained"
        : input.accepted ? "ready" : "retained",
      logicalWorkspaceRoot: descriptor.logicalWorkspaceRoot,
      ...(artifactBaseCommit ? { baseCommit: artifactBaseCommit } : {}),
      ...(descriptor.resultCommit ? { resultCommit: descriptor.resultCommit } : {}),
      ...(descriptor.snapshotRef ? { snapshotRef: descriptor.snapshotRef } : {}),
      parentArtifactIds: [...(input.parentArtifactIds ?? [])],
      changedFiles,
      createdAt: now,
      updatedAt: now,
      ...(descriptor.kind === "shared" && input.accepted
        ? { deliveredAt: now, delivery: "local" as const }
        : {}),
    };
    await this.persistArtifact(artifact);
    return cloneArtifact(artifact);
  }

  async handoff(
    artifactInput: Readonly<ResultArtifact>,
    destination: HandoffDestination,
  ): Promise<ResultArtifact> {
    const artifact = cloneArtifact(artifactInput);
    if (artifact.environmentKind !== "worktree") {
      if (destination.type === "branch") {
        throw new Error("A shared child result has no isolated commit to preserve as a branch");
      }
      return artifact;
    }
    if (!artifact.baseCommit || !artifact.resultCommit) {
      throw new Error(`Artifact ${artifact.id} has no Git result snapshot`);
    }
    const repositoryRoot = await discoverRepository(artifact.logicalWorkspaceRoot);
    if (!repositoryRoot) throw new Error("The artifact's logical workspace is no longer a Git repository");
    const descriptor = await this.loadEnvironment(artifact.environmentId);
    if (
      !descriptor.repositoryRoot ||
      normalizePathIdentity(descriptor.repositoryRoot) !== normalizePathIdentity(repositoryRoot) ||
      (descriptor.agentId !== undefined && descriptor.agentId !== artifact.agentId) ||
      (descriptor.taskId !== undefined && descriptor.taskId !== artifact.taskId)
    ) {
      throw new Error("The artifact identity no longer matches its saved execution environment");
    }

    if (destination.type === "branch") {
      const branchName = destination.branchName ??
        `easy-code/${safeBranchSegment(artifact.taskId)}-${artifact.agentId.slice(-8)}`;
      await git(repositoryRoot, ["check-ref-format", "--branch", branchName]);
      let existingCommit: string | undefined;
      try {
        existingCommit = (await git(repositoryRoot, [
          "rev-parse",
          "--verify",
          `refs/heads/${branchName}^{commit}`,
        ])).trim();
      } catch {
        // A missing branch is created below.
      }
      if (existingCommit && existingCommit !== artifact.resultCommit) {
        artifact.status = "conflicted";
        artifact.updatedAt = new Date().toISOString();
        descriptor.status = "conflicted";
        descriptor.updatedAt = artifact.updatedAt;
        await Promise.all([
          this.persistArtifact(artifact),
          this.persistEnvironment(descriptor),
        ]);
        return cloneArtifact(artifact);
      }
      if (!existingCommit) {
        await git(repositoryRoot, ["branch", branchName, artifact.resultCommit]);
      }
      artifact.status = "delivered";
      artifact.delivery = "branch";
      artifact.branchName = branchName;
    } else {
      const patch = await git(repositoryRoot, [
        "diff",
        "--binary",
        artifact.baseCommit,
        artifact.resultCommit,
        "--",
      ]);
      if (patch.length > 0) {
        let alreadyApplied = false;
        try {
          await git(repositoryRoot, ["apply", "--check", "--whitespace=nowarn", "-"], patch);
          await git(repositoryRoot, ["apply", "--whitespace=nowarn", "-"], patch);
        } catch {
          try {
            await git(repositoryRoot, [
              "apply",
              "--reverse",
              "--check",
              "--whitespace=nowarn",
              "-",
            ], patch);
            alreadyApplied = true;
          } catch {
            artifact.status = "conflicted";
            artifact.updatedAt = new Date().toISOString();
            await this.persistArtifact(artifact);
            descriptor.status = "conflicted";
            descriptor.updatedAt = artifact.updatedAt;
            await this.persistEnvironment(descriptor);
            return cloneArtifact(artifact);
          }
        }
        if (alreadyApplied) artifact.delivery = "local";
      }
      artifact.status = "delivered";
      artifact.delivery = "local";
      delete artifact.branchName;
    }

    const now = new Date().toISOString();
    artifact.deliveredAt = now;
    artifact.updatedAt = now;
    descriptor.status = "handed_off";
    descriptor.updatedAt = now;
    await Promise.all([
      this.persistArtifact(artifact),
      this.persistEnvironment(descriptor),
    ]);
    return cloneArtifact(artifact);
  }

  /** Remove only a validated manager-owned worktree. Result refs remain restorable. */
  async cleanup(environmentId: string, force = false): Promise<ExecutionEnvironmentSnapshot> {
    const descriptor = await this.loadEnvironment(environmentId);
    if (descriptor.kind === "shared") return descriptor;
    if (!descriptor.repositoryRoot || !descriptor.worktreeRoot) {
      throw new Error(`Worktree environment ${environmentId} is incomplete`);
    }
    if (existsSync(descriptor.worktreeRoot)) {
      await verifyManagedWorktree(descriptor.repositoryRoot, descriptor.worktreeRoot);
      const status = await git(descriptor.worktreeRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (status.trim() && !force) {
        descriptor.status = "retained";
        descriptor.updatedAt = new Date().toISOString();
        await this.persistEnvironment(descriptor);
        return descriptor;
      }
      await git(descriptor.repositoryRoot, [
        "worktree",
        "remove",
        ...(force ? ["--force"] : []),
        descriptor.worktreeRoot,
      ]);
    }
    descriptor.status = "removed";
    descriptor.updatedAt = new Date().toISOString();
    await this.persistEnvironment(descriptor);
    return descriptor;
  }

  async loadEnvironment(environmentId: string): Promise<ExecutionEnvironmentSnapshot> {
    const filename = this.environmentFile(environmentId);
    const parsed = JSON.parse(await readFile(filename, "utf8")) as PersistedEnvironment;
    if (
      parsed?.schemaVersion !== ENVIRONMENT_SCHEMA_VERSION ||
      !isExecutionEnvironmentSnapshot(parsed.environment) ||
      parsed.environment.id !== environmentId
    ) {
      throw new Error(`Invalid execution environment record: ${environmentId}`);
    }
    const descriptor = cloneEnvironment(parsed.environment);
    await this.assertEnvironmentDescriptor(descriptor);
    return descriptor;
  }

  async loadArtifact(artifactId: string): Promise<ResultArtifact> {
    const parsed = JSON.parse(await readFile(this.artifactFile(artifactId), "utf8")) as PersistedArtifact;
    if (
      parsed?.schemaVersion !== ENVIRONMENT_SCHEMA_VERSION ||
      !isResultArtifact(parsed.artifact) ||
      parsed.artifact.id !== artifactId
    ) {
      throw new Error(`Invalid result artifact record: ${artifactId}`);
    }
    return cloneArtifact(parsed.artifact);
  }

  private async persistEnvironment(environment: ExecutionEnvironmentSnapshot): Promise<void> {
    await writeJsonAtomic(this.environmentFile(environment.id), {
      schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
      environment: cloneEnvironment(environment),
    } satisfies PersistedEnvironment);
  }

  private async persistArtifact(artifact: ResultArtifact): Promise<void> {
    await writeJsonAtomic(this.artifactFile(artifact.id), {
      schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
      artifact: cloneArtifact(artifact),
    } satisfies PersistedArtifact);
  }

  private environmentFile(environmentId: string): string {
    return path.join(this.environmentDir, `${safePathSegment(environmentId)}.json`);
  }

  private artifactFile(artifactId: string): string {
    return path.join(this.artifactDir, `${safePathSegment(artifactId)}.json`);
  }

  /**
   * Treat every durable execution descriptor as untrusted input. Besides the
   * Git common-directory check performed for an existing checkout, validate
   * the complete path relationship before any saved path is used as a cwd or
   * passed to `git worktree`.
   */
  private async assertEnvironmentDescriptor(
    descriptor: Readonly<ExecutionEnvironmentSnapshot>,
  ): Promise<void> {
    if (
      normalizePathIdentity(descriptor.logicalWorkspaceRoot) !==
      normalizePathIdentity(this.logicalWorkspaceRoot)
    ) {
      throw new Error("Saved execution environment belongs to another logical workspace");
    }

    if (descriptor.kind === "shared") {
      if (
        normalizePathIdentity(descriptor.executionRoot) !==
          normalizePathIdentity(this.logicalWorkspaceRoot) ||
        descriptor.repositoryRoot !== undefined ||
        descriptor.worktreeRoot !== undefined
      ) {
        throw new Error("Saved shared execution environment has unsafe path metadata");
      }
      return;
    }

    if (!descriptor.repositoryRoot || !descriptor.worktreeRoot) {
      throw new Error(`Worktree environment ${descriptor.id} is missing repository metadata`);
    }
    const repositoryRoot = await discoverRepository(this.logicalWorkspaceRoot);
    if (
      !repositoryRoot ||
      normalizePathIdentity(repositoryRoot) !==
        normalizePathIdentity(descriptor.repositoryRoot)
    ) {
      throw new Error("Saved Worktree repository identity no longer matches the workspace");
    }

    assertManagedPath(this.worktreeRoot, descriptor.worktreeRoot);
    const repositoryId = sha256(normalizePathIdentity(repositoryRoot)).slice(0, 24);
    const expectedWorktreeRoot = path.join(
      this.worktreeRoot,
      repositoryId,
      safePathSegment(descriptor.id),
    );
    if (
      normalizePathIdentity(descriptor.worktreeRoot) !==
      normalizePathIdentity(expectedWorktreeRoot)
    ) {
      throw new Error("Saved Worktree path is not the Runtime-managed environment path");
    }
    await assertPhysicallyManagedPath(this.worktreeRoot, descriptor.worktreeRoot);

    const relativeWorkspace = path.relative(
      descriptor.repositoryRoot,
      descriptor.logicalWorkspaceRoot,
    );
    if (
      relativeWorkspace === ".." ||
      relativeWorkspace.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeWorkspace)
    ) {
      throw new Error("Saved logical workspace is outside its Git repository");
    }
    const expectedExecutionRoot = relativeWorkspace
      ? path.join(descriptor.worktreeRoot, relativeWorkspace)
      : descriptor.worktreeRoot;
    assertPathInsideOrEqual(descriptor.worktreeRoot, descriptor.executionRoot);
    if (
      normalizePathIdentity(descriptor.executionRoot) !==
      normalizePathIdentity(expectedExecutionRoot)
    ) {
      throw new Error("Saved execution root does not match the logical workspace mapping");
    }
    await assertPhysicallyContainedPath(
      descriptor.worktreeRoot,
      descriptor.executionRoot,
    );
  }

  private async assertWorktreeCapacity(environmentId: string): Promise<void> {
    let active = 0;
    for (const entry of await readdir(this.environmentDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      if (entry.name === `${safePathSegment(environmentId)}.json`) return;
      try {
        const parsed = JSON.parse(
          await readFile(path.join(this.environmentDir, entry.name), "utf8"),
        ) as PersistedEnvironment;
        if (
          parsed.schemaVersion === ENVIRONMENT_SCHEMA_VERSION &&
          isExecutionEnvironmentSnapshot(parsed.environment) &&
          parsed.environment.kind === "worktree" &&
          parsed.environment.status !== "removed" &&
          parsed.environment.status !== "failed"
        ) {
          active += 1;
        }
      } catch {
        // Invalid records are ignored here and rejected if explicitly loaded.
      }
    }
    if (active >= this.maxManagedWorktrees) {
      throw new Error(
        `Managed Worktree limit reached (${this.maxManagedWorktrees}); hand off or clean an older child environment first`,
      );
    }
  }
}

async function discoverRepository(workspaceRoot: string): Promise<string | undefined> {
  try {
    return path.normalize((await git(workspaceRoot, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return undefined;
  }
}

async function resolveBaseCommit(
  repositoryRoot: string,
  mode: WorktreeBaseMode,
): Promise<string> {
  if (mode === "fresh") {
    try {
      const symbolic = (await git(repositoryRoot, [
        "symbolic-ref",
        "--quiet",
        "refs/remotes/origin/HEAD",
      ])).trim();
      if (symbolic) return (await git(repositoryRoot, ["rev-parse", symbolic])).trim();
    } catch {
      // Repositories without a configured remote fall back to local HEAD.
    }
  }
  return (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
}

async function applyCurrentWorkspaceSnapshot(
  repositoryRoot: string,
  worktreeRoot: string,
): Promise<void> {
  const patch = await git(repositoryRoot, ["diff", "--binary", "HEAD", "--"]);
  if (patch.length > 0) {
    await git(worktreeRoot, ["apply", "--whitespace=nowarn", "-"], patch);
  }
  const untracked = nulList(await git(repositoryRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]));
  await copyRepositoryPaths(repositoryRoot, worktreeRoot, untracked);
}

async function copyWorktreeIncludes(repositoryRoot: string, worktreeRoot: string): Promise<void> {
  const includePath = path.join(repositoryRoot, ".worktreeinclude");
  let source: string;
  try {
    source = await readFile(includePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const patterns = source
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && isSafeIncludePattern(line));
  const matches = new Set<string>();
  for (const pattern of patterns.slice(0, 256)) {
    for (const filename of nulList(await git(repositoryRoot, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      pattern,
    ]))) {
      matches.add(filename);
      if (matches.size > MAX_INCLUDED_FILES) {
        throw new Error(`.worktreeinclude matched more than ${MAX_INCLUDED_FILES} files`);
      }
    }
  }
  await copyRepositoryPaths(repositoryRoot, worktreeRoot, [...matches], false);
}

function isSafeIncludePattern(pattern: string): boolean {
  return (
    !path.isAbsolute(pattern) &&
    !/^[A-Za-z]:[\\/]/u.test(pattern) &&
    !pattern.split(/[\\/]+/u).includes("..") &&
    !pattern.includes("\0")
  );
}

async function copyRepositoryPaths(
  sourceRoot: string,
  destinationRoot: string,
  filenames: readonly string[],
  allowSymlinks = true,
): Promise<void> {
  const sourceGuard = new WorkspacePathGuard(sourceRoot);
  const destinationGuard = new WorkspacePathGuard(destinationRoot);
  let copiedBytes = 0;
  if (filenames.length > MAX_INCLUDED_FILES) {
    throw new Error(`Snapshot contains more than ${MAX_INCLUDED_FILES} untracked files`);
  }
  for (const filename of filenames) {
    const relative = sourceGuard.normalizeRelative(filename);
    const source = sourceGuard.resolveLexical(relative);
    const destination = await destinationGuard.resolveForCreate(relative, true);
    const info = await lstat(source);
    copiedBytes += info.size;
    if (copiedBytes > MAX_INCLUDED_BYTES) {
      throw new Error(`Snapshot files exceed ${MAX_INCLUDED_BYTES} bytes`);
    }
    if (info.isSymbolicLink()) {
      if (!allowSymlinks) {
        throw new Error(`.worktreeinclude cannot copy symbolic link: ${relative}`);
      }
      const target = await readlink(source);
      await symlink(target, destination, process.platform === "win32" ? "file" : undefined);
    } else if (info.isFile()) {
      await copyFile(source, destination);
    }
  }
}

async function mergeDependencyCommits(
  worktreeRoot: string,
  commits: readonly string[],
  descriptor: ExecutionEnvironmentSnapshot,
): Promise<void> {
  for (const commit of commits) {
    try {
      await git(worktreeRoot, ["merge", "--no-ff", "--no-commit", commit]);
      await checkpointWorktree(worktreeRoot, "EASY CODE dependency integration snapshot");
    } catch (error) {
      const files = nulList(await git(worktreeRoot, [
        "diff",
        "--name-only",
        "--diff-filter=U",
        "-z",
      ]).catch(() => ""));
      descriptor.status = "conflicted";
      descriptor.updatedAt = new Date().toISOString();
      throw new WorktreeConflictError(
        error instanceof Error ? error.message : "Dependency result integration failed",
        descriptor,
        files,
      );
    }
  }
}

async function checkpointWorktree(worktreeRoot: string, message: string): Promise<string> {
  await git(worktreeRoot, ["add", "-A", "--", "."]);
  const staged = await git(worktreeRoot, ["diff", "--cached", "--name-only", "-z"]);
  if (staged.length > 0) {
    await git(worktreeRoot, [
      "-c",
      "user.name=EASY CODE Runtime",
      "-c",
      "user.email=runtime@easy-code.local",
      "-c",
      `core.hooksPath=${nullDevice()}`,
      "commit",
      "--no-gpg-sign",
      "--no-verify",
      "-m",
      message,
    ]);
  }
  return (await git(worktreeRoot, ["rev-parse", "HEAD"])).trim();
}

async function verifyManagedWorktree(repositoryRoot: string, worktreeRoot: string): Promise<void> {
  const actualRoot = path.normalize((await git(worktreeRoot, ["rev-parse", "--show-toplevel"])).trim());
  if (normalizePathIdentity(actualRoot) !== normalizePathIdentity(worktreeRoot)) {
    throw new Error("Saved execution environment is not the expected standalone worktree");
  }
  const expectedCommon = await canonicalGitCommonDirectory(repositoryRoot);
  const commonPath = (await git(worktreeRoot, ["rev-parse", "--git-common-dir"])).trim();
  const actualCommon = path.normalize(await realpath(
    path.isAbsolute(commonPath) ? commonPath : path.resolve(worktreeRoot, commonPath),
  ));
  if (normalizePathIdentity(actualCommon) !== normalizePathIdentity(expectedCommon)) {
    throw new Error("Saved worktree no longer belongs to the expected Git repository");
  }
}

async function canonicalGitCommonDirectory(cwd: string): Promise<string> {
  const commonPath = (await git(cwd, ["rev-parse", "--git-common-dir"])).trim();
  return path.normalize(await realpath(
    path.isAbsolute(commonPath) ? commonPath : path.resolve(cwd, commonPath),
  ));
}

async function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
  ]) {
    delete environment[key];
  }
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_") ||
      key === "GIT_CONFIG_COUNT"
    ) {
      delete environment[key];
    }
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "1";
  const result = await execa("git", [
    "-c",
    `core.hooksPath=${nullDevice()}`,
    "-c",
    "core.fsmonitor=false",
    ...args,
  ], {
    cwd,
    reject: false,
    input,
    stdin: input === undefined ? "ignore" : undefined,
    stdout: "pipe",
    stderr: "pipe",
    // Git patches are byte-sensitive. Execa strips the final newline by
    // default, which makes otherwise valid `git diff` output corrupt when it
    // is piped back into `git apply -`.
    stripFinalNewline: false,
    windowsHide: true,
    env: environment,
  });
  if (result.exitCode !== 0) {
    const detail = String(result.stderr || result.stdout || "Git command failed")
      .replace(/[\r\n]+/gu, " ")
      .trim()
      .slice(0, 1_000);
    throw new Error(`git ${args[0] ?? "command"} failed: ${detail}`);
  }
  return String(result.stdout ?? "");
}

async function writeJsonAtomic(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function environmentRef(environmentId: string, kind: "baseline" | "result"): string {
  return `refs/easy-code/environments/${safePathSegment(environmentId)}/${kind}`;
}

function safePathSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(value)) {
    throw new Error("Unsafe managed environment identifier");
  }
  return value;
}

function safeBranchSegment(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return normalized || "result";
}

function normalizePathIdentity(value: string): string {
  const normalized = path.resolve(value).replace(/\\/gu, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertManagedPath(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Saved Worktree path is outside the managed Worktree root");
  }
}

function assertPathInsideOrEqual(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Saved execution root is outside its managed Worktree");
  }
}

/**
 * Lexical containment is insufficient when a durable parent directory is
 * replaced with a symlink or Windows junction. Resolve the nearest existing
 * ancestor before a missing checkout is recreated.
 */
async function assertPhysicallyManagedPath(
  managedRoot: string,
  candidate: string,
): Promise<void> {
  assertManagedPath(managedRoot, candidate);
  const managedRootInfo = await lstat(managedRoot);
  if (managedRootInfo.isSymbolicLink()) {
    throw new Error("Managed Worktree root cannot be a symbolic link or junction");
  }
  const canonicalManagedRoot = path.normalize(await realpath(managedRoot));
  let current = path.resolve(candidate);
  let isCandidate = true;
  while (true) {
    try {
      const canonicalCurrent = path.normalize(await realpath(current));
      if (isCandidate) {
        assertManagedPath(canonicalManagedRoot, canonicalCurrent);
      } else {
        assertPathInsideOrEqual(canonicalManagedRoot, canonicalCurrent);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Cannot prove the saved Worktree path is managed");
    }
    current = parent;
    isCandidate = false;
  }
}

async function assertPhysicallyContainedPath(
  container: string,
  candidate: string,
): Promise<void> {
  assertPathInsideOrEqual(container, candidate);
  if (!existsSync(container)) return;
  const canonicalContainer = path.normalize(await realpath(container));
  let current = path.resolve(candidate);
  while (true) {
    try {
      const canonicalCurrent = path.normalize(await realpath(current));
      assertPathInsideOrEqual(canonicalContainer, canonicalCurrent);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Cannot prove the saved execution root is contained by its Worktree");
    }
    current = parent;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = path.relative(path.resolve(left), path.resolve(right));
  const rightToLeft = path.relative(path.resolve(right), path.resolve(left));
  const contained = (relative: string): boolean =>
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative));
  return contained(leftToRight) || contained(rightToLeft);
}

function nulList(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function cloneEnvironment(value: Readonly<ExecutionEnvironmentSnapshot>): ExecutionEnvironmentSnapshot {
  return { ...value };
}

function cloneArtifact(value: Readonly<ResultArtifact>): ResultArtifact {
  return {
    ...value,
    ...(value.parentArtifactIds
      ? { parentArtifactIds: [...value.parentArtifactIds] }
      : {}),
    changedFiles: [...value.changedFiles],
  };
}

export function isExecutionEnvironmentSnapshot(value: unknown): value is ExecutionEnvironmentSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<ExecutionEnvironmentSnapshot>;
  return (
    typeof input.id === "string" &&
    (input.agentId === undefined || typeof input.agentId === "string") &&
    (input.parentThreadId === undefined || typeof input.parentThreadId === "string") &&
    (input.childThreadId === undefined || typeof input.childThreadId === "string") &&
    (input.taskId === undefined || typeof input.taskId === "string") &&
    (input.kind === "shared" || input.kind === "worktree") &&
    (input.status === "provisioning" ||
      input.status === "ready" ||
      input.status === "running" ||
      input.status === "result_ready" ||
      input.status === "conflicted" ||
      input.status === "handed_off" ||
      input.status === "retained" ||
      input.status === "removed" ||
      input.status === "failed") &&
    typeof input.logicalWorkspaceRoot === "string" &&
    path.isAbsolute(input.logicalWorkspaceRoot) &&
    typeof input.executionRoot === "string" &&
    path.isAbsolute(input.executionRoot) &&
    (input.repositoryRoot === undefined ||
      (typeof input.repositoryRoot === "string" && path.isAbsolute(input.repositoryRoot))) &&
    (input.worktreeRoot === undefined ||
      (typeof input.worktreeRoot === "string" && path.isAbsolute(input.worktreeRoot))) &&
    (input.baseCommit === undefined || isGitCommitId(input.baseCommit)) &&
    (input.baselineCommit === undefined || isGitCommitId(input.baselineCommit)) &&
    (input.handoffBaseCommit === undefined || isGitCommitId(input.handoffBaseCommit)) &&
    (input.resultCommit === undefined || isGitCommitId(input.resultCommit)) &&
    (input.requestedIsolation === "auto" ||
      input.requestedIsolation === "shared" ||
      input.requestedIsolation === "worktree") &&
    (input.baseMode === "fresh" || input.baseMode === "head" || input.baseMode === "current-snapshot") &&
    typeof input.createdAt === "string" &&
    typeof input.updatedAt === "string"
  );
}

export function isResultArtifact(value: unknown): value is ResultArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<ResultArtifact>;
  return (
    typeof input.id === "string" &&
    typeof input.agentId === "string" &&
    typeof input.taskId === "string" &&
    typeof input.environmentId === "string" &&
    (input.environmentKind === "shared" || input.environmentKind === "worktree") &&
    (input.status === "ready" ||
      input.status === "integrated" ||
      input.status === "conflicted" ||
      input.status === "delivered" ||
      input.status === "retained") &&
    typeof input.logicalWorkspaceRoot === "string" &&
    path.isAbsolute(input.logicalWorkspaceRoot) &&
    (input.baseCommit === undefined || isGitCommitId(input.baseCommit)) &&
    (input.resultCommit === undefined || isGitCommitId(input.resultCommit)) &&
    (input.parentArtifactIds === undefined ||
      (Array.isArray(input.parentArtifactIds) &&
        input.parentArtifactIds.every((item) => typeof item === "string"))) &&
    Array.isArray(input.changedFiles) &&
    input.changedFiles.every((item) => typeof item === "string") &&
    typeof input.createdAt === "string" &&
    typeof input.updatedAt === "string"
  );
}

function isGitCommitId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/u.test(value);
}
