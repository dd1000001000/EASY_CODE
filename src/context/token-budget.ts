import type { ChatMessage, ModelRequest, ToolDefinition } from "../core/types.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";

/** Provider-neutral conservative estimate. Not a claim to be a native tokenizer. */
export function estimatedTokens(value: string): number {
  let ascii = 0;
  let other = 0;
  for (const point of value) point.codePointAt(0)! <= 127 ? ascii += 1 : other += 1;
  return Math.ceil((Math.ceil(ascii / 4) + other) * 1.2);
}

export interface TokenBudget {
  window: number;
  outputReserve: number;
  toolReserve: number;
  safetyReserve: number;
  inputCapacity: number;
}

export function tokenBudget(window: number, limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS): TokenBudget {
  if (!Number.isSafeInteger(window) || window < 4096) throw new Error("maxContextTokens must be at least 4096");
  const outputReserve = Math.min(limits.maxResponseTokens, Math.floor(window * limits.contextOutputReserveRatio));
  const toolReserve = Math.min(limits.contextToolReserveTokens, Math.floor(window * limits.contextToolReserveRatio));
  const safetyReserve = Math.max(limits.contextSafetyReserveTokens, Math.ceil(window * limits.contextSafetyReserveRatio));
  if (window - outputReserve - toolReserve - safetyReserve < 1024) throw new Error("Context reserves leave insufficient input capacity");
  return { window, outputReserve, toolReserve, safetyReserve,
    inputCapacity: window - outputReserve - toolReserve - safetyReserve };
}

const messageEstimates = new WeakMap<ChatMessage, { content: string | null; reasoning: string; calls: string; vision: number; role: string; tokens: number }>();

export function requestTokens(messages: readonly ChatMessage[], tools: readonly ToolDefinition[] = []): number {
  return messages.reduce((sum, message) => {
    const content = message.content ?? "";
    const reasoning = message.role === "assistant" ? message.reasoning_content ?? "" : "";
    const calls = message.role === "assistant" ? JSON.stringify(message.tool_calls ?? []) : "";
    const vision = message.role === "user" ? (message.images ?? []).reduce((total, image) => total +
      Math.ceil(image.width / 32) * Math.ceil(image.height / 32) + 2, 0) : 0;
    const saved = messageEstimates.get(message);
    if (saved && saved.content === content && saved.reasoning === reasoning && saved.calls === calls && saved.vision === vision && saved.role === message.role)
      return sum + saved.tokens;
    const tokens = 12 + estimatedTokens(content) + (message.role === "assistant" ? estimatedTokens(reasoning) + estimatedTokens(calls) : 0) + vision;
    messageEstimates.set(message, { content, reasoning, calls, vision, role: message.role, tokens });
    return sum + tokens;
  }, 0) + estimatedTokens(JSON.stringify(tools));
}

export function budgetedRequest(request: ModelRequest, budget: TokenBudget | undefined,
  estimate = requestTokens): ModelRequest {
  if (!budget) return request;
  const outputReserveTokens = request.outputReserveTokens ?? budget.outputReserve;
  if (estimate(request.messages, request.tools) + outputReserveTokens + budget.toolReserve + budget.safetyReserve > budget.window) {
    throw new Error("context_capacity_insufficient: protected request exceeds the configured token window; history was preserved");
  }
  return { ...request, outputReserveTokens };
}
