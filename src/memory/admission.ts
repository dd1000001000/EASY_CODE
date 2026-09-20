import { estimatedTokens } from "../context/token-budget.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";

export function assertDurableMemory(content: string, limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS): void {
  if (estimatedTokens(content) > limits.maxDurableMemoryTokens) throw new Error("Durable memory exceeds limits.maxDurableMemoryTokens; retain one concise cross-task fact without dropping its qualification.");
}
