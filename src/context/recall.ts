import type { SessionState, ToolExecutionResult } from "../core/types.js";
import { recallCompactionEvidence } from "./semantic-compaction.js";
import { sha256 } from "../utils/hash.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";

/** Only a parent that owns this durable session can expand explicitly published
 * participant evidence. No arbitrary model-selected peer thread is accepted. */
export function sharedReviewEvidenceOwner(state: Readonly<SessionState>, id: string): string {
  for (const session of state.reviewSessions) {
    if (session.evidenceIds.includes(id)) return session.reviewerThreadId;
  }
  return state.threadId;
}

/** The caller supplies the actor's own state. No model-selected thread is accepted. */
export function recallThreadContext(state: Readonly<SessionState>,
  input: { evidenceId: string; offset: number; limit: number },
  external?: (id: string, offset: number, limit: number) => object,
  limits = DEFAULT_RUNTIME_LIMITS): ToolExecutionResult {
  let id = input.evidenceId;
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > limits.evidenceRecallMaxChars)
    throw new Error("Invalid evidence page");
  if (id.startsWith("review:")) {
    const match = /^review:([^:]+):(brief|report)$/u.exec(id);
    const session = match && state.reviewSessions?.find(session => session.id === match[1]);
    const content = session && (match![2] === "brief" ? session.brief : session.report && JSON.stringify(session.report));
    if (!content) throw new Error("Review material not found in this thread");
    if (input.offset > content.length) throw new Error("Evidence offset exceeds captured content");
    return { ok: true, summary: "Independent historical review opinion, not a verified fact.", data: {
      evidenceId: id, content: content.slice(input.offset, input.offset + input.limit),
      nextOffset: input.offset + input.limit < content.length ? input.offset + input.limit : null,
      totalChars: content.length, historical: true } };
  }
  if (id.startsWith("artifact:")) {
    const prefix = id.slice(9);
    if (!/^[a-f0-9]{8,64}$/u.test(prefix)) throw new Error("Invalid artifact prefix");
    const matches = state.messages.flatMap((message, index) =>
      message.role === "tool" && sha256(message.content).startsWith(prefix) ? [index] : []);
    const identities = new Set(matches.map(index => sha256(state.messages[index]!.content ?? "")));
    if (identities.size > 1) throw new Error("Ambiguous artifact prefix; supply a longer digest");
    if (!matches.length) throw new Error("Artifact not found in this thread");
    id = `journal_message_${matches[0]}`;
  }
  const result = recallCompactionEvidence(state, JSON.stringify({ ...input, evidenceId: id, action: "recall" }), limits);
  if (result) return result;
  if (!external) throw new Error("Captured evidence reader unavailable");
  return { ok: true, summary: "Historical captured evidence, not current file or test state.",
    data: external(id, input.offset, input.limit) };
}
