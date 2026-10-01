/**
 * Runs and supervises child agents for the app: launching a child turn in its own environment,
 * recording progress and outcomes, merging artifacts back, handoff, and restore/pause across Thread switches.
 */

import { TaskBudget } from "../runtime/task-budget.js";
import type { AppInteractionPort } from "../ui/interaction-port.js";
import { SkillStore } from "../skills/store.js";
import { CommandRuntime } from "../command/runtime.js";
import { ContextArtifactIndex } from "../context/artifact-index.js";
import { ContextManager } from "../context/manager.js";
import type {
  AgentRunResult,
  ApprovalRequest,
  ChatMessage,
  CommandAuditEntry,
  CommandExecutionMode,
  EasyCodeConfig,
  FileChangeRecord,
  SessionState,
  ToolPresentation,
  ToolContext,
  ResultArtifact,
  ResultArtifactRef,
} from "../core/types.js";
import { MemoryManager, projectMemoryIdFromRoot } from "../memory/memory-manager.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { activePromptBundleBinding } from "../prompt-bundle/index.js";
import { buildSystemPrompt } from "../prompts/builder.js";
import { createProvider } from "../providers/factory.js";
import { TokenCalibration } from "../context/token-calibration.js";
import { AgentRuntime } from "../runtime/agent.js";
import { runtimeContextDependencies } from "./runtime-context.js";
import { workspaceIdFromRoot, type EasyCodeStorage } from "../storage/database.js";
import {
  SubagentCoordinator,
  type ObservedSubagentArtifacts,
  type SubagentExecutionOutcome,
  type SubagentExecutionRequest,
} from "../subagents/coordinator.js";
import { subagentDisplayLabel } from "../subagents/display-name.js";
import { SubagentMessageMailbox } from "../subagents/messages.js";
import { WorkspaceMutationLock } from "../subagents/workspace-mutation-lock.js";
import { BuiltinToolSource } from "../tools/builtin-source.js";
import { ToolCatalog } from "../tools/catalog.js";
import type { ToolExecutionAuthorizationRequest } from "../tools/execution-gateway.js";
import { ThreadStore, type ThreadLease } from "../threads/thread-store.js";
import { createId } from "../utils/ids.js";
import { foldPendingOperations } from "../context/pending-operations.js";
import { WorkspaceManager } from "../workspace/manager.js";
import {
  ExecutionEnvironmentManager,
  type ActiveExecutionEnvironment,
  type HandoffDestination,
} from "../workspace/execution-environment.js";
import type { ProjectWorkspace } from "../projects/types.js";
import { repairInterruptedTurn } from "./thread-recovery.js";
import { json, renderPromptBundleText, promptBundleText } from "./text.js";
import { samePath } from "../utils/paths.js";
import type { ToolSourceFactory } from "../app.js";

/** What SubagentHost needs from its host; live values are forwarded through getters. */
export interface SubagentHostContext {
  readonly authorizeCatalogToolCall: (request: Readonly<ToolExecutionAuthorizationRequest>) => Promise<boolean>;
  readonly commandExecutionMode: CommandExecutionMode;
  readonly commandRuntimes: Map<WorkspaceManager, CommandRuntime>;
  readonly config: EasyCodeConfig;
  readonly contextArtifactIndex: ContextArtifactIndex;
  readonly createCommandRuntime: (workspace: WorkspaceManager) => CommandRuntime;
  readonly currentProjectWorkspace: () => ProjectWorkspace | undefined;
  dirty: boolean;
  readonly effectiveConfig: () => EasyCodeConfig;
  readonly executionEnvironments: ExecutionEnvironmentManager;
  readonly hostAccessEpoch: number;
  readonly maxModelRequests: number | undefined;
  readonly memoryManager: MemoryManager;
  readonly observedToolCatalog: (workspace: WorkspaceManager, runtime: CommandRuntime) => ToolCatalog;
  readonly prepareProjectSandbox: (workspace: WorkspaceManager) => Promise<void>;
  readonly requestSubagentApproval: (
    request: ApprovalRequest,
    source: { agentId: string; taskId: string; label: string },
  ) => Promise<boolean>;
  readonly save: () => void;
  readonly sharedTaskBudget: (threadId: string) => TaskBudget;
  readonly state: SessionState;
  readonly storage: EasyCodeStorage;
  readonly subagentCoordinator: SubagentCoordinator;
  readonly subagentMessages: SubagentMessageMailbox;
  readonly syncWorkspaceState: () => void;
  readonly terminal: AppInteractionPort;
  readonly threadStore: ThreadStore;
  readonly toolSourceFactories: readonly ToolSourceFactory[];
  readonly trustedOuterSandbox: "harbor" | undefined;
  readonly workspace: WorkspaceManager;
  readonly workspaceMutationLock: WorkspaceMutationLock;
}

/** One child execution's state, shared by the stages of SubagentHost.runSubagent and read live by its callbacks. */
interface ChildRun {
  readonly request: SubagentExecutionRequest;
  activeEnvironment?: ActiveExecutionEnvironment;
  childWorkspace?: WorkspaceManager;
  childToolCatalog?: ToolCatalog;
  childState?: SessionState;
  childLease?: ThreadLease;
  readonly presentations: ToolPresentation[];
  dependencyArtifacts: ResultArtifactRef[];
  /** How many of the child's file changes and which commands have already been reported to the parent. */
  persistedChangeCount: number;
  readonly persistedCommandIds: Set<string>;
}

interface ChildCommandOwner {
  readonly threadId: string;
  readonly agentRole: "subagent";
  readonly agentId: string;
  readonly assignedTaskId: string;
}

/** The assignment block of the child's system prompt. */
function childAssignment(run: ChildRun): string {
  const { request } = run;
  return json({
    agentId: request.record.id,
    childThreadId: request.record.childThreadId,
    environmentId: request.record.environmentId,
    isolation: run.activeEnvironment!.descriptor.kind,
    mode: request.record.mode,
    assignmentKind: request.record.assignmentKind,
    ...(request.record.taskGraphId ? { taskGraphId: request.record.taskGraphId } : {}),
    task: {
      id: request.task.id,
      title: request.task.title,
      description: request.task.description,
      dependencies: request.task.dependencies,
      inputs: request.task.inputs,
      expectedArtifacts: request.task.expectedArtifacts,
      completionChecks: request.task.completionChecks,
      failureHandling: request.task.failureHandling,
    },
    parentInstructions: request.record.instructions,
  });
}

export class SubagentHost {
  constructor(private readonly ctx: SubagentHostContext) {}

  async runSubagent(request: SubagentExecutionRequest): Promise<SubagentExecutionOutcome> {
    const run: ChildRun = {
      request,
      presentations: [],
      dependencyArtifacts: [],
      persistedChangeCount: 0,
      persistedCommandIds: new Set(),
    };
    try {
      run.dependencyArtifacts = this.dependencyArtifacts(request);
      const existingChild = this.ctx.threadStore.get(request.record.childThreadId);
      await this.acquireChildEnvironment(run, existingChild);
      const childState = this.bindChildSession(run, existingChild);
      await this.markChildRunning(run);
      const { runtime, commandRuntime, commandOwner } = await this.createChildRuntime(run);
      const result = await (async () => {
        try {
          return await runtime.run(
            childState,
            existingChild ? promptBundleText("agents/child-resume.md") : promptBundleText("agents/child-start.md"),
            {
              maxModelRequests: this.ctx.maxModelRequests,
              maxContextChars: this.ctx.config.limits.maxContextChars,
              maxOutputChars: this.ctx.config.limits.maxOutputChars,
              maxContextTokens: this.ctx.config.limits.maxContextTokens || undefined,
              commandTimeoutMs: this.ctx.config.limits.commandTimeoutMs,
              approvalPolicy: this.ctx.config.approvalPolicy,
              commandExecutionMode: this.ctx.commandExecutionMode,
              isUnrestrictedHostAccessActive: () => this.ctx.commandExecutionMode === "unrestricted",
              unrestrictedHostAccessEpoch: () => this.ctx.hostAccessEpoch,
              signal: request.signal,
            },
          );
        } finally {
          // Never checkpoint or finalize an isolated checkout while a command
          // can still mutate it. Normally the child polls every handle to a
          // terminal state; this closes the lifecycle if it answers early or
          // the provider fails mid-turn.
          await commandRuntime.cancelAll(commandOwner);
        }
      })();
      return await this.finishChild(run, result);
    } catch (error) {
      return await this.failedChildOutcome(run, error);
    } finally {
      await this.releaseChild(run);
    }
  }

  /** Every DAG dependency must be complete, and either all or none of them carry a result artifact. */
  private dependencyArtifacts(request: SubagentExecutionRequest): ResultArtifactRef[] {
    const dependencyTasks = request.task.dependencies.map((taskId) => {
      const dependency = this.ctx.state.taskGraph?.tasks.find((task) => task.id === taskId);
      if (!dependency || dependency.status !== "completed") {
        throw new Error(`DAG dependency ${taskId} is not completed`);
      }
      return dependency;
    });
    const dependencyArtifacts = dependencyTasks.flatMap((dependency) =>
      dependency.resultArtifact ? [dependency.resultArtifact] : [],
    );
    if (dependencyArtifacts.length > 0 && dependencyArtifacts.length !== dependencyTasks.length) {
      throw new Error(
        "This DAG mixes isolated result artifacts with dependencies that have no Runtime artifact; integrate them before starting the child",
      );
    }
    for (const artifact of dependencyArtifacts) {
      if (!request.task.dependencies.includes(artifact.taskId)) {
        throw new Error(`Artifact ${artifact.id} is not bound to a declared dependency`);
      }
    }
    return dependencyArtifacts;
  }

  /**
   * Restore the child's durable execution environment, or provision one for a brand-new child.
   * An existing child session never silently gets a different checkout.
   */
  private async acquireChildEnvironment(run: ChildRun, existingChild: SessionState | undefined): Promise<void> {
    const { request } = run;
    const hasDurableChildBinding = this.ctx.threadStore.isBoundSubagentThread(request.record.childThreadId);
    try {
      const savedEnvironment = await this.ctx.executionEnvironments.loadEnvironment(request.record.environmentId);
      if (
        !samePath(savedEnvironment.logicalWorkspaceRoot, this.ctx.workspace.root) ||
        savedEnvironment.requestedIsolation !== request.record.requestedIsolation ||
        (savedEnvironment.agentId !== undefined && savedEnvironment.agentId !== request.record.id) ||
        (savedEnvironment.parentThreadId !== undefined &&
          savedEnvironment.parentThreadId !== request.record.parentThreadId) ||
        (savedEnvironment.childThreadId !== undefined &&
          savedEnvironment.childThreadId !== request.record.childThreadId) ||
        (savedEnvironment.taskId !== undefined && savedEnvironment.taskId !== request.task.id)
      ) {
        throw new Error(
          `Execution environment ${request.record.environmentId} does not match its durable child binding`,
        );
      }
      run.activeEnvironment = await this.ctx.executionEnvironments.restore(request.record.environmentId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (existingChild || hasDurableChildBinding) {
        throw new Error(
          `Execution environment ${request.record.environmentId} is missing for an existing durable child session; refusing to create a different checkout`,
        );
      }
      run.activeEnvironment = await this.ctx.executionEnvironments.provision({
        agentId: request.record.id,
        parentThreadId: request.record.parentThreadId,
        childThreadId: request.record.childThreadId,
        taskId: request.task.id,
        environmentId: request.record.environmentId,
        requestedIsolation: request.record.requestedIsolation,
        dependencyArtifacts: run.dependencyArtifacts,
      });
    }
    run.childWorkspace = run.activeEnvironment.workspace;
    if (run.activeEnvironment.descriptor.kind === "shared" && this.ctx.workspace.folders.length > 1) {
      run.childWorkspace = await WorkspaceManager.create(this.ctx.currentProjectWorkspace()!);
      run.activeEnvironment = { ...run.activeEnvironment, workspace: run.childWorkspace };
    }
    await this.ctx.prepareProjectSandbox(run.childWorkspace);
    request.reportEnvironment(run.activeEnvironment.descriptor);
  }

  /** Resume or create the child's thread under a lease, and record (or verify) its durable binding. */
  private bindChildSession(run: ChildRun, existingChild: SessionState | undefined): SessionState {
    const { request } = run;
    const childWorkspace = run.childWorkspace!;
    const activeEnvironment = run.activeEnvironment!;
    let childState: SessionState;
    if (existingChild) {
      if (!samePath(existingChild.workspaceRoot, childWorkspace.root)) {
        throw new Error(`Child thread ${request.record.childThreadId} is bound to a different execution root`);
      }
      run.childLease = this.ctx.threadStore.acquireThreadLease(existingChild.threadId);
      repairInterruptedTurn(this.ctx.threadStore, existingChild);
      childWorkspace.restorePersistedState(existingChild.filesRead, existingChild.changes);
      childState = existingChild;
      run.childState = childState;
    } else {
      childState = this.ctx.threadStore.create({
        threadId: request.record.childThreadId,
        workspaceRoot: childWorkspace.root,
        projectId: this.ctx.state.projectId,
        workspaceRevision: this.ctx.state.workspaceRevision,
        workspaceFolders: this.ctx.state.workspaceFolders?.map((folder) => ({ ...folder })),
        primaryWorkspaceFolderId: this.ctx.state.primaryWorkspaceFolderId,
        mode: request.record.mode,
        provider: request.record.provider,
        model: request.record.model,
        thinkingEffort: request.record.thinkingEffort,
        promptBundle: activePromptBundleBinding(),
        modelRegistryHash: this.ctx.state.modelRegistryHash,
        goal: request.task.title,
        constraints: [`Parent thread: ${request.record.parentThreadId}`, `Assigned task: ${request.task.id}`],
      });
      run.childState = childState;
      run.childLease = this.ctx.threadStore.acquireThreadLease(childState.threadId);
    }
    childState.mode = request.record.mode;
    childState.provider = request.record.provider;
    childState.model = request.record.model;
    childState.thinkingEffort = request.record.thinkingEffort;

    const bindingPayload = {
      agentId: request.record.id,
      parentThreadId: request.record.parentThreadId,
      childThreadId: request.record.childThreadId,
      taskId: request.task.id,
      mode: request.record.mode,
      environment: activeEnvironment.descriptor,
    };
    const childEvents = this.ctx.threadStore.journal(request.record.childThreadId).read();
    let existingBinding: (typeof childEvents)[number] | undefined;
    for (let index = childEvents.length - 1; index >= 0; index -= 1) {
      if (childEvents[index]?.type === "subagent.session_bound") {
        existingBinding = childEvents[index];
        break;
      }
    }
    if (existingBinding) {
      const payload = existingBinding.payload as Record<string, unknown>;
      const environment = payload.environment as Record<string, unknown> | undefined;
      if (
        payload.agentId !== request.record.id ||
        payload.parentThreadId !== request.record.parentThreadId ||
        payload.childThreadId !== request.record.childThreadId ||
        payload.taskId !== request.task.id ||
        payload.mode !== request.record.mode ||
        environment?.id !== request.record.environmentId
      ) {
        throw new Error(`Child thread ${request.record.childThreadId} has a conflicting durable binding`);
      }
    } else {
      this.ctx.threadStore.appendEvent(request.record.parentThreadId, {
        type: "subagent.environment_bound",
        turnId: request.record.createdByTurnId,
        phase: "completed",
        payload: bindingPayload,
      });
      this.ctx.threadStore.appendEvent(request.record.childThreadId, {
        type: "subagent.session_bound",
        phase: "completed",
        payload: bindingPayload,
      });
    }
    return childState;
  }

  private async markChildRunning(run: ChildRun): Promise<void> {
    const runningEnvironment = await this.ctx.executionEnvironments.markRunning(run.activeEnvironment!.descriptor.id);
    run.activeEnvironment = {
      descriptor: runningEnvironment,
      workspace: run.childWorkspace!,
    };
    run.request.reportEnvironment(runningEnvironment);
  }

  /** Record the child's new file changes and commands with its parent, then save the child thread. */
  private persistChildProgress(run: ChildRun): void {
    const { childState, childWorkspace, activeEnvironment } = run;
    if (!childState || !childWorkspace || !activeEnvironment) return;
    const allChanges = childWorkspace.getChangeSet();
    const changes = allChanges.slice(run.persistedChangeCount);
    const commands = childState.commands.filter((entry) => !run.persistedCommandIds.has(entry.id));
    if (changes.length || commands.length) {
      this.recordSubagentProgress(run.request, changes, commands, activeEnvironment.descriptor.kind === "shared");
      run.persistedChangeCount = allChanges.length;
      for (const entry of commands) run.persistedCommandIds.add(entry.id);
    }
    childState.filesRead = new Map(childWorkspace.getReadVersions().map((version) => [version.path, version]));
    childState.changes = childWorkspace.getChangeSet();
    this.ctx.threadStore.save(childState);
  }

  /** The child's own provider, tool catalog and AgentRuntime, bound to its task and execution environment. */
  private async createChildRuntime(
    run: ChildRun,
  ): Promise<{ runtime: AgentRuntime; commandRuntime: CommandRuntime; commandOwner: ChildCommandOwner }> {
    const { request } = run;
    const childWorkspace = run.childWorkspace!;
    const childConfig = this.ctx.effectiveConfig();
    const childPromptStartedAt = new Date();
    childConfig.workspaceRoot = childWorkspace.root;
    childConfig.mode = request.record.mode;
    childConfig.provider = request.record.provider;
    childConfig.thinkingEffort = request.record.thinkingEffort;
    childConfig.providers[request.record.provider]!.model = request.record.model;
    const provider = createProvider(childConfig, request.record.provider, request.record.model);
    const commandRuntime = this.ctx.createCommandRuntime(childWorkspace);
    const toolCatalog = await this.childToolCatalog(run, commandRuntime);
    const workspaceId = this.ctx.state.projectId ?? workspaceIdFromRoot(this.ctx.workspace.root);
    const projectMemoryId = this.ctx.state.projectId ?? projectMemoryIdFromRoot(this.ctx.workspace.root);
    const assignment = childAssignment(run);
    const commandOwner: ChildCommandOwner = {
      threadId: request.record.childThreadId,
      agentRole: "subagent",
      agentId: request.record.id,
      assignedTaskId: request.task.id,
    };
    const runtime = new AgentRuntime({
      takeSteering: async ({ threadId, turnId, boundary }) =>
        this.ctx.threadStore.drainTurnSteering(threadId, turnId, this.ctx.config.limits, boundary !== "after_model"),
      sealSteering: async ({ threadId, turnId }) =>
        this.ctx.threadStore.sealTurnSteering(threadId, turnId, this.ctx.config.limits),
      onModelRequestStart: () => request.reportActivity("thinking"),
      onModelRequestEnd: () => request.reportActivity("working"),
      onToolExecutionStart: (toolName) => request.reportActivity("tool", toolName),
      onToolExecutionEnd: () => request.reportActivity("working"),
      provider,
      limits: this.ctx.config.limits,
      taskBudget: this.ctx.sharedTaskBudget(request.record.parentThreadId),
      tokenCalibration: new TokenCalibration(
        JSON.stringify([provider.name, provider.model, childConfig.providers[provider.name]!.baseUrl]),
        this.ctx.storage,
      ),
      toolCatalog,
      visionAvailable: false,
      authorizeToolExecution: (request) => this.ctx.authorizeCatalogToolCall(request),
      agentIdentity: {
        role: "subagent",
        agentId: request.record.id,
        assignedTaskId: request.task.id,
      },
      contextManager: new ContextManager(),
      hasOpenCommandHandles: () => commandRuntime.hasOpenCommandHandles(commandOwner),
      getEnvironmentFault: () => commandRuntime.environmentFault(),
      buildSystemPrompt: async ({
        mode,
        workspaceSummary,
        memories,
        workingCheckpoint,
        retrievedThreadEvidence,
        toolNames,
      }) => {
        const base = await buildSystemPrompt({
          config: childConfig,
          workspaceFolders: childWorkspace.folders,
          skillStore: SkillStore.forProject(
            childWorkspace.root,
            this.ctx.config.dataDir,
            this.ctx.state.projectId ?? workspaceIdFromRoot(this.ctx.workspace.root),
          ),
          now: childPromptStartedAt,
          mode,
          workspaceSummary,
          memories,
          ...(workingCheckpoint ? { workingCheckpoint } : {}),
          ...(retrievedThreadEvidence ? { retrievedThreadEvidence } : {}),
          availableTools: toolNames,
          commandExecutionMode: this.ctx.commandExecutionMode,
        });
        return `${base}\n\n${this.childContract(run, assignment)}`;
      },
      getWorkspaceSummary: async () => json(childWorkspace.getManifestSummary()),
      ...runtimeContextDependencies(
        {
          memoryManager: this.ctx.memoryManager,
          contextArtifactIndex: this.ctx.contextArtifactIndex,
          limits: this.ctx.config.limits,
        },
        {
          workspaceId,
          projectMemoryId,
          workspaceRoot: childWorkspace.root,
          queryPrefix: `${request.task.title}\n${request.task.description}\n`,
          readOnlyMemory: true,
          evidenceOwner: (state) => state.threadId,
        },
      ),
      checkpointContext: async (state) => {
        if (run.childState) {
          await childWorkspace.fullConsistencyCheck();
          run.childState.filesRead = new Map(
            childWorkspace.getReadVersions().map((version) => [version.path, version]),
          );
          run.childState.changes = childWorkspace.getChangeSet();
        }
        await this.ctx.contextArtifactIndex.checkpoint(workspaceId, state);
      },
      appendEvent: async (event) => {
        const { threadId, ...input } = event;
        if (threadId !== request.record.childThreadId) {
          throw new Error("Child Runtime attempted to append to a different thread");
        }
        this.ctx.threadStore.appendEvent(threadId, input);
      },
      recordCommand: (turnId, entry) => {
        this.ctx.threadStore.recordToolAudit(request.record.childThreadId, turnId, entry);
      },
      onModelUsage: async (record) => {
        this.ctx.threadStore.appendEvent(request.record.childThreadId, {
          type: "model.usage",
          phase: "completed",
          payload: record,
        });
        // Keep the historical parent aggregate while the child owns its full event.
        this.ctx.threadStore.appendEvent(request.record.parentThreadId, {
          type: "model.usage",
          phase: "completed",
          payload: record,
        });
        if (this.ctx.state.threadId === request.record.parentThreadId) this.ctx.dirty = true;
      },
      requestApproval: (approval) =>
        this.ctx.requestSubagentApproval(approval, {
          agentId: request.record.id,
          taskId: request.task.id,
          label: subagentDisplayLabel(request.record),
        }),
      takeAdditionalInstructions: request.drainFollowUps,
      onToolCompleted: async (_state, _toolName, result) => {
        if (result.presentation) run.presentations.push(result.presentation);
        this.persistChildProgress(run);
        if (run.activeEnvironment?.descriptor.kind === "worktree" && !commandRuntime.hasRunningCommands()) {
          const checkpoint = await this.ctx.executionEnvironments.checkpoint(run.activeEnvironment);
          run.activeEnvironment = {
            descriptor: checkpoint,
            workspace: childWorkspace,
          };
          request.reportEnvironment(checkpoint);
        }
      },
    });
    return { runtime, commandRuntime, commandOwner };
  }

  /** Built-in tools bound to the child's task and parent mailbox, plus any configured external sources. */
  private async childToolCatalog(
    run: ChildRun,
    commandRuntime: CommandRuntime,
  ): Promise<Awaited<ReturnType<ToolCatalog["snapshot"]>>> {
    const { request } = run;
    const childWorkspace = run.childWorkspace!;
    const mutationLock =
      run.activeEnvironment!.descriptor.kind === "shared"
        ? this.ctx.workspaceMutationLock
        : new WorkspaceMutationLock();
    const catalog = this.ctx.observedToolCatalog(childWorkspace, commandRuntime);
    run.childToolCatalog = catalog;
    catalog.registerSource(
      new BuiltinToolSource({
        profile: this.ctx.trustedOuterSandbox ? "benchmark" : undefined,
        coordination: this.ctx.threadStore.coordination,
        workspace: childWorkspace,
        skillStore: SkillStore.forProject(
          childWorkspace.root,
          this.ctx.config.dataDir,
          this.ctx.state.projectId ?? workspaceIdFromRoot(this.ctx.workspace.root),
        ),
        commandRuntime,
        limits: this.ctx.config.limits,
        mutationLock,
        boundTask: request.task,
        parentMessage: {
          binding: {
            agentId: request.record.id,
            childThreadId: request.record.childThreadId,
            parentThreadId: request.record.parentThreadId,
            taskId: request.task.id,
            taskTitle: request.task.title,
          },
          post: (message, childThreadId, toolCallId) => {
            if (request.signal.aborted) throw new Error("The child is no longer running");
            const posted = this.ctx.subagentMessages.post(
              request.record.parentThreadId,
              message,
              childThreadId,
              toolCallId,
            );
            this.ctx.subagentCoordinator.notifyMessage(request.record.parentThreadId);
            return posted;
          },
        },
      }),
    );
    for (const factory of this.ctx.trustedOuterSandbox ? [] : (this.ctx.toolSourceFactories ?? [])) {
      catalog.registerSource(
        await factory({
          workspaceRoot: childWorkspace.root,
          threadId: request.record.childThreadId,
          role: "subagent",
          agentId: request.record.id,
          assignedTaskId: request.task.id,
        }),
      );
    }
    return catalog.snapshot();
  }

  /** The child's system-prompt contract: its environment, approval behavior and assignment. */
  private childContract(run: ChildRun, assignment: string): string {
    const environmentKind = run.activeEnvironment?.descriptor.kind ?? "unknown";
    const executionEnvironment =
      this.ctx.commandExecutionMode === "unrestricted"
        ? renderPromptBundleText("agents/child-environment-unrestricted.md", {
            environmentKind,
          })
        : renderPromptBundleText("agents/child-environment-sandboxed.md", {
            environmentKind,
          });
    const approvalBehavior = promptBundleText(
      this.ctx.commandExecutionMode === "unrestricted"
        ? "agents/child-approval-unrestricted.md"
        : "agents/child-approval-sandboxed.md",
    );
    return renderPromptBundleText("agents/child-contract.md", {
      executionEnvironment,
      approvalBehavior,
      assignment,
    });
  }

  /** Checkpoint a paused child, or finalize its result artifact and record the terminal outcome. */
  private async finishChild(run: ChildRun, result: AgentRunResult): Promise<SubagentExecutionOutcome> {
    const { request, presentations } = run;
    const childWorkspace = run.childWorkspace!;
    const childState = run.childState!;
    this.persistChildProgress(run);
    const activeEnvironment = run.activeEnvironment!;
    if (request.isPauseRequested()) {
      const pausedEnvironment = await this.ctx.executionEnvironments.checkpoint(activeEnvironment, "ready");
      request.reportEnvironment(pausedEnvironment);
      return {
        reason: "interrupted",
        error: "Child execution was paused for a resumable parent shutdown.",
        changes: childWorkspace.getChangeSet(),
        commands: [...childState.commands],
        presentations,
        environment: pausedEnvironment,
      };
    }
    // Cancellation observed before finalization wins. Once finalization has
    // started, a verified terminal report wins over a concurrent shutdown so
    // the durable artifact and terminal reason cannot disagree.
    const stoppedBeforeFinalize = request.signal.aborted;
    const acceptedReport = stoppedBeforeFinalize ? undefined : result.subagentTaskReport;
    const resultArtifact = await this.ctx.executionEnvironments.finalize(activeEnvironment, {
      agentId: request.record.id,
      taskId: request.task.id,
      accepted: acceptedReport?.outcome === "completed",
      parentArtifactIds: run.dependencyArtifacts.map((artifact) => artifact.id),
    });
    const finalEnvironment = await this.ctx.executionEnvironments.loadEnvironment(activeEnvironment.descriptor.id);
    request.reportEnvironment(finalEnvironment);
    const outcome: SubagentExecutionOutcome = {
      ...(acceptedReport ? { report: acceptedReport } : {}),
      reason: stoppedBeforeFinalize
        ? "stopped"
        : acceptedReport?.outcome === "completed"
          ? "completed"
          : acceptedReport?.outcome === "blocked"
            ? "blocked"
            : result.reason === "paused"
              ? "needs_parent_decision"
              : "failed",
      ...(!acceptedReport ? { error: redactSensitiveInformation(result.text).slice(0, 2_000) } : {}),
      changes: childWorkspace.getChangeSet(),
      commands: [...childState.commands],
      presentations,
      environment: finalEnvironment,
      resultArtifact,
    };
    this.recordSubagentOutcome(request, outcome);
    return outcome;
  }

  /** A failed or interrupted child still checkpoints (on pause) or retains (on failure) its checkout. */
  private async failedChildOutcome(run: ChildRun, error: unknown): Promise<SubagentExecutionOutcome> {
    const { request, presentations, activeEnvironment } = run;
    try {
      this.persistChildProgress(run);
    } catch {
      // The child journal already contains every previously completed step.
    }
    if (request.isPauseRequested()) {
      let pausedEnvironment = run.activeEnvironment?.descriptor;
      if (run.activeEnvironment) {
        try {
          pausedEnvironment = await this.ctx.executionEnvironments.checkpoint(run.activeEnvironment, "ready");
          request.reportEnvironment(pausedEnvironment);
        } catch {
          // Keep the registered checkout. Resume will validate it before use.
        }
      }
      return {
        reason: "interrupted",
        error: "Child execution was paused for a resumable parent shutdown.",
        changes: run.childWorkspace?.getChangeSet() ?? [],
        commands: [...(run.childState?.commands ?? [])],
        presentations,
        ...(pausedEnvironment ? { environment: pausedEnvironment } : {}),
      };
    }
    let retainedArtifact: ResultArtifact | undefined;
    let finalEnvironment = activeEnvironment?.descriptor;
    if (activeEnvironment) {
      try {
        retainedArtifact = await this.ctx.executionEnvironments.finalize(activeEnvironment, {
          agentId: request.record.id,
          taskId: request.task.id,
          accepted: false,
          parentArtifactIds: run.dependencyArtifacts.map((artifact) => artifact.id),
        });
        finalEnvironment = await this.ctx.executionEnvironments.loadEnvironment(activeEnvironment.descriptor.id);
        request.reportEnvironment(finalEnvironment);
      } catch {
        // Preserve the original execution failure. Provisioning metadata is
        // already durable and may still be inspected or recovered.
      }
    }
    const outcome: SubagentExecutionOutcome = {
      reason: request.signal.aborted ? "stopped" : "failed",
      error: redactSensitiveInformation(error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      changes: run.childWorkspace?.getChangeSet() ?? [],
      commands: [...(run.childState?.commands ?? [])],
      presentations,
      ...(finalEnvironment ? { environment: finalEnvironment } : {}),
      ...(retainedArtifact ? { resultArtifact: retainedArtifact } : {}),
    };
    try {
      this.recordSubagentOutcome(request, outcome);
    } catch {
      // The coordinator still exposes the in-memory terminal state.
    }
    return outcome;
  }

  /** Close the child's tool sources, drop an idle command runtime, and release the thread lease. */
  private async releaseChild(run: ChildRun): Promise<void> {
    if (run.childToolCatalog) {
      try {
        await run.childToolCatalog.close();
      } catch {
        // The source is process-local today. Future external sources must not
        // prevent durable child cleanup if their shutdown fails.
      }
    }
    if (run.childWorkspace && run.childWorkspace !== this.ctx.workspace) {
      // A recovery shell can exist before process-local command state has
      // been hydrated; durable child cleanup must remain safe in that case.
      const childCommandRuntime = this.ctx.commandRuntimes?.get(run.childWorkspace);
      if (childCommandRuntime && !childCommandRuntime.hasRunningCommands()) {
        this.ctx.commandRuntimes.delete(run.childWorkspace);
      }
    }
    if (run.childLease) {
      try {
        this.ctx.threadStore.releaseThreadLease(run.childLease);
      } catch {
        // The child journal remains authoritative and stale leases are
        // reclaimed through the existing dead-process recovery path.
      }
    }
  }

  private recordSubagentProgress(
    request: SubagentExecutionRequest,
    changes: readonly FileChangeRecord[],
    commands: readonly CommandAuditEntry[],
    mergeIntoParent: boolean,
  ): void {
    const attributedCommands = commands.map((entry) =>
      attributeSubagentCommandAudit(entry, {
        agentId: request.record.id,
        taskId: request.task.id,
      }),
    );
    this.ctx.threadStore.recordSubagentArtifacts(request.record.parentThreadId, request.record.createdByTurnId, {
      agentId: request.record.id,
      taskId: request.task.id,
      changes,
      commands: attributedCommands,
      mergeIntoParent,
    });
    if (this.ctx.state.threadId !== request.record.parentThreadId) return;
    if (!mergeIntoParent) {
      this.ctx.dirty = true;
      return;
    }

    const knownStateChanges = new Set(
      this.ctx.state.changes.map((change) =>
        [change.timestamp, change.path, change.operation, change.beforeHash ?? "", change.afterHash ?? ""].join("|"),
      ),
    );
    const knownWorkspaceChanges = new Set(
      this.ctx.workspace
        .getChangeSet()
        .map((change) =>
          [change.timestamp, change.path, change.operation, change.beforeHash ?? "", change.afterHash ?? ""].join("|"),
        ),
    );
    for (const change of changes) {
      const key = [
        change.timestamp,
        change.path,
        change.operation,
        change.beforeHash ?? "",
        change.afterHash ?? "",
      ].join("|");
      if (!knownStateChanges.has(key)) {
        this.ctx.state.changes.push({ ...change });
        knownStateChanges.add(key);
      }
      if (!knownWorkspaceChanges.has(key)) {
        this.ctx.workspace.recordChange(change);
        this.ctx.workspace.invalidateReadVersion(change.path);
        knownWorkspaceChanges.add(key);
      }
    }
    const knownCommands = new Set(this.ctx.state.commands.map((entry) => entry.id));
    for (const entry of attributedCommands) {
      if (knownCommands.has(entry.id)) continue;
      this.ctx.state.commands.push(entry);
      knownCommands.add(entry.id);
    }
    this.ctx.dirty = true;
  }

  private recordSubagentOutcome(request: SubagentExecutionRequest, outcome: SubagentExecutionOutcome): void {
    this.ctx.threadStore.recordSubagentResult(request.record.parentThreadId, request.record.createdByTurnId, {
      agentId: request.record.id,
      taskId: request.task.id,
      reason: outcome.reason,
      ...(outcome.report ? { report: outcome.report } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.environment ? { environment: outcome.environment } : {}),
      ...(outcome.resultArtifact ? { resultArtifact: outcome.resultArtifact } : {}),
    });
    if (this.ctx.state.threadId === request.record.parentThreadId) this.ctx.dirty = true;
  }

  /**
   * Collect terminal children at a Runtime boundary. This is intentionally not
   * represented as a model-authored tool call: the child already completed,
   * and collecting its durable result is control-plane bookkeeping.
   */
  async collectReadySubagentResults(state: SessionState, turnId: string, signal?: AbortSignal): Promise<number> {
    return this.ctx.workspaceMutationLock.runExclusive(async () => {
      let collected = 0;
      const terminal = new Set(["completed", "blocked", "needs_parent_decision", "failed", "stopped", "interrupted"]);
      for (;;) {
        const candidate = this.ctx.subagentCoordinator
          .outstanding(state.threadId)
          .find((record) => terminal.has(record.status));
        if (!candidate) break;
        const context: ToolContext = {
          workspaceRoot: state.workspaceRoot,
          mode: "code",
          threadId: state.threadId,
          turnId,
          approvalPolicy: this.ctx.config.approvalPolicy,
          commandExecutionMode: this.ctx.commandExecutionMode,
          requestApproval: async () => false,
          signal,
          commandTimeoutMs: this.ctx.config.limits.commandTimeoutMs,
          maxOutputChars: this.ctx.config.limits.maxOutputChars,
          agentRole: "main_agent",
          thinkingEffort: state.thinkingEffort,
          limits: this.ctx.config.limits,
          taskGraph: state.taskGraph,
        };
        const result = await this.ctx.subagentCoordinator.observe({ agentIds: [candidate.id], timeoutMs: 0 }, context);
        if (!result.ok || !result.subagentLifecycle || !result.subagentAssignment) break;
        const data =
          result.data && typeof result.data === "object"
            ? (result.data as { result?: { summary?: string }; error?: string })
            : undefined;
        const message: ChatMessage = {
          role: "user",
          content:
            "RUNTIME_SUBAGENT_RESULT_COLLECTED (authoritative child lifecycle, not a new user requirement)\n" +
            JSON.stringify({
              agentId: candidate.id,
              taskId: candidate.taskId,
              status: candidate.status,
              summary: data?.result?.summary,
              error: data?.error,
            }),
        };
        const payload = {
          tool: "observe_subagents",
          subagentLifecycle: result.subagentLifecycle,
          subagentAssignment: result.subagentAssignment,
          ...(result.taskGraphUpdate ? { taskGraph: result.taskGraphUpdate } : {}),
          ...(result.subagentTaskOperation ? { subagentTaskOperation: result.subagentTaskOperation } : {}),
          message,
        };
        this.ctx.threadStore.appendEvent(state.threadId, {
          type: "subagent.collected",
          turnId,
          phase: "completed",
          payload,
        });
        foldPendingOperations(state, payload);
        if (result.taskGraphUpdate) state.taskGraph = result.taskGraphUpdate;
        state.messages.push(message);
        const artifacts = this.ctx.subagentCoordinator.commitLifecycle(result.subagentLifecycle);
        if (artifacts) {
          await this.mergeSubagentArtifacts(state, artifacts);
          this.ctx.subagentCoordinator.finalizeArtifactMerge(artifacts.agentId);
        }
        collected += 1;
        this.ctx.dirty = true;
      }
      if (collected > 0) {
        this.ctx.syncWorkspaceState();
        this.ctx.save();
      }
      return collected;
    }, signal);
  }

  async mergeSubagentArtifacts(state: SessionState, artifacts: ObservedSubagentArtifacts): Promise<void> {
    const isolated = artifacts.environment?.kind === "worktree";
    if (!isolated) {
      const knownChanges = new Set(
        this.ctx.workspace
          .getChangeSet()
          .map((change) => [change.timestamp, change.path, change.operation, change.afterHash ?? ""].join("|")),
      );
      for (const change of artifacts.changes) {
        const key = [change.timestamp, change.path, change.operation, change.afterHash ?? ""].join("|");
        if (knownChanges.has(key)) continue;
        this.ctx.workspace.recordChange(change);
        this.ctx.workspace.invalidateReadVersion(change.path);
        knownChanges.add(key);
      }
      await this.ctx.workspace.refreshManifest();
    }

    const knownCommands = new Set(state.commands.map((entry) => entry.id));
    for (const entry of artifacts.commands) {
      if (knownCommands.has(entry.id)) continue;
      const attributedEntry = attributeSubagentCommandAudit(entry, {
        agentId: artifacts.agentId,
        taskId: artifacts.taskId,
      });
      state.commands.push(attributedEntry);
      this.ctx.threadStore.recordToolAudit(state.threadId, state.activeTurnId, attributedEntry);
      knownCommands.add(entry.id);
    }
    for (const presentation of artifacts.presentations) {
      if (presentation.type !== "file_diff") continue;
      try {
        this.ctx.terminal.fileDiff(presentation);
      } catch {
        this.ctx.terminal.info(
          `Subagent ${this.ctx.subagentCoordinator.displayLabel(artifacts.agentId)} changed ${presentation.path}, but its diff preview could not be rendered.`,
        );
      }
    }
    this.ctx.dirty = true;
    this.ctx.terminal.info(
      `Collected subagent ${this.ctx.subagentCoordinator.displayLabel(artifacts.agentId)} for task ${artifacts.taskId}: ` +
        `${artifacts.changes.length} change(s), ${artifacts.commands.length} command(s)` +
        (isolated && artifacts.resultArtifact
          ? `; result ${artifacts.resultArtifact.id} is ready for DAG lineage or handoff.`
          : "."),
    );
  }

  async handoffSubagentResult(
    artifact: Readonly<ResultArtifact>,
    destination: HandoffDestination,
  ): Promise<ResultArtifact> {
    const handoffId = createId("handoff");
    this.ctx.threadStore.appendEvent(this.ctx.state.threadId, {
      type: "subagent.handoff_requested",
      turnId: this.ctx.state.activeTurnId,
      phase: "started",
      payload: {
        handoffId,
        agentId: artifact.agentId,
        taskId: artifact.taskId,
        artifactId: artifact.id,
        destination,
      },
    });
    try {
      const before = destination.type === "local" ? await this.ctx.workspace.captureSnapshot() : undefined;
      const delivered = await this.ctx.executionEnvironments.handoff(artifact, destination);
      if (destination.type === "local" && before) {
        const after = await this.ctx.workspace.captureSnapshot();
        this.ctx.workspace.applyRuntimeSnapshots(before, after);
        this.ctx.syncWorkspaceState();
      }
      let cleanedEnvironment: string | undefined;
      if (delivered.status === "delivered") {
        try {
          const cleaned = await this.ctx.executionEnvironments.cleanup(delivered.environmentId);
          if (cleaned.status === "removed") cleanedEnvironment = cleaned.id;
        } catch {
          // Delivery is already durable; a busy Worktree remains recoverable
          // and may be cleaned by a later maintenance pass.
        }
      }
      this.ctx.threadStore.appendEvent(this.ctx.state.threadId, {
        type: "subagent.handoff_completed",
        turnId: this.ctx.state.activeTurnId,
        phase: "completed",
        payload: {
          handoffId,
          agentId: delivered.agentId,
          taskId: delivered.taskId,
          artifactId: delivered.id,
          artifact: delivered,
          ...(cleanedEnvironment ? { cleanedEnvironment } : {}),
        },
      });
      this.ctx.dirty = true;
      return delivered;
    } catch (error) {
      this.ctx.threadStore.appendEvent(this.ctx.state.threadId, {
        type: "subagent.handoff_failed",
        turnId: this.ctx.state.activeTurnId,
        phase: "failed",
        payload: {
          handoffId,
          agentId: artifact.agentId,
          taskId: artifact.taskId,
          artifactId: artifact.id,
          error: redactSensitiveInformation(error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        },
      });
      this.ctx.dirty = true;
      throw error;
    }
  }

  restoreSubagents(): number {
    const assignments = this.ctx.threadStore.subagentAssignments(this.ctx.state.threadId);
    const preparedAgentIds: string[] = [];
    let restored = 0;
    try {
      for (const entry of assignments) {
        const { assignment } = entry;
        if (this.ctx.subagentCoordinator.hasAgent(assignment.agentId, this.ctx.state.threadId)) {
          continue;
        }
        const task =
          assignment.kind === "dag"
            ? this.ctx.state.taskGraph?.tasks.find(
                (candidate) =>
                  candidate.id === assignment.taskId &&
                  candidate.owner === "subagent" &&
                  candidate.assignedAgentId === assignment.agentId &&
                  candidate.status === "in_progress",
              )
            : undefined;
        if (assignment.kind === "dag" && !task && !entry.observed) {
          // Do not resurrect a child against a different current graph.
          continue;
        }
        let durable = this.ctx.threadStore.latestSubagentResult(
          this.ctx.state.threadId,
          assignment.agentId,
          assignment.taskId,
        );
        const stopped = this.ctx.threadStore.hasCommittedSubagentStop(this.ctx.state.threadId, assignment.agentId);
        if (stopped && durable?.reason !== "stopped") {
          const event = this.ctx.threadStore.recordSubagentResult(this.ctx.state.threadId, entry.createdByTurnId, {
            agentId: assignment.agentId,
            taskId: assignment.taskId,
            reason: "stopped",
            error: "The parent had durably requested cancellation before recovery.",
          });
          durable = {
            agentId: assignment.agentId,
            taskId: assignment.taskId,
            reason: "stopped",
            error: "The parent had durably requested cancellation before recovery.",
            timestamp: event.timestamp,
          };
        }
        if (!durable) {
          if (entry.observed) continue;
          this.ctx.subagentCoordinator.restore(
            {
              parentThreadId: this.ctx.state.threadId,
              createdByTurnId: entry.createdByTurnId,
              assignment,
              ...(task ? { task } : {}),
            },
            { deferActivation: true },
          );
          preparedAgentIds.push(assignment.agentId);
          restored += 1;
          continue;
        }
        const recoveredArtifact = durable.resultArtifact
          ? (this.ctx.threadStore.latestSubagentHandoffArtifact(this.ctx.state.threadId, durable.resultArtifact.id) ??
            durable.resultArtifact)
          : undefined;
        const recovered = {
          parentThreadId: this.ctx.state.threadId,
          createdByTurnId: entry.createdByTurnId,
          assignment,
          ...(task ? { task } : {}),
          reason: durable.reason,
          ...(durable.report ? { report: durable.report } : {}),
          ...(durable.error ? { error: durable.error } : {}),
          ...(durable.environment ? { environment: durable.environment } : {}),
          ...(recoveredArtifact ? { resultArtifact: recoveredArtifact } : {}),
          finishedAt: durable.timestamp,
          observed: entry.observed,
        };
        if (assignment.childThreadId && assignment.environmentId) {
          this.ctx.subagentCoordinator.restore(recovered, { deferActivation: true });
          preparedAgentIds.push(assignment.agentId);
          restored += 1;
        } else if (assignment.kind === "standalone") {
          this.ctx.subagentCoordinator.restoreStandalone({ ...recovered, assignment }, { deferActivation: true });
          preparedAgentIds.push(assignment.agentId);
          restored += 1;
        }
      }
    } catch (error) {
      try {
        this.ctx.subagentCoordinator.rollbackRestored(preparedAgentIds);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Child-session recovery failed and its prepared batch could not be rolled back",
        );
      }
      throw error;
    }
    if (this.ctx.commandExecutionMode !== "manual") this.ctx.subagentCoordinator.activateRestored(preparedAgentIds);
    return restored;
  }

  assertNoRunningSubagents(action: string): void {
    if (this.ctx.subagentCoordinator.hasOutstanding(this.ctx.state.threadId)) {
      throw new Error(
        `Cannot ${action} while a child assignment is still outstanding. Continue the task so the main agent can wait for or stop and collect it first.`,
      );
    }
  }

  async pauseSubagentsForResume(): Promise<void> {
    const threadId = this.ctx.state.threadId;
    await this.ctx.subagentCoordinator.pause(threadId);
    this.ctx.save();
  }

  /** Re-arm only workers paused by a failed thread transition. */
  restorePausedCurrentThread(threadId: string): void {
    if (this.ctx.state.threadId !== threadId) {
      throw new Error("Cannot restore paused children after the parent thread changed");
    }
    this.ctx.subagentCoordinator.discardPausedJobs(threadId);
    this.restoreSubagents();
  }

  async drainPendingSubagentArtifacts(threadId: string): Promise<void> {
    for (const artifacts of this.ctx.subagentCoordinator.pendingArtifactMerges(threadId)) {
      await this.mergeSubagentArtifacts(this.ctx.state, artifacts);
      this.ctx.syncWorkspaceState();
      this.ctx.save();
      this.ctx.subagentCoordinator.finalizeArtifactMerge(artifacts.agentId);
    }
  }
}

/** Add durable parent-thread attribution without mutating a child's private audit record. */
export function attributeSubagentCommandAudit(
  entry: Readonly<CommandAuditEntry>,
  source: { agentId: string; taskId: string },
): CommandAuditEntry {
  return {
    ...entry,
    args: [...entry.args],
    sourceAgentRole: "subagent",
    sourceAgentId: source.agentId,
    sourceTaskId: source.taskId,
  };
}
