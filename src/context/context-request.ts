import type { ChatMessage, SessionState, ToolDefinition } from "../core/types.js";
import { shortTermMessages } from "./manager.js";
import { runtimeContinuityMessage } from "./runtime-state.js";

export interface NormalRequestEnvelope {
  systemPrompt: string; runtimeContext: string; tools: readonly ToolDefinition[]; reservedTokens?: number;
}

/** Same unabridged projection used for normal token-managed requests. */
export function exactContext(state: Readonly<SessionState>, envelope: NormalRequestEnvelope): ChatMessage[] {
  return [
    { role: "system", content: envelope.systemPrompt },
    ...shortTermMessages(state),
    ...[runtimeContinuityMessage(state), envelope.runtimeContext].filter(Boolean)
      .map((content): ChatMessage => ({ role: "user", content })),
  ];
}
