/** Independent model review of command and tool approval requests (used in auto-approve mode before asking the user). */

import { TaskBudget } from "../runtime/task-budget.js";
import { reviewCommandApproval, type ApprovalReview } from "../command/approval-agent.js";
import type { ApprovalRequest, EasyCodeConfig, SessionState } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { createProvider } from "../providers/factory.js";
import { type ToolApprovalIdentity } from "../tools/approval.js";
import { reviewToolApproval, type ToolApprovalReview } from "../tools/approval-agent.js";
import { ThreadStore } from "../threads/thread-store.js";
import { promptBundleText } from "./text.js";

/** What ApprovalReviewer needs from its host; live values are forwarded through getters. */
export interface ApprovalReviewerContext {
  readonly config: EasyCodeConfig;
  readonly effectiveConfig: () => EasyCodeConfig;
  readonly sharedTaskBudget: (threadId: string) => TaskBudget;
  readonly state: SessionState;
  readonly threadStore: ThreadStore;
}

export class ApprovalReviewer {
  constructor(private readonly ctx: ApprovalReviewerContext) {}

  async reviewApproval(request: ApprovalRequest): Promise<ApprovalReview> {
    try {
      const threadId = this.ctx.state.threadId;
      const turnId = this.ctx.state.activeTurnId;
      const provider = createProvider(
        this.ctx.effectiveConfig(),
        this.ctx.state.provider,
        this.ctx.config.approvalModel ?? this.ctx.state.model,
      );
      const task = this.ctx.state.messages
        .filter((message) => message.role === "user")
        .slice(-3)
        .map((message) => message.content)
        .join("\n");
      return await reviewCommandApproval(request, task, {
        provider,
        budget: this.ctx.sharedTaskBudget(threadId),
        limits: this.ctx.config.limits,
        maxInputChars: this.ctx.config.limits.approvalInputChars,
        maxOutputTokens: this.ctx.config.limits.approvalOutputTokens,
        onResponse: (response) =>
          this.ctx.threadStore.appendEvent(threadId, {
            type: "model.output.captured",
            turnId,
            payload: {
              purpose: "command_approval",
              finishReason: response.finishReason ?? null,
              message: JSON.parse(
                redactSensitiveInformation(
                  JSON.stringify({ content: response.message.content, tool_calls: response.message.tool_calls }),
                ),
              ),
            },
          }),
        onUsage: (usage, attempt) => {
          if (attempt)
            this.ctx.threadStore.appendEvent(threadId, {
              type: "model.api_attempt",
              turnId,
              phase: attempt.outcome,
              payload: { ...attempt, actor: "approval_agent", purpose: "command_approval" },
            });
          // A failed API attempt still completes an unreported usage record.
          // model.usage has a completed-only journal protocol; its phase is not the API outcome.
          this.ctx.threadStore.appendEvent(threadId, {
            type: "model.usage",
            phase: "completed",
            payload: {
              actor: "approval_agent",
              purpose: "command_approval",
              provider: provider.name,
              model: provider.model,
              turnId,
              retry: attempt?.retry ?? false,
              attempt: attempt?.attempt,
              usage,
            },
          });
        },
      });
    } catch (error) {
      return { decision: "reject", reason: redactSensitiveInformation(String(error)), unavailable: true };
    }
  }

  async reviewCatalogToolApproval(
    identity: ToolApprovalIdentity,
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<ToolApprovalReview> {
    try {
      const parentThreadId = this.ctx.state.threadId;
      const provider = createProvider(
        this.ctx.effectiveConfig(),
        this.ctx.state.provider,
        this.ctx.config.approvalModel ?? this.ctx.state.model,
      );
      const task = this.ctx.threadStore
        .recover(threadId)
        .messages.filter((message) => message.role === "user")
        .slice(-3)
        .map((message) => message.content)
        .join("\n");
      return await reviewToolApproval(identity, task, {
        provider,
        budget: this.ctx.sharedTaskBudget(parentThreadId),
        systemPrompt: promptBundleText("agents/tool-approval.md"),
        limits: this.ctx.config.limits,
        signal,
        maxInputChars: this.ctx.config.limits.approvalInputChars,
        maxOutputTokens: this.ctx.config.limits.approvalOutputTokens,
        onResponse: (response) =>
          this.ctx.threadStore.appendEvent(threadId, {
            type: "model.output.captured",
            turnId,
            payload: {
              purpose: "tool_approval",
              finishReason: response.finishReason ?? null,
              message: JSON.parse(
                redactSensitiveInformation(
                  JSON.stringify({ content: response.message.content, tool_calls: response.message.tool_calls }),
                ),
              ),
            },
          }),
        onUsage: (usage, attempt) => {
          if (attempt)
            this.ctx.threadStore.appendEvent(threadId, {
              type: "model.api_attempt",
              turnId,
              phase: attempt.outcome,
              payload: { ...attempt, actor: "approval_agent", purpose: "tool_approval" },
            });
          this.ctx.threadStore.appendEvent(threadId, {
            type: "model.usage",
            phase: "completed",
            payload: {
              actor: "approval_agent",
              purpose: "tool_approval",
              provider: provider.name,
              model: provider.model,
              turnId,
              retry: attempt?.retry ?? false,
              attempt: attempt?.attempt,
              usage,
            },
          });
        },
      });
    } catch (error) {
      return { decision: "reject", reason: redactSensitiveInformation(String(error)), unavailable: true };
    }
  }
}
