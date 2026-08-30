import readline from "node:readline";
import { randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

import { stripTerminalControls } from "../command/output-stream.js";
import type { ImageAttachment } from "../core/types.js";
import {
  sanitizeTerminalText,
  wrapToWidth,
} from "../ui/render/layout.js";

export interface PromptInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly readableFlowing?: boolean | null;
  setRawMode?(mode: boolean): this;
}

export interface PromptOutput extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
}

export interface PromptSubmission {
  readonly text: string;
  readonly images: ImageAttachment[];
  readonly pasteErrors: string[];
}

export interface PromptInputSession {
  /**
   * Commit stable terminal output above the active readline edit buffer.
   * A missing final line break is added; calls after release are ignored.
   */
  writeAbove(text: string): void;
  /** Re-render optional live content below the active edit buffer. */
  refreshBelow(): void;
}

export interface ReadPromptOptions {
  readonly input: PromptInput;
  readonly output: PromptOutput;
  readonly prompt: string;
  /**
   * Rebuild the readline prefix while the prompt is active. This is used for
   * interactive content that belongs above the edit buffer, such as an
   * expanded Thinking panel. Terminal controls are filtered before display.
   */
  readonly renderPrompt?: () => string;
  readonly initialImageCount?: number;
  readonly signal?: AbortSignal;
  readonly captureImage: (
    index: number,
    signal?: AbortSignal,
  ) => Promise<ImageAttachment>;
  readonly captureText?: (signal?: AbortSignal) => Promise<string | undefined>;
  readonly onShowThinking?: (
    id: number | "last",
  ) => void | Promise<void>;
  /** Toggle one live Thinking panel from the private VS Code mouse protocol. */
  readonly onToggleThinking?: (
    id: number,
  ) => void | Promise<void>;
  readonly onSessionReady?: (
    session: PromptInputSession | undefined,
  ) => void;
  /** Render live rows below the readline buffer; terminal controls are filtered. */
  readonly renderBelow?: () => string;
  /** Erase the readline chrome after submission so callers can commit a plain transcript row. */
  readonly clearOnSubmit?: boolean;
}

const ESCAPE = 0x1b;
const CTRL_C = 0x03;
const CTRL_T = 0x14;
const CTRL_V = 0x16;
const OSC_BEL = 0x07;
const MAX_PRIVATE_OSC_BYTES = 160;
const MAX_CLIPBOARD_TEXT_CHARS = 256 * 1024;
const MAX_BRACKETED_PASTE_BYTES = (MAX_CLIPBOARD_TEXT_CHARS * 4) + 64;
const BRACKETED_PASTE_START = Buffer.from("\u001B[200~");
const BRACKETED_PASTE_END = Buffer.from("\u001B[201~");
const ENABLE_BRACKETED_PASTE = "\u001B[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001B[?2004l";
/**
 * Private input sequence sent by the bundled VS Code extension. It is framed
 * like an OSC message so it cannot be confused with text or a real key emitted
 * by a legacy terminal. The extension only sends it while an EASY CODE process
 * owns the active integrated terminal.
 */
export const VSCODE_IMAGE_PASTE_SEQUENCE = "\u001B]6973;easy-code;paste-image\u0007";
export const VSCODE_SHOW_THINKING_SEQUENCE_PREFIX =
  "\u001B]6973;easy-code;show-thinking;";
export const VSCODE_TOGGLE_THINKING_SEQUENCE_PREFIX =
  "\u001B]6973;easy-code;toggle-thinking;";

export function vscodeToggleThinkingSequence(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Thinking block ID must be a positive safe integer");
  }
  return `${VSCODE_TOGGLE_THINKING_SEQUENCE_PREFIX}${id}\u0007`;
}

/** @deprecated Compatibility helper for already-installed VS Code clients. */
export function vscodeShowThinkingSequence(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Thinking block ID must be a positive safe integer");
  }
  return `${VSCODE_SHOW_THINKING_SEQUENCE_PREFIX}${id}\u0007`;
}

const IMAGE_PASTE_SEQUENCES = [
  Buffer.from("\u001B[118;5u"), // Ctrl+V
  Buffer.from("\u001B[118;6u"), // Ctrl+Shift+V
  Buffer.from("\u001B[118;9u"), // Super/Command+V
] as const;

const PRIVATE_OSC_PREFIX = Buffer.from("\u001B]6973;easy-code;");

type PrivateOscParseResult =
  | { readonly status: "none" }
  | { readonly status: "partial" }
  | {
      readonly status: "complete";
      readonly length: number;
      readonly action:
        | { readonly type: "paste-image" }
        | { readonly type: "toggle-thinking"; readonly id: number }
        | { readonly type: "ignore" };
    };

function parsePrivateOsc(input: Buffer, offset: number): PrivateOscParseResult {
  const tail = input.subarray(offset);
  const comparedLength = Math.min(tail.length, PRIVATE_OSC_PREFIX.length);
  if (
    !tail.subarray(0, comparedLength).equals(
      PRIVATE_OSC_PREFIX.subarray(0, comparedLength),
    )
  ) {
    return { status: "none" };
  }
  if (tail.length < PRIVATE_OSC_PREFIX.length) return { status: "partial" };

  const terminator = tail.indexOf(OSC_BEL, PRIVATE_OSC_PREFIX.length);
  if (terminator === -1) {
    if (tail.length <= MAX_PRIVATE_OSC_BYTES) return { status: "partial" };
    return {
      status: "complete",
      length: tail.length,
      action: { type: "ignore" },
    };
  }

  const length = terminator + 1;
  if (length > MAX_PRIVATE_OSC_BYTES) {
    return { status: "complete", length, action: { type: "ignore" } };
  }
  const payload = tail
    .subarray(PRIVATE_OSC_PREFIX.length, terminator)
    .toString("utf8");
  if (payload === "paste-image") {
    return { status: "complete", length, action: { type: "paste-image" } };
  }
  const thinking = /^(?:toggle|show)-thinking;([1-9][0-9]{0,15})$/u.exec(payload);
  if (thinking) {
    const id = Number(thinking[1]);
    if (Number.isSafeInteger(id)) {
      return {
        status: "complete",
        length,
        action: { type: "toggle-thinking", id },
      };
    }
  }
  return { status: "complete", length, action: { type: "ignore" } };
}

/**
 * Swallow EASY CODE's private VS Code protocol while another input UI (for
 * example an approval or secret prompt) owns stdin. Ordinary keys and escape
 * sequences pass through unchanged, including when split across chunks.
 */
export class PrivateOscInputFilter extends Transform implements PromptInput {
  private pendingSequence = Buffer.alloc(0);
  private pendingPrivateOsc = false;
  private escapeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly source: PromptInput,
    private readonly onToggleThinking?: (id: number) => void,
    private readonly onInterrupt?: () => void,
  ) {
    super();
  }

  get isTTY(): boolean {
    return Boolean(this.source.isTTY);
  }

  get isRaw(): boolean {
    return Boolean(this.source.isRaw);
  }

  setRawMode(mode: boolean): this {
    this.source.setRawMode?.(mode);
    return this;
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    const input = this.pendingSequence.length
      ? Buffer.concat([this.pendingSequence, data])
      : data;
    if (this.pendingSequence.length) {
      this.clearEscapeTimer();
      this.pendingSequence = Buffer.alloc(0);
      this.pendingPrivateOsc = false;
    }

    const output: number[] = [];
    let offset = 0;
    while (offset < input.length) {
      const byte = input[offset];
      if (byte === ESCAPE) {
        const privateOsc = parsePrivateOsc(input, offset);
        if (privateOsc.status === "complete") {
          if (privateOsc.action.type === "toggle-thinking") {
            this.onToggleThinking?.(privateOsc.action.id);
          }
          // Private messages are always consumed. Callers without a toggle
          // callback intentionally swallow them while another input UI owns
          // stdin; the busy request owner handles only its narrow callback.
          offset += privateOsc.length;
          continue;
        }
        if (privateOsc.status === "partial") {
          const tail = input.subarray(offset);
          this.pendingSequence = Buffer.from(tail);
          this.pendingPrivateOsc =
            tail.length >= 2 && tail[0] === ESCAPE && tail[1] === 0x5d;
          this.startEscapeTimer(this.pendingPrivateOsc ? 250 : 60);
          break;
        }
      }
      if (byte === CTRL_C) this.onInterrupt?.();
      if (byte !== undefined) output.push(byte);
      offset += 1;
    }
    callback(undefined, output.length ? Buffer.from(output) : undefined);
  }

  override _flush(callback: TransformCallback): void {
    this.clearEscapeTimer();
    if (!this.pendingSequence.length) {
      callback();
      return;
    }
    const pending = this.pendingSequence;
    this.pendingSequence = Buffer.alloc(0);
    const discard = this.pendingPrivateOsc;
    this.pendingPrivateOsc = false;
    callback(undefined, discard ? undefined : pending);
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.clearEscapeTimer();
    callback(error);
  }

  private startEscapeTimer(delayMs: number): void {
    this.clearEscapeTimer();
    this.escapeTimer = setTimeout(() => {
      if (!this.pendingSequence.length || this.destroyed) return;
      const pending = this.pendingSequence;
      this.pendingSequence = Buffer.alloc(0);
      const discard = this.pendingPrivateOsc;
      this.pendingPrivateOsc = false;
      if (!discard) this.push(pending);
    }, delayMs);
    this.escapeTimer.unref?.();
  }

  private clearEscapeTimer(): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
  }
}

/**
 * A TTY proxy that turns an image-paste hotkey into visible `[Image #N]`
 * input. Delaying the transform callback while the clipboard is read also
 * keeps a following Enter key behind the attachment operation.
 */
class ImagePasteInputProxy extends Transform {
  readonly isTTY = true;
  readonly images: ImageAttachment[] = [];
  readonly pasteErrors: string[] = [];

  private pendingSequence = Buffer.alloc(0);
  private pendingPrivateOsc = false;
  private escapeTimer?: ReturnType<typeof setTimeout>;
  private bracketedPasteActive = false;
  private bracketedPasteRejected = false;
  private bracketedPasteBuffer = Buffer.alloc(0);
  private pastedTextSequence = 0;
  private readonly pastedTextBlocks = new Map<string, string>();

  constructor(
    private readonly source: PromptInput,
    private readonly initialImageCount: number,
    private readonly captureImage: (
      index: number,
      signal?: AbortSignal,
    ) => Promise<ImageAttachment>,
    private readonly captureText?: (
      signal?: AbortSignal,
    ) => Promise<string | undefined>,
    private readonly onShowThinking?: (
      id: number | "last",
    ) => void | Promise<void>,
    private readonly onToggleThinking?: (
      id: number,
    ) => void | Promise<void>,
    private readonly signal?: AbortSignal,
  ) {
    super();
  }

  get isRaw(): boolean {
    return Boolean(this.source.isRaw);
  }

  setRawMode(mode: boolean): this {
    this.source.setRawMode?.(mode);
    return this;
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    void this.process(data).then(
      (output) => callback(undefined, output.length ? output : undefined),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  }

  override _flush(callback: TransformCallback): void {
    this.clearEscapeTimer();
    if (this.pendingSequence.length) {
      const pending = this.pendingSequence;
      this.pendingSequence = Buffer.alloc(0);
      const discard = this.pendingPrivateOsc;
      this.pendingPrivateOsc = false;
      callback(undefined, discard ? undefined : pending);
      return;
    }
    this.bracketedPasteActive = false;
    this.bracketedPasteRejected = false;
    this.bracketedPasteBuffer = Buffer.alloc(0);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.clearEscapeTimer();
    this.bracketedPasteActive = false;
    this.bracketedPasteRejected = false;
    this.bracketedPasteBuffer = Buffer.alloc(0);
    callback(error);
  }

  expandPastedText(value: string): string {
    let expanded = "";
    let offset = 0;
    while (offset < value.length) {
      let nextIndex = -1;
      let nextMarker: string | undefined;
      for (const marker of this.pastedTextBlocks.keys()) {
        const index = value.indexOf(marker, offset);
        if (index >= 0 && (nextIndex === -1 || index < nextIndex)) {
          nextIndex = index;
          nextMarker = marker;
        }
      }
      if (nextIndex === -1 || !nextMarker) {
        expanded += stripInternalPasteNonce(value.slice(offset));
        break;
      }
      expanded += stripInternalPasteNonce(value.slice(offset, nextIndex));
      expanded += this.pastedTextBlocks.get(nextMarker) ?? nextMarker;
      offset = nextIndex + nextMarker.length;
    }
    return expanded;
  }

  private async process(data: Buffer): Promise<Buffer> {
    const input = this.pendingSequence.length
      ? Buffer.concat([this.pendingSequence, data])
      : data;
    if (this.pendingSequence.length) {
      this.clearEscapeTimer();
      this.pendingSequence = Buffer.alloc(0);
      this.pendingPrivateOsc = false;
    }
    const output: number[] = [];
    let offset = 0;

    while (offset < input.length) {
      if (this.bracketedPasteActive) {
        const existingLength = this.bracketedPasteBuffer.length;
        const combined = existingLength > 0
          ? Buffer.concat([this.bracketedPasteBuffer, input.subarray(offset)])
          : input.subarray(offset);
        const terminator = combined.indexOf(BRACKETED_PASTE_END);
        if (terminator === -1) {
          if (!this.bracketedPasteRejected && combined.length > MAX_BRACKETED_PASTE_BYTES) {
            this.pasteErrors.push("Pasted text exceeds the 256 KiB input limit.");
            output.push(...Buffer.from(" [Text paste failed] ", "utf8"));
            this.bracketedPasteRejected = true;
          }
          if (this.bracketedPasteRejected) {
            // Continue swallowing the rejected paste until its closing marker,
            // retaining only enough bytes to recognize a fragmented terminator.
            this.bracketedPasteBuffer = Buffer.from(
              combined.subarray(Math.max(0, combined.length - BRACKETED_PASTE_END.length + 1)),
            );
          } else {
            this.bracketedPasteBuffer = Buffer.from(combined);
          }
          break;
        }

        const consumedFromInput = Math.max(
          0,
          terminator + BRACKETED_PASTE_END.length - existingLength,
        );
        offset += consumedFromInput;
        this.bracketedPasteActive = false;
        this.bracketedPasteBuffer = Buffer.alloc(0);
        if (!this.bracketedPasteRejected && terminator > MAX_BRACKETED_PASTE_BYTES) {
          this.pasteErrors.push("Pasted text exceeds the 256 KiB input limit.");
          output.push(...Buffer.from(" [Text paste failed] ", "utf8"));
          this.bracketedPasteRejected = true;
        }
        if (!this.bracketedPasteRejected) {
          try {
            const body = combined.subarray(0, terminator).toString("utf8");
            output.push(...Buffer.from(this.pastedTextForPrompt(body), "utf8"));
          } catch (error) {
            this.pasteErrors.push(
              error instanceof Error ? error.message : String(error),
            );
            output.push(...Buffer.from(" [Text paste failed] ", "utf8"));
          }
        }
        this.bracketedPasteRejected = false;
        continue;
      }

      const byte = input[offset];
      if (byte === CTRL_V) {
        output.push(...Buffer.from(await this.captureMarker(), "utf8"));
        offset += 1;
        continue;
      }
      if (byte === CTRL_T) {
        await this.onShowThinking?.("last");
        offset += 1;
        continue;
      }
      if (byte === ESCAPE) {
        const tail = input.subarray(offset);
        if (
          tail.length >= BRACKETED_PASTE_START.length &&
          tail.subarray(0, BRACKETED_PASTE_START.length).equals(BRACKETED_PASTE_START)
        ) {
          this.bracketedPasteActive = true;
          this.bracketedPasteRejected = false;
          this.bracketedPasteBuffer = Buffer.alloc(0);
          offset += BRACKETED_PASTE_START.length;
          continue;
        }
        const privateOsc = parsePrivateOsc(input, offset);
        if (privateOsc.status === "complete") {
          if (privateOsc.action.type === "paste-image") {
            output.push(...Buffer.from(await this.captureMarker(), "utf8"));
          } else if (privateOsc.action.type === "toggle-thinking") {
            await this.onToggleThinking?.(privateOsc.action.id);
          }
          offset += privateOsc.length;
          continue;
        }
        const enhanced = IMAGE_PASTE_SEQUENCES.find((sequence) =>
          input.subarray(offset, offset + sequence.length).equals(sequence),
        );
        if (enhanced) {
          output.push(...Buffer.from(await this.captureMarker(), "utf8"));
          offset += enhanced.length;
          continue;
        }
        const partialBracketedPaste =
          tail.length < BRACKETED_PASTE_START.length &&
          BRACKETED_PASTE_START.subarray(0, tail.length).equals(tail);
        const mayBePasteSequence =
          privateOsc.status === "partial" ||
          partialBracketedPaste ||
          tail.length === 1 ||
          IMAGE_PASTE_SEQUENCES.some(
            (sequence) => tail.length < sequence.length && sequence.subarray(0, tail.length).equals(tail),
          );
        if (mayBePasteSequence) {
          this.pendingSequence = Buffer.from(tail);
          this.pendingPrivateOsc =
            (tail.length >= 2 && tail[0] === ESCAPE && tail[1] === 0x5d) ||
            partialBracketedPaste;
          this.startEscapeTimer(this.pendingPrivateOsc ? 250 : 60);
          break;
        }
      }
      if (byte !== undefined) output.push(byte);
      offset += 1;
    }
    return Buffer.from(output);
  }

  private async captureMarker(): Promise<string> {
    const index = this.initialImageCount + this.images.length + 1;
    try {
      if (this.signal?.aborted) throw new Error("Image paste was canceled.");
      const attachment = await this.captureImage(index, this.signal);
      if (this.signal?.aborted) throw new Error("Image paste was canceled.");
      const expectedLabel = `Image #${index}`;
      if (attachment.label !== expectedLabel) {
        throw new Error(`Captured image label must be ${expectedLabel}.`);
      }
      this.images.push(attachment);
      return ` [${expectedLabel}] `;
    } catch (error) {
      let pasteError = error;
      if (!this.signal?.aborted && this.captureText) {
        try {
          const text = await this.captureText(this.signal);
          if (text) {
            try {
              return this.pastedTextForPrompt(text);
            } catch (textError) {
              pasteError = textError;
            }
          }
        } catch {
          // Preserve the original image error when text fallback is unavailable.
        }
      }
      this.pasteErrors.push(
        pasteError instanceof Error ? pasteError.message : String(pasteError),
      );
      return " [Image paste failed] ";
    }
  }

  private pastedTextForPrompt(value: string): string {
    const normalized = stripTerminalControls(
      value.replace(/\r\n?|\u2028|\u2029/gu, "\n"),
    );
    if (normalized.length > MAX_CLIPBOARD_TEXT_CHARS) {
      throw new Error("Pasted text exceeds the 256 KiB input limit.");
    }
    if (!/[\n\t]/u.test(normalized)) return normalized;

    this.pastedTextSequence += 1;
    const lineCount = normalized.split("\n").length;
    const marker = ` [Pasted text #${this.pastedTextSequence} · ${lineCount} ${lineCount === 1 ? "line" : "lines"}]${invisiblePasteNonce()} `;
    this.pastedTextBlocks.set(marker, normalized);
    return marker;
  }

  private startEscapeTimer(delayMs: number): void {
    this.clearEscapeTimer();
    this.escapeTimer = setTimeout(() => {
      if (!this.pendingSequence.length || this.destroyed) return;
      const pending = this.pendingSequence;
      this.pendingSequence = Buffer.alloc(0);
      const discard = this.pendingPrivateOsc;
      this.pendingPrivateOsc = false;
      if (!discard) this.push(pending);
    }, delayMs);
    this.escapeTimer.unref?.();
  }

  private clearEscapeTimer(): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
  }
}

export function readPrompt(
  options: ReadPromptOptions,
): Promise<PromptSubmission | null> {
  if (
    !options.input.isTTY ||
    !options.output.isTTY ||
    typeof options.input.setRawMode !== "function"
  ) {
    throw new Error("Image-aware prompting requires an interactive TTY.");
  }

  const initialImageCount = options.initialImageCount ?? 0;
  if (!Number.isInteger(initialImageCount) || initialImageCount < 0) {
    throw new Error("Initial image count must be a non-negative integer.");
  }

  const input = options.input;
  const wasRaw = Boolean(input.isRaw);
  const wasFlowing = input.readableFlowing === true;
  const captureController = new AbortController();
  let promptActive = true;
  let sessionReady = false;
  let promptSuspensionDepth = 0;
  let suspendedLine = "";
  let suspendedCursor = 0;
  let belowRendered = false;
  let resizeInProgress = false;
  let suspendedPromptVisibleAfterResize = false;
  let scheduledBelowDraw: ReturnType<typeof setImmediate> | undefined;
  let renderedCursorPosition: { rows: number; cols: number } | undefined;
  let renderedEndPosition: { rows: number; cols: number } | undefined;
  let latestPromptEndPosition: { rows: number; cols: number } | undefined;
  let bracketedPasteEnabled = false;
  let renderedPrompt = options.prompt;
  let rl!: readline.Interface;

  const resolvePrompt = (): string => {
    if (!options.renderPrompt) return renderedPrompt;
    try {
      const next = sanitizeTerminalText(options.renderPrompt(), {
        allowSgr: true,
      });
      return next || renderedPrompt;
    } catch {
      // A dynamic prefix is decorative. Keep the last valid prompt if its
      // renderer fails so the user never loses the active edit buffer.
      return renderedPrompt;
    }
  };
  const updatePrompt = (): string => {
    renderedPrompt = resolvePrompt();
    rl.setPrompt(renderedPrompt);
    return renderedPrompt;
  };

  const promptGeometry = (
    line = rl.line,
    cursor = rl.cursor,
  ): {
    cursorPosition: { rows: number; cols: number };
    endPosition: { rows: number; cols: number };
  } => {
    const mutableReadline = rl as unknown as { cursor: number };
    const originalCursor = rl.cursor;
    try {
      mutableReadline.cursor = cursor;
      const cursorPosition = rl.getCursorPos();
      mutableReadline.cursor = line.length;
      const endPosition = rl.getCursorPos();
      return { cursorPosition, endPosition };
    } finally {
      mutableReadline.cursor = originalCursor;
    }
  };
  const moveToPromptEnd = (
    cursorPosition: { rows: number; cols: number },
    endPosition: { rows: number; cols: number },
  ): number => {
    const rowsDown = Math.max(0, endPosition.rows - cursorPosition.rows);
    if (rowsDown > 0) readline.moveCursor(options.output, 0, rowsDown);
    readline.cursorTo(options.output, endPosition.cols);
    return rowsDown;
  };
  const eraseSuspendedResizePrompt = (): void => {
    if (!suspendedPromptVisibleAfterResize) return;
    const position = rl.getCursorPos();
    if (position.rows > 0) {
      readline.moveCursor(options.output, 0, -position.rows);
    }
    readline.cursorTo(options.output, 0);
    readline.clearScreenDown(options.output);
    (rl as unknown as { prevRows?: number }).prevRows = 0;
    suspendedPromptVisibleAfterResize = false;
  };
  const eraseBelow = (): void => {
    const cursorPosition = renderedCursorPosition;
    const endPosition = renderedEndPosition;
    belowRendered = false;
    renderedCursorPosition = undefined;
    renderedEndPosition = undefined;
    if (!cursorPosition || !endPosition) return;

    const rowsDown = moveToPromptEnd(cursorPosition, endPosition);
    readline.moveCursor(options.output, 0, 1);
    readline.cursorTo(options.output, 0);
    readline.clearScreenDown(options.output);
    readline.moveCursor(options.output, 0, -(rowsDown + 1));
    readline.cursorTo(options.output, cursorPosition.cols);
  };
  const drawBelow = (): void => {
    if (scheduledBelowDraw) {
      clearImmediate(scheduledBelowDraw);
      scheduledBelowDraw = undefined;
    }
    if (
      !promptActive ||
      promptSuspensionDepth > 0 ||
      resizeInProgress ||
      !options.renderBelow
    ) {
      return;
    }
    if (belowRendered) eraseBelow();

    let source = "";
    try {
      source = sanitizeTerminalText(options.renderBelow(), { allowSgr: true });
    } catch {
      // A decorative renderer must never make the input itself unusable.
      return;
    }
    if (!source) return;

    const columnsValue = Number(options.output.columns);
    const columns = Number.isFinite(columnsValue) && columnsValue > 0
      ? Math.max(1, Math.floor(columnsValue))
      : 80;
    const lines = wrapToWidth(source, columns, { preserveAnsi: true });
    if (lines.length === 0) return;

    const geometry = promptGeometry();
    const rowsDown = moveToPromptEnd(
      geometry.cursorPosition,
      geometry.endPosition,
    );
    options.output.write(`\r\n${lines.join("\r\n")}`);
    readline.moveCursor(options.output, 0, -(rowsDown + lines.length));
    readline.cursorTo(options.output, geometry.cursorPosition.cols);
    renderedCursorPosition = geometry.cursorPosition;
    renderedEndPosition = geometry.endPosition;
    belowRendered = true;
  };
  const refreshBelow = (): void => {
    if (!promptActive) return;
    if (promptSuspensionDepth > 0 || resizeInProgress) {
      return;
    }
    if (resolvePrompt() !== renderedPrompt) {
      if (suspendPrompt()) resumePrompt();
      return;
    }
    eraseBelow();
    drawBelow();
  };
  const scheduleBelowDraw = (): void => {
    if (scheduledBelowDraw || !promptActive) return;
    scheduledBelowDraw = setImmediate(() => {
      scheduledBelowDraw = undefined;
      drawBelow();
    });
  };
  const suspendPrompt = (): boolean => {
    if (!promptActive) return false;
    promptSuspensionDepth += 1;
    if (promptSuspensionDepth > 1) {
      // A resize can make readline repaint while an outer async suspension is
      // active. Hide that synchronized repaint before nested stable output.
      eraseSuspendedResizePrompt();
      return true;
    }

    eraseBelow();
    suspendedLine = rl.line;
    suspendedCursor = rl.cursor;
    const savedPosition = rl.getCursorPos();

    // Remove every visual row occupied by the wrapped edit buffer. Stable
    // output can now be written at the prompt's former first row.
    if (savedPosition.rows > 0) {
      readline.moveCursor(options.output, 0, -savedPosition.rows);
    }
    readline.cursorTo(options.output, 0);
    readline.clearScreenDown(options.output);
    (rl as unknown as { prevRows?: number }).prevRows = 0;
    suspendedPromptVisibleAfterResize = false;
    return true;
  };
  const resumePrompt = (): void => {
    if (promptSuspensionDepth === 0) return;
    promptSuspensionDepth -= 1;
    if (promptSuspensionDepth > 0) return;
    if (!promptActive) return;

    // readline is allowed to remain physically synchronized across any number
    // of resize events during an async suspension. Remove that old repaint once
    // at the latest geometry before drawing the state-derived prefix.
    eraseSuspendedResizePrompt();

    // Resolve the prefix after the state-changing callback. readline must know
    // about every added/removed row before getCursorPos() calculates geometry.
    const prompt = updatePrompt();

    // Recalculate visual positions in case the terminal was resized while an
    // asynchronous expansion kept the prompt hidden.
    const mutableReadline = rl as unknown as { cursor: number };
    mutableReadline.cursor = suspendedCursor;
    const savedPosition = rl.getCursorPos();
    mutableReadline.cursor = suspendedLine.length;
    const endPosition = rl.getCursorPos();
    mutableReadline.cursor = suspendedCursor;

    // readline.prompt() does not reliably repaint an existing edit buffer
    // after out-of-band output, so redraw it and restore its visual cursor.
    options.output.write(`${prompt}${suspendedLine}`);
    const rowsUp = Math.max(0, endPosition.rows - savedPosition.rows);
    if (rowsUp > 0) {
      readline.moveCursor(options.output, 0, -rowsUp);
    }
    readline.cursorTo(options.output, savedPosition.cols);
    (rl as unknown as { prevRows?: number }).prevRows = savedPosition.rows;
    drawBelow();
  };
  const promptSession: PromptInputSession = {
    writeAbove(text: string): void {
      if (!text || !suspendPrompt()) return;
      try {
        const atLineStart = stripTerminalControls(text).endsWith("\n");
        options.output.write(atLineStart ? text : `${text}\n`);
      } finally {
        resumePrompt();
      }
    },
    refreshBelow,
  };
  const showThinking = options.onShowThinking
    ? async (id: number | "last"): Promise<void> => {
        if (!suspendPrompt()) return;
        try {
          await options.onShowThinking?.(id);
        } finally {
          resumePrompt();
        }
      }
    : undefined;
  const toggleThinking = options.onToggleThinking
    ? async (id: number): Promise<void> => {
        if (!suspendPrompt()) return;
        try {
          await options.onToggleThinking?.(id);
        } finally {
          resumePrompt();
        }
      }
    : undefined;
  const proxy = new ImagePasteInputProxy(
    input,
    initialImageCount,
    options.captureImage,
    options.captureText,
    showThinking,
    toggleThinking,
    captureController.signal,
  );
  rl = readline.createInterface({
    input: proxy,
    output: options.output,
    terminal: true,
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      if (scheduledBelowDraw) clearImmediate(scheduledBelowDraw);
      scheduledBelowDraw = undefined;
      try {
        eraseBelow();
        eraseSuspendedResizePrompt();
      } catch {
        // Raw-mode and stream cleanup still matter if the TTY disappeared.
      }
      promptActive = false;
      promptSuspensionDepth = 0;
      if (sessionReady) {
        sessionReady = false;
        try {
          options.onSessionReady?.(undefined);
        } catch {
          // Cleanup and raw-mode restoration must not depend on a lifecycle hook.
        }
      }
      captureController.abort();
      if (bracketedPasteEnabled) {
        bracketedPasteEnabled = false;
        try {
          options.output.write(DISABLE_BRACKETED_PASTE);
        } catch {
          // The terminal may have disappeared while the prompt was active.
        }
      }
      rl.removeListener("close", onClose);
      rl.removeListener("line", onLine);
      proxy.removeListener("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
      input.removeListener("data", onRawInput);
      proxy.removeListener("keypress", onBeforeKeypress);
      proxy.removeListener("keypress", onAfterKeypress);
      options.output.removeListener("resize", onBeforeResize);
      options.output.removeListener("resize", onAfterResize);
      input.unpipe(proxy);
      if (!proxy.destroyed) proxy.destroy();
      try {
        input.setRawMode?.(wasRaw);
      } catch {
        // The TTY may have disappeared while the prompt was active.
      }
      if (wasFlowing) input.resume();
      else input.pause();
    };
    const finish = (
      answer?: string,
      error?: Error,
      closeInterface = true,
    ): void => {
      if (settled) return;
      settled = true;
      rl.removeListener("close", onClose);
      if (closeInterface) {
        try {
          eraseBelow();
        } catch {
          // Closing the interface must not depend on decorative output.
        }
        rl.close();
      }
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      if (answer === undefined) {
        resolve(null);
        return;
      }
      resolve({
        text: proxy.expandPastedText(answer),
        images: [...proxy.images],
        pasteErrors: [...proxy.pasteErrors],
      });
    };
    const onClose = (): void => finish(undefined, undefined, false);
    const eraseSubmittedPrompt = (): void => {
      if (!options.clearOnSubmit || !latestPromptEndPosition) return;
      readline.cursorTo(options.output, 0);
      readline.moveCursor(options.output, 0, -(latestPromptEndPosition.rows + 1));
      readline.clearScreenDown(options.output);
      latestPromptEndPosition = undefined;
    };
    const onLine = (answer: string): void => {
      eraseSubmittedPrompt();
      finish(answer);
    };
    const onError = (): void => finish(undefined, new Error("Unable to read terminal input."));
    const onAbort = (): void => finish();
    const onRawInput = (chunk: Buffer | string): void => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (data.includes(CTRL_C)) finish();
    };
    const onBeforeKeypress = (): void => {
      eraseBelow();
      if (options.clearOnSubmit) {
        latestPromptEndPosition = promptGeometry().endPosition;
      }
    };
    const onAfterKeypress = (): void => {
      // One input chunk can contain a large paste. Redraw once after readline
      // consumes the burst instead of once for every decoded character.
      scheduleBelowDraw();
    };
    const onBeforeResize = (): void => {
      resizeInProgress = true;
      eraseBelow();
      if (promptSuspensionDepth === 0) updatePrompt();
    };
    const onAfterResize = (): void => {
      resizeInProgress = false;
      if (promptSuspensionDepth > 0) {
        // Leave readline's repaint visible and internally synchronized. A
        // later resize can now replace it without walking into stable output;
        // resumePrompt() removes it once when the async action settles.
        suspendedPromptVisibleAfterResize = true;
        return;
      }
      drawBelow();
    };

    rl.once("close", onClose);
    rl.once("line", onLine);
    proxy.once("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      finish();
      return;
    }
    if (options.renderBelow || options.renderPrompt || options.clearOnSubmit) {
      // readline's own keypress/resize listeners remain the sole owners of the
      // edit buffer. We only clear decoration immediately before their redraw
      // and restore it immediately afterward.
      proxy.prependListener("keypress", onBeforeKeypress);
      proxy.on("keypress", onAfterKeypress);
      if (options.renderBelow || options.renderPrompt) {
        options.output.prependListener("resize", onBeforeResize);
        options.output.on("resize", onAfterResize);
      }
    }
    input.pipe(proxy);
    // Observe the source as well as the serialized Transform. A clipboard read
    // deliberately holds the Transform callback so Enter stays ordered behind
    // it, but Ctrl+C must still be able to abort that read immediately.
    input.on("data", onRawInput);
    bracketedPasteEnabled = true;
    try {
      options.output.write(ENABLE_BRACKETED_PASTE);
    } catch (error) {
      finish(
        undefined,
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }
    // Keep the prompt and submitted line owned by the interface itself so an
    // inline Thinking expansion can inspect and redraw the current edit buffer.
    updatePrompt();
    rl.prompt();
    drawBelow();
    if (options.onSessionReady) {
      sessionReady = true;
      try {
        options.onSessionReady(promptSession);
      } catch (error) {
        finish(
          undefined,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  });
}

function invisiblePasteNonce(): string {
  // Supplementary variation selectors have zero terminal width but remain in
  // readline's edit buffer. They bind expansion to the marker we inserted, so
  // identical visible text typed by the user is never mistaken for paste data.
  let nonce = "";
  for (const byte of randomBytes(8)) {
    nonce += String.fromCodePoint(0xE0100 + (byte >> 4));
    nonce += String.fromCodePoint(0xE0100 + (byte & 0x0f));
  }
  return nonce;
}

function stripInternalPasteNonce(value: string): string {
  return value.replace(/[\u{E0100}-\u{E010F}]/gu, "");
}
