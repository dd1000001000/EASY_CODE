import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { CommandRuntime } from "../dist/command/runtime.js";
import { WorkspaceMutationLock, wrapAgentToolsWithWorkspaceMutationLock } from "../dist/subagents/workspace-mutation-lock.js";
import { WorkspaceManager } from "../dist/workspace/manager.js";

const checkout = process.cwd();
const root = await mkdtemp(path.join(checkout, ".easy-code-service-smoke-"));
const workspace = await WorkspaceManager.create(root);
const runtime = new CommandRuntime(workspace);
const context = {
  workspaceRoot: root,
  mode: "code",
  threadId: "thread-service-smoke",
  turnId: "turn-service-smoke",
  approvalPolicy: "safe",
  commandExecutionMode: "auto_approve",
  requestApproval: async () => true,
  commandTimeoutMs: 5_000,
  maxOutputChars: 4_096,
};
const [runTool, startTool] = wrapAgentToolsWithWorkspaceMutationLock([
  { name: "run_command", mutating: true, execute: async (input, toolContext) => ({
    ok: true, data: await runtime.run(input, toolContext),
  }) },
  { name: "start_command", mutating: true, execute: async (input, toolContext) => {
    const { backgroundKind, ...request } = input;
    return { ok: true, data: await runtime.start(request, toolContext, backgroundKind) };
  }, whenCommandSettled: (commandId) => runtime.whenSettled(commandId) },
], new WorkspaceMutationLock());

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

try {
  const port = await freePort();
  const server = `require('node:http').createServer((req,res)=>res.end('service-ok')).listen(${port},'127.0.0.1')`;
  const client = `require('node:http').get('http://127.0.0.1:${port}',r=>{let body='';r.on('data',x=>body+=x);r.on('end',()=>{console.log(r.statusCode,body);process.exit(r.statusCode===200&&body==='service-ok'?0:2)})}).on('error',e=>{console.error(e.code);process.exit(3)})`;
  const started = await startTool.execute({ program: process.execPath, args: ["-e", server], intent: "run",
    backgroundKind: "service", timeoutMs: 20_000 }, context);
  assert.equal(started.data?.status, "running", "service did not start");
  const handle = started.data.commandId;
  let ready = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await runTool.execute({ program: process.execPath, args: ["-e", client], intent: "test",
      timeoutMs: 3_000 }, context);
    if (result.data?.status === "exited" && result.data.exitCode === 0) {
      ready = true;
      break;
    }
    const state = await runtime.status(handle, context);
    assert.equal(state.status, "running", "service exited before readiness");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.equal(ready, true, "separate native sandbox command could not reach the service");
  console.log("same-agent HTTP probe: ok");

  if (process.platform === "linux") {
    const external = await runTool.execute({ program: process.execPath, args: ["-e",
      "const s=require('node:net').connect({host:'1.1.1.1',port:80,timeout:1500});s.on('connect',()=>process.exit(4));s.on('error',()=>process.exit(0));s.on('timeout',()=>process.exit(0))"],
      intent: "test", timeoutMs: 3_000 }, context);
    assert.equal(external.data?.exitCode, 0, "service sandbox allowed direct external networking");
    console.log("direct external network denial: ok");

    const child = await startTool.execute({ program: process.execPath, args: ["-e", "setInterval(()=>{},1000)"],
      intent: "run", backgroundKind: "job", timeoutMs: 10_000 }, context);
    assert.equal(child.data?.status, "running", "service sandbox did not start a dependent job");
    const childStopped = await runtime.cancel(child.data.commandId, context);
    assert.equal(childStopped.status, "canceled");
    assert.equal(childStopped.lifecycle?.cleanup, "confirmed", "dependent job cleanup was not confirmed");
    const stillReady = await runTool.execute({ program: process.execPath, args: ["-e", client],
      intent: "test", timeoutMs: 3_000 }, context);
    assert.equal(stillReady.data?.exitCode, 0, "canceling a dependent job stopped the service");
    console.log("dependent job cancellation: ok");
  }

  const other = runTool.execute({ program: process.execPath, args: ["-e", "console.log('other agent')"],
    intent: "run" }, { ...context, threadId: "another-thread" });
  const otherEarly = await Promise.race([
    other.then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
  ]);
  assert.equal(otherEarly, "waiting", "another agent bypassed the service reservation");
  console.log("other-agent isolation: ok");

  const canceled = await runtime.cancel(handle, context);
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.lifecycle?.cleanup, "confirmed", JSON.stringify(canceled));
  const otherResult = await other;
  assert.equal(otherResult.data?.exitCode, 0);
  const after = await runTool.execute({ program: process.execPath, args: ["-e", client], intent: "test",
    timeoutMs: 3_000 }, context);
  assert.notEqual(after.data?.exitCode, 0, "service remained reachable after cancellation");
  console.log("service cancellation and lock release: ok");
} finally {
  await runtime.cancelAll();
  if (!path.resolve(root).startsWith(path.resolve(checkout) + path.sep)) {
    throw new Error("Service smoke cleanup path escaped the checkout");
  }
  await rm(root, { recursive: true, force: true });
}
