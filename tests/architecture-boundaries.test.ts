import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, it } from "./harness.js";

const HOT_PATHS = ["runtime", "context", "command", "workspace"] as const;
const RETIRED_RUNTIME_SYMBOLS = [
  "execution_dispatched",
  "legacyRunningCommands",
  "legacyCommandValidation",
  "parseSemanticCandidatePatch",
  "legacyManagedWorktreeRoot",
  "legacyToolMetadata",
  "activateInstalledModelCatalog",
  "pruneConsumedReasoning",
  "captureValidationBaseline",
  "compareValidationBaseline",
  "validationBaseline",
  ".easy-code-srt-runtime",
] as const;

const RETIRED_PTY_DISCLOSURE_ACTIONS = [
  "toggle-thinking",
  "toggle-adjustment",
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(target)
      : entry.isFile() && entry.name.endsWith(".ts")
        ? [target]
        : [];
  });
}

describe("current protocol architecture boundaries", () => {
  it("keeps retired compatibility symbols out of Runtime hot paths", () => {
    for (const area of HOT_PATHS) {
      for (const file of sourceFiles(path.resolve("src", area))) {
        const source = readFileSync(file, "utf8");
        for (const retired of RETIRED_RUNTIME_SYMBOLS) {
          assert.equal(source.includes(retired), false, `${file} contains retired symbol ${retired}`);
        }
        assert.doesNotMatch(
          source,
          /(?:from|import\()\s*["'][^"']*legacy-cleanup/iu,
          `${file} imports the one-shot legacy cleanup module`,
        );
      }
    }
  });

  it("does not reintroduce retired persisted names or configuration aliases", () => {
    const patterns = [
      /["']thread_checkpoint["']/u,
      /["']thread_created["']/u,
      /["']context\.compacted["']/u,
      /["']progress\.validation\.baseline["']/u,
      /["']review_remediation["']/u,
      /schema_migrations/u,
      /env_key_aliases/u,
      /process\.env\.EASY_CODE_WORKSPACE(?!_ROOT)/u,
      /cleanup-legacy/u,
    ];
    for (const file of sourceFiles(path.resolve("src"))) {
      const source = readFileSync(file, "utf8");
      for (const pattern of patterns) {
        assert.doesNotMatch(source, pattern, `${file} contains retired protocol surface ${pattern}`);
      }
    }
  });

  it("keeps VS Code disclosure actions on the authenticated bridge", () => {
    for (const file of ["prompt-input.ts", "tui-input.ts"]) {
      const source = readFileSync(path.resolve("src", "cli", file), "utf8");
      for (const retired of RETIRED_PTY_DISCLOSURE_ACTIONS) {
        assert.equal(source.includes(retired), false, `${file} contains retired PTY action ${retired}`);
      }
    }
  });
});
