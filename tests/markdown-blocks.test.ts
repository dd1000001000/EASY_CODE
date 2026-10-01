import assert from "node:assert/strict";

import { settledMarkdownLength } from "../src/ui/markdown-blocks.js";
import { describe, it } from "./harness.js";

function settled(text: string): string {
  return text.slice(0, settledMarkdownLength(text));
}

describe("settled Markdown blocks", () => {
  it("settles every block before the one still being written", () => {
    assert.equal(
      settled("# Title\n\nFirst paragraph.\n\n- a\n- b\n\nNext line\n"),
      "# Title\n\nFirst paragraph.\n\n- a\n- b\n\n",
    );
    assert.equal(
      settled("| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter the table\n"),
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n",
    );
    assert.equal(settled("```js\nconst x = 1;\n```\nAfter the fence\n"), "```js\nconst x = 1;\n```\n");
  });

  it("settles nothing while a single block is still open", () => {
    assert.equal(settled("Only one paragraph\nstill going"), "");
    assert.equal(settled("```js\nconst x = 1;\n\nconst y = 2;\n"), "");
    assert.equal(settled("Paragraph\n\n"), "");
    assert.equal(settled(""), "");
  });

  it("waits for the newest block's first line so it cannot still join the previous one", () => {
    assert.equal(settled("1. first\n\n2"), "");
    assert.equal(settled("1. first\n\n2. second\n"), "");
    assert.equal(settled("Intro\n\nNext"), "");
    assert.equal(settled("Intro\n\nNext\n"), "Intro\n\n");
  });

  it("keeps answers with reference definitions or carriage returns together", () => {
    assert.equal(settled("See [docs][d].\n\n[d]: https://example.com\n\nMore\n"), "");
    assert.equal(settled("One\r\n\r\nTwo\r\n"), "");
  });
});
