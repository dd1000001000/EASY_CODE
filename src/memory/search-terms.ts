const WORD = /[\p{L}\p{N}]+/gu;
const CJK_RUN = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/u;

/**
 * Lexical terms shared by the FTS index and in-process scoring. The unicode61
 * tokenizer keeps an unspaced CJK run as one token, so a query word could
 * only match the start of a sentence; CJK runs become overlapping bigrams.
 * Single characters are too common to be evidence and are left out.
 */
export function memorySearchTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const word of text.toLocaleLowerCase().match(WORD) ?? []) {
    word.split(CJK_RUN).forEach((part, index) => {
      if (index % 2 === 0) {
        if (part.length >= 2) terms.add(part);
        return;
      }
      const characters = Array.from(part);
      for (let start = 0; start + 1 < characters.length; start += 1) {
        terms.add(characters[start]! + characters[start + 1]!);
      }
    });
  }
  return [...terms];
}

/** The text stored in memories.search_text and indexed by memories_fts. */
export function memorySearchText(content: string): string {
  return memorySearchTerms(content).join(" ");
}
