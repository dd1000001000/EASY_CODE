import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { ThinkingViewer, parseViewerKeys } from "../src/ui/ink/thinking-viewer.js";
import type { TranscriptDocument } from "../src/ui/ink/entry-text.js";
import { stripAnsi } from "../src/ui/render/layout.js";
import { describe, it } from "./harness.js";

class TtyOutput extends PassThrough {
  readonly isTTY = true;
  columns = 40;
  rows = 6;
}

/** Ten rows of text; Thinking #1's marker is row 4 and expands to three body rows. */
function document(expanded: ReadonlySet<number>): TranscriptDocument {
  const lines = Array.from({ length: 10 }, (_, index) => `row ${index}`);
  lines[4] = expanded.has(1) ? "↕ Thinking #1" : "▶ Thinking #1";
  if (expanded.has(1)) lines.splice(5, 0, "  body a", "  body b", "  body c");
  return { lines, markers: new Map([[1, 4]]) };
}

function harness(): { viewer: ThinkingViewer; screen: () => string; closed: () => number } {
  const output = new TtyOutput();
  let written = "";
  let closed = 0;
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    written += chunk;
  });
  const viewer = new ThinkingViewer({
    output: output as unknown as NodeJS.WriteStream,
    document,
    onClosed: () => {
      closed += 1;
    },
  });
  return { viewer, screen: () => stripAnsi(written), closed: () => closed };
}

describe("Ink Thinking viewer", () => {
  it("parses navigation keys and skips unknown escape sequences", () => {
    assert.deepEqual(parseViewerKeys("\u001B[A\u001B[B\u001B[5~\u001B[6~"), ["up", "down", "page-up", "page-down"]);
    assert.deepEqual(parseViewerKeys("\u001B"), ["close"]);
    assert.deepEqual(parseViewerKeys("\u001B[1;5Cq"), ["close"]);
    assert.deepEqual(parseViewerKeys("x\u0014"), ["close"]);
  });

  it("keeps the expanded marker on its clicked row and closes when the last block collapses", () => {
    const { viewer, screen, closed } = harness();
    viewer.show(1, 2);
    assert.equal(viewer.isOpen, true);
    // Five content rows: the marker (document row 4) sits on screen row 2, so rows 2..6 show.
    assert.match(screen(), /row 2[\s\S]*row 3[\s\S]*↕ Thinking #1[\s\S]*body a[\s\S]*body b/u);
    viewer.handleInput("\u001B[B");
    assert.match(screen(), /body c/u);
    viewer.toggle(1);
    assert.equal(viewer.isOpen, false);
    assert.equal(closed(), 1);
  });
});
