import type { EventRecord, ImageAttachment } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { sanitizeTerminalText } from "../ui/render/layout.js";
import type { WebEntry, WebEntryKind } from "../web-contracts.js";
import { safeToolDisplayDetails } from "../runtime/tool-display-details.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function safe(text: string): string {
  return redactSensitiveInformation(sanitizeTerminalText(text, { allowSgr: false }));
}
function imageLabels(value: unknown): WebEntry["images"] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap(item => {
    const entry = object(item);
    return entry && typeof entry.id === "string" && typeof entry.label === "string" &&
      typeof entry.mediaType === "string"
      ? [{ id: entry.id, label: entry.label, mediaType: entry.mediaType as ImageAttachment["mediaType"] }]
      : [];
  });
}
function toolDetails(value: unknown): WebEntry["toolDetails"] {
  if (!Array.isArray(value)) return undefined;
  const details = safeToolDisplayDetails(value.flatMap(item => {
    const entry = object(item);
    return typeof entry?.label === "string" && typeof entry.value === "string"
      ? [{ label: entry.label, value: entry.value }] : [];
  }));
  return details.length ? details : undefined;
}

/** Project only user-facing conversation facts; never expose raw Journal payloads or credentials. */
export function projectWebHistory(events: readonly EventRecord[]): WebEntry[] {
  const entries: WebEntry[] = [];
  const pendingToolCalls = new Map<string, WebEntry>();
  const turnStartedAt = new Map<string, number>();
  const turnCompletedAt = new Map<string, number>();
  for (const event of events) {
    if (!event.turnId) continue;
    const timestamp = Date.parse(event.timestamp) || 0;
    if ((event.type === "turn.started" || event.type === "message.user") && !turnStartedAt.has(event.turnId)) {
      turnStartedAt.set(event.turnId, timestamp);
    }
    if (event.type === "turn.completed" || event.type === "turn.recovered") {
      turnCompletedAt.set(event.turnId, timestamp);
    }
  }
  const append = (event: EventRecord, kind: WebEntryKind, text: string, suffix = "", images?: WebEntry["images"],
    details?: WebEntry["toolDetails"], toolName?: string, toolStatus?: WebEntry["toolStatus"],
    answerState?: WebEntry["answerState"]): WebEntry | undefined => {
    if (!text.trim() && !images?.length) return undefined;
    const entry: WebEntry = {
      id: `${event.eventId}${suffix}`,
      kind,
      text: safe(text),
      timestamp: Date.parse(event.timestamp) || 0,
      ...(event.turnId ? { turnId: event.turnId, turnStartedAt: turnStartedAt.get(event.turnId) } : {}),
      ...(images?.length ? { images } : {}),
      ...(details?.length ? { toolDetails: details } : {}),
      ...(toolName ? { toolName: safe(toolName) } : {}),
      ...(toolStatus ? { toolStatus } : {}),
      ...(answerState ? { answerState } : {}),
    };
    entries.push(entry);
    return entry;
  };
  for (const event of events) {
    const payload = object(event.payload);
    if (event.type === "message.user") {
      const message = object(payload?.message);
      if (message?.role === "user" && typeof message.content === "string") {
        append(event, "user", message.content, "", imageLabels(message.images));
      }
    } else if (event.type === "turn.steering.queued") {
      const message = object(object(payload?.entry)?.message);
      if (message?.role === "user" && typeof message.content === "string") {
        append(event, "user", message.content, "", imageLabels(message.images));
      }
    } else if (event.type === "message.assistant" || event.type === "message.assistant.synthetic") {
      const message = object(event.payload);
      if (message?.role !== "assistant") continue;
      if (typeof message.reasoning_content === "string") append(event, "thinking", message.reasoning_content, ":thinking");
      if (typeof message.content === "string") append(event, "assistant", message.content, ":answer", undefined,
        undefined, undefined, undefined, message.phase === "final_answer" ? "finalizing" : "streaming");
    } else if (event.type === "tool.call") {
      const call = object(event.payload);
      const fn = object(call?.function);
      if (typeof fn?.name === "string") {
        const entry = append(event, "tool", `Calling ${fn.name}`, ":call", undefined, undefined, fn.name, "running");
        if (entry && typeof call?.id === "string") pendingToolCalls.set(call.id, entry);
      }
    } else if (event.type === "tool.result") {
      const name = typeof payload?.tool === "string" ? payload.tool : "Tool";
      // Journal tool payloads can contain entire files or command output. The
      // conversation needs the outcome, not a replay of private raw evidence.
      const completed = event.phase === "completed";
      const text = `${completed ? "✓" : "✗"} ${name} — ${event.phase ?? "completed"}`;
      const callId = typeof payload?.callId === "string" ? payload.callId : undefined;
      const pending = callId ? pendingToolCalls.get(callId) : undefined;
      if (pending) {
        pending.text = safe(text);
        pending.toolName = safe(name);
        pending.toolStatus = completed ? "completed" : "failed";
        pending.toolDetails = toolDetails(payload?.toolDetails);
        pendingToolCalls.delete(callId!);
      } else {
        append(event, "tool", text, ":result", undefined, toolDetails(payload?.toolDetails),
          name, completed ? "completed" : "failed");
      }
    }
  }
  for (const [turnId, completedAt] of turnCompletedAt) {
    const turnEntries = entries.filter(entry => entry.turnId === turnId);
    const finalAnswer = [...turnEntries].reverse().find(entry => entry.kind === "assistant");
    const terminal = finalAnswer ?? turnEntries.at(-1);
    if (!terminal) continue;
    for (const entry of turnEntries) {
      if (entry.kind === "assistant" && entry.answerState === "finalizing") entry.answerState = "streaming";
    }
    terminal.turnCompletedAt = completedAt;
    if (finalAnswer) finalAnswer.answerState = "confirmed";
  }
  return entries;
}
