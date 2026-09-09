import type { ChatMessage, SessionState } from "../core/types.js";

/** Protocol boundaries, not semantic phases. No call/result group may be split. */
export function completeExchange(messages: readonly ChatMessage[], end = messages.length): boolean {
  if (!Number.isInteger(end) || end < 0 || end > messages.length) return false;
  const pending = new Set<string>();
  for (const m of messages.slice(0, end)) {
    if (m.role === "assistant") {
      if (pending.size) return false;
      for (const call of m.tool_calls ?? []) {
        if (pending.has(call.id)) return false;
        pending.add(call.id);
      }
    } else if (m.role === "tool") {
      if (!pending.delete(m.tool_call_id)) return false;
    } else if (pending.size) return false;
  }
  return pending.size === 0;
}

export function exchangeStarts(state: Readonly<SessionState>): number[] {
  if (!completeExchange(state.messages)) return [];
  return state.messages.flatMap((message, index) =>
    message.role === "assistant" && index >= state.compactedMessageCount ? [index] : []);
}

/** Oldest sufficient prefix first: prefer N recent exchanges, then N-1 ... 1. */
export function retirementBoundaries(state: Readonly<SessionState>, retain: number): number[] {
  const starts = exchangeStarts(state);
  return starts.slice(-Math.max(1, retain))
    .filter((end) => end > state.compactedMessageCount && end > (starts[0] ?? end));
}

/** Semantic maintenance preserves at least the recent tail and retires only
 * the smallest sufficient OLD prefix. Emergency eviction has a separate path. */
export function summaryRetirementBoundaries(state: Readonly<SessionState>, retain: number): number[] {
  const starts = exchangeStarts(state).filter(index => {
    const message = state.messages[index]!;
    return !(message.role === "assistant" && message.tool_calls?.length &&
      message.tool_calls.every(call => call.function.name === "poll_command"));
  });
  const protectedStart = starts.at(-Math.max(1, retain));
  if (protectedStart === undefined || starts.length <= retain) return [];
  return starts.filter(end => end > state.compactedMessageCount && end > starts[0]! && end <= protectedStart);
}
