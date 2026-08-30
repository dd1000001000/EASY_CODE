import { Chalk } from "chalk";

import {
  sanitizeCommandOutput,
  stripTerminalControls,
} from "../command/output-stream.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";

const DEFAULT_MAX_REASONING_CHARS = 12_000;
const DEFAULT_MAX_REASONING_LINES = 120;
const DEFAULT_MAX_REASONING_LINE_CHARS = 1_000;
const DEFAULT_REASONING_PREVIEW_CHARS = 160;
const MAX_RETAINED_REASONING_BLOCKS = 256;

export interface ReasoningRenderLimits {
  readonly maxChars?: number;
  readonly maxLines?: number;
  readonly maxLineChars?: number;
}

export interface ReasoningBlock {
  readonly id: number;
  readonly text: string;
  readonly sourceChars: number;
  readonly sourceLines: number;
  readonly truncated: boolean;
}

export interface ReasoningRenderOptions {
  readonly color?: boolean;
  readonly previewChars?: number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), maximum));
}

function countText(value: string): { chars: number; lines: number } {
  let chars = 0;
  let lines = value ? 1 : 0;
  for (const character of value) {
    chars += 1;
    if (character === "\n") lines += 1;
  }
  return { chars, lines };
}

function takeCodePoints(
  value: string,
  maximum: number,
): { text: string; truncated: boolean } {
  let count = 0;
  let end = 0;
  for (const character of value) {
    if (count === maximum) {
      return { text: value.slice(0, end), truncated: true };
    }
    count += 1;
    end += character.length;
  }
  return { text: value, truncated: false };
}

/** Prepare an untrusted provider reasoning field for bounded terminal display. */
export function prepareReasoningText(
  value: string,
  limits: ReasoningRenderLimits = {},
): Omit<ReasoningBlock, "id"> {
  const maxChars = boundedInteger(
    limits.maxChars,
    DEFAULT_MAX_REASONING_CHARS,
    100_000,
  );
  const maxLines = boundedInteger(
    limits.maxLines,
    DEFAULT_MAX_REASONING_LINES,
    2_000,
  );
  const maxLineChars = boundedInteger(
    limits.maxLineChars,
    DEFAULT_MAX_REASONING_LINE_CHARS,
    10_000,
  );
  const normalized = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const source = countText(normalized);
  // Strip terminal controls before the second, broader redaction pass. This
  // prevents an untrusted provider from inserting ANSI, zero-width, bidi, or
  // C0/C1 bytes inside a secret so it evades pattern matching.
  const safe = redactSensitiveInformation(
    sanitizeCommandOutput(stripTerminalControls(normalized)),
  ).replace(/\t/gu, "    ");
  // A split limit prevents a provider response with millions of newlines from
  // allocating a correspondingly large array before the display is bounded.
  const candidateLines = safe.split("\n", maxLines + 1);
  let truncated = candidateLines.length > maxLines;
  const retainedLines = candidateLines.slice(0, maxLines).map((line) => {
    const retained = takeCodePoints(line, maxLineChars);
    if (!retained.truncated) return retained.text;
    truncated = true;
    return `${retained.text}… [line truncated]`;
  });
  let text = retainedLines.join("\n").trim();
  const retainedText = takeCodePoints(text, maxChars);
  if (retainedText.truncated) {
    text = `${retainedText.text}…`;
    truncated = true;
  }
  return {
    text,
    sourceChars: source.chars,
    sourceLines: source.lines,
    truncated,
  };
}

/** Bounded in-process registry; IDs remain monotonic even after clear(). */
export class ReasoningRegistry {
  private readonly blocks = new Map<number, ReasoningBlock>();
  private nextId = 1;
  private latestId?: number;

  constructor(private readonly limits: ReasoningRenderLimits = {}) {}

  add(value: string): ReasoningBlock {
    if (!Number.isSafeInteger(this.nextId)) {
      throw new Error("Thinking block ID space is exhausted");
    }
    const block: ReasoningBlock = {
      id: this.nextId,
      ...prepareReasoningText(value, this.limits),
    };
    this.nextId += 1;
    this.latestId = block.id;
    this.blocks.set(block.id, block);
    while (this.blocks.size > MAX_RETAINED_REASONING_BLOCKS) {
      const oldest = this.blocks.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.blocks.delete(oldest);
    }
    return block;
  }

  get(id: number | "last"): ReasoningBlock | undefined {
    const resolved = id === "last" ? this.latestId : id;
    return resolved === undefined ? undefined : this.blocks.get(resolved);
  }

  /** Recreate stable Thread-local IDs after loading durable message history. */
  rebuild(values: readonly string[]): number {
    this.blocks.clear();
    this.latestId = undefined;
    this.nextId = 1;
    for (const value of values) this.add(value);
    return this.blocks.size;
  }

  clear(): void {
    this.blocks.clear();
    this.latestId = undefined;
  }
}

export function renderReasoningMarker(
  block: ReasoningBlock,
  options: ReasoningRenderOptions = {},
): string {
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const previewLimit = boundedInteger(
    options.previewChars,
    DEFAULT_REASONING_PREVIEW_CHARS,
    2_000,
  );
  const compactText = block.text.replace(/\s+/gu, " ").trim();
  const retainedPreview = takeCodePoints(compactText, previewLimit);
  const preview = retainedPreview.text || "(No visible Thinking text.)";
  const omitted = retainedPreview.truncated || block.truncated;
  return palette.gray(
    `▶ Thinking #${block.id} · ${block.sourceChars} chars · ` +
      `Ctrl/Cmd+click to toggle · /thinking ${block.id}\n` +
      `  ${preview}${omitted ? "..." : ""}\n`,
  );
}

export function renderReasoningBody(
  block: ReasoningBlock,
  options: ReasoningRenderOptions = {},
): string {
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const content = block.text || "(No thinking text was returned.)";
  const truncation = block.truncated
    ? `\n… [Thinking truncated from ${block.sourceLines} lines / ${block.sourceChars} chars.]`
    : "";
  return palette.gray(
    `\n▼ Thinking #${block.id}\n${content}${truncation}\n▲ End Thinking #${block.id}\n`,
  );
}
