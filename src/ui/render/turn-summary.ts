import { pathToFileURL } from "node:url";

import { Chalk } from "chalk";

import { formatTokenCount } from "../../cli/token-count.js";
import type { Language } from "../../i18n/language.js";
import type { TurnChangedFile, TurnLineCounts, TurnSummary } from "../contracts.js";
import { formatDuration } from "../duration.js";
import { displayWidth, sanitizeTerminalText, truncateToWidth } from "./layout.js";

export { formatDuration };

export interface TurnSummaryRenderOptions {
  readonly language: Language;
  readonly color: boolean;
  readonly columns: number;
  /** Wrap file names in OSC 8 hyperlinks (terminals open them on Ctrl/Cmd+click). */
  readonly links: boolean;
}

/** Files listed under the summary line; the rest are counted. */
const MAX_FILE_ROWS = 8;
const FILE_INDENT = "    ";

function hyperlink(label: string, target: string): string {
  return `\u001B]8;;${target}\u0007${label}\u001B]8;;\u0007`;
}

function fileLabel(file: TurnChangedFile, zh: boolean): string {
  const name = sanitizeTerminalText(file.path, { allowSgr: false }).replace(/\\/gu, "/");
  return file.change === "deleted" ? `${name} ${zh ? "(已删除)" : "(deleted)"}` : name;
}

/** Keep the end of a path, where the file name is, within `columns`. */
function keepEnd(value: string, columns: number): string {
  if (displayWidth(value) <= columns) return value;
  const characters = Array.from(value);
  let kept = "";
  let width = 1;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const next = displayWidth(characters[index]!);
    if (width + next > columns) break;
    kept = characters[index] + kept;
    width += next;
  }
  return `…${kept}`;
}

function lineCounts(lines: TurnLineCounts, palette: InstanceType<typeof Chalk>): { text: string; width: number } {
  const added = `+${lines.added}`;
  const removed = `-${lines.removed}`;
  return { text: `${palette.green(added)} ${palette.red(removed)}`, width: added.length + 1 + removed.length };
}

/**
 * The gray block after a completed request: one line with how long it took,
 * the tokens the provider reported and how many files changed, then a row per
 * file with its added and removed lines when they are known. Rows never wrap;
 * long paths keep their end. Existing files link to themselves.
 */
export function renderTurnSummary(summary: Readonly<TurnSummary>, options: TurnSummaryRenderOptions): string {
  const zh = options.language === "zh_cn";
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const parts = [zh ? `用时 ${formatDuration(summary.durationMs)}` : `took ${formatDuration(summary.durationMs)}`];
  if (summary.inputTokens !== undefined && summary.outputTokens !== undefined) {
    parts.push(`↑ ${formatTokenCount(summary.inputTokens)} ↓ ${formatTokenCount(summary.outputTokens)} tokens`);
  }
  const files = summary.changedFiles;
  if (files.length === 0) return palette.gray(`  ${parts.join(" · ")}`);

  parts.push(zh ? `改动 ${files.length} 个文件` : `${files.length} file${files.length === 1 ? "" : "s"} changed`);
  const counted = files.flatMap((file) => (file.lines ? [file.lines] : []));
  const total = counted.reduce(
    (sum, lines) => ({ added: sum.added + lines.added, removed: sum.removed + lines.removed }),
    {
      added: 0,
      removed: 0,
    },
  );
  const head =
    palette.gray(`  ${parts.join(" · ")}`) + (counted.length > 0 ? ` ${lineCounts(total, palette).text}` : "");

  const shown = files.length > MAX_FILE_ROWS ? files.slice(0, MAX_FILE_ROWS - 1) : files;
  const counts = shown.map((file) => (file.lines ? lineCounts(file.lines, palette) : undefined));
  const countWidth = Math.max(0, ...counts.map((count) => count?.width ?? 0));
  // Names share one column so the counts line up; a name too wide for the row keeps its end.
  const nameWidth = Math.max(1, options.columns - FILE_INDENT.length - (countWidth > 0 ? countWidth + 2 : 0));
  const labels = shown.map((file) => keepEnd(fileLabel(file, zh), nameWidth));
  const column = Math.min(nameWidth, Math.max(...labels.map(displayWidth)));
  const rows = shown.map((file, index) => {
    const label = labels[index]!;
    const name =
      options.links && file.change !== "deleted" ? hyperlink(label, pathToFileURL(file.absolutePath).href) : label;
    const count = counts[index];
    if (!count) return palette.gray(`${FILE_INDENT}${name}`);
    return `${palette.gray(`${FILE_INDENT}${name}${" ".repeat(column - displayWidth(label) + 2)}`)}${count.text}`;
  });
  const hidden = files.length - shown.length;
  if (hidden > 0) rows.push(palette.gray(`${FILE_INDENT}${zh ? `等 ${hidden} 个文件` : `+${hidden} more`}`));
  return [truncateToWidth(head, options.columns), ...rows].join("\n");
}
