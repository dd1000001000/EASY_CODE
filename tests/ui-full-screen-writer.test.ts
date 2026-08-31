import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  FULL_SCREEN_ENTER_SEQUENCE,
  FULL_SCREEN_EXIT_SEQUENCE,
  FullScreenWriter,
} from "../src/ui/tui/full-screen-writer.js";
import type { ScreenOutput } from "../src/ui/render/screen-writer.js";
import { displayWidth, stripAnsi } from "../src/ui/render/layout.js";
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

describe("FullScreenWriter", () => {
  it("enters, renders, and exits using paired terminal modes without line feeds", () => {
    const output = new CapturedOutput(true, 8, 3);
    const transcript = capture(output);
    const writer = new FullScreenWriter(output);

    writer.enter();
    writer.render(["one", "two"]);
    writer.close();

    assert.equal(
      transcript.read(),
      FULL_SCREEN_ENTER_SEQUENCE +
        "\u001B[1;1H\u001B[2Kone" +
        "\u001B[2;1H\u001B[2Ktwo" +
        FULL_SCREEN_EXIT_SEQUENCE,
    );
    assert.equal(transcript.read().includes("\n"), false);
    assert.equal(output.destroyed, false);
  });

  it("does not capture the mouse so terminal text remains selectable", () => {
    assert.equal(FULL_SCREEN_ENTER_SEQUENCE.includes("\u001B[?1000h"), false);
    assert.equal(FULL_SCREEN_ENTER_SEQUENCE.includes("\u001B[?1006h"), false);
    assert.equal(FULL_SCREEN_EXIT_SEQUENCE.includes("\u001B[?1000l"), false);
    assert.equal(FULL_SCREEN_EXIT_SEQUENCE.includes("\u001B[?1006l"), false);
    assert.equal(FULL_SCREEN_ENTER_SEQUENCE.includes("\u001B[?1007h"), true);
    assert.equal(FULL_SCREEN_EXIT_SEQUENCE.includes("\u001B[?1007l"), true);
  });

  it("does not write an identical frame twice", () => {
    const output = new CapturedOutput(true, 20, 3);
    const transcript = capture(output);
    const writer = new FullScreenWriter(output);

    writer.enter();
    writer.render(["alpha", "beta"]);
    const once = transcript.read();
    writer.render(["alpha", "beta"]);

    assert.equal(transcript.read(), once);
    writer.close();
  });

  it("can exit and re-enter while close remains idempotent", () => {
    const output = new CapturedOutput(true, 20, 3);
    const transcript = capture(output);
    const writer = new FullScreenWriter(output);

    writer.render(["retained"]);
    writer.enter();
    writer.exit();
    writer.exit();
    writer.enter();
    writer.close();
    const completed = transcript.read();
    writer.close();

    assert.equal(
      completed,
      FULL_SCREEN_ENTER_SEQUENCE +
        "\u001B[1;1H\u001B[2Kretained" +
        FULL_SCREEN_EXIT_SEQUENCE +
        FULL_SCREEN_ENTER_SEQUENCE +
        "\u001B[1;1H\u001B[2Kretained" +
        FULL_SCREEN_EXIT_SEQUENCE,
    );
    assert.equal(transcript.read(), completed);
  });

  it("repaints only the physical row whose content changed", () => {
    const output = new CapturedOutput(true, 20, 4);
    const transcript = capture(output);
    const writer = new FullScreenWriter(output);

    writer.enter();
    writer.render(["one", "two", "three"]);
    const beforeChange = transcript.read().length;
    writer.render(["one", "changed", "three"]);

    assert.equal(
      transcript.read().slice(beforeChange),
      "\u001B[2;1H\u001B[2Kchanged",
    );
    writer.close();
  });

  it("sanitizes terminal controls and clips rows by display width", () => {
    const output = new CapturedOutput(true, 5, 2);
    const transcript = capture(output);
    const writer = new FullScreenWriter(output);

    writer.enter();
    const beforeRender = transcript.read().length;
    writer.render(["ab\u001B[2Jcdef\u0007"]);
    const painted = transcript.read().slice(beforeRender);
    const visible = painted.replace("\u001B[1;1H\u001B[2K", "");

    assert.equal(painted, "\u001B[1;1H\u001B[2Kabcd…");
    assert.equal(displayWidth(stripAnsi(visible)), 5);
    assert.equal(painted.includes("\u0007"), false);
    assert.equal((painted.match(/\u001B\[2J/gu) ?? []).length, 0);
    writer.close();
  });

  it("rereads dimensions and fully repaints after a real resize", () => {
    const output = new CapturedOutput(true, 80, 24);
    const transcript = capture(output);
    let columns = 5;
    let rows = 2;
    const writer = new FullScreenWriter({
      output,
      columns: () => columns,
      rows: () => rows,
    });

    writer.enter();
    writer.render(["abcdefgh", "second", "third"]);
    const beforeResize = transcript.read().length;
    columns = 8;
    rows = 3;

    assert.equal(writer.resize(), true);
    assert.deepEqual(writer.size, { columns: 8, rows: 3 });
    assert.equal(
      transcript.read().slice(beforeResize),
      "\u001B[2J\u001B[H" +
        "\u001B[1;1H\u001B[2Kabcdefgh" +
        "\u001B[2;1H\u001B[2Ksecond" +
        "\u001B[3;1H\u001B[2Kthird",
    );
    const afterResize = transcript.read();
    assert.equal(writer.resize(), false);
    assert.equal(transcript.read(), afterResize);
    writer.close();
  });

  it("closes idempotently and stays silent for non-TTY output", () => {
    const ttyOutput = new CapturedOutput(true);
    const ttyTranscript = capture(ttyOutput);
    const writer = new FullScreenWriter(ttyOutput);
    writer.enter();
    writer.close();
    const closed = ttyTranscript.read();
    writer.close();
    writer.render(["ignored"]);

    assert.equal(ttyTranscript.read(), closed);

    const plainOutput = new CapturedOutput(false);
    const plainTranscript = capture(plainOutput);
    const plainWriter = new FullScreenWriter(plainOutput);
    plainWriter.enter();
    plainWriter.render(["not emitted"]);
    plainWriter.close();
    assert.equal(plainTranscript.read(), "");
  });
});
