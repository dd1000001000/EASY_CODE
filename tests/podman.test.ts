import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import { execa } from "execa";
import { PodmanSandboxBackend, resolvePodmanCommand, podmanMount } from "../src/sandbox/podman-backend.js";
import { PodmanStartupService } from "../src/sandbox/podman-startup.js";
import { attachPodmanProxy } from "../src/sandbox/podman-proxy.js";
import { stopTaskContainer, inspectTaskContainer, type PodmanRunner } from "../src/sandbox/podman-client.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import type { ToolContext } from "../src/core/types.js";
import type { SandboxExecutionRequest, CommandExecutionBackend, PreparedCommand } from "../src/sandbox/types.js";
import { CommandRuntime } from "../src/command/runtime.js";
import { packageScriptRunner, workspacePackageManifest, CommandVerificationCollector } from "../src/command/verification.js";
import { podmanCommandGrant } from "../src/command/podman-grant.js";
import { grantCommandApprovalPrefix, isCommandApprovalPrefixGranted, canGrantCommandPrefix } from "../src/command/approval.js";
import { describe, it } from "./harness.js";

class FakeEngine {
  containers = new Map<string, any>();
  calls: string[][] = [];
  roots = new Map<string, string>();
  failStop = false;
  rootless = true;
  failStart = false;
  dependencyDigest = "d".repeat(64);
  dependencyNames: string[] = [];
  volumes = new Map<string, any>();
  probeFailure = false;
  helperCleanupFailure = false;
  run: PodmanRunner = async args => {
    this.calls.push(args);
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    const fail = (message: string) => ({ exitCode: 125, stdout: "", stderr: message });
    if (args[0] === "info") return ok(JSON.stringify({ host: { security: { rootless: this.rootless } } }));
    if (args[0] === "image") return ok(args[1] === "inspect" ? JSON.stringify([{ Id: "sha256:" + "b".repeat(64) }]) : "");
    if (args[0] === "volume") {
      if (args[1] === "create") {
        const labels = Object.fromEntries(args.flatMap((v, i) => v === "--label" ? [args[i + 1]!.split("=")] : []));
        this.volumes.set(args.at(-1)!, { Name: args.at(-1), Labels: labels }); return ok(args.at(-1));
      }
      if (args[1] === "inspect") return ok(JSON.stringify([this.volumes.get(args[2]!)]));
      if (args[1] === "exists") return { exitCode: this.volumes.has(args[2]!) ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1]!;
      const labels = Object.fromEntries(args.flatMap((v, i) => v === "--label" ? [args[i + 1]!.split("=")] : []));
      this.containers.set(name, { Id: name, Config: { Labels: labels }, State: { Running: false, Status: "exited" } });
      return this.probeFailure ? fail("dependency budget exceeded") : ok(JSON.stringify({ digest: this.dependencyDigest, names: this.dependencyNames }));
    }
    if (args[0] === "rm") {
      if (this.helperCleanupFailure) return fail("helper cleanup unknown");
      this.containers.delete(args.at(-1)!); return ok();
    }
    if (args[0] === "container") {
      const c = this.containers.get(args[2]!);
      return args[1] === "inspect" ? c ? ok(JSON.stringify([c])) : fail("no such container")
        : { exitCode: c ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1]!;
      const labels = Object.fromEntries(args.flatMap((v, i) => v === "--label" ? [args[i + 1]!.split("=")] : []));
      this.containers.set(name, { Id: "f".repeat(64), Config: { Labels: labels }, HostConfig: { NetworkMode: "none", Privileged: false, ReadonlyRootfs: args.includes("--read-only") }, State: { Running: false, Status: "created" } });
      return ok("f".repeat(64));
    }
    if (args[0] === "start") {
      this.containers.get(args[1]!)!.State = { Running: true, Status: "running" };
      return this.failStart ? fail("lost response after start") : ok(args[1]);
    }
    if (args[0] === "stop") {
      if (this.failStop) return fail("engine disconnected");
      this.containers.get(args.at(-1)!)!.State = { Running: false, Status: "exited" };
      return ok();
    }
    if (args[0] === "commit") return ok("a".repeat(64));
    if (args[0] === "exec") {
      if (args[2] === "/bin/cat") {
        const root = this.roots.values().next().value!;
        return ok(await readFile(path.join(root, path.posix.basename(args[3]!)), "utf8"));
      }
      return ok();
    }
    return fail(`unsupported fake call ${args[0]}`);
  };
}
const ctx = (root: string, threadId = "thread-podman"): ToolContext => ({ workspaceRoot: root, threadId,
  turnId: "turn-podman", mode: "code", approvalPolicy: "ask", commandExecutionMode: "manual", requestApproval: async () => true,
  commandTimeoutMs: 2000, maxOutputChars: 4096 });
async function fixture(run: (workspace: WorkspaceManager, stateRoot: string, engine: FakeEngine) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ec-podman-test-"));
  await mkdir(path.join(root, "project"));
  const workspace = await WorkspaceManager.create(path.join(root, "project"));
  const engine = new FakeEngine(); engine.roots.set("project", workspace.root);
  try { await run(workspace, path.join(root, "state"), engine); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function request(workspace: WorkspaceManager, backend: PodmanSandboxBackend, threadId?: string): SandboxExecutionRequest {
  const context = ctx(workspace.root, threadId);
  const command = backend.resolveCommand({ program: "python3", args: ["-c", "print('ok')"], intent: "test" });
  return { commandId: "command_" + "1".repeat(36), command, context, commandPreview: "python3",
    policyDecision: { id: "p", effect: "allow", capability: "workspace_exec", risk: "workspace", reason: "approved", matchedRule: "test" } };
}

describe("Podman execution backend", () => {
  it("reads validation manifests through the shared checkout mapping, never a host /workspace", async () => fixture(async (w, stateRoot, engine) => {
    await mkdir(path.join(w.root, "tests"));
    await writeFile(path.join(w.root, "tests", "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    const backend = new PodmanSandboxBackend(w, { stateRoot, run: engine.run });
    const c = backend.resolveCommand({ program: "npm", args: ["test"], cwd: "/workspace/tests", intent: "verify" });
    const runner = await packageScriptRunner(c, c.cwdAbsolute, () => workspacePackageManifest(w, backend.workspaceRelativeCwd(c)));
    assert.deepEqual(runner, ["jest"]);
    const collector = new CommandVerificationCollector(c, runner);
    collector.push("stdout", "Test Suites: 1 failed, 1 total\n");
    assert.equal(collector.finish("exited", 0, "unit_test").status, "failed");
    assert.equal(backend.workspaceRelativeCwd({ ...c, cwdAbsolute: "/tmp" }), undefined);
    assert.equal(await workspacePackageManifest(w, undefined), undefined);
    const unknown = new CommandVerificationCollector(c);
    unknown.push("stdout", "Test Suites: 1 failed, 1 total\n");
    assert.equal(unknown.finish("exited", 0, "unit_test").status, "unknown");
  }));
  it("resolves Linux paths without host PATH lookup and preserves multiline argv exactly", async () => fixture(async w => {
    const input = { program: "python3", args: ["-c", "print('a')\nprint('b')", "$(never interpolate)"], cwd: "tests", intent: "test" as const };
    const c = resolvePodmanCommand(w, input);
    assert.equal(c.executablePath, "python3"); assert.equal(c.cwdAbsolute, "/workspace/tests"); assert.deepEqual(c.args, input.args);
    assert.equal(resolvePodmanCommand(w, { ...input, cwd: "/tmp" }).cwdAbsolute, "/tmp");
    assert.equal(resolvePodmanCommand(w, { ...input, cwd: w.root }).cwdAbsolute, "/workspace");
    assert.throws(() => resolvePodmanCommand(w, { ...input, program: "E:\\miniconda\\python.exe" }), /Windows/);
    assert.throws(() => resolvePodmanCommand(w, { ...input, args: ["bad\0argument"] }), /NUL/);
    assert.equal(c.environment.API_KEY, undefined);
  }));
  it("maps Windows VM mounts explicitly and rejects mount option injection", () => {
    assert.equal(podmanMount("F:\\a b\\repo", "/workspace"), "type=bind,src=/mnt/f/a b/repo,dst=/workspace");
    assert.throws(() => podmanMount("/tmp/a,ro=false", "/workspace"), /commas/);
  });
  it("reuses a stopped task container, isolates other threads and emits private payloads", async () => fixture(async (w, stateRoot, engine) => {
    const b = new PodmanSandboxBackend(w, { stateRoot, run: engine.run });
    const first = await b.prepare(request(w, b));
    const payload = JSON.parse(await readFile(first.args[1]!, "utf8"));
    assert.equal(payload.target.cwdAbsolute, "/workspace"); assert.equal(first.externalLifecycle, true);
    assert.equal(first.metadata.backend, "podman");
    assert.ok(engine.calls.find(a => a[0] === "create")!.includes("--network=none"));
    assert.ok(!engine.calls.some(a => a.includes("--privileged") || a.includes("--network=host")));
    await first.cleanup();
    const second = await b.prepare(request(w, b)); await second.cleanup();
    assert.equal(engine.calls.filter(a => a[0] === "create").length, 1);
    const third = await b.prepare(request(w, b, "other-thread")); await third.cleanup();
    assert.equal(engine.calls.filter(a => a[0] === "create").length, 2);
    assert.equal(engine.containers.get(payload.name).State.Running, false);
  }));
  it("cleans an ambiguous start failure without replaying or deleting task dependencies", async () => fixture(async (w, stateRoot, engine) => {
    engine.failStart = true;
    const b = new PodmanSandboxBackend(w, { stateRoot, run: engine.run });
    await assert.rejects(b.prepare(request(w, b)), /lost response/);
    assert.equal(engine.calls.filter(a => a[0] === "start").length, 1);
    assert.ok(engine.calls.some(a => a[0] === "stop")); assert.ok(!engine.calls.some(a => a[0] === "rm"));
    for (const c of engine.containers.values()) assert.equal(c.State.Running, false);
  }));
  it("retains a durable command lease when container cleanup is unknown", async () => fixture(async (w, stateRoot, engine) => {
    const b = new PodmanSandboxBackend(w, { stateRoot, run: engine.run });
    const p = await b.prepare(request(w, b)); engine.failStop = true;
    await assert.rejects(p.cleanup(), /disconnected/);
    const task = (await readdir(stateRoot))[0]!;
    assert.ok((await readdir(path.join(stateRoot, task))).includes("command.lease"));
    await assert.rejects(b.prepare(request(w, b)), /unfinished command lease/);
  }));
  it("rejects rootful engines before container creation", async () => fixture(async (w, stateRoot, engine) => {
    engine.rootless = false;
    const b = new PodmanSandboxBackend(w, { stateRoot, run: engine.run });
    await assert.rejects(b.prepare(request(w, b)), /rootless/);
    assert.ok(!engine.calls.some(a => a[0] === "create"));
  }));
  it("hides protected subtrees without Podman tmpfs copy-up and installs an engine lifetime cap", async () => fixture(async (w, stateRoot, engine) => {
    const secret = path.join(w.root, "private"); await mkdir(secret); await writeFile(path.join(secret, "secret"), "not-visible");
    w.pathGuard.protect(secret);
    const b = new PodmanSandboxBackend(w, { stateRoot, run: engine.run });
    const p = await b.prepare(request(w, b)); await p.cleanup();
    const args = engine.calls.find(a => a[0] === "create")!;
    assert.ok(args.some(arg => arg.includes("empty-directory") && arg.endsWith("dst=/workspace/private,ro=true")));
    assert.ok(args.includes("--http-proxy=false"));
    assert.ok(Number(args[args.indexOf("--timeout") + 1]) > DEFAULT_RUNTIME_LIMITS.commandInstallTimeoutMaxMs / 1000);
  }));
  it("cancels queued commands without stealing an active container lease", async () => fixture(async (w, stateRoot, engine) => {
    const b = new PodmanSandboxBackend(w, { stateRoot, run: engine.run });
    const first = await b.prepare(request(w, b));
    const r = request(w, b); const abort = new AbortController(); r.context.signal = abort.signal;
    const queued = b.prepare(r); abort.abort();
    await assert.rejects(queued, /canceled/); await first.cleanup();
    const next = await b.prepare(request(w, b)); await next.cleanup();
  }));
  it("snapshots stopped dependencies for independent reviewers, never includes workspace mounts", async () => fixture(async (w, stateRoot, engine) => {
    const b = new PodmanSandboxBackend(w, { stateRoot, run: engine.run });
    const p = await b.prepare(request(w, b));
    await assert.rejects(b.snapshotForReview("thread-podman"), /unfinished/);
    await p.cleanup();
    assert.equal((await b.snapshotForReview("thread-podman")).image, "sha256:" + "a".repeat(64));
    assert.ok(engine.calls.find(a => a[0] === "commit")!.includes("--include-volumes=false"));
  }));
  it("reuses stable review images and volumes across resume, but invalidates changed dependencies or commands", async () => fixture(async (w, stateRoot, engine) => {
    engine.dependencyNames = ["node_modules", ".venv"];
    const b = new PodmanSandboxBackend(w, { stateRoot, run: engine.run });
    const p = await b.prepare(request(w, b)); await p.cleanup();
    const first = await b.snapshotForReview("thread-podman");
    const resumed = new PodmanSandboxBackend(w, { stateRoot, run: engine.run });
    assert.deepEqual(await resumed.snapshotForReview("thread-podman"), first);
    assert.equal(engine.calls.filter(a => a[0] === "commit").length, 1);
    assert.equal(engine.calls.filter(a => a[0] === "volume" && a[1] === "create").length, 2);
    engine.volumes.delete(first.volumes.node_modules!);
    assert.notDeepEqual((await b.snapshotForReview("thread-podman")).volumes, first.volumes);
    engine.dependencyDigest = "e".repeat(64);
    const changed = await b.snapshotForReview("thread-podman");
    assert.notEqual(changed.revision, first.revision);
    assert.notDeepEqual(changed.volumes, first.volumes);
    const next = await b.prepare(request(w, b)); await next.cleanup();
    assert.notEqual((await b.snapshotForReview("thread-podman")).generation, changed.generation);
    const actor = new PodmanSandboxBackend(w, { stateRoot, run: engine.run,
      readOnlyRootfs: true, reviewSnapshot: changed, limits: { ...DEFAULT_RUNTIME_LIMITS, podmanImage: changed.image } });
    const prepared = await actor.prepare(request(w, actor, "review-actor"));
    assert.ok(engine.calls.some(a => a.includes(`${changed.volumes.node_modules}:/workspace/node_modules:ro,nocopy`)));
    await prepared.cleanup();
  }));
  it("mounts the review dependency image read-only without taking away its private writable workspace", async () => fixture(async (w, stateRoot, engine) => {
    const b = new PodmanSandboxBackend(w, { stateRoot, run: engine.run, readOnlyRootfs: true });
    const p = await b.prepare(request(w, b));
    assert.equal(p.metadata.reviewEnvironmentUnchanged, true);
    const args = engine.calls.find(c => c[0] === "create")!; assert.ok(args.includes("--read-only"));
    assert.ok(args.includes(podmanMount(w.root, "/workspace")));
    await p.cleanup();
  }));
  it("does not quarantine a bad review snapshot after confirmed cleanup, but retains unknown helper leases", async () => fixture(async (w, stateRoot, engine) => {
    const b = new PodmanSandboxBackend(w, { stateRoot, run: engine.run });
    engine.probeFailure = true;
    await assert.rejects(b.snapshotForReview("thread-podman"), /budget/);
    const directory = path.join(stateRoot, (await readdir(stateRoot))[0]!);
    await assert.rejects(readFile(path.join(directory, "command.lease")), { code: "ENOENT" });
    engine.probeFailure = false;
    const next = await b.prepare(request(w, b)); await next.cleanup();
    engine.helperCleanupFailure = true;
    await assert.rejects(b.snapshotForReview("thread-podman"), /cleanup unknown/);
    assert.match(await readFile(path.join(directory, "command.lease"), "utf8"), /review_snapshot/);
    await assert.rejects(b.prepare(request(w, b)), /unfinished/);
  }));
  it("never interprets engine unavailability as an absent container or stops foreign containers", async () => {
    const failed: PodmanRunner = async () => ({ exitCode: 125, stdout: "", stderr: "offline" });
    await assert.rejects(inspectTaskContainer(failed, "owned"), /unknown/);
    const fake = new FakeEngine(); fake.containers.set("foreign", { Id: "1", Config: { Labels: { "io.easy-code.owner": "other" } }, State: { Running: true } });
    await assert.rejects(stopTaskContainer(fake.run, "foreign", "me"), /unowned/);
    assert.ok(!fake.calls.some(c => c[0] === "stop"));
  });
  it("keeps container permission prefixes separate from host grants, scope and networking", async () => fixture(async w => {
    const c = resolvePodmanCommand(w, { program: "pip", args: ["install", "pytest"], intent: "install" });
    const offline = podmanCommandGrant(c, "a".repeat(64), false);
    const online = podmanCommandGrant(c, "a".repeat(64), true);
    const grants = grantCommandApprovalPrefix([], offline);
    assert.equal(canGrantCommandPrefix(offline), true);
    assert.equal(isCommandApprovalPrefixGranted(grants, online), false);
    assert.equal(isCommandApprovalPrefixGranted([online], offline), true);
    assert.equal(isCommandApprovalPrefixGranted(grants, podmanCommandGrant({ ...c, args: ["install", "requests"] }, "a".repeat(64), false)), true);
    assert.equal(isCommandApprovalPrefixGranted(grants, podmanCommandGrant(c, "b".repeat(64), false)), false);
    assert.equal(isCommandApprovalPrefixGranted(grants, podmanCommandGrant({ ...c, cwdAbsolute: "/tmp" }, "a".repeat(64), false)), false);
  }));
  it("startup diagnoses a missing engine without installing dependencies or starting a host target", async () => {
    const service = new PodmanStartupService(DEFAULT_RUNTIME_LIMITS, async () => { throw new Error("ENOENT podman"); },
      async () => { throw new Error("Simulated missing package manager"); });
    const result = await service.inspect(); assert.equal(result.status, "dependencies_missing"); assert.equal(result.canSetup, true);
    assert.equal((await service.setup(result)).status, "failed");
  });
  it("normal nonzero exits and cancellation use engine cleanup even without a worker acknowledgment", async () => fixture(async w => {
    let cleaned = 0, canceled = 0;
    const backend: CommandExecutionBackend = {
      describe: () => ({ backend: "podman", enforced: true, filesystem: "container", network: "denied" }),
      prepare: async request => ({ executablePath: process.execPath, cwdAbsolute: w.root, environment: {}, controlPipe: true, externalLifecycle: true,
        metadata: backend.describe(), args: ["-e", `const fs=require('fs');const emit=x=>fs.writeSync(3,'[[EASY_CODE_SANDBOX:'+${JSON.stringify(request.commandId)}+':'+Buffer.from(JSON.stringify(x)).toString('base64url')+']]\\n');emit({type:'ready',backend:'podman'});emit({type:'execution_dispatched'});${request.command.args[0] === "exit" ? "emit({type:'execution_exited',exitCode:3,outcome:'exited'});process.exitCode=3" : "setInterval(()=>{},1000)"}`],
        cancel: async () => { canceled++; }, cleanup: async () => { cleaned++; } }),
    };
    const runtime = new CommandRuntime(w, undefined, backend, backend, { sandboxStartupTimeoutMs: 3000 });
    const a = await runtime.run({ program: process.execPath, args: ["exit"], intent: "inspect" }, ctx(w.root));
    assert.equal(a.exitCode, 3); assert.equal(a.lifecycle?.cleanup, "confirmed"); assert.equal(cleaned, 1);
    const b = await runtime.run({ program: process.execPath, args: ["wait"], intent: "inspect", timeoutMs: 50 }, ctx(w.root));
    assert.equal(b.status, "timed_out"); assert.equal(b.lifecycle?.cleanup, "confirmed"); assert.equal(cleaned, 2); assert.equal(canceled, 1);
  }));
  it("forwards relay streams only to the fixed host gate and rejects oversized frames", async () => {
    const server = createServer(socket => socket.on("data", data => socket.write(data)));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const input = new PassThrough(), output = new PassThrough(); let received = "";
    output.on("data", d => { received += d.toString(); });
    const proxy = attachPodmanProxy(input, output, `http://u:p@127.0.0.1:${port}`, { maxConnections: 1, maxBytes: 1000000 });
    try {
      input.write('{"type":"ready"}\n'); await proxy.ready;
      input.write('{"type":"open","id":1,"host":"ignored.invalid","port":443}\n');
      input.write(JSON.stringify({ type: "data", id: 1, data: Buffer.from("hello").toString("base64") }) + "\n");
      await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("no echo")), 2000);
        const interval = setInterval(() => { if (received.includes("aGVsbG8=")) { clearInterval(interval); clearTimeout(timeout); resolve(); } }, 10); });
      input.write("x".repeat(65537)); assert.equal(output.writableEnded, true);
    } finally { proxy.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
