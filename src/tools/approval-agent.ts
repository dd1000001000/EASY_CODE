import { z } from "zod";
import type { ModelProvider, ModelRequest, ProviderResponse, ProviderUsage } from "../core/types.js";
import type { TaskBudget } from "../runtime/task-budget.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { completeWithApiRetries, incompleteModelOutput, type ApiAttempt } from "../runtime/model-retry.js";
import { resetRequestHistory } from "../context/server-reset.js";
import { estimatedTokens } from "../context/token-budget.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { displayTextSchema, projectText } from "../utils/bounded-text.js";
import type { ToolApprovalIdentity } from "./approval.js";

export type ToolApprovalDecision = "allow_once" | "allow_same_tool" | "reject";
export interface ToolApprovalReview { decision: ToolApprovalDecision; reason: string; unavailable?: boolean }
export interface ToolApprovalAgentOptions {
  readonly provider: ModelProvider;
  readonly budget: TaskBudget;
  readonly systemPrompt: string;
  readonly maxInputChars: number;
  readonly maxOutputTokens: number;
  readonly limits?: Readonly<RuntimeLimits>;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage?: ProviderUsage, attempt?: ApiAttempt) => void;
  readonly onResponse?: (response: Readonly<ProviderResponse>) => void;
}

const reportSchema = z.object({ decision: z.enum(["allow_once", "allow_same_tool", "reject"]),
  reason: displayTextSchema(2000) }).strict();

/** Tool-free reviewer. A refusal or malformed response always escalates to the user. */
export async function reviewToolApproval(identity: ToolApprovalIdentity, userTask: string,
  options: ToolApprovalAgentOptions): Promise<ToolApprovalReview> {
  const limits = options.limits ?? DEFAULT_RUNTIME_LIMITS;
  const packet = redactSensitiveInformation(JSON.stringify({ userTask, operation: identity.label,
    toolDescription: identity.description,
    effects: identity.effects, arguments: identity.input,
    repeatedGrant: "The same concrete operation in this Thread; arguments may differ." }));
  if (packet.length > options.maxInputChars || options.signal?.aborted) {
    return { decision: "reject", reason: "Tool approval evidence is unavailable or exceeds the review budget; user review required.", unavailable: true };
  }
  const input: ModelRequest = { messages: [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: packet },
  ], responseMode: "stream", maxRetries: 0, thinkingEffort: "none",
    outputReserveTokens: limits.maxResponseTokens.none, signal: options.signal };
  let capacityResets = 0;
  try {
    let reason = "Approval output was invalid.";
    for (let correction = 0; correction <= limits.modelContentRetries; correction++) {
      const response = await completeWithApiRetries(options.provider, input, {
        limits, reserve: value => options.budget.reserve(value),
        onSettled: attempt => options.onUsage?.(attempt.usage, { ...attempt, retry: attempt.retry || correction > 0 }),
        resetContext: async value => {
          if (capacityResets >= limits.contextMaxCapacityRetries) throw new Error("context_capacity_insufficient: approval context reset exhausted");
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
        const report = reportSchema.parse(JSON.parse(response.message.content ?? ""));
        const projected = projectText(redactSensitiveInformation(report.reason), options.maxOutputTokens,
          value => estimatedTokens(JSON.stringify({ ...report, reason: value + " [truncated]" })));
        return { ...report, reason: projected.text + (projected.truncated ? " [truncated]" : "") };
      } catch (error) {
        reason = redactSensitiveInformation(String(error)).slice(0, 2000);
        input.messages.push({ role: "user", content: `RUNTIME_APPROVAL_CONTENT_ERROR: ${reason} Return complete JSON with decision and reason. Do not run tools.` });
      }
    }
    return { decision: "reject", reason: `Approval content corrections exhausted; user review required. ${reason}`, unavailable: true };
  } catch (error) {
    return { decision: "reject", reason: redactSensitiveInformation(String(error)).slice(0, 2000), unavailable: true };
  }
}
