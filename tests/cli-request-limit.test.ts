import assert from "node:assert/strict";
import { parseModelRequestLimit } from "../src/index.js";
import { describe, it } from "./harness.js";

describe("non-interactive model request limit", () => {
  it("accepts a positive safe integer", () => {
    assert.equal(parseModelRequestLimit("1"), 1);
    assert.equal(parseModelRequestLimit("250"), 250);
  });

  it("rejects zero, signs, fractions, and unsafe integers", () => {
    for (const value of ["0", "-1", "+1", "1.5", "abc", "9007199254740992"]) {
      assert.throws(() => parseModelRequestLimit(value), /positive/u);
    }
  });
});
