import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LocalLayaClient } from "../src/local-decision/client.js";
import { sharedLayaEndpoint } from "../src/local-decision/endpoint.js";
import { describe, it } from "./harness.js";

const execFileAsync = promisify(execFile);

async function waitForExit(address: string): Promise<void> {
  // Probing itself is a connection, so leave the one-second last-client grace
  // between probes instead of continually keeping the service alive.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1250));
    const alive = await new Promise<boolean>(resolve => {
      const socket = createConnection(address);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
    });
    if (!alive) return;
  }
  throw new Error("Shared model service remained after its last client disconnected");
}

describe("shared local Laya service", () => {
  it("loads one worker for concurrent clients and isolates cancellation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-laya-service-test-"));
    const workerPath = path.join(root, "fake-worker.mjs");
    const marker = path.join(root, "loads.txt");
    const separateClient = path.join(root, "separate-client.mjs");
    const source = `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(marker)}, 'loaded\\n');
process.stdout.write(JSON.stringify({type:'ready',modelSha256:'test-model',device:'cpu'})+'\\n');
let buffer='';
process.stdin.on('data', chunk => {
  buffer += String(chunk);
  for (let newline=buffer.indexOf('\\n'); newline>=0; newline=buffer.indexOf('\\n')) {
    const request=JSON.parse(buffer.slice(0,newline)); buffer=buffer.slice(newline+1);
    const options=request.task==='route' ? ['DIRECT','PLAN','CODE'] : ['RELEASE','CHALLENGE'];
    const scores=Object.fromEntries(options.map((item,index)=>[item,index===0?0.9:0.1/(options.length-1)]));
    setTimeout(()=>process.stdout.write(JSON.stringify({type:'result',id:request.id,task:request.task,
      input:request.input,inputTokens:3,truncated:false,optionOrder:options,scores,decision:options[0]})+'\\n'),
      request.input==='slow' ? 150 : 5);
  }
});`;
    await writeFile(workerPath, source);
    await writeFile(separateClient, `import { pathToFileURL } from 'node:url';
const { LocalLayaClient } = await import(pathToFileURL(process.argv[2]).href);
const client = new LocalLayaClient(JSON.parse(process.argv[3]), JSON.parse(process.argv[4]));
try { process.stdout.write((await client.decide('route', 'another process')).decision); }
finally { client.close(); }`);
    const options = { dataDir: root, python: process.execPath, workerPath };
    const limits = { startupMs: 10_000, decisionMs: 5_000, idleMs: 2_500 };
    const first = new LocalLayaClient(limits, options);
    const second = new LocalLayaClient(limits, options);
    const endpoint = sharedLayaEndpoint(options);
    try {
      const [a, b] = await Promise.all([first.decide("route", "first"), second.decide("delivery", "second")]);
      assert.equal(a.decision, "DIRECT");
      assert.equal(b.decision, "RELEASE");
      assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
      const modulePath = fileURLToPath(new URL("../src/local-decision/client.js", import.meta.url));
      const external = await execFileAsync(process.execPath, [separateClient, modulePath,
        JSON.stringify(limits), JSON.stringify(options)], { timeout: 10_000 });
      assert.equal(external.stdout, "DIRECT");
      assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
      await new Promise(resolve => setTimeout(resolve, 3000));
      assert.equal((await first.decide("route", "after idle")).decision, "DIRECT");
      assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 2);
      const controller = new AbortController();
      const canceled = first.decide("route", "slow", controller.signal);
      await new Promise(resolve => setTimeout(resolve, 30));
      controller.abort();
      await assert.rejects(canceled);
      assert.equal((await second.decide("route", "still alive")).decision, "DIRECT");
      first.close();
      assert.equal((await second.decide("delivery", "after first closed")).decision, "RELEASE");
      second.close();
      await waitForExit(endpoint.address);
      if (process.platform !== "win32") {
        const stale = spawnSync(process.execPath, ["-e", `const net=require('node:net'); const fs=require('node:fs');
          net.createServer().listen(${JSON.stringify(endpoint.address)}, () => {
            fs.writeSync(1, 'bound'); process.kill(process.pid, 'SIGKILL');
          });`], { encoding: "utf8", timeout: 5000 });
        assert.equal(stale.stdout, "bound");
        const recovered = new LocalLayaClient(limits, options);
        try { assert.equal((await recovered.decide("route", "after crash")).decision, "DIRECT"); }
        finally { recovered.close(); }
      }
    } finally {
      first.close(); second.close();
      await waitForExit(endpoint.address);
      await rm(root, { recursive: true, force: true });
    }
  });
});
