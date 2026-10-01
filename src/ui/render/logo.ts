import { Chalk } from "chalk";

/**
 * EASY CODE origami-dog icon as 11×10 pixel art, drawn from
 * `src/web/public/easy-code-icon.svg`. A half-block pixel is about 1.1× as
 * tall as it is wide in common terminal fonts, so 11 columns by 10 pixel rows
 * renders close to square. `.` is transparent, `b` is the blue tile (a
 * diagonal gradient, like the SVG), and every other letter is a fixed brand
 * color.
 */
const LOGO_PIXELS = [
  ".bbbbbbbbb.",
  "bbbbWbbbbbb",
  "bbbWDWbbbbb",
  "bbbDDWWWbbb",
  "bbWWLWWDWbb",
  "bbLLLWWWWDb",
  "bbLLLWWWbbb",
  "bbLCCCWbbbb",
  "bbbbbbbbbbb",
  ".bbbbbbbbb.",
] as const;

const LOGO_COLORS: Readonly<Record<string, readonly [number, number, number]>> = {
  W: [0xff, 0xff, 0xff],
  D: [0x18, 0x3b, 0x7d],
  L: [0xdd, 0xee, 0xff],
  C: [0x74, 0xd3, 0xf1],
};
const TILE_FROM = [0x42, 0x7a, 0xe1] as const;
const TILE_TO = [0x24, 0x50, 0xad] as const;

/** Terminal columns occupied by every rendered logo row. */
export const LOGO_COLUMNS = LOGO_PIXELS[0].length;
/** Terminal rows occupied by the rendered logo (two pixels per row). */
export const LOGO_ROWS = LOGO_PIXELS.length / 2;

type Rgb = readonly [number, number, number];

function pixel(row: number, column: number): Rgb | undefined {
  const code = LOGO_PIXELS[row]?.[column];
  if (code === undefined || code === ".") return undefined;
  if (code !== "b") return LOGO_COLORS[code];
  const t = (row + column) / (LOGO_PIXELS.length + LOGO_COLUMNS - 2);
  return [0, 1, 2].map((index) => Math.round(TILE_FROM[index]! + (TILE_TO[index]! - TILE_FROM[index]!) * t)) as [
    number,
    number,
    number,
  ];
}

/**
 * Render the logo with half-block cells so each terminal cell carries two
 * square pixels. Returns no rows without color support: the icon is purely
 * decorative and a monochrome block silhouette would only add noise.
 *
 * @param colorLevel chalk color level (0 none, 1 basic, 2 ansi256, 3 truecolor).
 */
export function renderEasyCodeLogo(colorLevel: 0 | 1 | 2 | 3): string[] {
  if (colorLevel === 0) return [];
  const palette = new Chalk({ level: colorLevel });
  const rows: string[] = [];
  for (let row = 0; row < LOGO_PIXELS.length; row += 2) {
    let line = "";
    for (let column = 0; column < LOGO_COLUMNS; column += 1) {
      const top = pixel(row, column);
      const bottom = pixel(row + 1, column);
      if (top && bottom) {
        // Never a full block: transcript checks treat █ as a progress bar.
        line += palette.rgb(...top).bgRgb(...bottom)("▀");
      } else if (top) {
        line += palette.rgb(...top)("▀");
      } else if (bottom) {
        line += palette.rgb(...bottom)("▄");
      } else {
        line += " ";
      }
    }
    rows.push(line);
  }
  return rows;
}
