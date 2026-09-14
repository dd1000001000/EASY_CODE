import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

import { CommandPolicy, CommandRuntime } from "../dist/command/index.js";
import { NativeAppServerClient } from "../dist/sandbox/app-server-client.js";
import { NativeSandboxBackend } from "../dist/sandbox/native-backend.js";
import { nativePermissionProfile } from "../dist/sandbox/native-policy.js";
import { nativeSandboxEntrypoint, nativeSandboxHome } from "../dist/sandbox/native-runtime.js";
import { NativeSandboxStartupService } from "../dist/sandbox/native-startup.js";
import { WorkspaceManager } from "../dist/workspace/manager.js";

const workspace = await mkdtemp(path.join(process.cwd(), ".easy-code-native-smoke-"));
const outside = await mkdtemp(path.join(os.homedir(), ".easy-code-native-outside-"));
const dataDir = path.join(workspace, ".easy-code-data");
const outsideSentinel = path.join(outside, "sentinel.txt");
await writeFile(outsideSentinel, "must remain private", "utf8");

async function execute(client, command, timeoutMs = 10_000) {
  return client.request("command/exec", {
    command,
    cwd: workspace,
    ...nativePermissionProfile(),
    timeoutMs,
  }, timeoutMs + 5_000);
}

async function denied(client, command, timeoutMs = 10_000) {
  try {
    return (await execute(client, command, timeoutMs)).exitCode !== 0;
  } catch (error) {
    return /sandbox denied|operation not permitted|permission denied|network/iu.test(String(error));
  }
}

try {
  const readiness = await new NativeSandboxStartupService().inspect();
  assert.equal(readiness.status, "ready", readiness.details.join("\n"));
  console.log("readiness: ok");

  const client = new NativeAppServerClient(nativeSandboxEntrypoint(), nativeSandboxHome());
  try {
    await client.initialize();
    const inside = await execute(client, [process.execPath, "-e",
      "require('node:fs').writeFileSync('inside.txt','sandboxed')"]);
    assert.equal(inside.exitCode, 0, inside.stderr);
    assert.equal(await readFile(path.join(workspace, "inside.txt"), "utf8"), "sandboxed");
    const bufferedOutput = await execute(client, [process.execPath, "-e",
      "process.stdout.write('BUFFERED_OUTPUT_OK')"]);
    assert.equal(bufferedOutput.exitCode, 0, bufferedOutput.stderr);
    assert.match(bufferedOutput.stdout, /BUFFERED_OUTPUT_OK/u);
    console.log("native boundary: workspace output ok");

    assert.equal(await denied(client, [process.execPath, "-e",
      "require('node:fs').writeFileSync(process.argv[1],'changed')", outsideSentinel]), true,
    "native sandbox wrote a path outside the workspace");
    assert.equal(await readFile(outsideSentinel, "utf8"), "must remain private");
    const outsideLink = path.join(workspace, "outside-link");
    await symlink(outside, outsideLink, process.platform === "win32" ? "junction" : "dir");
    assert.equal(await denied(client, [process.execPath, "-e",
      "require('node:fs').writeFileSync(process.argv[1],'changed')", path.join(outsideLink, "sentinel.txt")]), true,
    "native sandbox followed a workspace link to write outside the workspace");
    assert.equal(await readFile(outsideSentinel, "utf8"), "must remain private");
    console.log("native boundary: outside write denied");

    const directNetworkDenied = await denied(client, [process.execPath, "-e",
      "const n=require('node:net').connect({host:'1.1.1.1',port:80});" +
      "n.on('connect',()=>process.exit(0));n.on('error',()=>process.exit(7));" +
      "setTimeout(()=>process.exit(8),3000).unref()"], 5_000);
    assert.equal(directNetworkDenied, true, "native sandbox opened a direct external socket");
    console.log("native boundary: direct network denied");

    const server = createServer(socket => { socket.on("error", () => undefined); socket.end("LOOPBACK_OK"); });
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const loopback = await execute(client, [process.execPath, "-e",
        "const n=require('node:net').connect({host:'127.0.0.1',port:Number(process.argv[1])},()=>{});" +
        "n.on('data',d=>process.stdout.write(d));n.on('end',()=>process.exit(0));n.on('error',e=>{console.error(e);process.exit(9)})",
        String(address.port)]);
      assert.equal(loopback.exitCode, 0, loopback.stderr);
      assert.match(loopback.stdout, /LOOPBACK_OK/u);
    } finally { await new Promise(resolve => server.close(resolve)); }
    console.log("native boundary: loopback allowed");
  } finally {
    await client.close();
  }

  const manager = await WorkspaceManager.create(workspace);
  const backend = new NativeSandboxBackend(manager);
  const runtime = new CommandRuntime(manager, new CommandPolicy(), backend, undefined, {
    lifecycleDirectory: path.join(dataDir, "command-leases"),
  });
  const context = {
    workspaceRoot: workspace,
    mode: "code",
    threadId: "native-smoke-thread",
    turnId: "native-smoke-turn",
    approvalPolicy: "safe",
    commandExecutionMode: "auto_approve",
    requestApproval: async () => true,
    commandTimeoutMs: 10_000,
    maxOutputChars: 4_096,
  };
  const timedOut = await runtime.run({ program: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"], intent: "run", timeoutMs: 1_000 }, context);
  assert.equal(timedOut.status, "timed_out", JSON.stringify({ failure: timedOut.failure,
    lifecycle: timedOut.lifecycle, stderr: timedOut.stderr.text, exitCode: timedOut.exitCode,
    durationMs: timedOut.durationMs }));
  assert.equal(timedOut.lifecycle?.cleanup, "confirmed", JSON.stringify({ lifecycle: timedOut.lifecycle,
    stderr: timedOut.stderr.text, durationMs: timedOut.durationMs }));
  console.log("runtime: timeout cleanup confirmed");

  const followUp = await runtime.run({ program: process.execPath,
    args: ["-e", "process.stdout.write('FOLLOW_UP_OK')"], intent: "inspect", timeoutMs: 10_000 }, context);
  assert.equal(followUp.status, "exited", JSON.stringify({ failure: followUp.failure,
    lifecycle: followUp.lifecycle, stdout: followUp.stdout.text, stderr: followUp.stderr.text,
    durationMs: followUp.durationMs }));
  assert.equal(followUp.exitCode, 0);
  assert.match(followUp.stdout.text, /FOLLOW_UP_OK/u);
  assert.ok(followUp.durationMs < 15_000, `follow-up command took ${followUp.durationMs}ms`);
  console.log(`runtime: follow-up completed in ${followUp.durationMs}ms (${JSON.stringify(followUp.lifecycle?.timings)})`);
  await access(outsideSentinel);
  console.log(`Native sandbox smoke test passed on ${process.platform}.`);
} finally {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  await rm(outside, { recursive: true, force: true }).catch(() => undefined);
}
