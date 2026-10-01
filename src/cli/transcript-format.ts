import { Chalk, type ChalkInstance } from "chalk";

import type { ToolDisplayDetail } from "../core/types.js";

/** Leading glyph of every assistant answer and tool call in the transcript. */
export const TRANSCRIPT_BULLET = "●";
/** Leading glyph of a tool call's result rows. */
export const TRANSCRIPT_RESULT = "⎿";

function palette(color: boolean): ChalkInstance {
  return new Chalk({ level: color ? 1 : 0 });
}

/** Indent every row after the first so a multi-line body stays under its gutter. */
function underGutter(lines: readonly string[], indent: string): string {
  return lines.map((line, index) => (index === 0 || !line ? line : `${indent}${line}`)).join("\n");
}

/** `● answer`, with later rows indented under the text rather than the bullet. */
export function formatAssistantText(text: string, color: boolean): string {
  return `${palette(color).cyan(TRANSCRIPT_BULLET)} ${underGutter(text.split("\n"), "  ")}`;
}

export interface ToolTranscriptInput {
  readonly name: string;
  readonly ok: boolean;
  /** Already sanitized; may be multi-line. */
  readonly summary?: string;
  /** Already sanitized; shown only for a failed call. */
  readonly error?: string;
  /** Already sanitized single-line target, e.g. a file path or command. */
  readonly target?: string;
  readonly color: boolean;
}

/**
 * Render one completed tool call:
 *
 * ```
 * ● read_file(src/index.ts)
 *   ⎿  Read 120 lines.
 * ```
 *
 * The complete summary is kept (it is the only durable copy in scrollback);
 * continuation rows align under the first result row.
 */
export function formatToolTranscript(input: Readonly<ToolTranscriptInput>): string {
  const chalk = palette(input.color);
  const bullet = input.ok ? chalk.green(TRANSCRIPT_BULLET) : chalk.red(TRANSCRIPT_BULLET);
  const target = input.target ? `${chalk.gray("(")}${input.target}${chalk.gray(")")}` : "";
  const rows = [`${bullet} ${chalk.bold(input.name)}${target}`];
  const result = [
    ...(input.summary ? input.summary.split("\n") : []),
    ...(!input.ok && input.error ? input.error.split("\n").map((line) => chalk.red(line)) : []),
  ];
  if (result.length > 0) {
    rows.push(`  ${chalk.gray(TRANSCRIPT_RESULT)}  ${underGutter(result, "     ")}`);
  }
  return rows.join("\n");
}

/** Single-line call target built from the tool's human-readable display details. */
export function toolTarget(details: readonly ToolDisplayDetail[] | undefined): string | undefined {
  const values = (details ?? []).map((detail) => detail.value.replace(/\s+/gu, " ").trim()).filter(Boolean);
  return values.length > 0 ? values.join(" · ") : undefined;
}
