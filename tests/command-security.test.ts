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
import { NativeSandboxBackend } from "../src/sandbox/native-backend.js";
import { redactSensitiveInformation } from "../src/memory/sensitive.js";
import { describe, it } from "./harness.js";
import { RunCommandTool } from "../src/tools/run-command.js";
import { benchmarkResultControls } from "../src/sandbox/benchmark-result.js";
import { NativeAppServerRequestError } from "../src/sandbox/app-server-client.js";
import { sandboxBoundaryResultFromError } from "../src/sandbox/native-command-error.js";
import { SandboxBoundaryStore } from "../src/command/sandbox-boundary.js";

function context(root: string): ToolContext { return { workspaceRoot: root, mode: "code", threadId: "thread", turnId: "turn", approvalPolicy: "safe", requestApproval: async () => true, commandExecutionMode: "auto_approve", commandTimeoutMs: 10000, maxOutputChars: 256 }; }

function boundaryDenyingBackend(workspaceRoot: string, backend: "native" | "benchmark-container"): CommandExecutionBackend {
  const metadata = { backend, enforced: true, filesystem: backend === "native" ? "host" as const : "container" as const, network: "denied" as const };
  return { describe: () => metadata, async prepare(request) {
    const events: SandboxWorkerControl[] = [
      { type: "ready", backend },
      { type: "execution_dispatched" },
      { type: "sandbox_boundary_violation", access: "write", destinationCategory: "outside_workspace",
        destination: path.join(workspaceRoot, "..", "cache"), message: "sandbox denied write outside workspace" },
      { type: "execution_exited", exitCode: 1, outcome: "exited" },
    ];
    const frames = events.map(event => encodeSandboxControl(request.commandId, event)).join("");
    const script = `const fs=require('fs');const go=()=>{fs.writeSync(3,${JSON.stringify(frames)});process.exit(1)};if(process.platform==='win32')process.stdin.once('data',go);else go();`;
    return { executablePath: process.execPath, args: ["-e", script], cwdAbsolute: workspaceRoot,
      environment: { ...process.env }, metadata, controlPipe: true, cleanupAfterWorkerExit: true,
      cleanup: async () => undefined };
  } };
}

describe("command security floor", () => {
  it("returns an output-limit failure without poisoning a confirmed-clean worker or reporting a pass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-output-limit-"));
    try {
      const workspaceRoot = path.join(root, "workspace"); await mkdir(workspaceRoot);
      const manager = await WorkspaceManager.create(workspaceRoot);
      let calls = 0, cleanups = 0;
      const metadata = { backend: "benchmark-container" as const, enforced: true, filesystem: "container" as const, network: "denied" as const };
      const backend: CommandExecutionBackend = { describe: () => metadata, async prepare(request) {
        const outcome = ++calls === 1 ? "output_limit" : "exited";
        const events: SandboxWorkerControl[] = [{ type: "ready", backend: "benchmark-container" }, { type: "execution_dispatched" },
          ...benchmarkResultControls({ version: 2, exitCode: 0, outcome, cleanup: "confirmed", workerRestored: true })];
        const frames = events.map(e => encodeSandboxControl(request.commandId, e)).join("");
        const script = `const fs=require('fs');const go=()=>{process.stdout.write('46 passed\\n');fs.writeSync(3,${JSON.stringify(frames)});process.exit(0)};if(process.platform==='win32')process.stdin.once('data',go);else go();`;
        return { executablePath: process.execPath, args: ["-e", script], cwdAbsolute: workspaceRoot, environment: { ...process.env },
          metadata, controlPipe: true, cleanup: async () => { cleanups++; } };
      } };
      const runtime = new CommandRuntime(manager, undefined, backend, undefined, {
        quarantinePath: path.join(root, "quarantine.json"), lifecycleDirectory: path.join(root, "leases") });
      const tool = new RunCommandTool(manager, runtime);
      const input = { program: "node", args: ["--version"], intent: "verify", verificationKind: "custom" };
      const first = await tool.execute(input, context(workspaceRoot));
      const data = first.data as import("../src/command/types.js").RunCommandOutput;
      assert.equal(first.ok, false); assert.equal(data.exitCode, 0);
      assert.equal(data.failure?.code, "command_output_limit"); assert.equal(data.lifecycle?.cleanup, "confirmed");
      assert.notEqual(data.validation?.status, "passed"); assert.equal(calls, 1);
      const next = await tool.execute(input, context(workspaceRoot));
      assert.equal(next.ok, true); assert.equal(calls, 2); assert.equal(cleanups, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("Plan and Code share the same command sandbox permission metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-plan-permissions-"));
    try {
      const workspace = await WorkspaceManager.create(root);
      const backend = new NativeSandboxBackend(workspace);
      const command: ResolvedCommand = { program: "node", executablePath: process.execPath, args: ["--version"],
        cwdAbsolute: root, cwdRelative: ".", executableInsideWorkspace: false, environment: {}, environmentKeys: [] };
      const request = { commandId: "plan", command, context: { ...context(root), mode: "plan" as const }, commandPreview: "node",
        policyDecision: new CommandPolicy().classify({ program: "node", intent: "inspect" }, command, "plan") };
      const plan = backend.describe(request);
      const codeRequest = { ...request, context: { ...request.context, mode: "code" as const } };
      assert.deepEqual(plan, backend.describe(codeRequest));
      assert.equal(plan.filesystem, "host");
      assert.equal(plan.enforced, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps redaction placeholders stable across repeated audit/render passes", () => {
    const text = redactSensitiveInformation("token=ghp_1234567890123456789012345");
    assert.equal(redactSensitiveInformation(text), text);
    assert.equal(text, "token=[REDACTED TOKEN]");
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
    assert.equal(policy.classify({ program: "git", intent: "inspect" }, base, "plan").effect, "ask");
    assert.equal(policy.classify({ program: "git", intent: "inspect" }, { ...base, executableInsideWorkspace: false, args: ["branch", "-D", "topic"] }, "plan").effect, "ask");
    assert.equal(policy.classify({ program: "git", intent: "inspect" }, { ...base, executableInsideWorkspace: false }, "plan").effect, "ask");
  });

  it("uses a bounded, monotonic control stream independent of display text", () => {
    const seen: SandboxWorkerControl[] = [];
    const stream = new SandboxControlStream("owned", event => seen.push(event), true);
    const ready = encodeSandboxControl("owned", { type: "ready", backend: "native" });
    stream.push(ready.slice(0, 10)); stream.push(ready.slice(10));
    stream.push(encodeSandboxControl("owned", { type: "execution_dispatched" }));
    stream.push(encodeSandboxControl("owned", { type: "sandbox_boundary_violation", access: "write",
      destinationCategory: "outside_workspace", message: "sandbox denied write" }));
    stream.push(encodeSandboxControl("owned", { type: "execution_exited", exitCode: 0 }));
    assert.equal(seen.length, 4);
    assert.throws(() => stream.push(ready), /transition/u);
    assert.throws(() => new SandboxControlStream("owned", () => {}, true).push("untrusted text\n"), /Malformed/u);
  });

  it("classifies only structured app-server sandbox denials as known boundary exits", () => {
    const classified = sandboxBoundaryResultFromError(new NativeAppServerRequestError(
      "sandbox denied exec error, exit code: 7", -32000,
      { result: { stderr: "write blocked", path: "C:\\outside\\cache", exitCode: 7 } },
    ));
    assert.equal(classified?.exitCode, 7);
    assert.equal(classified?.stderr, "write blocked");
    assert.equal(classified?.event.type, "sandbox_boundary_violation");
    assert.equal(classified?.event.destination, "C:\\outside\\cache");
    assert.equal(sandboxBoundaryResultFromError(new Error("Permission denied")), undefined);
    assert.equal(sandboxBoundaryResultFromError(new NativeAppServerRequestError(
      "transport closed", -32001, { exitCode: 7 },
    )), undefined);
  });

  it("persists boundary attempts and consumes an exact host grant only once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-boundary-state-"));
    try {
      const filename = path.join(root, "state.json");
      const first = new SandboxBoundaryStore(filename, 32);
      assert.equal(first.recordViolation("thread:task", "family", "incident"), 1);
      const resumed = new SandboxBoundaryStore(filename, 32);
      assert.equal(resumed.recordViolation("thread:task", "family", "incident"), 2);
      resumed.recordDecision("thread:task", "incident", "allow_once", "exact-host-command");
      const approved = new SandboxBoundaryStore(filename, 32);
      assert.equal(approved.consumeHostGrant("thread:task", "different-command"), false);
      assert.equal(approved.consumeHostGrant("thread:task", "exact-host-command"), true);
      assert.equal(new SandboxBoundaryStore(filename, 32).consumeHostGrant("thread:task", "exact-host-command"), false);
    } finally { await rm(root, { recursive: true, force: true }); }
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
      const metadata = { backend: "native" as const, enforced: true, filesystem: "host" as const, network: "denied" as const };
      const backend: CommandExecutionBackend = { describe: () => metadata, async prepare(request) {
        const events: SandboxWorkerControl[] = [{ type: "ready", backend: "native" }, { type: "execution_dispatched" }, { type: "execution_exited", exitCode: 0 }, { type: "cleanup_error", message: "Native cleanup was not confirmed" }];
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

  it("treats a sandbox boundary denial as known, asks the model once, then requires the user without replay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-boundary-test-"));
    try {
      const workspaceRoot = path.join(root, "workspace"); await mkdir(workspaceRoot);
      const manager = await WorkspaceManager.create(workspaceRoot);
      const boundaryPrompts: import("../src/core/types.js").ApprovalRequest[] = [];
      const toolContext: ToolContext = { ...context(workspaceRoot), requestApproval: async request => {
        if (request.requiredReviewer === "user") {
          boundaryPrompts.push(request);
          request.observeDecision?.("allow_once");
        }
        return true;
      } };
      const options = { quarantinePath: path.join(root, "quarantine.json"), lifecycleDirectory: path.join(root, "leases"),
        boundaryStatePath: path.join(root, "boundary.json") };
      const firstRuntime = new CommandRuntime(manager, undefined, boundaryDenyingBackend(workspaceRoot, "native"), undefined, options);
      const firstTool = new RunCommandTool(manager, firstRuntime);
      const first = await firstTool.execute({ program: "node", args: ["--version"], intent: "inspect" }, toolContext);
      const firstData = first.data as import("../src/command/types.js").RunCommandOutput;
      assert.equal(first.ok, false);
      assert.equal(firstData.failure?.code, "sandbox_boundary_violation");
      assert.equal(firstData.lifecycle?.execution, "exited");
      assert.equal(firstData.lifecycle?.cleanup, "confirmed");
      assert.equal(firstData.sandboxBoundary?.action, "adjust_command");
      assert.equal(firstData.validation?.status, "unknown");
      assert.equal(first.failure?.execution, "exited");
      assert.equal(boundaryPrompts.length, 0);
      assert.doesNotThrow(() => firstRuntime.assertEnvironmentSafe());

      // Changing argv is a correction attempt, but the executable/cwd boundary
      // incident remains the same and therefore escalates on its second denial.
      const resumedRuntime = new CommandRuntime(manager, undefined, boundaryDenyingBackend(workspaceRoot, "native"), undefined, options);
      const resumedTool = new RunCommandTool(manager, resumedRuntime);
      const second = await resumedTool.execute({ program: "node", args: ["--help"], intent: "inspect" }, toolContext);
      const secondData = second.data as import("../src/command/types.js").RunCommandOutput;
      assert.equal(secondData.sandboxBoundary?.attempt, 2);
      assert.equal(secondData.sandboxBoundary?.action, "approved_once");
      assert.equal(secondData.sandboxBoundary?.hostRetryAuthorized, true);
      assert.equal(boundaryPrompts.length, 1);
      assert.equal(boundaryPrompts[0]?.requiredReviewer, "user");
      assert.equal(boundaryPrompts[0]?.executionTiming, "future_resubmission");

      const third = await resumedTool.execute({ program: "node", args: ["--help"], intent: "inspect" }, toolContext);
      const thirdData = third.data as import("../src/command/types.js").RunCommandOutput;
      assert.equal(third.ok, true);
      assert.equal(thirdData.sandbox.backend, "host-unrestricted");
      assert.equal(boundaryPrompts.length, 1, "the approved exact resubmission must not prompt twice");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("auto-approves the second boundary intervention in Benchmark without granting host escape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-benchmark-boundary-"));
    try {
      const workspaceRoot = path.join(root, "workspace"); await mkdir(workspaceRoot);
      const manager = await WorkspaceManager.create(workspaceRoot);
      let approvals = 0;
      const toolContext: ToolContext = { ...context(workspaceRoot), requestApproval: async () => { approvals++; return true; } };
      const runtime = new CommandRuntime(manager, undefined, boundaryDenyingBackend(workspaceRoot, "benchmark-container"), undefined, {
        networkProfile: "benchmark", lifecycleDirectory: path.join(root, "leases"), boundaryStatePath: path.join(root, "boundary.json") });
      const tool = new RunCommandTool(manager, runtime);
      await tool.execute({ program: "node", args: ["--version"], intent: "inspect" }, toolContext);
      const second = await tool.execute({ program: "node", args: ["--help"], intent: "inspect" }, toolContext);
      const data = second.data as import("../src/command/types.js").RunCommandOutput;
      assert.equal(data.sandboxBoundary?.action, "benchmark_allow_once");
      assert.equal(data.sandboxBoundary?.hostRetryAuthorized, false);
      assert.equal(data.sandbox.backend, "benchmark-container");
      assert.equal(approvals, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("confirms Windows descendant termination before finalizing host cleanup", async () => {
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
