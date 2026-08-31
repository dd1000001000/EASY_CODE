import type { EasyCodeConfig, SessionState } from "../core/types.js";
import { clonePlanReviewState } from "../plans/plan.js";
import { cloneTaskGraph } from "../tasks/task-graph.js";
import { createId } from "../utils/ids.js";

export function createSessionState(
  config: EasyCodeConfig,
  threadId = createId("thread")
): SessionState {
  const now = new Date().toISOString();
  const provider = config[config.provider];
  return {
    threadId,
    mode: config.mode,
    provider: config.provider,
    model: provider.model,
    thinkingEffort: config.thinkingEffort,
    workspaceRoot: config.workspaceRoot,
    constraints: [],
    messages: [],
    filesRead: new Map(),
    changes: [],
    commands: [],
    commandApprovalPrefixes: [],
    pendingSteering: [],
    steeringSequence: 0,
    steeringWatermark: 0,
    workingSummary: "",
    compactedMessageCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

export function cloneSessionState(state: SessionState): SessionState {
  return {
    ...state,
    constraints: [...state.constraints],
    messages: [...state.messages],
    filesRead: new Map(state.filesRead),
    changes: [...state.changes],
    commands: [...state.commands],
    commandApprovalPrefixes: [...state.commandApprovalPrefixes],
    ...(state.taskGraph ? { taskGraph: cloneTaskGraph(state.taskGraph) } : {}),
    ...(state.planReview ? { planReview: clonePlanReviewState(state.planReview) } : {}),
    pendingSteering: (state.pendingSteering ?? []).map((entry) => ({
      ...entry,
      message: {
        ...entry.message,
        ...(entry.message.images
          ? { images: entry.message.images.map((image) => ({ ...image })) }
          : {}),
      },
    })),
    steeringSequence: state.steeringSequence ?? 0,
    steeringWatermark: state.steeringWatermark ?? 0,
  };
}
