import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("recognizes an npm entry path reached through a directory link", () => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), "easy-code-entry-link-"));
    const sourceDirectory = path.join(temporary, "source");
    const linkedDirectory = path.join(temporary, "global-install");
    const entryName = "index.js";
    try {
      mkdirSync(sourceDirectory);
      writeFileSync(path.join(sourceDirectory, entryName), "// fixture\n", "utf8");
      symlinkSync(
        sourceDirectory,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );

      assert.equal(
        isDirectExecution(
          path.join(linkedDirectory, entryName),
          pathToFileURL(path.join(sourceDirectory, entryName)).href,
        ),
        true,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
