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
  /**
   * Temporarily release the underlying TTY while preserving the edit buffer.
   * Modal selectors use this lease instead of attaching a second stdin
   * consumer beside readline.
   */
  suspendInput(options?: { readonly preserveDisplay?: boolean }): boolean;
  /**
   * Feed raw terminal bytes into the preserved readline editor while another
   * UI owns physical stdin. Input is accepted only for an active, suspended
   * session and still passes through the normal paste/image/marker pipeline.
   */
  feedInput(chunk: Buffer | string): boolean;
  /**
   * Ignore the short arrow/Enter auto-repeat burst that can follow a modal
   * selector before accepting the next printable edit.
   */
  discardLeadingModalControls(): void;
  /** Restore a session previously suspended with suspendInput(). */
  resumeInput(options?: {
    readonly discardLeadingModalControls?: boolean;
    /**
     * The temporary owner restored/disabled terminal modes before returning
     * the lease, so readline must explicitly reacquire Raw Mode and bracketed
     * paste even when it enabled them before suspension.
     */
    readonly reacquireTerminalModes?: boolean;
    /**
     * Reuse the prompt already present in the primary terminal buffer instead
     * of painting it again. Callers may request this only when neither the
     * draft nor the surrounding live UI changed during the suspension.
     */
    readonly preserveDisplay?: boolean;
  }): void;
  /**
   * Wait until every line already accepted by this editor has reached its
   * serialized onSubmit callback. Pending clipboard capture that was followed
   * by Enter is included in the barrier.
   */
  flushSubmissions(): Promise<void>;
}

export interface PromptDraft {
  readonly text: string;
  readonly cursor: number;
  readonly images: readonly Readonly<ImageAttachment>[];
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
  /** Treat paste hotkeys as text-only and report the real clipboard failure. */
  readonly textOnlyPaste?: boolean;
  readonly onShowThinking?: (
    id: number | "last",
  ) => void | Promise<void>;
  /** Toggle one live Thinking panel from the private VS Code mouse protocol. */
  readonly onToggleThinking?: (
    id: number,
  ) => void | Promise<void>;
  /** Toggle one live queued-adjustment disclosure from the VS Code protocol. */
  readonly onToggleAdjustment?: (
    id: number,
  ) => void | Promise<void>;
  readonly onSessionReady?: (
    session: PromptInputSession | undefined,
  ) => void;
  /**
   * Offer the editor to `onSessionReady` before readline connects physical
   * stdin, changes terminal modes, or paints prompt pixels. A full-screen
   * owner claims the offered lease by synchronously calling `suspendInput()`;
   * if it does not, the editor automatically continues with the legacy
   * inline startup path.
   */
  readonly startSuspended?: boolean;
  /** Keep the editor alive after Enter and deliver each non-empty submission. */
  readonly keepOpen?: boolean;
  readonly onSubmit?: (
    submission: Readonly<PromptSubmission>,
  ) => void | Promise<void>;
  /** Observe the logical draft after readline and atomic paste updates. */
  readonly onDraftChange?: (draft: Readonly<PromptDraft>) => void;
  /** Busy composers route Ctrl+C to the active Runtime instead of closing. */
  readonly onInterrupt?: () => void;
  /** Dispose images whose markers were removed or whose editor was cancelled. */
  readonly onDiscardImages?: (
    images: readonly Readonly<ImageAttachment>[],
  ) => void | Promise<void>;
  /** Render live rows below the readline buffer; terminal controls are filtered. */
  readonly renderBelow?: () => string;
  /** Erase the readline chrome after submission so callers can commit a plain transcript row. */
  readonly clearOnSubmit?: boolean;
  /** Recover if a terminal starts but never closes a bracketed paste packet. */
  readonly bracketedPasteIdleTimeoutMs?: number;
  /** Bound each clipboard image/text read so stdin can never remain queued forever. */
  readonly clipboardCaptureTimeoutMs?: number;
}

const ESCAPE = 0x1b;
const CTRL_C = 0x03;
const CTRL_T = 0x14;
const CTRL_V = 0x16;
const OSC_BEL = 0x07;
const MAX_PRIVATE_OSC_BYTES = 160;
const MAX_CLIPBOARD_TEXT_CHARS = 256 * 1024;
const MAX_BRACKETED_PASTE_BYTES = (MAX_CLIPBOARD_TEXT_CHARS * 4) + 64;
const DEFAULT_BRACKETED_PASTE_IDLE_TIMEOUT_MS = 1_500;
const DEFAULT_CLIPBOARD_CAPTURE_TIMEOUT_MS = 8_000;
const MODAL_CONTROL_BURST_MS = 120;
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
export const VSCODE_TOGGLE_ADJUSTMENT_SEQUENCE_PREFIX =
  "\u001B]6973;easy-code;toggle-adjustment;";

export function vscodeToggleThinkingSequence(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Thinking block ID must be a positive safe integer");
  }
  return `${VSCODE_TOGGLE_THINKING_SEQUENCE_PREFIX}${id}\u0007`;
}

export function vscodeToggleAdjustmentSequence(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Adjustment ID must be a positive safe integer");
  }
  return `${VSCODE_TOGGLE_ADJUSTMENT_SEQUENCE_PREFIX}${id}\u0007`;
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
        | { readonly type: "toggle-adjustment"; readonly id: number }
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
  const adjustment = /^toggle-adjustment;([1-9][0-9]{0,15})$/u.exec(payload);
  if (adjustment) {
    const id = Number(adjustment[1]);
    if (Number.isSafeInteger(id)) {
      return {
        status: "complete",
        length,
        action: { type: "toggle-adjustment", id },
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
    private readonly onToggleAdjustment?: (id: number) => void,
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

  /** Drop incomplete input from a previous owner before a modal borrows us. */
  resetPendingInput(): void {
    this.clearEscapeTimer();
    this.pendingSequence = Buffer.alloc(0);
    this.pendingPrivateOsc = false;
    while (this.read() !== null) {
      // Ordinary bytes typed before the ownership boundary are stale too.
    }
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
          } else if (privateOsc.action.type === "toggle-adjustment") {
            this.onToggleAdjustment?.(privateOsc.action.id);
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
 * input. Clipboard reads run behind an in-buffer pending marker so a slow
 * helper never blocks later paste packets or ordinary typing. Submission is
 * held until every pending marker has settled.
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
  private bracketedPasteTimer?: ReturnType<typeof setTimeout>;
  private pastedTextSequence = 0;
  private pendingPasteSequence = 0;
  private pendingCaptureCount = 0;
  private submitRequested = false;
  private captureQueue: Promise<void> = Promise.resolve();
  private processTail: Promise<void> = Promise.resolve();
  private successfulImageCount = 0;
  private discardModalControlsUntil = 0;
  private terminalStateForwarding = true;
  private readonly pastedTextBlocks = new Map<string, string>();
  private readonly imageMarkers = new Map<string, string>();
  private readonly pendingMarkers = new Set<string>();

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
    private readonly textOnlyPaste = false,
    private readonly onShowThinking?: (
      id: number | "last",
    ) => void | Promise<void>,
    private readonly onToggleThinking?: (
      id: number,
    ) => void | Promise<void>,
    private readonly onToggleAdjustment?: (
      id: number,
    ) => void | Promise<void>,
    private readonly onAtomicBackspace?: () => boolean,
    private readonly onReplaceMarker?: (
      marker: string,
      replacement: string,
    ) => boolean,
    private readonly swallowInterrupt = false,
    private readonly signal?: AbortSignal,
    private readonly bracketedPasteIdleTimeoutMs =
      DEFAULT_BRACKETED_PASTE_IDLE_TIMEOUT_MS,
    private readonly clipboardCaptureTimeoutMs =
      DEFAULT_CLIPBOARD_CAPTURE_TIMEOUT_MS,
  ) {
    super();
  }

  get isRaw(): boolean {
    return Boolean(this.source.isRaw);
  }

  setRawMode(mode: boolean): this {
    if (this.terminalStateForwarding) {
      this.source.setRawMode?.(mode);
    }
    return this;
  }

  /**
   * readline normally owns raw-mode transitions while this proxy is its TTY.
   * A suspended prompt has handed the physical terminal to another renderer,
   * so readline must not restore that renderer's raw state when it closes.
   */
  setTerminalStateForwarding(enabled: boolean): void {
    this.terminalStateForwarding = enabled;
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    let releaseProcess!: () => void;
    const activeProcess = new Promise<void>((resolve) => {
      releaseProcess = resolve;
    });
    this.processTail = this.processTail.catch(() => undefined).then(() => activeProcess);
    void this.process(data).then(
      (output) => callback(undefined, output.length ? output : undefined),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    ).finally(releaseProcess);
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
    this.resetBracketedPaste();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.clearEscapeTimer();
    this.resetBracketedPaste();
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

  referencedImages(value: string): ImageAttachment[] {
    return this.images.filter((image) => {
      const marker = this.imageMarkers.get(image.id);
      return marker !== undefined && value.includes(marker);
    });
  }

  /**
   * Build one logical submission and reset all per-draft marker state while
   * preserving monotonic image numbering for the next busy-editor message.
   */
  consumeSubmission(value: string): {
    readonly submission: PromptSubmission;
    readonly discardedImages: readonly ImageAttachment[];
  } {
    const images = this.referencedImages(value);
    const referencedIds = new Set(images.map((image) => image.id));
    const discardedImages = this.images.filter((image) => !referencedIds.has(image.id));
    const submission = {
      text: this.expandPastedText(value),
      images,
      pasteErrors: [...this.pasteErrors],
    } satisfies PromptSubmission;

    this.images.length = 0;
    this.pasteErrors.length = 0;
    this.pastedTextBlocks.clear();
    this.imageMarkers.clear();
    this.pendingMarkers.clear();
    this.pendingCaptureCount = 0;
    this.submitRequested = false;
    return { submission, discardedImages };
  }

  /** Images still owned by a cancelled editor were never submitted. */
  consumeUnsubmittedImages(): readonly ImageAttachment[] {
    const images = [...this.images];
    this.images.length = 0;
    this.pastedTextBlocks.clear();
    this.imageMarkers.clear();
    this.pendingMarkers.clear();
    return images;
  }

  /**
   * A modal may release on an Enter/arrow key-repeat burst. Suppress only that
   * leading control burst; the first printable edit immediately reopens the
   * normal input path.
   */
  discardLeadingModalControls(): void {
    this.discardModalControlsUntil = Date.now() + MODAL_CONTROL_BURST_MS;
  }

  /** Drain transform and clipboard work that was admitted before input froze. */
  async flushPendingInput(): Promise<void> {
    while (true) {
      const processTail = this.processTail;
      const captureTail = this.captureQueue;
      await processTail.catch(() => undefined);
      await captureTail.catch(() => undefined);
      // Capture completion can inject the delayed Enter that readline turns
      // into a line event. Give that event and its onSubmit queue one turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (
        processTail === this.processTail &&
        captureTail === this.captureQueue &&
        this.pendingCaptureCount === 0
      ) {
        return;
      }
    }
  }

  collapseMarkerBefore(
    value: string,
    cursor: number,
  ): { line: string; cursor: number } | undefined {
    if (!Number.isInteger(cursor) || cursor <= 0 || cursor > value.length) {
      return undefined;
    }
    const markers = [
      ...this.pastedTextBlocks.keys(),
      ...this.imageMarkers.values(),
      ...this.pendingMarkers,
    ];
    const prefix = value.slice(0, cursor);
    let matched = "";
    for (const marker of markers) {
      if (marker.length > matched.length && prefix.endsWith(marker)) {
        matched = marker;
      }
    }
    if (!matched) return undefined;

    const start = cursor - matched.length;
    return {
      line: `${value.slice(0, start)}${value.slice(cursor)}`,
      cursor: start,
    };
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
      if (this.discardModalControlsUntil > 0) {
        if (Date.now() > this.discardModalControlsUntil) {
          this.discardModalControlsUntil = 0;
        } else {
          const discarded = leadingModalControlLength(input, offset);
          if (discarded > 0) {
            offset += discarded;
            continue;
          }
          // Ctrl+C remains an interrupt even inside the short transition.
          if (input[offset] !== CTRL_C) this.discardModalControlsUntil = 0;
        }
      }
      if (this.submitRequested) {
        // Enter fixes the logical end of this submission. Ignore everything
        // that follows while pending clipboard work settles; Ctrl+C is still
        // observed directly on the source stream by readPrompt.
        break;
      }
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
          this.refreshBracketedPasteTimer();
          break;
        }

        const consumedFromInput = Math.max(
          0,
          terminator + BRACKETED_PASTE_END.length - existingLength,
        );
        offset += consumedFromInput;
        this.clearBracketedPasteTimer();
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
      if (byte === CTRL_C && this.swallowInterrupt) {
        offset += 1;
        continue;
      }
      if ((byte === 0x08 || byte === 0x7f) && this.onAtomicBackspace?.()) {
        offset += 1;
        continue;
      }
      if (byte === CTRL_V) {
        output.push(...Buffer.from(this.beginCaptureMarker(), "utf8"));
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
          this.refreshBracketedPasteTimer();
          offset += BRACKETED_PASTE_START.length;
          continue;
        }
        const privateOsc = parsePrivateOsc(input, offset);
        if (privateOsc.status === "complete") {
          if (privateOsc.action.type === "paste-image") {
            output.push(...Buffer.from(this.beginCaptureMarker(), "utf8"));
          } else if (privateOsc.action.type === "toggle-thinking") {
            await this.onToggleThinking?.(privateOsc.action.id);
          } else if (privateOsc.action.type === "toggle-adjustment") {
            await this.onToggleAdjustment?.(privateOsc.action.id);
          }
          offset += privateOsc.length;
          continue;
        }
        const enhanced = IMAGE_PASTE_SEQUENCES.find((sequence) =>
          input.subarray(offset, offset + sequence.length).equals(sequence),
        );
        if (enhanced) {
          output.push(...Buffer.from(this.beginCaptureMarker(), "utf8"));
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
      if ((byte === 0x0d || byte === 0x0a) && this.pendingCaptureCount > 0) {
        this.submitRequested = true;
        offset += 1;
        continue;
      }
      if (byte !== undefined) output.push(byte);
      offset += 1;
    }
    return Buffer.from(output);
  }

  private beginCaptureMarker(): string {
    this.pendingPasteSequence += 1;
    const marker = ` [Pasting clipboard #${this.pendingPasteSequence}…]${invisiblePasteNonce()} `;
    this.pendingMarkers.add(marker);
    this.pendingCaptureCount += 1;

    // Keep real clipboard reads serialized. Besides avoiding native clipboard
    // contention, this preserves image numbering and the aggregate validation
    // performed by the caller while the Transform itself remains responsive.
    this.captureQueue = this.captureQueue
      .catch(() => undefined)
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(async () => {
        const replacement = await this.captureMarker();
        if (!this.destroyed && !this.signal?.aborted) {
          this.onReplaceMarker?.(marker, replacement);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.pasteErrors.push(message);
        if (!this.destroyed && !this.signal?.aborted) {
          this.onReplaceMarker?.(marker, " [Image paste failed] ");
        }
      })
      .finally(() => {
        this.pendingMarkers.delete(marker);
        this.pendingCaptureCount = Math.max(0, this.pendingCaptureCount - 1);
        if (
          this.pendingCaptureCount === 0 &&
          this.submitRequested &&
          !this.destroyed &&
          !this.signal?.aborted
        ) {
          this.submitRequested = false;
          this.push(Buffer.from("\r"));
        }
      });

    return marker;
  }

  private async captureMarker(): Promise<string> {
    if (this.textOnlyPaste) {
      try {
        if (this.signal?.aborted) throw new Error("Text paste was canceled.");
        if (!this.captureText) {
          throw new Error("Clipboard text capture is unavailable.");
        }
        const text = await this.captureWithTimeout(
          (signal) => this.captureText?.(signal) ?? Promise.resolve(undefined),
          "Clipboard text capture",
        );
        if (this.signal?.aborted) throw new Error("Text paste was canceled.");
        if (!text) throw new Error("Clipboard does not contain text.");
        return this.pastedTextForPrompt(text);
      } catch (error) {
        this.pasteErrors.push(
          error instanceof Error ? error.message : String(error),
        );
        return " [Text paste failed] ";
      }
    }

    const index = this.initialImageCount + this.successfulImageCount + 1;
    try {
      if (this.signal?.aborted) throw new Error("Image paste was canceled.");
      const attachment = await this.captureWithTimeout(
        (signal) => this.captureImage(index, signal),
        "Clipboard image capture",
      );
      if (this.signal?.aborted) throw new Error("Image paste was canceled.");
      const expectedLabel = `Image #${index}`;
      if (attachment.label !== expectedLabel) {
        throw new Error(`Captured image label must be ${expectedLabel}.`);
      }
      const marker = ` [${expectedLabel}]${invisiblePasteNonce()} `;
      this.images.push(attachment);
      this.successfulImageCount += 1;
      this.imageMarkers.set(attachment.id, marker);
      return marker;
    } catch (error) {
      let pasteError = error;
      if (!this.signal?.aborted && this.captureText) {
        try {
          const text = await this.captureWithTimeout(
            (signal) => this.captureText?.(signal) ?? Promise.resolve(undefined),
            "Clipboard text capture",
          );
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

  private async captureWithTimeout<T>(
    start: (signal: AbortSignal) => Promise<T>,
    label: string,
  ): Promise<T> {
    if (this.signal?.aborted) throw new Error(`${label} was canceled.`);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    this.signal?.addEventListener("abort", onAbort, { once: true });
    const delay = Number.isFinite(this.clipboardCaptureTimeoutMs)
      ? Math.max(1, Math.floor(this.clipboardCaptureTimeoutMs))
      : DEFAULT_CLIPBOARD_CAPTURE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${delay}ms.`));
        controller.abort();
      }, delay);
    });
    try {
      return await Promise.race([start(controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.signal?.removeEventListener("abort", onAbort);
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

  private refreshBracketedPasteTimer(): void {
    this.clearBracketedPasteTimer();
    const delay = Number.isFinite(this.bracketedPasteIdleTimeoutMs)
      ? Math.max(1, Math.floor(this.bracketedPasteIdleTimeoutMs))
      : DEFAULT_BRACKETED_PASTE_IDLE_TIMEOUT_MS;
    this.bracketedPasteTimer = setTimeout(() => {
      if (!this.bracketedPasteActive || this.destroyed) return;
      this.resetBracketedPaste();
      this.pasteErrors.push(
        "Pasted text was incomplete because the terminal did not send its closing marker.",
      );
      // Fail closed for the incomplete payload, but release the Transform so
      // subsequent ordinary keystrokes reach readline instead of being
      // swallowed forever as paste bytes.
      this.push(Buffer.from(" [Text paste failed] ", "utf8"));
    }, delay);
  }

  private clearBracketedPasteTimer(): void {
    if (this.bracketedPasteTimer) clearTimeout(this.bracketedPasteTimer);
    this.bracketedPasteTimer = undefined;
  }

  private resetBracketedPaste(): void {
    this.clearBracketedPasteTimer();
    this.bracketedPasteActive = false;
    this.bracketedPasteRejected = false;
    this.bracketedPasteBuffer = Buffer.alloc(0);
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
  if (options.keepOpen && !options.onSubmit) {
    throw new Error("A persistent prompt requires an onSubmit callback.");
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
  let inputConnected = false;
  let inputSuspended = false;
  let inputSuspendedWithPreservedDisplay = false;
  let startupSuspensionPending = false;
  let startupSuspensionClaimed = false;
  let readlineOutputMuted = false;
  let connectInput = (): void => undefined;
  let disconnectInput = (): void => undefined;
  let renderedPrompt = options.prompt;
  let rl!: readline.Interface;

  // readline remains the canonical editor while a full-screen disclosure UI
  // owns the terminal. Proxying only readline's output lets its state machine
  // continue processing injected bytes without letting its prompt repaint over
  // the alternate-screen renderer. All ordinary output still uses the real
  // stream in `options.output`.
  const writeReadlineOutput = (...args: unknown[]): boolean => {
    if (readlineOutputMuted) {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        queueMicrotask(() => {
          try {
            (callback as () => void)();
          } catch {
            // Writable callbacks are observational; a consumer callback must
            // not break the canonical editor while its output is muted.
          }
        });
      }
      return true;
    }
    return (options.output.write as unknown as (
      ...values: unknown[]
    ) => boolean).apply(options.output, args);
  };
  const readlineOutput = new Proxy(options.output, {
    get(target, property): unknown {
      if (property === "write") return writeReadlineOutput;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PromptOutput;

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
  let proxy!: ImagePasteInputProxy;
  let submissionQueue: Promise<void> = Promise.resolve();
  let notifyDraft = (): void => undefined;
  const promptSession: PromptInputSession = {
    writeAbove(text: string): void {
      if (!text || !suspendPrompt()) return;
      try {
        const safe = sanitizeTerminalText(text, { allowSgr: true });
        const atLineStart = stripTerminalControls(safe).endsWith("\n");
        options.output.write(atLineStart ? safe : `${safe}\n`);
      } finally {
        resumePrompt();
      }
    },
    refreshBelow,
    suspendInput(suspendOptions): boolean {
      if (!promptActive) return false;
      if (inputSuspended) {
        if (startupSuspensionPending) startupSuspensionClaimed = true;
        return true;
      }
      if (suspendOptions?.preserveDisplay && promptSuspensionDepth === 0) {
        // Alternate-screen UIs can leave the primary buffer byte-for-byte
        // untouched. Retain its prompt and decorations so switching back does
        // not emit a redraw that makes terminal emulators follow the cursor to
        // the bottom of scrollback.
        promptSuspensionDepth = 1;
        suspendedLine = rl.line;
        suspendedCursor = rl.cursor;
        inputSuspendedWithPreservedDisplay = true;
      } else if (!suspendPrompt()) {
        // The legacy OSC path reaches this method from a prompt callback that
        // has already suspended and erased the editor. Nest that suspension
        // instead of rejecting the disclosure open; resumeInput() and the
        // callback's finally block will unwind the two levels in order.
        return false;
      }
      // Mute readline before releasing stdin so feedInput() can edit the same
      // buffer without drawing over the alternate-screen owner. The ordinary
      // path erased the prompt; preserveDisplay leaves it hidden in primary.
      readlineOutputMuted = true;
      proxy.setTerminalStateForwarding(false);
      latestPromptEndPosition = undefined;
      disconnectInput();
      input.pause();
      inputSuspended = true;
      return true;
    },
    feedInput(chunk: Buffer | string): boolean {
      if (
        !promptActive ||
        !inputSuspended ||
        proxy.destroyed ||
        proxy.writableEnded
      ) {
        return false;
      }
      try {
        // Writing to the existing proxy preserves bracketed-paste expansion,
        // image capture, atomic marker deletion, readline cursor movement, and
        // serialized line submission exactly as physical stdin does.
        proxy.write(chunk);
        return true;
      } catch {
        return false;
      }
    },
    discardLeadingModalControls(): void {
      if (!promptActive) return;
      proxy.discardLeadingModalControls();
    },
    resumeInput(resumeOptions): void {
      if (!promptActive || !inputSuspended) return;
      if (resumeOptions?.discardLeadingModalControls) {
        proxy.discardLeadingModalControls();
      }
      inputSuspended = false;
      readlineOutputMuted = false;
      proxy.setTerminalStateForwarding(true);
      if (resumeOptions?.reacquireTerminalModes) {
        bracketedPasteEnabled = false;
      }
      // readline requested Raw Mode when its interface was created. A
      // start-suspended editor deliberately suppressed that request, and a
      // full-screen owner restores its own prior mode before handing control
      // back, so reassert the editor's terminal modes before reconnecting.
      try {
        if (!input.isRaw) input.setRawMode?.(true);
      } catch {
        // A disappearing TTY is handled by the normal stream/error lifecycle.
      }
      if (!bracketedPasteEnabled) {
        bracketedPasteEnabled = true;
        try {
          options.output.write(ENABLE_BRACKETED_PASTE);
        } catch {
          // Keep the logical editor recoverable even if the terminal vanished.
        }
      }
      const canReusePreservedDisplay = Boolean(
        resumeOptions?.preserveDisplay &&
          inputSuspendedWithPreservedDisplay &&
          rl.line === suspendedLine &&
          rl.cursor === suspendedCursor,
      );
      if (canReusePreservedDisplay) {
        // Nothing was erased and nothing changed. Dropping the logical
        // suspension is sufficient; any output here would force VS Code's
        // terminal viewport to jump to the active cursor at the bottom.
        promptSuspensionDepth = Math.max(0, promptSuspensionDepth - 1);
      } else {
        if (inputSuspendedWithPreservedDisplay) {
          // The primary prompt was deliberately retained, but its state is now
          // stale. Erase that old copy before using the ordinary state-derived
          // resume path so drafts never appear twice.
          eraseBelow();
          const savedPosition = rl.getCursorPos();
          if (savedPosition.rows > 0) {
            readline.moveCursor(options.output, 0, -savedPosition.rows);
          }
          readline.cursorTo(options.output, 0);
          readline.clearScreenDown(options.output);
          (rl as unknown as { prevRows?: number }).prevRows = 0;
          suspendedPromptVisibleAfterResize = false;
        }
        resumePrompt();
      }
      inputSuspendedWithPreservedDisplay = false;
      // Reconnect only after the preserved prompt is visible. pipe() can make
      // an already-buffered TTY flow synchronously, so connecting first could
      // echo keys into a prompt that is still suspended.
      connectInput();
    },
    async flushSubmissions(): Promise<void> {
      await proxy.flushPendingInput();
      // onLine serializes callbacks so multiline/image submissions cannot
      // overtake one another. Loop because a delayed image Enter may append a
      // callback while the previous queue is settling.
      while (true) {
        const pending = submissionQueue;
        await pending.catch(() => undefined);
        await Promise.resolve();
        if (pending === submissionQueue) return;
      }
    },
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
  const toggleAdjustment = options.onToggleAdjustment
    ? async (id: number): Promise<void> => {
        if (!suspendPrompt()) return;
        try {
          await options.onToggleAdjustment?.(id);
        } finally {
          resumePrompt();
        }
      }
    : undefined;
  const deleteAtomicMarker = (): boolean => {
    const collapsed = proxy.collapseMarkerBefore(rl.line, rl.cursor);
    if (!collapsed || !suspendPrompt()) return false;
    const mutableReadline = rl as unknown as {
      line: string;
      cursor: number;
    };
    mutableReadline.line = collapsed.line;
    mutableReadline.cursor = collapsed.cursor;
    suspendedLine = collapsed.line;
    suspendedCursor = collapsed.cursor;
    resumePrompt();
    notifyDraft();
    return true;
  };
  const replaceAtomicMarker = (
    marker: string,
    replacement: string,
  ): boolean => {
    const markerStart = rl.line.indexOf(marker);
    if (markerStart < 0 || !suspendPrompt()) return false;
    try {
      const markerEnd = markerStart + marker.length;
      const previousLine = suspendedLine;
      const previousCursor = suspendedCursor;
      const nextLine = `${previousLine.slice(0, markerStart)}${replacement}${previousLine.slice(markerEnd)}`;
      let nextCursor = previousCursor;
      if (previousCursor > markerStart) {
        nextCursor = previousCursor < markerEnd
          ? markerStart + replacement.length
          : previousCursor + replacement.length - marker.length;
      }
      const mutableReadline = rl as unknown as {
        line: string;
        cursor: number;
      };
      mutableReadline.line = nextLine;
      mutableReadline.cursor = nextCursor;
      suspendedLine = nextLine;
      suspendedCursor = nextCursor;
      return true;
    } finally {
      resumePrompt();
      notifyDraft();
    }
  };
  proxy = new ImagePasteInputProxy(
    input,
    initialImageCount,
    options.captureImage,
    options.captureText,
    options.textOnlyPaste ?? false,
    showThinking,
    toggleThinking,
    toggleAdjustment,
    deleteAtomicMarker,
    replaceAtomicMarker,
    Boolean(options.keepOpen && options.onInterrupt),
    captureController.signal,
    options.bracketedPasteIdleTimeoutMs,
    options.clipboardCaptureTimeoutMs,
  );
  const startSuspended = Boolean(
    options.startSuspended && options.onSessionReady,
  );
  if (startSuspended) {
    // readline configures Raw Mode during createInterface(). Suppress that
    // physical transition until the lifecycle hook has either transferred
    // ownership to a full-screen renderer or declined the lease.
    proxy.setTerminalStateForwarding(false);
    inputSuspended = true;
    readlineOutputMuted = true;
    promptSuspensionDepth = 1;
  }
  rl = readline.createInterface({
    input: proxy,
    output: readlineOutput,
    terminal: true,
  });
  notifyDraft = (): void => {
    try {
      const visibleText = stripInternalPasteNonce(rl.line);
      const visibleCursor = stripInternalPasteNonce(rl.line.slice(0, rl.cursor)).length;
      options.onDraftChange?.({
        text: visibleText,
        cursor: visibleCursor,
        images: proxy.referencedImages(rl.line),
      });
    } catch {
      // A presentation callback cannot own the editor lifecycle.
    }
  };

  return new Promise((resolve, reject) => {
    let settled = false;

    const discardImages = (
      images: readonly Readonly<ImageAttachment>[],
    ): void => {
      if (images.length === 0 || !options.onDiscardImages) return;
      void Promise.resolve(options.onDiscardImages(images)).catch(() => undefined);
    };

    const cleanup = (): void => {
      // While suspended, the prompt has handed both pixels and terminal modes
      // to the persistent full-screen renderer. Cleanup must only detach its
      // logical editor state; writing control sequences or restoring the
      // pre-prompt raw/flow state would corrupt the renderer behind it.
      const suspendedAtCleanup = inputSuspended;
      if (scheduledBelowDraw) clearImmediate(scheduledBelowDraw);
      scheduledBelowDraw = undefined;
      if (!suspendedAtCleanup) {
        try {
          eraseBelow();
          eraseSuspendedResizePrompt();
        } catch {
          // Raw-mode and stream cleanup still matter if the TTY disappeared.
        }
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
        if (!suspendedAtCleanup) {
          try {
            options.output.write(DISABLE_BRACKETED_PASTE);
          } catch {
            // The terminal may have disappeared while the prompt was active.
          }
        }
      }
      rl.removeListener("close", onClose);
      rl.removeListener("line", onLine);
      proxy.removeListener("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
      proxy.removeListener("keypress", onBeforeKeypress);
      proxy.removeListener("keypress", onAfterKeypress);
      options.output.removeListener("resize", onBeforeResize);
      options.output.removeListener("resize", onAfterResize);
      disconnectInput();
      discardImages(proxy.consumeUnsubmittedImages());
      if (!proxy.destroyed) proxy.destroy();
      if (!suspendedAtCleanup) {
        try {
          input.setRawMode?.(wasRaw);
        } catch {
          // The TTY may have disappeared while the prompt was active.
        }
        if (wasFlowing) input.resume();
        else input.pause();
      }
      inputSuspended = false;
      readlineOutputMuted = false;
      try {
        options.onDraftChange?.({ text: "", cursor: 0, images: [] });
      } catch {
        // Cleanup must not depend on a presentation callback.
      }
    };
    const finish = (
      answer?: string,
      error?: Error,
      closeInterface = true,
    ): void => {
      if (settled) return;
      settled = true;
      const consumed = answer === undefined
        ? undefined
        : proxy.consumeSubmission(answer);
      if (consumed) discardImages(consumed.discardedImages);
      rl.removeListener("close", onClose);
      if (closeInterface) {
        if (!inputSuspended) {
          try {
            eraseBelow();
          } catch {
            // Closing the interface must not depend on decorative output.
          }
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
      resolve(consumed?.submission ?? { text: answer, images: [], pasteErrors: [] });
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
      // During alternate-screen editing there is no physical readline prompt
      // to erase. Its last pre-suspension geometry is intentionally discarded
      // by suspendInput().
      if (!inputSuspended) eraseSubmittedPrompt();
      if (!options.keepOpen || !options.onSubmit) {
        finish(answer);
        return;
      }

      const consumed = proxy.consumeSubmission(answer);
      discardImages(consumed.discardedImages);
      const submission = consumed.submission;
      const hasContent = submission.text.trim().length > 0 ||
        submission.images.length > 0 || submission.pasteErrors.length > 0;
      if (hasContent) {
        submissionQueue = submissionQueue
          .then(() => options.onSubmit?.(submission))
          .then(() => undefined)
          .catch(() => undefined);
      }
      if (inputSuspended) {
        suspendedLine = rl.line;
        suspendedCursor = rl.cursor;
      }
      notifyDraft();
      if (!promptActive || inputSuspended) return;
      updatePrompt();
      rl.prompt();
      drawBelow();
    };
    const onError = (): void => finish(undefined, new Error("Unable to read terminal input."));
    const onAbort = (): void => finish();
    const onRawInput = (chunk: Buffer | string): void => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!data.includes(CTRL_C)) return;
      if (options.keepOpen && options.onInterrupt) {
        try {
          options.onInterrupt();
        } catch {
          // Runtime cancellation remains best effort at the presentation edge.
        }
        return;
      }
      finish();
    };
    const onBeforeKeypress = (): void => {
      if (inputSuspended) return;
      eraseBelow();
      if (options.clearOnSubmit) {
        latestPromptEndPosition = promptGeometry().endPosition;
      }
    };
    const onAfterKeypress = (): void => {
      // One input chunk can contain a large paste. Redraw once after readline
      // consumes the burst instead of once for every decoded character.
      if (inputSuspended) {
        suspendedLine = rl.line;
        suspendedCursor = rl.cursor;
      }
      notifyDraft();
      if (!inputSuspended) scheduleBelowDraw();
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
        // readline receives the resize event through its proxied output, but
        // cannot have repainted while the alternate-screen owner muted it.
        suspendedPromptVisibleAfterResize = !readlineOutputMuted;
        return;
      }
      drawBelow();
    };

    rl.once("close", onClose);
    if (options.keepOpen) rl.on("line", onLine);
    else rl.once("line", onLine);
    proxy.once("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      finish();
      return;
    }
    if (
      options.renderBelow ||
      options.renderPrompt ||
      options.clearOnSubmit ||
      options.onDraftChange
    ) {
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
    connectInput = (): void => {
      if (inputConnected || settled) return;
      input.pipe(proxy);
      input.on("data", onRawInput);
      inputConnected = true;
      input.resume();
    };
    disconnectInput = (): void => {
      if (!inputConnected) return;
      input.removeListener("data", onRawInput);
      input.unpipe(proxy);
      inputConnected = false;
    };
    if (startSuspended) {
      suspendedLine = rl.line;
      suspendedCursor = rl.cursor;
      startupSuspensionPending = true;
      sessionReady = true;
      try {
        options.onSessionReady?.(promptSession);
      } catch (error) {
        startupSuspensionPending = false;
        finish(
          undefined,
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
      startupSuspensionPending = false;
      if (settled) return;
      if (!startupSuspensionClaimed && inputSuspended) {
        // Backwards-compatible fallback: merely observing the early session
        // does not require a caller to implement terminal ownership.
        promptSession.resumeInput();
      }
      notifyDraft();
      return;
    }
    connectInput();
    // Observe the source as well as the serialized Transform. A clipboard read
    // deliberately holds the Transform callback so Enter stays ordered behind
    // it, but Ctrl+C must still be able to abort that read immediately.
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
    notifyDraft();
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
  // readline's edit buffer. They bind payloads and attachments to the exact
  // marker we inserted, so identical visible text typed by the user is inert.
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

function leadingModalControlLength(input: Buffer, offset: number): number {
  const byte = input[offset];
  if (byte === 0x0d || byte === 0x0a) return 1;
  if (byte !== ESCAPE) return 0;
  const text = input.subarray(offset, Math.min(input.length, offset + 80)).toString("utf8");
  const match = /^\u001B(?:\[[0-9:;]*[ABu~]|O[ABM])/u.exec(text);
  if (!match) return 0;
  const sequence = match[0];
  if (sequence.endsWith("A") || sequence.endsWith("B") || sequence.endsWith("M")) {
    return Buffer.byteLength(sequence);
  }
  if (sequence.endsWith("~")) {
    return /^\u001B\[27;[1-9][0-9]*;13~$/u.test(sequence)
      ? Buffer.byteLength(sequence)
      : 0;
  }
  const csiU = /^\u001B\[([0-9]+)(?::[0-9]+)?(?:;[^u]*)?u$/u.exec(sequence);
  if (!csiU) return 0;
  const keyCode = Number(csiU[1]);
  return [13, 57352, 57353, 57414, 57419, 57420].includes(keyCode)
    ? Buffer.byteLength(sequence)
    : 0;
}
