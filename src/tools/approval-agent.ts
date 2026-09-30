import { redactSensitiveInformation } from "../memory/sensitive.js";
import { runApprovalReview, type ApprovalReviewOptions, type ApprovalVerdict } from "../runtime/approval-review.js";
import type { ToolApprovalIdentity } from "./approval.js";

export type ToolApprovalDecision = "allow_once" | "allow_same_tool" | "reject";
export type ToolApprovalReview = ApprovalVerdict<ToolApprovalDecision>;
export interface ToolApprovalAgentOptions extends ApprovalReviewOptions {
  readonly systemPrompt: string;
  readonly maxInputChars: number;
  readonly signal?: AbortSignal;
}

/** Tool-free reviewer. A refusal or malformed response always escalates to the user. */
export async function reviewToolApproval(
  identity: ToolApprovalIdentity,
  userTask: string,
  options: ToolApprovalAgentOptions,
): Promise<ToolApprovalReview> {
  const packet = redactSensitiveInformation(
    JSON.stringify({
      userTask,
      operation: identity.label,
      toolDescription: identity.description,
      effects: identity.effects,
      arguments: identity.input,
      repeatedGrant: "The same concrete operation in this Thread; arguments may differ.",
    }),
  );
  if (packet.length > options.maxInputChars || options.signal?.aborted) {
    return {
      decision: "reject",
      reason: "Tool approval evidence is unavailable or exceeds the review budget; user review required.",
      unavailable: true,
    };
  }
  return runApprovalReview(
    {
      decisions: ["allow_once", "allow_same_tool", "reject"],
      systemPrompt: options.systemPrompt,
      packet,
      signal: options.signal,
    },
    options,
  );
}
