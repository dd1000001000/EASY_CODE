import assert from "node:assert/strict";

import {
  EditorHistory,
  atVerticalEdge,
  cursorColumn,
  deleteBackward,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  insertText,
  layoutRows,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveVertical,
  moveWordLeft,
  moveWordRight,
  rowIndexOfCursor,
  type EditorState,
} from "../src/ui/ink/composer-editor.js";
import { describe, it } from "./harness.js";

const at = (text: string, cursor = text.length): EditorState => ({ text, cursor });

describe("Ink composer editor", () => {
  it("inserts and deletes at the caret without splitting graphemes", () => {
    assert.deepEqual(insertText(at("ad", 1), "bc"), at("abcd", 3));
    assert.deepEqual(deleteBackward(at("ab")), at("a"));
    assert.deepEqual(deleteForward(at("ab", 0)), at("b", 0));
    // A flag emoji is two code points but one user-perceived character.
    assert.deepEqual(deleteBackward(at("a🇨🇳")), at("a"));
    assert.deepEqual(moveLeft(at("a👨‍👩‍👧")), at("a👨‍👩‍👧", 1));
    assert.deepEqual(moveRight(at("你好", 0)), at("你好", 1));
    assert.deepEqual(deleteBackward(at("x", 0)), at("x", 0));
  });

  it("edits by word and by line", () => {
    assert.deepEqual(deleteWordBackward(at("fix the bug")), at("fix the "));
    assert.deepEqual(moveWordLeft(at("fix the bug")), at("fix the bug", 8));
    assert.deepEqual(moveWordRight(at("fix the bug", 0)), at("fix the bug", 3));
    const text = "first\nsecond\nthird";
    assert.deepEqual(moveLineStart(at(text, 9)), at(text, 6));
    assert.deepEqual(moveLineEnd(at(text, 6)), at(text, 12));
    assert.deepEqual(deleteToLineEnd(at(text, 8)), at("first\nse\nthird", 8));
    assert.deepEqual(deleteToLineEnd(at(text, 5)), at("firstsecond\nthird", 5));
    assert.deepEqual(deleteToLineStart(at(text, 9)), at("first\nond\nthird", 6));
  });

  it("wraps rows by display width and keeps wide characters whole", () => {
    assert.deepEqual(
      layoutRows("abcdef", 4).map((row) => "abcdef".slice(row.start, row.end)),
      ["abcd", "ef"],
    );
    // Each CJK character is two cells wide, so three fit in six cells.
    assert.deepEqual(
      layoutRows("你好世界你", 6).map((row) => "你好世界你".slice(row.start, row.end)),
      ["你好世", "界你"],
    );
    assert.deepEqual(
      layoutRows("a\n\nb", 10).map((row) => [row.start, row.end]),
      [
        [0, 1],
        [2, 2],
        [3, 4],
      ],
    );
  });

  it("assigns a wrap boundary to the following row and a newline end to its own row", () => {
    const text = "abcdef";
    const rows = layoutRows(text, 4);
    assert.equal(rowIndexOfCursor(rows, 3), 0);
    assert.equal(rowIndexOfCursor(rows, 4), 1);
    assert.equal(rowIndexOfCursor(rows, 6), 1);
    const lines = layoutRows("ab\ncd", 10);
    assert.equal(rowIndexOfCursor(lines, 2), 0);
    assert.equal(rowIndexOfCursor(lines, 3), 1);
    assert.equal(cursorColumn("你好", layoutRows("你好", 10), 1), 2);
  });

  it("moves between display rows keeping the goal column", () => {
    const text = "abcdef\ngh\nijklmn";
    const down = moveVertical(at(text, 4), 10, 1);
    assert.deepEqual(down, at(text, 9));
    const again = moveVertical(down!, 10, 1, 4);
    assert.deepEqual(again, at(text, 14));
    assert.deepEqual(moveVertical(at(text, 14), 10, -1, 4), at(text, 9));
    assert.equal(moveVertical(at(text, 2), 10, -1), undefined);
    assert.equal(moveVertical(at(text, 12), 10, 1), undefined);
    assert.equal(atVerticalEdge(at(text, 2), 10, -1), true);
    assert.equal(atVerticalEdge(at(text, 9), 10, -1), false);
    // Soft-wrapped rows count as rows.
    assert.deepEqual(moveVertical(at("abcdef", 1), 4, 1), at("abcdef", 5));
  });

  it("recalls history and restores the in-progress draft", () => {
    const history = new EditorHistory(3);
    assert.equal(history.previous("draft"), undefined);
    for (const entry of ["one", "two", "two", "three", "four", "  "]) history.record(entry);
    assert.equal(history.previous("draft"), "four");
    assert.equal(history.previous("ignored"), "three");
    assert.equal(history.previous("ignored"), "two");
    assert.equal(history.previous("ignored"), undefined);
    assert.equal(history.next(), "three");
    assert.equal(history.next(), "four");
    assert.equal(history.next(), "draft");
    assert.equal(history.next(), undefined);
    history.previous("again");
    history.detach();
    assert.equal(history.next(), undefined);
  });
});
