import { formatUserTranscriptEntry } from "../../cli/disclosure-render.js";
import type { UITranscriptEntry } from "../contracts.js";

const CONVERSATION_ITEM_KINDS = new Set<UITranscriptEntry["kind"]>(["user", "assistant", "tool"]);

/**
 * Text of one transcript entry as Ink should print it. Scrollback text carries
 * its own line terminators, but Ink treats every trailing newline as a visible
 * row. Conversation items therefore get exactly one blank row above them, and
 * everything else loses only its final terminator.
 */
export function transcriptEntryText(entry: Readonly<UITranscriptEntry>): string {
  if (CONVERSATION_ITEM_KINDS.has(entry.kind)) {
    const body = entry.kind === "user" ? formatUserTranscriptEntry(entry) : entry.text;
    return `\n${trimBlankRows(body)}`;
  }
  // A Thinking marker gets the same single blank row as the answer that follows it.
  if (entry.id?.startsWith("thinking_")) return `\n${trimBlankRows(entry.text)}`;
  return entry.text.endsWith("\n") ? entry.text.slice(0, -1) : entry.text;
}

/** Drop leading/trailing line breaks, including those hidden inside a closing colour code. */
function trimBlankRows(text: string): string {
  return text.replace(/^((?:\u001B\[[0-9;]*m)*)\n+/u, "$1").replace(/\n+((?:\u001B\[[0-9;]*m)*)$/u, "$1");
}

/** Keep only the last `maxRows` physical rows of a still-streaming entry. */
export function clipTail(text: string, maxRows: number, hiddenLabel: (hidden: number) => string): string {
  const rows = text.split("\n");
  if (rows.length <= maxRows) return text;
  const hidden = rows.length - maxRows + 1;
  return [hiddenLabel(hidden), ...rows.slice(rows.length - maxRows + 1)].join("\n");
}
