import assert from "node:assert/strict";

import {
  createTuiEditorState,
  reduceTuiInput,
  TuiInputCore,
  TuiInputDecoder,
  type TuiInputEvent,
} from "../src/cli/tui-input.js";
import { describe, it } from "./harness.js";

const PASTE_START = "\u001B[200~";
const PASTE_END = "\u001B[201~";

function event(type: TuiInputEvent["type"], events: readonly TuiInputEvent[]) {
  return events.find((candidate) => candidate.type === type);
}

describe("raw TUI input decoder", () => {
  it("decodes fragmented UTF-8 without splitting CJK or emoji", () => {
    const decoder = new TuiInputDecoder();
    const source = Buffer.from("A中文👨‍👩‍👧‍👦B");
    const events: TuiInputEvent[] = [];
    for (const byte of source) events.push(...decoder.feed(Buffer.from([byte])));
    assert.equal(
      events.filter((candidate) => candidate.type === "text")
        .map((candidate) => candidate.type === "text" ? candidate.text : "")
        .join(""),
      "A中文👨‍👩‍👧‍👦B",
    );
    assert.equal(decoder.awaitingInput, false);
  });

  it("emits a multiline bracketed paste as one atomic event", () => {
    const decoder = new TuiInputDecoder();
    const events = decoder.feed(`${PASTE_START}first\r\n第二行\nthird${PASTE_END}`);
    assert.deepEqual(events, [{ type: "paste", text: "first\n第二行\nthird" }]);
    assert.equal(decoder.awaitingInput, false);
  });

  it("fully resets paste capture so a second fragmented paste never freezes input", () => {
    const decoder = new TuiInputDecoder();
    const events: TuiInputEvent[] = [];
    events.push(...decoder.feed(`${PASTE_START}A\nB${PASTE_END}`));
    events.push(...decoder.feed(Buffer.from(PASTE_START).subarray(0, 3)));
    events.push(...decoder.feed(Buffer.concat([
      Buffer.from(PASTE_START).subarray(3),
      Buffer.from("C\nD"),
      Buffer.from(PASTE_END).subarray(0, 4),
    ])));
    events.push(...decoder.feed(Buffer.concat([
      Buffer.from(PASTE_END).subarray(4),
      Buffer.from("tail"),
    ])));

    assert.deepEqual(events, [
      { type: "paste", text: "A\nB" },
      { type: "paste", text: "C\nD" },
      { type: "text", text: "tail" },
    ]);
    assert.equal(decoder.awaitingInput, false);
  });

  it("decodes two paste packets and Enter from one input chunk in order", () => {
    const decoder = new TuiInputDecoder();
    assert.deepEqual(
      decoder.feed(`${PASTE_START}one${PASTE_END}${PASTE_START}two\n2${PASTE_END}\r`),
      [
        { type: "paste", text: "one" },
        { type: "paste", text: "two\n2" },
        { type: "key", key: "enter" },
      ],
    );
  });

  it("reports an explicit paste limit error, consumes its terminator, and recovers", () => {
    const decoder = new TuiInputDecoder({ maxPasteBytes: 3 });
    const first = decoder.feed(`${PASTE_START}1234`);
    assert.equal(event("input-error", first)?.type, "input-error");
    const second = decoder.feed(`${PASTE_END}ok`);
    assert.deepEqual(second, [{ type: "text", text: "ok" }]);
    assert.equal(decoder.awaitingInput, false);
  });

  it("allows an owner timeout to reset an incomplete paste before later input", () => {
    const decoder = new TuiInputDecoder();
    assert.deepEqual(decoder.feed(`${PASTE_START}unfinished`), []);
    assert.equal(decoder.flushIncomplete()[0]?.type, "input-error");
    assert.deepEqual(decoder.feed("works"), [{ type: "text", text: "works" }]);
  });

  it("decodes navigation, edit, submit, newline, and interrupt keys", () => {
    const decoder = new TuiInputDecoder();
    const sequence = [
      "\u001B[D",
      "\u001B[C",
      "\u001B[A",
      "\u001B[B",
      "\u001B[H",
      "\u001B[F",
      "\u001B[3~",
      "\u007F",
      "\u001B[5~",
      "\u001B[6~",
      "\u001B[13;2u",
      "\u000A",
      "\u000D",
      "\u0003",
    ].join("");
    assert.deepEqual(
      decoder.feed(sequence).filter((candidate) => candidate.type === "key"),
      [
        { type: "key", key: "left" },
        { type: "key", key: "right" },
        { type: "key", key: "up" },
        { type: "key", key: "down" },
        { type: "key", key: "home" },
        { type: "key", key: "end" },
        { type: "key", key: "delete" },
        { type: "key", key: "backspace" },
        { type: "key", key: "page-up" },
        { type: "key", key: "page-down" },
        { type: "key", key: "newline" },
        { type: "key", key: "newline" },
        { type: "key", key: "enter" },
        { type: "key", key: "interrupt" },
      ],
    );
  });

  it("supports enhanced CSI-u Unicode, functional keys, and release filtering", () => {
    const decoder = new TuiInputDecoder();
    assert.deepEqual(
      decoder.feed(
        "\u001B[20013u" + // 中
        "\u001B[97:65;2u" + // shifted A
        "\u001B[57354u" + // PageUp
        "\u001B[57357u" + // End
        "\u001B[99;5u" + // Ctrl+C
        "\u001B[13;1:3u", // released Enter (ignored)
      ),
      [
        { type: "text", text: "中" },
        { type: "text", text: "A" },
        { type: "key", key: "page-up" },
        { type: "key", key: "end" },
        { type: "key", key: "interrupt" },
      ],
    );
  });

  it("decodes SGR mouse click, release, modifiers, and wheel", () => {
    const decoder = new TuiInputDecoder();
    const events = decoder.feed(
      "\u001B[<20;12;7M\u001B[<0;12;7m\u001B[<64;9;3M\u001B[<65;9;3M",
    );
    assert.deepEqual(events, [
      {
        type: "mouse",
        action: "press",
        button: "left",
        column: 12,
        row: 7,
        shift: true,
        alt: false,
        ctrl: true,
      },
      {
        type: "mouse",
        action: "release",
        button: "left",
        column: 12,
        row: 7,
        shift: false,
        alt: false,
        ctrl: false,
      },
      {
        type: "mouse",
        action: "wheel-up",
        button: "none",
        column: 9,
        row: 3,
        shift: false,
        alt: false,
        ctrl: false,
      },
      {
        type: "mouse",
        action: "wheel-down",
        button: "none",
        column: 9,
        row: 3,
        shift: false,
        alt: false,
        ctrl: false,
      },
    ]);
  });

  it("decodes EASY CODE private OSC actions across arbitrary chunks", () => {
    const decoder = new TuiInputDecoder();
    const source = Buffer.from(
      "\u001B]6973;easy-code;paste-image\u0007" +
      "\u001B]6973;easy-code;toggle-thinking;42\u0007" +
      "\u001B]6973;easy-code;toggle-adjustment;9\u001B\\",
    );
    const events: TuiInputEvent[] = [];
    for (let index = 0; index < source.length; index += 2) {
      events.push(...decoder.feed(source.subarray(index, index + 2)));
    }
    assert.deepEqual(events, [
      { type: "paste-image" },
      { type: "toggle-thinking", id: 42 },
      { type: "toggle-adjustment", id: 9 },
    ]);
  });
});

describe("pure TUI editor core", () => {
  it("edits CJK and emoji only at grapheme boundaries", () => {
    let state = createTuiEditorState("A中👨‍👩‍👧‍👦B");
    state = reduceTuiInput(state, { type: "key", key: "left" }).state;
    assert.equal(state.cursor, "A中👨‍👩‍👧‍👦".length);
    state = reduceTuiInput(state, { type: "key", key: "backspace" }).state;
    assert.equal(state.text, "A中B");
    assert.equal(state.cursor, "A中".length);
    state = reduceTuiInput(state, { type: "key", key: "backspace" }).state;
    assert.equal(state.text, "AB");
  });

  it("moves vertically by terminal cells across CJK lines", () => {
    let state = createTuiEditorState("ab中x\n123456\n短", "ab中".length);
    state = reduceTuiInput(state, { type: "key", key: "down" }).state;
    assert.equal(state.cursor, "ab中x\n1234".length);
    state = reduceTuiInput(state, { type: "key", key: "down" }).state;
    assert.equal(state.cursor, state.text.length);
    state = reduceTuiInput(state, { type: "key", key: "up" }).state;
    assert.equal(state.cursor, "ab中x\n1234".length);
  });

  it("inserts multiline paste into the draft and only Enter submits", () => {
    const core = new TuiInputCore();
    assert.equal(core.feed(`${PASTE_START}A\nB${PASTE_END}`).state.text, "A\nB");
    const newline = core.feed("\u000A");
    assert.equal(newline.effects.length, 0);
    assert.equal(newline.state.text, "A\nB\n");
    const submitted = core.feed("\r");
    assert.deepEqual(submitted.effects, [{ type: "submit", text: "A\nB\n" }]);
    assert.equal(submitted.state.text, "");
  });

  it("routes viewer keys and mouse wheel to scroll without mutating the draft", () => {
    const core = new TuiInputCore({ initialText: "preserve", focus: "viewer" });
    const transition = core.feed(
      "\u001B[A\u001B[B\u001B[5~\u001B[6~\u001B[H\u001B[F\u001B[<64;2;2M",
    );
    assert.equal(transition.state.text, "preserve");
    assert.deepEqual(transition.effects, [
      { type: "scroll", direction: "up", unit: "line", amount: 1 },
      { type: "scroll", direction: "down", unit: "line", amount: 1 },
      { type: "scroll", direction: "up", unit: "page", amount: 1 },
      { type: "scroll", direction: "down", unit: "page", amount: 1 },
      { type: "scroll", direction: "start", unit: "document", amount: 1 },
      { type: "scroll", direction: "end", unit: "document", amount: 1 },
      { type: "scroll", direction: "up", unit: "line", amount: 3 },
    ]);
  });

  it("preserves a draft while focus changes between composer and viewer", () => {
    const core = new TuiInputCore({ initialText: "草稿" });
    core.setFocus("viewer");
    assert.equal(core.feed("ignored\u001B[6~").state.text, "草稿");
    core.setFocus("composer");
    assert.equal(core.feed("继续").state.text, "草稿继续");
  });
});
