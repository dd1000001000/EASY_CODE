import type { TurnFileDiff } from "../ui/contracts.js";

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
