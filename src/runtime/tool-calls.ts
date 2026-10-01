import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { estimateToolDefinitionsChars } from "../context/manager.js";
import { foldPendingOperations, pendingCommandObservation } from "../context/pending-operations.js";
import { recallThreadContext } from "../context/recall.js";
import { reconciliationGate, reconciliationObservation } from "../context/reconciliation.js";
import {
  MAX_MEMORY_MUTATIONS_PER_TURN,
  type AgentTool,
  type ChatMessage,
  type CommandAuditEntry,
  type FunctionToolCall,
  type ImageAttachment,
  type SessionState,
  type ToolExecutionResult,
  type ToolName,
  type TurnSteeringBatch,
  type TurnSteeringBoundary,
} from "../core/types.js";
import { MAX_IMAGES_PER_MODEL_REQUEST, validateImageAttachmentCollection } from "../images/image-store.js";
import { assertThreadImageNumberAvailable } from "../images/labels.js";
import { validateProviderImageAttachments } from "../models/catalog.js";
import { createPlanReviewState } from "../plans/plan.js";
import { foldProgressObservation } from "../progress/guard.js";
import { observeToolResult } from "../progress/observation.js";
import {
  activeTask,
  cloneTaskGraph,
  revisionTouchesActiveMainTask,
  taskGraphOperationSchema,
  type TaskGraphTransitionOperation,
} from "../tasks/task-graph.js";
import { toolApprovalIdentity } from "../tools/approval.js";
import { toolFailure } from "../tools/base.js";
import { projectToolResult } from "../tools/output-projection.js";
import { createId } from "../utils/ids.js";
import {
  backgroundCommandFinalizationInstruction,
  commandVerificationClassification,
  progressResponseOrdinal,
  progressScopeKey,
  resultForModel,
  threadTitleUnclaimed,
} from "./agent-support.js";
import type { AgentRuntimeDependencies, ToolCallsContext, ToolCallsState } from "./agent-types.js";
import {
  gateToolCall,
  recoverToolFailure,
  subagentLifecycleError,
  validateTaskGraphEffect,
  type ToolEffects,
  type ToolInvocationOutcome,
} from "./tool-call-effects.js";
import { safeToolDisplayDetails, toolDisplayDetails } from "./tool-display-details.js";

/** Live state and callbacks supplied by AgentRuntime. */
export interface ToolCallsHostContext {
  readonly dependencies: AgentRuntimeDependencies;
  readonly takeAndApplySteering: (
    state: SessionState,
    turnId: string,
    boundary: TurnSteeringBoundary,
    turnImages: ImageAttachment[],
    seal?: boolean,
    memoryContext?: { userInput: string },
  ) => Promise<TurnSteeringBatch | undefined>;
}

export class ToolCalls {
  constructor(private readonly ctx: ToolCallsHostContext) {}

  /** Execute one model response's tool calls in order: gating, execution, and applying task-graph, subagent and plan effects. */
  async executeToolCalls(ctx: ToolCallsContext, updates: ToolCallsState): Promise<void> {
    const { agentIdentity, calls, state, turnId } = ctx;
    for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
      if (
        agentIdentity.role === "main_agent" &&
        (await this.ctx.dependencies.hasPendingSteering?.({
          threadId: state.threadId,
          turnId,
        }))
      ) {
        await this.skipCallsForSteering(ctx, calls.slice(callIndex));
        updates.steeringAppliedBetweenTools = true;
        break;
      }
      await this.executeToolCall(ctx, updates, calls[callIndex]!);
    }
  }

  /** Close the assistant's complete tool-call protocol before the durable steering application event adds a new user message. */
  private async skipCallsForSteering(ctx: ToolCallsContext, skippedCalls: FunctionToolCall[]): Promise<void> {
    const { memoryContext, options, progressResponseBase, state, step, turnId, turnImages } = ctx;
    for (const skipped of skippedCalls) {
      await this.ctx.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        stepId: `step_${step}`,
        type: "tool.call",
        phase: "requested",
        payload: skipped,
      });
      const skippedResult: ToolExecutionResult = {
        ok: false,
        summary: "Tool call skipped because newer user steering arrived.",
        error: "superseded_by_user_steering",
      };
      const skippedMessage: ChatMessage = {
        role: "tool",
        tool_call_id: skipped.id,
        name: skipped.function.name,
        content: resultForModel(skippedResult, options.maxOutputChars),
      };
      const skippedEventId = createId("event");
      const skippedObservation = observeToolResult({
        sourceEventId: skippedEventId,
        sourceCallId: skipped.id,
        scopeKey: progressScopeKey(state, turnId),
        responseOrdinal: progressResponseOrdinal(progressResponseBase, step),
        tool: skipped.function.name,
        result: skippedResult,
        verificationIntent: false,
      });
      await this.ctx.dependencies.appendEvent({
        eventId: skippedEventId,
        threadId: state.threadId,
        turnId,
        stepId: `step_${step}`,
        type: "tool.result",
        phase: "interrupted",
        payload: {
          callId: skipped.id,
          tool: skipped.function.name,
          message: skippedMessage,
          progressObservation: skippedObservation,
        },
      });
      state.progressGuard = foldProgressObservation(state.progressGuard, skippedObservation).state;
      state.messages.push(skippedMessage);
    }
    await this.ctx.takeAndApplySteering(state, turnId, "between_tools", turnImages, false, memoryContext);
  }

  /** Run one tool call through gating, invocation, effect validation and recovery, then commit its result. */
  private async executeToolCall(ctx: ToolCallsContext, updates: ToolCallsState, call: FunctionToolCall): Promise<void> {
    const { state, step, toolGateway, turnId } = ctx;
    const toolName = call.function.name as ToolName;
    // The gateway is a run-level snapshot, while this one-shot tool can be
    // withdrawn between requests; recheck its availability at execution.
    const tool =
      toolName === "name_thread" && !threadTitleUnclaimed(this.ctx.dependencies, state.threadId)
        ? undefined
        : toolGateway.get(toolName);
    // Verification relies on recorded changes and actual command results;
    // no whole-repository test baseline is captured or replayed.
    const taskIdAtCall = activeTask(state.taskGraph)?.id;

    await this.ctx.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      stepId: `step_${step}`,
      type: "tool.call",
      phase: "requested",
      payload: call,
    });

    const invocation =
      gateToolCall(
        {
          environmentFault: updates.environmentFault,
          proposePlanBatched: ctx.proposePlanBatched,
          submitTaskResultBatched: ctx.submitTaskResultBatched,
        },
        call,
        tool,
      ) ?? (await this.invokeTool(ctx, updates, call, tool!));
    const effects = this.validateToolEffects(ctx, updates, toolName, invocation);
    const recovered = recoverToolFailure(ctx.toolRecovery, toolName, effects.result);
    if (recovered.environmentFault !== undefined) updates.environmentFault = recovered.environmentFault;
    if (recovered.exhaustion) updates.requiredProtocolExhaustion = recovered.exhaustion;
    let result = recovered.result;
    if (this.ctx.dependencies.captureToolEvidence && toolName !== "write_memory") {
      try {
        result = {
          ...result,
          evidenceId: this.ctx.dependencies.captureToolEvidence(state, call.id, toolName, result),
        };
      } catch {
        // The bounded journal result remains authoritative. Evidence
        // archival is internal bookkeeping and should fail silently.
      }
    }
    await this.commitToolResult(ctx, updates, call, tool, taskIdAtCall, { ...invocation, ...effects, result });
  }

  /** Prepare and invoke an exposed tool, turning any preparation or execution error into a failed result. */
  private async invokeTool(
    ctx: ToolCallsContext,
    updates: ToolCallsState,
    call: FunctionToolCall,
    tool: AgentTool,
  ): Promise<ToolInvocationOutcome> {
    const { commandRetries, state, toolGateway } = ctx;
    const toolName = call.function.name as ToolName;
    let displayName = toolName;
    let taskGraphOperation: TaskGraphTransitionOperation | undefined;
    try {
      const preparedInvocation = toolGateway.prepare(toolName, call.function.arguments);
      if (!preparedInvocation) throw new Error(`Tool ${toolName} is not available`);
      const rawInput = preparedInvocation.input;
      displayName = toolApprovalIdentity(
        preparedInvocation.tool,
        rawInput,
        preparedInvocation.binding,
        state.workspaceRoot,
      ).label;
      let input: unknown = rawInput;
      if (toolName === "manage_tasks") {
        const parsedOperation = taskGraphOperationSchema.parse(rawInput);
        if (
          (parsedOperation.action === "complete" ||
            parsedOperation.action === "block" ||
            revisionTouchesActiveMainTask(state.taskGraph, parsedOperation)) &&
          this.ctx.dependencies.hasOpenCommandHandles?.()
        ) {
          updates.finishRejectedReason = backgroundCommandFinalizationInstruction();
          throw new Error(updates.finishRejectedReason);
        }
        if (
          parsedOperation.action === "create" &&
          (this.ctx.dependencies.getOutstandingSubagents?.() ?? []).some(
            (agent) => agent.assignmentKind === "standalone",
          )
        ) {
          throw new Error("Collect every standalone child result before creating a task DAG.");
        }
        input = parsedOperation;
        if (parsedOperation.action !== "list") {
          taskGraphOperation = parsedOperation;
        }
      }
      if (toolName === "submit_task_result" && this.ctx.dependencies.hasOpenCommandHandles?.()) {
        updates.finishRejectedReason = backgroundCommandFinalizationInstruction();
        throw new Error(updates.finishRejectedReason);
      }
      this.ctx.dependencies.onStatus?.(`Tool: ${displayName}`);
      const toolContext = this.buildToolContext(ctx, call, displayName);
      const waitAttempt =
        tool.name === "poll_command" ? this.ctx.dependencies.steeringNotifier?.openAttempt() : undefined;
      let result: ToolExecutionResult;
      try {
        result =
          reconciliationGate(state, tool.name, input) ??
          commandRetries.before(tool.name, input) ??
          (await toolGateway.invoke(
            { ...preparedInvocation, input },
            { ...toolContext, waitSignal: waitAttempt?.signal },
            (name, execute) => this.withToolExecutionActivity(name, execute),
          ));
        result = commandRetries.after(tool.name, input, result);
      } finally {
        waitAttempt?.dispose();
      }
      return { result, displayName, taskGraphOperation, preparedSubagentLifecycle: result.subagentLifecycle };
    } catch (error) {
      return { result: toolFailure(error, `Tool ${displayName} failed.`), displayName, taskGraphOperation };
    }
  }

  /** The Runtime services and budgets a tool invocation receives. */
  private buildToolContext(ctx: ToolCallsContext, call: FunctionToolCall, displayName: string) {
    const {
      agentIdentity,
      effectiveMode,
      imageNumbering,
      options,
      ordinaryToolDefinitions,
      projectionHistory,
      state,
      turnId,
      turnImages,
    } = ctx;
    const toolName = call.function.name as ToolName;
    return {
      limits: this.ctx.dependencies.limits,
      resultTokenBudget: this.ctx.dependencies.contextManager.tokenCapacity
        ? Math.max(
            0,
            this.ctx.dependencies.contextManager.tokenCapacity.inputCapacity -
              this.ctx.dependencies.contextManager.estimateRequestTokens(projectionHistory, ordinaryToolDefinitions) -
              (this.ctx.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).contextSafetyReserveTokens,
          )
        : undefined,
      resultCharBudget: this.ctx.dependencies.contextManager.tokenCapacity
        ? undefined
        : Math.max(
            0,
            this.ctx.dependencies.contextManager.activeCharBudget(options.maxContextChars) -
              JSON.stringify(projectionHistory).length -
              estimateToolDefinitionsChars(ordinaryToolDefinitions) -
              (this.ctx.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).contextSafetyReserveTokens * 2,
          ),
      orchestrationEnabled: options.orchestrationEnabled,
      isOrchestrationEnabled: options.isOrchestrationEnabled,
      workspaceRoot: state.workspaceRoot,
      ...(toolName === "run_command" || toolName === "start_command"
        ? { validationPriorChanges: state.changes.map((change) => ({ ...change })) }
        : {}),
      mode: effectiveMode,
      selectedMode: state.mode,
      threadId: state.threadId,
      turnId,
      approvalPolicy: options.approvalPolicy,
      commandExecutionMode: options.commandExecutionMode,
      isUnrestrictedHostAccessActive: options.isUnrestrictedHostAccessActive,
      unrestrictedHostAccessEpoch: options.unrestrictedHostAccessEpoch,
      requestApproval: this.ctx.dependencies.requestApproval,
      signal: options.signal,
      reportProgress: (update: { message?: string; progress?: number; total?: number }) => {
        const detail = update.message?.replace(/[\u0000-\u001F\u007F]/gu, " ").slice(0, 240);
        const amount =
          typeof update.progress === "number"
            ? `${update.progress}${typeof update.total === "number" ? `/${update.total}` : ""}`
            : undefined;
        this.ctx.dependencies.onStatus?.([`Tool: ${displayName}`, amount, detail].filter(Boolean).join(" · "));
      },
      commandTimeoutMs: options.commandTimeoutMs,
      maxOutputChars: options.maxOutputChars,
      agentRole: agentIdentity.role,
      ...(agentIdentity.role === "subagent"
        ? {
            agentId: agentIdentity.agentId,
            assignedTaskId: agentIdentity.assignedTaskId,
          }
        : {}),
      thinkingEffort: state.thinkingEffort,
      provider: state.provider,
      model: state.model,
      toolCallId: call.id,
      searchProjectMemory: this.ctx.dependencies.searchMemories,
      recordMemoryRecall: (memoryIds: readonly string[]) =>
        this.ctx.dependencies.recordMemoryRecall?.(state.threadId, turnId, memoryIds),
      recallContext: async (input: { evidenceId: string; offset: number; limit: number }) =>
        recallThreadContext(
          state,
          input,
          this.ctx.dependencies.readToolEvidence
            ? (id, offset, limit) => this.ctx.dependencies.readToolEvidence!(state, id, offset, limit)
            : undefined,
          this.ctx.dependencies.limits,
        ),
      ...(this.ctx.dependencies.getLayeredContext
        ? {
            searchHistory: async (query: string, limit: number) => {
              const history = await this.ctx.dependencies.getLayeredContext!({
                state,
                query,
                queries: [query],
                beforeMessageIndex: state.messages.length,
              });
              return (history.evidence ?? []).slice(0, limit).map((hit) => ({
                id: hit.id,
                title: hit.title.slice(0, 160),
                preview: hit.content.slice(0, 400),
                historical: true as const,
              }));
            },
          }
        : {}),
      ...(state.taskGraph ? { taskGraph: cloneTaskGraph(state.taskGraph) } : {}),
      recordCommand: (entry: CommandAuditEntry) => {
        const taskId = state.taskGraph ? activeTask(state.taskGraph)?.id : undefined;
        const scopedEntry: CommandAuditEntry = {
          ...entry,
          sourceAgentRole: agentIdentity.role,
          sourceScopeKey: state.taskGraph
            ? `${state.threadId}/${state.taskGraph.id}/${taskId ?? "none"}`
            : `${state.threadId}/intent:${state.contextIntentLedger?.latestRequest.sourceMessageIndex ?? turnId}`,
          ...(agentIdentity.role === "subagent" ? { sourceAgentId: agentIdentity.agentId } : {}),
          ...(taskId ? { sourceTaskId: taskId } : {}),
        };
        state.commands.push(scopedEntry);
        this.ctx.dependencies.recordCommand?.(turnId, scopedEntry);
      },
      ...(this.ctx.dependencies.attachImage
        ? {
            attachImage: async (image: { absolutePath: string; sourceName?: string }) => {
              if (turnImages.length >= MAX_IMAGES_PER_MODEL_REQUEST) {
                throw new Error(`A turn can contain at most ${MAX_IMAGES_PER_MODEL_REQUEST} images.`);
              }
              assertThreadImageNumberAvailable(imageNumbering.next);
              const attachment = await this.ctx.dependencies.attachImage?.({
                threadId: state.threadId,
                label: `Image #${imageNumbering.next}`,
                absolutePath: image.absolutePath,
                sourceName: image.sourceName,
              });
              if (!attachment) {
                throw new Error("Image attachment storage is unavailable.");
              }
              try {
                validateImageAttachmentCollection([...turnImages, attachment]);
                validateProviderImageAttachments(this.ctx.dependencies.provider.name, [attachment]);
              } catch (error) {
                await this.ctx.dependencies.discardImage?.(state.threadId, attachment).catch(() => undefined);
                throw error;
              }
              turnImages.push(attachment);
              imageNumbering.next += 1;
              return attachment;
            },
          }
        : {}),
    };
  }

  /** Check the state changes a tool result claims (memory, task DAG, child lifecycle, task report, plan) before any is applied. */
  private validateToolEffects(
    ctx: ToolCallsContext,
    updates: ToolCallsState,
    toolName: ToolName,
    invocation: ToolInvocationOutcome,
  ): ToolEffects {
    const { agentIdentity, effectiveMode, memoryContext, state, turnId } = ctx;
    let result = invocation.result;
    if (
      toolName === "write_memory" &&
      result.ok &&
      result.memoryMutation &&
      memoryContext.mutations.length >= MAX_MEMORY_MUTATIONS_PER_TURN
    ) {
      result = {
        ok: false,
        summary: `A turn can stage at most ${MAX_MEMORY_MUTATIONS_PER_TURN} memory changes.`,
        error: "memory_mutation_limit_reached",
      };
    }

    const taskGraphEffect = validateTaskGraphEffect(state, turnId, toolName, invocation.taskGraphOperation, result);
    result = taskGraphEffect.result;
    const { taskGraphUpdate, subagentTaskOperation } = taskGraphEffect;

    if (result.ok && result.subagentLifecycle) {
      const lifecycleError = subagentLifecycleError(
        toolName,
        result.subagentLifecycle,
        result.subagentAssignment,
        taskGraphUpdate,
        subagentTaskOperation,
      );
      if (lifecycleError) {
        result = {
          ok: false,
          summary: "Runtime rejected an invalid subagent lifecycle transition.",
          error: lifecycleError,
        };
      }
    } else if (result.ok && result.subagentAssignment) {
      result = {
        ok: false,
        summary: "Runtime rejected an unpaired child assignment.",
        error: "A child assignment requires an activate or observe lifecycle transition",
      };
    }

    if (result.ok && result.subagentTaskReport) {
      const report = result.subagentTaskReport;
      if (
        toolName !== "submit_task_result" ||
        agentIdentity.role !== "subagent" ||
        report.taskId !== agentIdentity.assignedTaskId
      ) {
        result = {
          ok: false,
          summary: "Runtime rejected an unauthorized child task result.",
          error: "invalid_subagent_task_result",
        };
      } else {
        updates.submittedTaskReport = report;
      }
    } else if (result.ok && toolName === "submit_task_result") {
      result = {
        ok: false,
        summary: "Runtime rejected a missing child task result.",
        error: "submit_task_result did not return a structured result",
      };
    }

    let planReviewUpdate: SessionState["planReview"] | undefined;
    if (result.ok && result.planProposal) {
      try {
        if (toolName !== "propose_plan" || effectiveMode !== "plan") {
          throw new Error("Only propose_plan may submit a proposal in Plan mode");
        }
        if ((this.ctx.dependencies.getOutstandingSubagents?.() ?? []).length > 0) {
          throw new Error("Outstanding child assignments must be collected before proposing a plan");
        }
        if (state.taskGraph && state.taskGraph.status !== "completed")
          throw new Error("Finish the planning task DAG before proposing a plan");
        planReviewUpdate = createPlanReviewState(result.planProposal, turnId, state.planReview);
      } catch (error) {
        result = {
          ok: false,
          summary: "Runtime rejected an invalid plan proposal.",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (result.ok && toolName === "propose_plan") {
      result = {
        ok: false,
        summary: "Runtime rejected a missing plan proposal.",
        error: "propose_plan did not return a structured proposal",
      };
    }
    if (!result.ok && toolName === "submit_task_result") {
      updates.submittedTaskReport = undefined;
    }
    return { result, taskGraphUpdate, subagentTaskOperation, planReviewUpdate };
  }

  /** Project a result into the model-facing tool message and classify it for the progress guard. */
  private toolResultRecord(
    ctx: ToolCallsContext,
    call: FunctionToolCall,
    tool: AgentTool | undefined,
    taskIdAtCall: string | undefined,
    result: ToolExecutionResult,
  ) {
    const { options, progressResponseBase, progressVerificationCommands, projectionHistory, state, step, turnId } = ctx;
    const toolName = call.function.name as ToolName;
    let projectionIntent: string | undefined;
    if (toolName === "run_command" || toolName === "start_command") {
      try {
        projectionIntent = JSON.parse(call.function.arguments).intent;
      } catch {
        /* invalid arguments were not executed */
      }
    }
    const projected = projectToolResult(result, this.ctx.dependencies.limits, {
      intent: projectionIntent,
      previousMessages: projectionHistory,
    });
    const projectionLimits = this.ctx.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS;
    const readData = result.data as
      { path?: unknown; content?: unknown; contentHash?: unknown; startLine?: unknown; endLine?: unknown } | undefined;
    const versionedRead =
      result.ok &&
      toolName === "read_file" &&
      readData &&
      typeof readData.path === "string" &&
      typeof readData.content === "string" &&
      typeof readData.contentHash === "string" &&
      /^[a-f0-9]{64}$/u.test(readData.contentHash) &&
      Number.isSafeInteger(readData.startLine) &&
      Number.isSafeInteger(readData.endLine);
    const isMcpResult = tool?.metadata?.identity.sourceId === "mcp";
    const resultChars = versionedRead
      ? projectionLimits.maxReadResultTokens * 8 + 4096
      : toolName === "search_files"
        ? projectionLimits.searchMaxResultTokens * 8 + 4096
        : isMcpResult
          ? options.maxOutputChars
          : (this.ctx.dependencies.limits?.maxToolResultChars ?? options.maxOutputChars);
    const toolMessage: ChatMessage = {
      role: "tool",
      tool_call_id: call.id,
      name: call.function.name,
      content: resultForModel(projected, resultChars),
    };
    const toolResultEventId = createId("event");
    const verification = commandVerificationClassification(
      toolName,
      call.function.arguments,
      progressVerificationCommands,
      result,
    );
    const progressCommandData =
      result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : undefined;
    if (
      verification.intent &&
      (toolName === "run_command" || toolName === "start_command") &&
      typeof progressCommandData?.commandId === "string"
    ) {
      progressVerificationCommands.set(progressCommandData.commandId, verification.kind ?? "custom");
    }
    const progressObservation = observeToolResult({
      sourceEventId: toolResultEventId,
      sourceCallId: call.id,
      scopeKey: taskIdAtCall ? `thread:${state.threadId}/task:${taskIdAtCall}` : progressScopeKey(state, turnId),
      responseOrdinal: progressResponseOrdinal(progressResponseBase, step),
      tool: call.function.name,
      result,
      verificationIntent: verification.intent,
      investigationPolicy: {
        minimum: projectionLimits.progressInvestigationMinSamples,
        ratio: projectionLimits.progressInvestigationRepeatRatio,
        window: projectionLimits.progressInvestigationWindowResponses,
        review: projectionLimits.progressInvestigationReviewEnabled,
      },
      ...(verification.kind ? { verificationKind: verification.kind } : {}),
    });
    return { toolMessage, toolResultEventId, progressObservation };
  }

  /** Journal the tool result, then apply its accepted effects to the session; a prepared child reservation is rolled back on failure. */
  private async commitToolResult(
    ctx: ToolCallsContext,
    updates: ToolCallsState,
    call: FunctionToolCall,
    tool: AgentTool | undefined,
    taskIdAtCall: string | undefined,
    outcome: ToolInvocationOutcome & ToolEffects,
  ): Promise<void> {
    const { memoryContext, projectionHistory, state, step, stepImageAttachments, toolGateway, turnId } = ctx;
    const { result, displayName, taskGraphOperation, taskGraphUpdate, subagentTaskOperation, planReviewUpdate } =
      outcome;
    const toolName = call.function.name as ToolName;
    const { toolMessage, toolResultEventId, progressObservation } = this.toolResultRecord(
      ctx,
      call,
      tool,
      taskIdAtCall,
      result,
    );
    let preparedSubagentLifecycleRolledBack = false;
    const rollbackPreparedSubagent = (): void => {
      if (!outcome.preparedSubagentLifecycle || preparedSubagentLifecycleRolledBack) return;
      preparedSubagentLifecycleRolledBack = true;
      try {
        this.ctx.dependencies.onSubagentLifecycleRollback?.(outcome.preparedSubagentLifecycle);
      } catch {
        // A local reservation cleanup hook must not replace the durable tool result/error.
      }
    };
    if (!result.ok) rollbackPreparedSubagent();
    const contextCommand = pendingCommandObservation(toolName, result, taskIdAtCall);
    const contextReconciliation = reconciliationObservation(state, toolName, result);
    let displayDetails: ReturnType<typeof safeToolDisplayDetails> = [];
    try {
      displayDetails = safeToolDisplayDetails(
        toolDisplayDetails(tool, toolName, call.function.arguments, result, state),
      );
    } catch {
      // Presentation metadata must never prevent a tool result from being committed.
    }
    try {
      await this.ctx.dependencies.appendEvent({
        eventId: toolResultEventId,
        threadId: state.threadId,
        turnId,
        stepId: `step_${step}`,
        type: "tool.result",
        phase: result.ok ? "completed" : "failed",
        payload: {
          callId: call.id,
          tool: call.function.name,
          ...(toolGateway.catalog.bindings.get(call.function.name)
            ? { toolBinding: toolGateway.catalog.bindings.get(call.function.name) }
            : {}),
          message: toolMessage,
          ...(displayDetails.length ? { toolDetails: displayDetails } : {}),
          progressObservation,
          ...(contextCommand ? { contextCommand } : {}),
          ...(contextReconciliation ? { contextReconciliation } : {}),
          outputProjection: {
            capturedResultChars: JSON.stringify(result.data ?? null).length,
            modelResultChars: toolMessage.content.length,
          },
          ...(result.failure ? { failure: result.failure } : {}),
          ...(taskIdAtCall ? { taskId: taskIdAtCall } : {}),
          ...(taskGraphUpdate && taskGraphOperation ? { taskGraph: taskGraphUpdate, taskGraphOperation } : {}),
          ...(taskGraphUpdate && subagentTaskOperation ? { taskGraph: taskGraphUpdate, subagentTaskOperation } : {}),
          ...(result.ok && result.subagentLifecycle ? { subagentLifecycle: result.subagentLifecycle } : {}),
          ...(result.ok && result.subagentAssignment ? { subagentAssignment: result.subagentAssignment } : {}),
          ...(result.ok && result.subagentMessageId ? { subagentMessageId: result.subagentMessageId } : {}),
          ...(planReviewUpdate ? { planReview: planReviewUpdate } : {}),
        },
      });
    } catch (error) {
      rollbackPreparedSubagent();
      throw error;
    }
    projectionHistory.push(toolMessage);
    const progressFold = foldProgressObservation(state.progressGuard, progressObservation);
    state.progressGuard = progressFold.state;
    foldPendingOperations(state, {
      tool: toolName,
      contextCommand,
      contextReconciliation,
      ...(result.ok
        ? { subagentLifecycle: result.subagentLifecycle, subagentAssignment: result.subagentAssignment }
        : {}),
    });
    updates.completedVerificationPhase ||=
      progressFold.accepted && progressObservation.kind === "verification_terminal";
    state.messages.push(toolMessage);
    if (taskGraphUpdate) {
      state.taskGraph = taskGraphUpdate;
      state.updatedAt = new Date().toISOString();
    }
    if (planReviewUpdate) {
      state.planReview = planReviewUpdate;
      updates.proposedPlan = planReviewUpdate.proposal;
      state.updatedAt = new Date().toISOString();
    }
    if (result.ok && result.imageAttachments?.length) {
      stepImageAttachments.push(...result.imageAttachments);
    }
    if (toolName === "write_memory" && result.ok && result.memoryMutation) {
      memoryContext.mutations.push(result.memoryMutation);
    }
    await this.ctx.dependencies.onToolCompleted?.(state, call.function.name, result, displayName, displayDetails);
  }

  private async withToolExecutionActivity<T>(toolName: string, request: () => Promise<T>): Promise<T> {
    let activityToken: unknown;
    let activityStarted = false;
    try {
      if (this.ctx.dependencies.onToolExecutionStart) {
        activityToken = this.ctx.dependencies.onToolExecutionStart(toolName, `Running Tool: ${toolName}`);
        activityStarted = true;
      }
    } catch {
      // Tool execution remains authoritative if presentation fails.
    }
    try {
      return await request();
    } finally {
      try {
        if (activityStarted) {
          this.ctx.dependencies.onToolExecutionEnd?.(toolName, activityToken);
        }
      } catch {
        // A broken presentation hook must not replace a tool result or error.
      }
    }
  }
}
