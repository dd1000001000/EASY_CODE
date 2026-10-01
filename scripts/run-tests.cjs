"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

// Tests must not inherit a host VS Code terminal's EASY CODE menu bridge. With these set, every
// Terminal under test connects to the real extension and defers its modal overlays until the host
// acknowledges, which breaks synchronous UI assertions. Bridge tests pass their own environment.
for (const name of ["EASY_CODE_VSCODE_BRIDGE_ENDPOINT", "EASY_CODE_VSCODE_BRIDGE_TOKEN"]) delete process.env[name];
// Approvals and long requests raise desktop notifications; a test run must not pop real ones.
// Notifier tests pass their own environment.
process.env.EASY_CODE_NOTIFICATIONS = "off";
// Sandbox tests must never read or update the developer's real Codex home (~/.codex).
// Account-sharing tests pass their own homes.
process.env.EASY_CODE_SHARE_SANDBOX_ACCOUNTS = "off";

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const testsDir = path.resolve(__dirname, "..", "dist-test", "tests");
  const bundleHome = fs.mkdtempSync(path.join(os.tmpdir(), "easy-code-test-bundle-"));
  const manager = await import(
    pathToFileURL(path.join(projectRoot, "dist-test", "src", "prompt-bundle", "manager.js")).href
  );
  const generated = await import(
    pathToFileURL(path.join(projectRoot, "dist-test", "src", "prompt-bundle", "generated.js")).href
  );
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
    .filter((name) => process.argv.length <= 2 || process.argv.slice(2).includes(name))
    .sort();

  if (files.length === 0) throw new Error("No matching test files");

  for (const file of files) {
    await import(pathToFileURL(path.join(testsDir, file)).href);
  }

  const failures = await harness.runRegisteredTests();
  fs.rmSync(bundleHome, { recursive: true, force: true });
  if (failures > 0) process.exitCode = 1;
}

let completed = false;
process.once("beforeExit", () => {
  if (completed) return;
  process.stderr.write(
    "Test runner exited before completing all tests (an unresolved promise may have no live handles).\n",
  );
  process.exitCode = 1;
});

main()
  .then(() => {
    completed = true;
  })
  .catch((error) => {
    completed = true;
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  });
