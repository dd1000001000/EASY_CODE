/**
 * Dependency-free terminal text layout helpers.
 *
 * The helpers in this module deliberately understand escape sequences instead
 * of removing text with a broad regular expression.  An unterminated OSC/DCS
 * sequence is treated as terminal control data all the way to the end of the
 * input, so it can never become printable output by accident.
 */

const ESC = 0x1b;
const CSI = 0x9b;
const OSC = 0x9d;
const DCS = 0x90;
const SOS = 0x98;
const PM = 0x9e;
const APC = 0x9f;
const ST = 0x9c;
const BEL = 0x07;
const DEFAULT_TAB_WIDTH = 4;

const COMBINING_MARK = /^\p{Mark}$/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
const BIDI_OR_INVISIBLE_FORMAT =
  /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;

interface AnsiSequence {
  readonly end: number;
  readonly value: string;
  readonly sgr: boolean;
}

interface TextToken {
  readonly kind: "text";
  readonly value: string;
  readonly width: number;
}

interface SgrToken {
  readonly kind: "sgr";
  readonly value: string;
}

type LayoutToken = TextToken | SgrToken;

export interface SanitizeTerminalTextOptions {
  /** Keep numeric Select Graphic Rendition sequences (colours/styles). */
  readonly allowSgr?: boolean;
  /** Number of spaces used for a tab. Defaults to four. */
  readonly tabWidth?: number;
}

export interface TruncateToWidthOptions {
  /** Marker appended when content is removed. Defaults to `…`. */
  readonly ellipsis?: string;
  /** Keep safe SGR colour/style sequences. Defaults to true. */
  readonly preserveAnsi?: boolean;
}

export interface WrapToWidthOptions {
  /** Keep safe SGR colour/style sequences. Defaults to true. */
  readonly preserveAnsi?: boolean;
}

/** Return true when a string contains an ANSI/C1 terminal sequence. */
export function hasAnsi(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (readAnsiSequence(value, index)) return true;
  }
  return false;
}

/** Remove ANSI escape sequences, including OSC/DCS and incomplete sequences. */
export function stripAnsi(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const sequence = readAnsiSequence(value, index);
    if (sequence) {
      index = sequence.end;
      continue;
    }
    result += value[index] ?? "";
    index += 1;
  }
  return result;
}

/**
 * Canonicalise text before it is written to a terminal.
 *
 * Newlines are retained, carriage returns become newlines, tabs become spaces,
 * cursor/OSC controls are removed, and only numeric SGR sequences may survive.
 */
export function sanitizeTerminalText(
  value: string,
  options: SanitizeTerminalTextOptions = {},
): string {
  const allowSgr = options.allowSgr ?? true;
  const tabWidth = normalizeTabWidth(options.tabWidth);
  let result = "";
  let index = 0;

  while (index < value.length) {
    const sequence = readAnsiSequence(value, index);
    if (sequence) {
      if (allowSgr && sequence.sgr) result += sequence.value;
      index = sequence.end;
      continue;
    }

    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    index += character.length;

    if (codePoint === 0x0d) {
      // Treat CRLF as one newline and a bare CR as a newline.  Passing a bare
      // carriage return through would let untrusted text overwrite a row.
      if (value.codePointAt(index) === 0x0a) index += 1;
      result += "\n";
      continue;
    }
    if (codePoint === 0x0a) {
      result += "\n";
      continue;
    }
    if (codePoint === 0x09) {
      result += " ".repeat(tabWidth);
      continue;
    }
    if (codePoint === 0x2028 || codePoint === 0x2029) {
      result += "\n";
      continue;
    }
    if (isTerminalControl(codePoint) || BIDI_OR_INVISIBLE_FORMAT.test(character)) {
      continue;
    }
    result += character;
  }

  return result;
}

/** Display-cell width of printable text. ANSI and line controls have width 0. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const token of layoutTokens(value, false)) {
    if (token.kind === "text" && token.value !== "\n") width += token.width;
  }
  return width;
}

/** Alias for callers accustomed to the `string-width` naming convention. */
export const stringWidth = displayWidth;

/** Width of the widest visual line in a possibly multiline value. */
export function maxLineWidth(value: string): number {
  let widest = 0;
  let current = 0;
  for (const token of layoutTokens(value, false)) {
    if (token.kind !== "text") continue;
    if (token.value === "\n") {
      widest = Math.max(widest, current);
      current = 0;
    } else {
      current += token.width;
    }
  }
  return Math.max(widest, current);
}

/**
 * Truncate a value to one terminal row without splitting a grapheme cluster.
 * Embedded newlines are represented by one space so no cursor controls leak
 * into a single-line status field.
 */
export function truncateToWidth(
  value: string,
  columns: number,
  options: TruncateToWidthOptions | string = {},
): string {
  const limit = normalizeColumns(columns, 0);
  if (limit === 0) return "";

  const normalizedOptions = typeof options === "string"
    ? { ellipsis: options }
    : options;
  const preserveAnsi = normalizedOptions.preserveAnsi ?? true;
  const source = sanitizeTerminalText(value, { allowSgr: preserveAnsi })
    .replace(/\n/gu, " ");
  const sourceTokens = layoutTokens(source, preserveAnsi);
  const sourceWidth = tokensWidth(sourceTokens);
  if (sourceWidth <= limit) return finishSgr(sourceTokens, preserveAnsi);

  const rawEllipsis = sanitizeTerminalText(
    normalizedOptions.ellipsis ?? "…",
    { allowSgr: false },
  ).replace(/\n/gu, " ");
  const ellipsis = takePlainWidth(rawEllipsis, limit);
  const ellipsisWidth = displayWidth(ellipsis);
  const contentLimit = Math.max(0, limit - ellipsisWidth);
  const output: LayoutToken[] = [];
  let width = 0;

  for (const token of sourceTokens) {
    if (token.kind === "sgr") {
      output.push(token);
      continue;
    }
    if (token.value === "\n") continue;
    if (token.width === 0) {
      output.push(token);
      continue;
    }
    if (width + token.width > contentLimit) break;
    output.push(token);
    width += token.width;
  }

  return finishSgr(output, preserveAnsi, ellipsis);
}

/** Alias retained for concise renderer call sites. */
export const truncate = truncateToWidth;

/**
 * Hard-wrap text by terminal display cells. Explicit newlines and empty lines
 * are preserved. Every returned line fits within `columns`.
 */
export function wrapToWidth(
  value: string,
  columns: number,
  options: WrapToWidthOptions = {},
): string[] {
  const limit = normalizeColumns(columns, 1);
  const preserveAnsi = options.preserveAnsi ?? true;
  const source = sanitizeTerminalText(value, { allowSgr: preserveAnsi });
  const tokens = layoutTokens(source, preserveAnsi);
  const lines: string[] = [];
  let current: LayoutToken[] = [];
  let currentWidth = 0;
  let sawSgr = false;

  const pushLine = (): void => {
    lines.push(tokensToString(current));
    current = [];
    currentWidth = 0;
  };

  for (const token of tokens) {
    if (token.kind === "sgr") {
      current.push(token);
      sawSgr = true;
      continue;
    }
    if (token.value === "\n") {
      pushLine();
      continue;
    }
    if (token.width === 0) {
      current.push(token);
      continue;
    }
    if (token.width > limit) {
      // A two-cell glyph cannot be displayed in a one-column terminal.  A
      // visible one-cell replacement keeps the width invariant deterministic.
      if (currentWidth === limit) pushLine();
      current.push({ kind: "text", value: "…", width: 1 });
      currentWidth += 1;
      continue;
    }
    if (currentWidth > 0 && currentWidth + token.width > limit) pushLine();
    current.push(token);
    currentWidth += token.width;
  }

  pushLine();
  if (preserveAnsi && sawSgr) {
    const finalIndex = lines.length - 1;
    lines[finalIndex] = `${lines[finalIndex] ?? ""}\u001B[0m`;
  }
  return lines;
}

/** Alias that makes the hard-wrapping behaviour explicit at call sites. */
export const wrapText = wrapToWidth;

/** Number of terminal rows occupied after hard wrapping at `columns`. */
export function countVisualRows(value: string, columns: number): number {
  if (!value) return 0;
  return wrapToWidth(value, columns, { preserveAnsi: false }).length;
}

/**
 * Clamp a visual column to a grapheme boundary in a line. This avoids placing
 * the terminal cursor in the second cell of a wide character.
 */
export function clampVisualColumn(value: string, requestedColumn: number): number {
  const requested = Number.isFinite(requestedColumn)
    ? Math.max(0, Math.floor(requestedColumn))
    : 0;
  let column = 0;
  for (const token of layoutTokens(value, false)) {
    if (token.kind !== "text" || token.value === "\n" || token.width === 0) {
      continue;
    }
    if (column + token.width > requested) break;
    column += token.width;
  }
  return column;
}

function readAnsiSequence(value: string, start: number): AnsiSequence | undefined {
  const first = value.charCodeAt(start);
  if (first === ESC) {
    const second = value.charCodeAt(start + 1);
    if (!Number.isFinite(second)) {
      return { end: start + 1, value: value.slice(start, start + 1), sgr: false };
    }
    if (second === 0x5b) return readCsi(value, start, start + 2);
    if (second === 0x5d) return readControlString(value, start, start + 2, true);
    if (second === 0x50 || second === 0x58 || second === 0x5e || second === 0x5f) {
      return readControlString(value, start, start + 2, false);
    }
    if (second === 0x5c) {
      return { end: start + 2, value: value.slice(start, start + 2), sgr: false };
    }
    // ANSI Fe/Fs/Fp sequences contain optional intermediate bytes followed by
    // one final byte. Unknown ESC bytes are consumed without consuming the
    // following printable Unicode character.
    let cursor = start + 1;
    while (isByteInRange(value.charCodeAt(cursor), 0x20, 0x2f)) cursor += 1;
    if (isByteInRange(value.charCodeAt(cursor), 0x30, 0x7e)) cursor += 1;
    else cursor = start + 1;
    return { end: cursor, value: value.slice(start, cursor), sgr: false };
  }

  if (first === CSI) return readCsi(value, start, start + 1);
  if (first === OSC) return readControlString(value, start, start + 1, true);
  if (first === DCS || first === SOS || first === PM || first === APC) {
    return readControlString(value, start, start + 1, false);
  }
  if (first === ST) {
    return { end: start + 1, value: value.slice(start, start + 1), sgr: false };
  }
  return undefined;
}

function readCsi(value: string, start: number, payloadStart: number): AnsiSequence {
  let cursor = payloadStart;
  while (cursor < value.length) {
    const byte = value.charCodeAt(cursor);
    cursor += 1;
    if (isByteInRange(byte, 0x40, 0x7e)) {
      const sequence = value.slice(start, cursor);
      return {
        end: cursor,
        value: sequence,
        // Only numeric SGR is retained by the sanitizer. Private-mode and
        // cursor sequences cannot pass merely because their final byte is `m`.
        sgr: /^(?:\u001B\[|\u009B)[0-9;:]*m$/u.test(sequence),
      };
    }
    if (!isByteInRange(byte, 0x20, 0x3f)) {
      break;
    }
  }
  // Incomplete/malformed CSI remains control data through the end. Dropping it
  // is safer than allowing a later chunk to complete a terminal instruction.
  return {
    end: value.length,
    value: value.slice(start),
    sgr: false,
  };
}

function readControlString(
  value: string,
  start: number,
  payloadStart: number,
  allowBel: boolean,
): AnsiSequence {
  let cursor = payloadStart;
  while (cursor < value.length) {
    const byte = value.charCodeAt(cursor);
    if (allowBel && byte === BEL) {
      cursor += 1;
      return { end: cursor, value: value.slice(start, cursor), sgr: false };
    }
    if (byte === ST) {
      cursor += 1;
      return { end: cursor, value: value.slice(start, cursor), sgr: false };
    }
    if (byte === ESC && value.charCodeAt(cursor + 1) === 0x5c) {
      cursor += 2;
      return { end: cursor, value: value.slice(start, cursor), sgr: false };
    }
    cursor += 1;
  }
  return { end: value.length, value: value.slice(start), sgr: false };
}

function layoutTokens(value: string, preserveAnsi: boolean): LayoutToken[] {
  const sanitized = sanitizeTerminalText(value, { allowSgr: preserveAnsi });
  const tokens: LayoutToken[] = [];
  let text = "";
  let index = 0;

  const flushText = (): void => {
    if (!text) return;
    for (const grapheme of splitGraphemes(text)) {
      tokens.push({
        kind: "text",
        value: grapheme,
        width: grapheme === "\n" ? 0 : graphemeWidth(grapheme),
      });
    }
    text = "";
  };

  while (index < sanitized.length) {
    const sequence = readAnsiSequence(sanitized, index);
    if (sequence) {
      flushText();
      if (preserveAnsi && sequence.sgr) {
        tokens.push({ kind: "sgr", value: sequence.value });
      }
      index = sequence.end;
      continue;
    }
    text += sanitized[index] ?? "";
    index += 1;
  }
  flushText();
  return tokens;
}

function splitGraphemes(value: string): string[] {
  const intl = Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: "grapheme" },
    ) => { segment(input: string): Iterable<{ segment: string }> };
  };
  if (intl.Segmenter) {
    const segmenter = new intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (part) => part.segment);
  }
  return fallbackGraphemes(value);
}

function fallbackGraphemes(value: string): string[] {
  const codePoints = Array.from(value);
  const graphemes: string[] = [];
  let current = "";
  let regionalCount = 0;
  let joinNext = false;

  for (const character of codePoints) {
    const codePoint = character.codePointAt(0) ?? 0;
    const regional = REGIONAL_INDICATOR.test(character);
    const extender = isZeroWidthCodePoint(codePoint, character) || EMOJI_MODIFIER.test(character);
    if (!current) {
      current = character;
      regionalCount = regional ? 1 : 0;
      joinNext = codePoint === 0x200d;
      continue;
    }
    if (joinNext || extender || codePoint === 0x20e3) {
      current += character;
      joinNext = codePoint === 0x200d;
      continue;
    }
    if (regional && regionalCount === 1) {
      current += character;
      regionalCount = 2;
      continue;
    }
    graphemes.push(current);
    current = character;
    regionalCount = regional ? 1 : 0;
    joinNext = codePoint === 0x200d;
  }
  if (current) graphemes.push(current);
  return graphemes;
}

function graphemeWidth(grapheme: string): number {
  if (!grapheme) return 0;
  if (isEmojiGrapheme(grapheme)) return 2;
  let width = 0;
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isZeroWidthCodePoint(codePoint, character) || isTerminalControl(codePoint)) {
      continue;
    }
    width += isFullWidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function isEmojiGrapheme(grapheme: string): boolean {
  if (grapheme.includes("\uFE0F") || grapheme.includes("\u200D")) return true;
  if (grapheme.includes("\u20E3")) return true;
  const regionalCount = Array.from(grapheme)
    .filter((character) => REGIONAL_INDICATOR.test(character)).length;
  if (regionalCount >= 2) return true;
  return EMOJI_PRESENTATION.test(grapheme);
}

function isZeroWidthCodePoint(codePoint: number, character: string): boolean {
  return COMBINING_MARK.test(character) ||
    EMOJI_MODIFIER.test(character) ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f);
}

function isFullWidthCodePoint(codePoint: number): boolean {
  if (!Number.isFinite(codePoint) || codePoint < 0x1100) return false;
  return codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3040 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd);
}

function isTerminalControl(codePoint: number): boolean {
  return codePoint <= 0x08 ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f);
}

function takePlainWidth(value: string, limit: number): string {
  let result = "";
  let width = 0;
  for (const grapheme of splitGraphemes(stripAnsi(value))) {
    const graphemeColumns = graphemeWidth(grapheme);
    if (graphemeColumns > 0 && width + graphemeColumns > limit) break;
    result += grapheme;
    width += graphemeColumns;
  }
  return result;
}

function tokensWidth(tokens: readonly LayoutToken[]): number {
  return tokens.reduce(
    (width, token) => width + (token.kind === "text" ? token.width : 0),
    0,
  );
}

function tokensToString(tokens: readonly LayoutToken[]): string {
  return tokens.map((token) => token.value).join("");
}

function finishSgr(
  tokens: readonly LayoutToken[],
  preserveAnsi: boolean,
  suffix = "",
): string {
  const text = `${tokensToString(tokens)}${suffix}`;
  return preserveAnsi && tokens.some((token) => token.kind === "sgr")
    ? `${text}\u001B[0m`
    : text;
}

function normalizeColumns(value: number, minimum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.floor(value));
}

function normalizeTabWidth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TAB_WIDTH;
  return Math.min(16, Math.max(1, Math.floor(value)));
}

function isByteInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}
