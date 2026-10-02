import { parseSlashCommand } from "../cli/slash-command.js";
import type {
  AgentRunResult,
  ChatMessage,
  CommandExecutionMode,
  EasyCodeConfig,
  ImageAttachment,
  SessionState,
  TurnSteeringEntry,
} from "../core/types.js";
import { translate } from "../i18n/catalog.js";
import { readLanguage } from "../i18n/language.js";
import {
  ImageStore,
  nextThreadImageNumber,
  validateImageAttachmentCollection,
  type ClipboardImageReader,
} from "../images/index.js";
import { validateProviderImageAttachments } from "../models/catalog.js";
import { formatPlanProposal } from "../plans/plan.js";
import { ThreadResourceStore, type ThreadResourceAttachment } from "../resources/index.js";
import { AgentRuntime } from "../runtime/agent.js";
import { TaskBudget } from "../runtime/task-budget.js";
import { TurnSteeringAttemptNotifier } from "../runtime/turn-steering-notifier.js";
import { type EasyCodeStorage } from "../storage/database.js";
import { SubagentCoordinator } from "../subagents/coordinator.js";
import { ThreadStore } from "../threads/thread-store.js";
import type { AppInteractionPort, PlanReviewDecision, TurnSummary } from "../ui/interaction-port.js";
import { createId } from "../utils/ids.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { ModelSelection } from "./model-selection.js";
import { SubagentHost } from "./subagent-host.js";
import { turnChangedFiles } from "./turn-changes.js";
import { renderPromptBundleText, stripPasteFailureMarkers } from "./text.js";
import type { ActiveTurnSteering, ExecutePromptOptions } from "./types.js";

/** Live state and callbacks supplied by EasyCodeApp. */
export interface AppTurnExecutionContext {
  readonly executePromptOwned: AppTurnExecution["executePromptOwned"];
  readonly activeContextCharLimit: () => number;
  activeTurnController: AbortController | undefined;
  activeTurnSteering: ActiveTurnSteering | undefined;
  readonly announceResumeRecovery: () => void;
  autoCompacting: boolean;
  readonly cancelActiveRequest: () => boolean;
  readonly captureClipboardImage: (
    index: number,
    currentImages?: readonly ImageAttachment[],
    signal?: AbortSignal,
  ) => Promise<ImageAttachment>;
  readonly clipboardImageReader: ClipboardImageReader;
  readonly closed: boolean;
  readonly commandExecutionMode: CommandExecutionMode;
  compacting: boolean;
  readonly config: EasyCodeConfig;
  readonly createRuntime: (
    presentReasoning: boolean,
    steeringNotifier?: TurnSteeringAttemptNotifier,
  ) => Promise<AgentRuntime>;
  dirty: boolean;
  readonly discardImages: (images: readonly ImageAttachment[]) => Promise<void>;
  readonly hasActiveOrchestration: () => boolean;
  readonly hasRunningCommands: () => boolean;
  readonly hostAccessEpoch: number;
  readonly imageStore: ImageStore;
  readonly isCompacting: () => boolean;
  readonly isRequestActive: () => boolean;
  readonly maxModelRequests: number | undefined;
  readonly modelSelection: ModelSelection;
  readonly orchestrationEnabled: () => boolean;
  readonly pauseMemoryMaintenance: (wait?: boolean) => Promise<void>;
  pendingImages: ImageAttachment[];
  readonly prepareProjectSandbox: (workspace: WorkspaceManager) => Promise<void>;
  readonly requireCurrentModelVision: () => void;
  readonly save: () => void;
  readonly state: SessionState;
  readonly storage: EasyCodeStorage;
  readonly subagentCoordinator: SubagentCoordinator;
  readonly subagentHost: SubagentHost;
  readonly syncTerminalView: (announceHeader?: boolean) => void;
  readonly syncWorkspaceState: () => void;
  readonly terminal: AppInteractionPort;
  readonly threadResourceStore: ThreadResourceStore;
  readonly threadStore: ThreadStore;
  uninstallController: AbortController | undefined;
  readonly uninstallRequested: boolean;
  readonly workspace: WorkspaceManager;
  readonly taskBudgets: Map<string, TaskBudget>;
}

export class AppTurnExecution {
  constructor(private readonly ctx: AppTurnExecutionContext) {}

  async runOnce(prompt: string): Promise<AgentRunResult> {
    this.ctx.announceResumeRecovery();
    if (this.ctx.state.planReview) {
      throw new Error(
        `Thread ${this.ctx.state.threadId} has a ${this.ctx.state.planReview.status.replace(/_/gu, " ")} ` +
          `plan (${this.ctx.state.planReview.proposal.id} revision ` +
          `${this.ctx.state.planReview.proposal.revision}). Resume it interactively to review or execute the plan.`,
      );
    }
    const normalized = prompt.trim();
    if (!normalized && this.ctx.pendingImages.length === 0) {
      throw new Error("A non-empty prompt or at least one image is required");
    }
    const result = await this.executePrompt(normalized || "Analyze the attached image(s).", this.ctx.pendingImages);
    this.ctx.pendingImages = [];
    if (result.planProposal) {
      this.ctx.terminal.info(`Resume thread ${result.threadId} interactively to approve, reject, or adjust this plan.`);
    }
    return result;
  }

  /** Submit a user turn without depending on the CLI prompt-reading loop. */
  async submitUserMessage(
    text: string,
    images: readonly ImageAttachment[] = [],
    resources: readonly ThreadResourceAttachment[] = [],
  ): Promise<AgentRunResult> {
    if (this.ctx.compacting) throw new Error("Wait for context compaction to finish before sending a message.");
    if (this.ctx.state.planReview) {
      throw new Error("Review the pending plan before starting another request.");
    }
    if (!text.trim() && images.length === 0 && resources.length === 0) {
      throw new Error("A non-empty prompt or at least one attachment is required");
    }
    for (const resource of resources) {
      const stored = await this.ctx.threadResourceStore.get(this.ctx.state.threadId, resource.uri);
      if (stored.id !== resource.id || stored.filename !== resource.filename) {
        throw new Error("A Thread resource no longer matches its stored metadata.");
      }
    }
    const resourceNotice = resources.length
      ? `\n\nAttached read-only Thread resources:\n${resources
          .map((resource) => `- ${resource.filename}: ${resource.uri}`)
          .join("\n")}\nUse read_file with these exact paths to inspect their contents.`
      : "";
    return this.executePrompt(`${text.trim()}${resourceNotice}`.trim(), images, true);
  }

  /** Queue an adjustment for the running turn; the Journal owns it after enqueue succeeds. */
  async submitAdjustment(text: string, images: readonly ImageAttachment[] = []): Promise<number> {
    if (this.ctx.isCompacting()) throw new Error("Adjustments are unavailable during context compaction.");
    if (parseSlashCommand(text)?.name === "compact")
      throw new Error("/compact is only available when the conversation is idle.");
    const active = this.ctx.activeTurnSteering;
    const turnId = this.ctx.state.activeTurnId;
    if (!active || !turnId || active.threadId !== this.ctx.state.threadId || active.controller.signal.aborted) {
      throw new Error("The active task finished before this adjustment could be queued.");
    }
    if (!text.trim() && images.length === 0) throw new Error("An adjustment needs text or an image.");
    if (images.length > 0) this.ctx.requireCurrentModelVision();
    const unique = new Map<string, ImageAttachment>();
    for (const image of active.requestImages) unique.set(image.id, image);
    for (const entry of this.ctx.threadStore.pendingTurnSteering(active.threadId)) {
      for (const image of entry.message.images ?? []) unique.set(image.id, image);
    }
    for (const image of active.draftImages.values()) unique.set(image.id, image);
    for (const image of images) unique.set(image.id, image);
    validateImageAttachmentCollection([...unique.values()]);
    validateProviderImageAttachments(this.ctx.state.provider, images);
    const entry: TurnSteeringEntry = this.ctx.threadStore.enqueueTurnSteering(active.threadId, turnId, {
      role: "user",
      content: text,
      ...(images.length ? { images: images.map((image) => ({ ...image })) } : {}),
    });
    this.ctx.dirty = true;
    // The durable message, not the editor, now owns these attachments.
    for (const image of images) active.draftImages.delete(image.id);
    active.notifier.notify(entry.sequence);
    this.ctx.terminal.addQueuedAdjustment(entry.sequence, text, images);
    try {
      for (const image of images) await this.ctx.imageStore.commit(active.threadId, image);
    } catch (error) {
      this.ctx.terminal.error(
        `Adjustment #${entry.sequence} is queued, but attachment finalization failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    return entry.sequence;
  }

  async processPendingPlanReview(showPlan: boolean, suppliedDecision?: PlanReviewDecision): Promise<boolean> {
    let shouldShowPlan = showPlan;
    const oneDecisionOnly = suppliedDecision !== undefined;
    while (this.ctx.state.planReview && !this.ctx.closed) {
      const review = this.ctx.state.planReview;
      const proposal = review.proposal;

      if (review.status === "approved_pending_execution") {
        this.ctx.terminal.info(translate(readLanguage(this.ctx.storage), "cli.planExecuting"));
        const result = await this.executePrompt(
          renderPromptBundleText("runtime/plan-approved.md", {
            planId: proposal.id,
            revision: proposal.revision,
            plan: formatPlanProposal(proposal),
          }),
          [],
          true,
          {
            approvedPlan: {
              id: proposal.id,
              revision: proposal.revision,
            },
          },
        );
        shouldShowPlan = false;
        if (!result.planProposal || oneDecisionOnly) return true;
        continue;
      }

      if (shouldShowPlan) this.ctx.terminal.showPlan(proposal);
      const decision =
        suppliedDecision ??
        (await this.ctx.terminal.reviewPlan({
          plan: proposal,
          captureText: async (signal) => this.ctx.clipboardImageReader.readText?.(signal),
        }));
      suppliedDecision = undefined;
      if (decision.action === "defer") {
        this.ctx.dirty = true;
        this.ctx.save();
        return false;
      }

      if (decision.action === "approve") {
        const event = this.ctx.threadStore.appendEvent(this.ctx.state.threadId, {
          type: "plan.approved",
          phase: "completed",
          payload: {
            planId: proposal.id,
            revision: proposal.revision,
          },
        });
        this.ctx.state.planReview = {
          ...review,
          status: "approved_pending_execution",
          approvedAt: event.timestamp,
        };
        this.ctx.state.mode = "code";
        this.ctx.config.mode = "code";
        this.ctx.state.updatedAt = event.timestamp;
        this.ctx.dirty = true;
        this.ctx.save();
        this.ctx.terminal.success(translate(readLanguage(this.ctx.storage), "cli.planApprovedCode"));
        shouldShowPlan = false;
        continue;
      }

      if (decision.action === "reject") {
        const message: Extract<ChatMessage, { role: "user" }> = {
          role: "user",
          content: renderPromptBundleText("runtime/plan-rejected.md", {
            planId: proposal.id,
            revision: proposal.revision,
          }),
        };
        const event = this.ctx.threadStore.appendEvent(this.ctx.state.threadId, {
          type: "plan.rejected",
          phase: "completed",
          payload: {
            planId: proposal.id,
            revision: proposal.revision,
            message,
          },
        });
        this.ctx.state.planReview = undefined;
        this.ctx.state.messages.push(message);
        this.ctx.state.updatedAt = event.timestamp;
        this.ctx.dirty = true;
        this.ctx.save();
        this.ctx.terminal.info(translate(readLanguage(this.ctx.storage), "cli.planRejected"));
        return true;
      }

      const event = this.ctx.threadStore.appendEvent(this.ctx.state.threadId, {
        type: "plan.feedback_submitted",
        phase: "completed",
        payload: {
          planId: proposal.id,
          revision: proposal.revision,
          feedback: decision.feedback,
        },
      });
      this.ctx.state.planReview = {
        ...review,
        feedback: decision.feedback,
      };
      this.ctx.state.updatedAt = event.timestamp;
      this.ctx.dirty = true;
      this.ctx.save();
      const result = await this.executePrompt(
        renderPromptBundleText("runtime/plan-adjustment.md", {
          planId: proposal.id,
          revision: proposal.revision,
          feedback: decision.feedback,
        }),
        [],
        true,
        this.ctx.state.mode === "auto" ? { modeOverride: "plan" } : {},
      );
      shouldShowPlan = !result.planProposal;
      if (oneDecisionOnly) {
        if (result.planProposal) this.ctx.terminal.showPlan(result.planProposal);
        return true;
      }
    }
    return true;
  }

  async compactCurrentSession(): Promise<void> {
    if (this.ctx.isRequestActive()) throw new Error("/compact is only available when the conversation is idle.");
    if (
      this.ctx.hasRunningCommands() ||
      this.ctx.subagentCoordinator.hasUnfinished(this.ctx.state.threadId) ||
      this.ctx.subagentCoordinator.hasOutstanding(this.ctx.state.threadId)
    ) {
      throw new Error("Wait for running commands and agents to finish before compacting.");
    }
    const controller = new AbortController();
    this.ctx.activeTurnController = controller;
    this.ctx.compacting = true;
    const operationId = createId("compact");
    const startedAt = Date.now();
    const onInterrupt = () => controller.abort();
    process.on("SIGINT", onInterrupt);
    try {
      this.ctx.terminal.setCurrentRequest("/compact", [], { onInterrupt });
      this.ctx.terminal.compactionProgress?.({
        operationId,
        mode: "manual",
        startedAt,
        phase: "preparing",
        beforeChars: 0,
      });
      const runtime = await this.ctx.createRuntime(false);
      const result = await runtime.compactSession(this.ctx.state, {
        maxContextChars: this.ctx.activeContextCharLimit(),
        signal: controller.signal,
        operationId,
        startedAt,
        onProgress: (progress) => this.ctx.terminal.compactionProgress?.(progress),
      });
      if (result.reason) this.ctx.terminal.warning(result.reason);
      this.ctx.dirty = true;
    } catch (error) {
      this.ctx.terminal.compactionProgress?.({
        operationId,
        mode: "manual",
        startedAt,
        completedAt: Date.now(),
        phase: controller.signal.aborted ? "cancelled" : "failed",
        beforeChars: 0,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      this.ctx.compacting = false;
      if (this.ctx.activeTurnController === controller) this.ctx.activeTurnController = undefined;
      this.ctx.terminal.clearCurrentRequest();
      this.ctx.save();
      this.ctx.syncTerminalView();
    }
  }

  private async executePrompt(
    userInput: string,
    images: readonly ImageAttachment[] = [],
    presentReasoning = false,
    runtimeOptions: ExecutePromptOptions = {},
  ): Promise<AgentRunResult> {
    if (this.ctx.activeTurnController) {
      throw new Error("A request is already running in this Thread.");
    }
    const controller = new AbortController();
    this.ctx.activeTurnController = controller;
    try {
      return await this.ctx.executePromptOwned(userInput, images, presentReasoning, runtimeOptions, controller);
    } finally {
      if (this.ctx.activeTurnController === controller) this.ctx.activeTurnController = undefined;
    }
  }

  async executePromptOwned(
    userInput: string,
    images: readonly ImageAttachment[],
    presentReasoning: boolean,
    runtimeOptions: ExecutePromptOptions,
    controller: AbortController,
  ): Promise<AgentRunResult> {
    await this.ctx.pauseMemoryMaintenance();
    await this.ctx.prepareProjectSandbox(this.ctx.workspace);
    if (this.ctx.commandExecutionMode === "manual" && this.ctx.hasActiveOrchestration()) {
      throw new Error(
        "This thread has unfinished DAG/subagent work. Select /approval → Approve for me or Full access before continuing; no child has been started by this request.",
      );
    }
    await this.ctx.subagentHost.drainPendingSubagentArtifacts(this.ctx.state.threadId);
    this.ctx.modelSelection.requireProviderApiKey(this.ctx.state.provider);
    if (images.length) this.ctx.requireCurrentModelVision();
    validateImageAttachmentCollection(images);
    validateProviderImageAttachments(this.ctx.state.provider, images);
    this.ctx.dirty = true;
    if (this.ctx.uninstallRequested) throw new Error("Task stopped for EASY CODE uninstall.");
    this.ctx.uninstallController = controller;
    const steeringNotifier = new TurnSteeringAttemptNotifier();
    const capturedSteeringImages = new Map<string, ImageAttachment>();
    const pendingSteering = this.ctx.threadStore.pendingTurnSteering(this.ctx.state.threadId);
    const pendingSteeringImages = pendingSteering.flatMap((entry) => entry.message.images ?? []);
    if (pendingSteeringImages.length > 0) this.ctx.requireCurrentModelVision();
    validateImageAttachmentCollection([...images, ...pendingSteeringImages]);
    validateProviderImageAttachments(this.ctx.state.provider, pendingSteeringImages);
    const latestPendingSteering = pendingSteering.at(-1);
    if (latestPendingSteering) steeringNotifier.notify(latestPendingSteering.sequence);
    this.ctx.activeTurnSteering = {
      threadId: this.ctx.state.threadId,
      controller,
      notifier: steeringNotifier,
      requestImages: images,
      draftImages: capturedSteeringImages,
    };
    let interruptCount = 0;
    const onInterrupt = (): void => {
      interruptCount += 1;
      if (interruptCount === 1) {
        this.ctx.terminal.info("Interrupting the current task...");
        this.ctx.cancelActiveRequest();
      } else {
        process.removeListener("SIGINT", onInterrupt);
        if (this.ctx.uninstallController === controller) this.ctx.uninstallController = undefined;
        this.ctx.terminal.emergencyRestore();
        process.exit(130);
      }
    };
    process.on("SIGINT", onInterrupt);

    try {
      const steeringImages = (): ImageAttachment[] => {
        const unique = new Map<string, ImageAttachment>();
        for (const image of images) unique.set(image.id, image);
        for (const entry of this.ctx.threadStore.pendingTurnSteering(this.ctx.state.threadId)) {
          for (const image of entry.message.images ?? []) unique.set(image.id, image);
        }
        for (const image of capturedSteeringImages.values()) unique.set(image.id, image);
        return [...unique.values()];
      };
      const discardCapturedSteeringImages = async (
        attachments: readonly Readonly<ImageAttachment>[],
      ): Promise<void> => {
        const discarded: ImageAttachment[] = [];
        for (const attachment of attachments) {
          const owned = capturedSteeringImages.get(attachment.id);
          if (!owned) continue;
          capturedSteeringImages.delete(attachment.id);
          discarded.push(owned);
        }
        await this.ctx.discardImages(discarded);
      };
      this.ctx.terminal.setCurrentRequest(userInput, images, {
        onInterrupt,
        initialImageCount: nextThreadImageNumber(this.ctx.state.messages, [...images, ...pendingSteeringImages]) - 1,
        captureImage: async (index, signal) => {
          const attachment = await this.ctx.captureClipboardImage(index, steeringImages(), signal);
          capturedSteeringImages.set(attachment.id, attachment);
          return attachment;
        },
        captureText: async (signal) => this.ctx.clipboardImageReader.readText?.(signal),
        onDiscardImages: discardCapturedSteeringImages,
        onSteer: async (submission) => {
          const text = stripPasteFailureMarkers(submission.text);
          if (!text.trim() && submission.images.length === 0) return;
          try {
            await this.submitAdjustment(text, submission.images);
          } catch (error) {
            await discardCapturedSteeringImages(submission.images);
            throw error;
          }
        },
      });
      const usageBefore = this.usageTotals();
      const changesBefore = this.ctx.workspace.getChangeSet().length;
      const runStartedAt = Date.now();
      const runtime = await this.ctx.createRuntime(presentReasoning, steeringNotifier);
      const result = await runtime.run(
        this.ctx.state,
        { text: userInput, images },
        {
          maxModelRequests: this.ctx.maxModelRequests,
          orchestrationEnabled: this.ctx.orchestrationEnabled(),
          isOrchestrationEnabled: () => this.ctx.orchestrationEnabled(),
          maxContextChars: this.ctx.activeContextCharLimit(),
          maxContextTokens: this.ctx.config.limits.maxContextTokens || undefined,
          maxOutputChars: this.ctx.config.limits.maxOutputChars,
          commandTimeoutMs: this.ctx.config.limits.commandTimeoutMs,
          approvalPolicy: this.ctx.config.approvalPolicy,
          commandExecutionMode: this.ctx.commandExecutionMode,
          isUnrestrictedHostAccessActive: () => this.ctx.commandExecutionMode === "unrestricted",
          unrestrictedHostAccessEpoch: () => this.ctx.hostAccessEpoch,
          signal: controller.signal,
          ...runtimeOptions,
        },
      );

      this.ctx.syncWorkspaceState();
      const turnEvents = this.ctx.threadStore
        .journal(result.threadId)
        .read()
        .filter((event) => event.turnId === result.turnId);
      const startedAt = Date.parse(
        turnEvents.find((event) => event.type === "turn.started" || event.type === "message.user")?.timestamp ?? "",
      );
      const completedAt = Date.parse(
        [...turnEvents].reverse().find((event) => event.type === "turn.completed")?.timestamp ?? "",
      );
      const timing =
        Number.isFinite(startedAt) && Number.isFinite(completedAt) ? { startedAt, completedAt } : undefined;
      if (!this.ctx.terminal.finalizeStreamedAnswer(result.text, timing)) {
        this.ctx.terminal.write(`\n${result.text.trim()}\n\n`);
      }
      const summary = this.turnSummary(
        timing ? timing.completedAt - timing.startedAt : Date.now() - runStartedAt,
        usageBefore,
        changesBefore,
      );
      this.recordTurnSummary(result.threadId, result.turnId, summary);
      this.ctx.terminal.turnCompleted?.(summary);
      return result;
    } finally {
      try {
        this.ctx.autoCompacting = false;
        if (this.ctx.activeTurnSteering?.controller === controller) this.ctx.activeTurnSteering = undefined;
        this.ctx.terminal.clearCurrentRequest();
        await this.ctx.discardImages([...capturedSteeringImages.values()]);
        capturedSteeringImages.clear();
      } finally {
        process.removeListener("SIGINT", onInterrupt);
        if (this.ctx.uninstallController === controller) this.ctx.uninstallController = undefined;
        this.ctx.save();
        this.ctx.syncTerminalView();
      }
    }
  }

  private usageTotals(): { readonly input: number; readonly output: number; readonly reported: number } {
    try {
      const summary = this.ctx.threadStore.modelUsageSummary(this.ctx.state.threadId);
      return { input: summary.promptTokens, output: summary.completionTokens, reported: summary.reportedRequests };
    } catch {
      return { input: 0, output: 0, reported: 0 };
    }
  }

  /** Keep the summary with the turn, so a reopened conversation can show it again. Best effort. */
  private recordTurnSummary(threadId: string, turnId: string, summary: TurnSummary): void {
    try {
      this.ctx.threadStore.appendEvent(threadId, {
        type: "turn.summary",
        turnId,
        payload: {
          durationMs: summary.durationMs,
          ...(summary.inputTokens === undefined ? {} : { inputTokens: summary.inputTokens }),
          ...(summary.outputTokens === undefined ? {} : { outputTokens: summary.outputTokens }),
          changedFiles: summary.changedFiles.map((file) => ({ path: file.path, change: file.change })),
        },
      });
    } catch {
      // The summary is presentation only; a failed append must not fail the finished turn.
    }
  }

  /** Duration, tokens and files of the turn that just finished, from counters taken before it ran. */
  private turnSummary(
    durationMs: number,
    usageBefore: ReturnType<AppTurnExecution["usageTotals"]>,
    changesBefore: number,
  ): TurnSummary {
    const usageAfter = this.usageTotals();
    const reported = usageAfter.reported > usageBefore.reported;
    const changedFiles = turnChangedFiles(this.ctx.workspace.getChangeSet().slice(changesBefore), (relative) =>
      this.ctx.workspace.pathGuard.resolveLexical(relative),
    );
    return {
      durationMs: Math.max(0, durationMs),
      ...(reported
        ? {
            inputTokens: Math.max(0, usageAfter.input - usageBefore.input),
            outputTokens: Math.max(0, usageAfter.output - usageBefore.output),
          }
        : {}),
      changedFiles,
    };
  }

  sharedTaskBudget(threadId: string): TaskBudget {
    let budget = this.ctx.taskBudgets.get(threadId);
    if (!budget) {
      const saved = [...this.ctx.threadStore.journal(threadId).read()]
        .reverse()
        .find((event) => event.type === "runtime.task_budget");
      budget = saved
        ? TaskBudget.restore(saved.payload, this.persistTaskBudget(threadId), {
            maxRequests: this.ctx.maxModelRequests ?? null,
            maxTokens: this.ctx.config.limits.maxTaskTokens,
          })
        : this.newTaskBudget(threadId);
      this.ctx.taskBudgets.set(threadId, budget);
    }
    return budget;
  }

  private persistTaskBudget(
    threadId: string,
  ): (snapshot: import("../runtime/task-budget.js").TaskBudgetSnapshot) => void {
    return (snapshot) => {
      this.ctx.threadStore.appendEvent(threadId, { type: "runtime.task_budget", payload: snapshot });
    };
  }

  newTaskBudget(threadId: string): TaskBudget {
    return new TaskBudget(
      this.ctx.maxModelRequests ?? null,
      this.ctx.config.limits.maxTaskTokens,
      this.persistTaskBudget(threadId),
    );
  }
}
