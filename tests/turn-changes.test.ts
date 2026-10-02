import assert from "node:assert/strict";
import path from "node:path";

import { turnChangedFiles } from "../src/app/turn-changes.js";
import type { FileChangeRecord } from "../src/core/types.js";
import { describe, it } from "./harness.js";

const ROOT = path.resolve("workspace");
const resolve = (relative: string) => {
  if (relative.startsWith("../")) throw new Error("outside the workspace");
  return path.join(ROOT, relative);
};

function change(
  file: string,
  operation: FileChangeRecord["operation"],
  extra: Partial<FileChangeRecord> = {},
): FileChangeRecord {
  return {
    path: file,
    operation,
    source: operation === "generated" || operation === "deleted_by_command" ? "command" : "file_tool",
    status: "applied",
    timestamp: "2026-10-02T00:00:00.000Z",
    ...extra,
  };
}

describe("files changed by one request", () => {
  it("classifies each file once as added, modified or deleted", () => {
    const files = turnChangedFiles(
      [
        change("src/new.ts", "create"),
        change("src/app.ts", "update", { beforeHash: "a" }),
        change("src/new.ts", "update", { beforeHash: "b" }),
        change("dist/out.js", "generated"),
        change("package-lock.json", "generated", { beforeHash: "c" }),
        change("old.ts", "delete", { beforeHash: "d" }),
      ],
      resolve,
    );
    assert.deepEqual(
      files.map(({ path: file, change: kind }) => [file, kind]),
      [
        ["src/new.ts", "created"],
        ["src/app.ts", "modified"],
        ["dist/out.js", "created"],
        ["package-lock.json", "modified"],
        ["old.ts", "deleted"],
      ],
    );
    assert.equal(files[0]?.absolutePath, path.join(ROOT, "src/new.ts"));
  });

  it("leaves out failed changes, files created and removed again, and paths outside the workspace", () => {
    const files = turnChangedFiles(
      [
        change("scratch.txt", "create"),
        change("scratch.txt", "delete"),
        change("blocked.ts", "update", { status: "policy_violation" }),
        change("../escape.ts", "update"),
        change("kept.ts", "update", { status: "verified" }),
      ],
      resolve,
    );
    assert.deepEqual(
      files.map((file) => file.path),
      ["kept.ts"],
    );
  });
});
