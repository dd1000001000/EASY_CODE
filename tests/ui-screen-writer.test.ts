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
    readonly rows: number = 24,
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
      "old\r\u001B[0Jnew\r\u001B[0J",
    );
    writer.close();
  });

  it("restores a visual live cursor and clears correctly from that position", () => {
    const output = new CapturedOutput(true, 5);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.renderLive("中ab\nxy", { row: 1, column: 1 });
    writer.renderLive("next");

    assert.equal(
      transcript.read(),
      "\r\n\u001B[1A中ab\r\nxy\r\u001B[1C" +
        "\r\u001B[1A\u001B[0Jnext",
    );
    writer.close();
  });

  it("snaps a requested cursor away from the second cell of a wide glyph", () => {
    const output = new CapturedOutput(true, 10);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.renderLive("a中b", { row: 0, column: 2 });

    assert.equal(transcript.read(), "a中b\r\u001B[1C");
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
      "busy\r\u001B[0Jdone\r\nbusy",
    );
    writer.close();
  });

  it("uses a dynamic caller-provided width", () => {
    const output = new CapturedOutput(true, 80);
    const transcript = capture(output);
    let columns = 4;
    const writer = new ScreenWriter({ output, columns: () => columns });

    writer.renderLive("A中国B");
    columns = 7;
    writer.renderLive("A中国B");

    assert.equal(
      transcript.read(),
      "\r\n\u001B[1AA中\r\n国B\r\u001B[1A\r\u001B[0JA中国B",
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
      "temporary\r\u001B[0J",
    );
    assert.equal(transcript.read(), closedTranscript);
    assert.equal(output.destroyed, false);
  });

  it("never appends a scrolling line feed while refreshing a live region", () => {
    const output = new CapturedOutput(true, 80);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    for (let index = 0; index < 100; index += 1) {
      writer.renderLive(`Request ${index}`);
    }

    const rendered = transcript.read();
    assert.equal(rendered.endsWith("\n"), false);
    assert.equal((rendered.match(/\n/gu) ?? []).length, 0);
    assert.equal(rendered.endsWith("Request 99"), true);
    writer.close();
  });

  it("reserves blank rows before a live region grows", () => {
    const output = new CapturedOutput(true, 80);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.renderLive("busy");
    writer.renderLive("approval\ncommand\nchoice 1\nchoice 2\nchoice 3");
    writer.clearLive();

    assert.equal(
      transcript.read(),
      "busy" +
        "\r\u001B[0J" +
        "\r\n\r\n\r\n\r\n\u001B[4A" +
        "approval\r\ncommand\r\nchoice 1\r\nchoice 2\r\nchoice 3" +
        "\r\u001B[4A\r\u001B[0J",
    );
    writer.close();
  });

  it("never paints a live block taller than the terminal viewport", () => {
    const output = new CapturedOutput(true, 80, 3);
    const transcript = capture(output);
    const writer = new ScreenWriter(output);

    writer.renderLive("one\ntwo\nthree\nfour\nfive");

    assert.equal(
      transcript.read(),
      "\r\n\r\n\u001B[2Aone\r\ntwo\r\nthree\r\u001B[2A",
    );
    assert.equal(transcript.read().includes("four"), false);
    writer.close();
  });

  it("reserves the physical rightmost TTY cell to avoid pending autowrap", () => {
    const tty = new ScreenWriter(new CapturedOutput(true, 80));
    const plain = new ScreenWriter(new CapturedOutput(false, 80));

    assert.equal(tty.columns, 79);
    assert.equal(plain.columns, 80);
    tty.close();
    plain.close();
  });

});
