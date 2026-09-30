import { z } from "zod";
import type { ModelProvider, ModelRequest, ProviderResponse, ProviderUsage } from "../core/types.js";
import type { TaskBudget } from "./task-budget.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { completeWithApiRetries, incompleteModelOutput, type ApiAttempt } from "./model-retry.js";
import { resetRequestHistory } from "../context/server-reset.js";
import { estimatedTokens } from "../context/token-budget.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { displayTextSchema, projectText } from "../utils/bounded-text.js";

/** A reviewer's verdict. `unavailable` marks a rejection caused by the review itself failing. */
export interface ApprovalVerdict<D extends string> {
  decision: D;
  reason: string;
  unavailable?: boolean;
}

/** Model access and output bounds shared by the command and tool approval agents. */
export interface ApprovalReviewOptions {
  readonly provider: ModelProvider;
  readonly budget: TaskBudget;
  readonly maxOutputTokens: number;
  readonly limits?: Readonly<RuntimeLimits>;
  readonly onUsage?: (usage?: ProviderUsage, attempt?: ApiAttempt) => void;
  readonly onResponse?: (response: Readonly<ProviderResponse>) => void;
}

/**
 * Ask a tool-free reviewer for one of `decisions` about an already-redacted evidence packet.
 * Malformed output gets bounded content corrections; any failure rejects and escalates to the user.
 * No decision or permission is ever inferred from a broken response.
 */
export async function runApprovalReview<D extends string>(
  review: {
    readonly decisions: readonly [D, ...D[]];
    readonly systemPrompt: string;
    readonly packet: string;
    readonly signal: AbortSignal | undefined;
  },
  options: ApprovalReviewOptions,
): Promise<ApprovalVerdict<D | "reject">> {
  const limits = options.limits ?? DEFAULT_RUNTIME_LIMITS;
  const reportSchema = z.object({ decision: z.enum(review.decisions), reason: displayTextSchema(2000) }).strict();
  const input: ModelRequest = {
    messages: [
      { role: "system", content: review.systemPrompt },
      { role: "user", content: review.packet },
    ],
    responseMode: "stream",
    maxRetries: 0,
    thinkingEffort: "none",
    outputReserveTokens: limits.maxResponseTokens.none,
    signal: review.signal,
  };
  let capacityResets = 0;
  try {
    let reason = "Approval output was invalid.";
    for (let correction = 0; correction <= limits.modelContentRetries; correction++) {
      const response = await completeWithApiRetries(options.provider, input, {
        limits,
        reserve: (value) => options.budget.reserve(value),
        onSettled: (attempt) =>
          options.onUsage?.(attempt.usage, { ...attempt, retry: attempt.retry || correction > 0 }),
        resetContext: async (value) => {
          if (capacityResets >= limits.contextMaxCapacityRetries)
            throw new Error("context_capacity_insufficient: approval context reset exhausted");
          capacityResets++;
          const reset = resetRequestHistory(value);
          input.messages = reset.messages;
          return reset;
        },
      });
      options.onResponse?.(response);
      try {
        const incomplete = incompleteModelOutput(response);
        if (incomplete) throw new Error(incomplete);
        if (response.message.tool_calls?.length) throw new Error("Approval agent attempted a tool call");
        // Zod cannot resolve optionality through a generic enum; the schema requires both fields.
        const report = reportSchema.parse(JSON.parse(response.message.content ?? "")) as {
          decision: D;
          reason: string;
        };
        const projected = projectText(redactSensitiveInformation(report.reason), options.maxOutputTokens, (value) =>
          estimatedTokens(JSON.stringify({ ...report, reason: value + " [truncated]" })),
        );
        return { ...report, reason: projected.text + (projected.truncated ? " [truncated]" : "") };
      } catch (error) {
        reason = redactSensitiveInformation(String(error)).slice(0, 2000);
        input.messages.push({
          role: "user",
          content: `RUNTIME_APPROVAL_CONTENT_ERROR: ${reason} Return complete JSON with decision and reason. Do not run tools.`,
        });
      }
    }
    return {
      decision: "reject",
      reason: `Approval content corrections exhausted; user review required. ${reason}`,
      unavailable: true,
    };
  } catch (error) {
    return {
      decision: "reject",
      reason: redactSensitiveInformation(String(error)).slice(0, 2000),
      unavailable: true,
    };
  }
}
