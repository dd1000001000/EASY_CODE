/** Repairs applied when a Thread is opened or resumed: interrupted turns, orphaned child tasks, and the resume summary. */

import type { ChatMessage, SessionState } from "../core/types.js";
import { toResultArtifactRef } from "../subagents/coordinator.js";
import { ThreadStore } from "../threads/thread-store.js";
import { interruptedTurnAssistantMessage } from "../threads/event-replay.js";
import { applySubagentTaskOperation, taskGraphView } from "../tasks/task-graph.js";
import { createId } from "../utils/ids.js";
import { type WorkspaceRestoreSummary } from "../workspace/manager.js";

export interface ResumeRecoverySummary {
  readonly threadId: string;
  readonly messageCount: number;
  readonly compactedMessageCount: number;
  readonly workingSummaryRestored: boolean;
  readonly restoredReasoningBlocks: number;
  readonly restoredReadVersions: number;
  readonly staleReadVersions: number;
  readonly restoredChanges: number;
  readonly discardedChanges: number;
  readonly restoredCommands: number;
  readonly interruptedTurnRepaired: boolean;
  readonly reconciledSubagentAssignments: number;
  readonly recoveredStandaloneSubagents: number;
  readonly taskGraph?: {
    readonly id: string;
    readonly status: string;
    readonly completed: number;
    readonly total: number;
    readonly currentTask?: string;
  };
  readonly planReview?: {
    readonly id: string;
    readonly revision: number;
    readonly status: string;
  };
}

export function repairInterruptedTurn(threadStore: ThreadStore, state: SessionState): boolean {
  const turnId = state.activeTurnId;
  if (!turnId) return false;
  const interruptedPlanReview = threadStore.interruptedPlanReview(state.threadId, turnId);
  const finalAssistantWasDurable = threadStore.hasDurableFinalAssistant(state.threadId, turnId);

  const repairedMessages: ChatMessage[] = [];
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const candidate = state.messages[index];
    if (candidate?.role !== "assistant" || !candidate.tool_calls?.length) continue;
    const completedCallIds = new Set(
      state.messages
        .slice(index + 1)
        .filter((message): message is Extract<ChatMessage, { role: "tool" }> => message.role === "tool")
        .map((message) => message.tool_call_id),
    );
    for (const call of candidate.tool_calls) {
      if (completedCallIds.has(call.id)) continue;
      const toolMessage: Extract<ChatMessage, { role: "tool" }> = {
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify({
          ok: false,
          summary: "Tool execution was interrupted before a result was recorded.",
          error: "interrupted",
        }),
      };
      repairedMessages.push(toolMessage);
    }
    break;
  }

  if (!finalAssistantWasDurable) {
    repairedMessages.push({
      role: "assistant",
      content: interruptedTurnAssistantMessage(),
    });
  }
  threadStore.appendEvent(state.threadId, {
    turnId,
    type: "turn.recovered",
    phase: "completed",
    payload: {
      reason: "interrupted",
      steps: 0,
      recovered: true,
      messages: repairedMessages,
      ...(interruptedPlanReview ? { planReview: interruptedPlanReview } : {}),
    },
  });
  state.messages.push(...repairedMessages);
  if (interruptedPlanReview) state.planReview = interruptedPlanReview;
  state.activeTurnId = undefined;
  state.updatedAt = new Date().toISOString();
  return true;
}

/** Reconcile child claims that cannot survive a process/thread boundary. */
export function releaseOrphanedSubagentTasks(
  threadStore: ThreadStore,
  state: SessionState,
  reason = "The owning child runtime is no longer active.",
): number {
  let released = 0;
  const resumableBindings = new Set(
    threadStore
      .unobservedSubagentAssignments(state.threadId)
      .filter(
        (entry) =>
          Boolean(entry.assignment.childThreadId) &&
          Boolean(entry.assignment.environmentId) &&
          !threadStore.hasCommittedSubagentStop(state.threadId, entry.assignment.agentId),
      )
      .map((entry) => entry.assignment.agentId),
  );
  while (state.taskGraph) {
    const orphan = state.taskGraph.tasks.find(
      (task) =>
        task.owner === "subagent" &&
        task.status === "in_progress" &&
        Boolean(task.assignedAgentId) &&
        !resumableBindings.has(task.assignedAgentId as string),
    );
    if (!orphan?.assignedAgentId) break;
    const turnId = createId("turn");
    const durableResult = threadStore.latestSubagentResult(state.threadId, orphan.assignedAgentId, orphan.id);
    const stopWasCommitted = threadStore.hasCommittedSubagentStop(state.threadId, orphan.assignedAgentId);
    const completedReport =
      !stopWasCommitted &&
      durableResult?.reason === "completed" &&
      durableResult.report?.outcome === "completed" &&
      durableResult.report.taskId === orphan.id &&
      durableResult.report.completionEvidence.length === orphan.completionChecks.length &&
      durableResult.report.completionEvidence.every((item, index) => item.check === orphan.completionChecks[index])
        ? durableResult.report
        : undefined;
    const operation = completedReport
      ? {
          action: "complete" as const,
          taskId: orphan.id,
          agentId: orphan.assignedAgentId,
          evidence: completedReport.completionEvidence.map((item) => item.evidence),
          ...(durableResult?.resultArtifact
            ? { resultArtifact: toResultArtifactRef(durableResult.resultArtifact) }
            : {}),
        }
      : {
          action: "release" as const,
          taskId: orphan.id,
          agentId: orphan.assignedAgentId,
        };
    const next = applySubagentTaskOperation(state.taskGraph, operation, { turnId });
    threadStore.appendEvent(state.threadId, {
      turnId,
      type: "subagent.reconciled",
      phase: "completed",
      payload: {
        taskGraph: next,
        subagentTaskOperation: operation,
        agentId: orphan.assignedAgentId,
        taskId: orphan.id,
        reason: completedReport ? "Recovered the child's durable verified result." : reason,
        ...(completedReport ? { report: completedReport } : {}),
      },
    });
    state.taskGraph = next;
    state.updatedAt = next.updatedAt;
    released += 1;
  }
  return released;
}

export function resumeRecoverySummary(
  state: Readonly<SessionState>,
  workspace: Readonly<WorkspaceRestoreSummary>,
  options: {
    interruptedTurnRepaired: boolean;
    reconciledSubagentAssignments: number;
  },
): ResumeRecoverySummary {
  const graph = state.taskGraph ? taskGraphView(state.taskGraph) : undefined;
  return {
    threadId: state.threadId,
    messageCount: state.messages.length,
    compactedMessageCount: state.compactedMessageCount,
    workingSummaryRestored: Boolean(state.workingSummary.trim()),
    restoredReasoningBlocks: state.messages.reduce(
      (count, message) => count + (message.role === "assistant" && message.reasoning_content?.trim() ? 1 : 0),
      0,
    ),
    restoredReadVersions: workspace.restoredReadVersions,
    staleReadVersions: workspace.staleReadVersions,
    restoredChanges: workspace.restoredChanges,
    discardedChanges: workspace.discardedChanges,
    restoredCommands: state.commands.length,
    interruptedTurnRepaired: options.interruptedTurnRepaired,
    reconciledSubagentAssignments: options.reconciledSubagentAssignments,
    recoveredStandaloneSubagents: 0,
    ...(graph
      ? {
          taskGraph: {
            id: graph.id,
            status: graph.status,
            completed: graph.completed,
            total: graph.total,
            ...(graph.currentTask ? { currentTask: graph.currentTask } : {}),
          },
        }
      : {}),
    ...(state.planReview
      ? {
          planReview: {
            id: state.planReview.proposal.id,
            revision: state.planReview.proposal.revision,
            status: state.planReview.status,
          },
        }
      : {}),
  };
}
