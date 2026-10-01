import assert from "node:assert/strict";

import { SLASH_COMMAND_NAMES } from "../src/cli/slash-command.js";
import { slashSuggestions } from "../src/cli/slash-suggestions.js";
import { modelsForProvider } from "../src/models/catalog.js";
import { describe, it } from "./harness.js";

const EN = { language: "en_us" } as const;

function suggest(text: string, context: Parameters<typeof slashSuggestions>[2] = EN) {
  return slashSuggestions(text, text.length, context);
}

describe("slash command suggestions", () => {
  it("lists every command with a description for a bare slash", () => {
    const items = suggest("/");
    assert.deepEqual(
      items.map((item) => item.label),
      SLASH_COMMAND_NAMES.map((name) => `/${name}`),
    );
    assert.ok(items.every((item) => item.description.length > 0));
  });

  it("filters by prefix and runs complete commands on Enter", () => {
    assert.deepEqual(suggest("/he"), [
      { label: "/help", description: "Show help", replacement: "/help", submit: true },
    ]);
    assert.deepEqual(
      suggest("/RE").map((item) => item.label),
      ["/resume"],
    );
    assert.deepEqual(suggest("/nothing"), []);
  });

  it("fills in commands that need an argument instead of running them", () => {
    const [mode] = suggest("/mod");
    assert.equal(mode?.replacement, "/mode ");
    assert.equal(mode?.submit, false);
    // /model works without an argument (it opens the picker), so it runs directly.
    assert.equal(suggest("/model")[0]?.submit, true);
  });

  it("offers the first argument after a command and localizes descriptions", () => {
    assert.deepEqual(
      suggest("/mode ").map((item) => item.replacement),
      ["/mode plan", "/mode auto", "/mode code"],
    );
    assert.deepEqual(
      suggest("/mode c").map((item) => item.label),
      ["code"],
    );
    const zh = slashSuggestions("/mode ", 6, { language: "zh_cn" });
    assert.match(zh[0]?.description ?? "", /计划/u);
    assert.equal(suggest("/approval ").length, 3);
  });

  it("keeps arguments that need more input open for typing", () => {
    const add = suggest("/workspace a")[0];
    assert.equal(add?.replacement, "/workspace add ");
    assert.equal(add?.submit, false);
    assert.deepEqual(suggest("/workspace add "), []);
  });

  it("offers the current provider's models and host-supplied threads", () => {
    const models = modelsForProvider("deepseek");
    assert.deepEqual(
      suggest("/model ", { ...EN, provider: "deepseek" }).map((item) => item.label),
      models.map((model) => model.id),
    );
    assert.deepEqual(suggest("/model "), []);

    const threads = suggest("/resume ", {
      ...EN,
      dynamicArguments: (command) =>
        command === "resume" ? [{ value: "thread_abc", description: "Add authentication" }] : undefined,
    });
    assert.deepEqual(threads, [
      { label: "thread_abc", description: "Add authentication", replacement: "/resume thread_abc", submit: true },
    ]);
  });

  it("has no menu for ordinary text, a moved caret, or later arguments", () => {
    assert.deepEqual(suggest("hello"), []);
    assert.deepEqual(slashSuggestions("/mode", 2, EN), []);
    assert.deepEqual(suggest("/mode plan extra"), []);
    assert.deepEqual(suggest("/mode\nplan"), []);
    assert.deepEqual(suggest("/constructor x"), []);
    assert.deepEqual(suggest("/status x"), []);
  });
});
