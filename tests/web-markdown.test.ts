import assert from "node:assert/strict";
import { renderAssistantMarkdown } from "../src/web/markdown.js";
import { describe, it } from "./harness.js";

describe("Web assistant Markdown", () => {
  it("renders headings, lists, and highlighted fenced code", () => {
    const rendered = renderAssistantMarkdown("## Result\n\n- done\n\n```js\nconst answer = 42;\n```");
    assert.match(rendered, /<h2>Result<\/h2>/u);
    assert.match(rendered, /<li>done<\/li>/u);
    assert.match(rendered, /data-copy-code/u);
    assert.match(rendered, /markdown-code-block/u);
    assert.match(rendered, /const/u);
  });
  it("escapes raw HTML, unknown-language code, and unsafe links", () => {
    const rendered = renderAssistantMarkdown("<img src=x onerror=alert(1)>\n\n```not-a-language\n<script>alert(1)</script>\n```\n\n[bad](javascript:alert(1))\n\n![remote](https://example.com/image.png)");
    assert.doesNotMatch(rendered, /<img|<script|href="javascript:/u);
    assert.match(rendered, /&lt;script&gt;/u);
  });
  it("keeps an unfinished streamed code fence valid HTML", () => {
    const rendered = renderAssistantMarkdown("```ts\nconst value = 1;");
    assert.match(rendered, /markdown-code-block/u);
    assert.match(rendered, /<\/code><\/pre><\/div>/u);
  });
});
