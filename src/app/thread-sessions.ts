import { CommandRuntime } from "../command/runtime.js";
import { ContextManager } from "../context/manager.js";
import { contextTokensInUse, contextUsageReport } from "../context/usage.js";
import type { CommandExecutionMode, EasyCodeConfig, PlanProposal, SessionState } from "../core/types.js";
import { translate } from "../i18n/catalog.js";
import { readLanguage } from "../i18n/language.js";
import { assertDataDirectoryOutsideWorkspace } from "../images/index.js";
import { effectiveContextWindow, resolveCatalogModel } from "../models/catalog.js";
import {
  checkProjectFolders,
  folderProblemText,
  primaryFolderUnavailableError,
  unavailablePrimaryFolder,
  type UnavailableProjectFolder,
} from "../projects/availability.js";
import type { ProjectWorkspace } from "../projects/types.js";
import { activePromptBundleBinding } from "../prompt-bundle/index.js";
import { workspaceIdFromRoot, type EasyCodeStorage } from "../storage/database.js";
import { SubagentCoordinator } from "../subagents/coordinator.js";
import { taskGraphView } from "../tasks/task-graph.js";
import { deleteThreadTree } from "../threads/delete-thread.js";
import { ThreadStore, type ThreadLease, type ThreadSummary } from "../threads/thread-store.js";
import { ToolCatalog } from "../tools/catalog.js";
import type { UISessionInfo } from "../ui/contracts.js";
import type { AppInteractionPort } from "../ui/interaction-port.js";
import { samePath } from "../utils/paths.js";
import { ProjectIndex } from "../web-server/projects.js";
import { ExecutionEnvironmentManager } from "../workspace/execution-environment.js";
import { WorkspaceManager, type WorkspaceRestoreSummary } from "../workspace/manager.js";
import { InfoCommands } from "./info-commands.js";
import { ModelSelection } from "./model-selection.js";
import { SubagentHost } from "./subagent-host.js";
import { json, parseQuotedArguments } from "./text.js";
import {
  releaseOrphanedSubagentTasks,
  repairInterruptedTurn,
  resumeRecoverySummary,
  type ResumeRecoverySummary,
} from "./thread-recovery.js";

/** Live state and callbacks supplied by EasyCodeApp. */
export interface AppThreadSessionsContext {
  readonly activeTurnController: AbortController | undefined;
  readonly assertNoRunningCommands: (action: string) => void;
  readonly cancelRunningCommands: () => Promise<void>;
  readonly commandRuntimes: Map<WorkspaceManager, CommandRuntime>;
  readonly config: EasyCodeConfig;
  dirty: boolean;
  executionEnvironments: ExecutionEnvironmentManager;
  readonly mainToolCatalogs: Map<string, ToolCatalog>;
  readonly modelSelection: ModelSelection;
  readonly pendingPlan: () => PlanProposal | undefined;
  pendingResumeRecovery: ResumeRecoverySummary | undefined;
  readonly restoreSubagents: () => number;
  state: SessionState;
  readonly storage: EasyCodeStorage;
  readonly subagentCoordinator: SubagentCoordinator;
  readonly subagentHost: SubagentHost;
  readonly terminal: AppInteractionPort;
  threadLease: ThreadLease | undefined;
  readonly threadStore: ThreadStore;
  workspace: WorkspaceManager;
  readonly commandExecutionMode: CommandExecutionMode;
  readonly orchestrationEnabled: () => boolean;
  readonly trustedOuterSandbox: "harbor" | undefined;
  readonly contextManager: ContextManager;
  readonly infoCommands: InfoCommands;
  readonly hasRunningCommands: () => boolean;
}

export class AppThreadSessions {
  /** Folders already reported as not found, so each change is reported once. */
  private readonly reportedUnavailable = new Set<string>();

  constructor(private readonly ctx: AppThreadSessionsContext) {}

  syncWorkspaceState(): void {
    const currentVersions = new Map(this.ctx.workspace.getReadVersions().map((version) => [version.path, version]));
    let versionsChanged = currentVersions.size !== this.ctx.state.filesRead.size;
    if (!versionsChanged) {
      for (const [filename, version] of currentVersions) {
        const previous = this.ctx.state.filesRead.get(filename);
        if (!previous || previous.hash !== version.hash || previous.readAt !== version.readAt) {
          versionsChanged = true;
          break;
        }
      }
    }
    if (versionsChanged) {
      this.ctx.state.filesRead = currentVersions;
      this.ctx.dirty = true;
    }
    const known = new Set(
      this.ctx.state.changes.map((change) =>
        [change.timestamp, change.path, change.operation, change.afterHash ?? ""].join("|"),
      ),
    );
    for (const change of this.ctx.workspace.getChangeSet()) {
      const key = [change.timestamp, change.path, change.operation, change.afterHash ?? ""].join("|");
      if (!known.has(key)) {
        this.ctx.state.changes.push(change);
        known.add(key);
        this.ctx.dirty = true;
      }
    }
  }

  currentProjectWorkspace(): ProjectWorkspace | undefined {
    if (
      !this.ctx.state.projectId ||
      !this.ctx.state.primaryWorkspaceFolderId ||
      !this.ctx.state.workspaceFolders?.length
    )
      return undefined;
    return {
      projectId: this.ctx.state.projectId,
      revision: this.ctx.state.workspaceRevision ?? 1,
      primaryFolderId: this.ctx.state.primaryWorkspaceFolderId,
      folders: this.ctx.state.workspaceFolders.map((folder, index) => ({
        ...folder,
        projectId: this.ctx.state.projectId!,
        active: true,
        addedRevision: 1,
        sortOrder: index,
      })),
    };
  }

  /**
   * Before a request, match the workspace to the project folders that can be
   * found now: a folder that went missing is left out, one that is back is
   * used again. The primary folder must be found. While commands or child
   * agents from earlier requests still run, the workspace stays as it is.
   */
  async refreshFolderAvailability(): Promise<void> {
    const membership = this.currentProjectWorkspace();
    if (!membership) return;
    const { unavailable } = checkProjectFolders(membership.folders);
    const primary = unavailable.find((folder) => folder.id === membership.primaryFolderId);
    if (primary) {
      this.ctx.terminal.projectFoldersChanged?.();
      throw primaryFolderUnavailableError(readLanguage(this.ctx.storage), primary, this.folderFix());
    }
    const current = new Set(this.ctx.workspace.unavailableFolders.map((folder) => folder.id));
    const changed = unavailable.length !== current.size || unavailable.some((folder) => !current.has(folder.id));
    if (changed && !this.earlierWorkRunning())
      await this.replaceProjectWorkspace(membership, { announceHeader: false, startingTurn: true });
    this.reportFolderAvailability(unavailable);
  }

  /** Report the folders the workspace was opened without. */
  announceFolderAvailability(): void {
    this.reportFolderAvailability(this.ctx.workspace.unavailableFolders);
  }

  /** Report each folder that is newly not found, and each one the workspace uses again. */
  private reportFolderAvailability(notFound: readonly UnavailableProjectFolder[]): void {
    const language = readLanguage(this.ctx.storage);
    let changed = false;
    const leftOut = new Set(this.ctx.workspace.unavailableFolders.map((folder) => folder.id));
    for (const folder of notFound) {
      if (this.reportedUnavailable.has(folder.id)) continue;
      this.reportedUnavailable.add(folder.id);
      changed = true;
      this.ctx.terminal.warning(
        translate(language, leftOut.has(folder.id) ? "cli.folderUnavailable" : "cli.folderUnavailableBusy", {
          key: folder.key,
          path: folder.path,
          reason: folderProblemText(language, folder.problem),
        }),
      );
    }
    for (const id of this.reportedUnavailable) {
      // Still missing, or found again but not in use until running work finishes.
      if (leftOut.has(id) || notFound.some((folder) => folder.id === id)) continue;
      this.reportedUnavailable.delete(id);
      changed = true;
      const folder = this.ctx.workspace.folders.find((item) => item.id === id);
      if (folder)
        this.ctx.terminal.info(translate(language, "cli.folderAvailableAgain", { key: folder.key, path: folder.path }));
    }
    if (changed) this.ctx.terminal.projectFoldersChanged?.();
  }

  /** Work from earlier requests that still uses the current workspace. */
  private earlierWorkRunning(): boolean {
    const threadId = this.ctx.state.threadId;
    return (
      this.ctx.hasRunningCommands() ||
      this.ctx.subagentCoordinator.hasUnfinished(threadId) ||
      this.ctx.subagentCoordinator.hasOutstanding(threadId) ||
      Boolean(this.ctx.pendingPlan())
    );
  }

  /** Where the user can choose another primary folder. */
  private folderFix(): "web" | "cli" {
    return this.ctx.terminal.surface === "web" ? "web" : "cli";
  }

  /** `startingTurn`: called by a turn that has claimed the Thread but not yet run anything. */
  private async replaceProjectWorkspace(
    descriptor: ProjectWorkspace,
    { announceHeader = true, startingTurn = false } = {},
  ): Promise<void> {
    this.ctx.assertNoRunningCommands("change project folders");
    this.ctx.subagentHost.assertNoRunningSubagents("change project folders");
    if (this.ctx.activeTurnController && !startingTurn)
      throw new Error("Wait for the current request to finish before changing project folders.");
    if (this.ctx.pendingPlan()) throw new Error("Resolve the proposed plan before changing project folders.");
    for (const catalog of this.ctx.mainToolCatalogs.values()) await catalog.close();
    this.ctx.mainToolCatalogs.clear();
    const previous = this.ctx.workspace;
    const next = await WorkspaceManager.create(descriptor);
    const restored = next.restorePersistedState(this.ctx.state.filesRead, this.ctx.state.changes);
    void restored;
    this.ctx.workspace = next;
    this.ctx.commandRuntimes.delete(previous);
    this.ctx.state.projectId = descriptor.projectId;
    this.ctx.state.workspaceRevision = descriptor.revision;
    this.ctx.state.workspaceFolders = descriptor.folders.map((folder) => ({
      id: folder.id,
      key: folder.key,
      path: folder.path,
    }));
    this.ctx.state.primaryWorkspaceFolderId = descriptor.primaryFolderId;
    this.ctx.state.workspaceRoot = next.root;
    this.ctx.config.workspaceRoot = next.root;
    this.ctx.executionEnvironments = new ExecutionEnvironmentManager({
      logicalWorkspaceRoot: next.root,
      dataDir: this.ctx.config.dataDir,
      baseMode: this.ctx.config.worktreeBaseMode,
      worktreeRoot: this.ctx.config.worktreeRoot,
      maxManagedWorktrees: this.ctx.config.limits.maxManagedWorktrees,
    });
    this.ctx.dirty = true;
    this.save();
    this.syncTerminalView(announceHeader);
  }

  async updateWorkspaceCommand(rawArgs: string): Promise<void> {
    const args = parseQuotedArguments(rawArgs);
    const action = args[0] ?? "list";
    const projectId = this.ctx.state.projectId;
    if (!projectId) throw new Error("This thread is not attached to a logical project.");
    const projects = new ProjectIndex(this.ctx.storage);
    if (action === "list") {
      if (args.length !== 1)
        throw new Error("Usage: /workspace list|refresh|add <path>|remove <folder-id>|primary <folder-id>");
      this.ctx.terminal.write(`${json(projects.get(projectId))}\n`);
      return;
    }
    if (action === "refresh") {
      if (args.length !== 1) throw new Error("Usage: /workspace refresh");
      this.ctx.terminal.write(`${json(await this.ctx.workspace.refreshManifest())}\n`);
      return;
    }
    // Validate the live project before persisting a new membership revision;
    // otherwise a rejected hot swap could leave storage ahead of this Thread.
    this.ctx.assertNoRunningCommands("change project folders");
    this.ctx.subagentHost.assertNoRunningSubagents("change project folders");
    if (this.ctx.activeTurnController)
      throw new Error("Wait for the current request to finish before changing project folders.");
    if (this.ctx.pendingPlan()) throw new Error("Resolve the proposed plan before changing project folders.");
    if (action === "add") {
      if (args.length !== 2) throw new Error('Usage: /workspace add "<absolute-folder-path>"');
      await assertDataDirectoryOutsideWorkspace(this.ctx.config.dataDir, args[1]!);
      projects.addFolder(projectId, args[1]!);
    } else if (action === "remove") {
      if (args.length !== 2) throw new Error("Usage: /workspace remove <folder-id>");
      const project = projects.get(projectId);
      if (project.folders.filter((folder) => folder.active).length <= 1)
        throw new Error(
          "The CLI cannot detach the final folder while this conversation is open. Use the Web project manager.",
        );
      projects.removeFolder(projectId, args[1]!);
    } else if (action === "primary") {
      if (args.length !== 2) throw new Error("Usage: /workspace primary <folder-id>");
      projects.setPrimaryFolder(projectId, args[1]!);
    } else {
      throw new Error("Usage: /workspace list|refresh|add <path>|remove <folder-id>|primary <folder-id>");
    }
    const next = projects.workspace(projectId);
    const missingPrimary = unavailablePrimaryFolder(next);
    if (missingPrimary) {
      // Saved; the conversation keeps its folders until a primary folder that can be found is chosen.
      this.ctx.terminal.success("Project folders updated.");
      this.ctx.terminal.warning(
        primaryFolderUnavailableError(readLanguage(this.ctx.storage), missingPrimary, "cli").message,
      );
      return;
    }
    await this.replaceProjectWorkspace(next);
    this.reportFolderAvailability(this.ctx.workspace.unavailableFolders);
    this.ctx.terminal.success("Project folders updated.");
  }

  async newThread(): Promise<void> {
    this.save();
    const previousThreadId = this.ctx.state.threadId;
    const previousWorkspace = this.ctx.workspace;
    const previousLease = this.requireThreadLease();
    const nextWorkspace = await WorkspaceManager.create(
      this.currentProjectWorkspace() ?? this.ctx.config.workspaceRoot,
    );
    const nextState = this.ctx.threadStore.create({
      workspaceRoot: nextWorkspace.root,
      projectId: this.ctx.state.projectId,
      workspaceRevision: this.ctx.state.workspaceRevision,
      workspaceFolders: this.ctx.state.workspaceFolders?.map((folder) => ({ ...folder })),
      primaryWorkspaceFolderId: this.ctx.state.primaryWorkspaceFolderId,
      mode: "auto",
      provider: this.ctx.state.provider,
      model: this.ctx.state.model,
      thinkingEffort: this.ctx.state.thinkingEffort,
      promptBundle: activePromptBundleBinding(),
      modelRegistryHash: this.ctx.state.modelRegistryHash,
    });
    const nextLease = this.ctx.threadStore.acquireThreadLease(nextState.threadId);
    try {
      await this.ctx.subagentHost.pauseSubagentsForResume();
      await this.ctx.cancelRunningCommands();
      this.ctx.threadStore.releaseThreadLease(previousLease);
    } catch (error) {
      const recoveryErrors: unknown[] = [error];
      try {
        // The new thread was never shown; remove it rather than leave an empty conversation behind.
        this.ctx.threadStore.releaseThreadLease(nextLease);
        deleteThreadTree(this.ctx.storage, this.ctx.threadStore, nextState.threadId);
      } catch (cleanupError) {
        recoveryErrors.push(cleanupError);
      }
      // Pausing may fail after stopping only some children, so always re-arm; restoring is idempotent.
      try {
        this.ctx.subagentHost.restorePausedCurrentThread(previousThreadId);
      } catch (restoreError) {
        recoveryErrors.push(restoreError);
      }
      if (recoveryErrors.length > 1) {
        throw new AggregateError(
          recoveryErrors,
          "Could not create a new thread and the current thread could not be fully restored",
        );
      }
      throw error;
    }
    this.ctx.workspace = nextWorkspace;
    this.ctx.state = nextState;
    this.ctx.config.mode = "auto";
    this.ctx.threadLease = nextLease;
    this.ctx.dirty = false;
    this.ctx.subagentCoordinator.discardPausedJobs(previousThreadId);
    this.ctx.commandRuntimes?.delete(previousWorkspace);
  }

  async resumeThread(threadId: string): Promise<void> {
    if (threadId === this.ctx.state.threadId) {
      this.save();
      this.ctx.pendingResumeRecovery = resumeRecoverySummary(
        this.ctx.state,
        {
          restoredReadVersions: this.ctx.workspace.getReadVersions().length,
          staleReadVersions: 0,
          restoredChanges: this.ctx.workspace.getChangeSet().length,
          discardedChanges: 0,
        },
        {
          interruptedTurnRepaired: false,
          reconciledSubagentAssignments: 0,
        },
      );
      return;
    }
    // Validate and prepare the target before stopping any process-local work in
    // the current Thread. A bad ID, active lease, or workspace mismatch must be
    // a transactional no-op for the current session.
    this.save();
    const previousThreadId = this.ctx.state.threadId;
    const previousWorkspace = this.ctx.workspace;
    const previousLease = this.requireThreadLease();
    let nextLease: ThreadLease | undefined;
    let recovered: SessionState;
    let nextWorkspace: WorkspaceManager;
    let restoredWorkspace: WorkspaceRestoreSummary;
    let restoredChangesChanged = false;
    let resumedModelChanged = false;
    let repairedInterruptedTurn: boolean;
    let releasedOrphanedSubagents = 0;
    try {
      if (this.ctx.threadStore.isBoundSubagentThread(threadId)) {
        throw new Error(`Thread ${threadId} is a parent-managed child session; resume its parent thread instead`);
      }
      nextLease = this.ctx.threadStore.acquireThreadLease(threadId);
      recovered = this.ctx.threadStore.recover(threadId);
      if (!this.ctx.config.providers[recovered.provider] || !resolveCatalogModel(recovered.provider, recovered.model)) {
        this.ctx.terminal.warning(
          `The saved model ${recovered.provider}/${recovered.model} is no longer available. Using the current default; choose another with /model.`,
        );
        recovered.provider = this.ctx.config.provider;
        recovered.model = this.ctx.config.providers[this.ctx.config.provider]!.model;
        resumedModelChanged = true;
      }
      if (
        (recovered.projectId ?? workspaceIdFromRoot(recovered.workspaceRoot)) !==
        (this.ctx.state.projectId ?? workspaceIdFromRoot(this.ctx.workspace.root))
      ) {
        throw new Error(`Thread ${threadId} belongs to another project.`);
      }
      const currentProject = this.currentProjectWorkspace();
      nextWorkspace = await WorkspaceManager.create(currentProject ?? recovered.workspaceRoot);
      recovered.projectId = nextWorkspace.projectId ?? recovered.projectId;
      recovered.workspaceRevision = nextWorkspace.revision;
      recovered.workspaceFolders = nextWorkspace.memberFolders.map((folder, index) => ({
        id: folder.id ?? `folder_${index + 1}`,
        key: folder.key,
        path: folder.path,
      }));
      recovered.primaryWorkspaceFolderId = recovered.workspaceFolders.find((folder) =>
        samePath(folder.path, nextWorkspace.root),
      )?.id;
      recovered.workspaceRoot = nextWorkspace.root;
      const savedChanges = JSON.stringify(recovered.changes);
      restoredWorkspace = nextWorkspace.restorePersistedState(recovered.filesRead, recovered.changes);
      recovered.filesRead = new Map(nextWorkspace.getReadVersions().map((version) => [version.path, version]));
      recovered.changes = nextWorkspace.getChangeSet();
      restoredChangesChanged = JSON.stringify(recovered.changes) !== savedChanges;
      if (restoredChangesChanged) {
        recovered.updatedAt = new Date().toISOString();
      }
    } catch (error) {
      if (nextLease) {
        try {
          this.ctx.threadStore.releaseThreadLease(nextLease);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Could not validate the thread for resume and its lease could not be released",
          );
        }
      }
      throw error;
    }

    try {
      await this.ctx.subagentHost.pauseSubagentsForResume();
      await this.ctx.cancelRunningCommands();
      this.save();
      releasedOrphanedSubagents = releaseOrphanedSubagentTasks(this.ctx.threadStore, recovered);
      repairedInterruptedTurn = repairInterruptedTurn(this.ctx.threadStore, recovered);
      this.ctx.threadStore.releaseThreadLease(previousLease);
    } catch (error) {
      const recoveryErrors: unknown[] = [error];
      if (nextLease) {
        try {
          this.ctx.threadStore.releaseThreadLease(nextLease);
        } catch (cleanupError) {
          recoveryErrors.push(cleanupError);
        }
      }
      // Pausing may fail after stopping only some children, so always re-arm; restoring is idempotent.
      try {
        this.ctx.subagentHost.restorePausedCurrentThread(previousThreadId);
      } catch (restoreError) {
        recoveryErrors.push(restoreError);
      }
      if (recoveryErrors.length > 1) {
        throw new AggregateError(
          recoveryErrors,
          "Could not resume the thread and the current thread could not be fully restored",
        );
      }
      throw error;
    }
    this.ctx.threadLease = nextLease;
    this.ctx.state = recovered;
    this.ctx.workspace = nextWorkspace;
    this.ctx.config.mode = recovered.mode;
    this.ctx.config.thinkingEffort = recovered.thinkingEffort;
    this.ctx.config.provider = recovered.provider;
    this.ctx.config.providers[recovered.provider]!.model = recovered.model;
    this.ctx.subagentCoordinator.discardPausedJobs(previousThreadId);
    this.ctx.commandRuntimes?.delete(previousWorkspace);
    this.ctx.dirty =
      restoredWorkspace.staleReadVersions > 0 ||
      restoredChangesChanged ||
      resumedModelChanged ||
      repairedInterruptedTurn ||
      releasedOrphanedSubagents > 0;
    const restoredReasoningBlocks = this.restoreReasoningHistory();
    const recoveredStandaloneSubagents = this.ctx.restoreSubagents();
    this.ctx.pendingResumeRecovery = resumeRecoverySummary(recovered, restoredWorkspace, {
      interruptedTurnRepaired: repairedInterruptedTurn,
      reconciledSubagentAssignments: releasedOrphanedSubagents,
    });
    this.ctx.pendingResumeRecovery = {
      ...this.ctx.pendingResumeRecovery,
      restoredReasoningBlocks,
      recoveredStandaloneSubagents,
    };
    this.save();
    this.ctx.modelSelection.rememberLastModel();
  }

  private requireThreadLease(): ThreadLease {
    if (!this.ctx.threadLease) {
      throw new Error("The active thread lease is unavailable");
    }
    return this.ctx.threadLease;
  }

  save(): void {
    this.syncWorkspaceState();
    if (!this.ctx.dirty) return;
    this.ctx.threadStore.save(this.ctx.state);
    this.ctx.dirty = false;
  }

  resumableThreads(): ThreadSummary[] {
    return this.ctx.threadStore
      .list({
        workspaceId: this.ctx.state.projectId ?? workspaceIdFromRoot(this.ctx.workspace.root),
        limit: 50,
      })
      .filter((session) => !this.ctx.threadStore.isBoundSubagentThread(session.threadId));
  }

  async selectResumeThread(): Promise<string | undefined> {
    const sessions = this.resumableThreads();
    if (sessions.length === 0) {
      this.ctx.terminal.info("This workspace has no previous threads.");
      return undefined;
    }
    return this.ctx.terminal.selectChoice(
      "Resume a thread",
      sessions.map((session) => ({
        id: session.threadId,
        label: session.goal?.trim() || session.threadId,
        detail: `${session.provider}/${session.model} · ${session.mode} · ` + `${session.updatedAt}`,
      })),
      this.ctx.state.threadId,
    );
  }

  restoreReasoningHistory(): number {
    return this.ctx.terminal.restoreReasoning(
      this.ctx.state.messages.flatMap((message) =>
        message.role === "assistant" && message.reasoning_content?.trim() ? [message.reasoning_content] : [],
      ),
    );
  }

  announceResumeRecovery(): void {
    // Every place that opens a conversation reports this, so it also reports missing folders.
    this.announceFolderAvailability();
    const recovery = this.ctx.pendingResumeRecovery;
    if (!recovery) return;
    this.ctx.pendingResumeRecovery = undefined;
    const language = readLanguage(this.ctx.storage);
    this.ctx.terminal.info(translate(language, "cli.resumedThread"));
    if (recovery.recoveredStandaloneSubagents > 0 && this.ctx.commandExecutionMode === "manual") {
      this.ctx.terminal.warning(translate(language, "cli.childrenPaused"));
    }
    if (recovery.interruptedTurnRepaired) {
      this.ctx.terminal.warning(translate(language, "cli.previousTurnInterrupted"));
    }
  }

  terminalSessionInfo(): UISessionInfo {
    // Follow model and conversation switches before the next request does.
    this.ctx.contextManager.configureTokenBudget(
      effectiveContextWindow(this.ctx.state.provider, this.ctx.state.model),
      this.ctx.config.limits,
      this.ctx.state.thinkingEffort,
    );
    const usage = contextUsageReport(this.ctx.contextManager, this.ctx.state);
    return {
      orchestrationEnabled: this.ctx.orchestrationEnabled(),
      agentConcurrencyLimit: this.ctx.config.limits.maxConcurrentSubagents[this.ctx.state.thinkingEffort],
      threadId: this.ctx.state.threadId,
      workspaceRoot: this.ctx.workspace.root,
      projectId: this.ctx.state.projectId,
      workspaceRevision: this.ctx.state.workspaceRevision,
      workspaceFolders: this.ctx.state.workspaceFolders?.map((folder) => ({ ...folder })),
      mode: this.ctx.state.mode,
      provider: this.ctx.state.provider,
      model: this.ctx.state.model,
      thinkingEffort: this.ctx.state.thinkingEffort,
      approvalPolicy: this.ctx.config.approvalPolicy,
      commandExecutionMode: this.ctx.commandExecutionMode,
      commandEnvironment: this.ctx.trustedOuterSandbox
        ? "container"
        : this.ctx.commandExecutionMode === "unrestricted"
          ? "host"
          : "container",
      contextTokens: contextTokensInUse(this.ctx.contextManager, this.ctx.state),
      ...(usage ? { contextLimitTokens: usage.windowTokens, contextUsage: usage } : {}),
    };
  }

  syncTerminalView(announceHeader = false): void {
    this.ctx.terminal.setSessionInfo(this.terminalSessionInfo(), announceHeader);
    if (!this.ctx.terminal.isInlineShell()) return;
    if (this.ctx.state.taskGraph) {
      this.ctx.terminal.taskGraph(
        taskGraphView(this.ctx.state.taskGraph, (agentId) => this.ctx.subagentCoordinator.displayLabel(agentId)),
      );
    } else {
      this.ctx.terminal.clearTaskGraph();
    }
    this.ctx.infoCommands.printSubagents();
  }
}
