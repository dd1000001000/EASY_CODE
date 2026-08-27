import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { assertSupportedNodeVersion, isDirectExecution } from "../src/index.js";
import { describe, it } from "./harness.js";

describe("CLI bootstrap", () => {
  it("enforces the documented Node.js 16.20.0 minimum", () => {
    assert.throws(
      () => assertSupportedNodeVersion("16.19.1"),
      /requires Node\.js >= 16\.20\.0/u,
    );
    assert.doesNotThrow(() => assertSupportedNodeVersion("16.20.0"));
    assert.doesNotThrow(() => assertSupportedNodeVersion("18.0.0"));
  });

  it("starts only when the module is the process entry point", () => {
    const entry = process.platform === "win32" ? "C:\\Temp\\easy-code.js" : "/tmp/easy-code.js";
    assert.equal(isDirectExecution(entry, pathToFileURL(entry).href), true);
    assert.equal(isDirectExecution(undefined, pathToFileURL(entry).href), false);
    assert.equal(
      isDirectExecution(entry, pathToFileURL(`${entry}.imported`).href),
      false,
    );
  });
});
