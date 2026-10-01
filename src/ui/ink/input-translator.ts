import { Transform, type TransformCallback } from "node:stream";

/** Private request sent by the bundled VS Code extension: "paste the clipboard image". */
export const VSCODE_IMAGE_PASTE_SEQUENCE = "\u001B]6973;easy-code;paste-image\u0007";
/** The key a user would press for the same intent; Ink reports it as Ctrl+V. */
const CTRL_V = "\u0016";
const PARTIAL_FLUSH_MS = 60;

/** Longest suffix of `value` that could still become the start of `sequence`. */
function partialSequenceLength(value: string, sequence: string): number {
  for (let length = Math.min(value.length, sequence.length - 1); length > 0; length -= 1) {
    if (sequence.startsWith(value.slice(value.length - length))) return length;
  }
  return 0;
}

/**
 * Sits between the real stdin and Ink. Ink's key parser knows nothing about
 * EASY CODE's private OSC message and would type its payload into the editor,
 * so it is translated into the equivalent Ctrl+V keystroke before Ink sees it.
 * Everything else passes through byte-for-byte, even when split across chunks.
 */
export class InputTranslator extends Transform {
  private pending = "";
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly source: NodeJS.ReadStream) {
    super({ decodeStrings: false, encoding: "utf8" });
    source.setEncoding?.("utf8");
    source.pipe(this);
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

  ref(): this {
    (this.source as { ref?: () => void }).ref?.();
    return this;
  }

  unref(): this {
    (this.source as { unref?: () => void }).unref?.();
    return this;
  }

  /** Detach from the real stdin without ending it, so the terminal remains usable after the UI closes. */
  release(): void {
    this.clearTimer();
    this.source.unpipe(this);
    this.pending = "";
    this.destroy();
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.clearTimer();
    const input = this.pending + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const translated = input.split(VSCODE_IMAGE_PASTE_SEQUENCE).join(CTRL_V);
    const held = partialSequenceLength(translated, VSCODE_IMAGE_PASTE_SEQUENCE);
    this.pending = held > 0 ? translated.slice(translated.length - held) : "";
    if (held > 0) {
      this.timer = setTimeout(() => this.flushPending(), PARTIAL_FLUSH_MS);
      this.timer.unref();
    }
    callback(undefined, held > 0 ? translated.slice(0, translated.length - held) : translated);
  }

  private flushPending(): void {
    this.timer = undefined;
    const rest = this.pending;
    this.pending = "";
    if (rest) this.push(rest);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
