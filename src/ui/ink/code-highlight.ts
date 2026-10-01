import { Chalk, supportsColor, type ChalkInstance } from "chalk";

import {
  CODE_THEMES,
  codeThemeForeground,
  codeTokensIfReady,
  resolveCodeLanguage,
  type CodeThemeName,
} from "../../highlight/shiki.js";

export type CodeColorLevel = 0 | 1 | 2 | 3;

export interface CodeStyle {
  /** 3 is 24-bit colour; chalk maps the theme's colours down to 256 or 16 for lower levels. */
  readonly level: CodeColorLevel;
  readonly theme: CodeThemeName;
}

// Shiki's FontStyle bit flags.
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;
const STRIKETHROUGH = 8;

const palettes = new Map<CodeColorLevel, ChalkInstance>();

function paletteFor(level: CodeColorLevel): ChalkInstance {
  let palette = palettes.get(level);
  if (!palette) palettes.set(level, (palette = new Chalk({ level })));
  return palette;
}

/** The richest colour the terminal supports, or none when colour is off (for example under NO_COLOR). */
export function codeColorLevel(color: boolean): CodeColorLevel {
  if (!color) return 0;
  return supportsColor ? (Math.max(1, supportsColor.level) as CodeColorLevel) : 1;
}

/**
 * github-dark unless `EASY_CODE_CODE_THEME` names another theme, or the
 * terminal reports a light background through `COLORFGBG` (`fg;bg`, where 7
 * and 15 are white).
 */
export function terminalCodeTheme(env: NodeJS.ProcessEnv = process.env): CodeThemeName {
  const chosen = env.EASY_CODE_CODE_THEME?.trim().toLowerCase();
  if (chosen && (CODE_THEMES as readonly string[]).includes(chosen)) return chosen as CodeThemeName;
  const background = env.COLORFGBG?.split(";").at(-1);
  return background === "7" || background === "15" ? "github-light" : "github-dark";
}

/** The style for code blocks in this terminal. */
export function terminalCodeStyle(color: boolean): CodeStyle {
  return { level: codeColorLevel(color), theme: terminalCodeTheme() };
}

/**
 * Colour a fenced code block by its info-string language with the theme's own
 * colours. Text in the theme's default colour keeps the terminal foreground.
 * Code without a supported language, or whose grammar is still loading,
 * keeps the plain yellow used for every block before.
 */
export function highlightCode(code: string, info: string | undefined, style: CodeStyle): string {
  const palette = paletteFor(style.level);
  const language = resolveCodeLanguage(info);
  const lines = style.level > 0 && language ? codeTokensIfReady(code, language, style.theme) : undefined;
  if (!lines) return palette.yellow(code);
  const foreground = codeThemeForeground(style.theme)?.toLowerCase();
  return lines
    .map((tokens) =>
      tokens
        .map((token) => {
          let paint: ChalkInstance | undefined;
          const color = token.color?.slice(0, 7);
          if (color && color.toLowerCase() !== foreground) paint = palette.hex(color);
          const font = token.fontStyle ?? 0;
          if (font > 0) {
            paint ??= palette;
            if (font & BOLD) paint = paint.bold;
            if (font & ITALIC) paint = paint.italic;
            if (font & UNDERLINE) paint = paint.underline;
            if (font & STRIKETHROUGH) paint = paint.strikethrough;
          }
          return paint ? paint(token.content) : token.content;
        })
        .join(""),
    )
    .join("\n");
}
