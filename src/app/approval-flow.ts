/** Approval flow for commands, subagent requests and catalog tool calls: queueing, reviewer escalation, user decisions and durable grants. */

import type { AppInteractionPort } from "../ui/interaction-port.js";
import { DECISION_TIMEOUT_MS } from "../ui/decision-timeout.js";
import {
  grantCommandApprovalPrefix,
  isCommandApprovalPrefixGranted,
  formatCommandApprovalPrefix,
} from "../command/approval.js";
import { autoApproveNetwork } from "../command/network-approval.js";
import { autoApproveLocal } from "../command/local-approval.js";
import { ApprovalQueue, type ApprovalReview } from "../command/approval-agent.js";
import { canGrantCommandPrefix } from "../command/approval.js";
import type { ApprovalRequest, CommandExecutionMode, SessionState } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import type { ToolExecutionAuthorizer, ToolExecutionAuthorizationRequest } from "../tools/execution-gateway.js";
import { toolApprovalIdentity, type ToolApprovalIdentity } from "../tools/approval.js";
import { type ToolApprovalReview } from "../tools/approval-agent.js";
import { ThreadStore } from "../threads/thread-store.js";
import { createId } from "../utils/ids.js";

/** What ApprovalFlow needs from its host; live values are forwarded through getters. */
export interface ApprovalFlowContext {
  approvalQueue: ApprovalQueue;
  readonly assumeYes: boolean;
  readonly authorizeToolExecution: ToolExecutionAuthorizer | undefined;
  readonly commandExecutionMode: CommandExecutionMode;
  dirty: boolean;
  readonly reviewApproval: (request: ApprovalRequest) => Promise<ApprovalReview>;
  readonly reviewCatalogToolApproval: (
    identity: ToolApprovalIdentity,
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
  ) => Promise<ToolApprovalReview>;
  readonly state: SessionState;
  readonly terminal: AppInteractionPort;
  readonly threadStore: ThreadStore;
}

export class ApprovalFlow {
  constructor(private readonly ctx: ApprovalFlowContext) {}

  async requestToolApproval(request: ApprovalRequest): Promise<boolean> {
    const threadId = this.ctx.state.threadId;
    return (this.ctx.approvalQueue ??= new ApprovalQueue()).run(async () => {
      if (threadId !== this.ctx.state.threadId || request.signal?.aborted) return false;
      return this.resolveToolApproval(request);
    });
  }

  private async resolveToolApproval(request: ApprovalRequest): Promise<boolean> {
    if (request.signal?.aborted) return false;
    const threadId = this.ctx.state.threadId;
    const mode = this.ctx.commandExecutionMode ?? (this.ctx.assumeYes ? "auto_approve" : "manual");
    if (request.requiredReviewer !== "user" && (request.network ? autoApproveNetwork(mode) : autoApproveLocal(mode))) {
      request.observeDecision?.("allow_once");
      return true;
    }

    if (
      isCommandApprovalPrefixGranted(this.ctx.state.commandApprovalPrefixes, request.commandPrefix) ||
      (request.existingNetworkCommandPrefix !== undefined &&
        isCommandApprovalPrefixGranted(this.ctx.state.commandApprovalPrefixes, request.existingNetworkCommandPrefix))
    ) {
      request.observeDecision?.("allow_prefix");
      return true;
    }

    let decision: import("../core/types.js").ApprovalDecision | undefined;
    if (mode === "auto_approve" && request.requiredReviewer !== "user") {
      const review = await this.ctx.reviewApproval(request);
      this.ctx.threadStore.appendEvent(threadId, {
        type: "approval.reviewed",
        payload: { id: request.id, source: request.source, ...review },
      });
      if (request.signal?.aborted || threadId !== this.ctx.state.threadId || mode !== this.ctx.commandExecutionMode)
        return false;
      if (
        review.decision !== "reject" &&
        (review.decision !== "allow_prefix" || canGrantCommandPrefix(request.commandPrefix))
      )
        decision = review.decision;
      else {
        request = { ...request, description: `${request.description}\nApproval agent: ${review.reason}` };
      }
    }
    if (!decision) {
      if (request.allowPrompt === false) {
        this.ctx.threadStore.appendEvent(this.ctx.state.threadId, {
          type: "approval.user_required",
          payload: { id: request.id, source: request.source },
        });
        throw new Error("User approval is required but interactive approval is unavailable");
      }
      decision = await this.ctx.terminal.approve(request);
    }
    if (request.signal?.aborted || threadId !== this.ctx.state.threadId || mode !== this.ctx.commandExecutionMode)
      return false;
    this.ctx.threadStore.appendEvent(threadId, {
      type: "approval.decided",
      payload: { id: request.id, decision, source: request.source },
    });
    if (decision === "reject") {
      request.observeDecision?.("reject");
      this.ctx.terminal.info("Command execution rejected.");
      return false;
    }
    if (decision === "allow_once") {
      request.observeDecision?.("allow_once");
      this.ctx.terminal.info(
        request.executionTiming === "future_resubmission"
          ? "Approved once for the next exact resubmission; the stopped command was not replayed."
          : "Approved once; starting the command.",
      );
      return true;
    }

    // Validate and derive the next in-memory state before writing the
    // authoritative event. If the durable append fails, the exception reaches
    // CommandRuntime and the command fails closed without executing.
    const prefixes = grantCommandApprovalPrefix(this.ctx.state.commandApprovalPrefixes, request.commandPrefix);
    this.ctx.threadStore.recordCommandApprovalPrefixGrant(
      this.ctx.state.threadId,
      request.commandPrefix,
      this.ctx.state.activeTurnId,
    );
    this.ctx.state.commandApprovalPrefixes = prefixes;
    this.ctx.dirty = true;
    request.observeDecision?.("allow_prefix");
    this.ctx.terminal.info(
      `${request.executionTiming === "future_resubmission" ? "Allowed for a future resubmission in this Thread" : "Allowed for this Thread"}: ${formatCommandApprovalPrefix(request.commandPrefix)}`,
    );
    return true;
  }

  requestSubagentApproval(
    request: ApprovalRequest,
    source: { agentId: string; taskId: string; label: string },
  ): Promise<boolean> {
    return this.requestToolApproval({
      ...request,
      source: { agentId: source.agentId, taskId: source.taskId },
      title: `[${source.label}] ${request.title}`,
    });
  }

  async authorizeCatalogToolCall(request: Readonly<ToolExecutionAuthorizationRequest>): Promise<boolean> {
    if (request.binding?.sourceId !== "mcp" && request.binding?.sourceId !== "builtin") {
      return this.ctx.authorizeToolExecution?.(request) ?? false;
    }
    const identity = toolApprovalIdentity(request.tool, request.input, request.binding, request.context.workspaceRoot);
    const parentThreadId = this.ctx.state.threadId;
    const threadId = request.context.threadId;
    const mode = request.context.commandExecutionMode ?? this.ctx.commandExecutionMode;
    const signal = request.context.signal;
    return this.ctx.approvalQueue.run(async () => {
      if (signal?.aborted || parentThreadId !== this.ctx.state.threadId) return false;
      const saved = this.ctx.threadStore.recover(threadId);
      if ((saved.toolApprovalGrants ?? []).includes(identity.key)) {
        return true;
      }
      if (mode === "unrestricted") {
        return true;
      }
      const approvalId = createId("approval");
      let decision: "allow_once" | "allow_same_tool" | "reject" | undefined;
      let reviewerReason: string | undefined;
      if (mode === "auto_approve") {
        const review = await this.ctx.reviewCatalogToolApproval(identity, threadId, request.context.turnId, signal);
        this.ctx.threadStore.appendEvent(threadId, {
          type: "approval.reviewed",
          turnId: request.context.turnId,
          payload: {
            id: approvalId,
            tool: identity.label,
            decision: review.decision,
            reason: review.reason,
            unavailable: review.unavailable ?? false,
          },
        });
        if (review.decision === "reject") {
          reviewerReason = review.reason;
        } else decision = review.decision;
      }
      if (signal?.aborted || parentThreadId !== this.ctx.state.threadId || mode !== this.ctx.commandExecutionMode)
        return false;
      if (!decision) {
        const preview = redactSensitiveInformation(JSON.stringify(identity.input)).slice(0, 300);
        const selected = await this.ctx.terminal.selectChoice(
          `Allow tool ${identity.label}?`,
          [
            { id: "allow_once", label: "Allow this call once", detail: preview },
            { id: "allow_same_tool", label: "Allow this tool in this Thread", detail: "Later arguments may differ" },
            { id: "reject", label: "Reject", detail: reviewerReason?.slice(0, 160) },
          ],
          "allow_once",
          { idleTimeoutMs: DECISION_TIMEOUT_MS, idleChoiceId: "allow_once", signal },
        );
        if (!selected) {
          this.ctx.threadStore.appendEvent(threadId, {
            type: "approval.user_required",
            turnId: request.context.turnId,
            payload: { id: approvalId, tool: identity.label },
          });
          return false;
        }
        decision = selected as "allow_once" | "allow_same_tool" | "reject";
      }
      if (signal?.aborted || parentThreadId !== this.ctx.state.threadId || mode !== this.ctx.commandExecutionMode)
        return false;
      this.ctx.threadStore.appendEvent(threadId, {
        type: "approval.decided",
        turnId: request.context.turnId,
        payload: { id: approvalId, tool: identity.label, decision },
      });
      if (decision === "reject") return false;
      if (decision === "allow_same_tool") {
        this.ctx.threadStore.recordToolApprovalGrant(threadId, identity.key, request.context.turnId);
        if (threadId === this.ctx.state.threadId) {
          this.ctx.state.toolApprovalGrants = [
            ...new Set([...(this.ctx.state.toolApprovalGrants ?? []), identity.key]),
          ];
          this.ctx.dirty = true;
        }
        this.ctx.terminal.info(`Allowed in this Thread: ${identity.label}`);
      }
      return true;
    });
  }
}
