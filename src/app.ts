import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppImageInputs, type AppImageInputsContext } from "./app/image-inputs.js";
import { AppShellCommands, type AppShellCommandsContext } from "./app/shell-commands.js";
import { AppThreadSessions, type AppThreadSessionsContext } from "./app/thread-sessions.js";
import { AppTurnExecution, type AppTurnExecutionContext } from "./app/turn-execution.js";
import type { ActiveTurnSteering, EasyCodeAppOptions, ToolSourceFactory } from "./app/types.js";
import type { ProjectWorkspace } from "./projects/types.js";
import { TaskBudget } from "./runtime/task-budget.js";
import { BenchmarkContainerBackend } from "./sandbox/benchmark-backend.js";

import { ApprovalFlow, type ApprovalFlowContext } from "./app/approval-flow.js";
import { ApprovalReviewer, type ApprovalReviewerContext } from "./app/approval-reviewer.js";
import { InfoCommands, type InfoCommandsContext } from "./app/info-commands.js";
import { McpServerController, type McpServerControllerContext } from "./app/mcp-servers.js";
import { ModelSelection, type ModelSelectionContext } from "./app/model-selection.js";
import { RuntimeAssembly, type RuntimeAssemblyContext } from "./app/runtime-assembly.js";
import { SubagentHost, type SubagentHostContext } from "./app/subagent-host.js";
import {
  releaseOrphanedSubagentTasks,
  repairInterruptedTurn,
  resumeRecoverySummary,
  type ResumeRecoverySummary,
} from "./app/thread-recovery.js";
import { consumeHarborProviderApiKeyFile, resolveHarborOuterSandbox } from "./benchmarks/swebench.js";
import { InkInteraction } from "./ui/ink/ink-interaction.js";
import { ApprovalQueue, type ApprovalReview } from "./command/approval-agent.js";
import { CommandRuntime } from "./command/runtime.js";
import { SystemKeyringCredentialStore, type ApiKeyCredentialStore } from "./config/credentials.js";
import { readLastModel } from "./config/last-model.js";
import { loadEasyCodeConfig } from "./config/loader.js";
import { ContextArtifactIndex } from "./context/artifact-index.js";
import { ContextManager } from "./context/manager.js";
import { contextTokensInUse } from "./context/usage.js";
import { WorkspaceToolObserver } from "./coordination/observer.js";
import type {
  AgentRunResult,
  ApprovalRequest,
  CommandExecutionMode,
  EasyCodeConfig,
  EventRecord,
  ImageAttachment,
  PlanProposal,
  SessionState,
} from "./core/types.js";
import { DownloadBroker } from "./downloads/broker.js";
import { translate } from "./i18n/catalog.js";
import { readLanguage } from "./i18n/language.js";
import {
  ImageStore,
  SystemClipboardImageReader,
  assertDataDirectoryOutsideWorkspace,
  prepareDataDirectoryOutsideWorkspace,
  type ClipboardImageReader,
} from "./images/index.js";
import { LocalLayaClient } from "./local-decision/client.js";
import { McpConfigStore, USER_MCP_CONFIG_PATH } from "./mcp/config.js";
import { McpConnections, McpToolSource } from "./mcp/source.js";
import { LocalEmbeddingModel } from "./memory/embedding-model.js";
import { MemoryMaintenance } from "./memory/maintenance.js";
import { GLOBAL_MEMORY_WORKSPACE_ID, MemoryManager, projectMemoryIdFromRoot } from "./memory/memory-manager.js";
import { MemoryVectorIndex } from "./memory/vector-index.js";
import {
  USER_MODEL_REGISTRY_PATH,
  effectiveContextWindow,
  requireCatalogModel,
  resolveCatalogModel,
  sweBenchVerified50Profile,
} from "./models/catalog.js";
import { activePromptBundleBinding, ensurePromptBundle } from "./prompt-bundle/index.js";
import { createProvider } from "./providers/factory.js";
import {
  DocumentConverter,
  ThreadDocumentService,
  ThreadResourceStore,
  type ThreadResourceAttachment,
} from "./resources/index.js";
import { AgentRuntime } from "./runtime/agent.js";
import { TurnSteeringAttemptNotifier } from "./runtime/turn-steering-notifier.js";
import { NativeSandboxBackend } from "./sandbox/native-backend.js";
import { NativeSandboxStartupService } from "./sandbox/native-startup.js";
import { type SandboxStartupService } from "./sandbox/startup.js";
import { SkillStore } from "./skills/store.js";
import { createStorage, workspaceIdFromRoot, type EasyCodeStorage } from "./storage/database.js";
import {
  SubagentCoordinator,
  type SubagentExecutionOutcome,
  type SubagentExecutionRequest,
} from "./subagents/coordinator.js";
import { SubagentMessageMailbox } from "./subagents/messages.js";
import { WorkspaceMutationLock } from "./subagents/workspace-mutation-lock.js";
import { deleteThreadTree } from "./threads/delete-thread.js";
import { ThreadStore, peekThreadWorkspaceRoot, type ThreadLease, type ThreadSummary } from "./threads/thread-store.js";
import { ThreadTitleStore } from "./threads/thread-title.js";
import { type ToolApprovalReview } from "./tools/approval-agent.js";
import { type ToolApprovalIdentity } from "./tools/approval.js";
import { BuiltinToolSource } from "./tools/builtin-source.js";
import { ToolCatalog, type ToolCatalogSnapshot } from "./tools/catalog.js";
import type { ToolExecutionAuthorizationRequest, ToolExecutionAuthorizer } from "./tools/execution-gateway.js";
import type { UISessionInfo } from "./ui/contracts.js";
import type { AppInteractionPort, PlanReviewDecision } from "./ui/interaction-port.js";
import { samePath } from "./utils/paths.js";
import { ProjectIndex } from "./web-server/projects.js";
import { ExecutionEnvironmentManager } from "./workspace/execution-environment.js";
import { WorkspaceManager } from "./workspace/manager.js";

// Re-exported so the package entry (src/index.ts `export *`) keeps its public API.
export { attributeSubagentCommandAudit } from "./app/subagent-host.js";
export {
  releaseOrphanedSubagentTasks,
  repairInterruptedTurn,
  type ResumeRecoverySummary,
} from "./app/thread-recovery.js";

export class EasyCodeApp {
  private readonly taskBudgets = new Map<string, TaskBudget>();
  private workspace: WorkspaceManager;
  private mentionManifestScan: Promise<void> | undefined;
  private state: SessionState;
  private readonly contextManager = new ContextManager();
  private readonly contextArtifactIndex: ContextArtifactIndex;
  private readonly memoryManager: MemoryManager;
  private readonly threadStore: ThreadStore;
  private readonly subagentMessages: SubagentMessageMailbox;
  private readonly threadTitles: ThreadTitleStore;
  private threadLease: ThreadLease | undefined;
  private readonly imageStore: ImageStore;
  private readonly threadResourceStore: ThreadResourceStore;
  private readonly documentConverter: DocumentConverter;
  private readonly threadDocumentService: ThreadDocumentService;
  private readonly workspaceMutationLock: WorkspaceMutationLock;
  private readonly commandRuntimes = new Map<WorkspaceManager, CommandRuntime>();
  private localLayaClient?: LocalLayaClient;
  private readonly downloadBrokers = new Map<string, Promise<DownloadBroker>>();
  private readonly mainToolCatalogs = new Map<string, ToolCatalog>();
  private readonly mcpConfigStore = new McpConfigStore();
  private mcpConnections?: McpConnections;
  private mcpAutoConnectPromise?: Promise<void>;
  private executionEnvironments: ExecutionEnvironmentManager;
  private readonly subagentCoordinator: SubagentCoordinator;
  private pendingImages: ImageAttachment[] = [];
  private pendingResumeRecovery?: ResumeRecoverySummary;
  private closed = false;
  private closeAsyncWork?: Promise<void>;
  private dirty = false;
  private commandExecutionMode: CommandExecutionMode;
  private hostAccessEpoch = 0;
  private approvalQueue = new ApprovalQueue();
  private memoryMaintenanceTimer?: NodeJS.Timeout;
  private memoryMaintenanceController?: AbortController;
  private memoryMaintenanceWork?: Promise<void>;
  private activeTurnController?: AbortController;
  private compacting = false;
  /** Automatic maintenance inside the running turn; interjections wait until it ends. */
  private autoCompacting = false;
  private activeTurnSteering?: ActiveTurnSteering;
  private readonly toolObservers = new Set<WorkspaceToolObserver>();
  private sandboxSetupDeferred = false;

  private constructor(
    private readonly config: EasyCodeConfig,
    private readonly storage: EasyCodeStorage,
    workspace: WorkspaceManager,
    state: SessionState,
    threadLease: ThreadLease,
    private readonly terminal: AppInteractionPort,
    private readonly keepInteractionOpen: boolean,
    private readonly assumeYes: boolean,
    private readonly maxModelRequests: number | undefined,
    private readonly trustedOuterSandbox: "harbor" | undefined,
    private readonly credentialStore: ApiKeyCredentialStore | undefined,
    private readonly startupInteraction: "none" | "select-model" | "ensure-api-key",
    private readonly sandboxStartupService: SandboxStartupService | undefined,
    private readonly clipboardImageReader: ClipboardImageReader,
    private readonly toolSourceFactories: readonly ToolSourceFactory[],
    private readonly authorizeToolExecution: ToolExecutionAuthorizer | undefined,
    resumeRecovery?: ResumeRecoverySummary,
    workspaceMutationLock?: WorkspaceMutationLock,
  ) {
    this.workspaceMutationLock = workspaceMutationLock ?? new WorkspaceMutationLock();
    this.threadTitles = new ThreadTitleStore(storage);
    this.workspace = workspace;
    this.terminal.configureStreaming(config.limits);
    this.state = state;
    this.terminal.setContextTokensProvider(() => contextTokensInUse(this.contextManager, this.state));
    this.threadLease = threadLease;
    this.commandExecutionMode =
      trustedOuterSandbox === "harbor" ? "unrestricted" : assumeYes ? "auto_approve" : "manual";
    // Startup/Resume never silently raises user authority to enable orchestration.
    if (this.commandExecutionMode === "manual") this.state.orchestrationEnabled = false;
    // Use the already resolved trusted cache root so normal launches and the
    // Harbor adapter consume the exact model prepared for this installation.
    const embeddingModel = new LocalEmbeddingModel({
      cacheDirectory: config.cacheDir,
    });
    const vectorIndex = new MemoryVectorIndex(storage, embeddingModel, { backgroundVectors: true });
    let reportedVectorFailure = false;
    this.memoryManager = new MemoryManager(storage, {
      limits: config.limits,
      vectorIndex,
      onVectorError: (error) => {
        if (reportedVectorFailure) return;
        reportedVectorFailure = true;
        const detail = error instanceof Error ? error.message : String(error);
        terminal.info(
          `Semantic memory search is unavailable (${detail}). ` +
            "EASY CODE is using lexical fallback; reinstall without --ignore-scripts to repair the local embedding model.",
        );
      },
    });
    let reportedContextVectorFailure = false;
    this.contextArtifactIndex = new ContextArtifactIndex(
      storage,
      embeddingModel,
      (error) => {
        if (reportedContextVectorFailure) return;
        reportedContextVectorFailure = true;
        const detail = error instanceof Error ? error.message : String(error);
        terminal.info(
          `Semantic Thread-context retrieval is unavailable (${detail}). ` +
            "EASY CODE is continuing with SQLite FTS5 retrieval.",
        );
      },
      { backgroundVectors: true, limits: config.limits },
    );
    this.threadStore = new ThreadStore(storage);
    this.threadStore.coordination.prune(config.limits.coordinationRetentionDays);
    this.subagentMessages = new SubagentMessageMailbox(this.threadStore);
    this.executionEnvironments = new ExecutionEnvironmentManager({
      logicalWorkspaceRoot: workspace.root,
      dataDir: config.dataDir,
      baseMode: config.worktreeBaseMode,
      worktreeRoot: config.worktreeRoot,
      maxManagedWorktrees: config.limits.maxManagedWorktrees,
    });
    this.imageStore = new ImageStore(config.dataDir);
    this.threadResourceStore = new ThreadResourceStore(config.dataDir, config.limits.threadResourceMaxBytes);
    this.documentConverter = new DocumentConverter(config.dataDir);
    this.threadDocumentService = new ThreadDocumentService(this.documentConverter, this.threadResourceStore);
    this.pendingResumeRecovery = resumeRecovery;
    this.contextManager.configureTokenBudget(
      effectiveContextWindow(this.state.provider, this.state.model),
      config.limits,
      this.state.thinkingEffort,
    );
    this.subagentCoordinator = new SubagentCoordinator({
      run: (request) => this.runSubagent(request),
      defaultIsolation: workspace.folders.length > 1 ? "shared" : config.subagentIsolation,
      forceSharedIsolation: this.trustedOuterSandbox === "harbor" || workspace.folders.length > 1,
      onWaitStart: (text) => this.terminal.startActivity(text, "waiting"),
      onWaitEnd: (activityToken) => {
        if (typeof activityToken === "string") {
          this.terminal.stopActivity(activityToken);
        }
      },
      onViewChange: (parentThreadId) => {
        if (this.state.threadId === parentThreadId) this.infoCommands.printSubagents();
      },
      pendingMessages: (parentThreadId, agentIds) => this.subagentMessages.pending(parentThreadId, agentIds),
      handoff: (artifact, destination) => this.subagentHost.handoffSubagentResult(artifact, destination),
    });
  }

  static async create(options: EasyCodeAppOptions = {}): Promise<EasyCodeApp> {
    if (
      options.maxModelRequests !== undefined &&
      (!Number.isSafeInteger(options.maxModelRequests) || options.maxModelRequests < 1)
    ) {
      throw new RangeError("maxModelRequests must be a positive safe integer when provided");
    }
    // Validate the benchmark-only outer boundary before creating a Thread or
    // touching workspace state. Invalid host claims fail without side effects.
    const trustedOuterSandbox = resolveHarborOuterSandbox();
    const harborProviderApiKey = consumeHarborProviderApiKeyFile(trustedOuterSandbox);
    const benchmarkProvider = sweBenchVerified50Profile().provider;
    // Library consumers do not pass through CLI main(), so activate the same
    // verified immutable Bundle here as well. This is idempotent.
    await ensurePromptBundle();
    const promptBundle = activePromptBundleBinding();
    const credentialStore =
      options.credentialStore === false ? undefined : (options.credentialStore ?? new SystemKeyringCredentialStore());
    let config = await loadEasyCodeConfig({
      workspaceRoot: options.workspaceRoot,
      credentialStore: harborProviderApiKey ? false : (credentialStore ?? false),
    });
    if (harborProviderApiKey) config.providers[benchmarkProvider]!.apiKey = harborProviderApiKey;
    const terminal: AppInteractionPort = options.terminal ?? new InkInteraction();
    if (options.approvalPolicy) config.approvalPolicy = options.approvalPolicy;

    let storage: EasyCodeStorage | undefined;
    let threadStore: ThreadStore | undefined;
    let threadLease: ThreadLease | undefined;
    try {
      const explicitWorkspace = Boolean(options.workspaceRoot || process.env.EASY_CODE_WORKSPACE_ROOT?.trim());
      if (options.resumeThreadId && !explicitWorkspace) {
        // The Thread journal is stored in the user data directory, so it can
        // identify its own workspace before workspace-local configuration is
        // loaded. This lets `easy-code --resume <id>` work from another cwd.
        const savedWorkspace = peekThreadWorkspaceRoot(config.dataDir, options.resumeThreadId);
        const discoveredConfig = await loadEasyCodeConfig({
          workspaceRoot: savedWorkspace,
          credentialStore: harborProviderApiKey ? false : (credentialStore ?? false),
        });
        if (harborProviderApiKey) discoveredConfig.providers[benchmarkProvider]!.apiKey = harborProviderApiKey;
        if (!samePath(discoveredConfig.dataDir, config.dataDir)) {
          throw new Error(
            `Thread ${options.resumeThreadId} resolves to a different EASY CODE data directory. ` +
              "Use an explicit --workspace and consistent user configuration.",
          );
        }
        config = discoveredConfig;
        if (options.approvalPolicy) config.approvalPolicy = options.approvalPolicy;
      }
      let workspace = await WorkspaceManager.create(options.projectWorkspace ?? config.workspaceRoot);
      config.dataDir = await prepareDataDirectoryOutsideWorkspace(config.dataDir, workspace.root);
      storage = createStorage(config.dataDir);
      terminal.setLanguage?.(readLanguage(storage));
      if (!options.resumeThreadId && !harborProviderApiKey) {
        const last = readLastModel(storage);
        if (last) {
          if (!options.provider && !options.model) {
            config.provider = last.provider;
            config.providers[last.provider]!.model = last.model;
          }
          if (!options.thinkingEffort) config.thinkingEffort = last.thinkingEffort;
        }
      }
      threadStore = new ThreadStore(storage);
      // Library callers can bypass both the CLI and Web project controllers.
      // Keep the core invariant here as well: every ordinary Thread belongs to
      // a durable UUID project, and resume resolves the latest membership by
      // project identity rather than trusting a historical root snapshot.
      if (!options.projectWorkspace) {
        const projects = new ProjectIndex(storage);
        if (options.resumeThreadId) {
          const summary = threadStore.list({ limit: 100_000 }).find((item) => item.threadId === options.resumeThreadId);
          if (!summary) throw new Error(`Thread not found: ${options.resumeThreadId}`);
          workspace = await WorkspaceManager.create(projects.workspace(summary.workspaceId));
        } else {
          workspace = await WorkspaceManager.create(projects.workspace(projects.add(workspace.root).id));
        }
      }
      for (const folder of workspace.folders) {
        await assertDataDirectoryOutsideWorkspace(config.dataDir, folder.path);
      }
      let state: SessionState;
      let shouldCheckpoint = false;
      let resumeRecovery: ResumeRecoverySummary | undefined;

      if (options.resumeThreadId) {
        if (threadStore.isBoundSubagentThread(options.resumeThreadId)) {
          throw new Error(
            `Thread ${options.resumeThreadId} is a parent-managed child session; resume its parent thread instead`,
          );
        }
        threadLease = threadStore.acquireThreadLease(options.resumeThreadId);
        state = threadStore.recover(options.resumeThreadId);
        if (options.projectWorkspace && state.projectId !== options.projectWorkspace.projectId) {
          throw new Error(`Thread ${state.threadId} belongs to another project.`);
        }
        state.projectId = workspace.projectId ?? state.projectId;
        state.workspaceRevision = workspace.revision;
        state.workspaceFolders = workspace.folders.map((folder, index) => ({
          id: folder.id ?? `folder_${index + 1}`,
          key: folder.key,
          path: folder.path,
        }));
        state.primaryWorkspaceFolderId = state.workspaceFolders.find((folder) =>
          samePath(folder.path, workspace.root),
        )?.id;
        state.workspaceRoot = workspace.root;
        if (!config.providers[state.provider] || !resolveCatalogModel(state.provider, state.model)) {
          terminal.warning(
            `The saved model ${state.provider}/${state.model} is no longer available. Using the current default; choose another with /model.`,
          );
          state.provider = config.provider;
          state.model = config.providers[config.provider]!.model;
          shouldCheckpoint = true;
        }
        const previousMode = state.mode;
        const previousProvider = state.provider;
        const previousModel = state.model;
        const previousThinkingEffort = state.thinkingEffort;
        const resumedMode = options.mode ?? state.mode;
        if (resumedMode !== state.mode && state.taskGraph && state.taskGraph.status !== "completed") {
          throw new Error("Finish or resolve the active task DAG before changing modes on resume.");
        }
        if (resumedMode !== state.mode && threadStore.unobservedSubagentAssignments(state.threadId).length > 0) {
          throw new Error("Collect outstanding child assignments before changing modes on resume.");
        }
        state.mode = resumedMode;
        state.thinkingEffort = options.thinkingEffort ?? state.thinkingEffort;
        const selectedProvider = options.provider ?? state.provider;
        state.provider = selectedProvider;
        state.model = options.model
          ? requireCatalogModel(selectedProvider, options.model).id
          : options.provider
            ? config.providers[selectedProvider]!.model
            : state.model;
        const savedChanges = JSON.stringify(state.changes);
        const restoredWorkspace = workspace.restorePersistedState(state.filesRead, state.changes);
        state.filesRead = new Map(workspace.getReadVersions().map((version) => [version.path, version]));
        state.changes = workspace.getChangeSet();
        const releasedOrphanedSubagents = releaseOrphanedSubagentTasks(threadStore, state);
        const repairedInterruptedTurn = repairInterruptedTurn(threadStore, state);
        resumeRecovery = resumeRecoverySummary(state, restoredWorkspace, {
          interruptedTurnRepaired: repairedInterruptedTurn,
          reconciledSubagentAssignments: releasedOrphanedSubagents,
        });
        shouldCheckpoint =
          shouldCheckpoint ||
          previousMode !== state.mode ||
          previousProvider !== state.provider ||
          previousModel !== state.model ||
          previousThinkingEffort !== state.thinkingEffort ||
          restoredWorkspace.staleReadVersions > 0 ||
          JSON.stringify(state.changes) !== savedChanges ||
          repairedInterruptedTurn ||
          releasedOrphanedSubagents > 0;
      } else {
        const selectedProvider = options.provider ?? config.provider;
        const selectedMode = options.mode ?? config.mode;
        const selectedModel = options.model
          ? requireCatalogModel(selectedProvider, options.model).id
          : config.providers[selectedProvider]!.model;
        state = threadStore.create({
          workspaceRoot: workspace.root,
          projectId: workspace.projectId,
          workspaceRevision: workspace.revision,
          workspaceFolders: workspace.folders.map((folder, index) => ({
            id: folder.id ?? `folder_${index + 1}`,
            key: folder.key,
            path: folder.path,
          })),
          primaryWorkspaceFolderId: workspace.folders.find((folder) => samePath(folder.path, workspace.root))?.id,
          mode: selectedMode,
          provider: selectedProvider,
          model: selectedModel,
          orchestrationEnabled: config.orchestrationEnabled,
          thinkingEffort: options.thinkingEffort ?? config.thinkingEffort,
          promptBundle,
          modelRegistryHash: config.modelRegistryHash,
        });
        threadLease = threadStore.acquireThreadLease(state.threadId);
      }

      config.workspaceRoot = workspace.root;
      config.provider = state.provider;
      config.mode = state.mode;
      config.thinkingEffort = state.thinkingEffort;
      config.providers[state.provider]!.model = state.model;
      if (shouldCheckpoint) threadStore.save(state);
      const app = new EasyCodeApp(
        config,
        storage,
        workspace,
        state,
        threadLease,
        terminal,
        options.keepInteractionOpen ?? false,
        options.assumeYes ?? false,
        options.maxModelRequests,
        trustedOuterSandbox,
        credentialStore,
        options.startupInteraction ?? "none",
        options.sandboxStartup
          ? (options.sandboxStartupService ??
              new NativeSandboxStartupService(
                config.limits,
                config.dataDir,
                (message) => terminal.info(message),
                workspace.writableRoots,
              ))
          : undefined,
        options.clipboardImageReader ??
          new SystemClipboardImageReader({
            currentDirectory: workspace.root,
          }),
        options.toolSourceFactories ?? [],
        options.authorizeToolExecution,
        resumeRecovery,
        options.workspaceMutationLock,
      );
      try {
        await app.imageStore.initialize();
        if (resumeRecovery) {
          const recoveredStandaloneSubagents = app.restoreSubagents();
          app.pendingResumeRecovery = {
            ...resumeRecovery,
            restoredReasoningBlocks: app.restoreReasoningHistory(),
            recoveredStandaloneSubagents,
          };
        }
        for (const imagePath of options.imagePaths ?? []) {
          await app.queueImagePath(imagePath, false);
        }
        if (!harborProviderApiKey) app.modelSelection.rememberLastModel();
      } catch (error) {
        const setupErrors: unknown[] = [error];
        try {
          // A later startup step may fail after a validated recovery batch has
          // started. Pause and await every child before releasing the parent
          // lease/storage so no orphan process keeps issuing tools.
          await app.subagentHost.pauseSubagentsForResume();
        } catch (pauseError) {
          setupErrors.push(pauseError);
        }
        try {
          await app.clearPendingImages();
        } catch (imageError) {
          setupErrors.push(imageError);
        }
        try {
          await app.imageStore.shutdown();
        } catch (shutdownError) {
          setupErrors.push(shutdownError);
        }
        if (setupErrors.length > 1) {
          throw new AggregateError(
            setupErrors,
            "EASY CODE startup failed and recovered child cleanup also reported errors",
          );
        }
        throw error;
      }
      return app;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (threadLease && threadStore) {
        try {
          threadStore.releaseThreadLease(threadLease);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        storage?.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        terminal.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "EASY CODE creation failed and resource cleanup also failed",
        );
      }
      throw error;
    }
  }

  private uninstallRequested = false;
  private uninstallController?: AbortController;
  requestUninstallShutdown(): void {
    this.uninstallRequested = true;
    this.memoryMaintenanceController?.abort();
    if (this.uninstallController) this.uninstallController.abort();
    else this.terminal.close();
  }

  private startMemoryMaintenance(): void {
    if (this.trustedOuterSandbox || this.memoryMaintenanceTimer) return;
    this.memoryMaintenanceTimer = setInterval(() => {
      void this.maintainMemoryWhenIdle();
    }, 60_000);
    this.memoryMaintenanceTimer.unref();
  }

  private async maintainMemoryWhenIdle(): Promise<void> {
    if (
      this.closed ||
      this.uninstallRequested ||
      this.uninstallController ||
      this.state.activeTurnId ||
      this.memoryMaintenanceWork
    )
      return;
    const controller = new AbortController();
    this.memoryMaintenanceController = controller;
    const work = (async () => {
      try {
        const maintenance = new MemoryMaintenance(
          this.storage,
          this.memoryManager,
          this.workspace.root,
          this.state.projectId ?? projectMemoryIdFromRoot(this.workspace.root),
        );
        maintenance.recover();
        this.memoryManager.expireDueMemories(this.state.projectId ?? projectMemoryIdFromRoot(this.workspace.root));
        this.memoryManager.expireDueMemories(GLOBAL_MEMORY_WORKSPACE_ID);
        maintenance.enqueueCompleted();
        if (!maintenance.hasPending()) return;
        this.modelSelection.requireProviderApiKey(this.state.provider);
        const provider = createProvider(this.effectiveConfig(), this.state.provider, this.state.model);
        await maintenance.processNext(this.state, provider, controller.signal);
      } catch {
        // Idle maintenance must never interrupt input or the main agent.
      }
    })();
    this.memoryMaintenanceWork = work;
    try {
      await work;
    } finally {
      if (this.memoryMaintenanceController === controller) this.memoryMaintenanceController = undefined;
      if (this.memoryMaintenanceWork === work) this.memoryMaintenanceWork = undefined;
    }
  }

  private async pauseMemoryMaintenance(wait = false): Promise<void> {
    this.memoryMaintenanceController?.abort();
    if (wait) await this.memoryMaintenanceWork;
  }

  /** Start a non-terminal host without entering the CLI prompt-reading loop. */
  startHostedSession(): void {
    this.terminal.beginShell(this.terminalSessionInfo());
    this.syncTerminalView();
    this.announceResumeRecovery();
    this.startMemoryMaintenance();
  }

  sessionInfo(): UISessionInfo {
    return this.terminalSessionInfo();
  }
  async selectHostedModel(): Promise<void> {
    this.subagentHost.assertNoRunningSubagents("switch models or thinking effort");
    await this.modelSelection.selectModelFromPicker(false);
  }
  async selectHostedApproval(): Promise<void> {
    this.assertNoRunningCommands("change command execution mode");
    await this.selectCommandExecutionMode(false);
  }
  async selectHostedOrchestration(): Promise<void> {
    await this.updateOrchestration([], false);
  }
  async selectHostedMode(): Promise<void> {
    this.subagentHost.assertNoRunningSubagents("switch modes");
    const language = readLanguage(this.storage);
    const selected = await this.terminal.selectChoice(
      translate(language, "ui.mode"),
      [
        {
          id: "plan",
          label: translate(language, "ui.modePlan"),
          disabled: Boolean(
            this.state.mode !== "plan" && this.state.taskGraph && this.state.taskGraph.status !== "completed",
          ),
        },
        { id: "auto", label: translate(language, "ui.modeAuto") },
        { id: "code", label: translate(language, "ui.modeCode") },
      ],
      this.state.mode,
    );
    if (selected && selected !== this.state.mode) await this.handleSlashCommand(`/mode ${selected}`);
  }
  dataDirectory(): string {
    return this.config.dataDir;
  }
  allThreads(): readonly ThreadSummary[] {
    return this.threadStore
      .list({ limit: 100_000 })
      .filter((session) => !this.threadStore.isBoundSubagentThread(session.threadId));
  }
  isRequestActive(): boolean {
    return this.activeTurnController !== undefined;
  }
  isCompacting(): boolean {
    return Boolean(this.compacting || this.autoCompacting);
  }

  /** Project membership is immutable while any Thread-owned execution can
   * still observe or mutate its bound workspace revision. */
  isProjectWorkspaceBusy(): boolean {
    return (
      this.isRequestActive() ||
      this.hasRunningCommands() ||
      this.subagentCoordinator.hasUnfinished(this.state.threadId) ||
      this.subagentCoordinator.hasOutstanding(this.state.threadId) ||
      Boolean(this.pendingPlan())
    );
  }
  threadEvents(): readonly EventRecord[] {
    return this.threadStore.journal(this.state.threadId).read();
  }
  workspaceThreads(): readonly ThreadSummary[] {
    return this.resumableThreads();
  }
  deleteHostedThread(threadId: string): readonly string[] {
    if (this.isRequestActive() || threadId === this.state.threadId) {
      throw new Error("Switch away from the active conversation before deleting it.");
    }
    return deleteThreadTree(this.storage, this.threadStore, threadId);
  }
  pendingPlan(): PlanProposal | undefined {
    return this.state.planReview?.proposal;
  }
  nextHostedImageLabel(stagedCount = 0): string {
    return this.imageInputs.nextHostedImageLabel(stagedCount);
  }

  async startNewHostedThread(): Promise<void> {
    if (this.isRequestActive()) throw new Error("Cannot switch Thread while a request is running.");
    await this.clearPendingImages();
    await this.newThread();
    this.terminal.resetForNewThread(this.terminalSessionInfo());
    this.syncTerminalView();
  }

  async resumeHostedThread(threadId: string): Promise<void> {
    if (this.isRequestActive()) throw new Error("Cannot switch Thread while a request is running.");
    await this.clearPendingImages();
    await this.resumeThread(threadId);
    this.terminal.resetForNewThread(this.terminalSessionInfo());
    this.syncTerminalView();
    this.announceResumeRecovery();
  }
  async importHostedImage(data: Buffer, label: string, sourceName?: string): Promise<ImageAttachment> {
    return this.imageInputs.importHostedImage(data, label, sourceName);
  }

  discardHostedImage(image: ImageAttachment): Promise<void> {
    return this.imageInputs.discardHostedImage(image);
  }

  async importHostedDocument(data: Buffer, filename: string, mediaType: string): Promise<ThreadResourceAttachment> {
    return this.imageInputs.importHostedDocument(data, filename, mediaType);
  }

  hostedDocumentMaxBytes(): number {
    return this.imageInputs.hostedDocumentMaxBytes();
  }

  discardHostedResource(resource: ThreadResourceAttachment): Promise<void> {
    return this.imageInputs.discardHostedResource(resource);
  }

  /** A browser supplies the decision, while the existing Journal transition remains authoritative. */
  async reviewHostedPlan(decision: PlanReviewDecision): Promise<void> {
    if (this.isRequestActive()) throw new Error("Wait for the active request before reviewing its plan.");
    if (!this.state.planReview) throw new Error("This Thread has no pending plan.");
    await this.processPendingPlanReview(true, decision);
  }
  async runInteractive(): Promise<void> {
    return this.shellCommands.runInteractive();
  }
  async runOnce(prompt: string): Promise<AgentRunResult> {
    return this.turnExecution.runOnce(prompt);
  }
  async submitUserMessage(
    text: string,
    images: readonly ImageAttachment[] = [],
    resources: readonly ThreadResourceAttachment[] = [],
  ): Promise<AgentRunResult> {
    return this.turnExecution.submitUserMessage(text, images, resources);
  }

  /** Cancel only the currently active turn; presentation hosts choose their own cancel gesture. */
  cancelActiveRequest(): boolean {
    const controller = this.activeTurnController;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }
  async submitAdjustment(text: string, images: readonly ImageAttachment[] = []): Promise<number> {
    return this.turnExecution.submitAdjustment(text, images);
  }
  async handleSlashCommand(input: string): Promise<boolean> {
    return this.shellCommands.handleSlashCommand(input);
  }

  close(): void {
    if ([...this.toolObservers].some((observer) => observer.hasPending)) {
      throw new Error("Background tool observations are pending; use closeAsync() to finish recording them.");
    }
    if (this.memoryMaintenanceWork) {
      throw new Error("Cannot close synchronously while background memory maintenance is running; use closeAsync().");
    }
    if (this.memoryMaintenanceTimer) clearInterval(this.memoryMaintenanceTimer);
    this.memoryMaintenanceTimer = undefined;
    if (!this.closed && this.hasRunningCommands()) {
      throw new Error(
        "Cannot close synchronously while background commands are running; use closeAsync() so they are canceled and audited first.",
      );
    }
    if (!this.closed && this.subagentCoordinator.hasOutstanding(this.state.threadId)) {
      throw new Error(
        "Cannot close synchronously while child work is outstanding; use closeAsync() so children are stopped and reconciled first.",
      );
    }
    if ([...this.mainToolCatalogs.values()].some((catalog) => catalog.requiresAsyncClose())) {
      throw new Error("Cannot close synchronously while a tool source has a managed lifecycle; use closeAsync().");
    }
    if (this.mcpConnections?.hasConnections()) {
      throw new Error("Cannot close synchronously while MCP servers are connected; use closeAsync().");
    }
    this.closeResources();
  }

  private closeResources(): void {
    if (this.closed) return;
    this.closed = true;
    const cleanupErrors: unknown[] = [];
    try {
      this.localLayaClient?.close();
      this.localLayaClient = undefined;
      this.save();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (this.threadLease) {
      try {
        this.threadStore.releaseThreadLease(this.threadLease);
        this.threadLease = undefined;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      for (const catalog of this.mainToolCatalogs.values()) catalog.closeSync();
      this.mainToolCatalogs.clear();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      this.contextArtifactIndex.close();
      this.memoryManager.close();
      this.storage.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (!this.keepInteractionOpen) this.terminal.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    this.commandRuntimes?.clear();
    // Stay closed even when a step failed: the database is already closed, so a
    // retry could not repeat the checkpoint or lease release and would only fail.
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Failed to close EASY CODE cleanly");
  }

  closeAsync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closeAsyncWork ??= this.performCloseAsync().catch((error: unknown) => {
      // A failure that stopped before closeResources() left the app open; let a later call try again.
      this.closeAsyncWork = undefined;
      throw error;
    });
    return this.closeAsyncWork;
  }

  private async performCloseAsync(): Promise<void> {
    const cleanupErrors: unknown[] = [];
    if (this.memoryMaintenanceTimer) clearInterval(this.memoryMaintenanceTimer);
    this.memoryMaintenanceTimer = undefined;
    try {
      await this.pauseMemoryMaintenance(true);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this.cancelRunningCommands();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this.subagentHost.pauseSubagentsForResume();
    } catch (error) {
      cleanupErrors.push(error);
    }
    await Promise.all([...this.toolObservers].map((observer) => observer.drain()));
    try {
      await this.clearPendingImages();
      await this.imageStore.shutdown();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const catalogs = [...this.mainToolCatalogs.values()];
      this.mainToolCatalogs.clear();
      await Promise.all(catalogs.map((catalog) => catalog.close()));
      await this.mcpConnections?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      this.closeResources();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Failed to close EASY CODE cleanly");
  }
  private async processPendingPlanReview(showPlan: boolean, suppliedDecision?: PlanReviewDecision): Promise<boolean> {
    return this.turnExecution.processPendingPlanReview(showPlan, suppliedDecision);
  }
  private async compactCurrentSession(): Promise<void> {
    return this.turnExecution.compactCurrentSession();
  }

  private executePromptOwned(...args: Parameters<AppTurnExecution["executePromptOwned"]>): Promise<AgentRunResult> {
    return this.turnExecution.executePromptOwned(...args);
  }
  private requireCurrentModelVision(): void {
    return this.imageInputs.requireCurrentModelVision();
  }
  private async captureClipboardImage(
    index: number,
    currentImages: readonly ImageAttachment[] = this.pendingImages,
    signal?: AbortSignal,
  ): Promise<ImageAttachment> {
    return this.imageInputs.captureClipboardImage(index, currentImages, signal);
  }
  private async queueImagePath(rawPath: string, announce: boolean): Promise<ImageAttachment> {
    return this.imageInputs.queueImagePath(rawPath, announce);
  }
  private async discardImages(images: readonly ImageAttachment[]): Promise<void> {
    return this.imageInputs.discardImages(images);
  }
  private async clearPendingImages(): Promise<void> {
    return this.imageInputs.clearPendingImages();
  }
  private async selectCommandExecutionMode(
    announceCancellation = true,
    requested?: CommandExecutionMode,
  ): Promise<void> {
    return this.shellCommands.selectCommandExecutionMode(announceCancellation, requested);
  }
  private effectiveConfig(): EasyCodeConfig {
    return this.shellCommands.effectiveConfig();
  }

  private restoreReasoningHistory(): number {
    return this.threadSessions.restoreReasoningHistory();
  }

  private announceResumeRecovery(): void {
    return this.threadSessions.announceResumeRecovery();
  }

  private activeContextCharLimit(): number {
    return this.config.limits.maxContextChars;
  }
  private orchestrationEnabled(): boolean {
    return this.shellCommands.orchestrationEnabled();
  }
  private async updateOrchestration(args: readonly string[] = [], reportCancel = true): Promise<void> {
    return this.shellCommands.updateOrchestration(args, reportCancel);
  }
  private hasActiveOrchestration(): boolean {
    return this.shellCommands.hasActiveOrchestration();
  }
  private sharedTaskBudget(threadId: string): TaskBudget {
    return this.turnExecution.sharedTaskBudget(threadId);
  }

  private newTaskBudget(threadId: string): TaskBudget {
    return this.turnExecution.newTaskBudget(threadId);
  }

  private syncWorkspaceState(): void {
    return this.threadSessions.syncWorkspaceState();
  }
  private async updateWorkspaceCommand(rawArgs: string): Promise<void> {
    return this.threadSessions.updateWorkspaceCommand(rawArgs);
  }
  private async newThread(): Promise<void> {
    return this.threadSessions.newThread();
  }
  private async resumeThread(threadId: string): Promise<void> {
    return this.threadSessions.resumeThread(threadId);
  }
  private save(): void {
    return this.threadSessions.save();
  }
  private terminalSessionInfo(): UISessionInfo {
    return this.threadSessions.terminalSessionInfo();
  }

  private syncTerminalView(announceHeader = false): void {
    return this.threadSessions.syncTerminalView(announceHeader);
  }

  /** Files of the workspace manifest, for `@` references; empty until the first scan finishes. */
  workspaceMentionPaths(): readonly string[] {
    const snapshot = this.workspace.getManifestSnapshot();
    if (!snapshot) {
      this.mentionManifestScan ??= this.workspace
        .refreshManifest()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.mentionManifestScan = undefined;
        });
      return [];
    }
    return [...snapshot.files.values()].map((entry) => entry.path);
  }

  private resumableThreads(): ThreadSummary[] {
    return this.threadSessions.resumableThreads();
  }
  private async selectResumeThread(): Promise<string | undefined> {
    return this.threadSessions.selectResumeThread();
  }

  private observedToolCatalog(workspace: WorkspaceManager, runtime: CommandRuntime): ToolCatalog {
    if (this.trustedOuterSandbox) return new ToolCatalog();
    const observer = new WorkspaceToolObserver(
      workspace,
      this.threadStore.coordination,
      this.config.limits,
      (message) => this.terminal.warning(message),
      (id) => runtime.whenSettled(id),
      [this.config.dataDir, this.config.cacheDir, this.config.configDir],
    );
    this.toolObservers.add(observer);
    return new ToolCatalog(observer);
  }

  private async mainToolCatalogSnapshot(): Promise<Readonly<ToolCatalogSnapshot>> {
    if (!this.trustedOuterSandbox) {
      this.mcpAutoConnectPromise ??= this.mcpServers.connectEnabledMcpServers();
      await this.mcpAutoConnectPromise;
    }
    const threadId = this.state.threadId;
    let catalog = this.mainToolCatalogs.get(threadId);
    if (!catalog) {
      let downloadBroker: DownloadBroker | undefined;
      if (!this.trustedOuterSandbox) {
        let broker = this.downloadBrokers.get(threadId);
        if (!broker) {
          broker = DownloadBroker.create(this.workspace, this.config.configDir, this.config.cacheDir, threadId);
          this.downloadBrokers.set(threadId, broker);
        }
        downloadBroker = await broker;
      }
      const commandRuntime = this.createCommandRuntime(this.workspace);
      catalog = this.observedToolCatalog(this.workspace, commandRuntime);
      catalog.registerSource(
        new BuiltinToolSource({
          profile: this.trustedOuterSandbox ? "benchmark" : undefined,
          coordination: this.threadStore.coordination,
          workspace: this.workspace,
          skillStore: SkillStore.forProject(
            this.workspace.root,
            this.config.dataDir,
            this.state.projectId ?? workspaceIdFromRoot(this.workspace.root),
          ),
          memoryManager: this.memoryManager,
          subagentControl: this.subagentCoordinator,
          commandRuntime,
          downloadBroker,
          limits: this.config.limits,
          mutationLock: this.workspaceMutationLock,
          threadTitleStore: this.threadTitles,
          threadResourceStore: this.threadResourceStore,
          threadDocumentService: this.threadDocumentService,
          includePublicWebTools: this.trustedOuterSandbox !== "harbor",
          ...(this.trustedOuterSandbox
            ? {}
            : {
                mcpConfigStore: this.mcpConfigStore,
                onMcpConfigChanged: (id: string) => this.mcpServers.mcp().disconnect(id),
              }),
        }),
      );
      if (!this.trustedOuterSandbox) catalog.registerSource(new McpToolSource(this.mcpServers.mcp()));
      for (const factory of this.trustedOuterSandbox ? [] : (this.toolSourceFactories ?? [])) {
        catalog.registerSource(
          await factory({
            workspaceRoot: this.workspace.root,
            threadId,
            role: "main_agent",
          }),
        );
      }
      this.mainToolCatalogs.set(threadId, catalog);
    }
    try {
      return await catalog.snapshot();
    } catch (error) {
      this.mainToolCatalogs.delete(threadId);
      try {
        await catalog.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Failed to load and close tool catalog for thread ${threadId}`);
      }
      throw error;
    }
  }

  private async prepareProjectSandbox(workspace: WorkspaceManager): Promise<void> {
    if (
      process.platform !== "win32" ||
      this.trustedOuterSandbox ||
      this.commandExecutionMode === "unrestricted" ||
      !this.sandboxStartupService ||
      this.sandboxSetupDeferred
    )
      return;
    const service = new NativeSandboxStartupService(
      this.config.limits,
      this.config.dataDir,
      (message) => this.terminal.info(message),
      workspace.writableRoots,
    );
    const readiness = await service.prepare();
    if (readiness.status !== "ready") {
      throw new Error(
        `Project command sandbox is not ready: ${readiness.details.join("; ")}. ` +
          "No command was dispatched. Complete Windows sandbox setup before continuing.",
      );
    }
  }

  private createCommandRuntime(workspace: WorkspaceManager): CommandRuntime {
    const existing = this.commandRuntimes.get(workspace);
    if (existing) return existing;
    for (const root of [
      this.config.configDir,
      this.config.dataDir,
      this.config.cacheDir,
      USER_MODEL_REGISTRY_PATH,
      USER_MCP_CONFIG_PATH,
    ])
      workspace.pathGuard.protect(root);
    workspace.pathGuard.protect(fileURLToPath(new URL("./", import.meta.url)));
    workspace.pathGuard.protect(fileURLToPath(new URL("../node_modules", import.meta.url)));
    const runtime = new CommandRuntime(
      workspace,
      undefined,
      this.trustedOuterSandbox === "harbor"
        ? new BenchmarkContainerBackend()
        : new NativeSandboxBackend(workspace, {
            limits: this.config.limits,
            dataDir: this.config.dataDir,
          }),
      undefined,
      {
        networkProfile: this.trustedOuterSandbox === "harbor" ? "benchmark" : "development",
        limits: this.config.limits,
        quarantinePath: path.join(
          this.config.dataDir,
          "command-quarantine",
          `${workspace.projectId ?? this.state.projectId ?? workspaceIdFromRoot(workspace.root)}.json`,
        ),
        lifecycleDirectory: path.join(
          this.config.dataDir,
          "command-leases",
          workspace.projectId ?? this.state.projectId ?? workspaceIdFromRoot(workspace.root),
        ),
        boundaryStatePath: path.join(
          this.config.dataDir,
          "command-boundary",
          `${workspace.projectId ?? this.state.projectId ?? workspaceIdFromRoot(workspace.root)}.json`,
        ),
        createOutputArchive: (commandId, context) =>
          this.memoryManager.evidenceStore.createCommandArchive(
            this.state.projectId ?? workspaceIdFromRoot(this.workspace.root),
            context.threadId,
            commandId,
          ),
        recordLifecycle: (context, commandId, type, payload) => {
          this.threadStore.appendEvent(context.threadId, {
            type,
            turnId: context.turnId,
            phase: "completed",
            payload: { commandId, detail: payload },
          });
        },
      },
    );
    this.commandRuntimes.set(workspace, runtime);
    return runtime;
  }

  private hasRunningCommands(): boolean {
    return [...this.commandRuntimes.values()].some((runtime) => runtime.hasRunningCommands());
  }

  private async cancelRunningCommands(): Promise<void> {
    await Promise.all([...this.commandRuntimes.values()].map((runtime) => runtime.cancelAll()));
  }

  private assertNoRunningCommands(action: string): void {
    if (!this.hasRunningCommands()) return;
    throw new Error(
      `Cannot ${action} while a run_command background handle is active; ` +
        "ask the agent to wait for or cancel the command first.",
    );
  }

  private mcpServersInstance?: McpServerController;
  private get mcpServers(): McpServerController {
    return (this.mcpServersInstance ??= new McpServerController(this.mcpServersContext()));
  }
  private mcpServersContext(): McpServerControllerContext {
    const app = this;
    return {
      get config() {
        return app.config;
      },
      createCommandRuntime: (...args) => app.createCommandRuntime(...args),
      handleSlashCommand: (...args) => app.handleSlashCommand(...args),
      get mcpConfigStore() {
        return app.mcpConfigStore;
      },
      get mcpConnections() {
        return app.mcpConnections;
      },
      set mcpConnections(value) {
        app.mcpConnections = value;
      },
      get terminal() {
        return app.terminal;
      },
      get trustedOuterSandbox() {
        return app.trustedOuterSandbox;
      },
      get workspace() {
        return app.workspace;
      },
    };
  }

  private showMcpServers(requested?: { serverId: string; action: string }): Promise<void> {
    return this.mcpServers.showMcpServers(requested);
  }

  private modelSelectionInstance?: ModelSelection;
  private get modelSelection(): ModelSelection {
    return (this.modelSelectionInstance ??= new ModelSelection(this.modelSelectionContext()));
  }
  private modelSelectionContext(): ModelSelectionContext {
    const app = this;
    return {
      get config() {
        return app.config;
      },
      get credentialStore() {
        return app.credentialStore;
      },
      get dirty() {
        return app.dirty;
      },
      set dirty(value) {
        app.dirty = value;
      },
      handleSlashCommand: (...args) => app.handleSlashCommand(...args),
      get pendingImages() {
        return app.pendingImages;
      },
      save: (...args) => app.save(...args),
      get state() {
        return app.state;
      },
      get storage() {
        return app.storage;
      },
      syncTerminalView: (...args) => app.syncTerminalView(...args),
      get terminal() {
        return app.terminal;
      },
    };
  }

  private approvalReviewerInstance?: ApprovalReviewer;
  private get approvalReviewer(): ApprovalReviewer {
    return (this.approvalReviewerInstance ??= new ApprovalReviewer(this.approvalReviewerContext()));
  }
  private approvalReviewerContext(): ApprovalReviewerContext {
    const app = this;
    return {
      get config() {
        return app.config;
      },
      effectiveConfig: (...args) => app.effectiveConfig(...args),
      sharedTaskBudget: (...args) => app.sharedTaskBudget(...args),
      get state() {
        return app.state;
      },
      get threadStore() {
        return app.threadStore;
      },
    };
  }

  private reviewApproval(request: ApprovalRequest): Promise<ApprovalReview> {
    return this.approvalReviewer.reviewApproval(request);
  }

  private reviewCatalogToolApproval(
    identity: ToolApprovalIdentity,
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<ToolApprovalReview> {
    return this.approvalReviewer.reviewCatalogToolApproval(identity, threadId, turnId, signal);
  }

  private approvalFlowInstance?: ApprovalFlow;
  private get approvalFlow(): ApprovalFlow {
    return (this.approvalFlowInstance ??= new ApprovalFlow(this.approvalFlowContext()));
  }
  private approvalFlowContext(): ApprovalFlowContext {
    const app = this;
    return {
      get approvalQueue() {
        return app.approvalQueue;
      },
      set approvalQueue(value) {
        app.approvalQueue = value;
      },
      get assumeYes() {
        return app.assumeYes;
      },
      get authorizeToolExecution() {
        return app.authorizeToolExecution;
      },
      get commandExecutionMode() {
        return app.commandExecutionMode;
      },
      get dirty() {
        return app.dirty;
      },
      set dirty(value) {
        app.dirty = value;
      },
      reviewApproval: (...args) => app.reviewApproval(...args),
      reviewCatalogToolApproval: (...args) => app.reviewCatalogToolApproval(...args),
      get state() {
        return app.state;
      },
      get terminal() {
        return app.terminal;
      },
      get threadStore() {
        return app.threadStore;
      },
    };
  }

  private requestToolApproval(request: ApprovalRequest): Promise<boolean> {
    return this.approvalFlow.requestToolApproval(request);
  }

  private requestSubagentApproval(
    request: ApprovalRequest,
    source: { agentId: string; taskId: string; label: string },
  ): Promise<boolean> {
    return this.approvalFlow.requestSubagentApproval(request, source);
  }

  private authorizeCatalogToolCall(request: Readonly<ToolExecutionAuthorizationRequest>): Promise<boolean> {
    return this.approvalFlow.authorizeCatalogToolCall(request);
  }

  private infoCommandsInstance?: InfoCommands;
  private get infoCommands(): InfoCommands {
    return (this.infoCommandsInstance ??= new InfoCommands(this.infoCommandsContext()));
  }
  private infoCommandsContext(): InfoCommandsContext {
    const app = this;
    return {
      activeContextCharLimit: (...args) => app.activeContextCharLimit(...args),
      assertNoRunningCommands: (...args) => app.assertNoRunningCommands(...args),
      get commandExecutionMode() {
        return app.commandExecutionMode;
      },
      get config() {
        return app.config;
      },
      get dirty() {
        return app.dirty;
      },
      set dirty(value) {
        app.dirty = value;
      },
      effectiveConfig: (...args) => app.effectiveConfig(...args),
      mainToolCatalogSnapshot: (...args) => app.mainToolCatalogSnapshot(...args),
      get maxModelRequests() {
        return app.maxModelRequests;
      },
      get memoryManager() {
        return app.memoryManager;
      },
      orchestrationEnabled: (...args) => app.orchestrationEnabled(...args),
      get pendingImages() {
        return app.pendingImages;
      },
      resumableThreads: (...args) => app.resumableThreads(...args),
      get state() {
        return app.state;
      },
      get storage() {
        return app.storage;
      },
      get subagentCoordinator() {
        return app.subagentCoordinator;
      },
      syncWorkspaceState: (...args) => app.syncWorkspaceState(...args),
      get taskBudgets() {
        return app.taskBudgets;
      },
      get terminal() {
        return app.terminal;
      },
      get threadStore() {
        return app.threadStore;
      },
      get trustedOuterSandbox() {
        return app.trustedOuterSandbox;
      },
      get workspace() {
        return app.workspace;
      },
    };
  }

  private subagentHostInstance?: SubagentHost;
  private get subagentHost(): SubagentHost {
    return (this.subagentHostInstance ??= new SubagentHost(this.subagentHostContext()));
  }
  private subagentHostContext(): SubagentHostContext {
    const app = this;
    return {
      authorizeCatalogToolCall: (...args) => app.authorizeCatalogToolCall(...args),
      get commandExecutionMode() {
        return app.commandExecutionMode;
      },
      get commandRuntimes() {
        return app.commandRuntimes;
      },
      get config() {
        return app.config;
      },
      get contextArtifactIndex() {
        return app.contextArtifactIndex;
      },
      createCommandRuntime: (...args) => app.createCommandRuntime(...args),
      currentProjectWorkspace: (...args) => app.currentProjectWorkspace(...args),
      get dirty() {
        return app.dirty;
      },
      set dirty(value) {
        app.dirty = value;
      },
      effectiveConfig: (...args) => app.effectiveConfig(...args),
      get executionEnvironments() {
        return app.executionEnvironments;
      },
      get hostAccessEpoch() {
        return app.hostAccessEpoch;
      },
      get maxModelRequests() {
        return app.maxModelRequests;
      },
      get memoryManager() {
        return app.memoryManager;
      },
      observedToolCatalog: (...args) => app.observedToolCatalog(...args),
      prepareProjectSandbox: (...args) => app.prepareProjectSandbox(...args),
      requestSubagentApproval: (...args) => app.requestSubagentApproval(...args),
      save: (...args) => app.save(...args),
      sharedTaskBudget: (...args) => app.sharedTaskBudget(...args),
      get state() {
        return app.state;
      },
      get storage() {
        return app.storage;
      },
      get subagentCoordinator() {
        return app.subagentCoordinator;
      },
      get subagentMessages() {
        return app.subagentMessages;
      },
      syncWorkspaceState: (...args) => app.syncWorkspaceState(...args),
      get terminal() {
        return app.terminal;
      },
      get threadStore() {
        return app.threadStore;
      },
      get toolSourceFactories() {
        return app.toolSourceFactories;
      },
      get trustedOuterSandbox() {
        return app.trustedOuterSandbox;
      },
      get workspace() {
        return app.workspace;
      },
      get workspaceMutationLock() {
        return app.workspaceMutationLock;
      },
    };
  }

  private currentProjectWorkspace(): ProjectWorkspace | undefined {
    return this.threadSessions.currentProjectWorkspace();
  }

  private runSubagent(request: SubagentExecutionRequest): Promise<SubagentExecutionOutcome> {
    return this.subagentHost.runSubagent(request);
  }

  private restoreSubagents(): number {
    return this.subagentHost.restoreSubagents();
  }

  private runtimeAssemblyInstance?: RuntimeAssembly;
  private get runtimeAssembly(): RuntimeAssembly {
    return (this.runtimeAssemblyInstance ??= new RuntimeAssembly(this.runtimeAssemblyContext()));
  }
  private runtimeAssemblyContext(): RuntimeAssemblyContext {
    const app = this;
    return {
      get approvalQueue() {
        return app.approvalQueue;
      },
      authorizeCatalogToolCall: (...args) => app.authorizeCatalogToolCall(...args),
      get autoCompacting() {
        return app.autoCompacting;
      },
      set autoCompacting(value) {
        app.autoCompacting = value;
      },
      get commandExecutionMode() {
        return app.commandExecutionMode;
      },
      get compacting() {
        return app.compacting;
      },
      get config() {
        return app.config;
      },
      get contextArtifactIndex() {
        return app.contextArtifactIndex;
      },
      get contextManager() {
        return app.contextManager;
      },
      createCommandRuntime: (...args) => app.createCommandRuntime(...args),
      get dirty() {
        return app.dirty;
      },
      set dirty(value) {
        app.dirty = value;
      },
      effectiveConfig: (...args) => app.effectiveConfig(...args),
      hasRunningCommands: (...args) => app.hasRunningCommands(...args),
      get imageStore() {
        return app.imageStore;
      },
      get infoCommands() {
        return app.infoCommands;
      },
      get localLayaClient() {
        return app.localLayaClient;
      },
      set localLayaClient(value) {
        app.localLayaClient = value;
      },
      mainToolCatalogSnapshot: (...args) => app.mainToolCatalogSnapshot(...args),
      get mcpConnections() {
        return app.mcpConnections;
      },
      get memoryManager() {
        return app.memoryManager;
      },
      newTaskBudget: (...args) => app.newTaskBudget(...args),
      requestToolApproval: (...args) => app.requestToolApproval(...args),
      reviewApproval: (...args) => app.reviewApproval(...args),
      save: (...args) => app.save(...args),
      sharedTaskBudget: (...args) => app.sharedTaskBudget(...args),
      get state() {
        return app.state;
      },
      get storage() {
        return app.storage;
      },
      get subagentCoordinator() {
        return app.subagentCoordinator;
      },
      get subagentHost() {
        return app.subagentHost;
      },
      get subagentMessages() {
        return app.subagentMessages;
      },
      syncTerminalView: (...args) => app.syncTerminalView(...args),
      syncWorkspaceState: (...args) => app.syncWorkspaceState(...args),
      get taskBudgets() {
        return app.taskBudgets;
      },
      get terminal() {
        return app.terminal;
      },
      get threadStore() {
        return app.threadStore;
      },
      get threadTitles() {
        return app.threadTitles;
      },
      get trustedOuterSandbox() {
        return app.trustedOuterSandbox;
      },
      get workspace() {
        return app.workspace;
      },
      get workspaceMutationLock() {
        return app.workspaceMutationLock;
      },
    };
  }

  private createRuntime(
    presentReasoning: boolean,
    steeringNotifier?: TurnSteeringAttemptNotifier,
  ): Promise<AgentRuntime> {
    return this.runtimeAssembly.createRuntime(presentReasoning, steeringNotifier);
  }

  private threadSessionsInstance?: AppThreadSessions;
  private get threadSessions(): AppThreadSessions {
    return (this.threadSessionsInstance ??= new AppThreadSessions(this.threadSessionsContext()));
  }
  private threadSessionsContext(): AppThreadSessionsContext {
    const host = this;
    return {
      get activeTurnController() {
        return host.activeTurnController;
      },
      assertNoRunningCommands: (...args) => host.assertNoRunningCommands(...args),
      cancelRunningCommands: (...args) => host.cancelRunningCommands(...args),
      get commandRuntimes() {
        return host.commandRuntimes;
      },
      get config() {
        return host.config;
      },
      get dirty() {
        return host.dirty;
      },
      set dirty(value) {
        host.dirty = value;
      },
      get executionEnvironments() {
        return host.executionEnvironments;
      },
      set executionEnvironments(value) {
        host.executionEnvironments = value;
      },
      get mainToolCatalogs() {
        return host.mainToolCatalogs;
      },
      get modelSelection() {
        return host.modelSelection;
      },
      pendingPlan: (...args) => host.pendingPlan(...args),
      get pendingResumeRecovery() {
        return host.pendingResumeRecovery;
      },
      set pendingResumeRecovery(value) {
        host.pendingResumeRecovery = value;
      },
      restoreSubagents: (...args) => host.restoreSubagents(...args),
      get state() {
        return host.state;
      },
      set state(value) {
        host.state = value;
      },
      get storage() {
        return host.storage;
      },
      get subagentCoordinator() {
        return host.subagentCoordinator;
      },
      get subagentHost() {
        return host.subagentHost;
      },
      get terminal() {
        return host.terminal;
      },
      get threadLease() {
        return host.threadLease;
      },
      set threadLease(value) {
        host.threadLease = value;
      },
      get threadStore() {
        return host.threadStore;
      },
      get workspace() {
        return host.workspace;
      },
      set workspace(value) {
        host.workspace = value;
      },
      get commandExecutionMode() {
        return host.commandExecutionMode;
      },
      orchestrationEnabled: (...args) => host.orchestrationEnabled(...args),
      get trustedOuterSandbox() {
        return host.trustedOuterSandbox;
      },
      get contextManager() {
        return host.contextManager;
      },
      get infoCommands() {
        return host.infoCommands;
      },
    };
  }

  private turnExecutionInstance?: AppTurnExecution;
  private get turnExecution(): AppTurnExecution {
    return (this.turnExecutionInstance ??= new AppTurnExecution(this.turnExecutionContext()));
  }
  private turnExecutionContext(): AppTurnExecutionContext {
    const host = this;
    return {
      executePromptOwned: (...args) => host.executePromptOwned(...args),
      activeContextCharLimit: (...args) => host.activeContextCharLimit(...args),
      get activeTurnController() {
        return host.activeTurnController;
      },
      set activeTurnController(value) {
        host.activeTurnController = value;
      },
      get activeTurnSteering() {
        return host.activeTurnSteering;
      },
      set activeTurnSteering(value) {
        host.activeTurnSteering = value;
      },
      announceResumeRecovery: (...args) => host.announceResumeRecovery(...args),
      get autoCompacting() {
        return host.autoCompacting;
      },
      set autoCompacting(value) {
        host.autoCompacting = value;
      },
      cancelActiveRequest: (...args) => host.cancelActiveRequest(...args),
      captureClipboardImage: (...args) => host.captureClipboardImage(...args),
      get clipboardImageReader() {
        return host.clipboardImageReader;
      },
      get closed() {
        return host.closed;
      },
      get commandExecutionMode() {
        return host.commandExecutionMode;
      },
      get compacting() {
        return host.compacting;
      },
      set compacting(value) {
        host.compacting = value;
      },
      get config() {
        return host.config;
      },
      createRuntime: (...args) => host.createRuntime(...args),
      get dirty() {
        return host.dirty;
      },
      set dirty(value) {
        host.dirty = value;
      },
      discardImages: (...args) => host.discardImages(...args),
      hasActiveOrchestration: (...args) => host.hasActiveOrchestration(...args),
      hasRunningCommands: (...args) => host.hasRunningCommands(...args),
      get hostAccessEpoch() {
        return host.hostAccessEpoch;
      },
      get imageStore() {
        return host.imageStore;
      },
      isCompacting: (...args) => host.isCompacting(...args),
      isRequestActive: (...args) => host.isRequestActive(...args),
      get maxModelRequests() {
        return host.maxModelRequests;
      },
      get modelSelection() {
        return host.modelSelection;
      },
      orchestrationEnabled: (...args) => host.orchestrationEnabled(...args),
      pauseMemoryMaintenance: (...args) => host.pauseMemoryMaintenance(...args),
      get pendingImages() {
        return host.pendingImages;
      },
      set pendingImages(value) {
        host.pendingImages = value;
      },
      prepareProjectSandbox: (...args) => host.prepareProjectSandbox(...args),
      requireCurrentModelVision: (...args) => host.requireCurrentModelVision(...args),
      save: (...args) => host.save(...args),
      get state() {
        return host.state;
      },
      get storage() {
        return host.storage;
      },
      get subagentCoordinator() {
        return host.subagentCoordinator;
      },
      get subagentHost() {
        return host.subagentHost;
      },
      syncTerminalView: (...args) => host.syncTerminalView(...args),
      syncWorkspaceState: (...args) => host.syncWorkspaceState(...args),
      get terminal() {
        return host.terminal;
      },
      get threadResourceStore() {
        return host.threadResourceStore;
      },
      get threadStore() {
        return host.threadStore;
      },
      get uninstallController() {
        return host.uninstallController;
      },
      set uninstallController(value) {
        host.uninstallController = value;
      },
      get uninstallRequested() {
        return host.uninstallRequested;
      },
      get workspace() {
        return host.workspace;
      },
      get taskBudgets() {
        return host.taskBudgets;
      },
    };
  }

  private shellCommandsInstance?: AppShellCommands;
  private get shellCommands(): AppShellCommands {
    return (this.shellCommandsInstance ??= new AppShellCommands(this.shellCommandsContext()));
  }
  private shellCommandsContext(): AppShellCommandsContext {
    const host = this;
    return {
      activeContextCharLimit: (...args) => host.activeContextCharLimit(...args),
      announceResumeRecovery: (...args) => host.announceResumeRecovery(...args),
      assertNoRunningCommands: (...args) => host.assertNoRunningCommands(...args),
      captureClipboardImage: (...args) => host.captureClipboardImage(...args),
      clearPendingImages: (...args) => host.clearPendingImages(...args),
      get clipboardImageReader() {
        return host.clipboardImageReader;
      },
      get closed() {
        return host.closed;
      },
      get commandExecutionMode() {
        return host.commandExecutionMode;
      },
      set commandExecutionMode(value) {
        host.commandExecutionMode = value;
      },
      compactCurrentSession: (...args) => host.compactCurrentSession(...args),
      get compacting() {
        return host.compacting;
      },
      get config() {
        return host.config;
      },
      get contextManager() {
        return host.contextManager;
      },
      get dirty() {
        return host.dirty;
      },
      set dirty(value) {
        host.dirty = value;
      },
      discardImages: (...args) => host.discardImages(...args),
      hasRunningCommands: (...args) => host.hasRunningCommands(...args),
      get hostAccessEpoch() {
        return host.hostAccessEpoch;
      },
      set hostAccessEpoch(value) {
        host.hostAccessEpoch = value;
      },
      get imageStore() {
        return host.imageStore;
      },
      get infoCommands() {
        return host.infoCommands;
      },
      get modelSelection() {
        return host.modelSelection;
      },
      newThread: (...args) => host.newThread(...args),
      get pendingImages() {
        return host.pendingImages;
      },
      set pendingImages(value) {
        host.pendingImages = value;
      },
      pendingPlan: (...args) => host.pendingPlan(...args),
      processPendingPlanReview: (...args) => host.processPendingPlanReview(...args),
      queueImagePath: (...args) => host.queueImagePath(...args),
      requireCurrentModelVision: (...args) => host.requireCurrentModelVision(...args),
      resumeThread: (...args) => host.resumeThread(...args),
      get sandboxSetupDeferred() {
        return host.sandboxSetupDeferred;
      },
      set sandboxSetupDeferred(value) {
        host.sandboxSetupDeferred = value;
      },
      get sandboxStartupService() {
        return host.sandboxStartupService;
      },
      save: (...args) => host.save(...args),
      selectResumeThread: (...args) => host.selectResumeThread(...args),
      resumableThreads: (...args) => host.resumableThreads(...args),
      mentionPaths: () => host.workspaceMentionPaths(),
      showMcpServers: (...args) => host.showMcpServers(...args),
      startMemoryMaintenance: (...args) => host.startMemoryMaintenance(...args),
      get startupInteraction() {
        return host.startupInteraction;
      },
      get state() {
        return host.state;
      },
      get storage() {
        return host.storage;
      },
      get subagentCoordinator() {
        return host.subagentCoordinator;
      },
      get subagentHost() {
        return host.subagentHost;
      },
      submitUserMessage: (...args) => host.submitUserMessage(...args),
      syncTerminalView: (...args) => host.syncTerminalView(...args),
      get terminal() {
        return host.terminal;
      },
      terminalSessionInfo: (...args) => host.terminalSessionInfo(...args),
      get threadStore() {
        return host.threadStore;
      },
      get trustedOuterSandbox() {
        return host.trustedOuterSandbox;
      },
      get uninstallRequested() {
        return host.uninstallRequested;
      },
      updateWorkspaceCommand: (...args) => host.updateWorkspaceCommand(...args),
    };
  }

  private imageInputsInstance?: AppImageInputs;
  private get imageInputs(): AppImageInputs {
    return (this.imageInputsInstance ??= new AppImageInputs(this.imageInputsContext()));
  }
  private imageInputsContext(): AppImageInputsContext {
    const host = this;
    return {
      get clipboardImageReader() {
        return host.clipboardImageReader;
      },
      get imageStore() {
        return host.imageStore;
      },
      get pendingImages() {
        return host.pendingImages;
      },
      set pendingImages(value) {
        host.pendingImages = value;
      },
      get state() {
        return host.state;
      },
      get storage() {
        return host.storage;
      },
      get terminal() {
        return host.terminal;
      },
      get workspace() {
        return host.workspace;
      },
      get threadDocumentService() {
        return host.threadDocumentService;
      },
      get threadResourceStore() {
        return host.threadResourceStore;
      },
    };
  }
}

export type { EasyCodeAppOptions, ToolSourceFactory, ToolSourceFactoryContext } from "./app/types.js";
