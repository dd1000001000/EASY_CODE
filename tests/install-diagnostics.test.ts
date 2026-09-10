import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { inspectInstallPaths } from "../src/install/diagnostics.js";
import { describe, it } from "./harness.js";

function launcherName(base: string): string {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

describe("installation path diagnostics", () => {
  it("finds conflicting npm and EASY CODE launcher directories without executing them", () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-install-paths-"));
    try {
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      mkdirSync(first);
      mkdirSync(second);
      for (const directory of [first, second]) {
        writeFileSync(path.join(directory, launcherName("npm")), "fixture\n");
        writeFileSync(path.join(directory, launcherName("easy-code")), "fixture\n");
      }

      const result = inspectInstallPaths({
        env: { PATH: [first, second].join(path.delimiter) },
        nodeExecutable: path.join(root, process.platform === "win32" ? "node.exe" : "node"),
      });
      assert.equal(result.multipleNpmLocations, true);
      assert.equal(result.conflictingEasyCodeLocations, true);
      assert.deepEqual(result.npm.map(({ directory }) => directory), [first, second]);
      assert.deepEqual(result.easyCode.map(({ directory }) => directory), [first, second]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated PATH entries and ignores missing launchers", () => {
    const root = mkdtempSync(path.join(tmpdir(), "easy-code-install-paths-"));
    try {
      const active = path.join(root, "active");
      const empty = path.join(root, "empty");
      mkdirSync(active);
      mkdirSync(empty);
      writeFileSync(path.join(active, launcherName("npm")), "fixture\n");
      writeFileSync(path.join(active, launcherName("easy-code")), "fixture\n");

      const result = inspectInstallPaths({
        env: { PATH: [active, empty, active].join(path.delimiter) },
      });
      assert.equal(result.multipleNpmLocations, false);
      assert.equal(result.conflictingEasyCodeLocations, false);
      assert.equal(result.npm.length, 1);
      assert.equal(result.easyCode.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
