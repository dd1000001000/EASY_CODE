import {
  clampVisualColumn,
  displayWidth,
  hasAnsi,
  sanitizeTerminalText,
  stripAnsi,
  wrapToWidth,
} from "./layout.js";

const DEFAULT_COLUMNS = 80;
const MAX_COLUMNS = 10_000;
const ERASE_SCREEN_DOWN = "\u001B[0J";

export interface ScreenOutput extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
}

export type ScreenWidthSource = number | (() => number | undefined);

export interface ScreenWriterOptions {
  readonly output?: ScreenOutput;
  readonly columns?: ScreenWidthSource;
}

export interface LiveCursor {
  /** Zero-based visual row relative to the first row of the live region. */
  readonly row: number;
  /** Zero-based display-cell column, not a UTF-16 string offset. */
  readonly column: number;
}

/** Backwards-friendly alias for renderer code that calls this a screen cursor. */
export type ScreenCursor = LiveCursor;

/**
 * Owns only terminal output and maintains one redrawable region at the bottom
 * of stdout. Stable commits remain in scrollback; live renders are erased and
 * replaced in place. No stdin, resize, signal, or process listeners are used.
 */
export class ScreenWriter {
  private readonly output: ScreenOutput;
  private readonly widthSource?: ScreenWidthSource;
  private readonly tty: boolean;
  private closed = false;
  private atLineStart = true;
  private liveText = "";
  private liveCursor?: LiveCursor;
  private renderedLiveRows = 0;
  /**
   * Rows physically reserved for the live region at its current anchor.
   *
   * A live block can grow while the terminal cursor is already on the last
   * viewport row. Writing the larger block immediately would scroll its first
   * rows into permanent scrollback before a later clear can erase them. Reserve
   * blank rows first, then return to the anchor and paint the block in place.
   */
  private reservedLiveRows = 0;
  /** Current cursor row relative to live-region start. */
  private renderedCursorRow = 0;
  private plainLastLive = "";

  constructor();
  constructor(output: ScreenOutput, columns?: ScreenWidthSource);
  constructor(options: ScreenWriterOptions);
  constructor(
    outputOrOptions: ScreenOutput | ScreenWriterOptions = process.stdout,
    columns?: ScreenWidthSource,
  ) {
    if (isScreenOutput(outputOrOptions)) {
      this.output = outputOrOptions;
      this.widthSource = columns;
    } else {
      this.output = outputOrOptions.output ?? process.stdout;
      this.widthSource = outputOrOptions.columns ?? columns;
    }
    this.tty = Boolean(this.output.isTTY);
  }

  /** Current layout width. An injected source wins, then stdout.columns, then 80. */
  get columns(): number {
    const injected = typeof this.widthSource === "function"
      ? safelyReadWidth(this.widthSource)
      : this.widthSource;
    const physicalColumns = normalizeColumns(injected ?? this.output.columns);
    // Never paint the last physical cell of a TTY row. Windows ConPTY and
    // several terminal emulators disagree about whether CR after an exact-width
    // row cancels or commits pending autowrap; reserving one cell keeps live-row
    // accounting deterministic and prevents stale Progress blocks in scrollback.
    return this.tty && physicalColumns > 1
      ? physicalColumns - 1
      : physicalColumns;
  }

  get isTTY(): boolean {
    return this.tty;
  }

  /**
   * Append stable output. If a live region is visible it is temporarily erased,
   * the stable text is committed at its former start, and the live region is
   * then redrawn underneath it.
   */
  commit(stableText: string): void {
    if (this.closed || !stableText) return;
    const sanitized = containStyles(
      sanitizeTerminalText(stableText, { allowSgr: this.tty }),
      this.tty,
    );
    if (!sanitized) return;

    if (!this.tty) {
      this.write(sanitized);
      this.updateLineStart(sanitized);
      return;
    }

    const pendingLive = this.liveText;
    const pendingCursor = this.liveCursor;
    if (this.renderedLiveRows > 0) this.eraseRenderedLive();
    // Stable output changes the live region's anchor. Any rows reserved below
    // the former anchor no longer describe the space available at the new one.
    this.reservedLiveRows = 0;
    this.write(sanitized);
    this.updateLineStart(sanitized);
    if (pendingLive) this.drawLive(pendingLive, pendingCursor);
  }

  /**
   * Replace the bottom live region. `cursor`, when supplied, is restored to a
   * grapheme-safe visual row/column inside the rendered region. A future clear
   * or render still locates the region correctly from that cursor position.
   */
  renderLive(liveText: string, cursor?: LiveCursor): void {
    if (this.closed) return;
    const sanitized = sanitizeTerminalText(liveText, { allowSgr: this.tty });
    if (!sanitized) {
      this.clearLive();
      return;
    }

    this.liveText = sanitized;
    this.liveCursor = cursor ? normalizeCursorInput(cursor) : undefined;

    if (!this.tty) {
      const plain = plainSnapshot(sanitized, this.columns);
      if (plain && plain !== this.plainLastLive) {
        if (!this.atLineStart) this.write("\n");
        this.write(`${plain}\n`);
        this.atLineStart = true;
        this.plainLastLive = plain;
      }
      return;
    }

    if (this.renderedLiveRows > 0) this.eraseRenderedLive();
    this.drawLive(sanitized, this.liveCursor);
  }

  /** Remove the live region. Stable scrollback is not touched. */
  clearLive(): void {
    if (this.closed) return;
    if (this.tty && this.renderedLiveRows > 0) this.eraseRenderedLive();
    this.resetLiveState();
  }

  /**
   * Clear transient TTY output and release internal state. stdout is deliberately
   * not ended or destroyed because ScreenWriter does not own the stream itself.
   */
  close(): void {
    if (this.closed) return;
    if (this.tty && this.renderedLiveRows > 0) this.eraseRenderedLive();
    this.resetLiveState();
    this.closed = true;
  }

  private drawLive(text: string, cursor?: LiveCursor): void {
    if (!this.atLineStart) {
      this.write("\r\n");
      this.atLineStart = true;
    }

    const wrappedLines = wrapToWidth(text, this.columns, { preserveAnsi: true });
    // A block taller than the viewport cannot be erased reliably: cursor-up
    // clamps at the top while painting would scroll its leading rows into
    // permanent history. Keep the redrawable block within the physical screen;
    // a resize-triggered refresh can reveal more rows when space returns.
    const rowLimit = terminalRowLimit(this.output.rows);
    const lines = wrappedLines.slice(0, rowLimit);
    this.reservedLiveRows = Math.min(this.reservedLiveRows, rowLimit);
    this.reserveLiveRows(lines.length);
    // Keep a shorter replacement attached to the bottom of the rows that are
    // already reserved for this live-region anchor. Modal overlays commonly
    // replace a taller activity/task block. Painting them back at row zero
    // leaves the stale reservation below the modal, so xterm exposes a large
    // blank area and appears to pull the approval box to the top. Cursor-down
    // stays inside the existing reservation and, unlike CR/LF, cannot advance
    // terminal scrollback.
    const topOffset = Math.max(0, this.reservedLiveRows - lines.length);
    if (topOffset > 0) this.write(cursorDown(topOffset));
    // Keep the cursor inside the final live row. A trailing LF would scroll the
    // terminal once the viewport is full, permanently leaking the former top
    // row into scrollback on every spinner refresh.
    this.write(lines.join("\r\n"));
    this.renderedLiveRows = lines.length;
    this.renderedCursorRow = topOffset + Math.max(0, lines.length - 1);
    this.atLineStart = displayWidth(lines.at(-1) ?? "") === 0;

    if (lines.length === 0) return;
    if (!cursor) {
      // Leave the physical cursor at the rendered content's origin. This is
      // normally the live-region origin; when a shorter block is bottom-aligned
      // inside an existing reservation it is the first row of that block. In
      // both cases the cursor remains above live content, which prevents resize
      // and refresh cycles from leaking the leading rows into scrollback.
      if (lines.length > 1) {
        this.write("\r");
        this.write(cursorUp(lines.length - 1));
        this.renderedCursorRow = topOffset;
        this.atLineStart = true;
      }
      return;
    }
    const targetRow = Math.min(lines.length - 1, cursor.row);
    const targetColumn = clampVisualColumn(
      lines[targetRow] ?? "",
      Math.min(cursor.column, displayWidth(lines[targetRow] ?? "")),
    );
    // Rendering ends at the last row. Return to column zero before moving to
    // the requested visual cell so CR/LF and autowrap modes cannot affect it.
    this.write("\r");
    const rowsUp = (lines.length - 1) - targetRow;
    this.write(cursorUp(rowsUp));
    if (targetColumn > 0) this.write(cursorRight(targetColumn));
    this.renderedCursorRow = topOffset + targetRow;
    this.atLineStart = targetColumn === 0;
  }

  private eraseRenderedLive(): void {
    // The cursor can be at the end of the block (normal status rendering) or in
    // the middle of it (composer editing). Return to column zero first, then to
    // the first live row, and clear only from there down.
    this.write("\r");
    if (this.renderedCursorRow > 0) {
      this.write(cursorUp(this.renderedCursorRow));
    }
    this.write(ERASE_SCREEN_DOWN);
    this.renderedLiveRows = 0;
    this.renderedCursorRow = 0;
    this.atLineStart = true;
  }

  private reserveLiveRows(rows: number): void {
    if (rows <= this.reservedLiveRows) return;

    const previousRows = this.reservedLiveRows;
    const additionalRows = rows - Math.max(1, previousRows);

    // Move to the last already-reserved row, append only blank rows, and then
    // return to the original live-region anchor. If this reaches the viewport
    // bottom, only blank space (never live content) is allowed to scroll.
    if (previousRows > 1) this.write(cursorDown(previousRows - 1));
    if (additionalRows > 0) this.write("\r\n".repeat(additionalRows));
    if (rows > 1) this.write(cursorUp(rows - 1));

    this.reservedLiveRows = rows;
    this.atLineStart = true;
  }

  private resetLiveState(): void {
    this.liveText = "";
    this.liveCursor = undefined;
    this.renderedLiveRows = 0;
    this.renderedCursorRow = 0;
    this.reservedLiveRows = 0;
    this.plainLastLive = "";
  }

  private updateLineStart(value: string): void {
    if (!value) return;
    this.atLineStart = stripAnsi(value).endsWith("\n");
  }

  private write(value: string): void {
    if (value) this.output.write(value);
  }
}

function isScreenOutput(value: ScreenOutput | ScreenWriterOptions): value is ScreenOutput {
  return typeof (value as ScreenOutput).write === "function";
}

function safelyReadWidth(source: () => number | undefined): number | undefined {
  try {
    return source();
  } catch {
    return undefined;
  }
}

function normalizeColumns(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) return DEFAULT_COLUMNS;
  return Math.min(MAX_COLUMNS, Math.max(1, Math.floor(value ?? DEFAULT_COLUMNS)));
}

function terminalRowLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(1, Math.floor(value ?? 1));
}

function normalizeCursorInput(cursor: LiveCursor): LiveCursor {
  return {
    row: finiteNonNegativeInteger(cursor.row),
    column: finiteNonNegativeInteger(cursor.column),
  };
}

function finiteNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function cursorUp(rows: number): string {
  return rows > 0 ? `\u001B[${rows}A` : "";
}

function cursorDown(rows: number): string {
  return rows > 0 ? `\u001B[${rows}B` : "";
}

function cursorRight(columns: number): string {
  return columns > 0 ? `\u001B[${columns}C` : "";
}

function plainSnapshot(value: string, columns: number): string {
  return wrapToWidth(value, columns, { preserveAnsi: false }).join("\n");
}

function containStyles(value: string, tty: boolean): string {
  // SGR is the only caller-supplied control family ScreenWriter permits. Reset
  // it at every stable commit boundary so a partial/untrusted colour sequence
  // cannot style the prompt or a later message.
  return tty && hasAnsi(value) ? `${value}\u001B[0m` : value;
}
