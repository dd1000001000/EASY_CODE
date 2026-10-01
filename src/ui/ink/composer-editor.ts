import { displayWidth } from "../render/layout.js";

/**
 * Pure multiline text-editing model behind the Ink composer. It has no
 * terminal, React, or clipboard dependency, so every key behavior can be unit
 * tested. Offsets are UTF-16 indexes, matching `UIComposerState.cursor`.
 */
export interface EditorState {
  readonly text: string;
  readonly cursor: number;
}

/** One wrapped display row; `hard` rows end at a newline or at the end of the text. */
export interface VisualRow {
  readonly start: number;
  readonly end: number;
  readonly hard: boolean;
}

export const EMPTY_EDITOR: EditorState = { text: "", cursor: 0 };

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function boundaries(text: string): number[] {
  const offsets = [0];
  for (const { index, segment } of segmenter.segment(text)) offsets.push(index + segment.length);
  return offsets;
}

function clampCursor(text: string, cursor: number): number {
  return Math.max(0, Math.min(text.length, cursor));
}

function previousBoundary(text: string, cursor: number): number {
  let previous = 0;
  for (const offset of boundaries(text)) {
    if (offset >= cursor) break;
    previous = offset;
  }
  return previous;
}

function nextBoundary(text: string, cursor: number): number {
  for (const offset of boundaries(text)) if (offset > cursor) return offset;
  return text.length;
}

function isWordCharacter(character: string): boolean {
  return /[\p{L}\p{N}_]/u.test(character);
}

function wordStart(text: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && !isWordCharacter(text[index - 1]!)) index -= 1;
  while (index > 0 && isWordCharacter(text[index - 1]!)) index -= 1;
  return index;
}

function wordEnd(text: string, cursor: number): number {
  let index = cursor;
  while (index < text.length && !isWordCharacter(text[index]!)) index += 1;
  while (index < text.length && isWordCharacter(text[index]!)) index += 1;
  return index;
}

function lineStart(text: string, cursor: number): number {
  return text.lastIndexOf("\n", cursor - 1) + 1;
}

function lineEnd(text: string, cursor: number): number {
  const index = text.indexOf("\n", cursor);
  return index === -1 ? text.length : index;
}

export function insertText(state: EditorState, value: string): EditorState {
  if (!value) return state;
  const cursor = clampCursor(state.text, state.cursor);
  return { text: state.text.slice(0, cursor) + value + state.text.slice(cursor), cursor: cursor + value.length };
}

export function deleteBackward(state: EditorState): EditorState {
  const cursor = clampCursor(state.text, state.cursor);
  if (cursor === 0) return state;
  const start = previousBoundary(state.text, cursor);
  return { text: state.text.slice(0, start) + state.text.slice(cursor), cursor: start };
}

export function deleteForward(state: EditorState): EditorState {
  const cursor = clampCursor(state.text, state.cursor);
  if (cursor >= state.text.length) return state;
  const end = nextBoundary(state.text, cursor);
  return { text: state.text.slice(0, cursor) + state.text.slice(end), cursor };
}

export function deleteWordBackward(state: EditorState): EditorState {
  const cursor = clampCursor(state.text, state.cursor);
  const start = wordStart(state.text, cursor);
  return start === cursor ? state : { text: state.text.slice(0, start) + state.text.slice(cursor), cursor: start };
}

export function deleteToLineEnd(state: EditorState): EditorState {
  const cursor = clampCursor(state.text, state.cursor);
  const end = lineEnd(state.text, cursor);
  // At the end of a line, Ctrl+K joins the next line like readline.
  const stop = end === cursor && end < state.text.length ? end + 1 : end;
  return stop === cursor ? state : { text: state.text.slice(0, cursor) + state.text.slice(stop), cursor };
}

export function deleteToLineStart(state: EditorState): EditorState {
  const cursor = clampCursor(state.text, state.cursor);
  const start = lineStart(state.text, cursor);
  return start === cursor ? state : { text: state.text.slice(0, start) + state.text.slice(cursor), cursor: start };
}

export function moveLeft(state: EditorState): EditorState {
  return { ...state, cursor: previousBoundary(state.text, clampCursor(state.text, state.cursor)) };
}

export function moveRight(state: EditorState): EditorState {
  return { ...state, cursor: nextBoundary(state.text, clampCursor(state.text, state.cursor)) };
}

export function moveWordLeft(state: EditorState): EditorState {
  return { ...state, cursor: wordStart(state.text, clampCursor(state.text, state.cursor)) };
}

export function moveWordRight(state: EditorState): EditorState {
  return { ...state, cursor: wordEnd(state.text, clampCursor(state.text, state.cursor)) };
}

export function moveLineStart(state: EditorState): EditorState {
  return { ...state, cursor: lineStart(state.text, clampCursor(state.text, state.cursor)) };
}

export function moveLineEnd(state: EditorState): EditorState {
  return { ...state, cursor: lineEnd(state.text, clampCursor(state.text, state.cursor)) };
}

/** Wrap text into display rows no wider than `width` cells, breaking between graphemes. */
export function layoutRows(text: string, width: number): VisualRow[] {
  const limit = Math.max(1, Math.floor(width));
  const rows: VisualRow[] = [];
  let lineOffset = 0;
  for (const line of text.split("\n")) {
    let rowStart = lineOffset;
    let rowWidth = 0;
    for (const { index, segment } of segmenter.segment(line)) {
      const cells = displayWidth(segment);
      if (rowWidth > 0 && rowWidth + cells > limit) {
        rows.push({ start: rowStart, end: lineOffset + index, hard: false });
        rowStart = lineOffset + index;
        rowWidth = 0;
      }
      rowWidth += cells;
    }
    rows.push({ start: rowStart, end: lineOffset + line.length, hard: true });
    lineOffset += line.length + 1;
  }
  return rows;
}

/** Index of the display row that owns `cursor`; a wrap boundary belongs to the following row. */
export function rowIndexOfCursor(rows: readonly VisualRow[], cursor: number): number {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const next = rows[index + 1];
    if (cursor < row.start) break;
    if (row.hard ? cursor <= row.end : next !== undefined && cursor < next.start) return index;
  }
  return Math.max(0, rows.length - 1);
}

export function cursorColumn(text: string, rows: readonly VisualRow[], cursor: number): number {
  const row = rows[rowIndexOfCursor(rows, cursor)];
  return row ? displayWidth(text.slice(row.start, cursor)) : 0;
}

/** Move one display row up (-1) or down (+1); undefined when already at that edge. */
export function moveVertical(
  state: EditorState,
  width: number,
  direction: -1 | 1,
  goalColumn?: number,
): EditorState | undefined {
  const rows = layoutRows(state.text, width);
  const cursor = clampCursor(state.text, state.cursor);
  const current = rowIndexOfCursor(rows, cursor);
  const target = rows[current + direction];
  if (!target) return undefined;
  const column = goalColumn ?? cursorColumn(state.text, rows, cursor);
  let offset = target.start;
  let used = 0;
  for (const { index, segment } of segmenter.segment(state.text.slice(target.start, target.end))) {
    const cells = displayWidth(segment);
    if (used + cells > column) break;
    used += cells;
    offset = target.start + index + segment.length;
  }
  return { text: state.text, cursor: offset };
}

/** Whether the cursor sits on the first (-1) or last (+1) display row. */
export function atVerticalEdge(state: EditorState, width: number, direction: -1 | 1): boolean {
  const rows = layoutRows(state.text, width);
  const current = rowIndexOfCursor(rows, clampCursor(state.text, state.cursor));
  return current + direction < 0 || current + direction >= rows.length;
}

/** Submitted-prompt history with the in-progress draft preserved while browsing. */
export class EditorHistory {
  private readonly entries: string[] = [];
  private position = -1;
  private draft = "";

  constructor(private readonly limit = 500) {}

  record(text: string): void {
    this.position = -1;
    this.draft = "";
    if (!text.trim() || this.entries[this.entries.length - 1] === text) return;
    this.entries.push(text);
    if (this.entries.length > this.limit) this.entries.shift();
  }

  previous(current: string): string | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.position === -1) {
      this.draft = current;
      this.position = this.entries.length;
    }
    if (this.position === 0) return undefined;
    this.position -= 1;
    return this.entries[this.position];
  }

  next(): string | undefined {
    if (this.position === -1) return undefined;
    this.position += 1;
    if (this.position >= this.entries.length) {
      this.position = -1;
      return this.draft;
    }
    return this.entries[this.position];
  }

  /** Leaving history browsing (for example after an edit) keeps the edited text as the new draft. */
  detach(): void {
    this.position = -1;
  }
}
