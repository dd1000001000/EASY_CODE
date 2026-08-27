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
}

const ESCAPE = 0x1b;
const CTRL_C = 0x03;
const CTRL_V = 0x16;
/**
 * Private input sequence sent by the bundled VS Code extension. It is framed
 * like an OSC message so it cannot be confused with text or a real key emitted
 * by a legacy terminal. The extension only sends it while an EASY CODE process
 * owns the active integrated terminal.
 */
export const VSCODE_IMAGE_PASTE_SEQUENCE = "\u001B]6973;easy-code;paste-image\u0007";

const IMAGE_PASTE_SEQUENCES = [
  Buffer.from(VSCODE_IMAGE_PASTE_SEQUENCE),
  Buffer.from("\u001B[118;5u"), // Ctrl+V
  Buffer.from("\u001B[118;6u"), // Ctrl+Shift+V
  Buffer.from("\u001B[118;9u"), // Super/Command+V
] as const;

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
  private escapeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly source: PromptInput,
    private readonly initialImageCount: number,
    private readonly captureImage: (
      index: number,
      signal?: AbortSignal,
    ) => Promise<ImageAttachment>,
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
      callback(undefined, pending);
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
      if (byte === ESCAPE) {
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
          tail.length === 1 ||
          IMAGE_PASTE_SEQUENCES.some(
            (sequence) => tail.length < sequence.length && sequence.subarray(0, tail.length).equals(tail),
          );
        if (mayBePasteSequence) {
          this.pendingSequence = Buffer.from(tail);
          this.startEscapeTimer();
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

  private startEscapeTimer(): void {
    this.clearEscapeTimer();
    this.escapeTimer = setTimeout(() => {
      if (!this.pendingSequence.length || this.destroyed) return;
      const pending = this.pendingSequence;
      this.pendingSequence = Buffer.alloc(0);
      this.push(pending);
    }, 60);
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
  const proxy = new ImagePasteInputProxy(
    input,
    initialImageCount,
    options.captureImage,
    captureController.signal,
  );
  const rl = readline.createInterface({
    input: proxy,
    output: options.output,
    terminal: true,
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      captureController.abort();
      rl.removeListener("close", onClose);
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
    const onError = (): void => finish(undefined, new Error("Unable to read terminal input."));
    const onAbort = (): void => finish();
    const onRawInput = (chunk: Buffer | string): void => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (data.includes(CTRL_C)) finish();
    };

    rl.once("close", onClose);
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
    rl.question(options.prompt, (answer) => finish(answer));
  });
}
