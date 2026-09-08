import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CommandPolicy } from "../src/command/policy.js";
import { CommandRuntime } from "../src/command/runtime.js";
import { ExecutionJournal } from "../src/command/execution-journal.js";
import { grantCommandApprovalPrefix, isCommandApprovalPrefixGranted } from "../src/command/approval.js";
import { containWindowsWorker } from "../src/command/windows-job.js";
import { encodeSandboxControl, SandboxControlStream } from "../src/sandbox/control.js";
import type { CommandExecutionBackend, SandboxWorkerControl } from "../src/sandbox/types.js";
import type { ToolContext } from "../src/core/types.js";
import type { ResolvedCommand } from "../src/command/types.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { assertWindowsAclCleanup } from "../src/sandbox/windows-cleanup.js";
import { AnthropicSandboxBackend } from "../src/sandbox/anthropic-backend.js";
import { redactSensitiveInformation } from "../src/memory/sensitive.js";
import { describe, it } from "./harness.js";

function context(root: string): ToolContext { return { workspaceRoot: root, mode: "code", threadId: "thread", turnId: "turn", approvalPolicy: "safe", requestApproval: async () => true, commandExecutionMode: "auto_approve", commandTimeoutMs: 10000, maxOutputChars: 256 }; }

describe("command security floor", () => {
  it("refuses Windows Plan commands before sandbox effects even if policy says allow", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-readonly-test-"));
    try {
      const workspace = await WorkspaceManager.create(root);
      const before = await readdir(root);
      const backend = new AnthropicSandboxBackend(workspace, { platform: "win32" });
      const command: ResolvedCommand = { program: "node", executablePath: process.execPath,
        args: ["--version"], cwdAbsolute: root, cwdRelative: ".", executableInsideWorkspace: false,
        trustedExecutable: true, environment: {}, environmentKeys: [] };
      await assert.rejects(() => backend.prepare({ commandId: "plan-must-not-start", command,
        context: { ...context(root), mode: "plan", commandExecutionMode: "unrestricted" },
        commandPreview: "node --version", policyDecision: {
          ...new CommandPolicy().classify({ program: "node", intent: "inspect" }, command, "plan"),
          effect: "allow", reason: "test classifier",
        } }),
      /file-tools-only/u);
      assert.deepEqual(await readdir(root), before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps redaction placeholders stable across repeated audit/render passes", () => {
    const text = redactSensitiveInformation("token=ghp_1234567890123456789012345");
    assert.equal(redactSensitiveInformation(text), text);
    assert.equal(text, "token=[REDACTED TOKEN]");
  });
  it("rejects silent SDK ACL cleanup failure instead of trusting reset resolution", () => {
    assertWindowsAclCleanup([]);
    assertWindowsAclCleanup([{ status: "revoked" }]);
    assert.throws(() => assertWindowsAclCleanup(undefined), /confirmed/u);
    assert.throws(() => assertWindowsAclCleanup([{ status: "accessDenied" }]), /confirmed/u);
  });
  it("keeps historical interpreter grants inert and disallows new blanket grants", () => {
    for (const filename of ["C:\\tools\\cmd.exe", "/usr/bin/python3", "/usr/bin/npm", process.execPath]) {
      const platform = filename.startsWith("C:") ? "win32" : filename.startsWith("/") ? "linux" : process.platform;
      assert.throws(() => grantCommandApprovalPrefix([], filename, platform), /per-invocation/u);
      assert.equal(isCommandApprovalPrefixGranted([filename], filename, platform), false);
    }
  });

  it("does not classify a workspace git shim or mutating branch command as Plan inspection", () => {
    const base: ResolvedCommand = { program: "git", executablePath: path.resolve("git.exe"), args: ["status"], cwdAbsolute: process.cwd(), cwdRelative: ".", executableInsideWorkspace: true, trustedExecutable: true, environment: {}, environmentKeys: [] };
    const policy = new CommandPolicy();
    assert.equal(policy.classify({ program: "git", intent: "inspect" }, base, "plan").effect, "deny");
    assert.equal(policy.classify({ program: "git", intent: "inspect" }, { ...base, executableInsideWorkspace: false, args: ["branch", "-D", "topic"] }, "plan").effect, "deny");
    assert.equal(policy.classify({ program: "git", intent: "inspect" }, { ...base, executableInsideWorkspace: false }, "plan").effect, "allow");
  });

  it("uses a bounded, monotonic control stream independent of display text", () => {
    const seen: SandboxWorkerControl[] = [];
    const stream = new SandboxControlStream("owned", event => seen.push(event), true);
    const ready = encodeSandboxControl("owned", { type: "ready", backend: "anthropic-srt-linux" });
    stream.push(ready.slice(0, 10)); stream.push(ready.slice(10));
    stream.push(encodeSandboxControl("owned", { type: "execution_dispatched" }));
    stream.push(encodeSandboxControl("owned", { type: "execution_exited", exitCode: 0 }));
    assert.equal(seen.length, 3);
    assert.throws(() => stream.push(ready), /transition/u);
    assert.throws(() => new SandboxControlStream("owned", () => {}, true).push("untrusted text\n"), /Malformed/u);
  });

  it("does not interpret an orphaned lease as retryable or silently clear it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-lease-test-"));
    try {
      await writeFile(path.join(root, "command_orphan.lease"), "unknown");
      assert.throws(() => new ExecutionJournal(root).assertRecovered(), /Unfinished/u);
      assert.equal(await readFile(path.join(root, "command_orphan.lease"), "utf8"), "unknown");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retains exit evidence despite clipped output and cleanup failure, then quarantines Resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-lifecycle-test-"));
    try {
      const workspaceRoot = path.join(root, "workspace"); await mkdir(workspaceRoot);
      const manager = await WorkspaceManager.create(workspaceRoot);
      const metadata = { backend: "anthropic-srt-windows" as const, enforced: true, filesystem: "workspace-write" as const, network: "denied" as const };
      const backend: CommandExecutionBackend = { describe: () => metadata, async prepare(request) {
        const events: SandboxWorkerControl[] = [{ type: "ready", backend: "anthropic-srt-windows" }, { type: "execution_dispatched" }, { type: "execution_exited", exitCode: 0 }, { type: "cleanup_error", message: "ACL restore timed out" }];
        const records = events.map(event => encodeSandboxControl(request.commandId, event)).join("");
        const script = `const fs=require('fs');const go=()=>{process.stdout.write('noise'.repeat(10000));fs.writeSync(3,${JSON.stringify(records)});process.exit(0)};if(process.platform==='win32')process.stdin.once('data',go);else go();`;
        return { executablePath: process.execPath, args: ["-e", script], cwdAbsolute: workspaceRoot, environment: { ...process.env }, metadata, controlPipe: true, cleanup: async () => { throw new Error("Should not release a failed cleanup lease"); } };
      } };
      const events: string[] = [];
      const options = { quarantinePath: path.join(root, "quarantine.json"), lifecycleDirectory: path.join(root, "leases"), recordLifecycle: (_context: ToolContext, _id: string, type: string) => { events.push(type); } };
      const runtime = new CommandRuntime(manager, undefined, backend, undefined, options);
      const result = await runtime.run({ program: "node", args: ["--version"], intent: "inspect" }, context(workspaceRoot));
      assert.equal(result.exitCode, 0);
      assert.equal(result.status, "exited");
      assert.equal(result.lifecycle?.cleanup, "failed");
      assert.equal(result.lifecycle?.execution, "exited");
      assert.equal(result.stdout.truncated, true);
      assert.ok(events.includes("command.execution_exited"));
      assert.throws(() => runtime.assertEnvironmentSafe(), /quarantined/u);
      assert.throws(() => new CommandRuntime(manager, undefined, backend, undefined, options).assertEnvironmentSafe(), /quarantined/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("confirms Windows descendant termination before allowing ACL cleanup", async () => {
    if (process.platform !== "win32") return;
    const worker = spawn(process.execPath, ["-e", "process.stdin.on('data',()=>{const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});process.stdout.write(String(c.pid)+'\\n')});process.stdin.resume();"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    try {
      const job = await containWindowsWorker(worker.pid!);
      const childPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture did not report descendant")), 5000);
        worker.stdout.once("data", chunk => { clearTimeout(timer); resolve(Number(chunk.toString().trim())); });
        worker.stdin.write("SPAWN\n");
      });
      try {
        await Promise.all([job.quiesce(), job.quiesce()]);
        assert.throws(() => process.kill(childPid, 0));
        process.kill(worker.pid!, 0);
        const nextChildPid = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Second fixture child did not start")), 5000);
          worker.stdout.once("data", chunk => { clearTimeout(timer); resolve(Number(chunk.toString().trim())); });
          worker.stdin.write("SPAWN AGAIN\n");
        });
        await job.quiesce();
        assert.throws(() => process.kill(nextChildPid, 0), "a previous QUIET record must not acknowledge a new cleanup");
      } finally { assert.equal((await job.stop()).confirmed, true); }
    } finally { worker.kill(); }
  });
});
