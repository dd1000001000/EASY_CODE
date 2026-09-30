import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { renderPinnedCurrentState } from "../context/artifact-index.js";
import {
  completeExchange,
  foldCompactionControl,
  runCompactionTransaction,
  type CompactionResult,
} from "../context/compaction-transaction.js";
import type { NormalRequestEnvelope } from "../context/context-request.js";
import { type ContextPressureLevel, type ProviderRequestContextInspection } from "../context/manager.js";
import { runManualCompaction, type CompactionProgress } from "../context/manual-compaction.js";
import { RequestPrefixTracker } from "../context/request-prefix.js";
import {
  type ChatMessage,
  type ImageAttachment,
  type ModelUsagePurpose,
  type ModelUsageRecord,
  type SessionState,
  type ToolDefinition,
  type TurnSteeringBatch,
  type TurnSteeringBoundary,
} from "../core/types.js";
import { createId } from "../utils/ids.js";
import { redactedAuxiliaryToolCall } from "./agent-support.js";
import type { AgentRunOptions, AgentRuntimeDependencies } from "./agent-types.js";
import { type AutoRouteAttempt } from "./auto-router.js";

/** Live state and callbacks supplied by AgentRuntime. */
export interface ContextMaintenanceContext {
  readonly dependencies: AgentRuntimeDependencies;
  manualCompaction: boolean;
  readonly requestPrefixTracker: RequestPrefixTracker;
  retryContext: { state: SessionState; turnId: string } | undefined;
  readonly takeAndApplySteering: (
    state: SessionState,
    turnId: string,
    boundary: TurnSteeringBoundary,
    turnImages: ImageAttachment[],
    seal?: boolean,
    memoryContext?: { userInput: string },
  ) => Promise<TurnSteeringBatch | undefined>;
}

export class ContextMaintenance {
  constructor(private readonly ctx: ContextMaintenanceContext) {}

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
    this.ctx.manualCompaction = true;
    try {
      const ordinaryTools = this.ctx.dependencies.toolCatalog.tools;
      const systemPrompt = await this.ctx.dependencies.buildSystemPrompt({
        mode: state.mode,
        workspaceSummary: "Current workspace and task state are provided in Runtime context after the conversation.",
        memories: [],
        toolNames: ordinaryTools.map((tool) => tool.name),
      });
      const runtimeContext =
        "RUNTIME_CONTEXT_DATA (workspace/checkpoint data, not new user instructions):\n" +
        JSON.stringify({
          workspaceSummary: await this.ctx.dependencies.getWorkspaceSummary(),
          workingCheckpoint: renderPinnedCurrentState(state, undefined, true),
          memories: [],
          retrievedThreadEvidence: "",
        });
      let operationId = "manual_compaction";
      return await runManualCompaction({
        state,
        manager: this.ctx.dependencies.contextManager,
        operationId: options.operationId,
        startedAt: options.startedAt,
        maxContextChars: options.maxContextChars,
        signal: options.signal,
        nextRequest: { systemPrompt, runtimeContext, tools: ordinaryTools.map((tool) => tool.definition) },
        append: (event) => this.ctx.dependencies.appendEvent(event),
        onProgress: (progress) => {
          operationId = progress.operationId;
          this.ctx.retryContext = { state, turnId: operationId };
          options.onProgress?.(progress);
        },
        complete: async (messages, attempt) => {
          const response = await this.ctx.dependencies.provider.complete({
            messages,
            tools: [],
            signal: options.signal,
            thinkingEffort: "none",
            responseMode: "stream",
            outputReserveTokens: 4000,
          });
          await this.reportModelUsage(operationId, "context_compaction", response.usage, {
            attempt,
            retry: attempt > 1,
          });
          return response.message;
        },
      });
    } finally {
      this.ctx.manualCompaction = false;
      this.ctx.retryContext = undefined;
    }
  }

  observeProviderContext(input: {
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
    const measuredRequest =
      input.actualRequest ??
      this.ctx.dependencies.contextManager.inspectProviderRequest({
        state: input.state,
        maxContextChars: input.maxContextChars,
        messages: input.messages,
        ...(input.tools ? { tools: input.tools } : {}),
      });
    const actualRequest = {
      ...measuredRequest,
      ...this.ctx.requestPrefixTracker.observe(
        `${input.state.threadId}:${this.ctx.dependencies.provider.name}:${this.ctx.dependencies.provider.model}:${input.state.thinkingEffort}`,
        input.messages,
        input.tools,
      ),
    };
    const identity = this.ctx.dependencies.agentIdentity ?? { role: "main_agent" as const };
    try {
      this.ctx.dependencies.onProviderContext?.({
        threadId: input.state.threadId,
        turnId: input.turnId,
        actor: identity.role,
        purpose: input.purpose,
        provider: this.ctx.dependencies.provider.name,
        model: this.ctx.dependencies.provider.model,
        timestamp: new Date().toISOString(),
        ...(input.step === undefined ? {} : { step: input.step }),
        attempt: input.attempt,
        enforcedPressure: input.enforcedPressure,
        enforcedUtilization: input.enforcedUtilization,
        actualRequest,
      });
    } catch {
      // Context telemetry is observational and must never block model work.
    }
    return actualRequest;
  }

  async closeContextPhase(
    state: SessionState,
    turnId: string,
    kind: "verification" | "turn" | "investigation" = "verification",
  ): Promise<void> {
    if (!state.messages.length || !completeExchange(state.messages)) return;
    if (kind === "turn" && state.compactionControl?.lastVerificationTurnId === turnId) return;
    const payload = { end: state.messages.length, kind, turnId };
    await this.ctx.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "context.phase.closed",
      phase: "completed",
      payload,
    });
    foldCompactionControl(state, "context.phase.closed", payload);
  }

  async maintainContext(
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
    let progress: CompactionProgress | undefined;
    const report = () => {
      if (!progress) return;
      try {
        this.ctx.dependencies.onCompactionProgress?.({ ...progress });
      } catch {
        /* Presentation must not interrupt context maintenance. */
      }
    };
    const start = async () => {
      if (progress) return;
      progress = {
        operationId: createId("auto_compact"),
        mode: "automatic",
        turnId,
        startedAt: Date.now(),
        phase: "summarizing",
        beforeChars: 0,
      };
      await this.ctx.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "context.auto.started",
        payload: progress,
      });
      report();
    };
    const finish = async (
      phase: "completed" | "failed" | "cancelled",
      reason?: string,
      outcome?: CompactionProgress["outcome"],
    ) => {
      if (!progress) return;
      progress = {
        ...progress,
        phase,
        completedAt: Date.now(),
        ...(reason ? { reason } : {}),
        ...(outcome ? { outcome } : {}),
      };
      await this.ctx.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "context.auto.finished",
        payload: progress,
      });
      report();
    };
    try {
      const result = await runCompactionTransaction({
        state,
        manager: this.ctx.dependencies.contextManager,
        turnId,
        limits: this.ctx.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS,
        signal: options.signal,
        skipSummary: forceRecovery,
        forceRecovery,
        retainRecentExchanges: (this.ctx.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).compactionRetainRecentExchanges,
        maxContextChars: options.maxContextChars,
        required,
        maxRequests,
        nextRequest,
        append: async (event) => {
          // Ordinary capacity checks stay silent; announce only actual maintenance.
          if (
            [
              "context.compaction.started",
              "context.compaction.attempt",
              "context.compaction.prepared",
              "context.compaction.committed",
              "context.compaction.fallback",
              "context.history.evicted",
              "context.server_reset",
            ].includes(event.type)
          )
            await start();
          return this.ctx.dependencies.appendEvent(event);
        },
        complete: async (messages, attempt, tools) => {
          const inspection = this.ctx.dependencies.contextManager.inspectProviderRequest({
            state,
            maxContextChars: options.maxContextChars,
            messages,
            tools,
          });
          this.observeProviderContext({
            state,
            turnId,
            purpose: "context_compaction",
            attempt,
            messages,
            tools,
            enforcedPressure: required ? "require" : "suggest",
            enforcedUtilization: inspection.utilization,
            maxContextChars: options.maxContextChars,
            actualRequest: inspection,
          });
          // Automatic maintenance is not interruptible by user steering: the
          // hosts reject adjustments while it runs, and any entry queued just
          // before it started is applied after the summary via afterComplete.
          const attempted = {
            value: await this.ctx.dependencies.provider.complete({
              messages,
              tools,
              signal: options.signal,
              thinkingEffort: "none",
              responseMode: "stream",
              currentTurnImageIds: images.map((image) => image.id),
            }),
          };
          await this.reportModelUsage(turnId, "context_compaction", attempted.value.usage, {
            attempt,
            retry: attempt > 1,
          });
          await this.ctx.dependencies.appendEvent({
            threadId: state.threadId,
            turnId,
            type: "context.summary.response",
            payload: {
              finishReason: attempted.value.finishReason ?? null,
              usage: attempted.value.usage,
              contentChars: attempted.value.message.content?.length ?? 0,
              thinkingChars: attempted.value.message.reasoning_content?.length ?? 0,
              toolCalls: attempted.value.message.tool_calls?.length ?? 0,
            },
          });
          return {
            ...attempted.value.message,
            tool_calls: attempted.value.message.tool_calls?.map(redactedAuxiliaryToolCall),
          };
        },
        afterComplete: async () => {
          await this.ctx.takeAndApplySteering(state, turnId, "after_model", images, false, memoryContext);
        },
      });
      // A started transaction can end without changing history (interrupted,
      // abandoned or rejected); only a committed boundary counts as compaction.
      if (result.paused) await finish("failed", result.paused.reason);
      else if (result.committed) await finish("completed", undefined, "compacted");
      else await finish("completed", undefined, "unchanged");
      return result;
    } catch (error) {
      await finish(
        options.signal?.aborted ? "cancelled" : "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async withModelRequestActivity<T>(text: string, request: () => Promise<T>): Promise<T> {
    let activityToken: unknown;
    let activityStarted = false;
    try {
      if (this.ctx.dependencies.onModelRequestStart) {
        activityToken = this.ctx.dependencies.onModelRequestStart(text);
        activityStarted = true;
      }
    } catch {
      // Transient terminal presentation must never prevent an API request.
    }
    try {
      return await request();
    } finally {
      try {
        if (activityStarted) {
          this.ctx.dependencies.onModelRequestEnd?.(activityToken);
        }
      } catch {
        // A broken presentation hook must not replace a model result or error.
      }
    }
  }

  async reportModelUsage(
    turnId: string,
    purpose: ModelUsagePurpose,
    usage: ModelUsageRecord["usage"],
    request: { step?: number; attempt?: number; retry: boolean },
  ): Promise<void> {
    if (!this.ctx.dependencies.onModelUsage) return;
    const identity = this.ctx.dependencies.agentIdentity ?? { role: "main_agent" as const };
    const record: ModelUsageRecord = {
      actor: identity.role,
      purpose,
      provider: this.ctx.dependencies.provider.name,
      model: this.ctx.dependencies.provider.model,
      turnId,
      retry: request.retry,
      ...(request.step !== undefined ? { step: request.step } : {}),
      ...(request.attempt !== undefined ? { attempt: request.attempt } : {}),
      ...(usage ? { usage: { ...usage } } : {}),
      ...(identity.role === "subagent"
        ? {
            sourceAgentId: identity.agentId,
            sourceTaskId: identity.assignedTaskId,
          }
        : {}),
    };
    try {
      await this.ctx.dependencies.onModelUsage(record);
    } catch {
      // Usage accounting is internal telemetry and must not alter or annotate
      // the user-visible result.
    }
  }

  async reportAutoRouteUsage(turnId: string, attempts: readonly AutoRouteAttempt[]): Promise<void> {
    for (const attempt of attempts) {
      await this.reportModelUsage(turnId, "auto_route", attempt.usage, {
        attempt: attempt.attempt,
        retry: attempt.attempt > 1,
      });
    }
  }
}
