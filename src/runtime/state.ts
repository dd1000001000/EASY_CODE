import type { EasyCodeConfig, SessionState } from "../core/types.js";
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
    commands: [...state.commands]
  };
}
