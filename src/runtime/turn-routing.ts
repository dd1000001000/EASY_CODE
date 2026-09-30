import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { renderPinnedCurrentState, renderRetrievedContext } from "../context/artifact-index.js";
import { type CompactionResult } from "../context/compaction-transaction.js";
import type { NormalRequestEnvelope } from "../context/context-request.js";
import { type ContextPressureLevel, type ProviderRequestContextInspection } from "../context/manager.js";
import { optionalMemoryTokenBudget, selectMemoryContext } from "../context/memory-controller.js";
import { reconciliationPending } from "../context/reconciliation.js";
import { requestTokens } from "../context/token-budget.js";
import {
  type AgentRunResult,
  type ChatMessage,
  type ImageAttachment,
  type MemoryMutationRequest,
  type ModelUsagePurpose,
  type PlanProposal,
  type PlanReviewState,
  type SessionState,
  type SubagentTaskReport,
  type ToolDefinition,
  type TurnSteeringBatch,
  type TurnSteeringBoundary,
} from "../core/types.js";
import type { LocalDecisionResult, LocalDecisionTask } from "../local-decision/client.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { sha256 } from "../utils/hash.js";
import { createId } from "../utils/ids.js";
import {
  availableTools,
  backgroundCommandFinalizationInstruction,
  pinCurrentState,
  renderRuntimePrompt,
  runtimePromptText,
  threadTitleUnclaimed,
} from "./agent-support.js";
import type { AgentRunOptions, AgentRuntimeDependencies, TurnReturn, TurnRun } from "./agent-types.js";
import { autoRouteCapabilitySummary } from "./auto-route-capabilities.js";
import {
  AutoRouteRequestError,
  AutoRouteSelectionError,
  determineAutoRoute,
  projectAutoRouteContext,
  type AutoRouteAttempt,
  type AutoRouteContext,
  type AutoRouteDecision,
} from "./auto-router.js";
import { contextRetrievalQuery } from "./retrieval-query.js";

/** Live state and callbacks supplied by AgentRuntime. */
export interface TurnRoutingContext {
  readonly dependencies: AgentRuntimeDependencies;
  readonly finish: (
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
  ) => Promise<AgentRunResult>;
  readonly maintainContext: (
    state: SessionState,
    turnId: string,
    images: ImageAttachment[],
    memoryContext: { userInput: string },
    options: AgentRunOptions,
    nextRequest: NormalRequestEnvelope,
    required: boolean,
    maxRequests?: number,
    forceRecovery?: boolean,
  ) => Promise<CompactionResult>;
  readonly modelRequestsUsed: number;
  readonly observeProviderContext: (input: {
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
  }) => ProviderRequestContextInspection;
  readonly orchestrationToolsAvailable: (state: Readonly<SessionState>, options: AgentRunOptions) => boolean;
  readonly remainingRequestAllowance: () => number | undefined;
  readonly reportAutoRouteUsage: (turnId: string, attempts: readonly AutoRouteAttempt[]) => Promise<void>;
  readonly requestLimitReached: () => boolean;
  readonly runProviderAttempt: <T>(
    turnSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal | undefined) => Promise<T>,
  ) => Promise<{ kind: "completed"; value: T } | { kind: "steering_interrupted" }>;
  readonly takeAndApplySteering: (
    state: SessionState,
    turnId: string,
    boundary: TurnSteeringBoundary,
    turnImages: ImageAttachment[],
    seal?: boolean,
    memoryContext?: { userInput: string },
  ) => Promise<TurnSteeringBatch | undefined>;
  readonly withModelRequestActivity: <T>(text: string, request: () => Promise<T>) => Promise<T>;
}

export class TurnRouting {
  constructor(private readonly ctx: TurnRoutingContext) {}

  async decideLocally(
    state: Readonly<SessionState>,
    turnId: string,
    task: LocalDecisionTask,
    rawInput: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; result: LocalDecisionResult; appliedDecision: string } | undefined> {
    if (!this.ctx.dependencies.localDecision) return undefined;
    let result: LocalDecisionResult;
    const input = redactSensitiveInformation(rawInput);
    try {
      // The same sanitized text is sent to the worker and retained in its
      // project-local trace. The worker performs token-aware middle clipping.
      result = await this.ctx.dependencies.localDecision(task, input, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const id = createId("decision");
      await this.ctx.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "decision.local_fallback",
        phase: "failed",
        payload: { id, task, reason: reason.slice(0, 500) },
      });
      try {
        await this.ctx.dependencies.recordLocalDecisionFallback?.({
          id,
          threadId: state.threadId,
          turnId,
          task,
          input,
          reason: reason.slice(0, 500),
        });
      } catch (traceError) {
        const detail = traceError instanceof Error ? traceError.message : String(traceError);
        this.ctx.dependencies.onStatus?.(`Local Laya fallback trace was not written: ${detail.slice(0, 160)}`);
      }
      this.ctx.dependencies.onStatus?.(
        `Local Laya ${task} decision unavailable; using the existing workflow. ${reason.slice(0, 150)}`,
      );
      return undefined;
    }
    const id = createId("decision");
    const releaseThreshold = (this.ctx.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).layaDeliveryReleaseThreshold;
    const releaseConfidence = result.scores.RELEASE;
    const appliedDecision =
      task === "delivery" &&
      result.decision === "RELEASE" &&
      !(
        typeof releaseConfidence === "number" &&
        Number.isFinite(releaseConfidence) &&
        releaseConfidence >= releaseThreshold
      )
        ? "CHALLENGE"
        : result.decision;
    await this.ctx.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: task === "route" ? "decision.local_route" : "decision.local_delivery",
      phase: "completed",
      payload: {
        id,
        decision: result.decision,
        appliedDecision,
        ...(task === "delivery" ? { releaseThreshold } : {}),
        inputHash: sha256(result.input),
        inputTokens: result.inputTokens,
        truncated: result.truncated,
        scores: result.scores,
        modelSha256: result.modelSha256,
      },
    });
    if (task === "route") await this.recordLocalDecision(id, state, turnId, result, appliedDecision);
    return { id, result, appliedDecision };
  }

  async recordLocalDecision(
    id: string,
    state: Readonly<SessionState>,
    turnId: string,
    decision: LocalDecisionResult,
    appliedDecision: string,
    challenged?: boolean,
  ): Promise<void> {
    try {
      await this.ctx.dependencies.recordLocalDecision?.({
        id,
        threadId: state.threadId,
        turnId,
        decision,
        appliedDecision,
        ...(challenged !== undefined ? { challenged, challengeAlreadyUsed: challenged } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.ctx.dependencies.onStatus?.(
        `Local Laya decision was made, but its project trace was not written: ${reason.slice(0, 160)}`,
      );
    }
  }

  /** Resolve the effective mode for this turn: honor an explicit override, or run Auto routing (which may answer directly or pause the turn). */
  /** Settle the turn's mode: validate a review override, then let Auto mode choose Plan, Code or a direct answer. */
  async resolveTurnMode(run: TurnRun): Promise<{ kind: "next" } | TurnReturn> {
    const { agentIdentity, options, state, turnId } = run;
    if (options.modeOverride && state.mode !== "auto") {
      throw new Error("A review mode override is valid only while the persistent mode is Auto");
    }
    run.outstandingSubagentsAtRoute =
      agentIdentity.role === "main_agent" ? (this.ctx.dependencies.getOutstandingSubagents?.() ?? []) : [];
    if (run.outstandingSubagentsAtRoute.length > 0 && options.modeOverride === "plan")
      throw new Error("Outstanding child assignments must be collected before entering a Plan review override");
    if (state.mode !== "auto") return { kind: "next" };
    if (options.modeOverride) {
      await this.ctx.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "mode.review_override",
        phase: "completed",
        payload: {
          mode: options.modeOverride,
          reason:
            options.modeOverride === "plan"
              ? "The user requested a revision of the pending plan."
              : "Runtime resumed an explicitly selected Code operation.",
        },
      });
      return { kind: "next" };
    }
    const paused = await this.compactBeforeAutoRoute(run);
    if (paused) return paused;
    const fixedSelection = this.fixedAutoRoute(run);
    if (fixedSelection) {
      await this.commitAutoRoute(run, fixedSelection.mode, fixedSelection.reason);
      return { kind: "next" };
    }
    return this.chooseAutoRoute(run);
  }

  /** Persist Auto mode's choice and switch this turn (and the session) into it. */
  private async commitAutoRoute(run: TurnRun, mode: "plan" | "code", reason: string): Promise<void> {
    const { state, turnId } = run;
    await this.ctx.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "mode.auto_route",
      phase: "completed",
      payload: { mode, reason },
    });
    state.mode = mode;
    state.updatedAt = new Date().toISOString();
    run.effectiveMode = mode;
    try {
      this.ctx.dependencies.onModeSelected?.(mode);
    } catch {
      /* Presentation cannot undo a durable mode transition. */
    }
  }

  /** Compact before routing when history is already under pressure, sized for a Code request. */
  private async compactBeforeAutoRoute(run: TurnRun): Promise<TurnReturn | undefined> {
    const { agentIdentity, memoryContext, options, state, turnId, turnImages } = run;
    const routingPressure = this.ctx.dependencies.contextManager.inspect(state, options.maxContextChars).utilization;
    if (
      run.outstandingSubagentsAtRoute.length > 0 ||
      routingPressure < (this.ctx.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).contextCompactionTriggerRatio
    )
      return undefined;
    const nextTools = availableTools(
      this.ctx.dependencies.toolCatalog.tools,
      "code",
      agentIdentity.role,
      state.thinkingEffort,
      this.ctx.orchestrationToolsAvailable(state, options),
      this.ctx.dependencies.visionAvailable ?? true,
    );
    const nextRequest = {
      systemPrompt: await this.ctx.dependencies.buildSystemPrompt({
        mode: "code",
        workspaceSummary: "",
        memories: [],
        toolNames: nextTools.map((tool) => tool.name),
      }),
      runtimeContext: renderPinnedCurrentState(state),
      tools: nextTools.map((tool) => tool.definition),
      reservedTokens: optionalMemoryTokenBudget(
        options.maxContextChars,
        options.maxContextTokens,
        this.ctx.dependencies.limits,
        true,
      ),
    };
    const compacted = await this.ctx.maintainContext(
      state,
      turnId,
      turnImages,
      memoryContext,
      options,
      nextRequest,
      false,
      this.ctx.remainingRequestAllowance(),
    );
    if (compacted.paused)
      return {
        kind: "return",
        value: this.ctx.finish(
          state,
          turnId,
          `Context paused: ${compacted.paused.reason} Required ${compacted.paused.usage} / ${compacted.paused.capacity} ${compacted.paused.unit}. History and task state are preserved.`,
          "limit_reached",
          compacted.requests,
          memoryContext,
          undefined,
          undefined,
          {
            code: "context_capacity_exhausted",
            tool: "runtime",
            attempts: state.compactionControl?.transaction?.attempts ?? 0,
            recoverable: true,
          },
        ),
      };
    if (this.ctx.requestLimitReached())
      return {
        kind: "return",
        value: this.ctx.finish(
          state,
          turnId,
          "The shared model-request budget was exhausted during pre-route context compaction.",
          "limit_reached",
          this.ctx.modelRequestsUsed,
          memoryContext,
        ),
      };
    return undefined;
  }

  /** Conditions that force Code mode without asking the router. */
  private fixedAutoRoute(run: TurnRun): { mode: "code"; reason: string } | undefined {
    const backgroundCommandHandleOpenAtRoute = this.ctx.dependencies.hasOpenCommandHandles?.() ?? false;
    if (reconciliationPending(run.state))
      return {
        mode: "code",
        reason: "Reconcile the reset context, workspace and original pending operations before finishing.",
      };
    if (backgroundCommandHandleOpenAtRoute) return { mode: "code", reason: backgroundCommandFinalizationInstruction() };
    if (run.outstandingSubagentsAtRoute.length > 0)
      return {
        mode: "code",
        reason: "Collect every running or unobserved child assignment in code mode before planning or finishing.",
      };
    return undefined;
  }

  /** Ask the local decider and then the router model until a route survives steering. */
  private async chooseAutoRoute(run: TurnRun): Promise<{ kind: "next" } | TurnReturn> {
    const { memoryContext, state, turnId, turnImages } = run;
    for (;;) {
      await this.ctx.takeAndApplySteering(state, turnId, "before_model", turnImages, false, memoryContext);
      let routed;
      try {
        routed = await this.requestAutoRoute(run);
      } catch (error) {
        if (error instanceof AutoRouteSelectionError || error instanceof AutoRouteRequestError) {
          await this.ctx.reportAutoRouteUsage(turnId, error.attempts);
        }
        if (error instanceof AutoRouteRequestError) throw error.originalError;
        throw error;
      }
      if (routed.kind === "resolved") return { kind: "next" };
      if (routed.kind === "retry") continue;
      if (routed.kind === "steering_interrupted") {
        await this.ctx.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          type: "model.attempt.steering_interrupted",
          phase: "interrupted",
          payload: { purpose: "auto_route" },
        });
        await this.ctx.takeAndApplySteering(state, turnId, "after_model", turnImages, false, memoryContext);
        continue;
      }
      const decision = routed.value;
      await this.ctx.reportAutoRouteUsage(turnId, decision.attempts);
      if (decision.threadTitle) {
        try {
          if (this.ctx.dependencies.threadTitle?.claim(state.threadId, decision.threadTitle)) {
            this.ctx.dependencies.onThreadTitleClaimed?.(decision.threadTitle);
          }
        } catch {
          // Automatic naming is best-effort and must not add noise to the
          // user's response when the title store is unavailable.
        }
      }
      if (await this.ctx.takeAndApplySteering(state, turnId, "after_model", turnImages, false, memoryContext)) {
        continue;
      }
      if (decision.kind === "direct_response") {
        if (await this.ctx.takeAndApplySteering(state, turnId, "before_final", turnImages, true, memoryContext)) {
          continue;
        }
        return this.answerDirectly(run, decision);
      }
      await this.commitAutoRoute(run, decision.mode, decision.reason);
      return { kind: "next" };
    }
  }

  /**
   * One routing attempt. The local decider may settle Plan or Code on its own ("resolved"), or ask for a retry
   * because steering arrived; otherwise this is the router model's attempt.
   */
  private async requestAutoRoute(
    run: TurnRun,
  ): Promise<
    | { kind: "resolved" }
    | { kind: "retry" }
    | { kind: "completed"; value: AutoRouteDecision }
    | { kind: "steering_interrupted" }
  > {
    const { agentIdentity, memoryContext, options, state, turnHistoryStart, turnId, turnImages } = run;
    this.ctx.dependencies.onStatus?.("Auto mode is choosing how to handle this request...");
    const steeringText = state.messages
      .slice(turnHistoryStart + 1)
      .filter(
        (message): message is Extract<ChatMessage, { role: "user" }> =>
          message.role === "user" && message.content.startsWith(runtimePromptText("runtime/steering-prefix.md")),
      )
      .map((message) => message.content)
      .join("\n\n");
    const routingInput = [
      run.userInput,
      turnImages.length ? `[${turnImages.length} image attachment(s) are included.]` : "",
      steeringText,
    ]
      .filter(Boolean)
      .join("\n\n");
    const priorMessagesStart = Math.min(state.compactedMessageCount, turnHistoryStart);
    const autoRouteContext: AutoRouteContext = {
      workingSummary: state.workingSummary,
      priorMessages: state.messages.slice(priorMessagesStart, turnHistoryStart),
      threadNeedsTitle: threadTitleUnclaimed(this.ctx.dependencies, state.threadId),
    };
    let localDirect = false;
    if (agentIdentity.role === "main_agent" && turnImages.length === 0) {
      const prior = projectAutoRouteContext(autoRouteContext).content;
      const localInput = prior ? `${prior}\n\nCurrent request:\n${routingInput}` : routingInput;
      const local = await this.decideLocally(state, turnId, "route", localInput, options.signal);
      if (local) {
        if (await this.ctx.takeAndApplySteering(state, turnId, "after_model", turnImages, false, memoryContext))
          return { kind: "retry" };
        if (local.result.decision === "PLAN" || local.result.decision === "CODE") {
          await this.commitAutoRoute(
            run,
            local.result.decision.toLowerCase() as "plan" | "code",
            `Local Laya selected ${local.result.decision}.`,
          );
          return { kind: "resolved" };
        }
        localDirect = local.result.decision === "DIRECT";
      }
    }
    const controllerPolicy = await this.autoRouteControllerPolicy(
      run,
      priorMessagesStart + projectAutoRouteContext(autoRouteContext).priorMessageBoundary,
    );
    return this.ctx.runProviderAttempt(options.signal, (attemptSignal) =>
      this.ctx.withModelRequestActivity(`Waiting for ${this.ctx.dependencies.provider.model} response`, () =>
        determineAutoRoute(
          this.ctx.dependencies.provider,
          routingInput,
          attemptSignal,
          turnImages,
          state.thinkingEffort,
          autoRouteContext,
          controllerPolicy,
          (request, attempt) => {
            const inspection = this.ctx.dependencies.contextManager.inspectProviderRequest({
              state,
              maxContextChars: options.maxContextChars,
              messages: request.messages,
              ...(request.tools ? { tools: request.tools } : {}),
            });
            this.ctx.observeProviderContext({
              state,
              turnId,
              attempt,
              purpose: "auto_route",
              messages: request.messages,
              ...(request.tools ? { tools: request.tools } : {}),
              enforcedPressure: inspection.pressure,
              enforcedUtilization: inspection.utilization,
              maxContextChars: options.maxContextChars,
              actualRequest: inspection,
            });
          },
          this.ctx.dependencies.limits,
          localDirect,
        ),
      ),
    );
  }

  /**
   * The router's system prompt. Direct answers must inherit the same base security contract and layered
   * EASYCODE.md guidance as a normal agent request. Empty workspace/memory inputs prevent this controller from
   * answering questions that require repository or retrieval facts.
   */
  private async autoRouteControllerPolicy(run: TurnRun, autoRouteBoundary: number): Promise<string> {
    const { agentIdentity, memoryContext, options, state } = run;
    let routeLayeredContext = pinCurrentState(state, memoryContext.approvedPlanReview);
    if (this.ctx.dependencies.getLayeredContext) {
      try {
        const derived = await this.ctx.dependencies.getLayeredContext({
          state,
          query: contextRetrievalQuery(state, memoryContext.userInput),
          beforeMessageIndex: 0,
        });
        routeLayeredContext = pinCurrentState(state, memoryContext.approvedPlanReview, derived);
      } catch {
        // Layered retrieval is an internal optimization; the current
        // durable context remains authoritative when it is unavailable.
      }
    }
    const planRouteTools = availableTools(
      this.ctx.dependencies.toolCatalog.tools,
      "plan",
      agentIdentity.role,
      state.thinkingEffort,
      this.ctx.orchestrationToolsAvailable(state, options),
      this.ctx.dependencies.visionAvailable ?? true,
    );
    const codeRouteTools = availableTools(
      this.ctx.dependencies.toolCatalog.tools,
      "code",
      agentIdentity.role,
      state.thinkingEffort,
      this.ctx.orchestrationToolsAvailable(state, options),
      this.ctx.dependencies.visionAvailable ?? true,
    );
    const routeCapabilities = autoRouteCapabilitySummary({
      planTools: planRouteTools,
      codeTools: codeRouteTools,
      connectedMcpServers: this.ctx.dependencies.connectedMcpServers?.length ?? 0,
    });
    const buildControllerPolicy = async (context: typeof routeLayeredContext): Promise<string> => {
      const allowance = optionalMemoryTokenBudget(
        options.maxContextChars,
        options.maxContextTokens,
        this.ctx.dependencies.limits,
      );
      const selection = selectMemoryContext({
        state,
        memories: [],
        evidence: context.evidence ?? [],
        tokenBudget: allowance,
        limits: this.ctx.dependencies.limits,
        presentText: [state.workingSummary],
      });
      const evidenceText = context.evidence
        ? renderRetrievedContext(selection.evidence)
        : requestTokens([{ role: "user", content: context.retrievedThreadEvidence ?? "" }]) <= allowance
          ? context.retrievedThreadEvidence
          : undefined;
      const basePolicy = await this.ctx.dependencies.buildSystemPrompt({
        mode: "auto",
        workspaceSummary: "",
        memories: [],
        ...(context.workingCheckpoint ? { workingCheckpoint: context.workingCheckpoint } : {}),
        ...(evidenceText ? { retrievedThreadEvidence: evidenceText } : {}),
        toolNames: [],
      });
      return `${basePolicy}\n\n${renderRuntimePrompt("controllers/live-capability-status.md", {
        planCapabilities: routeCapabilities.planCapabilities,
        codeCapabilities: routeCapabilities.codeCapabilities,
        currentConditions: routeCapabilities.currentConditions,
      })}`;
    };
    let controllerPolicy = await buildControllerPolicy(routeLayeredContext);
    if (this.ctx.dependencies.getLayeredContext) {
      try {
        const derived = await this.ctx.dependencies.getLayeredContext({
          state,
          query: contextRetrievalQuery(state, memoryContext.userInput),
          beforeMessageIndex: autoRouteBoundary,
        });
        routeLayeredContext = pinCurrentState(state, memoryContext.approvedPlanReview, derived);
        controllerPolicy = await buildControllerPolicy(routeLayeredContext);
      } catch {
        // Fall back to the pinned checkpoint without surfacing an
        // implementation detail in the conversation.
      }
    }
    return controllerPolicy;
  }

  /** Auto mode answered the request itself: record the answer and finish the turn without a step. */
  private async answerDirectly(
    run: TurnRun,
    decision: Extract<AutoRouteDecision, { kind: "direct_response" }>,
  ): Promise<TurnReturn> {
    const { memoryContext, state, turnId } = run;
    await this.ctx.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "mode.auto_direct_response",
      phase: "completed",
      payload: { attempts: decision.attempts.length },
    });
    const directAssistant: Extract<ChatMessage, { role: "assistant" }> = {
      role: "assistant",
      content: decision.content,
      phase: "final_answer",
      ...(decision.reasoningContent ? { reasoning_content: decision.reasoningContent } : {}),
    };
    state.messages.push(directAssistant);
    await this.ctx.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "message.assistant",
      phase: "completed",
      payload: directAssistant,
    });
    if (state.thinkingEffort !== "none" && decision.reasoningContent) {
      try {
        this.ctx.dependencies.onReasoning?.({
          type: "reasoning",
          text: decision.reasoningContent,
          threadId: state.threadId,
          turnId,
          step: 0,
          provider: this.ctx.dependencies.provider.name,
          model: this.ctx.dependencies.provider.model,
          thinkingEffort: state.thinkingEffort,
        });
      } catch {
        // Presentation is transient; the durable assistant remains authoritative.
      }
    }
    this.ctx.dependencies.onText?.(decision.content);
    return {
      kind: "return",
      value: this.ctx.finish(state, turnId, decision.content, "success", 0, memoryContext),
    };
  }
}
