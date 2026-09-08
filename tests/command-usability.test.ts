import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CommandPolicy } from "../src/command/policy.js";
import { CommandResolver } from "../src/command/resolver.js";
import { CommandRuntime } from "../src/command/runtime.js";
import { normalizeCommandRequest } from "../src/command/normalize-request.js";
import { resolveLocalCommandPath } from "../src/command/local-path.js";
import { autoApproveLocal } from "../src/command/local-approval.js";
import type { CommandExecutionBackend } from "../src/sandbox/types.js";
import type { ResolvedCommand, RunCommandOutput } from "../src/command/types.js";
import type { ToolContext } from "../src/core/types.js";
import { RunCommandTool, StartCommandTool, PollCommandTool } from "../src/tools/run-command.js";
import { projectToolResult } from "../src/tools/output-projection.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { describe, it } from "./harness.js";

const host: CommandExecutionBackend = {
  describe: () => ({ backend: "host-test-only", enforced: false, filesystem: "host", network: "host" }),
  async prepare(request) { return { ...request.command, metadata: this.describe(), cleanup: async () => undefined }; },
};
const context = (root: string): ToolContext => ({ workspaceRoot: root, mode: "code", threadId: "usability", turnId: "turn", approvalPolicy: "safe", requestApproval: async () => true, commandTimeoutMs: 5000, maxOutputChars: 256 });
async function fixture(run: (root: string, manager: WorkspaceManager) => Promise<void>) {
  const root = await mkdtemp(path.join(process.cwd(), ".easy-code-command-usability-"));
  try { await mkdir(path.join(root, "tests")); await run(root, await WorkspaceManager.create(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe("command usability and boundaries", () => {
  it("normalizes metadata idempotently and never promotes inspect to verification", () => {
    const normalized = normalizeCommandRequest({ program: "node", intent: "verify" });
    assert.equal(normalized.verificationKind, "custom");
    assert.deepEqual(normalizeCommandRequest(normalized), normalized);
    assert.equal(normalizeCommandRequest({ program: "node", intent: "inspect", verificationKind: "smoke_test" }).verificationKind, undefined);
  });

  it("accepts canonical inside cwd, multiline/literal argv, and relative programs based on cwd", async () => fixture(async (root, manager) => {
    const resolver = new CommandResolver(manager);
    for (const cwd of ["tests", "tests/..", "tests/../tests", path.join(root, "tests")]) {
      const resolved = await resolver.resolve({ program: process.execPath, args: ["-e", "const x = 1;\nconsole.log(x)", "|", "&"], cwd, intent: "run" });
      assert.ok(resolved.cwdAbsolute === root || resolved.cwdAbsolute === path.join(root, "tests"));
      assert.equal(resolved.args[2], "|");
    }
    const script = path.join(root, "tests", process.platform === "win32" ? "check&one.cmd" : "check&one");
    await writeFile(script, "echo ok"); await chmod(script, 0o755);
    const resolved = await resolver.resolve({ program: `./${path.basename(script)}`, cwd: "tests", intent: "run" });
    assert.equal(resolved.executablePath, script);
    await assert.rejects(() => resolver.resolve({ program: process.execPath, cwd: "../", intent: "run" }), /boundary/u);
    await assert.rejects(() => resolver.resolve({ program: process.execPath, args: ["bad\0argument"], intent: "run" }), /NUL/u);
    await assert.rejects(() => resolver.resolve({ program: process.execPath, cwd: "//server/share", intent: "run" }), /Network/u);
  }));

  it("resolves local executable aliases without granting extra filesystem or Plan authority", async () => fixture(async (root, manager) => {
    const filename = path.join(root, "tests", process.platform === "win32" ? "node.exe" : "node");
    try { await symlink(process.execPath, filename, "file"); }
    catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    const resolver = new CommandResolver(manager);
    const resolved = await resolver.resolve({ program: "./node" + (process.platform === "win32" ? ".exe" : ""), args: ["-e", "console.log(1)"], cwd: "tests", intent: "run" });
    assert.equal(resolved.executablePath, await realpath(process.execPath));
    assert.equal(new CommandPolicy().classify({ program: "node", intent: "inspect" }, resolved, "plan").effect, "deny");
    await assert.rejects(() => resolveLocalCommandPath("\\\\server\\share\\node.exe", root), /Network/u);
  }));

  it("canonicalizes workspace git -C reads without opening Git configuration or metadata writes", async () => fixture(async (root, manager) => {
    const resolver = new CommandResolver(manager);
    const command = await resolver.resolve({ program: "git", args: ["--no-pager", "-C", "tests", "-C", "..", "diff"], intent: "inspect" });
    assert.equal(command.cwdAbsolute, root);
    assert.deepEqual(command.args, ["--no-pager", "diff"]);
    assert.notEqual(new CommandPolicy().classify({ program: "git", intent: "inspect" }, command, "code").effect, "deny");
    for (const args of [["diff", "-p"], ["log", "-p", "-1"], ["show", "-p", "HEAD"]]) {
      assert.equal(new CommandPolicy().classify({ program: "git", intent: "inspect" },
        { ...command, args }, "plan").effect, "allow");
    }
    for (const args of [["-p", "diff"], ["--paginate", "log"], ["diff", "--ext-diff"], ["show", "--textconv"]]) {
      assert.equal(new CommandPolicy().classify({ program: "git", intent: "inspect" },
        { ...command, args }, "code").effect, "deny");
    }
    await assert.rejects(() => resolver.resolve({ program: "git", args: ["-C", "..", "diff"], intent: "inspect" }), /boundary/u);
    for (const args of [["-c", "core.pager=evil", "diff"], ["reset", "--hard"]]) {
      assert.equal(new CommandPolicy().classify({ program: "git", intent: "run" }, { ...command, trustedExecutable: true, args }, "code").effect, "deny");
    }
  }));

  it("distinguishes literal arguments, named file cleanup, recursive removal, system and unknown effects", () => {
    const base: ResolvedCommand = { program: "rg", executablePath: "/usr/bin/rg", args: ["|", "a"], cwdAbsolute: process.cwd(), cwdRelative: ".", executableInsideWorkspace: false, environment: {}, environmentKeys: [] };
    const policy = new CommandPolicy();
    for (const [program, args, risk] of [
      ["rg", ["|", "file"], "workspace"], ["rm", ["generated.tmp"], "workspace"],
      ["rm", ["-rf", "build"], "destructive"], ["mv", ["a", "b"], "workspace"],
      ["sh", ["-c", "rm -rf build"], "destructive"], ["sh", ["-c", "echo ok | cat"], "workspace"],
      ["sudo", ["anything"], "system"], ["unknown-admin-tool", [], "destructive"],
    ] as const) {
      const command = { ...base, executablePath: `/usr/bin/${program}`, args: [...args] };
      const decision = policy.classify({ program, intent: "run" }, command, "code");
      assert.equal(decision.risk, risk, program + args.join(" "));
      assert.equal(decision.effect, "ask");
      assert.equal(autoApproveLocal("auto_approve", decision.risk), risk === "workspace");
      assert.equal(policy.classify({ program, intent: "inspect" }, command, "plan").effect, "deny");
    }
  });

  it("reports a masked failure end-to-end and preserves normalized metadata through start/poll/projection", async () => fixture(async (root, manager) => {
    // An actual platform shell pipeline; no network and no host mutation outside fixture.
    await writeFile(path.join(root, "runtests.py"), "import sys\nprint('FAIL: test_boundary (tests.Batch)')\nprint('AssertionError: 2 != 3')\nprint('FAILED (failures=1)')\nsys.exit(1)\n");
    const runtime = new CommandRuntime(manager, new CommandPolicy(), host);
    const run = new RunCommandTool(manager, runtime);
    const result = await run.execute({ program: process.platform === "win32" ? "cmd" : "sh", args: process.platform === "win32"
      ? ["/c", "python runtests.py 2>&1 | findstr FAIL"] : ["-c", "python runtests.py 2>&1 | grep -E 'FAIL|Error'"], intent: "verify" }, context(root));
    const data = result.data as RunCommandOutput;
    assert.equal(data.exitCode, 0, JSON.stringify(result));
    assert.equal(data.validation?.status, "failed"); assert.equal(result.ok, false);
    assert.equal(data.requestMetadata?.verificationKind, "custom");
    const projected = projectToolResult(result);
    assert.equal((projected.data as RunCommandOutput).validation?.status, "failed");
    const start = new StartCommandTool(manager, runtime); const poll = new PollCommandTool(manager, runtime);
    let current = await start.execute({ program: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0),100)"], intent: "verify" }, context(root));
    assert.equal((current.data as RunCommandOutput).requestMetadata?.verificationKind, "custom");
    while ((current.data as { status: string }).status === "running") current = await poll.execute({ commandId: (current.data as RunCommandOutput).commandId, waitMs: 1000 }, context(root));
    assert.equal((current.data as RunCommandOutput).requestMetadata?.verificationKind, "custom");
    assert.equal((current.data as RunCommandOutput).validation?.status, "passed");
  }));
});
