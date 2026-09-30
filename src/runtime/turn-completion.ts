import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { completeExchange, investigationExchangeStart } from "../context/compaction-transaction.js";
import { reconciliationPending } from "../context/reconciliation.js";
import {
  type AgentRunResult,
  type ChatMessage,
  type ImageAttachment,
  type MemoryMutationRequest,
  type PlanProposal,
  type PlanReviewState,
  type SessionState,
  type SubagentTaskReport,
  type TurnSteeringBatch,
  type TurnSteeringBoundary,
} from "../core/types.js";
import type { LocalDecisionResult, LocalDecisionTask } from "../local-decision/client.js";
import {
  createPlanReviewState,
  formatPlanProposal,
  planDraftFromText,
  returnPlanExecutionToReview,
  type PlanExecutionReturnOutcome,
} from "../plans/plan.js";
import { renderRuntimePrompt, runtimePromptText } from "./agent-support.js";
import type {
  AgentRuntimeDependencies,
  HandleTextResponseFlow,
  SettleToolBatchFlow,
  TextResponseContext,
  ToolBatchOutcomeContext,
  ToolBatchOutcomeState,
} from "./agent-types.js";
import {
  evaluateCompletionGate,
  foldCompletionControl,
  nextCompletionAttempt,
  renderCompletionCorrection,
} from "./completion-gate.js";
import { ToolProtocolExhausted } from "./tool-recovery.js";

/** Live state and callbacks supplied by AgentRuntime. */
export interface TurnCompletionContext {
  readonly closeContextPhase: (
    state: SessionState,
    turnId: string,
    kind?: "verification" | "turn" | "investigation",
  ) => Promise<void>;
  readonly decideLocally: (
    state: Readonly<SessionState>,
    turnId: string,
    task: LocalDecisionTask,
    rawInput: string,
    signal?: AbortSignal,
  ) => Promise<{ id: string; result: LocalDecisionResult; appliedDecision: string } | undefined>;
  readonly dependencies: AgentRuntimeDependencies;
  readonly recordLocalDecision: (
    id: string,
    state: Readonly<SessionState>,
    turnId: string,
    decision: LocalDecisionResult,
    appliedDecision: string,
    challenged?: boolean,
  ) => Promise<void>;
  readonly takeAndApplySteering: (
    state: SessionState,
    turnId: string,
    boundary: TurnSteeringBoundary,
    turnImages: ImageAttachment[],
    seal?: boolean,
    memoryContext?: { userInput: string },
  ) => Promise<TurnSteeringBatch | undefined>;
}

export class TurnCompletion {
  constructor(private readonly ctx: TurnCompletionContext) {}

  /** Act on what a tool batch produced: environment faults, protocol exhaustion, rejected finishes, child reports, plan proposals and new image attachments. */
  async settleToolBatch(ctx: ToolBatchOutcomeContext, updates: ToolBatchOutcomeState): Promise<SettleToolBatchFlow> {
    const {
      agentIdentity,
      completedVerificationPhase,
      environmentFault,
      finishRejectedReason,
      memoryContext,
      proposedPlan,
      requiredProtocolExhaustion,
      state,
      step,
      stepImageAttachments,
      submittedTaskReport,
      turnId,
      turnImages,
    } = ctx;
    let { steeringAppliedBetweenTools } = updates;
    try {
      if (environmentFault) {
        return {
          kind: "return",
          value: this.finish(
            state,
            turnId,
            `Task paused because the command environment is quarantined. ${environmentFault}`,
            "paused",
            step,
            memoryContext,
            undefined,
            undefined,
            undefined,
            {
              cause: "command_environment",
              resumable: true,
              requiredAction: "Repair the command environment and verify cleanup, then resume this task.",
              obligations: [],
            },
          ),
        };
      }
      if (completedVerificationPhase) await this.ctx.closeContextPhase(state, turnId);
      else if (investigationExchangeStart(state.messages) !== undefined)
        await this.ctx.closeContextPhase(state, turnId, "investigation");
      if (!steeringAppliedBetweenTools) {
        steeringAppliedBetweenTools = Boolean(
          await this.ctx.takeAndApplySteering(state, turnId, "between_tools", turnImages, false, memoryContext),
        );
      }
      if (steeringAppliedBetweenTools) {
        return { kind: "continue" };
      }

      if (requiredProtocolExhaustion) {
        throw new ToolProtocolExhausted(requiredProtocolExhaustion.tool, requiredProtocolExhaustion.attempt, step);
      }
      if (finishRejectedReason) {
        const obligations = evaluateCompletionGate({
          state,
          role: agentIdentity.role,
          reconciliationPending: reconciliationPending(state),
          openCommandHandles: true,
          outstandingSubagents:
            agentIdentity.role === "main_agent" ? (this.ctx.dependencies.getOutstandingSubagents?.() ?? []) : [],
        });
        const { signature, attempt } = nextCompletionAttempt(state, obligations);
        const payload = { signature, attempt, obligations };
        await this.ctx.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          type: "completion.rejected",
          phase: "completed",
          payload,
        });
        foldCompletionControl(state, "completion.rejected", payload);
        const maximum = (this.ctx.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).prematureFinishRetries;
        if (attempt <= maximum) {
          const feedback: ChatMessage = {
            role: "user",
            content: renderCompletionCorrection(obligations, attempt, maximum - attempt),
          };
          state.messages.push(feedback);
          await this.ctx.dependencies.appendEvent({
            threadId: state.threadId,
            turnId,
            type: "message.user.synthetic",
            phase: "completed",
            payload: feedback,
          });
          return { kind: "continue" };
        }
        return {
          kind: "return",
          value: this.finish(
            state,
            turnId,
            finishRejectedReason,
            "paused",
            step,
            memoryContext,
            undefined,
            undefined,
            undefined,
            {
              cause: "completion_protocol",
              resumable: true,
              requiredAction: obligations.map((item) => item.requiredAction).join(" "),
              obligations,
            },
          ),
        };
      }
      if (submittedTaskReport) {
        const text = submittedTaskReport.summary;
        this.ctx.dependencies.onText?.(text);
        return {
          kind: "return",
          value: this.finish(
            state,
            turnId,
            text,
            submittedTaskReport.outcome === "completed" ? "success" : "blocked",
            step,
            memoryContext,
            undefined,
            submittedTaskReport,
          ),
        };
      }

      if (proposedPlan) {
        if (await this.ctx.takeAndApplySteering(state, turnId, "before_final", turnImages, true, memoryContext)) {
          return { kind: "continue" };
        }
        const text = `${formatPlanProposal(proposedPlan)}\n\n` + runtimePromptText("runtime/plan-waiting-review.md");
        this.ctx.dependencies.onText?.(text);
        return {
          kind: "return",
          value: this.finish(state, turnId, text, "planned", step, memoryContext, proposedPlan),
        };
      }

      if (stepImageAttachments.length) {
        const labels = stepImageAttachments.map((image) => image.label).join(", ");
        const imageMessage: Extract<ChatMessage, { role: "user" }> = {
          role: "user",
          content: renderRuntimePrompt("runtime/read-image-follow-up.md", {
            labels,
          }),
          images: stepImageAttachments,
        };
        state.messages.push(imageMessage);
        await this.ctx.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `step_${step}`,
          type: "message.user.synthetic",
          phase: "completed",
          payload: imageMessage,
        });
        await this.ctx.dependencies.commitImages?.(state.threadId, stepImageAttachments);
      }
    } finally {
      updates.steeringAppliedBetweenTools = steeringAppliedBetweenTools;
    }
    return { kind: "next" };
  }

  /** Handle a model response without tool calls: enforce outstanding obligations, then finish the turn or continue with the next step. */
  async handleTextResponse(ctx: TextResponseContext): Promise<HandleTextResponseFlow> {
    const {
      agentIdentity,
      assistantMessage,
      calls,
      effectiveMode,
      memoryContext,
      options,
      state,
      step,
      turnHistoryStart,
      turnId,
      turnImages,
    } = ctx;
    if (calls.length === 0) {
      if (agentIdentity.role === "main_agent" && this.ctx.dependencies.collectReadySubagents) {
        const collected = await this.ctx.dependencies.collectReadySubagents(state, turnId, options.signal);
        if (collected > 0) {
          return { kind: "continue" };
        }
      }
      const outstandingSubagents =
        agentIdentity.role === "main_agent" ? (this.ctx.dependencies.getOutstandingSubagents?.() ?? []) : [];
      const obligations = evaluateCompletionGate({
        state,
        role: agentIdentity.role,
        planning: effectiveMode === "plan",
        reconciliationPending: reconciliationPending(state),
        openCommandHandles: this.ctx.dependencies.hasOpenCommandHandles?.() ?? false,
        outstandingSubagents,
      });
      if (obligations.length) {
        const { signature, attempt } = nextCompletionAttempt(state, obligations);
        const payload = { signature, attempt, obligations };
        await this.ctx.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          type: "completion.rejected",
          phase: "completed",
          payload,
        });
        foldCompletionControl(state, "completion.rejected", payload);
        const limits = this.ctx.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS;
        // When several obligations coexist, stop as soon as the most
        // restrictive configured correction budget is exhausted. Resolving
        // that obligation creates a new signature and lets the remaining
        // obligations use their own budget on Resume.
        const maximum = limits.prematureFinishRetries;
        if (attempt <= maximum) {
          const feedback: ChatMessage = {
            role: "user",
            content: renderCompletionCorrection(obligations, attempt, maximum - attempt),
          };
          state.messages.push(feedback);
          await this.ctx.dependencies.appendEvent({
            threadId: state.threadId,
            turnId,
            type: "message.user.synthetic",
            phase: "completed",
            payload: feedback,
          });
          return { kind: "continue" };
        }
        return {
          kind: "return",
          value: this.finish(
            state,
            turnId,
            `Task paused after ${attempt} repeated invalid completion proposals. Pending obligations: ` +
              obligations.map((item) => item.description).join(" "),
            "paused",
            step,
            memoryContext,
            undefined,
            undefined,
            undefined,
            {
              cause: obligations.some(
                (item) => item.kind === "subagent_submission" || item.kind === "collect_subagents",
              )
                ? "subagent"
                : "completion_protocol",
              resumable: true,
              requiredAction: obligations.map((item) => item.requiredAction).join(" "),
              obligations,
            },
          ),
        };
      }
      if (state.completionControl?.active) {
        const payload = { signature: state.completionControl.active.signature };
        await this.ctx.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          type: "completion.resolved",
          phase: "completed",
          payload,
        });
        foldCompletionControl(state, "completion.resolved", payload);
      }
      if (effectiveMode === "plan" && agentIdentity.role === "main_agent" && assistantMessage.content?.trim()) {
        if (await this.ctx.takeAndApplySteering(state, turnId, "before_final", turnImages, true, memoryContext))
          return { kind: "continue" };
        const planReview = createPlanReviewState(planDraftFromText(assistantMessage.content), turnId, state.planReview);
        await this.ctx.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          type: "plan.proposed",
          phase: "completed",
          payload: { planReview },
        });
        state.planReview = planReview;
        state.updatedAt = new Date().toISOString();
        const text =
          `${formatPlanProposal(planReview.proposal)}\n\n` + runtimePromptText("runtime/plan-waiting-review.md");
        this.ctx.dependencies.onText?.(text);
        return {
          kind: "return",
          value: this.finish(state, turnId, text, "planned", step, memoryContext, planReview.proposal),
        };
      }
      let text = assistantMessage.content?.trim() || "The task ended, but the model did not provide an explanation.";
      if (await this.ctx.takeAndApplySteering(state, turnId, "before_final", turnImages, false, memoryContext)) {
        return { kind: "continue" };
      }
      if (
        effectiveMode === "code" &&
        agentIdentity.role === "main_agent" &&
        assistantMessage.content?.trim() &&
        !this.ctx.dependencies.deliveryChallengeAlreadyUsed?.(state.threadId)
      ) {
        const priorRequest = /^\s*(continue|resume|继续|接着做|继续执行)[\s.!。！]*$/iu.test(memoryContext.userInput)
          ? state.messages
              .slice(0, turnHistoryStart)
              .reverse()
              .find(
                (message) =>
                  message.role === "user" && message.content.trim() && !message.content.startsWith("RUNTIME_"),
              )?.content
          : undefined;
        const requirements = [
          priorRequest,
          memoryContext.userInput,
          ...(state.contextIntentLedger?.activeConstraints.map((item) => item.text) ?? []),
          ...(state.contextIntentLedger?.userCorrections.map((item) => item.text) ?? []),
        ]
          .filter(Boolean)
          .join("\n\n");
        const input = `Original user request:\n${requirements}\n\nMain agent completion summary:\n${text}`;
        const local = await this.ctx.decideLocally(state, turnId, "delivery", input, options.signal);
        if (local) {
          if (local.appliedDecision === "CHALLENGE") {
            const feedback: ChatMessage = {
              role: "user",
              content:
                "RUNTIME_DELIVERY_CHALLENGE: Your own completion summary may not cover every user requirement. " +
                "Check the requested outcomes against the actual changes and verification once more. " +
                "Correct any omission you find, then submit a new final response. " +
                "This local classifier does not identify a specific bug and will not challenge this task again.",
            };
            await this.ctx.dependencies.appendEvent({
              threadId: state.threadId,
              turnId,
              type: "decision.delivery.challenge_requested",
              phase: "completed",
              payload: { decisionId: local.id, message: feedback },
            });
            state.messages.push(feedback);
          }
          await this.ctx.recordLocalDecision(
            local.id,
            state,
            turnId,
            local.result,
            local.appliedDecision,
            local.appliedDecision === "CHALLENGE",
          );
          if (local.appliedDecision === "CHALLENGE") return { kind: "continue" };
        }
      }
      // Finalization seals user steering exactly once. Reviewer advice, when
      // present, was already injected before this model request.
      if (await this.ctx.takeAndApplySteering(state, turnId, "before_final", turnImages, true, memoryContext))
        return { kind: "continue" };
      this.ctx.dependencies.onText?.(text);
      const reason = state.taskGraph?.status === "terminal_blocked" ? "blocked" : "success";
      return { kind: "return", value: this.finish(state, turnId, text, reason, step, memoryContext) };
    }
    return { kind: "next" };
  }

  async finish(
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
    const returnOutcome: PlanExecutionReturnOutcome | undefined =
      reason === "failed" || reason === "interrupted" || reason === "limit_reached" ? reason : undefined;
    if (
      returnOutcome &&
      memoryContext.approvedPlanReview &&
      !state.planReview &&
      state.taskGraph?.createdByTurnId !== turnId
    ) {
      const restoredPlanReview = returnPlanExecutionToReview(memoryContext.approvedPlanReview, returnOutcome);
      await this.ctx.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "plan.execution_returned_to_review",
        phase: "completed",
        payload: {
          planId: restoredPlanReview.proposal.id,
          revision: restoredPlanReview.proposal.revision,
          outcome: returnOutcome,
          planReview: restoredPlanReview,
        },
      });
      state.planReview = restoredPlanReview;
      memoryContext.approvedPlanReview = undefined;
    }
    state.activeTurnId = undefined;
    state.updatedAt = new Date().toISOString();
    const lastMessage = state.messages[state.messages.length - 1];
    const result: AgentRunResult = {
      text,
      reason,
      steps,
      threadId: state.threadId,
      turnId,
      ...(planProposal ? { planProposal } : {}),
      ...(subagentTaskReport ? { subagentTaskReport } : {}),
      ...(failure ? { failure } : {}),
      ...(pause ? { pause } : {}),
    };
    if (
      completeExchange(state.messages) &&
      (!lastMessage ||
        lastMessage.role !== "assistant" ||
        Boolean(lastMessage.tool_calls?.length) ||
        !lastMessage.content?.trim())
    ) {
      const syntheticMessage: ChatMessage = { role: "assistant", content: text, phase: "final_answer" };
      state.messages.push(syntheticMessage);
      await this.ctx.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "message.assistant",
        phase: "completed",
        payload: syntheticMessage,
      });
    }
    await this.ctx.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "turn.completed",
      phase: "completed",
      payload: {
        reason,
        steps,
        ...(failure ? { failure } : {}),
        ...(pause ? { pause } : {}),
        ...(planProposal ? { planId: planProposal.id, revision: planProposal.revision } : {}),
      },
    });

    if (
      memoryContext.mutations.length > 0 &&
      this.ctx.dependencies.commitMemoryMutations &&
      (reason === "success" || reason === "planned")
    ) {
      try {
        const committed = await this.ctx.dependencies.commitMemoryMutations({
          workspaceRoot: state.workspaceRoot,
          threadId: state.threadId,
          turnId,
          outcome: reason,
          mutations: memoryContext.mutations,
        });
        await this.ctx.dependencies
          .appendEvent({
            threadId: state.threadId,
            turnId,
            type: "memory.committed",
            phase: "completed",
            payload: committed,
          })
          .catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.ctx.dependencies
          .appendEvent({
            threadId: state.threadId,
            turnId,
            type: "memory.commit_failed",
            phase: "failed",
            payload: { message },
          })
          .catch(() => undefined);
      }
    } else if (memoryContext.mutations.length > 0) {
      await this.ctx.dependencies
        .appendEvent({
          threadId: state.threadId,
          turnId,
          type: "memory.discarded",
          phase: "completed",
          payload: { count: memoryContext.mutations.length, reason },
        })
        .catch(() => undefined);
    }
    if (reason === "success" || reason === "planned") await this.ctx.closeContextPhase(state, turnId, "turn");
    if (this.ctx.dependencies.checkpointContext) {
      try {
        await this.ctx.dependencies.checkpointContext(state);
      } catch {
        // The durable Thread journal remains authoritative. A best-effort
        // projection failure is not a user-facing task failure.
      }
    }
    return result;
  }
}
