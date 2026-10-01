/** Wires an AgentRuntime for the main agent: provider, tool catalog, budgets, persistence, presentation and approval hooks. */

import path from "node:path";
import { TaskBudget } from "../runtime/task-budget.js";
import { runWorkspaceReview } from "../review/application.js";
import { sharedReviewEvidenceOwner } from "../context/recall.js";
import type { AppInteractionPort } from "../ui/interaction-port.js";
import { compactionRunning } from "../ui/compaction.js";
import { USER_MCP_CONFIG_PATH } from "../mcp/config.js";
import { McpConnections } from "../mcp/source.js";
import { SkillStore } from "../skills/store.js";
import { isCommandApprovalPrefixGranted } from "../command/approval.js";
import { ApprovalQueue, type ApprovalReview } from "../command/approval-agent.js";
import { canGrantCommandPrefix } from "../command/approval.js";
import { CommandRuntime } from "../command/runtime.js";
import { ContextArtifactIndex } from "../context/artifact-index.js";
import { ContextManager } from "../context/manager.js";
import type {
  ApprovalRequest,
  CommandExecutionMode,
  EasyCodeConfig,
  ImageAttachment,
  ModelProvider,
  ProviderStreamEvent,
  SessionState,
  TurnSteeringBatch,
} from "../core/types.js";
import { ImageStore } from "../images/index.js";
import { MemoryManager, projectMemoryIdFromRoot } from "../memory/memory-manager.js";
import { ThreadTitleStore } from "../threads/thread-title.js";
import { modelSupportsVision, USER_MODEL_REGISTRY_PATH } from "../models/catalog.js";
import { buildSystemPrompt } from "../prompts/builder.js";
import { createProvider } from "../providers/factory.js";
import { TokenCalibration } from "../context/token-calibration.js";
import { AgentRuntime, type AgentRuntimeDependencies, type ProviderContextSnapshot } from "../runtime/agent.js";
import { LocalLayaClient } from "../local-decision/client.js";
import { appendLocalDecisionFallbackTrace, appendLocalDecisionTrace } from "../local-decision/trace.js";
import { TurnSteeringAttemptNotifier } from "../runtime/turn-steering-notifier.js";
import { workspaceIdFromRoot, type EasyCodeStorage } from "../storage/database.js";
import { SubagentCoordinator, type ObservedSubagentArtifacts } from "../subagents/coordinator.js";
import { SubagentMessageMailbox } from "../subagents/messages.js";
import { WorkspaceMutationLock } from "../subagents/workspace-mutation-lock.js";
import { type ToolCatalogSnapshot } from "../tools/catalog.js";
import type { ToolExecutionAuthorizationRequest } from "../tools/execution-gateway.js";
import { ThreadStore } from "../threads/thread-store.js";
import { taskGraphView } from "../tasks/task-graph.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { json } from "./text.js";
import { InfoCommands } from "./info-commands.js";
import { SubagentHost } from "./subagent-host.js";
import { runtimeContextDependencies } from "./runtime-context.js";

/** What RuntimeAssembly needs from its host; live values are forwarded through getters. */
export interface RuntimeAssemblyContext {
  readonly approvalQueue: ApprovalQueue;
  readonly authorizeCatalogToolCall: (request: Readonly<ToolExecutionAuthorizationRequest>) => Promise<boolean>;
  autoCompacting: boolean;
  readonly commandExecutionMode: CommandExecutionMode;
  readonly compacting: boolean;
  readonly config: EasyCodeConfig;
  readonly contextArtifactIndex: ContextArtifactIndex;
  readonly contextManager: ContextManager;
  readonly createCommandRuntime: (workspace: WorkspaceManager) => CommandRuntime;
  dirty: boolean;
  readonly effectiveConfig: () => EasyCodeConfig;
  readonly hasRunningCommands: () => boolean;
  readonly imageStore: ImageStore;
  readonly infoCommands: InfoCommands;
  lastProviderContext: ProviderContextSnapshot | undefined;
  localLayaClient: LocalLayaClient | undefined;
  readonly mainToolCatalogSnapshot: () => Promise<Readonly<ToolCatalogSnapshot>>;
  readonly mcpConnections: McpConnections | undefined;
  readonly memoryManager: MemoryManager;
  readonly newTaskBudget: (threadId: string) => TaskBudget;
  readonly requestToolApproval: (request: ApprovalRequest) => Promise<boolean>;
  readonly reviewApproval: (request: ApprovalRequest) => Promise<ApprovalReview>;
  readonly save: () => void;
  readonly sharedTaskBudget: (threadId: string) => TaskBudget;
  readonly state: SessionState;
  readonly storage: EasyCodeStorage;
  readonly subagentCoordinator: SubagentCoordinator;
  readonly subagentHost: SubagentHost;
  readonly subagentMessages: SubagentMessageMailbox;
  readonly syncTerminalView: (announceHeader?: boolean) => void;
  readonly syncWorkspaceState: () => void;
  readonly taskBudgets: Map<string, TaskBudget>;
  readonly terminal: AppInteractionPort;
  readonly threadStore: ThreadStore;
  readonly threadTitles: ThreadTitleStore;
  readonly trustedOuterSandbox: "harbor" | undefined;
  readonly workspace: WorkspaceManager;
  readonly workspaceMutationLock: WorkspaceMutationLock;
}

export class RuntimeAssembly {
  constructor(private readonly ctx: RuntimeAssemblyContext) {}

  async createRuntime(
    presentReasoning: boolean,
    steeringNotifier?: TurnSteeringAttemptNotifier,
  ): Promise<AgentRuntime> {
    const effectiveConfig = this.ctx.effectiveConfig();
    const promptStartedAt = new Date();
    const childrenRunning = this.ctx.subagentCoordinator
      .snapshot(this.ctx.state.threadId)
      .some((child) => child.status === "running" || child.status === "stopping");
    const reviewPending = this.ctx.state.reviewSessions?.some((session) => session.status !== "applied");
    const budget =
      childrenRunning || reviewPending || this.ctx.compacting
        ? this.ctx.sharedTaskBudget(this.ctx.state.threadId)
        : this.ctx.newTaskBudget(this.ctx.state.threadId);
    this.ctx.taskBudgets.set(this.ctx.state.threadId, budget);
    const visionCapable = modelSupportsVision(this.ctx.state.provider, this.ctx.state.model);
    const provider = createProvider(effectiveConfig, this.ctx.state.provider, this.ctx.state.model, {
      loadImage: (attachment) => this.ctx.imageStore.load(this.ctx.state.threadId, attachment),
    });
    const workspaceId = this.ctx.state.projectId ?? workspaceIdFromRoot(this.ctx.workspace.root);
    const projectMemoryId = this.ctx.state.projectId ?? projectMemoryIdFromRoot(this.ctx.workspace.root);
    const commandRuntime = this.ctx.createCommandRuntime(this.ctx.workspace);
    const commandOwner = {
      threadId: this.ctx.state.threadId,
      agentRole: "main_agent" as const,
    };
    const toolCatalog = await this.ctx.mainToolCatalogSnapshot();

    return new AgentRuntime({
      provider,
      ...this.localDecisionDependencies(),
      limits: this.ctx.config.limits,
      taskBudget: budget,
      tokenCalibration: new TokenCalibration(
        JSON.stringify([provider.name, provider.model, effectiveConfig.providers[provider.name]!.baseUrl]),
        this.ctx.storage,
      ),
      toolCatalog,
      threadTitle: {
        isUnclaimed: (threadId) => this.ctx.threadTitles.isUnclaimed(threadId),
        claim: (threadId, title) => this.ctx.threadTitles.claim(threadId, title),
      },
      onThreadTitleClaimed: (title) => this.ctx.terminal.threadTitleChanged?.(title),
      connectedMcpServers: this.ctx.mcpConnections?.connectedServers() ?? [],
      visionAvailable: visionCapable,
      authorizeToolExecution: (request) => this.ctx.authorizeCatalogToolCall(request),
      agentIdentity: { role: "main_agent" },
      takeSubagentMessages: async (threadId, turnId) => this.ctx.subagentMessages.deliverToModel(threadId, turnId),
      contextManager: this.ctx.contextManager,
      buildSystemPrompt: async ({
        mode,
        workspaceSummary,
        memories,
        workingCheckpoint,
        retrievedThreadEvidence,
        toolNames,
        taskGraph,
        planReview,
      }) =>
        buildSystemPrompt({
          config: effectiveConfig,
          workspaceFolders: this.ctx.workspace.folders,
          skillStore: SkillStore.forProject(
            this.ctx.workspace.root,
            this.ctx.config.dataDir,
            this.ctx.state.projectId ?? workspaceIdFromRoot(this.ctx.workspace.root),
          ),
          now: promptStartedAt,
          mode,
          workspaceSummary,
          memories,
          ...(workingCheckpoint ? { workingCheckpoint } : {}),
          ...(retrievedThreadEvidence ? { retrievedThreadEvidence } : {}),
          availableTools: toolNames,
          commandExecutionMode: this.ctx.commandExecutionMode,
          ...(taskGraph ? { taskGraph } : {}),
          ...(planReview ? { planReview } : {}),
        }),
      getWorkspaceSummary: async () => json(this.ctx.workspace.getManifestSummary()),
      ...runtimeContextDependencies(
        {
          memoryManager: this.ctx.memoryManager,
          contextArtifactIndex: this.ctx.contextArtifactIndex,
          limits: this.ctx.config.limits,
        },
        {
          workspaceId,
          projectMemoryId,
          workspaceRoot: this.ctx.workspace.root,
          // The main thread can recall evidence archived by the review sessions it started.
          evidenceOwner: sharedReviewEvidenceOwner,
        },
      ),
      recordMemoryRecall: (threadId, turnId, memoryIds) =>
        this.ctx.memoryManager.recordRecall(threadId, turnId, memoryIds),
      checkpointContext: async (state) => {
        await this.ctx.workspace.fullConsistencyCheck();
        this.ctx.syncWorkspaceState();
        await this.ctx.contextArtifactIndex.checkpoint(workspaceId, state);
      },
      hasOpenCommandHandles: () => commandRuntime.hasOpenCommandHandles(commandOwner),
      getEnvironmentFault: () => commandRuntime.environmentFault(),
      commitMemoryMutations: async (input) =>
        this.ctx.memoryManager.applyModelMutationsWithEmbeddings({
          workspaceId: this.ctx.state.projectId ?? workspaceIdFromRoot(this.ctx.workspace.root),
          workspaceRoot: input.workspaceRoot,
          threadId: input.threadId,
          turnId: input.turnId,
          outcome: input.outcome,
          mutations: input.mutations,
        }),
      appendEvent: async (event) => {
        const { threadId, ...input } = event;
        this.ctx.threadStore.appendEvent(threadId, input);
        this.ctx.dirty = true;
      },
      ...(steeringNotifier ? this.steeringDependencies(steeringNotifier) : {}),
      recordCommand: (turnId, entry) => {
        this.ctx.threadStore.recordToolAudit(this.ctx.state.threadId, turnId, entry);
        this.ctx.dirty = true;
      },
      commitImages: async (threadId, attachments) => {
        for (const attachment of attachments) {
          await this.ctx.imageStore.commit(threadId, attachment);
        }
      },
      onToolCompleted: (state, toolName, result, displayName, details) =>
        this.onToolCompleted(state, toolName, result, displayName, details),
      onSubagentLifecycleRollback: (update) => {
        this.ctx.subagentCoordinator.rollbackLifecycle(update);
      },
      getOutstandingSubagents: () => this.ctx.subagentCoordinator.outstanding(this.ctx.state.threadId),
      collectReadySubagents: (state, turnId, signal) =>
        this.ctx.subagentHost.collectReadySubagentResults(state, turnId, signal),
      requestApproval: async (request) => {
        return this.ctx.requestToolApproval(request);
      },
      runReviewSession: async (input) => this.runReviewSession(input, provider, budget),
      onModelUsage: async (record) => {
        this.ctx.threadStore.appendEvent(this.ctx.state.threadId, {
          type: "model.usage",
          phase: "completed",
          payload: record,
        });
        this.ctx.dirty = true;
      },
      onModeSelected: (mode) => {
        this.ctx.config.mode = mode;
        this.ctx.syncTerminalView();
      },
      onProviderContext: (snapshot) => {
        if (snapshot.threadId === this.ctx.state.threadId) {
          this.ctx.lastProviderContext = snapshot;
          this.ctx.syncTerminalView();
        }
      },
      ...this.presentationCallbacks(presentReasoning),
      ...(visionCapable
        ? {
            attachImage: (input: { threadId: string; label: string; absolutePath: string; sourceName?: string }) =>
              this.ctx.imageStore.importFile(
                input.threadId,
                input.label,
                input.absolutePath,
                input.sourceName,
                this.ctx.workspace.root,
              ),
            discardImage: (threadId: string, attachment: ImageAttachment) =>
              this.ctx.imageStore.remove(threadId, attachment),
          }
        : {}),
    });
  }

  /** The optional local Laya classifier, its decision traces, and the one-challenge-per-delivery rule. */
  private localDecisionDependencies(): Pick<
    AgentRuntimeDependencies,
    "localDecision" | "recordLocalDecision" | "recordLocalDecisionFallback" | "deliveryChallengeAlreadyUsed"
  > {
    return {
      localDecision: (task, input, signal) => {
        this.ctx.localLayaClient ??= new LocalLayaClient(
          {
            startupMs: this.ctx.config.limits.layaStartupTimeoutMs,
            decisionMs: this.ctx.config.limits.layaDecisionTimeoutMs,
            idleMs: this.ctx.config.limits.layaIdleTimeoutMs,
          },
          {
            dataDir: this.ctx.config.dataDir,
            python:
              process.env.EASY_CODE_LAYA_PYTHON ||
              path.join(
                this.ctx.config.dataDir,
                "runtimes",
                "laya-decision-onnx",
                process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
              ),
          },
        );
        return this.ctx.localLayaClient.decide(task, input, signal);
      },
      recordLocalDecision: (trace) => appendLocalDecisionTrace(this.ctx.workspace.root, trace),
      recordLocalDecisionFallback: (trace) => appendLocalDecisionFallbackTrace(this.ctx.workspace.root, trace),
      deliveryChallengeAlreadyUsed: (threadId) => {
        const events = this.ctx.threadStore.journal(threadId).read();
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index];
          if (event?.type === "decision.delivery.challenge_requested") return true;
          const completedReason =
            event?.payload && typeof event.payload === "object" && "reason" in event.payload
              ? event.payload.reason
              : undefined;
          if (event?.type === "turn.completed" && (completedReason === "success" || completedReason === "planned"))
            return false;
        }
        return false;
      },
    };
  }

  /** Mid-turn user adjustments and peer messages, delivered through the thread's steering queue. */
  private steeringDependencies(
    steeringNotifier: TurnSteeringAttemptNotifier,
  ): Pick<
    AgentRuntimeDependencies,
    "steeringNotifier" | "takeSteering" | "sealSteering" | "hasPendingSteering" | "onSteeringApplied"
  > {
    return {
      steeringNotifier,
      takeSteering: async ({ threadId, turnId, boundary }) =>
        this.ctx.threadStore.drainTurnSteering(threadId, turnId, this.ctx.config.limits, boundary !== "after_model"),
      sealSteering: async ({ threadId, turnId }) =>
        this.ctx.terminal.sealCurrentRequestSteering(() =>
          this.ctx.threadStore.sealTurnSteering(threadId, turnId, this.ctx.config.limits),
        ),
      hasPendingSteering: async ({ threadId, turnId }) => this.ctx.threadStore.hasPendingTurnSteering(threadId, turnId),
      onSteeringApplied: (batch: Readonly<TurnSteeringBatch>) => {
        if (batch.source === "peer_message") {
          for (const entry of batch.entries)
            this.ctx.terminal.peerMessage?.(entry.senderThreadId!, entry.message.content);
          return;
        }
        const first = batch.entries[0]?.sequence;
        const last = batch.throughSequence;
        const range = first === last ? `#${last}` : `#${first}-#${last}`;
        this.ctx.terminal.success(`Applied adjustment${first === last ? "" : "s"} ${range}.`);
      },
    };
  }

  /** Present a finished tool call and apply its child-agent effects before saving. */
  private async onToolCompleted(
    ...[state, toolName, result, displayName, details]: Parameters<
      NonNullable<AgentRuntimeDependencies["onToolCompleted"]>
    >
  ): Promise<void> {
    if (toolName === "send_thread_message" && result.ok) {
      const sent = result.data as { targetThreadId: string; message: string };
      this.ctx.terminal.peerMessage?.(sent.targetThreadId, sent.message, true);
    }
    this.ctx.terminal.toolCompleted(displayName ?? toolName, result.ok, result.summary, result.error, details);
    if (toolName === "name_thread" && result.ok) {
      const title = (result.data as { title?: unknown } | undefined)?.title;
      if (typeof title === "string") this.ctx.terminal.threadTitleChanged?.(title);
    }
    let mergedSubagentArtifacts: ObservedSubagentArtifacts | undefined;
    if (result.ok && result.subagentLifecycle) {
      const artifacts = this.ctx.subagentCoordinator.commitLifecycle(result.subagentLifecycle);
      if (artifacts) {
        await this.ctx.subagentHost.mergeSubagentArtifacts(state, artifacts);
        mergedSubagentArtifacts = artifacts;
      }
    }
    this.ctx.syncWorkspaceState();
    this.ctx.save();
    if (mergedSubagentArtifacts) {
      this.ctx.subagentCoordinator.finalizeArtifactMerge(mergedSubagentArtifacts.agentId);
    }
    if ((toolName === "manage_tasks" || toolName === "manage_subagents") && result.ok && result.taskGraphUpdate) {
      try {
        this.ctx.terminal.taskGraph(
          taskGraphView(result.taskGraphUpdate, (agentId) => this.ctx.subagentCoordinator.displayLabel(agentId)),
        );
      } catch {
        this.ctx.terminal.info("The task DAG was updated successfully, but its terminal view could not be rendered.");
      }
    }
    if (toolName === "manage_subagents" && result.ok) {
      try {
        this.ctx.infoCommands.printSubagents();
      } catch {
        this.ctx.terminal.info(
          "The child-agent state was updated successfully, but its terminal view could not be rendered.",
        );
      }
    }
    if (result.ok && result.presentation?.type === "file_diff") {
      try {
        this.ctx.terminal.fileDiff(result.presentation);
      } catch {
        this.ctx.terminal.info("The file was updated successfully, but the diff preview could not be rendered.");
      }
    }
  }

  /** Run an independent workspace review under the workspace mutation lock. */
  private runReviewSession(
    input: Parameters<NonNullable<AgentRuntimeDependencies["runReviewSession"]>>[0],
    provider: ModelProvider,
    budget: TaskBudget,
  ): ReturnType<NonNullable<AgentRuntimeDependencies["runReviewSession"]>> {
    return this.ctx.workspaceMutationLock.runExclusive(async () => {
      // A background writer outlives its run_command lock; do not snapshot it.
      if (this.ctx.hasRunningCommands())
        return {
          decision: "unavailable" as const,
          requests: 0,
          reused: true,
          reason: "A supervised command is still running; observe its terminal result before review.",
        };
      const reviewUiId = this.ctx.terminal.startReview();
      try {
        return await runWorkspaceReview(input, {
          workspace: this.ctx.workspace,
          store: this.ctx.threadStore,
          memory: this.ctx.memoryManager,
          index: this.ctx.contextArtifactIndex,
          provider,
          budget,
          limits: this.ctx.config.limits,
          sensitivePaths: [
            this.ctx.config.configDir,
            this.ctx.config.dataDir,
            this.ctx.config.cacheDir,
            USER_MODEL_REGISTRY_PATH,
            USER_MCP_CONFIG_PATH,
          ],
          dataDir: this.ctx.config.dataDir,
          lifecycleDirectory: path.join(this.ctx.config.dataDir, "review-command-leases"),
          offline: this.ctx.trustedOuterSandbox === "harbor",
          status: (text) => this.ctx.terminal.status(text),
          onProgress: (progress) => this.ctx.terminal.updateReview(reviewUiId, progress.phase),
          approve: async (context, request) =>
            this.ctx.approvalQueue.run(async () => {
              if (request.signal?.aborted || request.command?.scope === "host") return false;
              const saved = this.ctx.threadStore.recover(context.threadId);
              if (isCommandApprovalPrefixGranted(saved.commandApprovalPrefixes, request.commandPrefix)) return true;
              // Review permissions do not inherit main-thread Full access.
              const decision = await this.ctx.reviewApproval(request);
              this.ctx.threadStore.appendEvent(context.threadId, { type: "approval.reviewed", payload: decision });
              let vote = decision.decision;
              if (vote === "reject") {
                if (this.ctx.trustedOuterSandbox || request.allowPrompt === false || !process.stdin.isTTY) return false;
                vote = await this.ctx.terminal.approve({
                  ...request,
                  description: `${request.description}\nApproval reviewer: ${decision.reason}`,
                });
              }
              if (request.signal?.aborted) return false;
              if (vote === "allow_prefix" && canGrantCommandPrefix(request.commandPrefix))
                this.ctx.threadStore.recordCommandApprovalPrefixGrant(
                  context.threadId,
                  request.commandPrefix,
                  context.turnId,
                );
              return vote !== "reject";
            }),
        });
      } finally {
        this.ctx.terminal.stopReview(reviewUiId);
      }
    }, input.signal);
  }

  /** Transient terminal presentation: status, activity spinners, streamed output and reasoning. */
  private presentationCallbacks(presentReasoning: boolean): Partial<AgentRuntimeDependencies> {
    return {
      onStatus: (status) => this.ctx.terminal.status(status),
      onCompactionProgress: (progress) => {
        this.ctx.autoCompacting = progress.mode === "automatic" && compactionRunning(progress);
        this.ctx.terminal.compactionProgress?.(progress);
      },
      onModelRequestStart: (text) => this.ctx.terminal.startActivity(text, "model"),
      onModelRequestEnd: (activityToken) => {
        if (typeof activityToken === "string") {
          this.ctx.terminal.stopActivity(activityToken);
        }
      },
      onToolExecutionStart: (toolName, text) => this.ctx.terminal.startActivity(text, "tool", toolName),
      onToolExecutionEnd: (_toolName, activityToken) => {
        if (typeof activityToken === "string") {
          this.ctx.terminal.stopActivity(activityToken);
        }
      },
      onModelStream: (event: Readonly<ProviderStreamEvent>) => {
        try {
          this.ctx.terminal.modelStream(event);
        } catch {
          // Streaming is transient UI only; the assembled response is still shown.
        }
      },
      ...(presentReasoning
        ? {
            onReasoning: ({ text }: { text: string }) => {
              try {
                this.ctx.terminal.addReasoning(text);
              } catch {
                // Reasoning presentation is transient and must never interrupt
                // a persisted model response or its pending tool calls.
              }
            },
          }
        : {}),
    };
  }
}
