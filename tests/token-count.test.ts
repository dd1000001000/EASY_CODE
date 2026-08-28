import assert from "node:assert/strict";

import { formatTokenCount } from "../src/cli/token-count.js";
import { describe, it } from "./harness.js";

describe("CLI token counter", () => {
  it("uses no suffix below one thousand and decimal k/m/b suffixes above it", () => {
    assert.equal(formatTokenCount(0), "0");
    assert.equal(formatTokenCount(999), "999");
    assert.equal(formatTokenCount(1_000), "1k");
    assert.equal(formatTokenCount(12_400), "12.4k");
    assert.equal(formatTokenCount(999_950), "1m");
    assert.equal(formatTokenCount(1_250_000), "1.3m");
    assert.equal(formatTokenCount(2_500_000_000), "2.5b");
  });

  it("normalizes invalid, negative, and fractional estimates", () => {
    assert.equal(formatTokenCount(-5), "0");
    assert.equal(formatTokenCount(Number.NaN), "0");
    assert.equal(formatTokenCount(42.6), "43");
  });
});
