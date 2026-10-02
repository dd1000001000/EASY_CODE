import { pathToFileURL } from "node:url";

import { Chalk } from "chalk";

import { formatTokenCount } from "../../cli/token-count.js";
import type { Language } from "../../i18n/language.js";
import type { TurnChangedFile, TurnSummary } from "../contracts.js";
import { formatDuration } from "../duration.js";
import { displayWidth, sanitizeTerminalText } from "./layout.js";

export { formatDuration };

export interface TurnSummaryRenderOptions {
  readonly language: Language;
  readonly color: boolean;
  readonly columns: number;
  /** Wrap file names in OSC 8 hyperlinks (terminals open them on Ctrl/Cmd+click). */
  readonly links: boolean;
}

function hyperlink(label: string, target: string): string {
  return `\u001B]8;;${target}\u0007${label}\u001B]8;;\u0007`;
}

function fileLabel(file: TurnChangedFile, zh: boolean): string {
  const name = sanitizeTerminalText(file.path, { allowSgr: false }).replace(/\\/gu, "/");
  return file.change === "deleted" ? `${name} ${zh ? "(已删除)" : "(deleted)"}` : name;
}

/**
 * The gray line after a completed request: how long it took, the tokens the
 * provider reported, and the files it changed. File names are as many as fit
 * the width, the rest counted; existing files link to themselves.
 */
export function renderTurnSummary(summary: Readonly<TurnSummary>, options: TurnSummaryRenderOptions): string {
  const zh = options.language === "zh_cn";
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const parts = [zh ? `用时 ${formatDuration(summary.durationMs)}` : `took ${formatDuration(summary.durationMs)}`];
  if (summary.inputTokens !== undefined && summary.outputTokens !== undefined) {
    parts.push(`↑ ${formatTokenCount(summary.inputTokens)} ↓ ${formatTokenCount(summary.outputTokens)} tokens`);
  }
  const files = summary.changedFiles;
  if (files.length > 0)
    parts.push(zh ? `改动 ${files.length} 个文件` : `${files.length} file${files.length === 1 ? "" : "s"} changed`);
  const head = `  ${parts.join(" · ")}`;
  if (files.length === 0) return palette.gray(head);

  // Plain widths decide how many names fit; links are added afterwards, as they take no columns.
  const separator = zh ? "、" : ", ";
  let used = displayWidth(head) + displayWidth(zh ? "：" : ": ");
  const shown: TurnChangedFile[] = [];
  for (const [index, file] of files.entries()) {
    const remaining = files.length - index - 1;
    const more = remaining > 0 ? displayWidth(`${separator}${zh ? `等 ${remaining} 个` : `+${remaining} more`}`) : 0;
    const width = (shown.length > 0 ? displayWidth(separator) : 0) + displayWidth(fileLabel(file, zh));
    if (shown.length > 0 && used + width + more > options.columns) break;
    shown.push(file);
    used += width;
  }
  const names = shown.map((file) => {
    const label = fileLabel(file, zh);
    return options.links && file.change !== "deleted" ? hyperlink(label, pathToFileURL(file.absolutePath).href) : label;
  });
  const hidden = files.length - shown.length;
  const tail = hidden > 0 ? `${separator}${zh ? `等 ${hidden} 个` : `+${hidden} more`}` : "";
  return palette.gray(`${head}${zh ? "：" : ": "}${names.join(separator)}${tail}`);
}
