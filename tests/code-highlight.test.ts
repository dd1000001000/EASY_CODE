import assert from "node:assert/strict";

import { Chalk } from "chalk";

import { ensureCodeLanguage, resolveCodeLanguage } from "../src/highlight/shiki.js";
import { highlightCode, terminalCodeTheme, type CodeStyle } from "../src/ui/ink/code-highlight.js";
import { stripAnsi } from "../src/ui/render/layout.js";
import { describe, it } from "./harness.js";

const truecolor: CodeStyle = { level: 3, theme: "github-dark" };
const YELLOW = "\u001B[33m";

/** A fresh copy of the shared highlighter, so the loading path is seen regardless of earlier tests. */
async function freshHighlighter(): Promise<typeof import("../src/highlight/shiki.js")> {
  const url = new URL("../src/highlight/shiki.js", import.meta.url);
  url.search = `fresh=${Date.now()}`;
  return (await import(url.href)) as typeof import("../src/highlight/shiki.js");
}

describe("fenced code highlighting", () => {
  it("loads grammars on demand and announces each one", async () => {
    const shiki = await freshHighlighter();
    assert.equal(shiki.codeTokensIfReady("local x = 1", "lua", "github-dark"), undefined);
    let announced = 0;
    const unsubscribe = shiki.subscribeCodeLanguages(() => (announced += 1));
    const epoch = shiki.codeLanguageEpoch();
    assert.equal(await shiki.ensureCodeLanguage("lua"), true);
    unsubscribe();
    assert.equal(announced, 1);
    assert.equal(shiki.codeLanguageEpoch(), epoch + 1);
    const lines = shiki.codeTokensIfReady("local x = 1\nreturn x", "lua", "github-dark");
    assert.equal(lines?.length, 2);
    assert.equal(lines?.[0]?.map((token) => token.content).join(""), "local x = 1");
  });

  it("paints the github-dark colours in 24-bit and keeps the code text intact", async () => {
    await ensureCodeLanguage("typescript");
    const code = 'const total: number = 42; // sum\nreturn "done";';
    const rendered = highlightCode(code, "ts", truecolor);
    assert.equal(stripAnsi(rendered), code);
    assert.ok(rendered.includes("\u001B[38;2;249;117;131mconst"), rendered);
    assert.ok(rendered.includes("\u001B[38;2;121;184;255m42"), rendered);
    assert.ok(rendered.includes("\u001B[38;2;106;115;125m// sum"), rendered);
    assert.ok(rendered.includes('\u001B[38;2;158;203;255m"done"'), rendered);
  });

  it("leaves text in the theme's default colour to the terminal", async () => {
    await ensureCodeLanguage("typescript");
    const rendered = highlightCode("x;", "typescript", truecolor);
    assert.ok(!rendered.includes("225;228;232"), rendered);
  });

  it("maps the theme down to 256 and 16 colours", async () => {
    await ensureCodeLanguage("python");
    const code = "def f():\n    pass";
    const ansi256 = highlightCode(code, "py", { level: 2, theme: "github-dark" });
    assert.ok(ansi256.includes(`${new Chalk({ level: 2 }).hex("#F97583")("def")}`), ansi256);
    const ansi16 = highlightCode(code, "python", { level: 1, theme: "github-dark" });
    assert.ok(ansi16.includes(`${new Chalk({ level: 1 }).hex("#F97583")("def")}`), ansi16);
    assert.equal(stripAnsi(ansi16), code);
  });

  it("accepts aliases and info strings with extra words", async () => {
    await ensureCodeLanguage("shellscript");
    await ensureCodeLanguage("cpp");
    assert.equal(resolveCodeLanguage("bash title=run.sh"), "shellscript");
    assert.equal(resolveCodeLanguage("C++"), "cpp");
    assert.equal(resolveCodeLanguage("hpp"), "cpp");
    assert.equal(resolveCodeLanguage("no-such-language"), undefined);
    assert.notEqual(highlightCode("echo hi", "bash title=run.sh", truecolor), `${YELLOW}echo hi\u001B[39m`);
    const cpp = highlightCode("#include <vector>\nint main() { return 0; }", "c++", truecolor);
    assert.ok(cpp.includes("\u001B[38;2;"), cpp);
  });

  it("colours diff and patch blocks", async () => {
    await ensureCodeLanguage("diff");
    const diff = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n same";
    const rendered = highlightCode(diff, "diff", truecolor);
    assert.equal(stripAnsi(rendered), diff);
    assert.ok(rendered.includes("\u001B[38;2;253;174;183m-old"), rendered);
    assert.ok(rendered.includes("\u001B[38;2;133;232;157m+new"), rendered);
    assert.ok(highlightCode("-gone", "patch", truecolor).includes("\u001B[38;2;253;174;183m-gone"));
  });

  it("keeps unlabelled, unknown and oversized code plain yellow", async () => {
    await ensureCodeLanguage("python");
    assert.equal(highlightCode("text", undefined, truecolor), `${YELLOW}text\u001B[39m`);
    assert.equal(highlightCode("text", "no-such-language", truecolor), `${YELLOW}text\u001B[39m`);
    const large = "x = 1\n".repeat(5_000);
    assert.equal(highlightCode(large, "python", truecolor), new Chalk({ level: 3 }).yellow(large));
  });

  it("adds no colour when colour is off", async () => {
    await ensureCodeLanguage("javascript");
    assert.equal(highlightCode("const x = 1;", "js", { level: 0, theme: "github-dark" }), "const x = 1;");
  });

  it("picks github-light for light terminals or when configured", () => {
    assert.equal(terminalCodeTheme({}), "github-dark");
    assert.equal(terminalCodeTheme({ COLORFGBG: "0;15" }), "github-light");
    assert.equal(terminalCodeTheme({ COLORFGBG: "15;0" }), "github-dark");
    assert.equal(terminalCodeTheme({ COLORFGBG: "15;0", EASY_CODE_CODE_THEME: "GitHub-Light" }), "github-light");
    assert.equal(terminalCodeTheme({ COLORFGBG: "0;15", EASY_CODE_CODE_THEME: "github-dark" }), "github-dark");
    assert.equal(terminalCodeTheme({ EASY_CODE_CODE_THEME: "monokai" }), "github-dark");
  });
});
