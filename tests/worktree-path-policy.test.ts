import assert from "node:assert/strict";

import {
  assessWorktreePaths,
  WINDOWS_WORKTREE_SAFE_PATH_CHARS,
  WorktreePathTooLongError,
} from "../src/workspace/worktree-path-policy.js";
import { describe, it } from "./harness.js";

describe("worktree path policy", () => {
  it("finds the longest predicted Windows checkout path", () => {
    const root = "C:\\ec\\wt\\r-1234\\e-5678";
    const relative = `nested/${"x".repeat(220)}.py`;
    const assessment = assessWorktreePaths(root, ["short.txt", relative], "win32");

    assert.equal(assessment.longestRelativePath, relative);
    assert.equal(assessment.longestPathChars, assessment.longestAbsolutePath.length);
    assert.equal(assessment.safe, false);
    assert.equal(assessment.safeLimit, WINDOWS_WORKTREE_SAFE_PATH_CHARS);
  });

  it("does not apply the Windows compatibility limit on other platforms", () => {
    const assessment = assessWorktreePaths(
      "/tmp/easy-code/worktree",
      [`nested/${"x".repeat(300)}.py`],
      "linux",
    );
    assert.equal(assessment.safe, true);
  });

  it("rejects repository paths that escape the checkout root", () => {
    assert.throws(
      () => assessWorktreePaths("C:\\ec\\wt", ["../outside.txt"], "win32"),
      /unsafe Worktree path/u,
    );
  });

  it("provides a structured actionable error", () => {
    const assessment = assessWorktreePaths(
      "C:\\ec\\wt",
      [`nested/${"x".repeat(240)}.py`],
      "win32",
    );
    const error = new WorktreePathTooLongError(assessment);
    assert.equal(error.name, "WorktreePathTooLongError");
    assert.equal(error.assessment, assessment);
    assert.match(error.message, /predicted Windows path length/u);
    assert.match(error.message, /remove generated\/deeply nested tracked files/u);
  });
});
