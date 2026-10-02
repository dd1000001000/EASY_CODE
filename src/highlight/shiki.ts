import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemedToken } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

/**
 * The one Shiki highlighter shared by the terminal and the Web page. Nothing is
 * loaded up front: the WASM regex engine and each grammar arrive on first use,
 * and until then callers render code plain and repaint once it is ready.
 */

export type CodeThemeName = "github-dark" | "github-light";
export const CODE_THEMES: readonly CodeThemeName[] = ["github-dark", "github-light"];

type GrammarModule = Promise<{ default: LanguageRegistration[] }>;

/** Static imports, so bundlers emit one chunk per grammar instead of all of Shiki's. */
const GRAMMARS = {
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  docker: () => import("@shikijs/langs/docker"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  lua: () => import("@shikijs/langs/lua"),
  make: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scss: () => import("@shikijs/langs/scss"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
} satisfies Record<string, () => GrammarModule>;

export type CodeLanguage = keyof typeof GRAMMARS;
export const CODE_LANGUAGES = Object.keys(GRAMMARS) as CodeLanguage[];

/** Names models write after a fence, mapped to the grammar that colours them. */
const ALIASES: Readonly<Record<string, CodeLanguage>> = {
  bash: "shellscript",
  sh: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  h: "c",
  "c#": "csharp",
  cs: "csharp",
  dockerfile: "docker",
  makefile: "make",
  mk: "make",
  md: "markdown",
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript",
  cts: "typescript",
  mts: "typescript",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  yml: "yaml",
  kt: "kotlin",
  kts: "kotlin",
  properties: "ini",
  svg: "xml",
  htm: "html",
  patch: "diff",
  udiff: "diff",
};

/** Larger blocks stay plain; tokenizing them would stall a frame. */
export const MAX_HIGHLIGHT_CHARS = 20_000;
const CACHE_LIMIT = 128;

/** The grammar for a fence info string such as `ts title=a.ts`, if one is supported. */
export function resolveCodeLanguage(info: string | undefined): CodeLanguage | undefined {
  const name = info?.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  if (!name) return undefined;
  if (Object.prototype.hasOwnProperty.call(GRAMMARS, name)) return name as CodeLanguage;
  return Object.prototype.hasOwnProperty.call(ALIASES, name) ? ALIASES[name] : undefined;
}

let pendingHighlighter: Promise<HighlighterCore> | undefined;
let highlighter: HighlighterCore | undefined;
const loaded = new Set<CodeLanguage>();
const loading = new Map<CodeLanguage, Promise<boolean>>();
const listeners = new Set<() => void>();
let epoch = 0;

function startHighlighter(): Promise<HighlighterCore> {
  pendingHighlighter ??= createHighlighterCore({
    themes: [import("@shikijs/themes/github-dark"), import("@shikijs/themes/github-light")],
    langs: [],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  }).then((instance) => (highlighter = instance));
  return pendingHighlighter;
}

/**
 * Load a grammar in the background. Resolves false when it cannot load (for
 * example a page whose policy forbids WASM); that language then stays plain.
 */
export function ensureCodeLanguage(language: CodeLanguage): Promise<boolean> {
  if (loaded.has(language)) return Promise.resolve(true);
  let pending = loading.get(language);
  if (!pending) {
    pending = startHighlighter()
      .then((instance) => instance.loadLanguage(GRAMMARS[language]()))
      .then(
        () => {
          loaded.add(language);
          epoch += 1;
          for (const listener of [...listeners]) listener();
          return true;
        },
        () => false,
      );
    loading.set(language, pending);
  }
  return pending;
}

/** Load every supported grammar, one at a time, so later code blocks colour at once. */
export async function preloadCodeLanguages(): Promise<void> {
  for (const language of CODE_LANGUAGES) await ensureCodeLanguage(language);
}

/** Changes each time a grammar finishes loading; views include it to know when to repaint. */
export function codeLanguageEpoch(): number {
  return epoch;
}

export function subscribeCodeLanguages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function cached<T>(cache: Map<string, T>, key: string, compute: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const value = compute();
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return value;
}

/** The highlighter once `language` is loaded; otherwise starts loading it and returns undefined. */
function readyFor(code: string, language: CodeLanguage): HighlighterCore | undefined {
  if (code.length > MAX_HIGHLIGHT_CHARS) return undefined;
  if (highlighter && loaded.has(language)) return highlighter;
  void ensureCodeLanguage(language);
  return undefined;
}

const tokenCache = new Map<string, ThemedToken[][]>();
const htmlCache = new Map<string, string>();

/** Lines of coloured tokens in one theme, or undefined while the grammar is still loading. */
export function codeTokensIfReady(
  code: string,
  language: CodeLanguage,
  theme: CodeThemeName,
): ThemedToken[][] | undefined {
  const instance = readyFor(code, language);
  if (!instance) return undefined;
  try {
    return cached(tokenCache, `${theme}\0${language}\0${code}`, () =>
      instance.codeToTokensBase(code, { lang: language, theme }),
    );
  } catch {
    return undefined;
  }
}

/**
 * A `<pre class="shiki">` block carrying both GitHub themes as CSS variables
 * (`--shiki-light` / `--shiki-dark`); the stylesheet picks one. Token text is
 * escaped by Shiki. Undefined while the grammar is still loading.
 */
export function codeHtmlIfReady(code: string, language: CodeLanguage): string | undefined {
  const instance = readyFor(code, language);
  if (!instance) return undefined;
  try {
    return cached(htmlCache, `${language}\0${code}`, () =>
      instance.codeToHtml(code, {
        lang: language,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
      }),
    );
  } catch {
    return undefined;
  }
}

/** The theme's default text colour, which terminals leave to their own foreground. */
export function codeThemeForeground(theme: CodeThemeName): string | undefined {
  return highlighter?.getTheme(theme).fg;
}

const lineHtmlCache = new Map<string, readonly string[]>();

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * Each line of `code` as HTML spans carrying both GitHub themes as CSS
 * variables, like `codeHtmlIfReady` but without the surrounding `<pre>`, for
 * views that lay lines out themselves (diffs). Text is escaped. Undefined
 * while the grammar is still loading.
 */
export function codeLinesHtmlIfReady(code: string, language: CodeLanguage): readonly string[] | undefined {
  const instance = readyFor(code, language);
  if (!instance) return undefined;
  try {
    return cached(lineHtmlCache, `${language}\0${code}`, () =>
      instance
        .codeToTokens(code, {
          lang: language,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
        })
        .tokens.map((line) =>
          line
            .map((token) => {
              const style = Object.entries(token.htmlStyle ?? {})
                .map(([name, value]) => `${name}:${value}`)
                .join(";");
              return `<span style="${escapeHtml(style)}">${escapeHtml(token.content)}</span>`;
            })
            .join(""),
        ),
    );
  } catch {
    return undefined;
  }
}
