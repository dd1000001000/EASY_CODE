import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { type CompactionResult } from "../context/compaction-transaction.js";
import type { NormalRequestEnvelope } from "../context/context-request.js";
import {
  estimateToolDefinitionsChars,
  type ContextPressureLevel,
  type ProviderRequestContextInspection,
} from "../context/manager.js";
import {
  expandedMemoryRecall,
  memoryQueries,
  memoryQueryKey,
  optionalMemoryTokenBudget,
  selectMemoryContext,
  visibleMemoryText,
} from "../context/memory-controller.js";
import { foldMemoryGate } from "../context/pressure-recovery.js";
import { reconciliationPending } from "../context/reconciliation.js";
import {
  type AgentRunResult,
  type AgentTool,
  type ChatMessage,
  type ImageAttachment,
  type LongTermMemory,
  type MemoryMutationRequest,
  type ModelUsagePurpose,
  type PlanProposal,
  type PlanReviewState,
  type SessionState,
  type SubagentTaskReport,
  type ToolDefinition,
} from "../core/types.js";
import {
  backgroundCommandFinalizationInstruction,
  CONTEXT_PRESSURE_SYSTEM_RESERVE_CHARS,
  LAYERED_EVIDENCE_SYSTEM_RESERVE_CHARS,
  pinCurrentState,
  progressRuntimeInstruction,
  progressScopeKey,
  progressWeakHintKind,
  renderStepMemory,
  threadTitleUnclaimed,
} from "./agent-support.js";
import type {
  AgentRunOptions,
  AgentRuntimeDependencies,
  PrepareStepRequestFlow,
  RuntimeLayeredContext,
  StepLoop,
  StepRequestDraft,
  StepRequestFit,
} from "./agent-types.js";
import { contextRetrievalQuery } from "./retrieval-query.js";

/** Live state and callbacks supplied by AgentRuntime. */
export interface StepRequestsContext {
  readonly appendProgressHint: (state: SessionState, turnId: string, payload: unknown) => Promise<void>;
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
  readonly remainingRequestAllowance: () => number | undefined;
  readonly requestLimit: number | undefined;
}

export class StepRequests {
  constructor(private readonly ctx: StepRequestsContext) {}

  /** Assemble this step's provider request: memory selection, layered retrieval, system prompt, enabled tools and capacity-checked messages. */
  async prepareStepRequest(loop: StepLoop, step: number): Promise<PrepareStepRequestFlow> {
    const { memoryContext, options, state, turnId, turnImages } = loop;
    const layeredContext = pinCurrentState(state, memoryContext.approvedPlanReview);
    const memoryLimits = this.ctx.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS;
    const queries = memoryQueries(state, memoryContext.userInput).slice(0, memoryLimits.memoryMaxQueries);
    const queryKey = `${memoryQueryKey(state, queries)}:${this.ctx.dependencies.memoryGeneration?.() ?? ""}`;
    const memorySearch = await this.searchStepMemories(loop, queries, queryKey);
    const draft = await this.openStepRequestDraft(loop, layeredContext, memoryLimits);

    // Reserve room with the complete ordinary capability surface before
    // selecting the retrieval boundary. The fixed evidence reserve affects
    // selection only; pressure below is measured from a concrete provider
    // request after retrieval, projection, and tool-schema serialization.
    const selectionSystemPrompt = await this.buildStepSystemPrompt(draft);
    const ordinaryToolDefinitions = draft.ordinaryEnabledTools.map((tool) => tool.definition);
    const reservedSystemPromptChars =
      selectionSystemPrompt.length +
      32 +
      estimateToolDefinitionsChars(ordinaryToolDefinitions) +
      (this.ctx.dependencies.getLayeredContext ? LAYERED_EVIDENCE_SYSTEM_RESERVE_CHARS : 0) +
      CONTEXT_PRESSURE_SYSTEM_RESERVE_CHARS;
    const retrieval = await this.retrieveStepContext(draft, queries, queryKey);
    const request = await this.fitStepRequest(
      draft,
      retrieval.contextChanged ? await this.buildStepSystemPrompt(draft) : selectionSystemPrompt,
      reservedSystemPromptChars,
      ordinaryToolDefinitions,
    );

    // One isolated transaction for token/character capacity and explicit requests.
    // Also enforce the aggregate tool-output budget below the pressure trigger.
    const compacted = await this.ctx.maintainContext(
      state,
      turnId,
      turnImages,
      memoryContext,
      options,
      {
        systemPrompt: request.systemPrompt,
        runtimeContext: draft.stepRuntimeContext,
        tools: ordinaryToolDefinitions,
        reservedTokens: Math.max(0, draft.optionalAllowance - draft.memorySelectionInfo.estimatedTokens),
      },
      request.contextUtilization >= memoryLimits.contextCompactionTriggerRatio,
      this.ctx.remainingRequestAllowance(),
    );
    if (compacted.paused)
      return {
        kind: "return",
        value: this.ctx.finish(
          state,
          turnId,
          `Context paused: ${compacted.paused.reason} Required ${compacted.paused.usage} / ${compacted.paused.capacity} ${compacted.paused.unit}. History, files and pending operations are preserved. Reduce required input or use a larger supported window to resume.`,
          "limit_reached",
          step,
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
    if (compacted.committed || compacted.requests > 0) return { kind: "retry" };
    const enabledTools = draft.ordinaryEnabledTools;
    this.dropDuplicateStepMemory(draft, request, enabledTools);
    await this.ctx.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      stepId: `step_${step}`,
      type: "context.memory.selected",
      phase: "completed",
      payload: {
        estimatedTokens: draft.memorySelectionInfo.estimatedTokens,
        dropped: draft.memorySelectionInfo.dropped,
        memorySearchCalls: memorySearch.calls,
        memorySearchDurationMs: memorySearch.durationMs,
        retrievalCacheHit: retrieval.cacheHit,
        optionalAllowance: draft.optionalAllowance,
        retrievalDurationMs: retrieval.durationMs,
        selectedOptionalCount: draft.selectedOptionalCount,
        tokenCapacityEnabled: options.maxContextTokens !== undefined,
      },
    });
    this.ctx.observeProviderContext({
      state,
      turnId,
      step,
      attempt: 1,
      purpose: "agent_step",
      messages: request.messages,
      tools: enabledTools.map((tool) => tool.definition),
      enforcedPressure: request.contextPressure,
      enforcedUtilization: request.contextUtilization,
      maxContextChars: options.maxContextChars,
      actualRequest: request.requestInspection,
    });
    this.ctx.dependencies.onStatus?.(
      `Step ${step}${this.ctx.requestLimit === undefined ? "" : `/${this.ctx.requestLimit}`}: requesting ${this.ctx.dependencies.provider.model}`,
    );
    return {
      kind: "next",
      outputs: {
        stepRuntimeContext: draft.stepRuntimeContext,
        selectedForStep: draft.selectedForStep,
        ordinaryToolDefinitions,
        enabledTools,
        messages: request.messages,
      },
    };
  }

  /** Search long-term memory unless the query set is unchanged since the last step or reconciliation is pending. */
  private async searchStepMemories(
    loop: StepLoop,
    queries: readonly string[],
    queryKey: string,
  ): Promise<{ calls: number; durationMs: number }> {
    const { memoryContext, retrieval, state } = loop;
    let calls = 0;
    const started = Date.now();
    if (queryKey !== retrieval.rememberedQueryKey && !reconciliationPending(state)) {
      const found: Readonly<LongTermMemory>[] = [];
      for (const [index, query] of queries.entries()) {
        calls += 1;
        found.push(
          ...(await this.ctx.dependencies.searchMemories(
            query,
            index === 0 || query === memoryContext.userInput ? undefined : { scope: "project" },
          )),
        );
      }
      // Keep each memory at its first rank, as the copy whose delivery counts as use when any query matched it confidently.
      const merged = new Map<string, Readonly<LongTermMemory>>();
      for (const memory of found) if (!merged.get(memory.id)?.countsAsUse) merged.set(memory.id, memory);
      retrieval.memories = [...merged.values()];
      retrieval.rememberedQueryKey = queryKey;
    }
    return { calls, durationMs: Date.now() - started };
  }

  /** Gather the step's fixed inputs (workspace summary, tools, runtime reminders) and its optional-memory allowance. */
  private async openStepRequestDraft(
    loop: StepLoop,
    layeredContext: RuntimeLayeredContext,
    memoryLimits: RuntimeLimits,
  ): Promise<StepRequestDraft> {
    const { agentIdentity, options, retrieval, state, toolGateway, turnId } = loop;
    const workspaceSummary = await this.ctx.dependencies.getWorkspaceSummary();
    const ordinaryEnabledTools = [...toolGateway.catalog.tools].filter(
      (tool) => tool.name !== "name_thread" || threadTitleUnclaimed(this.ctx.dependencies, state.threadId),
    );
    const currentProgressScope = progressScopeKey(state, turnId);
    const progressInstruction =
      agentIdentity.role === "main_agent" ? progressRuntimeInstruction(state, currentProgressScope) : "";
    const weakHintKind = progressInstruction ? progressWeakHintKind(state, currentProgressScope) : undefined;
    if (weakHintKind)
      await this.ctx.appendProgressHint(state, turnId, { scopeKey: currentProgressScope, kind: weakHintKind });
    const runtimeNextActions = [
      this.ctx.dependencies.hasOpenCommandHandles?.() ? backgroundCommandFinalizationInstruction() : "",
      progressInstruction,
    ].filter(Boolean);
    const phaseKey = JSON.stringify([
      state.compactedMessageCount,
      state.taskGraph?.tasks.filter((task) => task.status === "in_progress").map((task) => task.id),
    ]);
    const phaseChanged = retrieval.rememberedPhaseKey !== undefined && retrieval.rememberedPhaseKey !== phaseKey;
    retrieval.rememberedPhaseKey = phaseKey;
    let optionalAllowance = optionalMemoryTokenBudget(
      options.maxContextChars,
      options.maxContextTokens,
      memoryLimits,
      phaseChanged || expandedMemoryRecall(state),
    );
    if (state.pressureRecovery?.optionalMemorySuppressed) optionalAllowance = 0;
    if (reconciliationPending(state)) optionalAllowance = 0;
    return {
      loop,
      memoryLimits,
      workspaceSummary,
      runtimeNextActions,
      ordinaryEnabledTools,
      layeredContext,
      optionalAllowance,
      selectedForStep: undefined,
      selectedOptionalCount: 0,
      memorySelectionInfo: { estimatedTokens: 0, dropped: { duplicate: 0, stale: 0, budget: 0 } },
      stepRuntimeContext: "",
    };
  }

  /** Select optional memory for the draft's current context and allowance, render its runtime context and build the system prompt. */
  private async buildStepSystemPrompt(draft: StepRequestDraft): Promise<string> {
    const { layeredContext: context, loop, optionalAllowance } = draft;
    const { state } = loop;
    const selected = selectMemoryContext({
      state,
      memories: loop.retrieval.memories,
      evidence: context.evidence ?? [],
      tokenBudget: optionalAllowance,
      limits: draft.memoryLimits,
      presentText: [state.workingSummary, ...state.constraints],
    });
    draft.selectedForStep = selected;
    draft.selectedOptionalCount =
      selected.memories.length +
      selected.evidence.length +
      (context.evidence === undefined && optionalAllowance > 0 && context.retrievedThreadEvidence ? 1 : 0);
    draft.memorySelectionInfo = { estimatedTokens: selected.estimatedTokens, dropped: selected.dropped };
    draft.stepRuntimeContext = renderStepMemory(draft, selected);
    return this.ctx.dependencies.buildSystemPrompt({
      mode: loop.effectiveMode,
      workspaceSummary: "Current workspace and task state are provided in Runtime context after the conversation.",
      memories: [],
      toolNames: draft.ordinaryEnabledTools.map((tool) => tool.name),
    });
  }

  /** Layered retrieval up to the context boundary, cached by query and boundary; failures keep the pinned checkpoint. */
  private async retrieveStepContext(
    draft: StepRequestDraft,
    queries: readonly string[],
    queryKey: string,
  ): Promise<{ contextChanged: boolean; cacheHit: boolean; durationMs: number }> {
    const { memoryContext, retrieval, state } = draft.loop;
    const outcome = { contextChanged: false, cacheHit: false, durationMs: 0 };
    if (!this.ctx.dependencies.getLayeredContext || reconciliationPending(state)) return outcome;
    try {
      const boundary = this.ctx.dependencies.contextManager.retrievalBoundary(state);
      const cacheKey = `${queryKey}:${boundary}`;
      const retrievalStarted = Date.now();
      outcome.cacheHit = retrieval.retrievedQueryKey === cacheKey && retrieval.retrievedCache !== undefined;
      const derived =
        retrieval.retrievedQueryKey === cacheKey && retrieval.retrievedCache
          ? retrieval.retrievedCache
          : await this.ctx.dependencies.getLayeredContext({
              state,
              query: contextRetrievalQuery(state, memoryContext.userInput),
              queries,
              beforeMessageIndex: boundary,
            });
      retrieval.retrievedQueryKey = cacheKey;
      retrieval.retrievedCache = derived;
      outcome.durationMs = Date.now() - retrievalStarted;
      draft.layeredContext = pinCurrentState(state, memoryContext.approvedPlanReview, derived);
      outcome.contextChanged = true;
    } catch {
      // Continue with the pinned checkpoint. Retrieval diagnostics belong
      // in durable internals, not the user-visible activity stream.
    }
    return outcome;
  }

  /** Build and measure the request, gate optional memory on pressure, and drop optional memory entirely if it would force eviction. */
  private async fitStepRequest(
    draft: StepRequestDraft,
    systemPrompt: string,
    reservedSystemPromptChars: number,
    ordinaryToolDefinitions: ToolDefinition[],
  ): Promise<StepRequestFit> {
    const { options, state, turnId } = draft.loop;
    const measure = (prompt: string): StepRequestFit => {
      const messages = this.ctx.dependencies.contextManager.build({
        systemPrompt: prompt,
        runtimeContext: draft.stepRuntimeContext,
        state,
        maxContextChars: options.maxContextChars,
        reservedSystemPromptChars,
      });
      const requestInspection = this.ctx.dependencies.contextManager.inspectProviderRequest({
        state,
        maxContextChars: options.maxContextChars,
        messages,
        tools: ordinaryToolDefinitions,
      });
      return {
        systemPrompt: prompt,
        messages,
        requestInspection,
        contextPressure: requestInspection.pressure,
        contextUtilization: requestInspection.utilization,
      };
    };
    const fit = measure(systemPrompt);
    const setMemoryGate = async (suppressed: boolean) => {
      if (Boolean(state.pressureRecovery?.optionalMemorySuppressed) === suppressed) return;
      const payload = { suppressed };
      await this.ctx.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "context.memory.gated",
        phase: "completed",
        payload,
      });
      foldMemoryGate(state, payload);
    };
    if (fit.contextUtilization >= draft.memoryLimits.contextReferenceTriggerRatio) await setMemoryGate(true);
    else if (fit.contextUtilization <= draft.memoryLimits.contextMemoryResumeRatio) await setMemoryGate(false);

    // Optional recall must not force eviction of the live working chain.
    // First remove optional memory as whole records, then reassess pressure.
    if (draft.selectedOptionalCount > 0 && fit.contextPressure !== "normal") {
      draft.optionalAllowance = 0;
      return measure(await this.buildStepSystemPrompt(draft));
    }
    return fit;
  }

  /**
   * Remove only duplicates backed by the FINAL visible message set. Keep all other messages byte-identical: no
   * re-selection can evict their proof. The enforced pressure stays the one measured before this reduction.
   */
  private dropDuplicateStepMemory(draft: StepRequestDraft, fit: StepRequestFit, enabledTools: readonly AgentTool[]) {
    const { options, state } = draft.loop;
    const selectedForStep = draft.selectedForStep;
    if (!selectedForStep || draft.selectedOptionalCount === 0) return;
    const stepRuntimeContext = draft.stepRuntimeContext;
    const subset = selectMemoryContext({
      state,
      memories: selectedForStep.memories,
      evidence: selectedForStep.evidence,
      tokenBudget: draft.optionalAllowance,
      limits: draft.memoryLimits,
      presentText: [
        state.workingSummary,
        ...state.constraints,
        ...visibleMemoryText(fit.messages.filter((message) => message.content !== stepRuntimeContext)),
      ],
    });
    const reducedContext = renderStepMemory(draft, subset);
    if (reducedContext.length > stepRuntimeContext.length) return;
    fit.messages = fit.messages.map((message) =>
      message.role === "user" && message.content === stepRuntimeContext
        ? { ...message, content: reducedContext }
        : message,
    );
    draft.stepRuntimeContext = reducedContext;
    draft.memorySelectionInfo = {
      estimatedTokens: subset.estimatedTokens,
      dropped: {
        duplicate: selectedForStep.dropped.duplicate + subset.dropped.duplicate,
        stale: selectedForStep.dropped.stale + subset.dropped.stale,
        budget: selectedForStep.dropped.budget + subset.dropped.budget,
      },
    };
    draft.selectedOptionalCount -=
      selectedForStep.memories.length +
      selectedForStep.evidence.length -
      subset.memories.length -
      subset.evidence.length;
    draft.selectedForStep = subset;
    fit.requestInspection = this.ctx.dependencies.contextManager.inspectProviderRequest({
      state,
      maxContextChars: options.maxContextChars,
      messages: fit.messages,
      tools: enabledTools.map((tool) => tool.definition),
    });
  }
}
