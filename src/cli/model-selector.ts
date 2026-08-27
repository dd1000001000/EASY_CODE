import { StringDecoder } from "node:string_decoder";

import { Chalk } from "chalk";

import type { ProviderName } from "../core/types.js";

export interface StartupModelChoice {
  provider: ProviderName;
  model: string;
  apiKeyConfigured: boolean;
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

export interface ModelSelectorOptions {
  input: ModelSelectorInput;
  output: ModelSelectorOutput;
  initialProvider: ProviderName;
  color?: boolean;
}

const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";
const MAX_MODEL_LABEL_CODE_POINTS = 96;

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
  return characters.length <= MAX_MODEL_LABEL_CODE_POINTS
    ? result
    : `${characters.slice(0, MAX_MODEL_LABEL_CODE_POINTS).join("")}…`;
}

function providerLabel(provider: ProviderName): string {
  return provider === "qwen" ? "Qwen" : "DeepSeek";
}

export function renderStartupModelSelector(
  choices: readonly StartupModelChoice[],
  selectedIndex: number,
  color = true,
): string[] {
  const palette = new Chalk({ level: color ? 1 : 0 });
  const lines = [palette.bold.cyan("请选择 EASY CODE 使用的模型")];
  choices.forEach((choice, index) => {
    const selected = index === selectedIndex;
    const marker = selected ? "›" : " ";
    const status = choice.apiKeyConfigured ? "API Key 已配置" : "需要 API Key";
    const text = `${marker} ${providerLabel(choice.provider)} / ${safeLabel(choice.model)}  [${status}]`;
    lines.push(selected ? palette.bold.white(text) : palette.gray(text));
  });
  lines.push(palette.dim("使用 ↑/↓ 切换，Enter 确认，Esc 取消"));
  return lines;
}

export function selectStartupModel(
  choices: readonly StartupModelChoice[],
  options: ModelSelectorOptions,
): Promise<ProviderName | undefined> {
  if (choices.length === 0) throw new Error("No startup models are available.");
  if (!options.input.isTTY || !options.output.isTTY || typeof options.input.setRawMode !== "function") {
    throw new Error("The startup model selector requires an interactive TTY.");
  }

  let selectedIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.provider === options.initialProvider),
  );
  const lineCount = choices.length + 2;
  let rendered = false;

  const render = (): void => {
    const lines = renderStartupModelSelector(choices, selectedIndex, options.color ?? true);
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
    const finish = (provider?: ProviderName, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(provider);
    };
    const startEscapeTimer = (): void => {
      clearEscapeTimer();
      escapeTimer = setTimeout(() => finish(undefined), 60);
      escapeTimer.unref?.();
    };
    const move = (offset: number): void => {
      selectedIndex = (selectedIndex + offset + choices.length) % choices.length;
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
          finish(choices[selectedIndex]?.provider);
          return;
        }
      }
    };
    const onEnd = (): void => finish(undefined);
    const onClose = (): void => finish(undefined);
    const onError = (): void => finish(undefined, new Error("Unable to read the startup model selection."));

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
      finish(undefined, new Error("Unable to start the model selector."));
    }
  });
}
