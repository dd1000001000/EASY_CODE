import { Chalk } from "chalk";

import {
  sanitizeCommandOutput,
  stripTerminalControls,
} from "../command/output-stream.js";
import type { ImageAttachment } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { sanitizeTerminalText, wrapToWidth } from "../ui/render/layout.js";

const DEFAULT_ADJUSTMENT_PREVIEW_CHARS = 160;

export interface AdjustmentBlock {
  readonly id: number;
  readonly text: string;
  readonly imageLabels: readonly string[];
  readonly sourceChars: number;
  readonly sourceLines: number;
  readonly truncated: boolean;
}

export interface AdjustmentRenderOptions {
  readonly color?: boolean;
  readonly previewChars?: number;
  readonly columns?: number;
  /** @deprecated Disclosure bodies are never presentation-truncated. */
  readonly maxRows?: number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), maximum));
}

function takeCodePoints(value: string, maximum: number): {
  readonly text: string;
  readonly truncated: boolean;
} {
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

function safeLabel(value: string): string {
  return sanitizeTerminalText(value, { allowSgr: false })
    .replace(/\s+/gu, " ")
    .trim();
}

function prepareAdjustmentText(value: string): {
  readonly text: string;
  readonly sourceChars: number;
  readonly sourceLines: number;
  readonly truncated: false;
} {
  const normalized = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  let sourceChars = 0;
  let sourceLines = normalized ? 1 : 0;
  for (const character of normalized) {
    sourceChars += 1;
    if (character === "\n") sourceLines += 1;
  }
  // Adjustment bodies are user-authored and already bounded by the composer.
  // Retain the complete submitted value for expansion while stripping unsafe
  // terminal controls and redacting credentials before it enters UI state.
  const text = redactSensitiveInformation(
    sanitizeCommandOutput(stripTerminalControls(normalized)),
  ).replace(/\t/gu, "    ");
  return { text, sourceChars, sourceLines, truncated: false };
}

function imageBadges(block: Readonly<AdjustmentBlock>): string {
  return block.imageLabels
    .filter((label) => !block.text.includes(`[${label}]`))
    .map((label) => `[${label}]`)
    .join(" ");
}

function previewWithImageBadges(block: Readonly<AdjustmentBlock>): string {
  const badges = block.imageLabels.map((label) => `[${label}]`).join(" ");
  let text = block.text.replace(/\s+/gu, " ").trim();
  for (const label of block.imageLabels) {
    text = text.replaceAll(`[${label}]`, " ");
  }
  text = text.replace(/\s+/gu, " ").trim();
  return [badges, text].filter(Boolean).join(" ") || "(Empty adjustment.)";
}

function adjustmentSummary(block: Readonly<AdjustmentBlock>): string {
  const imageCount = block.imageLabels.length;
  return `${block.sourceChars} chars` +
    (imageCount > 0 ? ` · ${imageCount} image${imageCount === 1 ? "" : "s"}` : "");
}

/** Process-local display registry. Durable steering remains in ThreadStore. */
export class AdjustmentRegistry {
  private readonly blocks = new Map<number, AdjustmentBlock>();
  private latestId?: number;

  add(
    id: number,
    text: string,
    images: readonly Readonly<ImageAttachment>[] = [],
  ): AdjustmentBlock {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("Adjustment ID must be a positive safe integer");
    }
    const prepared = prepareAdjustmentText(text);
    const block: AdjustmentBlock = {
      id,
      ...prepared,
      imageLabels: images
        .map((image) => safeLabel(image.label))
        .filter((label) => label.length > 0),
    };
    this.blocks.delete(id);
    this.blocks.set(id, block);
    this.latestId = id;
    return block;
  }

  get(id: number | "last"): AdjustmentBlock | undefined {
    const resolved = id === "last" ? this.latestId : id;
    return resolved === undefined ? undefined : this.blocks.get(resolved);
  }

  clear(): void {
    this.blocks.clear();
    this.latestId = undefined;
  }
}

export function renderAdjustmentMarker(
  block: Readonly<AdjustmentBlock>,
  options: AdjustmentRenderOptions = {},
): string {
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const previewLimit = boundedInteger(
    options.previewChars,
    DEFAULT_ADJUSTMENT_PREVIEW_CHARS,
    2_000,
  );
  const content = previewWithImageBadges(block);
  const retained = takeCodePoints(content, previewLimit);
  const omitted = retained.truncated || block.truncated;
  return palette.gray(
    `▶ Queued adjustment #${block.id} · ${adjustmentSummary(block)} · ` +
      `/adjustment ${block.id} · VS Code Ctrl/Cmd+click to toggle\n` +
      `  ${retained.text}${omitted ? "..." : ""}\n`,
  );
}

export function renderAdjustmentHistoryMarker(
  block: Readonly<AdjustmentBlock>,
  options: AdjustmentRenderOptions = {},
): string {
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const previewLimit = boundedInteger(
    options.previewChars,
    DEFAULT_ADJUSTMENT_PREVIEW_CHARS,
    2_000,
  );
  const content = previewWithImageBadges(block);
  const retained = takeCodePoints(content, previewLimit);
  return palette.gray(
    `• Queued adjustment #${block.id} · ${adjustmentSummary(block)} · ` +
      `use /adjustment ${block.id} for retained content\n` +
      `  ${retained.text}${retained.truncated || block.truncated ? "..." : ""}\n`,
  );
}

export function renderAdjustmentPanel(
  block: Readonly<AdjustmentBlock>,
  options: AdjustmentRenderOptions = {},
): string {
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const columns = boundedInteger(options.columns, 80, 10_000);
  const text = block.text || "(No text; this adjustment contains attachments only.)";
  const innerWidth = Math.max(1, columns - 2);
  const wrappedText = wrapToWidth(text, innerWidth, {
    preserveAnsi: false,
  });
  const body = wrappedText
    .map((line) => palette.gray(`  ${line}`));
  const hiddenBadges = block.imageLabels
    .filter((label) => !block.text.includes(`[${label}]`))
    .map((label) => `[${label}]`)
    .join(" ");
  const header = palette.gray(
    `↕ Queued adjustment #${block.id}` +
      `${hiddenBadges ? ` · ${hiddenBadges}` : ""} · ` +
      `/adjustment ${block.id} · ` +
      "VS Code Ctrl/Cmd+click to toggle",
  );
  return [header, ...body].join("\n");
}

export function renderAdjustmentBody(
  block: Readonly<AdjustmentBlock>,
  options: AdjustmentRenderOptions = {},
): string {
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const attachments = imageBadges(block);
  const text = block.text || "(No text; this adjustment contains attachments only.)";
  return palette.gray(
    `\n▼ Queued adjustment #${block.id}\n${text}` +
      `${attachments ? `\nAttachments: ${attachments}` : ""}` +
      `\n▲ End queued adjustment #${block.id}\n`,
  );
}
