import assert from "node:assert/strict";

import {
  clampVisualColumn,
  countVisualRows,
  displayWidth,
  hasAnsi,
  maxLineWidth,
  sanitizeTerminalText,
  stripAnsi,
  truncateToWidth,
  wrapToWidth,
} from "../src/ui/render/layout.js";
import { describe, it } from "./harness.js";

describe("terminal UI layout", () => {
  it("recognizes and safely strips CSI, OSC, C1, and incomplete controls", () => {
    const styled = "plain \u001B[31mred\u001B[0m";
    assert.equal(hasAnsi(styled), true);
    assert.equal(hasAnsi("plain text"), false);
    assert.equal(stripAnsi(styled), "plain red");
    assert.equal(
      stripAnsi("a\u001B]8;;https://example.test\u0007link\u001B]8;;\u001B\\b"),
      "alinkb",
    );
    assert.equal(stripAnsi("safe\u009B2Jtext"), "safetext");
    assert.equal(stripAnsi("safe\u001B]52;c;unterminated"), "safe");
  });

  it("sanitizes cursor and control input while optionally retaining SGR", () => {
    const value = "ok\rnext\t\u0007\u001B[2Jx\u001B[31mred\u001B[0m";
    assert.equal(
      sanitizeTerminalText(value),
      "ok\nnext    x\u001B[31mred\u001B[0m",
    );
    assert.equal(
      sanitizeTerminalText(value, { allowSgr: false }),
      "ok\nnext    xred",
    );
  });

  it("measures CJK, combining text, flags, and joined emoji by display cells", () => {
    assert.equal(displayWidth("ASCII"), 5);
    assert.equal(displayWidth("A中文B"), 6);
    assert.equal(displayWidth("e\u0301"), 1);
    assert.equal(displayWidth("🇨🇳"), 2);
    assert.equal(displayWidth("👍🏽"), 2);
    assert.equal(displayWidth("👨‍👩‍👧‍👦"), 2);
    assert.equal(displayWidth("\u001B[31m中文\u001B[0m"), 4);
    assert.equal(maxLineWidth("abc\n中文"), 4);
  });

  it("truncates at grapheme boundaries with a width-bounded marker", () => {
    assert.equal(truncateToWidth("abcdef", 4), "abc…");
    assert.equal(truncateToWidth("A中国B", 5), "A中…");
    assert.equal(truncateToWidth("👨‍👩‍👧‍👦ab", 3), "👨‍👩‍👧‍👦…");
    assert.equal(truncateToWidth("abc", 0), "");
    const colored = truncateToWidth("\u001B[31mabcdef", 4);
    assert.equal(stripAnsi(colored), "abc…");
    assert.ok(colored.endsWith("\u001B[0m"));
  });

  it("hard-wraps by terminal cells and preserves explicit empty lines", () => {
    assert.deepEqual(wrapToWidth("A中国B", 3), ["A中", "国B"]);
    assert.deepEqual(wrapToWidth("a\n\n中", 3), ["a", "", "中"]);
    assert.deepEqual(
      wrapToWidth("a👨‍👩‍👧‍👦b", 3),
      ["a👨‍👩‍👧‍👦", "b"],
    );
    assert.deepEqual(wrapToWidth("中", 1), ["…"]);
    assert.equal(countVisualRows("A中国B", 3), 2);
    for (const line of wrapToWidth("a中文🙂z", 4)) {
      assert.ok(displayWidth(line) <= 4);
    }
  });

  it("replays SGR styles on every independently paintable wrapped row", () => {
    const wrapped = wrapToWidth(
      "\u001B[90mabcdefgh\u001B[0m",
      3,
      { preserveAnsi: true },
    );

    assert.deepEqual(wrapped.map(stripAnsi), ["abc", "def", "gh"]);
    for (const row of wrapped) {
      assert.ok(row.startsWith("\u001B[90m"));
      assert.ok(row.endsWith("\u001B[0m"));
    }

    const explicitRows = wrapToWidth(
      "\u001B[2mfirst\nsecond\u001B[0m",
      80,
      { preserveAnsi: true },
    );
    assert.deepEqual(explicitRows.map(stripAnsi), ["first", "second"]);
    assert.ok(explicitRows[1]?.startsWith("\u001B[2m"));
    assert.ok(explicitRows[1]?.endsWith("\u001B[0m"));
  });

  it("clamps cursor columns to wide-character boundaries", () => {
    assert.equal(clampVisualColumn("a中b", 0), 0);
    assert.equal(clampVisualColumn("a中b", 2), 1);
    assert.equal(clampVisualColumn("a中b", 3), 3);
    assert.equal(clampVisualColumn("a中b", 99), 4);
  });
});
