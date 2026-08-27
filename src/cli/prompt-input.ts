import readline from "node:readline";
import { Transform, type TransformCallback } from "node:stream";

import type { ImageAttachment } from "../core/types.js";

export interface PromptInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly readableFlowing?: boolean | null;
  setRawMode?(mode: boolean): this;
}

export interface PromptOutput extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

export interface PromptSubmission {
  readonly text: string;
  readonly images: ImageAttachment[];
  readonly pasteErrors: string[];
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
  readonly onShowThinking?: (
    id: number | "last",
  ) => void | Promise<void>;
}

const ESCAPE = 0x1b;
const CTRL_C = 0x03;
const CTRL_T = 0x14;
const CTRL_V = 0x16;
const OSC_BEL = 0x07;
const MAX_PRIVATE_OSC_BYTES = 160;
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
      this.pasteErrors.push(error instanceof Error ? error.message : String(error));
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
  let rl!: readline.Interface;
  const showThinking = options.onShowThinking
    ? async (id: number | "last"): Promise<void> => {
        const savedLine = rl.line;
        const savedCursor = rl.cursor;
        const savedPosition = rl.getCursorPos();
        const mutableReadline = rl as unknown as { cursor: number };
        mutableReadline.cursor = savedLine.length;
        const endPosition = rl.getCursorPos();
        mutableReadline.cursor = savedCursor;

        // Remove every visual row occupied by a wrapped edit buffer, without
        // changing readline's logical line or cursor.
        if (savedPosition.rows > 0) {
          readline.moveCursor(options.output, 0, -savedPosition.rows);
        }
        readline.cursorTo(options.output, 0);
        readline.clearScreenDown(options.output);
        try {
          await options.onShowThinking?.(id);
        } finally {
          if (promptActive) {
            // readline.prompt() does not reliably repaint its existing edit
            // buffer after out-of-band output, so draw the unchanged buffer
            // explicitly and then restore its visual cursor position.
            options.output.write(`${options.prompt}${savedLine}`);
            const rowsUp = Math.max(0, endPosition.rows - savedPosition.rows);
            if (rowsUp > 0) {
              readline.moveCursor(options.output, 0, -rowsUp);
            }
            readline.cursorTo(options.output, savedPosition.cols);
          }
        }
      }
    : undefined;
  const proxy = new ImagePasteInputProxy(
    input,
    initialImageCount,
    options.captureImage,
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
      promptActive = false;
      captureController.abort();
      rl.removeListener("close", onClose);
      rl.removeListener("line", onLine);
      proxy.removeListener("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
      input.removeListener("data", onRawInput);
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
      if (closeInterface) rl.close();
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

    rl.once("close", onClose);
    rl.once("line", onLine);
    proxy.once("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      finish();
      return;
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
  });
}
