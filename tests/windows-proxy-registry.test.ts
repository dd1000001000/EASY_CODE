import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return Math.min(address.port, 65535 - 16);
}

async function startLeaseChild(dataDir: string, portStart: number): Promise<{
  child: ChildProcessWithoutNullStreams;
  port: number;
}> {
  const registryURL = new URL("../src/sandbox/windows-proxy-registry.js", import.meta.url).href;
  const gateURL = new URL("../src/command/network-gate.js", import.meta.url).href;
  const source = `
    const [{ acquireWindowsProxyPortLease }, { ensureSharedCommandNetworkGateServer }] =
      await Promise.all([import(process.argv[1]), import(process.argv[2])]);
    const lease = await acquireWindowsProxyPortLease({ dataDir: process.argv[3],
      portStart: Number(process.argv[4]), portSlots: 16, bind: ensureSharedCommandNetworkGateServer });
    await lease.markAuthorized();
    process.stdout.write(JSON.stringify({ port: lease.port }) + "\\n");
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once("data", resolve));
  `;
  const child = spawn(process.execPath,
    ["--input-type=module", "--eval", source, registryURL, gateURL, dataDir, String(portStart)],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const line = await new Promise<string>((resolve, reject) => {
    let output = ""; let errors = "";
    child.stdout.on("data", chunk => {
      output += String(chunk);
      const newline = output.indexOf("\n");
      if (newline >= 0) resolve(output.slice(0, newline));
    });
    child.stderr.on("data", chunk => { errors += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => {
      if (!output.includes("\n")) reject(new Error(`lease child exited ${String(code)}: ${errors}`));
    });
  });
  return { child, port: (JSON.parse(line) as { port: number }).port };
}

async function stop(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.stdin.end("stop\n");
  await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill();
}

describe("Windows sandbox process proxy registry", () => {
  it("leases distinct ports to concurrent CLI processes and persists their authorized union", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "easy-proxy-registry-"));
    const start = await freePort();
    let first: ChildProcessWithoutNullStreams | undefined;
    let second: ChildProcessWithoutNullStreams | undefined;
    try {
      const one = await startLeaseChild(dataDir, start); first = one.child;
      const two = await startLeaseChild(dataDir, start); second = two.child;
      assert.notEqual(one.port, two.port);
      const registry = JSON.parse(await readFile(path.join(dataDir, "native-sandbox", "proxy-ports.json"), "utf8")) as {
        provisionedPorts: number[]; leases: Array<{ port: number }>;
      };
      assert.deepEqual(registry.provisionedPorts, [one.port, two.port].sort((a, b) => a - b));
      assert.deepEqual(new Set(registry.leases.map(lease => lease.port)), new Set([one.port, two.port]));
    } finally {
      await Promise.all([stop(first), stop(second)]);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
