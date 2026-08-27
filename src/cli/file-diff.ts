import { Chalk } from "chalk";
import {
  structuredPatch,
  type Hunk,
  type ParsedDiff,
} from "diff";

import type { FileDiffPresentation } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_RENDERED_LINES = 400;
const MAX_EDIT_LENGTH = 10_000;
const MAX_RENDERED_LINE_CHARS = 500;

export interface FileDiffRenderOptions {
  color?: boolean;
  contextLines?: number;
  maxLines?: number;
}

interface DiffRow {
  marker: " " | "+" | "-" | "\\";
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface SensitiveLineMap {
  before: ReadonlySet<number>;
  after: ReadonlySet<number>;
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/** Escape untrusted source text before applying EASY CODE's own ANSI styling. */
export function sanitizeDiffText(value: string): string {
  const redacted = redactSensitiveInformation(value);
  let output = "";
  for (const character of redacted) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\t") {
      output += "    ";
    } else if (isUnsafeTerminalCodePoint(codePoint)) {
      output += `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
    } else {
      output += character;
    }
    if (output.length > MAX_RENDERED_LINE_CHARS) {
      return `${output.slice(0, MAX_RENDERED_LINE_CHARS)}… [line truncated]`;
    }
  }
  return output;
}

function rowFromPatchLine(
  line: string,
  oldLine: number,
  newLine: number,
): { row: DiffRow; nextOldLine: number; nextNewLine: number } {
  const rawMarker = line[0];
  const marker: DiffRow["marker"] =
    rawMarker === "+" || rawMarker === "-" || rawMarker === "\\"
      ? rawMarker
      : " ";
  const text = marker === " " && rawMarker !== " " ? line : line.slice(1);

  if (marker === "-") {
    return {
      row: { marker, oldLine, text },
      nextOldLine: oldLine + 1,
      nextNewLine: newLine,
    };
  }
  if (marker === "+") {
    return {
      row: { marker, newLine, text },
      nextOldLine: oldLine,
      nextNewLine: newLine + 1,
    };
  }
  if (marker === "\\") {
    return {
      row: { marker, text: line.slice(1).trimStart() },
      nextOldLine: oldLine,
      nextNewLine: newLine,
    };
  }
  return {
    row: { marker, oldLine, newLine, text },
    nextOldLine: oldLine + 1,
    nextNewLine: newLine + 1,
  };
}

function rowsForHunk(hunk: Hunk): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.lines) {
    const parsed = rowFromPatchLine(line, oldLine, newLine);
    rows.push(parsed.row);
    oldLine = parsed.nextOldLine;
    newLine = parsed.nextNewLine;
  }
  return rows;
}

function splitContentLines(value: string): string[] {
  if (!value) return [];
  const normalized = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function privateKeyLineNumbers(value: string): Set<number> {
  const sensitive = new Set<number>();
  let insidePrivateKey = false;
  for (const [index, line] of splitContentLines(value).entries()) {
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu.test(line)) {
      insidePrivateKey = true;
    }
    if (insidePrivateKey) sensitive.add(index + 1);
    if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/iu.test(line)) {
      insidePrivateKey = false;
    }
  }
  return sensitive;
}

function formatRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function formatLineNumber(value: number | undefined, width: number): string {
  return (value === undefined ? "" : String(value)).padStart(width, " ");
}

function renderRow(
  row: DiffRow,
  width: number,
  palette: InstanceType<typeof Chalk>,
  sensitiveLines: SensitiveLineMap,
): string {
  const oldNumber = formatLineNumber(row.oldLine, width);
  const newNumber = formatLineNumber(row.newLine, width);
  const containsPrivateKeyMaterial =
    (row.oldLine !== undefined && sensitiveLines.before.has(row.oldLine)) ||
    (row.newLine !== undefined && sensitiveLines.after.has(row.newLine));
  const safeText = containsPrivateKeyMaterial
    ? "[REDACTED PRIVATE KEY MATERIAL]"
    : sanitizeDiffText(row.text);
  const line = `${oldNumber} ${newNumber} │ ${row.marker} ${safeText}\n`;
  if (row.marker === "+") return palette.green(line);
  if (row.marker === "-") return palette.red(line);
  if (row.marker === "\\") return palette.dim(line);
  return line;
}

function lineNumberWidth(presentation: FileDiffPresentation): number {
  const oldCount = splitContentLines(presentation.before).length;
  const newCount = splitContentLines(presentation.after).length;
  return Math.max(3, String(Math.max(oldCount, newCount, 1)).length);
}

function renderFallback(
  presentation: FileDiffPresentation,
  palette: InstanceType<typeof Chalk>,
  maxLines: number,
  sensitiveLines: SensitiveLineMap,
): string {
  const before = splitContentLines(presentation.before);
  const after = splitContentLines(presentation.after);
  const width = lineNumberWidth(presentation);
  const oldBudget = Math.min(before.length, Math.ceil(maxLines / 2));
  const newBudget = Math.min(after.length, maxLines - oldBudget);
  let output = palette.yellow(
    "Diff exceeds the safe computation limit; showing a bounded summary of removed and added content.\n",
  );
  for (let index = 0; index < oldBudget; index += 1) {
    output += renderRow(
      { marker: "-", oldLine: index + 1, text: before[index] ?? "" },
      width,
      palette,
      sensitiveLines,
    );
  }
  for (let index = 0; index < newBudget; index += 1) {
    output += renderRow(
      { marker: "+", newLine: index + 1, text: after[index] ?? "" },
      width,
      palette,
      sensitiveLines,
    );
  }
  const omitted = before.length + after.length - oldBudget - newBudget;
  if (omitted > 0) {
    output += palette.yellow(`… ${omitted} lines omitted; use read_file to view the complete file.\n`);
  }
  return output;
}

export function renderFileDiff(
  presentation: FileDiffPresentation,
  options: FileDiffRenderOptions = {},
): string {
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const context = Math.max(0, Math.min(options.contextLines ?? DEFAULT_CONTEXT_LINES, 20));
  const maxLines = Math.max(1, Math.min(options.maxLines ?? DEFAULT_MAX_RENDERED_LINES, 2_000));
  const safePath = sanitizeDiffText(presentation.path);
  const sensitiveLines: SensitiveLineMap = {
    before: privateKeyLineNumbers(presentation.before),
    after: privateKeyLineNumbers(presentation.after),
  };
  let output = palette.bold(`\nFile changed: ${safePath}\n`);

  if (presentation.before === "" && presentation.after === "") {
    const description = presentation.operation === "delete"
      ? "[Empty file deleted]"
      : presentation.operation === "update"
        ? "[Empty file unchanged]"
        : "[Empty file created]";
    return output + palette.dim(`${description}\n\n`);
  }

  let patch: ParsedDiff | undefined;
  try {
    patch = structuredPatch(
      presentation.path,
      presentation.path,
      presentation.before,
      presentation.after,
      "before",
      "after",
      { context, maxEditLength: MAX_EDIT_LENGTH },
    ) as ParsedDiff | undefined;
  } catch {
    patch = undefined;
  }

  const width = lineNumberWidth(presentation);
  output += palette.dim(`${"old".padStart(width)} ${"new".padStart(width)} │ code\n`);
  output += palette.dim(`${"─".repeat(width)} ${"─".repeat(width)} ┼ ${"─".repeat(24)}\n`);

  if (!patch) {
    return `${output}${renderFallback(presentation, palette, maxLines, sensitiveLines)}\n`;
  }
  if (patch.hunks.length === 0) {
    return `${output}${palette.dim("Only the final newline or line separators changed.\n")}\n`;
  }

  const totalRows = patch.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  let renderedRows = 0;
  outer: for (const hunk of patch.hunks) {
    output += palette.dim(
      `@@ -${formatRange(hunk.oldStart, hunk.oldLines)} +${formatRange(hunk.newStart, hunk.newLines)} @@\n`,
    );
    for (const row of rowsForHunk(hunk)) {
      if (renderedRows >= maxLines) break outer;
      output += renderRow(row, width, palette, sensitiveLines);
      renderedRows += 1;
    }
  }

  if (renderedRows < totalRows) {
    output += palette.yellow(
      `… Diff truncated; ${totalRows - renderedRows} lines omitted. Use read_file to view the complete file.\n`,
    );
  }
  return `${output}\n`;
}
