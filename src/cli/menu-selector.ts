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

export interface MenuSelectorOverlay {
  render(lines: string[]): void;
  clear(): void;
}

export interface MenuSelectorOptions {
  readonly input: MenuSelectorInput;
  readonly output: MenuSelectorOutput;
  readonly color?: boolean;
  readonly overlay?: MenuSelectorOverlay;
  /** Resolve false to fail closed when a choice cannot be reviewed safely. */
  readonly canConfirm?: () => boolean;
}

const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";
const DEFAULT_MAX_LABEL_CODE_POINTS = 96;

/** Escape controls and bidi formatting so untrusted labels cannot control the terminal. */
export function safeMenuLabel(
  value: string,
  maxCodePoints = DEFAULT_MAX_LABEL_CODE_POINTS,
): string {
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
    result += unsafe
      ? `\\u{${codePoint.toString(16).padStart(4, "0")}}`
      : character;
  }
  const characters = Array.from(result);
  return characters.length <= maxCodePoints
    ? result
    : `${characters.slice(0, maxCodePoints).join("")}…`;
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

  let selectedIndex = Math.max(0, Math.min(initialIndex, choiceCount - 1));
  const lineCount = choiceCount + 2;
  let rendered = false;

  const render = (): void => {
    const lines = renderLines(selectedIndex);
    if (options.overlay) {
      options.overlay.render(lines);
      rendered = true;
      return;
    }
    if (rendered) options.output.write(`\u001B[${lineCount}A`);
    for (const line of lines) {
      if (rendered) options.output.write("\u001B[2K\r");
      options.output.write(`${line}\n`);
    }
    rendered = true;
  };

  return new Promise((resolve, reject) => {
    const input = options.input;
    const decoder = new StringDecoder("utf8");
    const wasRaw = Boolean(input.isRaw);
    const mustEnableRawMode = !wasRaw;
    const wasFlowing = input.readableFlowing === true;
    let settled = false;
    let escapeState: "none" | "start" | "control" = "none";
    let escapeIntroducer: "[" | "O" | undefined;
    let escapeBody = "";
    let escapeTimer: ReturnType<typeof setTimeout> | undefined;

    const clearEscapeTimer = (): void => {
      if (escapeTimer) clearTimeout(escapeTimer);
      escapeTimer = undefined;
    };
    const cleanup = (): void => {
      clearEscapeTimer();
      input.removeListener("data", guardedOnData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onClose);
      input.removeListener("error", onError);
      try {
        if (mustEnableRawMode) input.setRawMode?.(false);
      } catch {
        // The terminal may have disappeared while the selector was active.
      }
      if (wasFlowing) input.resume();
      else input.pause();
      try {
        if (options.overlay) options.overlay.clear();
        else options.output.write(`${SHOW_CURSOR}\n`);
      } catch {
        // Selection is already settled; output cleanup is best effort.
      }
    };
    const finish = (index?: number, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(index);
    };
    const startEscapeTimer = (delayMs = 60): void => {
      clearEscapeTimer();
      escapeTimer = setTimeout(() => finish(undefined), delayMs);
      escapeTimer.unref?.();
    };
    const move = (offset: number): void => {
      selectedIndex = (selectedIndex + offset + choiceCount) % choiceCount;
      render();
    };
    const confirm = (): void => {
      let allowed = true;
      try {
        allowed = options.canConfirm?.() ?? true;
      } catch {
        allowed = false;
      }
      finish(allowed ? selectedIndex : undefined);
    };
    const parseCsiU = (
      body: string,
    ): {
      readonly keyCode: number;
      readonly modifier?: number;
      readonly event?: 1 | 2 | 3;
    } | undefined => {
      const fields = body.split(";");
      if (fields.length < 1 || fields.length > 3) return undefined;
      const keyFields = fields[0]?.split(":") ?? [];
      if (
        keyFields.length < 1 ||
        keyFields.length > 3 ||
        !keyFields.every(isSafeProtocolInteger)
      ) return undefined;
      const keyCode = Number(keyFields[0]);

      let modifier: number | undefined;
      let event: 1 | 2 | 3 | undefined;
      if (fields.length >= 2) {
        const modifierFields = fields[1]?.split(":") ?? [];
        if (
          modifierFields.length < 1 ||
          modifierFields.length > 2 ||
          !isPositiveSafeProtocolInteger(modifierFields[0] ?? "")
        ) return undefined;
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
          !textCodePoints.every((value) =>
            isSafeProtocolInteger(value) && Number(value) <= 0x10ffff
          )
        ) return undefined;
      }
      return { keyCode, modifier, event };
    };
    const parseArrowEvent = (body: string): 1 | 2 | 3 | undefined | false => {
      if (body === "" || body === "1") return undefined;
      const match = /^1;(\d+)(?::([123]))?$/u.exec(body);
      if (!match) return false;
      const modifier = Number(match[1]);
      if (!Number.isSafeInteger(modifier) || modifier < 1) return false;
      return match[2] === undefined
        ? undefined
        : Number(match[2]) as 1 | 2 | 3;
    };
    const handleControlSequence = (
      introducer: "[" | "O" | undefined,
      body: string,
      final: string,
    ): void => {
      if (final === "A" || final === "B") {
        if (introducer === "O") {
          if (body !== "") return;
        } else if (introducer === "[") {
          const event = parseArrowEvent(body);
          if (event === false || event === 3) return;
        } else {
          return;
        }
        move(final === "A" ? -1 : 1);
        return;
      }
      if (introducer === "O" && body === "" && final === "M") {
        confirm();
        return;
      }
      if (introducer !== "[") return;

      if (final === "u") {
        const key = parseCsiU(body);
        if (!key || key.event === 3) return;
        if (key.keyCode === 57352 || key.keyCode === 57419) move(-1);
        else if (key.keyCode === 57353 || key.keyCode === 57420) move(1);
        else if (key.keyCode === 13 || key.keyCode === 57414) confirm();
        else if (key.keyCode === 27) finish(undefined);
        else if (
          (key.keyCode === 99 || key.keyCode === 67) &&
          key.modifier !== undefined &&
          ((key.modifier - 1) & 4) !== 0
        ) {
          finish(undefined);
        }
        return;
      }

      if (final === "~") {
        // xterm modifyOtherKeys encodes modified Enter as CSI 27;mod;13~.
        const match = /^27;(\d+);13$/u.exec(body);
        if (match && isPositiveSafeProtocolInteger(match[1] ?? "")) {
          confirm();
        }
      }
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const character of text) {
        if (escapeState === "start") {
          clearEscapeTimer();
          if (character === "[" || character === "O") {
            escapeState = "control";
            escapeIntroducer = character;
            escapeBody = "";
            startEscapeTimer(250);
          } else {
            escapeState = "none";
            escapeIntroducer = undefined;
            escapeBody = "";
          }
          continue;
        }
        if (escapeState === "control") {
          if (character === "\u001B") {
            escapeState = "start";
            escapeIntroducer = undefined;
            escapeBody = "";
            startEscapeTimer();
            continue;
          }
          if (character >= "@" && character <= "~") {
            clearEscapeTimer();
            const introducer = escapeIntroducer;
            const body = escapeBody;
            escapeState = "none";
            escapeIntroducer = undefined;
            escapeBody = "";
            handleControlSequence(introducer, body, character);
            if (settled) return;
          } else if (escapeBody.length < 64) {
            escapeBody += character;
            startEscapeTimer(250);
          } else {
            finish(undefined);
            return;
          }
          continue;
        }
        if (character === "\u001B") {
          escapeState = "start";
          escapeIntroducer = undefined;
          escapeBody = "";
          startEscapeTimer();
          continue;
        }
        if (character === "\u0003") {
          finish(undefined);
          return;
        }
        if (character === "\r" || character === "\n") {
          confirm();
          return;
        }
      }
    };
    const guardedOnData = (chunk: Buffer | string): void => {
      try {
        onData(chunk);
      } catch {
        finish(
          undefined,
          new Error("Unable to process the interactive selection."),
        );
      }
    };
    const onEnd = (): void => finish(undefined);
    const onClose = (): void => finish(undefined);
    const onError = (): void => finish(undefined, new Error("Unable to read the interactive selection."));

    try {
      if (!options.overlay) options.output.write(HIDE_CURSOR);
      // Make the selector the active input owner before exposing its first
      // frame. VS Code/ConPTY can deliver the first key immediately after the
      // overlay becomes visible; rendering first left a small window where
      // that key was still consumed by the previous prompt owner.
      if (mustEnableRawMode) input.setRawMode?.(true);
      input.on("data", guardedOnData);
      input.once("end", onEnd);
      input.once("close", onClose);
      input.once("error", onError);
      input.resume();
      render();
    } catch {
      finish(undefined, new Error("Unable to start the interactive selection."));
    }
  });
}

function isSafeProtocolInteger(value: string): boolean {
  if (!/^\d+$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0;
}

function isPositiveSafeProtocolInteger(value: string): boolean {
  return isSafeProtocolInteger(value) && Number(value) >= 1;
}
