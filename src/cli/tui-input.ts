import { displayWidth, stripAnsi } from "../ui/render/layout.js";

const ESC = 0x1b;
const CTRL_A = 0x01;
const CTRL_C = 0x03;
const CTRL_E = 0x05;
const CTRL_J = 0x0a;
const CTRL_V = 0x16;
const CARRIAGE_RETURN = 0x0d;
const BACKSPACE = 0x08;
const DELETE = 0x7f;
const TAB = 0x09;
const BEL = 0x07;

const BRACKETED_PASTE_START = Buffer.from("\u001B[200~");
const BRACKETED_PASTE_END = Buffer.from("\u001B[201~");
const PRIVATE_OSC_PREFIX = Buffer.from("\u001B]6973;easy-code;");

export type TuiKey =
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "backspace"
  | "delete"
  | "enter"
  | "newline"
  | "interrupt"
  | "page-up"
  | "page-down";

export type TuiMouseButton = "left" | "middle" | "right" | "none";
export type TuiMouseAction =
  | "press"
  | "release"
  | "move"
  | "wheel-up"
  | "wheel-down"
  | "wheel-left"
  | "wheel-right";

export interface TuiMouseEvent {
  readonly type: "mouse";
  /** SGR mouse coordinates are one-based terminal cells. */
  readonly column: number;
  readonly row: number;
  readonly action: TuiMouseAction;
  readonly button: TuiMouseButton;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

export type TuiInputErrorCode =
  | "paste-too-large"
  | "incomplete-paste"
  | "malformed-control";

export type TuiInputEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "key"; readonly key: TuiKey }
  | TuiMouseEvent
  | { readonly type: "paste-image" }
  | { readonly type: "toggle-thinking"; readonly id: number }
  | { readonly type: "toggle-adjustment"; readonly id: number }
  | {
      readonly type: "input-error";
      readonly code: TuiInputErrorCode;
      readonly message: string;
      readonly byteLength?: number;
    };

export interface TuiInputDecoderOptions {
  /**
   * Optional explicit bracketed-paste byte limit. The default is unlimited;
   * callers that impose a safety limit receive an error instead of truncated
   * text. The decoder then consumes through the closing marker and recovers.
   */
  readonly maxPasteBytes?: number;
  /** Bound an unterminated CSI/OSC packet so malformed input cannot stall forever. */
  readonly maxControlBytes?: number;
}

type EscapeParseResult =
  | { readonly status: "partial" }
  | { readonly status: "complete"; readonly length: number; readonly event?: TuiInputEvent };

/**
 * Stateful byte-stream decoder for a raw terminal.
 *
 * It deliberately does not own `process.stdin`, Raw Mode, timers, or drawing.
 * Every `feed` call may contain a fragment, one packet, or many packets. A
 * bracketed paste is emitted once as one event, including all internal lines.
 */
export class TuiInputDecoder {
  private pending = Buffer.alloc(0);
  private pasteActive = false;
  private pasteRejected = false;
  private pasteBytesDiscarded = 0;
  private readonly maxPasteBytes: number;
  private readonly maxControlBytes: number;

  constructor(options: TuiInputDecoderOptions = {}) {
    this.maxPasteBytes = normalizeOptionalLimit(options.maxPasteBytes, Number.POSITIVE_INFINITY);
    this.maxControlBytes = normalizeOptionalLimit(options.maxControlBytes, 4_096);
  }

  feed(chunk: Buffer | Uint8Array | string): TuiInputEvent[] {
    const input = typeof chunk === "string"
      ? Buffer.from(chunk)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (input.length > 0) {
      this.pending = this.pending.length > 0
        ? Buffer.concat([this.pending, input])
        : Buffer.from(input);
    }

    const events: TuiInputEvent[] = [];
    while (this.pending.length > 0) {
      if (this.pasteActive) {
        if (!this.consumePaste(events)) break;
        continue;
      }

      if (isPartialPrefix(this.pending, BRACKETED_PASTE_START)) break;
      if (this.pending.subarray(0, BRACKETED_PASTE_START.length).equals(BRACKETED_PASTE_START)) {
        this.consumeBytes(BRACKETED_PASTE_START.length);
        this.pasteActive = true;
        this.pasteRejected = false;
        this.pasteBytesDiscarded = 0;
        continue;
      }

      const first = this.pending[0] ?? 0;
      if (first === ESC) {
        const parsed = this.parseEscape();
        if (parsed.status === "partial") break;
        this.consumeBytes(parsed.length);
        if (parsed.event) events.push(parsed.event);
        continue;
      }

      if (first < 0x20 || first === DELETE) {
        const consumed = this.consumeControl(events);
        if (!consumed) break;
        continue;
      }

      const runLength = printableRunLength(this.pending);
      const completeLength = completeUtf8PrefixLength(this.pending.subarray(0, runLength));
      if (completeLength === 0) break;
      const text = sanitizeInputText(this.pending.subarray(0, completeLength).toString("utf8"));
      this.consumeBytes(completeLength);
      if (text) events.push({ type: "text", text });
      if (completeLength < runLength) break;
    }
    return events;
  }

  /**
   * Abandon an incomplete protocol packet after the caller's idle timeout.
   * This is the only clock-dependent policy needed by an integration layer.
   */
  flushIncomplete(): TuiInputEvent[] {
    if (this.pasteActive) {
      const byteLength = this.pasteBytesDiscarded + this.pending.length;
      this.reset();
      return [{
        type: "input-error",
        code: "incomplete-paste",
        message: "Bracketed paste ended without a closing marker; the paste was discarded.",
        byteLength,
      }];
    }
    if (this.pending.length === 0) return [];
    const byteLength = this.pending.length;
    this.pending = Buffer.alloc(0);
    return [{
      type: "input-error",
      code: "malformed-control",
      message: "An incomplete terminal control sequence was discarded.",
      byteLength,
    }];
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
    this.pasteActive = false;
    this.pasteRejected = false;
    this.pasteBytesDiscarded = 0;
  }

  get awaitingInput(): boolean {
    return this.pending.length > 0 || this.pasteActive;
  }

  private consumePaste(events: TuiInputEvent[]): boolean {
    const end = this.pending.indexOf(BRACKETED_PASTE_END);
    if (end >= 0) {
      const byteLength = this.pasteBytesDiscarded + end;
      if (!this.pasteRejected && byteLength <= this.maxPasteBytes) {
        const text = sanitizeInputText(this.pending.subarray(0, end).toString("utf8"));
        events.push({ type: "paste", text });
      } else if (!this.pasteRejected) {
        events.push(pasteLimitError(byteLength, this.maxPasteBytes));
      }
      this.pending = Buffer.from(this.pending.subarray(end + BRACKETED_PASTE_END.length));
      this.pasteActive = false;
      this.pasteRejected = false;
      this.pasteBytesDiscarded = 0;
      return true;
    }

    const totalBytes = this.pasteBytesDiscarded + this.pending.length;
    if (!this.pasteRejected && totalBytes > this.maxPasteBytes) {
      this.pasteRejected = true;
      events.push(pasteLimitError(totalBytes, this.maxPasteBytes));
    }
    if (this.pasteRejected) {
      const retained = longestSuffixPrefixLength(this.pending, BRACKETED_PASTE_END);
      const discarded = this.pending.length - retained;
      this.pasteBytesDiscarded += discarded;
      this.pending = retained > 0
        ? Buffer.from(this.pending.subarray(discarded))
        : Buffer.alloc(0);
    }
    return false;
  }

  private consumeControl(events: TuiInputEvent[]): boolean {
    const first = this.pending[0] ?? 0;
    if (first === CARRIAGE_RETURN) {
      const length = this.pending[1] === CTRL_J ? 2 : 1;
      this.consumeBytes(length);
      events.push({ type: "key", key: "enter" });
      return true;
    }
    this.consumeBytes(1);
    if (first === CTRL_J) events.push({ type: "key", key: "newline" });
    else if (first === CTRL_C) events.push({ type: "key", key: "interrupt" });
    else if (first === CTRL_V) events.push({ type: "paste-image" });
    else if (first === BACKSPACE || first === DELETE) {
      events.push({ type: "key", key: "backspace" });
    } else if (first === CTRL_A) events.push({ type: "key", key: "home" });
    else if (first === CTRL_E) events.push({ type: "key", key: "end" });
    else if (first === TAB) events.push({ type: "text", text: "\t" });
    return true;
  }

  private parseEscape(): EscapeParseResult {
    if (this.pending.length === 1) return { status: "partial" };

    if (this.pending[1] === CARRIAGE_RETURN || this.pending[1] === CTRL_J) {
      return {
        status: "complete",
        length: 2,
        event: { type: "key", key: "newline" },
      };
    }

    const second = this.pending[1] ?? 0;
    if (second === 0x5d) return this.parseOsc();
    if (second === 0x5b) return this.parseCsi();
    if (second === 0x4f) return this.parseSs3();

    // Unknown two-byte ESC sequence: consume the ESC introducer and its final
    // byte together so it can never leak into editable text.
    return { status: "complete", length: 2 };
  }

  private parseOsc(): EscapeParseResult {
    const terminator = findOscTerminator(this.pending);
    if (!terminator) {
      if (this.pending.length <= this.maxControlBytes) return { status: "partial" };
      return {
        status: "complete",
        length: this.pending.length,
        event: malformedControlError(this.pending.length),
      };
    }

    const length = terminator.index + terminator.length;
    if (!startsWith(this.pending, PRIVATE_OSC_PREFIX)) {
      return { status: "complete", length };
    }
    const payload = this.pending
      .subarray(PRIVATE_OSC_PREFIX.length, terminator.index)
      .toString("utf8");
    return { status: "complete", length, event: parsePrivateAction(payload) };
  }

  private parseCsi(): EscapeParseResult {
    let finalIndex = -1;
    for (let index = 2; index < this.pending.length; index += 1) {
      const byte = this.pending[index] ?? 0;
      if (byte >= 0x40 && byte <= 0x7e) {
        finalIndex = index;
        break;
      }
      if (byte < 0x20 || byte > 0x3f) {
        return { status: "complete", length: index + 1 };
      }
    }
    if (finalIndex < 0) {
      if (this.pending.length <= this.maxControlBytes) return { status: "partial" };
      return {
        status: "complete",
        length: this.pending.length,
        event: malformedControlError(this.pending.length),
      };
    }

    const length = finalIndex + 1;
    const sequence = this.pending.subarray(0, length).toString("ascii");
    return { status: "complete", length, event: parseCsiEvent(sequence) };
  }

  private parseSs3(): EscapeParseResult {
    if (this.pending.length < 3) return { status: "partial" };
    const final = String.fromCharCode(this.pending[2] ?? 0);
    const key = ss3Key(final);
    return {
      status: "complete",
      length: 3,
      event: key ? { type: "key", key } : undefined,
    };
  }

  private consumeBytes(length: number): void {
    this.pending = length >= this.pending.length
      ? Buffer.alloc(0)
      : Buffer.from(this.pending.subarray(length));
  }
}

export interface TuiEditorState {
  readonly text: string;
  /** UTF-16 offset at a grapheme boundary. */
  readonly cursor: number;
  /** Visual cell column retained across consecutive vertical movements. */
  readonly preferredColumn: number | null;
}

export type TuiInputFocus = "composer" | "viewer";

export interface TuiEditorOptions {
  readonly focus?: TuiInputFocus;
  readonly clearOnSubmit?: boolean;
  readonly mouseWheelLines?: number;
}

export type TuiInputEffect =
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "interrupt" }
  | {
      readonly type: "scroll";
      readonly direction: "up" | "down" | "start" | "end";
      readonly unit: "line" | "page" | "document";
      readonly amount: number;
    }
  | { readonly type: "mouse"; readonly event: TuiMouseEvent }
  | { readonly type: "paste-image" }
  | { readonly type: "toggle-thinking"; readonly id: number }
  | { readonly type: "toggle-adjustment"; readonly id: number }
  | {
      readonly type: "input-error";
      readonly code: TuiInputErrorCode;
      readonly message: string;
      readonly byteLength?: number;
    };

export interface TuiEditorTransition {
  readonly state: TuiEditorState;
  readonly effects: readonly TuiInputEffect[];
}

export function createTuiEditorState(text = "", cursor = text.length): TuiEditorState {
  const safeText = sanitizeInputText(text);
  return {
    text: safeText,
    cursor: nearestGraphemeBoundary(safeText, cursor),
    preferredColumn: null,
  };
}

/** Apply one decoded event without reading input or drawing the terminal. */
export function reduceTuiInput(
  state: Readonly<TuiEditorState>,
  event: Readonly<TuiInputEvent>,
  options: TuiEditorOptions = {},
): TuiEditorTransition {
  const focus = options.focus ?? "composer";
  const effects: TuiInputEffect[] = [];
  let next = normalizeEditorState(state);

  if (event.type === "input-error") {
    effects.push(copyInputError(event));
    return { state: next, effects };
  }
  if (event.type === "paste-image") {
    effects.push({ type: "paste-image" });
    return { state: next, effects };
  }
  if (event.type === "toggle-thinking") {
    effects.push({ type: "toggle-thinking", id: event.id });
    return { state: next, effects };
  }
  if (event.type === "toggle-adjustment") {
    effects.push({ type: "toggle-adjustment", id: event.id });
    return { state: next, effects };
  }
  if (event.type === "mouse") {
    const wheel = mouseScrollEffect(event, options.mouseWheelLines ?? 3);
    if (wheel) effects.push(wheel);
    else effects.push({ type: "mouse", event });
    return { state: next, effects };
  }

  if (focus === "viewer") {
    const scroll = viewerScrollEffect(event);
    if (scroll) effects.push(scroll);
    else if (event.type === "key" && event.key === "interrupt") {
      effects.push({ type: "interrupt" });
    }
    return { state: next, effects };
  }

  if (event.type === "text" || event.type === "paste") {
    const inserted = sanitizeInputText(event.text);
    next = replaceRange(next, next.cursor, next.cursor, inserted);
    return { state: next, effects };
  }

  switch (event.key) {
    case "left":
      next = moveHorizontal(next, -1);
      break;
    case "right":
      next = moveHorizontal(next, 1);
      break;
    case "up":
      next = moveVertical(next, -1);
      break;
    case "down":
      next = moveVertical(next, 1);
      break;
    case "home":
      next = withCursor(next, lineStart(next.text, next.cursor), null);
      break;
    case "end":
      next = withCursor(next, lineEnd(next.text, next.cursor), null);
      break;
    case "backspace": {
      const start = previousGraphemeBoundary(next.text, next.cursor);
      next = replaceRange(next, start, next.cursor, "");
      break;
    }
    case "delete": {
      const end = nextGraphemeBoundary(next.text, next.cursor);
      next = replaceRange(next, next.cursor, end, "");
      break;
    }
    case "newline":
      next = replaceRange(next, next.cursor, next.cursor, "\n");
      break;
    case "enter":
      effects.push({ type: "submit", text: next.text });
      if (options.clearOnSubmit ?? true) next = createTuiEditorState();
      break;
    case "interrupt":
      effects.push({ type: "interrupt" });
      break;
    case "page-up":
      effects.push({ type: "scroll", direction: "up", unit: "page", amount: 1 });
      break;
    case "page-down":
      effects.push({ type: "scroll", direction: "down", unit: "page", amount: 1 });
      break;
  }
  return { state: next, effects };
}

/** Convenience composition for an owner that wants decoder and draft state together. */
export class TuiInputCore {
  readonly decoder: TuiInputDecoder;
  private editorState: TuiEditorState;
  private focus: TuiInputFocus;
  private readonly clearOnSubmit: boolean;
  private readonly mouseWheelLines: number;

  constructor(options: TuiInputDecoderOptions & TuiEditorOptions & {
    readonly initialText?: string;
    readonly initialCursor?: number;
  } = {}) {
    this.decoder = new TuiInputDecoder(options);
    this.editorState = createTuiEditorState(
      options.initialText ?? "",
      options.initialCursor ?? (options.initialText?.length ?? 0),
    );
    this.focus = options.focus ?? "composer";
    this.clearOnSubmit = options.clearOnSubmit ?? true;
    this.mouseWheelLines = normalizeOptionalLimit(options.mouseWheelLines, 3);
  }

  get state(): TuiEditorState {
    return this.editorState;
  }

  setFocus(focus: TuiInputFocus): void {
    this.focus = focus;
  }

  replaceDraft(text: string, cursor = text.length): void {
    this.editorState = createTuiEditorState(text, cursor);
  }

  feed(chunk: Buffer | Uint8Array | string): {
    readonly events: readonly TuiInputEvent[];
    readonly effects: readonly TuiInputEffect[];
    readonly state: TuiEditorState;
  } {
    const events = this.decoder.feed(chunk);
    return this.apply(events);
  }

  flushIncomplete(): {
    readonly events: readonly TuiInputEvent[];
    readonly effects: readonly TuiInputEffect[];
    readonly state: TuiEditorState;
  } {
    return this.apply(this.decoder.flushIncomplete());
  }

  private apply(events: readonly TuiInputEvent[]) {
    const effects: TuiInputEffect[] = [];
    for (const event of events) {
      const transition = reduceTuiInput(this.editorState, event, {
        focus: this.focus,
        clearOnSubmit: this.clearOnSubmit,
        mouseWheelLines: this.mouseWheelLines,
      });
      this.editorState = transition.state;
      effects.push(...transition.effects);
    }
    return { events, effects, state: this.editorState };
  }
}

function parseCsiEvent(sequence: string): TuiInputEvent | undefined {
  const sgrMouse = /^\u001B\[<([0-9]+);([0-9]+);([0-9]+)([Mm])$/u.exec(sequence);
  if (sgrMouse) return decodeSgrMouse(sgrMouse);

  const match = /^\u001B\[([0-9;:?<>]*)([A-Za-z~])$/u.exec(sequence);
  if (!match) return undefined;
  const payload = match[1] ?? "";
  const final = match[2] ?? "";
  if (final === "A") return keyEvent("up");
  if (final === "B") return keyEvent("down");
  if (final === "C") return keyEvent("right");
  if (final === "D") return keyEvent("left");
  if (final === "H") return keyEvent("home");
  if (final === "F") return keyEvent("end");

  const params = payload.split(";").map((value) => Number(value || "0"));
  if (final === "~") {
    const first = params[0] ?? 0;
    if (first === 1 || first === 7) return keyEvent("home");
    if (first === 4 || first === 8) return keyEvent("end");
    if (first === 3) return keyEvent("delete");
    if (first === 5) return keyEvent("page-up");
    if (first === 6) return keyEvent("page-down");
    if ((first === 13 && (params[1] ?? 0) === 2) ||
        (first === 27 && (params[1] ?? 0) === 2 && (params[2] ?? 0) === 13)) {
      return keyEvent("newline");
    }
    if (first === 27 && (params[1] ?? 0) >= 5 && (params[2] ?? 0) === 99) {
      return keyEvent("interrupt");
    }
  }
  if (final === "u") return parseKittyKey(payload);
  return undefined;
}

function parseKittyKey(payload: string): TuiInputEvent | undefined {
  const fields = payload.split(";");
  const keyCodes = (fields[0] ?? "").split(":").map(Number);
  const modifierParts = (fields[1] ?? "1").split(":").map(Number);
  const codePoint = keyCodes[0] ?? 0;
  const modifier = modifierParts[0] ?? 1;
  const eventType = modifierParts[1] ?? 1;
  if (!Number.isSafeInteger(codePoint) || !Number.isSafeInteger(modifier) ||
      !Number.isSafeInteger(eventType) || modifier < 1 || eventType === 3) {
    return undefined;
  }

  const mask = modifier - 1;
  const shift = (mask & 1) !== 0;
  const alt = (mask & 2) !== 0;
  const ctrl = (mask & 4) !== 0;
  const superKey = (mask & 8) !== 0;

  const functional = kittyFunctionalKey(codePoint);
  if (functional) return keyEvent(functional);
  if (codePoint === 13) return keyEvent(shift ? "newline" : "enter");
  if (codePoint === 10 || (ctrl && codePoint === 106)) return keyEvent("newline");
  if (ctrl && codePoint === 99) return keyEvent("interrupt");
  if (
    codePoint === 118 &&
    ((ctrl && !alt && !superKey) ||
      (superKey && !ctrl && !alt && !shift))
  ) {
    return { type: "paste-image" };
  }
  if (codePoint === 127) return keyEvent("backspace");

  const associatedText = decodeKittyAssociatedText(fields[2]);
  if (associatedText && !ctrl && !alt && !superKey) {
    return { type: "text", text: associatedText };
  }
  const shiftedCodePoint = keyCodes[1];
  const printableCodePoint = shift && shiftedCodePoint !== undefined &&
      Number.isSafeInteger(shiftedCodePoint)
    ? shiftedCodePoint
    : codePoint;
  if (!ctrl && !alt && !superKey && isPrintableUnicodeScalar(printableCodePoint)) {
    return { type: "text", text: sanitizeInputText(String.fromCodePoint(printableCodePoint)) };
  }
  return undefined;
}

function kittyFunctionalKey(codePoint: number): TuiKey | undefined {
  if (codePoint === 57349) return "delete";
  if (codePoint === 57350) return "left";
  if (codePoint === 57351) return "right";
  if (codePoint === 57352) return "up";
  if (codePoint === 57353) return "down";
  if (codePoint === 57354) return "page-up";
  if (codePoint === 57355) return "page-down";
  if (codePoint === 57356) return "home";
  if (codePoint === 57357) return "end";
  return undefined;
}

function decodeKittyAssociatedText(field: string | undefined): string {
  if (!field) return "";
  let result = "";
  for (const encoded of field.split(":")) {
    const codePoint = Number(encoded);
    if (!isPrintableUnicodeScalar(codePoint) && codePoint !== 9 && codePoint !== 10) {
      return "";
    }
    result += String.fromCodePoint(codePoint);
  }
  return sanitizeInputText(result);
}

function isPrintableUnicodeScalar(codePoint: number): boolean {
  return Number.isSafeInteger(codePoint) && codePoint >= 0x20 &&
    codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
}

function parsePrivateAction(payload: string): TuiInputEvent | undefined {
  if (payload === "paste-image") return { type: "paste-image" };
  const thinking = /^(?:toggle|show)-thinking;([1-9][0-9]{0,15})$/u.exec(payload);
  if (thinking) {
    const id = Number(thinking[1]);
    if (Number.isSafeInteger(id)) return { type: "toggle-thinking", id };
  }
  const adjustment = /^toggle-adjustment;([1-9][0-9]{0,15})$/u.exec(payload);
  if (adjustment) {
    const id = Number(adjustment[1]);
    if (Number.isSafeInteger(id)) return { type: "toggle-adjustment", id };
  }
  return undefined;
}

function decodeSgrMouse(match: RegExpExecArray): TuiMouseEvent | undefined {
  const code = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  if (![code, column, row].every(Number.isSafeInteger) || column <= 0 || row <= 0) {
    return undefined;
  }
  const final = match[4];
  const wheel = (code & 64) !== 0;
  const motion = (code & 32) !== 0;
  const base = code & 3;
  const button: TuiMouseButton = base === 0
    ? "left"
    : base === 1
      ? "middle"
      : base === 2
        ? "right"
        : "none";
  let action: TuiMouseAction;
  if (wheel) {
    action = base === 0
      ? "wheel-up"
      : base === 1
        ? "wheel-down"
        : base === 2
          ? "wheel-left"
          : "wheel-right";
  } else if (final === "m" || base === 3) action = "release";
  else if (motion) action = "move";
  else action = "press";
  return {
    type: "mouse",
    column,
    row,
    action,
    button: wheel ? "none" : button,
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}

function ss3Key(final: string): TuiKey | undefined {
  if (final === "A") return "up";
  if (final === "B") return "down";
  if (final === "C") return "right";
  if (final === "D") return "left";
  if (final === "H") return "home";
  if (final === "F") return "end";
  return undefined;
}

function keyEvent(key: TuiKey): TuiInputEvent {
  return { type: "key", key };
}

function viewerScrollEffect(event: TuiInputEvent): TuiInputEffect | undefined {
  if (event.type !== "key") return undefined;
  if (event.key === "up") return scrollEffect("up", "line", 1);
  if (event.key === "down") return scrollEffect("down", "line", 1);
  if (event.key === "page-up") return scrollEffect("up", "page", 1);
  if (event.key === "page-down") return scrollEffect("down", "page", 1);
  if (event.key === "home") return scrollEffect("start", "document", 1);
  if (event.key === "end") return scrollEffect("end", "document", 1);
  return undefined;
}

function mouseScrollEffect(event: TuiMouseEvent, lines: number): TuiInputEffect | undefined {
  if (event.action === "wheel-up") return scrollEffect("up", "line", lines);
  if (event.action === "wheel-down") return scrollEffect("down", "line", lines);
  if (event.action === "wheel-left") return scrollEffect("up", "line", lines);
  if (event.action === "wheel-right") return scrollEffect("down", "line", lines);
  return undefined;
}

function scrollEffect(
  direction: "up" | "down" | "start" | "end",
  unit: "line" | "page" | "document",
  amount: number,
): TuiInputEffect {
  return { type: "scroll", direction, unit, amount };
}

function normalizeEditorState(state: Readonly<TuiEditorState>): TuiEditorState {
  const text = sanitizeInputText(state.text);
  return {
    text,
    cursor: nearestGraphemeBoundary(text, state.cursor),
    preferredColumn: state.preferredColumn === null || !Number.isFinite(state.preferredColumn)
      ? null
      : Math.max(0, Math.floor(state.preferredColumn)),
  };
}

function replaceRange(
  state: TuiEditorState,
  start: number,
  end: number,
  replacement: string,
): TuiEditorState {
  const safeStart = nearestGraphemeBoundary(state.text, start);
  const safeEnd = nearestGraphemeBoundary(state.text, end);
  const text = state.text.slice(0, safeStart) + replacement + state.text.slice(safeEnd);
  return {
    text,
    cursor: safeStart + replacement.length,
    preferredColumn: null,
  };
}

function moveHorizontal(state: TuiEditorState, direction: -1 | 1): TuiEditorState {
  const cursor = direction < 0
    ? previousGraphemeBoundary(state.text, state.cursor)
    : nextGraphemeBoundary(state.text, state.cursor);
  return withCursor(state, cursor, null);
}

function moveVertical(state: TuiEditorState, direction: -1 | 1): TuiEditorState {
  const currentStart = lineStart(state.text, state.cursor);
  const currentColumn = state.preferredColumn ?? displayWidth(
    state.text.slice(currentStart, state.cursor),
  );
  let targetStart: number;
  let targetEnd: number;
  if (direction < 0) {
    if (currentStart === 0) return withCursor(state, state.cursor, currentColumn);
    targetEnd = currentStart - 1;
    targetStart = lineStart(state.text, targetEnd);
  } else {
    const currentEnd = lineEnd(state.text, state.cursor);
    if (currentEnd >= state.text.length) return withCursor(state, state.cursor, currentColumn);
    targetStart = currentEnd + 1;
    targetEnd = lineEnd(state.text, targetStart);
  }
  const cursor = offsetAtVisualColumn(state.text, targetStart, targetEnd, currentColumn);
  return withCursor(state, cursor, currentColumn);
}

function withCursor(
  state: TuiEditorState,
  cursor: number,
  preferredColumn: number | null,
): TuiEditorState {
  return {
    text: state.text,
    cursor: nearestGraphemeBoundary(state.text, cursor),
    preferredColumn,
  };
}

function lineStart(text: string, cursor: number): number {
  return text.lastIndexOf("\n", Math.max(0, cursor) - 1) + 1;
}

function lineEnd(text: string, cursor: number): number {
  const end = text.indexOf("\n", Math.max(0, cursor));
  return end < 0 ? text.length : end;
}

function offsetAtVisualColumn(
  text: string,
  start: number,
  end: number,
  requestedColumn: number,
): number {
  let offset = start;
  let column = 0;
  for (const segment of graphemeSegments(text.slice(start, end))) {
    const width = displayWidth(segment.segment);
    if (column + width > requestedColumn) break;
    offset = start + segment.end;
    column += width;
  }
  return offset;
}

function previousGraphemeBoundary(text: string, cursor: number): number {
  const safe = Math.max(0, Math.min(text.length, Math.floor(cursor)));
  let previous = 0;
  for (const boundary of graphemeBoundaries(text)) {
    if (boundary >= safe) break;
    previous = boundary;
  }
  return previous;
}

function nextGraphemeBoundary(text: string, cursor: number): number {
  const safe = Math.max(0, Math.min(text.length, Math.floor(cursor)));
  for (const boundary of graphemeBoundaries(text)) {
    if (boundary > safe) return boundary;
  }
  return text.length;
}

function nearestGraphemeBoundary(text: string, requested: number): number {
  const safe = Number.isFinite(requested)
    ? Math.max(0, Math.min(text.length, Math.floor(requested)))
    : text.length;
  let previous = 0;
  for (const boundary of graphemeBoundaries(text)) {
    if (boundary > safe) break;
    previous = boundary;
  }
  return previous;
}

function graphemeBoundaries(text: string): number[] {
  const boundaries = [0];
  for (const segment of graphemeSegments(text)) boundaries.push(segment.end);
  return boundaries;
}

function graphemeSegments(text: string): Array<{ readonly segment: string; readonly end: number }> {
  const intl = Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { readonly granularity: "grapheme" },
    ) => { segment(input: string): Iterable<{ readonly segment: string; readonly index: number }> };
  };
  if (intl.Segmenter) {
    const segmenter = new intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => ({
      segment: part.segment,
      end: part.index + part.segment.length,
    }));
  }
  const result: Array<{ segment: string; end: number }> = [];
  let offset = 0;
  for (const codePoint of Array.from(text)) {
    offset += codePoint.length;
    result.push({ segment: codePoint, end: offset });
  }
  return result;
}

function sanitizeInputText(value: string): string {
  const normalized = stripAnsi(
    value
      .replace(/\r\n?/gu, "\n")
      .replace(/[\u2028\u2029]/gu, "\n"),
  );
  let result = "";
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x09 || codePoint === 0x0a) {
      result += character;
      continue;
    }
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    // Keep ZWNJ/ZWJ because they are semantic grapheme components (notably in
    // joined emoji), but remove bidi overrides and other invisible controls.
    if (codePoint === 0x061c || codePoint === 0x200b || codePoint === 0x200e ||
        codePoint === 0x200f || (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2060 && codePoint <= 0x2069) || codePoint === 0xfeff) {
      continue;
    }
    result += character;
  }
  return result;
}

function printableRunLength(input: Buffer): number {
  let index = 0;
  while (index < input.length) {
    const byte = input[index] ?? 0;
    if (byte === ESC || byte < 0x20 || byte === DELETE) break;
    index += 1;
  }
  return index;
}

function completeUtf8PrefixLength(input: Buffer): number {
  if (input.length === 0) return 0;
  let lead = input.length - 1;
  while (lead >= 0 && ((input[lead] ?? 0) & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return input.length;
  const first = input[lead] ?? 0;
  const expected = first < 0x80
    ? 1
    : (first & 0xe0) === 0xc0
      ? 2
      : (first & 0xf0) === 0xe0
        ? 3
        : (first & 0xf8) === 0xf0
          ? 4
          : 1;
  return input.length - lead < expected ? lead : input.length;
}

function findOscTerminator(input: Buffer): { readonly index: number; readonly length: number } | undefined {
  for (let index = 2; index < input.length; index += 1) {
    const byte = input[index] ?? 0;
    if (byte === BEL) return { index, length: 1 };
    if (byte === ESC && input[index + 1] === 0x5c) return { index, length: 2 };
  }
  return undefined;
}

function startsWith(value: Buffer, prefix: Buffer): boolean {
  return value.length >= prefix.length && value.subarray(0, prefix.length).equals(prefix);
}

function isPartialPrefix(value: Buffer, prefix: Buffer): boolean {
  return value.length < prefix.length && value.equals(prefix.subarray(0, value.length));
}

function longestSuffixPrefixLength(value: Buffer, marker: Buffer): number {
  const maximum = Math.min(value.length, marker.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.subarray(value.length - length).equals(marker.subarray(0, length))) return length;
  }
  return 0;
}

function normalizeOptionalLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function pasteLimitError(byteLength: number, limit: number): TuiInputEvent {
  return {
    type: "input-error",
    code: "paste-too-large",
    message: `Bracketed paste contains at least ${byteLength} bytes, exceeding the ${limit}-byte limit; it was discarded.`,
    byteLength,
  };
}

function malformedControlError(byteLength: number): TuiInputEvent {
  return {
    type: "input-error",
    code: "malformed-control",
    message: "An unterminated terminal control sequence was discarded.",
    byteLength,
  };
}

function copyInputError(event: Extract<TuiInputEvent, { type: "input-error" }>): TuiInputEffect {
  return {
    type: "input-error",
    code: event.code,
    message: event.message,
    ...(event.byteLength === undefined ? {} : { byteLength: event.byteLength }),
  };
}
