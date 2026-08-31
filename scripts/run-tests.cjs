"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const testsDir = path.resolve(__dirname, "..", "dist-test", "tests");
  const bundleHome = fs.mkdtempSync(path.join(os.tmpdir(), "easy-code-test-bundle-"));
  const manager = await import(pathToFileURL(
    path.join(projectRoot, "dist-test", "src", "prompt-bundle", "manager.js"),
  ).href);
  const generated = await import(pathToFileURL(
    path.join(projectRoot, "dist-test", "src", "prompt-bundle", "generated.js"),
  ).href);
  await manager.ensurePromptBundleForTesting({
    homeDirectory: bundleHome,
    packagedBundleDirectory: path.join(projectRoot, "resources", "prompt-bundle"),
    expectedManifestHash: generated.PACKAGED_PROMPT_BUNDLE_MANIFEST_HASH,
    runtimeVersion: generated.EASY_CODE_RUNTIME_VERSION,
  });
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
  fs.rmSync(bundleHome, { recursive: true, force: true });
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
