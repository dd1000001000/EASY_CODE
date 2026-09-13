/** Opt-in REAL engine acceptance. Missing engine/image is failure, not a skip.
 * --with-dependencies explicitly allows pip HTTP(S) downloads in the fixture.
 * No model/API requests, host execution fallback, or global container pruning. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceManager } from "../dist/workspace/manager.js";
import { CommandRuntime } from "../dist/command/runtime.js";
import { PodmanSandboxBackend } from "../dist/sandbox/podman-backend.js";
import { PodmanStartupService, PODMAN_IPC_PROBE } from "../dist/sandbox/podman-startup.js";
import { loadEasyCodeConfig } from "../dist/config/loader.js";
import { PodmanResourceManager } from "../dist/sandbox/podman-resources.js";

const online = process.argv.includes("--with-dependencies");
const { limits } = await loadEasyCodeConfig({ credentialStore: false });
const readiness = await new PodmanStartupService(limits).inspect();
if (readiness.status !== "ready") throw new Error(`Podman acceptance NOT RUN: ${JSON.stringify(readiness)}`);
const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-podman-smoke-"));
const workspaceRoot = path.join(root, "project");
await mkdir(workspaceRoot);
const workspace = await WorkspaceManager.create(workspaceRoot);
const threadId = `smoke_${randomUUID()}`, otherThread = `smoke_${randomUUID()}`;
const backend = new PodmanSandboxBackend(workspace, { limits, stateRoot: path.join(root, "control") });
const runtime = new CommandRuntime(workspace, undefined, backend, undefined, { limits,
  networkProfile: online ? "development" : "review_offline", lifecycleDirectory: path.join(root, "leases") });
const context = { workspaceRoot, threadId, turnId: "smoke", mode: "code", approvalPolicy: "ask", commandExecutionMode: "manual",
  limits, maxOutputChars: 8192, commandTimeoutMs: 600000, isUnrestrictedHostAccessActive: () => false,
  requestApproval: async request => request.command?.scope === "container" && (!request.command.network || online) };
const checks = [];
let reviewBackend, reviewRuntime, reviewSnapshot;
const reviewThread = `smoke_review_${randomUUID()}`;
async function run(program, args, options = {}) {
  const result = await runtime.run({ program, args, cwd: "/workspace", intent: "inspect", ...options }, context);
  assert.equal(result.lifecycle?.cleanup, "confirmed", JSON.stringify(result));
  return result;
}
async function passing(name, program, args, options) {
  const result = await run(program, args, options);
  assert.equal(result.status, "exited", JSON.stringify(result)); assert.equal(result.exitCode, 0, JSON.stringify(result));
  checks.push(name); process.stdout.write(`PASS ${name}\n`); return result;
}
try {
  await writeFile(path.join(workspaceRoot, "from-host.txt"), "host-to-container");
  await passing("shared checkout + persistent rootfs", "python3", ["-c", "from pathlib import Path; assert Path('from-host.txt').read_text()=='host-to-container'; Path('from-container.txt').write_text('container-to-host'); Path('/root/easy-code-smoke-marker').write_text('retained')"]);
  assert.equal(await readFile(path.join(workspaceRoot, "from-container.txt"), "utf8"), "container-to-host");
  await passing("rootfs retained after stop/start", "python3", ["-c", "from pathlib import Path; assert Path('/root/easy-code-smoke-marker').read_text()=='retained'"]);
  await passing("asyncio / socketpair / semaphore / temporary files / offline", "python3", ["-I", "-u", "-c", PODMAN_IPC_PROBE]);
  await passing("Node child process and IPC", "node", ["-e", "require('child_process').execFileSync('node',['-e','process.exit(0)']);const n=require('net');const s=n.createServer(c=>c.end('ok')).listen(0,'127.0.0.1',()=>{const c=n.connect(s.address().port,'127.0.0.1');c.resume();c.on('end',()=>s.close());});"]);
  await writeFile(path.join(workspaceRoot, "probe.cpp"), "#include <iostream>\nint main(){std::cout << 42;}\n");
  await passing("C++ compiler and program", "bash", ["-c", "g++ probe.cpp -o probe && ./probe"]);
  const plan = await runtime.run({ program: "node", args: ["-e", "require('fs').writeFileSync('plan-command.txt','approved')"], intent: "run" }, { ...context, mode: "plan" });
  assert.equal(plan.exitCode, 0); assert.equal(await readFile(path.join(workspaceRoot, "plan-command.txt"), "utf8"), "approved");
  checks.push("Plan commands obey approval, not a retired read-only OS fence");
  await writeFile(path.join(workspaceRoot, "failing.test.cjs"), "require('node:test')('boundary',()=>require('node:assert/strict').equal(2,3));\n");
  await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { test: "node --test --test-reporter=tap failing.test.cjs" } }));
  const npm = await run("npm", ["test"], { intent: "verify" });
  assert.equal(npm.validation?.status, "failed"); assert.equal(npm.validation?.source, "framework_summary");
  const piped = await run("bash", ["-c", "node --test --test-reporter=tap failing.test.cjs 2>&1 | grep '^#'"], { intent: "verify" });
  assert.equal(piped.exitCode, 0); assert.equal(piped.validation?.status, "failed");
  checks.push("mapped npm metadata and masked pipeline failures");
  const failed = await run("python3", ["-c", "raise SystemExit(7)"]); assert.equal(failed.exitCode, 7);
  const timeout = await run("python3", ["-c", "import time;time.sleep(60)"], { timeoutMs: 300 });
  assert.equal(timeout.status, "timed_out"); checks.push("nonzero/timeout without replay or quarantine");
  const handle = await runtime.start({ program: "python3", args: ["-c", "import time;time.sleep(60)"], intent: "inspect" }, context);
  assert.equal(handle.status, "running"); const canceled = await runtime.cancel(handle.commandId, context);
  assert.equal(canceled.status, "canceled"); assert.equal(canceled.lifecycle?.cleanup, "confirmed"); checks.push("cancel stops container");
  await passing("detached child is bounded by container", "python3", ["-c", "import subprocess,time; subprocess.Popen(['python3','-c',\"import time;f=open('/workspace/child.log','a');\\nwhile True: f.write('x');f.flush();time.sleep(.05)\"],start_new_session=True);time.sleep(.2)"]);
  const size = (await readFile(path.join(workspaceRoot, "child.log"))).length;
  await passing("next command sees no surviving child", "python3", ["-c", `import time;from pathlib import Path;time.sleep(.2);assert len(Path('child.log').read_bytes())==${size}`]);
  const other = await runtime.run({ program: "python3", args: ["-c", "from pathlib import Path;assert not Path('/root/easy-code-smoke-marker').exists()"], intent: "inspect" }, { ...context, threadId: otherThread });
  assert.equal(other.exitCode, 0, JSON.stringify(other)); checks.push("separate task environment");
  if (online) {
    await passing("approved pip dependencies", "python3", ["-m", "pip", "install", "--disable-pip-version-check", "fastapi", "httpx", "pytest"], { intent: "install", timeoutMs: 600000 });
    await passing("FastAPI TestClient", "python3", ["-c", "from fastapi import FastAPI;from fastapi.testclient import TestClient;app=FastAPI();app.get('/')(lambda:{'ok':True});assert TestClient(app).get('/').json()=={'ok':True}"]);
  }
  await passing("Linux dependencies for review", "bash", ["-c", "python3 -m venv .venv && mkdir -p node_modules/dep node_modules/.bin && printf 'module.exports=42' > node_modules/dep/index.js && ln -s ../dep/index.js node_modules/.bin/dep"]);
  reviewSnapshot = await backend.snapshotForReview(threadId);
  assert.deepEqual(await backend.snapshotForReview(threadId), reviewSnapshot);
  const reviewRoot = path.join(root, "review"); await mkdir(reviewRoot);
  reviewBackend = new PodmanSandboxBackend(await WorkspaceManager.create(reviewRoot), { stateRoot: path.join(root, "control"),
    limits: { ...limits, podmanImage: reviewSnapshot.image }, readOnlyRootfs: true, reviewSnapshot });
  reviewRuntime = new CommandRuntime(new WorkspaceManager(reviewRoot), undefined, reviewBackend, undefined, { limits, networkProfile: "review_offline" });
  const reviewed = await reviewRuntime.run({ program: "bash", args: ["-c", ".venv/bin/python -c 'import sys; print(sys.prefix)' && node -e \"if(require('./node_modules/dep')!==42) process.exit(1)\" && ! touch node_modules/write-test"], cwd: "/workspace", intent: "verify" },
    { ...context, workspaceRoot: reviewRoot, threadId: reviewThread });
  assert.equal(reviewed.exitCode, 0, JSON.stringify(reviewed)); checks.push("independent immutable Linux review dependencies and stable snapshot cache");
  process.stdout.write(JSON.stringify({ passed: checks, dependencyDownloadTest: online ? "passed" : "not requested" }, null, 2) + "\n");
} finally {
  await runtime.cancelAll();
  await reviewRuntime?.cancelAll();
  // WSL-created Linux directory symlinks cannot always be unlinked by native
  // Windows Node. Remove ONLY these generated dependency fixtures inside their
  // owning container before removing the fixture's task environment.
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("easy-code-podman-smoke-") ||
      workspaceRoot !== path.join(root, "project")) throw new Error("Invalid dependency fixture cleanup root");
  const cleaned = await runtime.run({ program: "rm", args: ["-rf", "--", "/workspace/.venv", "/workspace/node_modules"],
    cwd: "/workspace", intent: "run" }, context);
  assert.equal(cleaned.lifecycle?.cleanup, "confirmed", JSON.stringify(cleaned));
  assert.equal(cleaned.exitCode, 0, JSON.stringify(cleaned));
  await reviewBackend?.removeTask(reviewThread);
  if (reviewSnapshot) {
    const resources = new PodmanResourceManager(path.join(root, "control"), limits);
    for (const volume of Object.values(reviewSnapshot.volumes)) await resources.remove("volume", volume);
    await resources.remove("image", `localhost/easy-code-review:${reviewSnapshot.owner.slice(0, 32)}-${reviewSnapshot.generation.slice(0, 16)}`);
  }
  // Refuse to erase fixtures/leases when engine cleanup is not confirmed.
  await backend.removeTask(threadId); await backend.removeTask(otherThread);
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("easy-code-podman-smoke-")) throw new Error("Invalid fixture cleanup root");
  await rm(root, { recursive: true, force: true });
}
