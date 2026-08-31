import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { EasyCodePaths } from "../src/config/defaults.js";
import {
  EASY_CODE_DATA_ROOT_MARKER,
  ensureEasyCodeDataRootMarker,
} from "../src/storage/data-root.js";
import { createStorage } from "../src/storage/database.js";
import {
  cleanupEasyCodeUserData,
  resolveNpmRemovalInvocation,
} from "../src/uninstall/index.js";
import { describe, it } from "./harness.js";

function fixture(): {
  readonly root: string;
  readonly home: string;
  readonly data: string;
  readonly paths: EasyCodePaths;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-uninstall-test-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  return {
    root,
    home,
    data,
    paths: {
      dataDir: data,
      configDir: path.join(root, "config"),
      cacheDir: path.join(root, "cache"),
    },
  };
}

function put(target: string, content = "private\n"): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

describe("EASY CODE uninstall cleanup", () => {
  it("marks every Runtime-created data root for safe future cleanup", () => {
    const test = fixture();
    try {
      const storage = createStorage(test.data);
      storage.close();
      assert.deepEqual(
        JSON.parse(readFileSync(path.join(test.data, EASY_CODE_DATA_ROOT_MARKER), "utf8")),
        { product: "easy-code-agent", formatVersion: 1 },
      );
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });

  it("deletes prompts and all memory-bearing entries while preserving Worktrees and siblings", async () => {
    const test = fixture();
    try {
      put(path.join(test.home, ".easy_code", "bundles", "prompt-1.0.0", "system.md"));
      put(path.join(test.home, ".easy-code", "legacy.txt"));
      put(path.join(test.data, "easy-code.db"));
      put(path.join(test.data, "easy-code.db-journal"));
      put(path.join(test.data, "threads", "thread_test", "events.jsonl"));
      put(path.join(test.data, "attachments", "image.png"));
      put(path.join(test.data, "artifacts", "result.json"));
      put(path.join(test.data, "subagent-environments", "environment.json"));
      put(path.join(test.data, "subagent-artifacts", "artifact.json"));
      put(path.join(test.data, "worktrees", "retained", "source.ts"), "keep\n");
      put(path.join(test.data, "user-sentinel.txt"), "keep\n");

      const result = await cleanupEasyCodeUserData({
        homeDirectory: test.home,
        defaultPaths: test.paths,
        dataDirectories: [test.data],
      });

      assert.equal(existsSync(path.join(test.home, ".easy_code")), false);
      assert.equal(existsSync(path.join(test.home, ".easy-code")), false);
      for (const name of [
        "easy-code.db",
        "easy-code.db-journal",
        "threads",
        "attachments",
        "artifacts",
        "subagent-environments",
        "subagent-artifacts",
      ]) {
        assert.equal(existsSync(path.join(test.data, name)), false, name);
      }
      assert.equal(readFileSync(path.join(test.data, "worktrees", "retained", "source.ts"), "utf8"), "keep\n");
      assert.equal(readFileSync(path.join(test.data, "user-sentinel.txt"), "utf8"), "keep\n");
      assert(result.preserved.some((entry) => entry.endsWith("worktrees")));
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });

  it("removes an empty owned data root and is idempotent", async () => {
    const test = fixture();
    try {
      ensureEasyCodeDataRootMarker(test.data);
      put(path.join(test.data, "easy-code.db"));
      put(path.join(test.data, "threads", "thread_test", "events.jsonl"));

      await cleanupEasyCodeUserData({
        homeDirectory: test.home,
        defaultPaths: test.paths,
        dataDirectories: [test.data],
      });
      assert.equal(existsSync(test.data), false);
      const again = await cleanupEasyCodeUserData({
        homeDirectory: test.home,
        defaultPaths: test.paths,
        dataDirectories: [test.data],
      });
      assert(again.absent.length >= 3);
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });

  it("does not follow a Prompt Bundle junction", async () => {
    const test = fixture();
    const outside = path.join(test.root, "outside");
    try {
      put(path.join(outside, "sentinel.txt"), "outside\n");
      symlinkSync(outside, path.join(test.home, ".easy_code"), process.platform === "win32" ? "junction" : "dir");

      await cleanupEasyCodeUserData({
        homeDirectory: test.home,
        defaultPaths: test.paths,
        dataDirectories: [path.join(test.root, "absent-data")],
      });
      assert.equal(existsSync(path.join(test.home, ".easy_code")), false);
      assert.equal(readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "outside\n");
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });

  it("skips a custom root without an ownership marker", async () => {
    const test = fixture();
    const custom = path.join(test.root, "shared-custom-root");
    try {
      put(path.join(custom, "easy-code.db"));
      put(path.join(custom, "threads", "unrelated.txt"));
      const result = await cleanupEasyCodeUserData({
        homeDirectory: test.home,
        defaultPaths: test.paths,
        dataDirectories: [custom],
      });
      assert.equal(existsSync(path.join(custom, "easy-code.db")), true);
      assert.equal(existsSync(path.join(custom, "threads", "unrelated.txt")), true);
      assert.match(result.warnings.join("\n"), /ownership marker/u);
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });

  it("recognizes an older custom data root through its exact storage signature", async () => {
    const test = fixture();
    const custom = path.join(test.root, "legacy-custom-root");
    try {
      put(path.join(custom, "easy-code.db"), "SQLite format 3\0legacy-data");
      mkdirSync(path.join(custom, "threads"), { recursive: true });
      mkdirSync(path.join(custom, "artifacts"), { recursive: true });
      await cleanupEasyCodeUserData({
        homeDirectory: test.home,
        defaultPaths: test.paths,
        dataDirectories: [custom],
      });
      assert.equal(existsSync(custom), false);
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });

  it("fails closed while another process owns the memory database lock", async () => {
    const test = fixture();
    try {
      put(path.join(test.home, ".easy_code", "active.json"));
      put(path.join(test.data, "easy-code.db"));
      put(
        path.join(test.data, "easy-code.db.easy-code-advisory-lock", "owner.json"),
        "{}\n",
      );
      await assert.rejects(
        cleanupEasyCodeUserData({
          homeDirectory: test.home,
          defaultPaths: test.paths,
          dataDirectories: [test.data],
        }),
        /memory is in use/u,
      );
      assert.equal(existsSync(path.join(test.home, ".easy_code", "active.json")), true);
      assert.equal(existsSync(path.join(test.data, "easy-code.db")), true);
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });

  it("cleans only known entries from a marked custom root", async () => {
    const test = fixture();
    const custom = path.join(test.root, "custom-data");
    try {
      mkdirSync(custom, { recursive: true });
      ensureEasyCodeDataRootMarker(custom);
      put(path.join(custom, "easy-code.db"));
      put(path.join(custom, "threads", "thread_test", "events.jsonl"));
      put(path.join(custom, "keep.txt"), "keep\n");
      await cleanupEasyCodeUserData({
        homeDirectory: test.home,
        defaultPaths: test.paths,
        dataDirectories: [custom],
      });
      assert.equal(existsSync(path.join(custom, "easy-code.db")), false);
      assert.equal(existsSync(path.join(custom, "threads")), false);
      assert.equal(readFileSync(path.join(custom, "keep.txt"), "utf8"), "keep\n");
      assert.equal(existsSync(path.join(custom, EASY_CODE_DATA_ROOT_MARKER)), true);
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });

  it("builds a structured npm global-removal invocation", () => {
    const test = fixture();
    try {
      const npmCli = path.join(test.root, "npm-cli.js");
      put(npmCli, "// fixture\n");
      assert.deepEqual(
        resolveNpmRemovalInvocation({ npm_execpath: npmCli }, "C:\\Node\\node.exe", "win32"),
        {
          command: "C:\\Node\\node.exe",
          args: [npmCli, "uninstall", "--global", "easy-code-agent"],
          shell: false,
        },
      );
    } finally {
      rmSync(test.root, { recursive: true, force: true });
    }
  });
});
