import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { executionCapabilities, assertExecutionCapabilities } from "../src/sandbox/capabilities.js";
import { CommandRuntime } from "../src/command/runtime.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { encodeSandboxControl } from "../src/sandbox/control.js";
import { runCommandInputSchema } from "../src/tools/run-command.js";
import { PodmanSandboxBackend } from "../src/sandbox/podman-backend.js";
import type { CommandExecutionBackend, SandboxBackendName } from "../src/sandbox/types.js";
import type { ToolContext, ApprovalRequest } from "../src/core/types.js";

async function fixture(run: (root: string, workspace: WorkspaceManager, context: ToolContext) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-capabilities-"));
  try {
    const context: ToolContext = { workspaceRoot: root, mode: "code", threadId: "thread-capabilities", turnId: "turn",
      approvalPolicy: "safe", commandExecutionMode: "auto_approve", requestApproval: async () => true,
      commandTimeoutMs: 2000, maxOutputChars: 2048 };
    await run(root, await WorkspaceManager.create(root), context);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function backend(name: SandboxBackendName, prepared: string[]): CommandExecutionBackend {
  return { describe: () => ({ backend: name, enforced: false, filesystem: "host", network: "host", capabilities: executionCapabilities(name) }),
    async prepare(request) {
      prepared.push(name);
      if (name === "host-unrestricted") assert.equal(request.hostExecutionAuthorized, true);
      return { executablePath: process.execPath, args: ["-e", "process.stdout.write('fixture executed')"],
        cwdAbsolute: request.command.cwdAbsolute, environment: {}, metadata: this.describe(), cleanup: async () => {} };
    } };
}

describe("unified sandbox compatibility", () => {
  it("uses Podman container metadata independent of the host platform", async () => fixture(async (_, workspace) => {
    const metadata = new PodmanSandboxBackend(workspace).describe();
    assert.equal(metadata.backend, "podman");
    assert.equal(metadata.filesystem, "container");
    assert.deepEqual(metadata.capabilities, executionCapabilities("podman"));
  }));
  it("reports policy capabilities, not fictitious cross-language proof", () => {
    const report = executionCapabilities("podman");
    assert.equal(report.source, "policy");
    assert.equal(report.isolation, "container");
    assert.equal(report.features.loopback_tcp, "supported");
    assert.equal(executionCapabilities("benchmark-container").features.shared_memory, "supported");
    const unknown = executionCapabilities("host-test-only");
    assert.throws(() => assertExecutionCapabilities(unknown, ["process_tree"]), /Target was not started/);
    assert.doesNotThrow(() => assertExecutionCapabilities(report, ["temporary_files", "child_processes"]));
  });
  it("does not inject Python hooks and strictly validates optional capability names", async () => {
    const source = await readFile(path.join(process.cwd(), "src/sandbox/podman-backend.ts"), "utf8");
    assert.doesNotMatch(source, /sitecustomize|windowsPythonIpc|targetEnvironment\.PYTHONPATH/);
    assert.deepEqual(runCommandInputSchema.parse({ program: "node", intent: "test", requiredCapabilities: [] }).requiredCapabilities, []);
    assert.throws(() => runCommandInputSchema.parse({ program: "node", intent: "test", requiredCapabilities: ["full_network"] }));
  });
  it("proposes host permissions before one approval and never executes the failed sandbox attempt", async () => fixture(async (_, workspace, context) => {
    const prepared: string[] = [], approvals: ApprovalRequest[] = [];
    context.requestApproval = async request => { approvals.push(request); return true; };
    const runtime = new CommandRuntime(workspace, undefined, backend("host-test-only", prepared), backend("host-unrestricted", prepared));
    const result = await runtime.run({ program: "node", args: ["--version"], intent: "test" }, context);
    assert.equal(result.status, "exited"); assert.deepEqual(prepared, ["host-unrestricted"]);
    assert.equal(approvals.length, 1); assert.equal(approvals[0]?.command?.scope, "host");
    assert.equal(approvals[0]?.command?.network, true); assert.match(approvals[0]!.description, /HOST execution/);
    assert.equal(result.sandbox.enforced, false);
    assert.equal(result.lifecycle?.execution, "exited");
  }));
  it("does not launch anything when host escalation is refused", async () => fixture(async (_, workspace, context) => {
    const prepared: string[] = []; context.requestApproval = async request => request.command?.scope !== "host";
    const runtime = new CommandRuntime(workspace, undefined, backend("host-test-only", prepared), backend("host-unrestricted", prepared));
    const result = await runtime.run({ program: "node", intent: "test" }, context);
    assert.equal(result.status, "policy_denied"); assert.deepEqual(prepared, []);
  }));
  it("returns a zero-retry capability error when host escalation is disabled", async () => fixture(async (_, workspace, context) => {
    const prepared: string[] = [];
    const runtime = new CommandRuntime(workspace, undefined, backend("host-test-only", prepared), backend("host-unrestricted", prepared),
      { limits: { ...DEFAULT_RUNTIME_LIMITS, sandboxAllowHostEscalation: false } });
    const result = await runtime.run({ program: "node", intent: "verify" }, context);
    assert.equal(result.failure?.code, "sandbox_capability_missing"); assert.equal(result.failure?.retryable, false);
    assert.equal(result.lifecycle?.execution, "not_started"); assert.deepEqual(prepared, []);
  }));
  it("allows explicit no-IPC checks without changing the sandbox boundary", async () => fixture(async (_, workspace, context) => {
    const prepared: string[] = [];
    const runtime = new CommandRuntime(workspace, undefined, backend("host-test-only", prepared), backend("host-unrestricted", prepared));
    await runtime.run({ program: "node", intent: "verify", requiredCapabilities: [] }, context);
    assert.deepEqual(prepared, ["host-test-only"]);
  }));
  it("Benchmark cannot escalate even with host scope and missing IPC", async () => fixture(async (_, workspace, context) => {
    const prepared: string[] = [];
    context.requestApproval = async () => { throw new Error("Benchmark must not ask for host approval"); };
    const runtime = new CommandRuntime(workspace, undefined, backend("host-test-only", prepared), backend("host-unrestricted", prepared), { networkProfile: "benchmark" });
    const result = await runtime.run({ program: "python", intent: "test", executionScope: "host" }, context);
    assert.equal(result.failure?.code, "sandbox_capability_missing"); assert.deepEqual(prepared, []);
  }));
  it("full access retains its no-approval host semantics", async () => fixture(async (_, workspace, context) => {
    const prepared: string[] = [];
    context.commandExecutionMode = "unrestricted";
    context.requestApproval = async () => { throw new Error("Full access should not prompt"); };
    const runtime = new CommandRuntime(workspace, undefined, backend("host-test-only", prepared), backend("host-unrestricted", prepared));
    assert.equal((await runtime.run({ program: "node", intent: "test" }, context)).exitCode, 0);
    assert.deepEqual(prepared, ["host-unrestricted"]);
  }));
  it("supervises real Windows host descendants even when the direct target exits first", async () => fixture(async (_, workspace, context) => {
    if (process.platform !== "win32") return;
    context.commandExecutionMode = "unrestricted";
    context.commandTimeoutMs = 5000;
    context.requestApproval = async () => { throw new Error("Full access must not request approval"); };
    const runtime = new CommandRuntime(workspace);
    const result = await runtime.run({ program: process.execPath, intent: "test", args: ["-e",
      "const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)"] }, context);
    assert.equal(result.status, "exited");assert.equal(result.exitCode, 0);
    assert.equal(result.sandbox.enforced, false);assert.equal(result.lifecycle?.cleanup, "confirmed");
    const pid = Number(result.stdout.text.trim());assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }));
  it("reports host target timeout independently and permits the next command after confirmed cleanup", async () => fixture(async (_, workspace, context) => {
    if (process.platform !== "win32") return;
    context.commandExecutionMode = "unrestricted";
    const runtime = new CommandRuntime(workspace);
    const result = await runtime.run({ program: process.execPath, intent: "test", timeoutMs: 500,
      args: ["-e", "console.log('started');setTimeout(()=>{},15000)"] }, context);
    assert.equal(result.status, "timed_out");assert.match(result.stdout.text, /started/);
    assert.equal(result.lifecycle?.timeoutPhase, "command");assert.equal(result.lifecycle?.cleanup, "confirmed");
    assert.equal(result.failure?.retryable, false);
    assert.equal((await runtime.run({ program: process.execPath, intent: "inspect", args: ["-e", "console.log(42)"] }, context)).exitCode, 0);
  }));
  for (const phase of ["initialization", "cleanup"] as const) it(`does not charge ${phase} time against the command timeout`, async () => fixture(async (root, workspace, context) => {
    const metadata = { backend: "benchmark-container" as const, enforced: true, filesystem: "container" as const, network: "denied" as const };
    const worker: CommandExecutionBackend = { describe: () => metadata, async prepare(request) {
      const frame = (event: Parameters<typeof encodeSandboxControl>[1]) => JSON.stringify(encodeSandboxControl(request.commandId, event));
      const ready = `fs.writeSync(3,${frame({ type: "ready", backend: "benchmark-container" })});`;
      const result = `fs.writeSync(3,${frame({ type: "execution_dispatched" })});fs.writeSync(3,${frame({ type: "execution_exited", exitCode: 0 })});`;
      const cleanup = `fs.writeSync(3,${frame({ type: "cleanup_complete" })});process.exit(0);`;
      const script = `const fs=require('fs');const go=()=>{${ready}${phase === "initialization" ? `setTimeout(()=>{${result}${cleanup}},220);` : `${result}setTimeout(()=>{${cleanup}},220);`}};if(process.platform==='win32')process.stdin.once('data',go);else go();`;
      return { executablePath: process.execPath, args: ["-e", script], cwdAbsolute: root, environment: { ...process.env }, metadata, controlPipe: true, cleanup: async () => {} };
    } };
    const runtime = new CommandRuntime(workspace, undefined, worker, undefined, { sandboxStartupTimeoutMs: 3000 });
    const result = await runtime.run({ program: "node", intent: "inspect", timeoutMs: 80 }, context);
    assert.equal(result.status, "exited"); assert.equal(result.exitCode, 0); assert.equal(result.lifecycle?.cleanup, "confirmed");
    assert.ok(result.lifecycle!.timings![phase === "initialization" ? "initializationMs" : "cleanupMs"] >= 150);
  }));
});
