"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const testsDir = path.resolve(__dirname, "..", "dist-test", "tests");
  const harnessPath = path.join(testsDir, "harness.js");
  const harness = await import(pathToFileURL(harnessPath).href);
  const files = fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.js"))
    .sort();

  for (const file of files) {
    await import(pathToFileURL(path.join(testsDir, file)).href);
  }

  const failures = await harness.runRegisteredTests();
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
