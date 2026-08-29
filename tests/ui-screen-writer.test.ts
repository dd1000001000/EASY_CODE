import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  ScreenWriter,
  type ScreenOutput,
} from "../src/ui/render/screen-writer.js";
import { describe, it } from "./harness.js";

class CapturedOutput extends PassThrough implements ScreenOutput {
  constructor(
    readonly isTTY: boolean,
    readonly columns: number = 80,
  ) {
    super();
  }
}

function capture(output: CapturedOutput): { read: () => string } {
  output.setEncoding("utf8");
  let transcript = "";
  output.on("data", (chunk: string) => {
    transcript += chunk;
  });
  return { read: () => transcript };
}

describe("ScreenWriter", () => {
  it("commits sanitized stable output without letting text move the cursor", () => {
    const output = new CapturedOutput(true);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.commit("safe\u001B[2Jbad\u0007\rnext");

    assert.equal(transcript.read(), "safebad\nnext");
    writer.close();
  });

  it("contains allowed SGR styling within one stable commit", () => {
    const output = new CapturedOutput(true);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.commit("\u001B[31mred");

    assert.equal(transcript.read(), "\u001B[31mred\u001B[0m");
    writer.close();
  });

  it("erases and redraws only the bottom live region", () => {
    const output = new CapturedOutput(true, 20);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.renderLive("old");
    writer.renderLive("new");
    writer.clearLive();

    assert.equal(
      transcript.read(),
      "old\n\r\u001B[1A\u001B[0Jnew\n\r\u001B[1A\u001B[0J",
    );
    writer.close();
  });

  it("restores a visual live cursor and clears correctly from that position", () => {
    const output = new CapturedOutput(true, 4);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.renderLive("中ab\nxy", { row: 1, column: 1 });
    writer.renderLive("next");

    assert.equal(
      transcript.read(),
      "中ab\nxy\n\u001B[1A\u001B[1C" +
        "\r\u001B[1A\u001B[0Jnext\n",
    );
    writer.close();
  });

  it("snaps a requested cursor away from the second cell of a wide glyph", () => {
    const output = new CapturedOutput(true, 10);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.renderLive("a中b", { row: 0, column: 2 });

    assert.equal(transcript.read(), "a中b\n\u001B[1A\u001B[1C");
    writer.close();
  });

  it("places commits above an existing live region and redraws it", () => {
    const output = new CapturedOutput(true, 20);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.renderLive("busy");
    writer.commit("done");

    assert.equal(
      transcript.read(),
      "busy\n\r\u001B[1A\u001B[0Jdone\nbusy\n",
    );
    writer.close();
  });

  it("uses a dynamic caller-provided width", () => {
    const output = new CapturedOutput(true, 80);
    const transcript = capture(output);
    let columns = 3;
    const writer = new ScreenWriter({ output, columns: () => columns });

    writer.renderLive("A中国B");
    columns = 6;
    writer.renderLive("A中国B");

    assert.equal(
      transcript.read(),
      "A中\n国B\n\r\u001B[2A\u001B[0JA中国B\n",
    );
    writer.close();
  });

  it("falls back to safe plain snapshots on non-TTY output", () => {
    const output = new CapturedOutput(false, 20);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.renderLive("loading\u001B[2J\rnext\u0007");
    writer.renderLive("loading\u001B[2J\rnext\u0007");
    writer.clearLive();
    writer.commit("done\u001B[31m!");

    assert.equal(transcript.read(), "loading\nnext\ndone!");
    assert.equal(transcript.read().includes("\u001B"), false);
    writer.close();
  });

  it("closes idempotently without ending stdout and ignores later writes", () => {
    const output = new CapturedOutput(true);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.renderLive("temporary");
    writer.close();
    const closedTranscript = transcript.read();
    writer.close();
    writer.commit("ignored");
    writer.renderLive("ignored");

    assert.equal(
      closedTranscript,
      "temporary\n\r\u001B[1A\u001B[0J",
    );
    assert.equal(transcript.read(), closedTranscript);
    assert.equal(output.destroyed, false);
  });
});
