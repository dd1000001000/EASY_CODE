import assert from "node:assert/strict";
import { describe, it } from "./harness.js";
import type { FileChangeRecord } from "../src/core/types.js";
import { targetedValidationChanges } from "../src/command/validation-changes.js";
import { isValidationTestPath } from "../src/progress/validation-paths.js";

const empty = { created: [], updated: [], deleted: [], truncated: false };
function change(path: string, operation: FileChangeRecord["operation"], beforeHash?: string, afterHash?: string): FileChangeRecord {
  return { path, operation, ...(beforeHash ? { beforeHash } : {}), ...(afterHash ? { afterHash } : {}),
    source: "file_tool", status: "applied", timestamp: "now" };
}

describe("targeted verification standard", () => {
  it("marks a pre-existing test weakened by the agent without scanning the repository", () => {
    const result = targetedValidationChanges([change("tests/test_a.py", "update", "original", "weakened")], empty);
    assert.deepEqual(result?.changedPaths, ["tests/test_a.py"]);
    assert.equal(isValidationTestPath("src/component.test.ts"), true);
    assert.deepEqual(targetedValidationChanges([change("src/component.test.ts", "update", "original", "weakened")], empty)?.changedPaths,
      ["src/component.test.ts"]);
  });
  it("does not treat an added self-written test as the original oracle", () => {
    assert.equal(targetedValidationChanges([change("tests/test_new.py", "create", undefined, "new")], empty), undefined);
    assert.equal(targetedValidationChanges([change("tests/test_new.py", "create", undefined, "new"),
      change("tests/test_new.py", "update", "new", "changed")], empty), undefined);
  });
  it("recognizes restoration and in-command test/config changes", () => {
    assert.equal(targetedValidationChanges([change("tests/test_a.py", "update", "original", "weakened"),
      change("tests/test_a.py", "update", "weakened", "original")], empty), undefined);
    assert.deepEqual(targetedValidationChanges([], { ...empty, updated: ["tests/test_a.py"] })?.changedPaths,
      ["tests/test_a.py"]);
    assert.deepEqual(targetedValidationChanges([], { ...empty, created: ["pytest.ini", "tests/test_added.py"] })?.changedPaths,
      ["pytest.ini"]);
  });
});
