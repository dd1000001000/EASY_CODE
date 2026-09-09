import type { ChatMessage, SessionState } from "../core/types.js";
import { sha256 } from "../utils/hash.js";

export interface PressureRecoveryState {
  toolReferences: number[];
  summaries: Record<string, string>;
  serverReset?: import("./server-reset.js").ServerContextReset;
  reconciliation?: import("./reconciliation.js").ContextReconciliation;
  rebase?: { scope: string; count: number };
  maintenance?: { historyHash: string; requestKey: string; usage?: number; capacity?: number;
    paused?: import("./capacity.js").CapacityPause };
}

/** Projection only: canonical messages and their tool-call bindings never change. */
export function pressureProjectedMessages(state: Readonly<SessionState>): ChatMessage[] {
  const references = new Set(state.pressureRecovery?.toolReferences ?? []);
  return state.messages.map((message, index) => {
    if (index < state.compactedMessageCount || message.role !== "tool" || !references.has(index)) return message;
    return toolOutputReference(message, index);
  });
}

export function toolOutputReference(message: Extract<ChatMessage, { role: "tool" }>, index: number): ChatMessage {
    let observation: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(message.content);
      const data = raw?.data;
      observation = { ...(typeof raw?.ok === "boolean" ? { ok: raw.ok } : {}),
        ...(typeof raw?.summary === "string" ? { summaryExcerpt: raw.summary.slice(0, 512) } : {}),
        ...(typeof data?.commandId === "string" ? { commandId: data.commandId } : {}),
        ...(typeof data?.status === "string" ? { status: data.status } : {}),
        ...(typeof data?.exitCode === "number" || data?.exitCode === null ? { exitCode: data.exitCode } : {}),
        ...(typeof raw?.evidenceId === "string" ? { capturedEvidenceId: raw.evidenceId } : {}),
        ...(typeof data?.path === "string" ? { path: data.path } : {}),
        ...(typeof data?.contentHash === "string" ? { fileHash: data.contentHash } : {}),
        ...(typeof data?.startLine === "number" ? { startLine: data.startLine, endLine: data.endLine } : {}),
        ...(data?.validation ? { validation: { status: data.validation.status, confidence: data.validation.confidence,
          source: data.validation.source, standard: data.validation.standard?.status } } : {}) };
    } catch { /* A reference never invents an outcome for opaque output. */ }
    return { ...message, content: JSON.stringify({
      ...observation,
      contextNotice: "Tool output moved out of active context, NOT summarized or verified. Recall before relying on omitted details.",
      evidenceId: `journal_message_${index}`, digest: sha256(message.content),
      shortRef: `artifact:${sha256(message.content).slice(0, 12)}`,
      totalChars: message.content.length,
      recovery: "recall_context: evidenceId, offset=0, limit=4000. Historical evidence is not current file state.",
    }) };
}
