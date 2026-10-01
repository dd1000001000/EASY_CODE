import assert from "node:assert/strict";

import { Chalk } from "chalk";

import { highlightCode } from "../src/ui/ink/code-highlight.js";
import { stripAnsi } from "../src/ui/render/layout.js";
import { describe, it } from "./harness.js";

const palette = new Chalk({ level: 1 });
const plain = new Chalk({ level: 0 });

const MAGENTA = "\u001B[35m";
const GREEN = "\u001B[32m";
const RED = "\u001B[31m";
const YELLOW = "\u001B[33m";
const CYAN = "\u001B[36m";
const GRAY = "\u001B[90m";

describe("fenced code highlighting", () => {
  it("colours tokens by language and keeps the code text intact", () => {
    const code = 'const total: number = 42; // sum\nreturn "done";';
    const rendered = highlightCode(code, "ts", palette);
    assert.equal(stripAnsi(rendered), code);
    assert.ok(rendered.includes(`${MAGENTA}const`));
    assert.ok(rendered.includes(`${CYAN}number`));
    assert.ok(rendered.includes(`${YELLOW}42`));
    assert.ok(rendered.includes(`${GRAY}// sum`));
    assert.ok(rendered.includes(`${GREEN}"done"`));
  });

  it("accepts aliases and info strings with extra words", () => {
    assert.ok(highlightCode("def f():\n    pass", "py", palette).includes(`${MAGENTA}def`));
    assert.ok(highlightCode("echo hi", "bash title=run.sh", palette).includes("echo"));
  });

  it("decodes characters highlight.js escapes", () => {
    const code = "if (a < b && c > d) x = \"<tag>\" + 'q';";
    assert.equal(stripAnsi(highlightCode(code, "javascript", palette)), code);
  });

  it("colours diff and patch blocks like file-change previews", () => {
    const diff = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n same";
    const rendered = highlightCode(diff, "diff", palette);
    assert.equal(stripAnsi(rendered), diff);
    assert.ok(rendered.includes(`${RED}-old`));
    assert.ok(rendered.includes(`${GREEN}+new`));
    assert.ok(rendered.includes(`${CYAN}@@ -1 +1 @@`));
    assert.ok(highlightCode("-gone", "patch", palette).includes(`${RED}-gone`));
  });

  it("keeps unlabelled, unknown and oversized code plain yellow", () => {
    assert.equal(highlightCode("text", undefined, palette), `${YELLOW}text\u001B[39m`);
    assert.equal(highlightCode("text", "no-such-language", palette), `${YELLOW}text\u001B[39m`);
    const large = "x = 1\n".repeat(5_000);
    assert.equal(highlightCode(large, "python", palette), palette.yellow(large));
  });

  it("adds no colour when colour is off", () => {
    assert.equal(highlightCode("const x = 1;", "js", plain), "const x = 1;");
  });
});
