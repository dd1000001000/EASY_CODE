import { Lexer } from "marked";

/**
 * Length of the leading part of a Markdown text whose blocks can no longer
 * change: every top-level block except the last one, which may still grow.
 * A block is final once the next one has started, because Markdown never lets
 * text after a blank line reach back into a closed paragraph, list, table or
 * fence. Returns 0 when nothing is final yet, or when the lexer's tokens do not
 * reproduce the text exactly (so a split could not be made safely).
 */
export function settledMarkdownLength(text: string): number {
  if (!text || text.includes("\r")) return 0;
  const tokens = Lexer.lex(text, { gfm: true });
  if (tokens.map((token) => token.raw).join("") !== text) return 0;
  // Reference links resolve across the whole answer, so an answer that defines
  // one is kept together.
  if (tokens.some((token) => token.type === "def")) return 0;
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last]!.type === "space") last -= 1;
  if (last <= 0) return 0;

  let length = 0;
  let content = false;
  for (const token of tokens.slice(0, last)) {
    length += token.raw.length;
    if (token.type !== "space") content = true;
  }
  // Until the newest block has a whole first line it may still continue the
  // one before it (a half-typed "2" becoming "2. item" of the same list).
  if (!text.slice(length).includes("\n")) return 0;
  return content ? length : 0;
}
