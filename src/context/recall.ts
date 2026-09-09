import type { SessionState, ToolExecutionResult } from "../core/types.js";
import { recallCompactionEvidence } from "./semantic-compaction.js";
import { sha256 } from "../utils/hash.js";

/** Only a parent that owns this durable session can expand explicitly published
 * participant evidence. No arbitrary model-selected peer thread is accepted. */
export function sharedReviewEvidenceOwner(state: Readonly<SessionState>, id: string): string {
  for (const session of state.reviewSessions ?? []) {
    const owner = session.experiments.find(e => e.id === id)?.actor ?? session.statements.find(s => s.value.evidenceRefs.includes(id))?.actor;
    if (owner && session.actorThreads) return session.actorThreads[owner];
  }
  return state.threadId;
}

/** The caller supplies the actor's own state. No model-selected thread is accepted. */
export function recallThreadContext(state: Readonly<SessionState>,
  input: { evidenceId: string; offset: number; limit: number },
  external?: (id: string, offset: number, limit: number) => object): ToolExecutionResult {
  let id = input.evidenceId;
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 16000)
    throw new Error("Invalid evidence page");
  if (id.startsWith("review:")) {
    const match = /^review:([^:]+):(author|reviewer|briefing)$/u.exec(id);
    const session = match && state.reviewSessions?.find(session => session.id === match[1]);
    const summary = session && (match![2] === "briefing" ? session.briefing : session.summaries[match![2] as "author" | "reviewer"]);
    if (!summary) throw new Error("Review summary not found in this thread");
    if (input.offset > summary.full.length) throw new Error("Evidence offset exceeds captured content");
    return { ok: true, summary: "Independent historical review opinion, not a verified fact.", data: {
      evidenceId: id, content: summary.full.slice(input.offset, input.offset + input.limit),
      nextOffset: input.offset + input.limit < summary.full.length ? input.offset + input.limit : null,
      totalChars: summary.full.length, historical: true } };
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
  const result = recallCompactionEvidence(state, JSON.stringify({ ...input, evidenceId: id, action: "recall" }));
  if (result) return result;
  if (!external) throw new Error("Captured evidence reader unavailable");
  return { ok: true, summary: "Historical captured evidence, not current file or test state.",
    data: external(id, input.offset, input.limit) };
}
