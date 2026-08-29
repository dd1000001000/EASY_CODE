import readline from "node:readline";
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
  readonly onSessionReady?: (
    session: PromptInputSession | undefined,
  ) => void;
  /** Render live rows below the readline buffer; terminal controls are filtered. */
  readonly renderBelow?: () => string;
}

const ESCAPE = 0x1b;
const CTRL_C = 0x03;
const CTRL_T = 0x14;
const CTRL_V = 0x16;
const OSC_BEL = 0x07;
const MAX_PRIVATE_OSC_BYTES = 160;
const MAX_CLIPBOARD_TEXT_CHARS = 256 * 1024;
/**
 * Private input sequence sent by the bundled VS Code extension. It is framed
 * like an OSC message so it cannot be confused with text or a real key emitted
 * by a legacy terminal. The extension only sends it while an EASY CODE process
 * owns the active integrated terminal.
 */
export const VSCODE_IMAGE_PASTE_SEQUENCE = "\u001B]6973;easy-code;paste-image\u0007";
export const VSCODE_SHOW_THINKING_SEQUENCE_PREFIX =
  "\u001B]6973;easy-code;show-thinking;";

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
        | { readonly type: "show-thinking"; readonly id: number }
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
  const thinking = /^show-thinking;([1-9][0-9]{0,15})$/u.exec(payload);
  if (thinking) {
    const id = Number(thinking[1]);
    if (Number.isSafeInteger(id)) {
      return {
        status: "complete",
        length,
        action: { type: "show-thinking", id },
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

  constructor(private readonly source: PromptInput) {
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
          // A private message is meaningful only to the main EASY CODE prompt.
          // This filter is used by every other input UI, so always consume it.
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
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.clearEscapeTimer();
    callback(error);
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
        const privateOsc = parsePrivateOsc(input, offset);
        if (privateOsc.status === "complete") {
          if (privateOsc.action.type === "paste-image") {
            output.push(...Buffer.from(await this.captureMarker(), "utf8"));
          } else if (privateOsc.action.type === "show-thinking") {
            await this.onShowThinking?.(privateOsc.action.id);
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
        const tail = input.subarray(offset);
        const mayBePasteSequence =
          privateOsc.status === "partial" ||
          tail.length === 1 ||
          IMAGE_PASTE_SEQUENCES.some(
            (sequence) => tail.length < sequence.length && sequence.subarray(0, tail.length).equals(tail),
          );
        if (mayBePasteSequence) {
          this.pendingSequence = Buffer.from(tail);
          this.pendingPrivateOsc =
            tail.length >= 2 && tail[0] === ESCAPE && tail[1] === 0x5d;
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
              return clipboardTextForPrompt(text);
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
  let scheduledBelowDraw: ReturnType<typeof setImmediate> | undefined;
  let renderedCursorPosition: { rows: number; cols: number } | undefined;
  let renderedEndPosition: { rows: number; cols: number } | undefined;
  let rl!: readline.Interface;

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
    if (promptSuspensionDepth > 1) return true;

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
    return true;
  };
  const resumePrompt = (): void => {
    if (promptSuspensionDepth === 0) return;
    promptSuspensionDepth -= 1;
    if (promptSuspensionDepth > 0) return;
    if (!promptActive) return;

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
    options.output.write(`${options.prompt}${suspendedLine}`);
    const rowsUp = Math.max(0, endPosition.rows - savedPosition.rows);
    if (rowsUp > 0) {
      readline.moveCursor(options.output, 0, -rowsUp);
    }
    readline.cursorTo(options.output, savedPosition.cols);
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
  const proxy = new ImagePasteInputProxy(
    input,
    initialImageCount,
    options.captureImage,
    options.captureText,
    showThinking,
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
        text: answer,
        images: [...proxy.images],
        pasteErrors: [...proxy.pasteErrors],
      });
    };
    const onClose = (): void => finish(undefined, undefined, false);
    const onLine = (answer: string): void => finish(answer);
    const onError = (): void => finish(undefined, new Error("Unable to read terminal input."));
    const onAbort = (): void => finish();
    const onRawInput = (chunk: Buffer | string): void => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (data.includes(CTRL_C)) finish();
    };
    const onBeforeKeypress = (): void => {
      eraseBelow();
    };
    const onAfterKeypress = (): void => {
      // One input chunk can contain a large paste. Redraw once after readline
      // consumes the burst instead of once for every decoded character.
      scheduleBelowDraw();
    };
    const onBeforeResize = (): void => {
      resizeInProgress = true;
      eraseBelow();
    };
    const onAfterResize = (): void => {
      resizeInProgress = false;
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
    if (options.renderBelow) {
      // readline's own keypress/resize listeners remain the sole owners of the
      // edit buffer. We only clear decoration immediately before their redraw
      // and restore it immediately afterward.
      proxy.prependListener("keypress", onBeforeKeypress);
      proxy.on("keypress", onAfterKeypress);
      options.output.prependListener("resize", onBeforeResize);
      options.output.on("resize", onAfterResize);
    }
    input.pipe(proxy);
    // Observe the source as well as the serialized Transform. A clipboard read
    // deliberately holds the Transform callback so Enter stays ordered behind
    // it, but Ctrl+C must still be able to abort that read immediately.
    input.on("data", onRawInput);
    // Keep the prompt and submitted line owned by the interface itself so an
    // inline Thinking expansion can inspect and redraw the current edit buffer.
    rl.setPrompt(options.prompt);
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

function clipboardTextForPrompt(value: string): string {
  const sanitized = stripTerminalControls(value)
    // readline treats these bytes as editing or submission commands when they
    // arrive from our Transform, so keep pasted text literal and single-line.
    .replace(/[\t\r\n]+/gu, " ");
  if (sanitized.length > MAX_CLIPBOARD_TEXT_CHARS) {
    throw new Error("Clipboard text exceeds the 256 KiB input limit.");
  }
  return sanitized;
}
