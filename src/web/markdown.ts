import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, grammar] of Object.entries({ bash, css, diff, javascript, json, markdown,
  powershell, python, sql, typescript, xml, yaml })) hljs.registerLanguage(name, grammar);

const markdownRenderer = new MarkdownIt({ html: false, linkify: false, typographer: false });
markdownRenderer.renderer.rules.image = (tokens, index) =>
  markdownRenderer.utils.escapeHtml(tokens[index]?.content || "Image attachment");
markdownRenderer.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  if (!token) return "";
  const language = token.info.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  const code = token.content;
  const highlighted = code.length <= 20_000 && language && hljs.getLanguage(language)
    ? hljs.highlight(code, { language, ignoreIllegals: true }).value
    : markdownRenderer.utils.escapeHtml(code);
  const label = markdownRenderer.utils.escapeHtml(language || "Code");
  return `<div class="markdown-code-block"><div class="markdown-code-header"><span>${label}</span><button type="button" data-copy-code>Copy</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
};
const defaultLinkOpen = markdownRenderer.renderer.rules.link_open;
markdownRenderer.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const token = tokens[index];
  token?.attrSet("target", "_blank");
  token?.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen?.(tokens, index, options, environment, renderer) ?? renderer.renderToken(tokens, index, options);
};

/** Model text is untrusted: raw HTML is disabled and fenced code is escaped or highlighted. */
export function renderAssistantMarkdown(text: string): string {
  return markdownRenderer.render(text);
}
