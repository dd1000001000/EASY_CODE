import chalk from "chalk";

import { formatUserTranscriptEntry } from "../../cli/disclosure-render.js";
import type { UIState, UITranscriptEntry } from "../contracts.js";
import { truncateToWidth, wrapToWidth } from "../render/layout.js";
import { renderSessionHeader, type RenderViewOptions } from "../render/view.js";
import { renderAnswer } from "./markdown-view.js";

const CONVERSATION_ITEM_KINDS = new Set<UITranscriptEntry["kind"]>(["user", "assistant", "tool"]);
/** Transcript ids of session headers, re-rendered for the current width whenever they are printed. */
export const SESSION_HEADER_ID_PREFIX = "session_header_";
/** Transcript ids of Thinking markers: `thinking_<registry id>`. */
export const THINKING_ID_PREFIX = "thinking_";

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
  if (thinkingIdOf(entry) !== undefined) return `\n${trimBlankRows(entry.text)}`;
  return entry.text.endsWith("\n") ? entry.text.slice(0, -1) : entry.text;
}

/** Drop leading/trailing line breaks, including those hidden inside a closing colour code. */
function trimBlankRows(text: string): string {
  return text.replace(/^((?:\u001B\[[0-9;]*m)*)\n+/u, "$1").replace(/\n+((?:\u001B\[[0-9;]*m)*)$/u, "$1");
}

/** Registry id of a Thinking marker entry. */
export function thinkingIdOf(entry: Readonly<UITranscriptEntry>): number | undefined {
  if (!entry.id?.startsWith(THINKING_ID_PREFIX)) return undefined;
  const id = Number(entry.id.slice(THINKING_ID_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * One transcript row wrapped to the current width, so the row count Ink prints
 * is exactly the count used for the live-region budget. Conversation rows keep
 * continuation lines indented under their gutter.
 */
export function entryDisplay(entry: Readonly<UITranscriptEntry>, ui: UIState, view: RenderViewOptions): string {
  const width = view.columns ?? 80;
  if (entry.id?.startsWith(SESSION_HEADER_ID_PREFIX)) return `\n${renderSessionHeader(ui, view)}\n`;
  // Answers hold the model's Markdown, rendered as one block by marked and Ink's layout.
  if (entry.kind === "assistant") return `\n${renderAnswer(trimBlankRows(entry.text), width, view.color ?? false)}`;
  const text = transcriptEntryText(entry);
  // Thinking previews are a teaser: cut them at the edge instead of wrapping mid-word.
  if (thinkingIdOf(entry) !== undefined) {
    return text
      .split("\n")
      .map((line) => truncateToWidth(line, width, { preserveAnsi: true }))
      .join("\n");
  }
  return wrapToWidth(text, width, {
    preserveAnsi: true,
    hangingIndent: CONVERSATION_ITEM_KINDS.has(entry.kind),
    wordWrap: true,
  }).join("\n");
}

/** The collapsed marker hint; `/thinking <id>` pairs the id so the VS Code extension links it. */
export function thinkingToggleHint(id: number): string {
  return `/thinking ${id} · Ctrl+click or Ctrl+T to expand`;
}

export interface TranscriptDocument {
  readonly lines: readonly string[];
  /** Line index of each Thinking marker, by registry id. */
  readonly markers: ReadonlyMap<number, number>;
}

/**
 * The whole transcript as display rows, with the selected Thinking blocks
 * expanded in place. Used by the full-screen Thinking viewer.
 */
export function transcriptDocument(
  ui: UIState,
  view: RenderViewOptions,
  expanded: ReadonlySet<number>,
  body: (id: number) => string | undefined,
): TranscriptDocument {
  const width = view.columns ?? 80;
  const lines: string[] = [];
  const markers = new Map<number, number>();
  for (const entry of ui.transcript) {
    const id = thinkingIdOf(entry);
    const text = id !== undefined && expanded.has(id) ? body(id) : undefined;
    const rows =
      id !== undefined && text !== undefined
        ? [
            "",
            chalk.gray(`↕ Thinking #${id} · Ctrl/Cmd+click to close · /thinking ${id}`),
            ...wrapToWidth(text || "(No visible Thinking text.)", Math.max(1, width - 2), {
              preserveAnsi: false,
              wordWrap: true,
            }).map((line) => chalk.gray(`  ${line}`)),
          ]
        : entryDisplay(entry, ui, view).split("\n");
    if (id !== undefined) {
      const offset = rows.findIndex((row) => row.length > 0);
      markers.set(id, lines.length + Math.max(0, offset));
    }
    lines.push(...rows);
  }
  return { lines, markers };
}
