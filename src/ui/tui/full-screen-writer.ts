import {
  sanitizeTerminalText,
  truncateToWidth,
} from "../render/layout.js";
import type { ScreenOutput } from "../render/screen-writer.js";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const MAX_COLUMNS = 10_000;
const MAX_ROWS = 10_000;

const ALTERNATE_SCREEN_ON = "\u001B[?1049h";
const ALTERNATE_SCREEN_OFF = "\u001B[?1049l";
// Translate the wheel to cursor-up/down while the alternate buffer is active.
// Unlike DEC mouse reporting (1000/1002/1003 + 1006), this mode does not own
// button presses, so native terminal drag-selection and copy remain available.
const ALTERNATE_SCROLL_ON = "\u001B[?1007h";
const ALTERNATE_SCROLL_OFF = "\u001B[?1007l";
const CURSOR_HIDE = "\u001B[?25l";
const CURSOR_SHOW = "\u001B[?25h";
const BRACKETED_PASTE_ON = "\u001B[?2004h";
const BRACKETED_PASTE_OFF = "\u001B[?2004l";
const AUTOWRAP_OFF = "\u001B[?7l";
const AUTOWRAP_ON = "\u001B[?7h";
const CLEAR_SCREEN = "\u001B[2J";
const HOME = "\u001B[H";
const ERASE_LINE = "\u001B[2K";
const RESET_STYLE = "\u001B[0m";

/**
 * The exact terminal modes owned by FullScreenWriter.
 *
 * Keeping these sequences paired in one module makes it difficult for an
 * integration to enable a mode without restoring it on close.
 */
export const FULL_SCREEN_ENTER_SEQUENCE =
  ALTERNATE_SCREEN_ON +
  ALTERNATE_SCROLL_ON +
  CURSOR_HIDE +
  BRACKETED_PASTE_ON +
  AUTOWRAP_OFF +
  CLEAR_SCREEN +
  HOME;

export const FULL_SCREEN_EXIT_SEQUENCE =
  RESET_STYLE +
  ALTERNATE_SCROLL_OFF +
  BRACKETED_PASTE_OFF +
  AUTOWRAP_ON +
  CURSOR_SHOW +
  ALTERNATE_SCREEN_OFF;

export type FullScreenDimensionSource = number | (() => number | undefined);

export interface FullScreenSize {
  readonly columns: number;
  readonly rows: number;
}

export interface FullScreenWriterOptions {
  readonly output?: ScreenOutput;
  readonly columns?: FullScreenDimensionSource;
  readonly rows?: FullScreenDimensionSource;
}

/**
 * A small, input-agnostic alternate-screen renderer.
 *
 * The writer owns only the terminal modes it enables and the pixels in the
 * alternate buffer. It deliberately installs no resize, signal, exception, or
 * stdin handlers; the application remains responsible for those lifecycles.
 * Every paint uses absolute cursor addressing and never emits a line feed, so
 * rendering cannot append application output to the normal terminal
 * scrollback. Rows are sanitized and clipped to the current physical width.
 *
 * Mouse reporting is deliberately left disabled. VS Code's terminal-link
 * provider owns disclosure clicks, while leaving DEC mouse reporting off lets
 * the terminal keep native drag selection and copy semantics in this view.
 * Alternate-scroll mode converts only wheel motion to cursor keys; the input
 * owner turns those into continuous viewport scrolling. PageUp/PageDown remain
 * the portable fallback for terminal emulators that ignore mode 1007.
 */
export class FullScreenWriter {
  private readonly output: ScreenOutput;
  private readonly columnsSource?: FullScreenDimensionSource;
  private readonly rowsSource?: FullScreenDimensionSource;
  private readonly tty: boolean;

  private active = false;
  private closed = false;
  private currentSize: FullScreenSize;
  private sourceRows: readonly string[] = [];
  private renderedRows: readonly string[] = [];

  constructor();
  constructor(output: ScreenOutput);
  constructor(options: FullScreenWriterOptions);
  constructor(
    outputOrOptions: ScreenOutput | FullScreenWriterOptions = process.stdout,
  ) {
    if (isScreenOutput(outputOrOptions)) {
      this.output = outputOrOptions;
    } else {
      this.output = outputOrOptions.output ?? process.stdout;
      this.columnsSource = outputOrOptions.columns;
      this.rowsSource = outputOrOptions.rows;
    }
    this.tty = Boolean(this.output.isTTY);
    this.currentSize = this.readSize();
  }

  get isTTY(): boolean {
    return this.tty;
  }

  get isActive(): boolean {
    return this.active;
  }

  get size(): FullScreenSize {
    return { ...this.currentSize };
  }

  /** Enter the alternate buffer and paint the most recently supplied frame. */
  enter(): void {
    if (this.closed || this.active || !this.tty) return;
    this.currentSize = this.readSize();
    this.active = true;
    this.renderedRows = blankRows(this.currentSize.rows);
    this.write(FULL_SCREEN_ENTER_SEQUENCE);
    this.paint();
  }

  /**
   * Replace the fixed-size frame.
   *
   * Supplying fewer rows leaves the remaining viewport rows blank; supplying
   * more rows ignores rows below the physical viewport. An identical frame
   * writes no terminal data. Only changed physical rows are repainted.
   */
  render(rows: readonly string[]): void {
    if (this.closed) return;
    this.sourceRows = Array.from(rows);
    if (this.active) this.paint();
  }

  /** Clear the alternate frame without leaving the alternate buffer. */
  clear(): void {
    this.render([]);
  }

  /**
   * Refresh dimensions after a caller-observed terminal resize.
   *
   * With no arguments dimensions are reread from the configured sources (or
   * the output stream). A supplied size is useful for adapters that receive
   * dimensions directly in their resize event. A real size change clears and
   * repaints the alternate buffer; a no-op resize emits nothing.
   */
  resize(): boolean;
  resize(size: Partial<FullScreenSize>): boolean;
  resize(columns: number, rows: number): boolean;
  resize(
    sizeOrColumns?: Partial<FullScreenSize> | number,
    explicitRows?: number,
  ): boolean {
    if (this.closed) return false;
    const observed = this.readSize();
    const requested = typeof sizeOrColumns === "number"
      ? { columns: sizeOrColumns, rows: explicitRows }
      : sizeOrColumns ?? {};
    const nextSize = {
      columns: normalizeDimension(
        requested.columns ?? observed.columns,
        DEFAULT_COLUMNS,
        MAX_COLUMNS,
      ),
      rows: normalizeDimension(
        requested.rows ?? observed.rows,
        DEFAULT_ROWS,
        MAX_ROWS,
      ),
    };
    if (
      nextSize.columns === this.currentSize.columns &&
      nextSize.rows === this.currentSize.rows
    ) {
      return false;
    }

    this.currentSize = nextSize;
    this.renderedRows = blankRows(nextSize.rows);
    if (this.active) {
      this.write(CLEAR_SCREEN + HOME);
      this.paint();
    }
    return true;
  }

  /**
   * Leave the alternate buffer while keeping this writer reusable.
   *
   * This is useful when an application temporarily yields the terminal to an
   * external program. Calling exit repeatedly is safe; a later enter repaints
   * the retained source frame from a clean alternate buffer.
   */
  exit(): void {
    if (!this.active) return;
    if (this.tty) this.write(FULL_SCREEN_EXIT_SEQUENCE);
    this.active = false;
    this.renderedRows = [];
  }

  /**
   * Restore every terminal mode owned by this writer and end its lifecycle.
   *
   * close is intentionally idempotent and does not end or destroy the output
   * stream. Process signal/exception handlers belong to the caller.
   */
  close(): void {
    if (this.closed) return;
    this.exit();
    this.closed = true;
  }

  private paint(): void {
    const nextRows = normalizeFrame(this.sourceRows, this.currentSize);
    let output = "";

    for (let index = 0; index < nextRows.length; index += 1) {
      const next = nextRows[index] ?? "";
      const previous = this.renderedRows[index] ?? "";
      if (next === previous) continue;
      output += cursorPosition(index + 1, 1) + ERASE_LINE + next;
    }

    this.renderedRows = nextRows;
    this.write(output);
  }

  private readSize(): FullScreenSize {
    return {
      columns: normalizeDimension(
        readDimension(this.columnsSource) ?? this.output.columns,
        DEFAULT_COLUMNS,
        MAX_COLUMNS,
      ),
      rows: normalizeDimension(
        readDimension(this.rowsSource) ?? this.output.rows,
        DEFAULT_ROWS,
        MAX_ROWS,
      ),
    };
  }

  private write(value: string): void {
    if (value) this.output.write(value);
  }
}

function normalizeFrame(
  sourceRows: readonly string[],
  size: FullScreenSize,
): readonly string[] {
  return Array.from(
    { length: size.rows },
    (_, index) => normalizeRow(sourceRows[index] ?? "", size.columns),
  );
}

function normalizeRow(value: string, columns: number): string {
  const safe = sanitizeTerminalText(value, { allowSgr: true })
    .replace(/\n/gu, " ");
  return truncateToWidth(safe, columns, { preserveAnsi: true });
}

function blankRows(rows: number): readonly string[] {
  return Array.from({ length: rows }, () => "");
}

function cursorPosition(row: number, column: number): string {
  return `\u001B[${row};${column}H`;
}

function isScreenOutput(
  value: ScreenOutput | FullScreenWriterOptions,
): value is ScreenOutput {
  return typeof (value as ScreenOutput).write === "function";
}

function readDimension(
  source: FullScreenDimensionSource | undefined,
): number | undefined {
  if (typeof source !== "function") return source;
  try {
    return source();
  } catch {
    return undefined;
  }
}

function normalizeDimension(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value ?? fallback)));
}
