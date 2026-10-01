import { StringDecoder } from "node:string_decoder";

import { Chalk } from "chalk";

export interface MenuSelectorInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly readableFlowing?: boolean | null;
  setRawMode?(mode: boolean): this;
}

export interface MenuSelectorOutput extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
  readonly rows?: number;
}

export type MenuNavigationDirection = "up" | "down";

export interface MenuSelectorNavigationActivation {
  /**
   * Settles after the host has installed its key interception. `false` means
   * the selector must rely on ordinary TTY input instead.
   */
  readonly ready?: Promise<boolean>;
  release(): void;
}

export interface MenuSelectorNavigation {
  /**
   * Activate an optional out-of-band navigation source for this selector.
   * The returned cleanup must be safe to call on every selector exit path.
   * A host that supplies `ready` must not resolve it with `true` until its key
   * binding is active; the selector remains hidden until that acknowledgement
   * arrives so the first visible arrow cannot escape to terminal scrollback.
   */
  activate(onNavigate: (direction: MenuNavigationDirection) => void): MenuSelectorNavigationActivation;
}

export interface MenuSelectorOptions {
  readonly signal?: AbortSignal;
  readonly input: MenuSelectorInput;
  readonly output: MenuSelectorOutput;
  readonly color?: boolean;
  readonly navigation?: MenuSelectorNavigation;
  /** Resolve false to fail closed when a choice cannot be reviewed safely. */
  readonly canConfirm?: () => boolean;
  /** Starts only after the menu's first visible frame. */
  readonly idleTimeoutMs?: number;
  readonly idleSelectionIndex?: number;
}

const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";
const DEFAULT_MAX_LABEL_CODE_POINTS = 96;

/** Escape controls and bidi formatting so untrusted labels cannot control the terminal. */
export function safeMenuLabel(value: string, maxCodePoints = DEFAULT_MAX_LABEL_CODE_POINTS): string {
  let result = "";
  for (const character of value.replace(/[\r\n\t]/gu, " ")) {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafe =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x2069) ||
      codePoint === 0xfeff;
    result += unsafe ? `\\u{${codePoint.toString(16).padStart(4, "0")}}` : character;
  }
  const characters = Array.from(result);
  return characters.length <= maxCodePoints ? result : `${characters.slice(0, maxCodePoints).join("")}…`;
}

export function renderMenu(
  title: string,
  rows: readonly string[],
  selectedIndex: number,
  color: boolean,
  maxLabelCodePoints = DEFAULT_MAX_LABEL_CODE_POINTS,
): string[] {
  const palette = new Chalk({ level: color ? 1 : 0 });
  const lines = [palette.bold.cyan(safeMenuLabel(title, maxLabelCodePoints))];
  rows.forEach((row, index) => {
    const selected = index === selectedIndex;
    const text = `${selected ? "›" : " "} ${safeMenuLabel(row, maxLabelCodePoints)}`;
    lines.push(selected ? palette.bold.white(text) : palette.gray(text));
  });
  lines.push(palette.dim("Use ↑/↓ to move, Enter to confirm, or Esc to cancel"));
  return lines;
}

/**
 * Select one row in a fixed-height menu. Cancellation resolves undefined and
 * all exit paths restore the previous Raw Mode, flow state, and cursor.
 */
export function selectMenuIndex(
  choiceCount: number,
  initialIndex: number,
  renderLines: (selectedIndex: number) => string[],
  options: MenuSelectorOptions,
  emptyMessage: string,
): Promise<number | undefined> {
  if (choiceCount === 0) throw new Error(emptyMessage);
  if (!options.input.isTTY || !options.output.isTTY || typeof options.input.setRawMode !== "function") {
    throw new Error("Interactive selection requires a TTY.");
  }
  return new MenuSelector(choiceCount, initialIndex, renderLines, options).run();
}

/** One active selection: owns the input stream, the escape-sequence parser and the rendered frame until it settles. */
class MenuSelector {
  private selectedIndex: number;
  private readonly lineCount: number;
  private rendered = false;
  private renderEnabled = true;
  private readonly input: MenuSelectorInput;
  private readonly decoder = new StringDecoder("utf8");
  private mustEnableRawMode = false;
  private wasFlowing = false;
  private settled = false;
  private escapeState: "none" | "start" | "control" = "none";
  private escapeIntroducer: "[" | "O" | undefined;
  private escapeBody = "";
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseNavigation: (() => void) | undefined;
  private settle: (index: number | undefined, error: Error | undefined) => void = () => undefined;

  constructor(
    private readonly choiceCount: number,
    initialIndex: number,
    private readonly renderLines: (selectedIndex: number) => string[],
    private readonly options: MenuSelectorOptions,
  ) {
    this.selectedIndex = Math.max(0, Math.min(initialIndex, choiceCount - 1));
    this.lineCount = choiceCount + 2;
    this.input = options.input;
  }

  run(): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      this.settle = (index, error) => (error ? reject(error) : resolve(index));
      const input = this.input;
      this.mustEnableRawMode = !input.isRaw;
      this.wasFlowing = input.readableFlowing === true;
      this.start();
    });
  }

  private start(): void {
    const { input, options } = this;
    try {
      options.output.write(HIDE_CURSOR);
      // Make the selector the active input owner before exposing its first
      // frame. VS Code/ConPTY can deliver the first key immediately after the
      // menu becomes visible; rendering first left a small window where
      // that key was still consumed by the previous prompt owner.
      // Reassert Raw Mode even when Node's cached `isRaw` flag is already true.
      // Windows ConPTY can leave the console input handle in cooked mode after
      // a focus/owner transition while the JavaScript ReadStream still reports
      // `isRaw === true`. In that state the first arrows are buffered until an
      // Enter completes the cooked read. `setRawMode(true)` is idempotent for a
      // healthy TTY and repairs that drift before the selector becomes visible.
      input.setRawMode?.(true);
      input.on("data", this.guardedOnData);
      input.once("end", this.onEnd);
      input.once("close", this.onClose);
      options.signal?.addEventListener("abort", this.onAbort, { once: true });
      if (options.signal?.aborted) {
        this.finish(undefined);
        return;
      }
      input.once("error", this.onError);
      input.resume();
      // An out-of-band host may invoke its listener synchronously while it is
      // still installing key interception. Suppress every frame until the
      // activation result below explicitly permits the menu to become visible.
      this.renderEnabled = options.navigation === undefined;
      const navigationActivation = options.navigation?.activate((direction) => {
        if (this.settled) return;
        try {
          this.move(direction === "up" ? -1 : 1);
        } catch {
          this.finish(undefined, new Error("Unable to render the interactive selection."));
        }
      });
      this.releaseNavigation = navigationActivation?.release.bind(navigationActivation);
      const navigationReady = navigationActivation?.ready;
      if (navigationReady) {
        // Keep the menu invisible until VS Code confirms that Up/Down have
        // been rebound. TTY input is already in Raw Mode, so an unavailable
        // host can safely resolve `false` and use the normal terminal path.
        void navigationReady
          .catch(() => false)
          .then(() => {
            if (this.settled) return;
            this.renderEnabled = true;
            try {
              this.render();
              this.armIdleTimer();
            } catch {
              this.finish(undefined, new Error("Unable to render the interactive selection."));
            }
          });
      } else {
        this.renderEnabled = true;
        this.render();
        this.armIdleTimer();
      }
    } catch {
      this.finish(undefined, new Error("Unable to start the interactive selection."));
    }
  }

  private render(): void {
    if (!this.renderEnabled) return;
    const { options } = this;
    const lines = this.renderLines(this.selectedIndex);
    if (this.rendered) options.output.write(`\u001B[${this.lineCount}A`);
    for (const line of lines) {
      if (this.rendered) options.output.write("\u001B[2K\r");
      options.output.write(`${line}\n`);
    }
    this.rendered = true;
  }

  private clearEscapeTimer(): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
  }

  private cleanup(): void {
    const { input, options } = this;
    options.signal?.removeEventListener("abort", this.onAbort);
    this.clearEscapeTimer();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    try {
      this.releaseNavigation?.();
    } catch {
      // Optional host integration cleanup is best effort.
    }
    this.releaseNavigation = undefined;
    input.removeListener("data", this.guardedOnData);
    input.removeListener("end", this.onEnd);
    input.removeListener("close", this.onClose);
    input.removeListener("error", this.onError);
    try {
      if (this.mustEnableRawMode) input.setRawMode?.(false);
    } catch {
      // The terminal may have disappeared while the selector was active.
    }
    if (this.wasFlowing) input.resume();
    else input.pause();
    try {
      options.output.write(`${SHOW_CURSOR}\n`);
    } catch {
      // Selection is already settled; output cleanup is best effort.
    }
  }

  private finish(index?: number, error?: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.settle(index, error);
  }

  private armIdleTimer(): void {
    const { options } = this;
    if (this.settled || !this.rendered || this.idleTimer || options.idleTimeoutMs === undefined) return;
    const timeoutIndex = options.idleSelectionIndex;
    if (
      !Number.isSafeInteger(options.idleTimeoutMs) ||
      options.idleTimeoutMs <= 0 ||
      timeoutIndex === undefined ||
      !Number.isSafeInteger(timeoutIndex) ||
      timeoutIndex < 0 ||
      timeoutIndex >= this.choiceCount
    )
      return;
    this.idleTimer = setTimeout(() => {
      // A pending Esc may be waiting for its short CSI disambiguation window.
      // Never let the unattended approval timer race past that user input.
      if (options.signal?.aborted || this.escapeState !== "none" || !this.rendered || !this.renderEnabled) {
        this.finish(undefined);
        return;
      }
      this.finish(this.confirmationAllowed() ? timeoutIndex : undefined);
    }, options.idleTimeoutMs);
  }

  private startEscapeTimer(delayMs = 60): void {
    this.clearEscapeTimer();
    this.escapeTimer = setTimeout(() => this.finish(undefined), delayMs);
    this.escapeTimer.unref?.();
  }

  private move(offset: number): void {
    this.selectedIndex = (this.selectedIndex + offset + this.choiceCount) % this.choiceCount;
    this.render();
  }

  private confirmationAllowed(): boolean {
    try {
      return this.options.canConfirm?.() ?? true;
    } catch {
      return false;
    }
  }

  private confirm(): void {
    // Never accept a buffered Enter before the user has seen the first menu
    // frame. VS Code navigation readiness is asynchronous, so confirmation
    // must remain fail-closed while the menu is deliberately hidden.
    if (!this.renderEnabled || !this.rendered) return;
    this.finish(this.confirmationAllowed() ? this.selectedIndex : undefined);
  }

  private handleControlSequence(introducer: "[" | "O" | undefined, body: string, final: string): void {
    if (final === "A" || final === "B") {
      if (introducer === "O") {
        if (body !== "") return;
      } else if (introducer === "[") {
        const event = parseArrowEvent(body);
        if (event === false || event === 3) return;
      } else {
        return;
      }
      this.move(final === "A" ? -1 : 1);
      return;
    }
    if (introducer === "O" && body === "" && final === "M") {
      this.confirm();
      return;
    }
    if (introducer !== "[") return;

    if (final === "u") {
      const key = parseCsiU(body);
      if (!key || key.event === 3) return;
      if (key.keyCode === 57352 || key.keyCode === 57419) this.move(-1);
      else if (key.keyCode === 57353 || key.keyCode === 57420) this.move(1);
      else if (key.keyCode === 13 || key.keyCode === 57414) this.confirm();
      else if (key.keyCode === 27) this.finish(undefined);
      else if (
        (key.keyCode === 99 || key.keyCode === 67) &&
        key.modifier !== undefined &&
        ((key.modifier - 1) & 4) !== 0
      ) {
        this.finish(undefined);
      }
      return;
    }

    if (final === "~") {
      // xterm modifyOtherKeys encodes modified Enter as CSI 27;mod;13~.
      const match = /^27;(\d+);13$/u.exec(body);
      if (match && isPositiveSafeProtocolInteger(match[1] ?? "")) {
        this.confirm();
      }
    }
  }

  private beginEscape(): void {
    this.escapeState = "start";
    this.escapeIntroducer = undefined;
    this.escapeBody = "";
    this.startEscapeTimer();
  }

  private resetEscape(): void {
    this.escapeState = "none";
    this.escapeIntroducer = undefined;
    this.escapeBody = "";
  }

  private onData(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    for (const character of text) {
      if (this.escapeState === "start") {
        this.clearEscapeTimer();
        if (character === "[" || character === "O") {
          this.escapeState = "control";
          this.escapeIntroducer = character;
          this.escapeBody = "";
          this.startEscapeTimer(250);
        } else {
          this.resetEscape();
        }
        continue;
      }
      if (this.escapeState === "control") {
        if (character === "\u001B") {
          this.beginEscape();
          continue;
        }
        if (character >= "@" && character <= "~") {
          this.clearEscapeTimer();
          const introducer = this.escapeIntroducer;
          const body = this.escapeBody;
          this.resetEscape();
          this.handleControlSequence(introducer, body, character);
          if (this.settled) return;
        } else if (this.escapeBody.length < 64) {
          this.escapeBody += character;
          this.startEscapeTimer(250);
        } else {
          this.finish(undefined);
          return;
        }
        continue;
      }
      if (character === "\u001B") {
        this.beginEscape();
        continue;
      }
      if (character === "\u0003") {
        this.finish(undefined);
        return;
      }
      if (character === "\r" || character === "\n") {
        this.confirm();
        return;
      }
    }
  }

  private readonly guardedOnData = (chunk: Buffer | string): void => {
    try {
      this.onData(chunk);
    } catch {
      this.finish(undefined, new Error("Unable to process the interactive selection."));
    }
  };
  private readonly onEnd = (): void => this.finish(undefined);
  private readonly onClose = (): void => this.finish(undefined);
  private readonly onAbort = (): void => this.finish(undefined);
  private readonly onError = (): void => this.finish(undefined, new Error("Unable to read the interactive selection."));
}

/** A kitty keyboard-protocol (CSI u) key: code, optional modifier mask and press/repeat/release event. */
function parseCsiU(body: string):
  | {
      readonly keyCode: number;
      readonly modifier?: number;
      readonly event?: 1 | 2 | 3;
    }
  | undefined {
  const fields = body.split(";");
  if (fields.length < 1 || fields.length > 3) return undefined;
  const keyFields = fields[0]?.split(":") ?? [];
  if (keyFields.length < 1 || keyFields.length > 3 || !keyFields.every(isSafeProtocolInteger)) return undefined;
  const keyCode = Number(keyFields[0]);

  let modifier: number | undefined;
  let event: 1 | 2 | 3 | undefined;
  if (fields.length >= 2) {
    const modifierFields = fields[1]?.split(":") ?? [];
    if (
      modifierFields.length < 1 ||
      modifierFields.length > 2 ||
      !isPositiveSafeProtocolInteger(modifierFields[0] ?? "")
    )
      return undefined;
    modifier = Number(modifierFields[0]);
    if (modifierFields.length === 2) {
      if (!/^[123]$/u.test(modifierFields[1] ?? "")) return undefined;
      event = Number(modifierFields[1]) as 1 | 2 | 3;
    }
  }
  if (fields.length === 3) {
    const textCodePoints = fields[2]?.split(":") ?? [];
    if (
      textCodePoints.length < 1 ||
      !textCodePoints.every((value) => isSafeProtocolInteger(value) && Number(value) <= 0x10ffff)
    )
      return undefined;
  }
  return { keyCode, modifier, event };
}

/** The event of a CSI arrow key: undefined for a plain press, false when the parameters are malformed. */
function parseArrowEvent(body: string): 1 | 2 | 3 | undefined | false {
  if (body === "" || body === "1") return undefined;
  const match = /^1;(\d+)(?::([123]))?$/u.exec(body);
  if (!match) return false;
  const modifier = Number(match[1]);
  if (!Number.isSafeInteger(modifier) || modifier < 1) return false;
  return match[2] === undefined ? undefined : (Number(match[2]) as 1 | 2 | 3);
}

function isSafeProtocolInteger(value: string): boolean {
  if (!/^\d+$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0;
}

function isPositiveSafeProtocolInteger(value: string): boolean {
  return isSafeProtocolInteger(value) && Number(value) >= 1;
}
