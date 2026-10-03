import { Chalk, type ChalkInstance } from "chalk";

import { formatTokenCount } from "../../cli/token-count.js";
import { translate, type MessageKey } from "../../i18n/catalog.js";
import type { Language } from "../../i18n/language.js";
import { contextUsageRows, formatShare, type ContextUsageRowId } from "../context-usage.js";
import type { ContextUsageReport } from "../contracts.js";
import { displayWidth } from "./layout.js";

export interface ContextUsageRenderOptions {
  readonly language: Language;
  readonly color: boolean;
  readonly columns: number;
}

const MAX_BAR_CELLS = 40;

function paint(palette: ChalkInstance, id: ContextUsageRowId): (text: string) => string {
  switch (id) {
    case "messages":
      return palette.blue;
    case "systemPrompt":
      return palette.yellow;
    case "systemTools":
      return palette.cyan;
    case "mcpTools":
      return palette.red;
    case "skills":
      return palette.green;
    case "instructions":
      return palette.magenta;
    case "memory":
      return palette.magentaBright;
    case "runtimeContext":
      return palette.white;
    case "reserved":
    case "free":
      return palette.gray;
  }
}

/**
 * The context window as one bar split by what uses it, then a row per part
 * with its tokens and share of the window, like `/context` shows it.
 */
export function renderContextUsage(report: Readonly<ContextUsageReport>, options: ContextUsageRenderOptions): string {
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const text = (key: MessageKey, params?: Readonly<Record<string, string | number>>) =>
    translate(options.language, key, params);
  const { used, rows } = contextUsageRows(report);
  const window = Math.max(1, report.windowTokens);
  const head = `${palette.bold(text("ui.contextWindow"))}  ${formatTokenCount(used)} / ${formatTokenCount(report.windowTokens)} (${Math.round((used / window) * 100)}%)`;

  // Every part in use keeps at least one cell; the largest give cells back when
  // the bar overflows, and the free space takes what is left.
  const cells = Math.max(10, Math.min(MAX_BAR_CELLS, options.columns - 4));
  const drawn = rows.filter((row) => row.id !== "free" && row.tokens > 0);
  const widths = drawn.map((row) => Math.max(1, Math.round((row.tokens / window) * cells)));
  for (let total = widths.reduce((sum, width) => sum + width, 0); total > cells; total -= 1) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 1) break;
    widths[widest] = widths[widest]! - 1;
  }
  let bar = drawn
    .map((row, index) => paint(palette, row.id)((row.id === "reserved" ? "▒" : "█").repeat(widths[index]!)))
    .join("");
  const free = cells - widths.reduce((sum, width) => sum + width, 0);
  if (free > 0) bar += palette.gray("░".repeat(free));

  const labels = rows.map((row) => text(row.label));
  const labelWidth = Math.max(...labels.map(displayWidth));
  const tokens = rows.map((row) => formatTokenCount(row.tokens));
  const tokenWidth = Math.max(...tokens.map((value) => value.length));
  const lines = rows.map((row, index) => {
    const label = labels[index]!;
    const swatch = paint(palette, row.id)(row.id === "free" ? "□" : row.id === "reserved" ? "▒" : "■");
    return `  ${swatch} ${label}${" ".repeat(labelWidth - displayWidth(label))}  ${tokens[index]!.padStart(tokenWidth)}  ${formatShare(row.ratio).padStart(6)}`;
  });
  const notes = [text("ui.contextCompactsAt", { tokens: formatTokenCount(report.compactionTokens) })];
  if (!report.measured) notes.push(text("ui.contextNotMeasured"));
  return [head, `  ${bar}`, ...lines, ...notes.map((note) => palette.gray(`  ${note}`))].join("\n");
}
