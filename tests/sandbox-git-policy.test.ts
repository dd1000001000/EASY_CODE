import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sandboxGitArgs, sandboxGitEnvironment } from "../src/sandbox/git-policy.js";
import { describe, it } from "./harness.js";

const exec = promisify(execFile);
describe("sandbox Git policy", () => {
  it("only adds diff flags to supported subcommands and preserves option values and paths", () => {
    for (const command of ["diff", "show", "log", "diff-files", "diff-index", "diff-tree"]) {
      const args = sandboxGitArgs("git", ["-C", "diff", "-c", "core.fsmonitor=evil", command,
        "-S", "--", "--", "a b.txt"]);
      assert.deepEqual(args.slice(-4), ["-S", "--", "--", "a b.txt"]);
      assert.ok(args.indexOf("core.fsmonitor=false") > args.indexOf("core.fsmonitor=evil"));
      assert.deepEqual(args.slice(args.indexOf("--no-ext-diff"), args.indexOf("-S")), ["--no-ext-diff", "--no-textconv"]);
      assert.ok(!args.includes("diff.external="));
      assert.deepEqual(args.slice(0, 4), ["-C", "diff", "-c", "core.fsmonitor=evil"]);
    }
    for (const args of [["diff", "--ext-diff"], ["show", "--textconv"], ["diff", "--ext-diff", "-S"]]) {
      assert.throws(() => sandboxGitArgs("git", args), /enabling options are disabled/u);
    }
    for (const command of ["status", "rev-parse", "branch", "ls-files", "--version"]) {
      assert.ok(!sandboxGitArgs("git.exe", [command]).includes("--no-ext-diff"));
    }
    assert.deepEqual(sandboxGitArgs("python", ["-c", "print('git diff')"]), ["-c", "print('git diff')"]);
  });

  it("drops inherited Git overrides for direct and indirect invocations", () => {
    const source = { PATH: "bin", GIT_EXTERNAL_DIFF: "evil", GIT_DIFF_OPTS: "evil", GIT_CONFIG_PARAMETERS: "evil",
      GIT_CONFIG_COUNT: "99", GIT_CONFIG_KEY_98: "diff.external", GIT_CONFIG_VALUE_98: "evil", git_external_diff: "evil" };
    const env = sandboxGitEnvironment(source, "/empty");
    assert.equal(env.GIT_EXTERNAL_DIFF, undefined);
    assert.equal(env.git_external_diff, undefined);
    assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(env.GIT_CONFIG_KEY_98, undefined);
    assert.equal(env.GIT_CONFIG_COUNT, "3");
    assert.equal(env.GIT_CONFIG_GLOBAL, "/empty");
    assert.equal(env.PATH, "bin");
    assert.equal(source.GIT_EXTERNAL_DIFF, "evil");
  });

  it("runs real built-in diffs despite empty/external/textconv configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-git-policy-"));
    try {
      const env = sandboxGitEnvironment(process.env, path.join(root, "empty-global"));
      const raw = (args: string[]) => exec("git", args, { cwd: root, env });
      const safe = (args: string[]) => exec("git", sandboxGitArgs("git", args), { cwd: root, env });
      await raw(["init", "-q"]);
      await writeFile(path.join(root, "file.txt"), "before\n");
      await writeFile(path.join(root, ".gitattributes"), "*.txt diff=hostile\n");
      await raw(["add", "."]);
      await raw(["-c", "user.name=Sandbox Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline"]);
      await writeFile(path.join(root, "file.txt"), "after\n");
      await raw(["config", "diff.external", ""]);
      await assert.rejects(raw(["diff", "--", "file.txt"]), /external diff|cannot run/iu);
      assert.match((await safe(["diff", "--", "file.txt"])).stdout, /\+after/u);
      await raw(["config", "diff.external", "false"]);
      await raw(["config", "diff.hostile.command", "false"]);
      await raw(["config", "diff.hostile.textconv", "false"]);
      const configBefore = await readFile(path.join(root, ".git", "config"), "utf8");
      assert.match((await safe(["diff", "--", "file.txt"])).stdout, /\+after/u);
      // Missing option values must still fail, not consume a protection flag.
      await assert.rejects(safe(["diff", "-S", "--", "--", "file.txt"]), /requires a value/u);
      assert.equal((await safe(["diff", "-S--", "--", "file.txt"])).stdout, "");
      await raw(["add", "file.txt"]);
      assert.match((await safe(["diff", "--cached", "--", "file.txt"])).stdout, /\+after/u);
      assert.match((await safe(["show", "HEAD", "--", "file.txt"])).stdout, /\+before/u);
      assert.match((await safe(["log", "-p", "-1", "--", "file.txt"])).stdout, /\+before/u);
      assert.match((await safe(["status", "--porcelain"])).stdout, /file.txt/u);
      assert.equal(await readFile(path.join(root, ".git", "config"), "utf8"), configBefore);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
