import { Chalk, type ChalkInstance } from "chalk";
import { Box, Text, renderToString } from "ink";
import { Lexer, type Token, type Tokens } from "marked";
import { memo, type ReactElement } from "react";

import { displayWidth, stripAnsi } from "../render/layout.js";
import { highlightCode } from "./code-highlight.js";

/**
 * Assistant answers rendered from Markdown with `marked`'s lexer and Ink's own
 * layout: the answer is one block, Ink does every line wrap, list items hang
 * under their bullets, and table columns share the width through flexbox.
 * The whole answer is re-lexed whenever its text changes, so a half-streamed
 * answer simply renders as far as it has arrived.
 */
export const MarkdownView = memo(function MarkdownView(props: {
  readonly text: string;
  readonly width: number;
  readonly color: boolean;
}): ReactElement {
  const palette = new Chalk({ level: props.color ? 1 : 0 });
  const tokens = Lexer.lex(props.text, { gfm: true });
  return <Blocks tokens={tokens} width={Math.max(4, props.width)} palette={palette} />;
});

interface BlockProps {
  readonly tokens: readonly Token[];
  readonly width: number;
  readonly palette: ChalkInstance;
  /** Tight list items keep their paragraphs together without blank rows. */
  readonly tight?: boolean;
}

function Blocks({ tokens, width, palette, tight = false }: BlockProps): ReactElement {
  const blocks = tokens.filter((token) => token.type !== "space" && token.type !== "def");
  return (
    <Box flexDirection="column" width={width}>
      {blocks.map((token, index) => (
        <Box key={index} marginTop={index > 0 && !tight ? 1 : 0} width={width}>
          <Block token={token} width={width} palette={palette} />
        </Box>
      ))}
    </Box>
  );
}

function Block({
  token,
  width,
  palette,
}: {
  readonly token: Token;
  readonly width: number;
  readonly palette: ChalkInstance;
}): ReactElement {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      const text = inline(heading.tokens, palette);
      return <Text>{heading.depth <= 2 ? palette.bold.cyan(text) : palette.bold(text)}</Text>;
    }
    case "paragraph":
      return <Text>{inline((token as Tokens.Paragraph).tokens, palette)}</Text>;
    case "text": {
      const text = token as Tokens.Text;
      return <Text>{text.tokens ? inline(text.tokens, palette) : text.text}</Text>;
    }
    case "code": {
      const code = token as Tokens.Code;
      return (
        <Box
          flexDirection="column"
          width={width}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor="gray"
          paddingLeft={1}
        >
          {code.lang ? <Text>{palette.gray(code.lang)}</Text> : null}
          <Text>{highlightCode(code.text, code.lang, palette)}</Text>
        </Box>
      );
    }
    case "blockquote":
      return (
        <Box
          width={width}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor="gray"
          paddingLeft={1}
        >
          <Blocks tokens={(token as Tokens.Blockquote).tokens} width={Math.max(4, width - 2)} palette={palette} />
        </Box>
      );
    case "list":
      return <List list={token as Tokens.List} width={width} palette={palette} />;
    case "table":
      return <Table table={token as Tokens.Table} width={width} palette={palette} />;
    case "hr":
      return <Text>{palette.gray("─".repeat(Math.min(width, 40)))}</Text>;
    default:
      return <Text>{"raw" in token ? String(token.raw).replace(/\n+$/u, "") : ""}</Text>;
  }
}

function List({
  list,
  width,
  palette,
}: {
  readonly list: Tokens.List;
  readonly width: number;
  readonly palette: ChalkInstance;
}): ReactElement {
  const start = typeof list.start === "number" ? list.start : 1;
  const markers = list.items.map((item, index) =>
    item.task ? (item.checked ? "☑" : "☐") : list.ordered ? `${start + index}.` : "•",
  );
  const markerWidth = Math.max(...markers.map((marker) => displayWidth(marker))) + 1;
  return (
    <Box flexDirection="column" width={width}>
      {list.items.map((item, index) => (
        <Box key={index} width={width} marginTop={index > 0 && list.loose ? 1 : 0}>
          <Box width={markerWidth} flexShrink={0}>
            <Text>{markers[index]}</Text>
          </Box>
          <Blocks tokens={item.tokens} width={Math.max(4, width - markerWidth)} palette={palette} tight={!list.loose} />
        </Box>
      ))}
    </Box>
  );
}

/**
 * Columns start at their natural width and give way in proportion to it when
 * the row is too wide, so every row gets identical column widths and long
 * cells wrap inside their column.
 */
function Table({
  table,
  width,
  palette,
}: {
  readonly table: Tokens.Table;
  readonly width: number;
  readonly palette: ChalkInstance;
}): ReactElement {
  const header = table.header.map((cell) => palette.bold(inline(cell.tokens, palette)));
  const rows = table.rows.map((row) => row.map((cell) => inline(cell.tokens, palette)));
  const natural = header.map((cell, column) =>
    Math.max(1, displayWidth(stripAnsi(cell)), ...rows.map((row) => displayWidth(stripAnsi(row[column] ?? "")))),
  );
  const row = (cells: readonly string[], key: string, underline = false): ReactElement => (
    <Box
      key={key}
      width={width}
      columnGap={2}
      {...(underline
        ? { borderStyle: "single", borderTop: false, borderLeft: false, borderRight: false, borderColor: "gray" }
        : {})}
    >
      {natural.map((size, column) => (
        <Box key={column} flexBasis={size} flexShrink={size} flexGrow={0} minWidth={Math.min(size, 4)}>
          <Text>{cells[column] ?? ""}</Text>
        </Box>
      ))}
    </Box>
  );
  return (
    <Box flexDirection="column" width={width}>
      {row(header, "header", true)}
      {rows.map((cells, index) => row(cells, `row-${index}`))}
    </Box>
  );
}

/** Inline Markdown as one styled string; Ink wraps it. */
function inline(tokens: readonly Token[] | undefined, palette: ChalkInstance): string {
  if (!tokens) return "";
  return tokens
    .map((token): string => {
      switch (token.type) {
        case "strong":
          return palette.bold(inline((token as Tokens.Strong).tokens, palette));
        case "em":
          return palette.italic(inline((token as Tokens.Em).tokens, palette));
        case "del":
          return palette.strikethrough(inline((token as Tokens.Del).tokens, palette));
        case "codespan":
          return palette.cyan((token as Tokens.Codespan).text);
        case "link": {
          const link = token as Tokens.Link;
          const label = inline(link.tokens, palette);
          return stripAnsi(label) === link.href
            ? palette.underline(link.href)
            : `${label} ${palette.gray(`(${link.href})`)}`;
        }
        case "image":
          return palette.gray(`[image: ${(token as Tokens.Image).text || (token as Tokens.Image).href}]`);
        case "br":
          return "\n";
        case "checkbox":
          return "";
        case "text": {
          const text = token as Tokens.Text;
          return text.tokens ? inline(text.tokens, palette) : decodeEntities(text.text);
        }
        case "escape":
          return (token as Tokens.Escape).text;
        default:
          return "raw" in token ? String(token.raw) : "";
      }
    })
    .join("");
}

/** marked escapes a few characters as HTML entities in text tokens. */
function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

/** An assistant answer: the `●` gutter beside its Markdown block. */
export const AnswerBlock = memo(function AnswerBlock(props: {
  readonly text: string;
  readonly width: number;
  readonly color: boolean;
  /** One blank row above, like every conversation item. */
  readonly spaced?: boolean;
  /** Later blocks of an answer already started above: same gutter, no second bullet. */
  readonly continuation?: boolean;
}): ReactElement {
  const bullet = props.continuation ? " " : new Chalk({ level: props.color ? 1 : 0 }).cyan("●");
  return (
    <Box width={props.width} marginTop={props.spaced ? 1 : 0}>
      <Box width={2} flexShrink={0}>
        <Text>{bullet}</Text>
      </Box>
      <MarkdownView text={props.text} width={Math.max(4, props.width - 2)} color={props.color} />
    </Box>
  );
});

const ANSWER_CACHE_LIMIT = 64;
const answerCache = new Map<string, string>();

/**
 * One assistant answer as printed rows, for the full-screen Thinking viewer.
 * Never call this while the live Ink tree renders: a nested render corrupts
 * Ink's layout engine. The live tree renders `AnswerBlock` directly instead.
 */
export function renderAnswer(text: string, width: number, color: boolean, continuation = false): string {
  const key = `${width}:${color ? 1 : 0}:${continuation ? 1 : 0}:${text}`;
  const cached = answerCache.get(key);
  if (cached !== undefined) return cached;
  const rendered = renderToString(<AnswerBlock text={text} width={width} color={color} continuation={continuation} />, {
    columns: width,
  });
  answerCache.set(key, rendered);
  if (answerCache.size > ANSWER_CACHE_LIMIT) answerCache.delete(answerCache.keys().next().value!);
  return rendered;
}
