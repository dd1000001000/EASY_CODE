import { StringDecoder } from "node:string_decoder";

import { Chalk } from "chalk";

import type { ProviderName } from "../core/types.js";
import type { VisionSupport } from "../models/catalog.js";

export interface ProviderSelectorChoice {
  readonly provider: ProviderName;
  readonly label: string;
  readonly apiKeyConfigured: boolean;
}

export interface ModelSelectorChoice {
  readonly id: string;
  readonly label: string;
  readonly vision?: VisionSupport;
}

export interface ModelSelectorInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly readableFlowing?: boolean | null;
  setRawMode?(mode: boolean): this;
}

export interface ModelSelectorOutput extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

interface SelectorOptions {
  readonly input: ModelSelectorInput;
  readonly output: ModelSelectorOutput;
  readonly color?: boolean;
}

export interface ProviderSelectorOptions extends SelectorOptions {
  readonly initialProvider: ProviderName;
}

export interface ModelChoiceSelectorOptions extends SelectorOptions {
  readonly initialModel?: string;
}

const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";
const MAX_LABEL_CODE_POINTS = 96;

function safeLabel(value: string): string {
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
  return characters.length <= MAX_LABEL_CODE_POINTS
    ? result
    : `${characters.slice(0, MAX_LABEL_CODE_POINTS).join("")}…`;
}

function renderMenu(
  title: string,
  rows: readonly string[],
  selectedIndex: number,
  color: boolean,
): string[] {
  const palette = new Chalk({ level: color ? 1 : 0 });
  const lines = [palette.bold.cyan(title)];
  rows.forEach((row, index) => {
    const selected = index === selectedIndex;
    const text = `${selected ? "›" : " "} ${safeLabel(row)}`;
    lines.push(selected ? palette.bold.white(text) : palette.gray(text));
  });
  lines.push(palette.dim("Use ↑/↓ to move, Enter to confirm, or Esc to cancel"));
  return lines;
}

export function renderProviderSelector(
  choices: readonly ProviderSelectorChoice[],
  selectedIndex: number,
  color = true,
): string[] {
  return renderMenu(
    "Select a provider for EASY CODE",
    choices.map((choice) => {
      const status = choice.apiKeyConfigured ? "API key configured" : "API key required";
      return `${choice.label}  [${status}]`;
    }),
    selectedIndex,
    color,
  );
}

export function renderModelSelector(
  providerName: string,
  choices: readonly ModelSelectorChoice[],
  selectedIndex: number,
  color = true,
): string[] {
  return renderMenu(
    `Select a model from ${providerName}`,
    choices.map((choice) => {
      const name = choice.label === choice.id
        ? choice.label
        : `${choice.label}  [${choice.id}]`;
      if (choice.vision === "supported") return `${name}  [vision]`;
      if (choice.vision === "unknown") return `${name}  [vision unverified]`;
      return name;
    }),
    selectedIndex,
    color,
  );
}

export function selectProvider(
  choices: readonly ProviderSelectorChoice[],
  options: ProviderSelectorOptions,
): Promise<ProviderName | undefined> {
  const initialIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.provider === options.initialProvider),
  );
  return selectIndex(
    choices.length,
    initialIndex,
    (selectedIndex) =>
      renderProviderSelector(choices, selectedIndex, options.color ?? true),
    options,
    "No providers are available.",
  ).then((index) => (index === undefined ? undefined : choices[index]?.provider));
}

export function selectModel(
  providerName: string,
  choices: readonly ModelSelectorChoice[],
  options: ModelChoiceSelectorOptions,
): Promise<string | undefined> {
  const normalizedInitial = options.initialModel?.toLowerCase();
  const initialIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.id.toLowerCase() === normalizedInitial),
  );
  return selectIndex(
    choices.length,
    initialIndex,
    (selectedIndex) =>
      renderModelSelector(providerName, choices, selectedIndex, options.color ?? true),
    options,
    `No models are available for ${providerName}.`,
  ).then((index) => (index === undefined ? undefined : choices[index]?.id));
}

function selectIndex(
  choiceCount: number,
  initialIndex: number,
  renderLines: (selectedIndex: number) => string[],
  options: SelectorOptions,
  emptyMessage: string,
): Promise<number | undefined> {
  if (choiceCount === 0) throw new Error(emptyMessage);
  if (!options.input.isTTY || !options.output.isTTY || typeof options.input.setRawMode !== "function") {
    throw new Error("Model selection requires an interactive TTY.");
  }

  let selectedIndex = Math.max(0, Math.min(initialIndex, choiceCount - 1));
  const lineCount = choiceCount + 2;
  let rendered = false;

  const render = (): void => {
    const lines = renderLines(selectedIndex);
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
    const wasFlowing = input.readableFlowing === true;
    let settled = false;
    let escapeState: "none" | "start" | "control" = "none";
    let escapeTimer: ReturnType<typeof setTimeout> | undefined;

    const clearEscapeTimer = (): void => {
      if (escapeTimer) clearTimeout(escapeTimer);
      escapeTimer = undefined;
    };
    const cleanup = (): void => {
      clearEscapeTimer();
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onClose);
      input.removeListener("error", onError);
      try {
        input.setRawMode?.(wasRaw);
      } catch {
        // The terminal may have disappeared while the selector was active.
      }
      if (wasFlowing) input.resume();
      else input.pause();
      try {
        options.output.write(`${SHOW_CURSOR}\n`);
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
    const startEscapeTimer = (): void => {
      clearEscapeTimer();
      escapeTimer = setTimeout(() => finish(undefined), 60);
      escapeTimer.unref?.();
    };
    const move = (offset: number): void => {
      selectedIndex = (selectedIndex + offset + choiceCount) % choiceCount;
      render();
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const character of text) {
        if (escapeState === "start") {
          clearEscapeTimer();
          if (character === "[" || character === "O") {
            escapeState = "control";
          } else {
            escapeState = "none";
          }
          continue;
        }
        if (escapeState === "control") {
          if (character >= "@" && character <= "~") {
            escapeState = "none";
            if (character === "A") move(-1);
            if (character === "B") move(1);
          }
          continue;
        }
        if (character === "\u001B") {
          escapeState = "start";
          startEscapeTimer();
          continue;
        }
        if (character === "\u0003") {
          finish(undefined);
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(selectedIndex);
          return;
        }
      }
    };
    const onEnd = (): void => finish(undefined);
    const onClose = (): void => finish(undefined);
    const onError = (): void => finish(undefined, new Error("Unable to read the model selection."));

    try {
      options.output.write(HIDE_CURSOR);
      render();
      input.setRawMode?.(true);
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("close", onClose);
      input.once("error", onError);
      input.resume();
    } catch {
      finish(undefined, new Error("Unable to start the model selection."));
    }
  });
}
