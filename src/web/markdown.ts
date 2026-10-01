import MarkdownIt from "markdown-it";
import { codeHtmlIfReady, resolveCodeLanguage } from "../highlight/shiki.js";

export { codeLanguageEpoch, subscribeCodeLanguages } from "../highlight/shiki.js";

/** On code blocks rendered plain while their grammar loads. */
export const PENDING_HIGHLIGHT = "data-highlight-pending";

const markdownRenderer = new MarkdownIt({ html: false, linkify: false, typographer: false });
markdownRenderer.renderer.rules.image = (tokens, index) =>
  markdownRenderer.utils.escapeHtml(tokens[index]?.content || "Image attachment");
markdownRenderer.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  if (!token) return "";
  const language = token.info.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  const code = token.content;
  const grammar = resolveCodeLanguage(language);
  const highlighted = grammar ? codeHtmlIfReady(code, grammar) : undefined;
  // Until its grammar has loaded the code shows plain, marked so the message renders again once it has.
  const plain = `<pre class="shiki"${grammar ? ` ${PENDING_HIGHLIGHT}` : ""}><code>${markdownRenderer.utils.escapeHtml(code)}</code></pre>`;
  const label = markdownRenderer.utils.escapeHtml(language || "Code");
  return `<div class="markdown-code-block"><div class="markdown-code-header"><span>${label}</span><button type="button" data-copy-code>Copy</button></div>${highlighted ?? plain}</div>`;
};
const defaultLinkOpen = markdownRenderer.renderer.rules.link_open;
markdownRenderer.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const token = tokens[index];
  token?.attrSet("target", "_blank");
  token?.attrSet("rel", "noopener noreferrer");
  return (
    defaultLinkOpen?.(tokens, index, options, environment, renderer) ?? renderer.renderToken(tokens, index, options)
  );
};

/** Model text is untrusted: raw HTML is disabled and fenced code is escaped or highlighted by Shiki. */
export function renderAssistantMarkdown(text: string): string {
  return markdownRenderer.render(text);
}
