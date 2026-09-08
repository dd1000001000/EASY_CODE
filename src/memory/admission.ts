import { estimatedTokens } from "../context/token-budget.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";

/** Conservative rejection of obvious task diaries, not a semantic truth classifier. */
export function isTransientMemory(content: string): boolean {
  return /(?:本次任务|这一轮|本轮任务|本次运行|刚刚运行|临时假设|未验证假设|this task|this run|in this turn|today I|temporary hypothesis|Traceback \(most recent call last\)|\b\d+ tests? passed\b)/iu.test(content);
}

export function assertDurableMemory(content: string, limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS): void {
  if (isTransientMemory(content)) throw new Error("Task-local logs, results and temporary hypotheses belong in Journal/checkpoints, not long-term memory. Keep only a stable cross-task fact.");
  if (estimatedTokens(content) > limits.maxDurableMemoryTokens) throw new Error("Durable memory exceeds limits.maxDurableMemoryTokens; retain one concise cross-task fact without dropping its qualification.");
}
