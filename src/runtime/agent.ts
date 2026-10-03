import { type VerificationKind } from "../command/types.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { type CompactionResult } from "../context/compaction-transaction.js";
import type { NormalRequestEnvelope } from "../context/context-request.js";
import { type ContextPressureLevel, type ProviderRequestContextInspection } from "../context/manager.js";
import { type CompactionProgress } from "../context/manual-compaction.js";
import { RequestPrefixTracker } from "../context/request-prefix.js";
import { resetRequestHistory, resetServerContext, resetStateRequest } from "../context/server-reset.js";
import { budgetedRequest, requestTokens, responseTokenReserve } from "../context/token-budget.js";
import {
  type AgentRunResult,
  type ChatMessage,
  type FunctionToolCall,
  type ImageAttachment,
  type MemoryMutationRequest,
  type ModelUsagePurpose,
  type ModelUsageRecord,
  type PlanProposal,
  type PlanReviewState,
  type ProviderResponse,
  type ProviderStreamEvent,
  type SessionState,
  type SubagentTaskReport,
  type ToolDefinition,
  type TurnSteeringBatch,
  type TurnSteeringBoundary,
} from "../core/types.js";
import { validateImageAttachmentCollection } from "../images/image-store.js";
import { nextThreadImageNumber } from "../images/labels.js";
import type { LocalDecisionResult, LocalDecisionTask } from "../local-decision/client.js";
import { validateProviderImageAttachments } from "../models/catalog.js";
import { clonePlanReviewState } from "../plans/plan.js";
import { foldProgressHint } from "../progress/guard.js";
import { CommandEnvironmentQuarantined } from "../sandbox/environment-fault.js";
import { isSubagentToolName } from "../subagents/tool-names.js";
import { snapshotToolSet } from "../tools/catalog.js";
import { ToolExecutionGateway } from "../tools/execution-gateway.js";
import { createId } from "../utils/ids.js";
import {
  MAX_AUDITED_TOOL_BINDINGS,
  appendSteeringLedgerEntry,
  availableTools,
  configuredRequestLimit,
  contextCapacityFailure,
  deduplicateThreadTitleCalls,
  progressScopeKey,
  renderRuntimePrompt,
  threadTitleUnclaimed,
  updateLatestRequestLedger,
} from "./agent-support.js";
import type {
  AgentRunOptions,
  AgentRuntimeDependencies,
  AgentUserInput,
  HandleTextResponseFlow,
  PrepareStepRequestFlow,
  SettleToolBatchFlow,
  StepLoop,
  StepOutcome,
  TextResponseContext,
  ToolBatchOutcomeContext,
  ToolBatchOutcomeState,
  ToolCallsState,
  TurnReturn,
  TurnRun,
} from "./agent-types.js";
import { type AutoRouteAttempt } from "./auto-router.js";
import { CommandRetryTracker } from "./command-retry.js";
import { ContextMaintenance, type ContextMaintenanceContext } from "./context-maintenance.js";
import { failureCategory } from "./failure-policy.js";
import {
  completeWithApiRetries,
  incompleteModelOutput,
  isContextCapacityError,
  markRetryManaged,
} from "./model-retry.js";
import { createProviderAttemptSignal } from "./provider-attempt-signal.js";
import { StepRequests, type StepRequestsContext } from "./step-requests.js";
import { TaskBudgetExceeded } from "./task-budget.js";
import { ToolCalls, type ToolCallsHostContext } from "./tool-calls.js";
import type { ToolCallsContext } from "./agent-types.js";
import { ToolProtocolExhausted, ToolRecoveryBudget } from "./tool-recovery.js";
import { TurnCompletion, type TurnCompletionContext } from "./turn-completion.js";
import { TurnRouting, type TurnRoutingContext } from "./turn-routing.js";

export class AgentRuntime {
  /** Auxiliary operation: no user turn, tool dispatch, memory writes or task continuation. */
  async compactSession(
    state: SessionState,
    options: {
      maxContextChars: number;
      signal?: AbortSignal;
      operationId?: string;
      startedAt?: number;
      onProgress?: (progress: CompactionProgress) => void;
    },
  ): Promise<CompactionProgress> {
    return this.contextMaintenance.compactSession(state, options);
  }
  private async decideLocally(
    state: Readonly<SessionState>,
    turnId: string,
    task: LocalDecisionTask,
    rawInput: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; result: LocalDecisionResult; appliedDecision: string } | undefined> {
    return this.turnRouting.decideLocally(state, turnId, task, rawInput, signal);
  }
  private async recordLocalDecision(
    id: string,
    state: Readonly<SessionState>,
    turnId: string,
    decision: LocalDecisionResult,
    appliedDecision: string,
    challenged?: boolean,
  ): Promise<void> {
    return this.turnRouting.recordLocalDecision(id, state, turnId, decision, appliedDecision, challenged);
  }

  private orchestrationToolsAvailable(state: Readonly<SessionState>, options: AgentRunOptions): boolean {
    return (
      options.orchestrationEnabled !== false ||
      Boolean(state.taskGraph && state.taskGraph.status !== "completed") ||
      (this.dependencies.getOutstandingSubagents?.().length ?? 0) > 0
    );
  }
  private requestLimit: number | undefined;
  private modelRequestsUsed = 0;
  private retryContext?: { state: SessionState; turnId: string };
  private manualCompaction = false;
  private readonly requestPrefixTracker = new RequestPrefixTracker();
  constructor(private readonly dependencies: AgentRuntimeDependencies) {
    const provider = dependencies.provider;
    dependencies.contextManager.estimateRequestTokens = dependencies.tokenCalibration
      ? dependencies.tokenCalibration.estimate.bind(dependencies.tokenCalibration)
      : requestTokens;
    this.dependencies = {
      ...dependencies,
      provider: {
        get name() {
          return provider.name;
        },
        get model() {
          return provider.model;
        },
        complete: async (request) => {
          if (this.requestLimit !== undefined && this.modelRequestsUsed >= this.requestLimit)
            throw new TaskBudgetExceeded("actor model-request limit reached");
          const limits = dependencies.limits ?? DEFAULT_RUNTIME_LIMITS;
          const capacity = dependencies.contextManager.tokenCapacity;
          const effortReserve =
            request.thinkingEffort === undefined
              ? (capacity?.outputReserve ?? responseTokenReserve(limits, "none"))
              : responseTokenReserve(limits, request.thinkingEffort, capacity?.window);
          const sent = budgetedRequest(
            { ...request, outputReserveTokens: request.outputReserveTokens ?? effortReserve },
            capacity,
            dependencies.contextManager.estimateRequestTokens,
          );
          this.modelRequestsUsed += 1; // Logical model request, not physical transport retries.
          let actualRequest = sent;
          const response = await completeWithApiRetries(provider, sent, {
            limits,
            reserve: (value) => {
              actualRequest = value;
              return (
                dependencies.taskBudget?.reserve(value, dependencies.contextManager.estimateRequestTokens) ??
                (() => undefined)
              );
            },
            onSettled: async (attempt) => {
              if (this.retryContext)
                await dependencies.appendEvent({
                  threadId: this.retryContext.state.threadId,
                  turnId: this.retryContext.turnId,
                  type: "model.api_attempt",
                  phase: attempt.outcome,
                  payload: attempt,
                });
              if (
                attempt.outcome === "failed" &&
                ["stream_header_timeout", "stream_semantic_idle_timeout"].includes(attempt.failure?.code ?? "")
              ) {
                const progress = attempt.failure?.progress;
                const detail = progress
                  ? ` (${progress.reasoningChars} thinking, ${progress.textChars} text, ${progress.toolArgumentChars} tool-argument chars received)`
                  : "";
                const reason =
                  attempt.failure?.code === "stream_header_timeout"
                    ? "Model response headers did not arrive within the configured interval"
                    : "Model stream made no semantic progress for the configured idle interval";
                dependencies.onStatus?.(
                  attempt.failure?.recovery === "retry_api"
                    ? `${reason}${detail}. Retrying API attempt ${attempt.attempt + 1}/${limits.maxProviderRetries + 1}.`
                    : `${reason}${detail}. No API retries remain.`,
                );
              }
            },
            resetContext: async (rejected) => {
              if (this.manualCompaction)
                throw new Error(
                  "Summary exceeds the provider context window; manual compaction will not discard its source history.",
                );
              const active = this.retryContext;
              if (!active) return resetRequestHistory(rejected);
              await resetServerContext(active.state, active.turnId, dependencies.appendEvent);
              dependencies.onStatus?.(
                "Server rejected context capacity. Historical context cleared; retrying once with user requirements. Files, budgets and execution state are unchanged.",
              );
              return resetStateRequest(rejected, active.state);
            },
          });
          try {
            dependencies.tokenCalibration?.observe(actualRequest.messages, actualRequest.tools ?? [], response.usage);
          } catch {
            /* Calibration persistence must not replace a successful response. */
          }
          return response;
        },
      },
    };
    markRetryManaged(this.dependencies.provider);
    const steeringConfigured = Boolean(
      dependencies.takeSteering ||
      dependencies.sealSteering ||
      dependencies.hasPendingSteering ||
      dependencies.steeringNotifier ||
      dependencies.onSteeringApplied,
    );
    if (steeringConfigured && (!dependencies.takeSteering || !dependencies.sealSteering)) {
      throw new Error("Turn steering requires both boundary consumption and finalization sealing");
    }
  }

  private async appendProgressHint(state: SessionState, turnId: string, payload: unknown): Promise<void> {
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "progress.hint.presented",
      phase: "completed",
      payload,
    });
    state.progressGuard = foldProgressHint(state.progressGuard, payload);
  }

  /** Run the single current review implementation; no legacy reviewer or experiment gate remains. */
  private async processProgressIntervention(input: {
    state: SessionState;
    turnId: string;
    userInput: string;
    remainingModelRequests?: number;
    signal?: AbortSignal;
  }): Promise<number> {
    const runReviewSession = this.dependencies.runReviewSession;
    if (!runReviewSession) return 0;
    const scopeKey = progressScopeKey(input.state, input.turnId);
    const pending = input.state.progressGuard.incidents.find(
      (incident) => incident.scopeKey === scopeKey && incident.phase === "review_pending",
    );
    const unfinished = input.state.reviewSessions?.find((session) => session.status !== "applied");
    if (!pending && !unfinished) return 0;
    const result = await runReviewSession({
      ...input,
      maxContextTokens: this.dependencies.contextManager.tokenCapacity?.window,
      incidentId: pending?.incidentId ?? unfinished?.incidentId,
    });
    return result.requests;
  }

  private requestLimitReached(): boolean {
    return this.requestLimit !== undefined && this.modelRequestsUsed >= this.requestLimit;
  }

  private remainingRequestAllowance(): number | undefined {
    return this.requestLimit === undefined ? undefined : Math.max(0, this.requestLimit - this.modelRequestsUsed);
  }
  private observeProviderContext(input: {
    state: SessionState;
    turnId: string;
    purpose: ModelUsagePurpose;
    messages: readonly ChatMessage[];
    tools?: readonly ToolDefinition[];
    enforcedPressure: ContextPressureLevel;
    enforcedUtilization: number;
    attempt: number;
    step?: number;
    maxContextChars: number;
    actualRequest?: ProviderRequestContextInspection;
  }): ProviderRequestContextInspection {
    return this.contextMaintenance.observeProviderContext(input);
  }

  private async takeAndApplySteering(
    state: SessionState,
    turnId: string,
    boundary: TurnSteeringBoundary,
    turnImages: ImageAttachment[],
    seal = false,
    memoryContext?: { userInput: string },
  ): Promise<TurnSteeringBatch | undefined> {
    const batch = seal
      ? await this.dependencies.sealSteering?.({ threadId: state.threadId, turnId })
      : await this.dependencies.takeSteering?.({
          threadId: state.threadId,
          turnId,
          boundary,
        });
    if (!batch) return undefined;
    if (
      !Number.isSafeInteger(batch.throughSequence) ||
      batch.throughSequence <= state.steeringWatermark ||
      batch.entries.length === 0 ||
      (batch.source !== "user_adjust" && batch.source !== "peer_message") ||
      batch.entries.some((entry) => entry.source !== batch.source) ||
      batch.entries[batch.entries.length - 1]?.sequence !== batch.throughSequence ||
      batch.message.role !== "user"
    ) {
      throw new Error("Runtime received an invalid or already-applied steering batch");
    }
    const batchImages = batch.message.images ?? [];
    if (batchImages.length > 0) {
      validateImageAttachmentCollection([...turnImages, ...batchImages]);
      validateProviderImageAttachments(this.dependencies.provider.name, batchImages);
      for (const image of batchImages) {
        if (!turnImages.some((candidate) => candidate.id === image.id)) {
          turnImages.push({ ...image });
        }
      }
    }
    const steeringMessageIndex = state.messages.length;
    state.messages.push({
      role: "user",
      content: batch.message.content,
      ...(batchImages.length > 0 ? { images: batchImages.map((image) => ({ ...image })) } : {}),
    });
    if (batch.source === "user_adjust") appendSteeringLedgerEntry(state, steeringMessageIndex, batch.message.content);
    state.pendingSteering = state.pendingSteering.filter((entry) => entry.sequence > batch.throughSequence);
    state.steeringSequence = Math.max(state.steeringSequence, batch.throughSequence);
    state.steeringWatermark = batch.throughSequence;
    state.updatedAt = new Date().toISOString();
    if (memoryContext && batch.source === "user_adjust") {
      const provenance = batch.entries
        .map((entry) => {
          const labels = (entry.message.images ?? []).map((image) => image.label).join(", ");
          return [entry.message.content, labels ? `[Attachments: ${labels}]` : ""].filter(Boolean).join("\n");
        })
        .join("\n\n");
      memoryContext.userInput += `\n\n[MID_TURN_USER_STEERING]\n${provenance}`;
    }
    this.dependencies.steeringNotifier?.consume(batch.throughSequence);
    try {
      this.dependencies.onSteeringApplied?.(batch, boundary);
    } catch {
      // Presentation is transient; durable application already succeeded.
    }
    return batch;
  }

  private async runProviderAttempt<T>(
    turnSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<{ kind: "completed"; value: T } | { kind: "steering_interrupted" }> {
    const steeringAttempt = this.dependencies.steeringNotifier?.openAttempt();
    const attemptSignal = createProviderAttemptSignal({
      turnSignal,
      steeringSignal: steeringAttempt?.signal,
    });
    try {
      if (attemptSignal.signal.aborted && attemptSignal.abortSource === "steering") {
        return { kind: "steering_interrupted" };
      }
      const value = await operation(turnSignal || steeringAttempt ? attemptSignal.signal : undefined);
      if (attemptSignal.abortSource === "turn") {
        throw turnSignal?.reason ?? new Error("The turn was interrupted");
      }
      if (attemptSignal.abortSource === "steering") {
        return { kind: "steering_interrupted" };
      }
      return { kind: "completed", value };
    } catch (error) {
      if (attemptSignal.abortSource === "turn") throw error;
      if (attemptSignal.abortSource === "steering") {
        return { kind: "steering_interrupted" };
      }
      throw error;
    } finally {
      attemptSignal.dispose();
      steeringAttempt?.dispose();
    }
  }

  async run(state: SessionState, input: string | AgentUserInput, options: AgentRunOptions): Promise<AgentRunResult> {
    const run = this.openTurn(state, input, options);
    try {
      await this.recordTurnStart(run);
      const routed = await this.resolveTurnMode(run);
      if (routed.kind === "return") return routed.value;
      const loop = await this.bindTurnTools(run);
      // Once execution becomes uncertain, this run never re-enables mutations.
      // Recovery is an explicit external repair followed by Resume.
      for (let step = 1; !this.requestLimitReached(); step += 1) {
        const outcome = await this.runStep(loop, step);
        if (outcome.kind === "return") return outcome.value;
        if (outcome.kind === "retry") step -= 1;
      }
      return this.finishAtRequestLimit(run);
    } catch (error) {
      return this.failedRun(run, error);
    }
  }

  /** Validate the request, reset the per-run budget, claim the turn and append the user message to history. */
  private openTurn(state: SessionState, input: string | AgentUserInput, options: AgentRunOptions): TurnRun {
    this.requestLimit = configuredRequestLimit(options);
    this.modelRequestsUsed = 0;
    this.dependencies.contextManager.configureTokenBudget(
      options.maxContextTokens,
      this.dependencies.limits,
      state.thinkingEffort,
    );
    const userInput = typeof input === "string" ? input : input.text;
    const inputImages = typeof input === "string" ? [] : [...(input.images ?? [])];
    validateImageAttachmentCollection(inputImages);
    validateProviderImageAttachments(this.dependencies.provider.name, inputImages);
    const turnId = createId("turn");
    this.retryContext = { state, turnId };
    const turnImages = [...inputImages];
    this.dependencies.steeringNotifier?.consume(state.steeringWatermark);
    const agentIdentity = this.dependencies.agentIdentity ?? { role: "main_agent" as const };
    if (agentIdentity.role === "subagent" && state.mode !== "code" && state.mode !== "plan") {
      throw new Error("An isolated child runtime must remain in Plan or Code mode");
    }
    state.activeTurnId = turnId;
    state.goal = userInput || "Analyze the attached image(s).";
    state.updatedAt = new Date().toISOString();
    const userMessage: Extract<ChatMessage, { role: "user" }> = {
      role: "user",
      content: userInput,
      ...(inputImages.length ? { images: inputImages } : {}),
    };
    const turnHistoryStart = state.messages.length;
    state.messages.push(userMessage);
    updateLatestRequestLedger(state, turnHistoryStart, userMessage.content);
    return {
      state,
      options,
      turnId,
      agentIdentity,
      userInput,
      userMessage,
      turnImages,
      turnHistoryStart,
      memoryContext: { userInput, mutations: [], approvedPlanReview: undefined },
      outstandingSubagentsAtRoute: [],
      effectiveMode: options.modeOverride ?? state.mode,
    };
  }

  /** Persist the user message and, when this turn executes an approved plan, retire the review it came from. */
  private async recordTurnStart(run: TurnRun): Promise<void> {
    const { memoryContext, options, state, turnId, userMessage } = run;
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "message.user",
      phase: "completed",
      payload: { content: run.userInput, message: userMessage },
    });
    if (userMessage.images?.length) {
      await this.dependencies.commitImages?.(state.threadId, userMessage.images);
    }
    if (!options.approvedPlan) return;
    const review = state.planReview;
    if (
      !review ||
      review.status !== "approved_pending_execution" ||
      review.proposal.id !== options.approvedPlan.id ||
      review.proposal.revision !== options.approvedPlan.revision
    ) {
      throw new Error("The approved plan no longer matches the pending review state");
    }
    const replacedTaskGraphId =
      state.taskGraph && state.taskGraph.status !== "completed" ? state.taskGraph.id : undefined;
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "plan.execution_started",
      phase: "completed",
      payload: {
        planId: review.proposal.id,
        revision: review.proposal.revision,
        ...(replacedTaskGraphId ? { replacedTaskGraphId } : {}),
      },
    });
    memoryContext.approvedPlanReview = clonePlanReviewState(review);
    state.planReview = undefined;
    if (replacedTaskGraphId) state.taskGraph = undefined;
    state.updatedAt = new Date().toISOString();
  }

  /** Bind the tools this turn exposes to the model, audit the binding and set up the step loop. */
  private async bindTurnTools(run: TurnRun): Promise<StepLoop> {
    const { agentIdentity, options, state, turnId } = run;
    const imageNumbering = { next: nextThreadImageNumber(state.messages) };
    const exposedTools = availableTools(
      this.dependencies.toolCatalog.tools,
      run.effectiveMode,
      agentIdentity.role,
      state.thinkingEffort,
      this.orchestrationToolsAvailable(state, options),
      this.dependencies.visionAvailable ?? true,
    ).filter(
      (tool) =>
        (tool.name !== "name_thread" || threadTitleUnclaimed(this.dependencies, state.threadId)) &&
        (state.mode !== "auto" ||
          (tool.name !== "manage_tasks" &&
            tool.name !== "spawn_subagent" &&
            (!isSubagentToolName(tool.name) || run.outstandingSubagentsAtRoute.length > 0))),
    );
    const exposedToolCatalog = snapshotToolSet(exposedTools, this.dependencies.toolCatalog.revision);
    const toolGateway = new ToolExecutionGateway(exposedToolCatalog, this.dependencies.authorizeToolExecution);
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "tool.catalog.bound",
      phase: "completed",
      payload: {
        catalogRevision: this.dependencies.toolCatalog.revision,
        catalogHash: this.dependencies.toolCatalog.hash,
        exposureHash: exposedToolCatalog.hash,
        toolCount: exposedToolCatalog.bindings.size,
        toolsTruncated: exposedToolCatalog.bindings.size > MAX_AUDITED_TOOL_BINDINGS,
        tools: [...exposedToolCatalog.bindings.values()].slice(0, MAX_AUDITED_TOOL_BINDINGS).map((binding) => ({
          toolId: binding.toolId,
          modelName: binding.modelName,
          sourceId: binding.sourceId,
          sourceKind: binding.sourceKind,
          schemaHash: binding.schemaHash,
          metadataHash: binding.metadataHash,
        })),
      },
    });
    const limits = this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS;
    return {
      ...run,
      toolGateway,
      imageNumbering,
      progressResponseBase: state.progressGuard?.lastObservedResponseOrdinal ?? 0,
      progressVerificationCommands: new Map<string, VerificationKind>(),
      toolRecovery: new ToolRecoveryBudget(limits.modelContentRetries + 1),
      commandRetries: new CommandRetryTracker(limits.sandboxInitializationRetries),
      retrieval: {
        memories: [],
        rememberedPhaseKey: undefined,
        rememberedQueryKey: "",
        retrievedCache: undefined,
        retrievedQueryKey: "",
      },
      invalidOutputAttempts: 0,
    };
  }

  /** One model request of the turn and everything its response causes. */
  private async runStep(loop: StepLoop, step: number): Promise<StepOutcome> {
    const { agentIdentity, memoryContext, options, state, turnId, turnImages } = loop;
    if (options.signal?.aborted) {
      return {
        kind: "return",
        value: this.finish(
          state,
          turnId,
          "The task was interrupted by the user.",
          "interrupted",
          step - 1,
          memoryContext,
        ),
      };
    }
    const exhausted = await this.collectStepInputs(loop, step);
    if (exhausted) return exhausted;
    const prepared = await this.prepareStepRequest(loop, step);
    if (prepared.kind !== "next") return prepared;
    const requested = await this.requestModelResponse(loop, step, prepared.outputs);
    if (requested.kind !== "response") return requested;
    if (
      agentIdentity.role === "main_agent" &&
      (await this.takeAndApplySteering(state, turnId, "after_model", turnImages, false, memoryContext))
    ) {
      // The response was never added to the transcript, so a tool-call
      // protocol cannot be left half-open. Retry this logical step with the
      // newly coalesced user message.
      return { kind: "retry" };
    }
    const { assistantMessage, executionToolCalls } = await this.recordAssistantResponse(loop, step, requested.response);
    const projectionHistory: ChatMessage[] = [...prepared.outputs.messages, assistantMessage];

    // Execute original arguments; the complete sanitized candidate remains
    // in history until an accepted compaction retires it.
    const invalidOutput = incompleteModelOutput(requested.response);
    if (invalidOutput) return this.rejectIncompleteOutput(loop, step, invalidOutput, executionToolCalls ?? []);
    loop.invalidOutputAttempts = 0;
    const calls = executionToolCalls ?? [];
    const handleTextResponseFlow = await this.handleTextResponse({ ...loop, assistantMessage, calls, step });
    if (handleTextResponseFlow.kind !== "next") return handleTextResponseFlow;
    return this.runToolBatch(loop, step, calls, prepared.outputs.ordinaryToolDefinitions, projectionHistory);
  }

  /** Deliver child reports, parent follow-ups and steering before the step's request, and review stalled progress. */
  private async collectStepInputs(loop: StepLoop, step: number): Promise<TurnReturn | undefined> {
    const { agentIdentity, memoryContext, options, state, turnId, turnImages } = loop;
    if (agentIdentity.role === "main_agent") {
      for (const report of (await this.dependencies.takeSubagentMessages?.(state.threadId, turnId)) ?? []) {
        state.messages.push(report);
      }
    }
    for (const instruction of this.dependencies.takeAdditionalInstructions?.() ?? []) {
      const followUp: Extract<ChatMessage, { role: "user" }> = {
        role: "user",
        content: renderRuntimePrompt("runtime/parent-follow-up.md", {
          instruction,
        }),
      };
      state.messages.push(followUp);
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        stepId: `step_${step}`,
        type: "message.user.synthetic",
        phase: "completed",
        payload: followUp,
      });
    }
    await this.takeAndApplySteering(state, turnId, "before_model", turnImages, false, memoryContext);
    if (agentIdentity.role !== "main_agent") return undefined;
    const shared = this.dependencies.taskBudget?.snapshot();
    const sharedRemaining =
      shared?.maxRequests === null || shared === undefined
        ? undefined
        : Math.max(0, shared.maxRequests - shared.requests);
    const localRemaining = this.remainingRequestAllowance();
    const remainingModelRequests =
      localRemaining === undefined
        ? sharedRemaining
        : sharedRemaining === undefined
          ? localRemaining
          : Math.min(localRemaining, sharedRemaining);
    const reviewRequests = await this.processProgressIntervention({
      state,
      turnId,
      userInput: memoryContext.userInput,
      remainingModelRequests,
      signal: options.signal,
    });
    this.modelRequestsUsed += reviewRequests;
    if (!this.requestLimitReached()) return undefined;
    return {
      kind: "return",
      value: this.finish(
        state,
        turnId,
        "The shared model-request budget was exhausted while reviewing stalled progress.",
        "limit_reached",
        this.modelRequestsUsed,
        memoryContext,
      ),
    };
  }

  /** Send the step's request to the provider; a failed request ends the turn and a steering interruption retries the step. */
  private async requestModelResponse(
    loop: StepLoop,
    step: number,
    outputs: Extract<PrepareStepRequestFlow, { kind: "next" }>["outputs"],
  ): Promise<{ kind: "response"; response: ProviderResponse } | StepOutcome> {
    const { agentIdentity, memoryContext, options, state, turnId, turnImages } = loop;
    const { stepRuntimeContext, selectedForStep, enabledTools, messages } = outputs;
    try {
      const attempted = await this.runProviderAttempt(options.signal, (attemptSignal) =>
        this.withModelRequestActivity(`Waiting for ${this.dependencies.provider.model} response`, () =>
          this.dependencies.provider.complete({
            messages,
            // Every actor prefers the same streaming provider transport.
            // Presentation remains main-agent-only so private child context
            // cannot leak into the parent's terminal.
            responseMode: "stream",
            currentTurnImageIds: turnImages.map((image) => image.id),
            tools: enabledTools.map((tool) => tool.definition),
            signal: attemptSignal,
            thinkingEffort: state.thinkingEffort,
            ...(agentIdentity.role === "main_agent" && this.dependencies.onModelStream
              ? {
                  onStreamEvent: (event: ProviderStreamEvent) => {
                    try {
                      this.dependencies.onModelStream?.(event);
                    } catch {
                      // Live presentation must never replace provider output.
                    }
                  },
                }
              : {}),
          }),
        ),
      );
      if (attempted.kind === "steering_interrupted") {
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `step_${step}`,
          type: "model.attempt.steering_interrupted",
          phase: "interrupted",
          payload: { purpose: "agent_step" },
        });
        await this.takeAndApplySteering(state, turnId, "after_model", turnImages, false, memoryContext);
        return { kind: "retry" };
      }
      const response = attempted.value;
      const usedMemoryIds = (selectedForStep?.memories ?? [])
        .filter((memory) => memory.countsAsUse)
        .map((memory) => memory.id);
      if (
        agentIdentity.role === "main_agent" &&
        usedMemoryIds.length &&
        messages.some((message) => message.role === "user" && message.content === stepRuntimeContext)
      ) {
        try {
          this.dependencies.recordMemoryRecall?.(state.threadId, turnId, usedMemoryIds);
        } catch {
          // Recall accounting is derived state, never a reason to discard a model response.
        }
      }
      await this.reportModelUsage(turnId, "agent_step", response.usage, { step, attempt: 1, retry: false });
      return { kind: "response", response };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.signal?.aborted && isContextCapacityError(error)) {
        return {
          kind: "return",
          value: this.finish(
            state,
            turnId,
            "Context paused: the provider rejected the input capacity after bounded recovery. History, files and pending operations are preserved; reduce required input or configure a supported model window before resuming.",
            "limit_reached",
            step,
            memoryContext,
            undefined,
            undefined,
            {
              code: "context_capacity_exhausted",
              tool: "runtime",
              attempts: state.pressureRecovery?.serverReset ? 1 : 0,
              recoverable: true,
            },
          ),
        };
      }
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        stepId: `step_${step}`,
        type: "model.error",
        phase: "failed",
        payload: { message, category: failureCategory(error, options.signal), commandReplay: false },
      });
      const interrupted = Boolean(options.signal?.aborted);
      return {
        kind: "return",
        value: this.finish(
          state,
          turnId,
          interrupted ? "The task was interrupted by the user." : `Model request failed: ${message}`,
          interrupted ? "interrupted" : error instanceof TaskBudgetExceeded ? "limit_reached" : "failed",
          error instanceof TaskBudgetExceeded ? this.modelRequestsUsed : step,
          memoryContext,
          undefined,
          undefined,
          interrupted ? undefined : contextCapacityFailure(error, state),
        ),
      };
    }
  }

  /** Append the model's response to history and show its reasoning; returns the calls to execute. */
  private async recordAssistantResponse(
    loop: StepLoop,
    step: number,
    response: ProviderResponse,
  ): Promise<{ assistantMessage: ChatMessage; executionToolCalls: FunctionToolCall[] | undefined }> {
    const { state, turnId } = loop;
    const executionToolCalls = deduplicateThreadTitleCalls(response.message.tool_calls);
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: response.message.content,
      ...(response.message.phase ? { phase: response.message.phase } : {}),
      tool_calls: executionToolCalls,
      reasoning_content: response.message.reasoning_content,
    };
    state.messages.push(assistantMessage);
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      stepId: `step_${step}`,
      type: "message.assistant",
      phase: "completed",
      payload: assistantMessage,
    });
    const reasoningText = response.message.reasoning_content;
    const thinkingEffort = state.thinkingEffort;
    if (
      thinkingEffort !== "none" &&
      reasoningText !== undefined &&
      reasoningText !== null &&
      reasoningText.trim().length > 0
    ) {
      try {
        this.dependencies.onReasoning?.({
          type: "reasoning",
          text: reasoningText,
          threadId: state.threadId,
          turnId,
          step,
          provider: this.dependencies.provider.name,
          model: this.dependencies.provider.model,
          thinkingEffort,
        });
      } catch {
        // This hook is ephemeral presentation only. A broken UI must not
        // interrupt the durable assistant message or its pending tool calls.
      }
    }
    return { assistantMessage, executionToolCalls };
  }

  /** Reject every call of a truncated or malformed response and ask the model to correct it, within the content-retry budget. */
  private async rejectIncompleteOutput(
    loop: StepLoop,
    step: number,
    invalidOutput: string,
    calls: readonly FunctionToolCall[],
  ): Promise<StepOutcome> {
    const { memoryContext, state, turnId } = loop;
    loop.invalidOutputAttempts++;
    for (const call of calls) {
      const rejected: ChatMessage = {
        role: "tool",
        name: call.function.name,
        tool_call_id: call.id,
        content: JSON.stringify({ ok: false, error: invalidOutput, executed: false }),
      };
      state.messages.push(rejected);
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "tool.result",
        phase: "failed",
        payload: {
          callId: call.id,
          tool: call.function.name,
          message: rejected,
          result: { ok: false, executed: false, error: invalidOutput },
        },
      });
    }
    const feedback: ChatMessage = { role: "user", content: "RUNTIME_MODEL_CONTENT_ERROR: " + invalidOutput };
    state.messages.push(feedback);
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "message.user.synthetic",
      payload: feedback,
    });
    if (loop.invalidOutputAttempts <= (this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).modelContentRetries)
      return { kind: "continue" };
    return {
      kind: "return",
      value: this.finish(
        state,
        turnId,
        invalidOutput + " Content correction budget exhausted; work is unverified and retained.",
        "failed",
        step,
        memoryContext,
      ),
    };
  }

  /** Execute the response's tool calls, then act on what the batch produced. */
  private async runToolBatch(
    loop: StepLoop,
    step: number,
    calls: FunctionToolCall[],
    ordinaryToolDefinitions: ToolDefinition[],
    projectionHistory: ChatMessage[],
  ): Promise<StepOutcome> {
    const proposePlanBatched = calls.length > 1 && calls.some((call) => call.function.name === "propose_plan");
    const askUserBatched = calls.length > 1 && calls.some((call) => call.function.name === "ask_user");
    const submitTaskResultBatched =
      calls.length > 1 && calls.some((call) => call.function.name === "submit_task_result");
    const stepImageAttachments: ImageAttachment[] = [];
    const batch: ToolCallsState = {
      completedVerificationPhase: false,
      environmentFault: this.dependencies.getEnvironmentFault?.(),
      finishRejectedReason: undefined,
      proposedPlan: undefined,
      unansweredQuestions: undefined,
      requiredProtocolExhaustion: undefined,
      steeringAppliedBetweenTools: false,
      submittedTaskReport: undefined,
    };
    await this.executeToolCalls(
      {
        ...loop,
        calls,
        ordinaryToolDefinitions,
        projectionHistory,
        proposePlanBatched,
        askUserBatched,
        step,
        stepImageAttachments,
        submitTaskResultBatched,
      },
      batch,
    );
    const settleToolBatchFlow = await this.settleToolBatch({ ...loop, ...batch, step, stepImageAttachments }, batch);
    return settleToolBatchFlow.kind === "next" ? { kind: "continue" } : settleToolBatchFlow;
  }

  /** The loop ran out of model requests: pause on open completion obligations, otherwise stop at the limit. */
  private finishAtRequestLimit(run: TurnRun): Promise<AgentRunResult> {
    const { memoryContext, state, turnId } = run;
    if (state.completionControl?.active) {
      const obligations = state.completionControl.active.obligations;
      const cause: NonNullable<AgentRunResult["pause"]>["cause"] = obligations.some(
        (item) => item.kind === "subagent_submission" || item.kind === "collect_subagents",
      )
        ? "subagent"
        : "completion_protocol";
      return this.finish(
        state,
        turnId,
        `Task paused at the model-request limit with ${obligations.length} unresolved completion obligation(s).`,
        "paused",
        this.modelRequestsUsed,
        memoryContext,
        undefined,
        undefined,
        undefined,
        {
          cause,
          resumable: true,
          requiredAction: obligations.map((item) => item.requiredAction).join(" "),
          obligations,
        },
      );
    }
    if (this.requestLimit === undefined) {
      throw new Error("Agent loop ended without completion or a configured model-request limit");
    }
    return this.finish(
      state,
      turnId,
      `Reached the hard limit of ${this.requestLimit} model requests before the task could be confirmed complete.`,
      "limit_reached",
      this.modelRequestsUsed,
      memoryContext,
    );
  }

  /** Close a turn that threw: report interruption, quarantine, capacity or failure and release the active turn. */
  private async failedRun(run: TurnRun, error: unknown): Promise<AgentRunResult> {
    const { memoryContext, options, state, turnId } = run;
    const interrupted = Boolean(options.signal?.aborted);
    const message = error instanceof Error ? error.message : String(error);
    const protocolFailure = !interrupted && error instanceof ToolProtocolExhausted ? error : undefined;
    const controlFailure =
      protocolFailure?.failure ?? (!interrupted ? contextCapacityFailure(error, state) : undefined);
    const capacityExhausted = !interrupted && isContextCapacityError(error);
    const result: AgentRunResult = {
      text: interrupted
        ? "The task was interrupted by the user."
        : error instanceof CommandEnvironmentQuarantined
          ? `Task paused: the command environment is quarantined. History and pending work are preserved; repair and verify cleanup before resuming. ${message}`
          : capacityExhausted
            ? "Context paused: the required request exceeds the model capacity. History and pending work are preserved; reduce required input or use a supported larger window before resuming."
            : `Agent run failed: ${message}`,
      reason: interrupted
        ? "interrupted"
        : capacityExhausted || error instanceof TaskBudgetExceeded
          ? "limit_reached"
          : "failed",
      steps:
        error instanceof TaskBudgetExceeded || error instanceof CommandEnvironmentQuarantined
          ? this.modelRequestsUsed
          : (protocolFailure?.steps ?? 0),
      threadId: state.threadId,
      turnId,
      ...(controlFailure ? { failure: controlFailure } : {}),
    };
    if (state.activeTurnId === turnId) {
      try {
        return await this.finish(
          state,
          turnId,
          result.text,
          result.reason,
          result.steps,
          memoryContext,
          undefined,
          undefined,
          result.failure,
        );
      } catch {
        state.activeTurnId = undefined;
        state.updatedAt = new Date().toISOString();
      }
    }
    return result;
  }
  private async prepareStepRequest(loop: StepLoop, step: number): Promise<PrepareStepRequestFlow> {
    return this.stepRequests.prepareStepRequest(loop, step);
  }
  private async settleToolBatch(
    ctx: ToolBatchOutcomeContext,
    updates: ToolBatchOutcomeState,
  ): Promise<SettleToolBatchFlow> {
    return this.turnCompletion.settleToolBatch(ctx, updates);
  }
  private async resolveTurnMode(run: TurnRun): Promise<{ kind: "next" } | TurnReturn> {
    return this.turnRouting.resolveTurnMode(run);
  }
  private async handleTextResponse(ctx: TextResponseContext): Promise<HandleTextResponseFlow> {
    return this.turnCompletion.handleTextResponse(ctx);
  }
  private async executeToolCalls(ctx: ToolCallsContext, updates: ToolCallsState): Promise<void> {
    return this.toolCalls.executeToolCalls(ctx, updates);
  }
  private async closeContextPhase(
    state: SessionState,
    turnId: string,
    kind: "verification" | "turn" | "investigation" = "verification",
  ): Promise<void> {
    return this.contextMaintenance.closeContextPhase(state, turnId, kind);
  }
  private async maintainContext(
    state: SessionState,
    turnId: string,
    images: ImageAttachment[],
    memoryContext: { userInput: string },
    options: AgentRunOptions,
    nextRequest: NormalRequestEnvelope,
    required: boolean,
    maxRequests?: number,
    forceRecovery = false,
  ): Promise<CompactionResult> {
    return this.contextMaintenance.maintainContext(
      state,
      turnId,
      images,
      memoryContext,
      options,
      nextRequest,
      required,
      maxRequests,
      forceRecovery,
    );
  }
  private async withModelRequestActivity<T>(text: string, request: () => Promise<T>): Promise<T> {
    return this.contextMaintenance.withModelRequestActivity(text, request);
  }
  private async reportModelUsage(
    turnId: string,
    purpose: ModelUsagePurpose,
    usage: ModelUsageRecord["usage"],
    request: { step?: number; attempt?: number; retry: boolean },
  ): Promise<void> {
    return this.contextMaintenance.reportModelUsage(turnId, purpose, usage, request);
  }
  private async reportAutoRouteUsage(turnId: string, attempts: readonly AutoRouteAttempt[]): Promise<void> {
    return this.contextMaintenance.reportAutoRouteUsage(turnId, attempts);
  }
  private async finish(
    state: SessionState,
    turnId: string,
    text: string,
    reason: AgentRunResult["reason"],
    steps: number,
    memoryContext: {
      userInput: string;
      mutations: readonly MemoryMutationRequest[];
      approvedPlanReview?: Readonly<PlanReviewState>;
    },
    planProposal?: PlanProposal,
    subagentTaskReport?: SubagentTaskReport,
    failure?: AgentRunResult["failure"],
    pause?: AgentRunResult["pause"],
  ): Promise<AgentRunResult> {
    return this.turnCompletion.finish(
      state,
      turnId,
      text,
      reason,
      steps,
      memoryContext,
      planProposal,
      subagentTaskReport,
      failure,
      pause,
    );
  }

  private stepRequestsInstance?: StepRequests;
  private get stepRequests(): StepRequests {
    return (this.stepRequestsInstance ??= new StepRequests(this.stepRequestsContext()));
  }
  private stepRequestsContext(): StepRequestsContext {
    const host = this;
    return {
      appendProgressHint: (...args) => host.appendProgressHint(...args),
      get dependencies() {
        return host.dependencies;
      },
      finish: (...args) => host.finish(...args),
      maintainContext: (...args) => host.maintainContext(...args),
      observeProviderContext: (...args) => host.observeProviderContext(...args),
      remainingRequestAllowance: (...args) => host.remainingRequestAllowance(...args),
      get requestLimit() {
        return host.requestLimit;
      },
    };
  }

  private turnRoutingInstance?: TurnRouting;
  private get turnRouting(): TurnRouting {
    return (this.turnRoutingInstance ??= new TurnRouting(this.turnRoutingContext()));
  }
  private turnRoutingContext(): TurnRoutingContext {
    const host = this;
    return {
      get dependencies() {
        return host.dependencies;
      },
      finish: (...args) => host.finish(...args),
      maintainContext: (...args) => host.maintainContext(...args),
      get modelRequestsUsed() {
        return host.modelRequestsUsed;
      },
      observeProviderContext: (...args) => host.observeProviderContext(...args),
      orchestrationToolsAvailable: (...args) => host.orchestrationToolsAvailable(...args),
      remainingRequestAllowance: (...args) => host.remainingRequestAllowance(...args),
      reportAutoRouteUsage: (...args) => host.reportAutoRouteUsage(...args),
      requestLimitReached: (...args) => host.requestLimitReached(...args),
      runProviderAttempt: (...args) => host.runProviderAttempt(...args),
      takeAndApplySteering: (...args) => host.takeAndApplySteering(...args),
      withModelRequestActivity: (...args) => host.withModelRequestActivity(...args),
    };
  }

  private toolCallsInstance?: ToolCalls;
  private get toolCalls(): ToolCalls {
    return (this.toolCallsInstance ??= new ToolCalls(this.toolCallsContext()));
  }
  private toolCallsContext(): ToolCallsHostContext {
    const host = this;
    return {
      get dependencies() {
        return host.dependencies;
      },
      takeAndApplySteering: (...args) => host.takeAndApplySteering(...args),
    };
  }

  private contextMaintenanceInstance?: ContextMaintenance;
  private get contextMaintenance(): ContextMaintenance {
    return (this.contextMaintenanceInstance ??= new ContextMaintenance(this.contextMaintenanceContext()));
  }
  private contextMaintenanceContext(): ContextMaintenanceContext {
    const host = this;
    return {
      get dependencies() {
        return host.dependencies;
      },
      get manualCompaction() {
        return host.manualCompaction;
      },
      set manualCompaction(value) {
        host.manualCompaction = value;
      },
      get requestPrefixTracker() {
        return host.requestPrefixTracker;
      },
      get retryContext() {
        return host.retryContext;
      },
      set retryContext(value) {
        host.retryContext = value;
      },
      takeAndApplySteering: (...args) => host.takeAndApplySteering(...args),
    };
  }

  private turnCompletionInstance?: TurnCompletion;
  private get turnCompletion(): TurnCompletion {
    return (this.turnCompletionInstance ??= new TurnCompletion(this.turnCompletionContext()));
  }
  private turnCompletionContext(): TurnCompletionContext {
    const host = this;
    return {
      closeContextPhase: (...args) => host.closeContextPhase(...args),
      decideLocally: (...args) => host.decideLocally(...args),
      get dependencies() {
        return host.dependencies;
      },
      recordLocalDecision: (...args) => host.recordLocalDecision(...args),
      takeAndApplySteering: (...args) => host.takeAndApplySteering(...args),
    };
  }
}

export type {
  AgentRunOptions,
  AgentRuntimeDependencies,
  AgentUserInput,
  ProviderContextSnapshot,
} from "./agent-types.js";
