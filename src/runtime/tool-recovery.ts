import type { AgentRunResult } from "../core/types.js";

export const MAX_TOOL_PROTOCOL_ATTEMPTS = 3;
export const MAX_TOOL_CORRECTION_STEPS = MAX_TOOL_PROTOCOL_ATTEMPTS - 1;

/** Counts model corrections, never executes or replays a tool. */
export class ToolRecoveryBudget {
  private readonly failures = new Map<string, number>();
  constructor(private readonly maximumAttempts = MAX_TOOL_PROTOCOL_ATTEMPTS,
    private readonly toolAttempts: Readonly<Record<string, number>> = {}) {}

  fail(tool: string): { attempt: number; remaining: number } {
    const attempt = (this.failures.get(tool) ?? 0) + 1;
    this.failures.set(tool, attempt);
    return { attempt, remaining: Math.max(0, (this.toolAttempts[tool] ?? this.maximumAttempts) - attempt) };
  }

  succeed(tool: string): void { this.failures.delete(tool); }
}

export class ToolProtocolExhausted extends Error {
  readonly failure: NonNullable<AgentRunResult["failure"]>;
  constructor(tool: string, attempts: number, readonly steps: number, persistentBudget = false) {
    const code = tool === "compact_context" ? "context_compaction_failed" : "tool_protocol_failed";
    super(`${code}: ${tool} did not complete its required protocol after ${attempts} attempts. ` +
      "Work is paused, not completed. The existing history and unaccepted candidate remain available. " +
      (tool === "compact_context" ? "No compaction boundary was advanced by this failure. " : "") +
      (persistentBudget ? "The transaction's attempts remain consumed after Resume; inspect its durable candidate and validation feedback."
        : "Resume explicitly to retry with a fresh bounded correction budget."));
    this.name = "ToolProtocolExhausted";
    this.failure = { code, tool, attempts, recoverable: true };
  }
}
