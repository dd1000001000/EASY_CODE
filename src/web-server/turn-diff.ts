import type { TurnDiffHunk, TurnFileDiff } from "../ui/contracts.js";

/** Bounds for a diff read back from the journal, matching what a summary saves. */
const MAX_HUNKS = 400;
const MAX_LINES = 400;

/** The same diff with every line passed through `clean` (control characters, secrets); the prefix is kept. */
export function safeDiff(diff: Readonly<TurnFileDiff>, clean: (text: string) => string): TurnFileDiff {
  return {
    truncated: diff.truncated,
    hunks: diff.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      lines: hunk.lines.map((line) => line.slice(0, 1) + clean(line.slice(1)).replace(/\n/gu, " ")),
    })),
  };
}

function isLine(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith(" ") || value.startsWith("+") || value.startsWith("-"));
}

/** A recorded diff, or undefined when the value is not one. */
export function parseTurnDiff(value: unknown): TurnFileDiff | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { hunks, truncated } = value as { hunks?: unknown; truncated?: unknown };
  if (!Array.isArray(hunks) || hunks.length > MAX_HUNKS) return undefined;
  const parsed: TurnDiffHunk[] = [];
  let total = 0;
  for (const hunk of hunks) {
    if (hunk === null || typeof hunk !== "object") return undefined;
    const { oldStart, newStart, lines } = hunk as { oldStart?: unknown; newStart?: unknown; lines?: unknown };
    if (!Number.isInteger(oldStart) || !Number.isInteger(newStart) || !Array.isArray(lines)) return undefined;
    if (!lines.every(isLine)) return undefined;
    total += lines.length;
    if (total > MAX_LINES) return undefined;
    parsed.push({ oldStart: oldStart as number, newStart: newStart as number, lines });
  }
  return { hunks: parsed, truncated: truncated === true };
}
