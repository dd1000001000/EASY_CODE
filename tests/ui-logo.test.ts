import assert from "node:assert/strict";

import { displayWidth, stripAnsi } from "../src/ui/render/layout.js";
import { LOGO_COLUMNS, LOGO_ROWS, renderEasyCodeLogo } from "../src/ui/render/logo.js";
import { describe, it } from "./harness.js";

describe("EASY CODE logo", () => {
  it("renders a fixed-size half-block icon at every color level", () => {
    for (const level of [1, 2, 3] as const) {
      const rows = renderEasyCodeLogo(level);
      assert.equal(rows.length, LOGO_ROWS);
      for (const row of rows) {
        assert.equal(displayWidth(stripAnsi(row)), LOGO_COLUMNS);
        assert.match(stripAnsi(row), /^[ ▀▄]+$/u);
      }
    }
  });

  it("uses truecolor brand colors and omits the icon without color support", () => {
    const truecolor = renderEasyCodeLogo(3).join("\n");
    assert.ok(truecolor.includes("\u001B[38;2;255;255;255m"), "white dog body");
    assert.ok(truecolor.includes("24;59;125m"), "dark ear, eye and nose");
    assert.ok(truecolor.includes("116;211;241m"), "cyan collar");
    assert.deepEqual(renderEasyCodeLogo(0), []);
  });
});
