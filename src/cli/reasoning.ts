import { Chalk } from "chalk";

import {
  sanitizeCommandOutput,
  stripTerminalControls,
} from "../command/output-stream.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";

const DEFAULT_REASONING_PREVIEW_CHARS = 160;

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

function optionalBoundedInteger(
  value: number | undefined,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
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

/**
 * Prepare an untrusted provider reasoning field for terminal display.
 *
 * The default path deliberately retains the complete sanitized provider value.
 * Optional limits remain available to callers that explicitly need a bounded
 * diagnostic fixture, but presentation defaults must never destroy Thinking
 * content before the user asks to expand or inspect it.
 */
export function prepareReasoningText(
  value: string,
  limits: ReasoningRenderLimits = {},
): Omit<ReasoningBlock, "id"> {
  const maxChars = optionalBoundedInteger(limits.maxChars, 10_000_000);
  const maxLines = optionalBoundedInteger(limits.maxLines, 100_000);
  const maxLineChars = optionalBoundedInteger(limits.maxLineChars, 1_000_000);
  const normalized = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const source = countText(normalized);
  // Strip terminal controls before the second, broader redaction pass. This
  // prevents an untrusted provider from inserting ANSI, zero-width, bidi, or
  // C0/C1 bytes inside a secret so it evades pattern matching.
  const safe = redactSensitiveInformation(
    sanitizeCommandOutput(stripTerminalControls(normalized)),
  ).replace(/\t/gu, "    ");
  const candidateLines = maxLines === undefined
    ? safe.split("\n")
    : safe.split("\n", maxLines + 1);
  let truncated = maxLines !== undefined && candidateLines.length > maxLines;
  const retainedLines = (maxLines === undefined
    ? candidateLines
    : candidateLines.slice(0, maxLines)).map((line) => {
      if (maxLineChars === undefined) return line;
      const retained = takeCodePoints(line, maxLineChars);
      if (!retained.truncated) return retained.text;
      truncated = true;
      return `${retained.text}… [line truncated]`;
    });
  let text = retainedLines.join("\n").trim();
  if (maxChars !== undefined) {
    const retainedText = takeCodePoints(text, maxChars);
    if (retainedText.truncated) {
      text = `${retainedText.text}…`;
      truncated = true;
    }
  }
  return {
    text,
    sourceChars: source.chars,
    sourceLines: source.lines,
    truncated,
  };
}

/** Thread-local registry; IDs remain monotonic even after clear(). */
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
      `/thinking ${block.id} · VS Code Ctrl/Cmd+click to toggle\n` +
      `  ${preview}${omitted ? "..." : ""}\n`,
  );
}

/**
 * Render a completed Thinking item after its turn leaves the redrawable tail.
 * Historical terminal scrollback cannot be rewritten safely, so this variant
 * deliberately avoids the clickable toggle prefix while keeping `/thinking` as
 * an explicit way to inspect the retained body.
 */
export function renderReasoningHistoryMarker(
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
    `• Thinking #${block.id} · ${block.sourceChars} chars · ` +
      `use /thinking ${block.id} for retained content\n` +
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
