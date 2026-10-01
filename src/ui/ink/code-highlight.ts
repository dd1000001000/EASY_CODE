import type { ChalkInstance } from "chalk";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, grammar] of Object.entries({
  bash,
  c,
  cpp,
  csharp,
  css,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
}))
  hljs.registerLanguage(name, grammar);

/** Larger blocks are shown plain; highlighting them would stall the frame. */
const MAX_HIGHLIGHT_CHARS = 20_000;
const DIFF_LANGUAGES = new Set(["diff", "patch", "udiff"]);

type Paint = (palette: ChalkInstance) => (text: string) => string;

/** highlight.js scopes in the terminal palette; unlisted scopes inherit their parent's colour. */
const SCOPE_PAINT: Readonly<Record<string, Paint>> = {
  keyword: (p) => p.magenta,
  "meta-keyword": (p) => p.magenta,
  "selector-tag": (p) => p.magenta,
  doctag: (p) => p.magenta,
  string: (p) => p.green,
  regexp: (p) => p.green,
  char: (p) => p.green,
  "template-tag": (p) => p.green,
  number: (p) => p.yellow,
  literal: (p) => p.yellow,
  symbol: (p) => p.yellow,
  bullet: (p) => p.yellow,
  title: (p) => p.cyan,
  type: (p) => p.cyan,
  built_in: (p) => p.cyan,
  class: (p) => p.cyan,
  tag: (p) => p.cyan,
  name: (p) => p.cyan,
  section: (p) => p.cyan.bold,
  "selector-id": (p) => p.cyan,
  "selector-class": (p) => p.cyan,
  comment: (p) => p.gray,
  quote: (p) => p.gray,
  meta: (p) => p.gray,
  addition: (p) => p.green,
  deletion: (p) => p.red,
  emphasis: (p) => p.italic,
  strong: (p) => p.bold,
};

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
};

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/gu, (entity) => ENTITIES[entity] ?? entity);
}

/** Turn highlight.js span markup into terminal colours. */
function paintHighlighted(html: string, palette: ChalkInstance): string {
  const stack: (Paint | undefined)[] = [];
  let output = "";
  for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/gu)) {
    if (match[1] !== undefined) {
      const scope = match[1].split(/\s+/u)[0]!.replace(/^hljs-/u, "");
      stack.push(SCOPE_PAINT[scope]);
    } else if (match[2] !== undefined) {
      const text = decode(match[2]);
      let paint: Paint | undefined;
      for (let index = stack.length - 1; index >= 0 && !paint; index -= 1) paint = stack[index];
      output += paint ? paint(palette)(text) : text;
    } else {
      stack.pop();
    }
  }
  return output;
}

/** Unified-diff lines in the same colours as the file-change previews. */
function paintDiff(code: string, palette: ChalkInstance): string {
  return code
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return palette.bold(line);
      if (line.startsWith("@@")) return palette.cyan(line);
      if (line.startsWith("+")) return palette.green(line);
      if (line.startsWith("-")) return palette.red(line);
      if (line.startsWith("\\")) return palette.dim(line);
      return line;
    })
    .join("\n");
}

/**
 * Colour a fenced code block by its info-string language. Code without a
 * known language keeps the plain yellow used for every block before.
 */
export function highlightCode(code: string, info: string | undefined, palette: ChalkInstance): string {
  const language = info?.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  if (DIFF_LANGUAGES.has(language)) return paintDiff(code, palette);
  if (!language || code.length > MAX_HIGHLIGHT_CHARS || !hljs.getLanguage(language)) return palette.yellow(code);
  try {
    return paintHighlighted(hljs.highlight(code, { language, ignoreIllegals: true }).value, palette);
  } catch {
    return palette.yellow(code);
  }
}
