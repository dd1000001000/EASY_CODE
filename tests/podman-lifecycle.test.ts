import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { ensurePodmanInstalled } from "../src/sandbox/podman-install.js";
import { addPodman } from "../src/uninstall/podman.js";
import type { UninstallPlan } from "../src/uninstall/plan.js";
import type { OwnedResource } from "../src/install/ownership.js";
import { machineConnectionReceipts, reconcileAbsentMachine } from "../src/sandbox/podman-machine-state.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import { describe, it } from "./harness.js";

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
async function fixture(action: (f: Awaited<ReturnType<typeof engineFixture>>) => Promise<void>) {
  const f = await engineFixture();
  try { await action(f); }
  finally {
    assert.equal(path.dirname(f.home), os.tmpdir());
    assert.ok(path.basename(f.home).startsWith("easy-code-lifecycle-test-"));
    await rm(f.home, { recursive: true, force: true });
  }
}
async function engineFixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "easy-code-lifecycle-test-"));
  const file = path.join(home, "connections.json"), key = path.join(home, ".local", "share", "containers", "podman", "machine", "machine");
  await mkdir(path.dirname(key), { recursive: true }); await writeFile(key, "fixture key; not an actual SSH key");
  const resources: OwnedResource[] = [], calls: string[][] = [];
  const state = { machine: false, running: false, distro: false, generation: 0, failInit: false, failRemoval: false, port: 61206 };
  const endpoint = { uri: "ssh://user@127.0.0.1:61206/run/user/1000/podman/podman.sock", identity: key };
  const rootEndpoint = { uri: "ssh://root@127.0.0.1:61206/run/podman/podman.sock", identity: key };
  const foreign = { URI: "ssh://other@server.invalid/run/podman.sock", Identity: "foreign-key" };
  const read = async (): Promise<any> => JSON.parse(await readFile(file, "utf8"));
  const write = async (value: unknown) => writeFile(file, JSON.stringify(value));
  await write({ Connection: { Default: "unrelated", Connections: { unrelated: foreign } }, Farm: {} });
  const run = async (program: string, argv: string[]) => {
    calls.push([program, ...argv]);
    let args = argv;
    if (args[0] === "--connection") args = args.slice(2);
    if (args[0] === "--url") args = args.slice(4);
    if (program === "wsl.exe") return ok(state.distro ? "Ubuntu\npodman-easy-code" : "Ubuntu");
    if (args[0] === "--version") return ok("podman fixture");
    if (args.slice(0, 3).join(" ") === "system connection list") {
      const data = await read();
      return ok(JSON.stringify(Object.entries(data.Connection.Connections).map(([Name, value]) => ({
        Name, ...(value as object), Default: data.Connection.Default === Name, ReadWrite: true,
      }))));
    }
    if (args.slice(0, 3).join(" ") === "system connection add") {
      const data = await read();
      // Match actual Podman's normal connection add: no IsMachine field.
      data.Connection.Connections[args.at(-2)!] = { URI: args.at(-1), Identity: args[4] };
      await write(data); return ok();
    }
    if (args.slice(0, 3).join(" ") === "system connection remove") {
      const data = await read(); delete data.Connection.Connections[args[3]!];
      await write(data); return ok();
    }
    if (args[0] === "machine") {
      if (args[1] === "list") return ok(JSON.stringify(state.machine ? [{ Name: "easy-code", Running: state.running }] : []));
      if (args[1] === "init") {
        if (state.failInit) return { exitCode: 125, stdout: "", stderr: "fixture init failed" };
        state.machine = true; state.distro = true; state.generation++;
        const data = await read();
        data.Connection.Connections["easy-code"] = { URI: endpoint.uri, Identity: key, IsMachine: true };
        data.Connection.Connections["easy-code-root"] = { URI: rootEndpoint.uri, Identity: key, IsMachine: true };
        await write(data); return ok();
      }
      if (args[1] === "inspect") return ok(JSON.stringify([{ Name: "easy-code", Created: String(state.generation), Rootful: false,
        ConfigDir: { Path: path.join(home, "wsl") }, SSHConfig: { Port: state.port, IdentityPath: key, RemoteUsername: "user" },
        State: state.running ? "running" : "stopped" }]));
      if (args[1] === "start" && args.includes("--help")) return ok("--update-connection");
      if (args[1] === "start") { state.running = true; return ok(); }
      if (args[1] === "stop") { state.running = false; return ok(); }
      if (args[1] === "ssh") return ok("1000");
      if (args[1] === "rm") {
        state.machine = false; state.distro = false;
        if (state.failRemoval) return { exitCode: 125, stdout: "", stderr: 'Error: failed to remove machines files: unable to find connection named "easy-code-root"' };
        const data = await read(); delete data.Connection.Connections["easy-code"]; delete data.Connection.Connections["easy-code-root"];
        await write(data); return ok();
      }
    }
    if (args[0] === "info") return ok(JSON.stringify({ host: { security: { rootless: true } } }));
    if (["ps", "volume", "images"].includes(args[0]!)) return ok("[]");
    throw new Error("Unexpected fixture command: " + args.join(" "));
  };
  const setup = (runner = run) => ensurePodmanInstalled(DEFAULT_RUNTIME_LIMITS, { run: runner, platform: "win32", home, connectionsFile: file,
    executable: () => "podman", resources, record: resource => { resources.push(resource); } });
  const plan = async (runner = run) => {
    const plan: UninstallPlan = { actions: [], warnings: [], blockers: [], resources, home, roots: { data: [], config: [], cache: [] } };
    await addPodman(plan, runner, "win32", "podman", file); return plan;
  };
  return { home, file, key, run, calls, resources, state, endpoint, foreign, read, write, setup, plan };
}

describe("shared Podman installation lifecycle", () => {
  it("repairs the reported live VM at 63256 with a lone legacy alias at 61206 without recreating it", async () => fixture(async f => {
    await f.setup();
    f.state.port = 63256;
    const data = await f.read();
    data.Connection.Default = "easy-code";
    data.Connection.Connections["easy-code"] = { URI: f.endpoint.uri, Identity: f.key };
    delete data.Connection.Connections["easy-code-root"];
    await f.write(data);
    // Even a newer receipt must not turn a legacy old-port index into foreign ownership.
    f.resources.push({ kind: "machine-connection", name: "easy-code", connection: "easy-code", path: f.file,
      identity: JSON.stringify({ ...f.endpoint, uri: f.endpoint.uri.replace("61206", "63256") }) });
    f.calls.length = 0;
    await f.setup(); await f.setup();
    const after = await f.read();
    assert.equal(after.Connection.Connections["easy-code"].URI, f.endpoint.uri.replace("61206", "63256"));
    assert.equal(after.Connection.Connections["easy-code-root"].URI, "ssh://root@127.0.0.1:63256/run/podman/podman.sock");
    assert.equal(after.Connection.Default, "easy-code");
    assert.deepEqual(after.Connection.Connections.unrelated, f.foreign);
    assert.equal(f.calls.filter(c => c.slice(1, 4).join(" ") === "system connection add").length, 2);
    assert.ok(!f.calls.some(c => ["init", "rm", "start", "stop", "remove"].some(arg => c.includes(arg))));
  }));
  it("uninstall previews stale live aliases read-only and removes them only on confirmed execution", async () => fixture(async f => {
    await f.setup(); f.state.port = 63256;
    const data = await f.read(); delete data.Connection.Connections["easy-code-root"];
    delete data.Connection.Connections["easy-code"].IsMachine;
    await f.write(data); const before = await readFile(f.file);
    f.calls.length = 0;
    const plan = await f.plan(); assert.deepEqual(plan.blockers, []);
    assert.ok(plan.warnings.some(message => message.includes("stale connection")));
    assert.deepEqual(await readFile(f.file), before);
    assert.ok(!f.calls.some(c => ["add", "remove", "stop", "rm"].some(arg => c.includes(arg))));
    f.state.failRemoval = true;
    await plan.actions.find(a => a.id === "machine:easy-code")!.execute();
    assert.ok(!f.calls.some(c => c.includes("add")), "Uninstall does not recreate or retarget aliases just to remove them");
    assert.equal(f.state.machine, false);
    assert.deepEqual((await f.read()).Connection.Connections, { unrelated: f.foreign });
    f.state.failRemoval = false;
    await f.setup();
    const second = await f.plan(); assert.deepEqual(second.blockers, [], "Use the latest VM identity receipt after reinstall");
    await second.actions.find(a => a.id === "machine:easy-code")!.execute();
  }));
  it("refuses live aliases with different keys, roles, foreign machines or inconsistent registry evidence", async () => fixture(async f => {
    await f.setup(); f.state.port = 63256;
    const baseline = await f.read();
    for (const reason of ["key", "user", "socket", "host", "other-machine", "source"] as const) {
      const data = structuredClone(baseline);
      const alias = data.Connection.Connections["easy-code"];
      if (reason === "key") alias.Identity = path.join(f.home, "unrelated-key");
      if (reason === "user") alias.URI = alias.URI.replace("user@", "other@");
      if (reason === "socket") alias.URI = alias.URI.replace("/1000/", "/1001/");
      if (reason === "host") alias.URI = alias.URI.replace("127.0.0.1", "remote.invalid");
      await f.write(data); f.calls.length = 0;
      const run: typeof f.run = async (program, args) => {
        if (reason === "other-machine" && args[0] === "machine" && args[1] === "list")
          return ok(JSON.stringify([{ Name: "easy-code" }, { Name: "foreign-machine" }]));
        if (reason === "other-machine" && args[0] === "machine" && args[1] === "inspect" && args[2] === "foreign-machine")
          return ok(JSON.stringify([{ Name: "foreign-machine", SSHConfig: { Port: 61206 } }]));
        const result = await f.run(program, args);
        if (reason === "source" && args.slice(0, 3).join(" ") === "system connection list")
          result.stdout = result.stdout.replaceAll("61206", "61207");
        return result;
      };
      await assert.rejects(f.setup(run), /does not match|another Podman machine|source mismatch/u, reason);
      const plan = await f.plan(run); assert.ok(plan.blockers.length, reason);
      assert.deepEqual(await f.read(), data);
      assert.ok(!f.calls.some(c => ["add", "remove", "stop", "rm"].some(arg => c.includes(arg))), reason);
    }
  }));
  it("rechecks before confirmed uninstall and preserves a connection changed after preview", async () => fixture(async f => {
    await f.setup(); f.state.port = 63256;
    const plan = await f.plan(); assert.deepEqual(plan.blockers, []);
    const data = await f.read(); data.Connection.Connections["easy-code-root"].URI = "ssh://root@foreign.invalid/run/podman/podman.sock";
    await f.write(data); f.calls.length = 0;
    await assert.rejects(plan.actions.find(a => a.id === "machine:easy-code")!.execute(), /does not match/u);
    assert.ok(!f.calls.some(c => ["add", "remove", "stop", "rm"].some(arg => c.includes(arg))));
    assert.equal(f.state.machine, true);
  }));
  it("fresh install, lost registry repair, partial removal and reinstall share the same ownership contract", async () => fixture(async f => {
    await f.setup();
    assert.equal(f.state.generation, 1);
    const data = await f.read(); delete data.Connection.Connections["easy-code"]; delete data.Connection.Connections["easy-code-root"];
    await f.write(data); await f.setup();
    assert.equal(f.state.generation, 1, "Repair must not recreate the VM");
    const repaired = await f.read();
    assert.equal(repaired.Connection.Connections["easy-code"].IsMachine, undefined);
    assert.equal(repaired.Connection.Connections["easy-code-root"].IsMachine, undefined);
    assert.equal(machineConnectionReceipts(f.resources, "easy-code", f.file, "win32").size, 2);
    // Provider removes the VM, then fails on missing alias metadata.
    f.state.failRemoval = true;
    const plan = await f.plan(); assert.deepEqual(plan.blockers, []);
    await plan.actions.find(a => a.id === "machine:easy-code")!.execute();
    assert.deepEqual((await f.read()).Connection, { Default: "unrelated", Connections: { unrelated: f.foreign } });
    await f.setup(); await f.setup();
    assert.equal(f.state.generation, 2, "Idempotent setup must not repeat init");
    assert.equal(f.calls.filter(c => c.includes("init")).length, 2);
    assert.ok(!f.calls.some(c => c.includes("reset") || c.includes("prune") || c.includes("--all") && !c.includes("ps")));
  }));
  it("migrates the reported single ordinary legacy alias without receipts before init", async () => fixture(async f => {
    const data = await f.read();
    data.Connection.Connections["easy-code"] = { URI: f.endpoint.uri, Identity: f.key };
    await f.write(data); await f.setup();
    assert.equal(f.state.generation, 1);
    const removal = f.calls.findIndex(c => c.slice(1, 4).join(" ") === "system connection remove");
    const creation = f.calls.findIndex(c => c.includes("init"));
    assert.ok(removal >= 0 && removal < creation);
    assert.deepEqual((await f.read()).Connection.Connections.unrelated, f.foreign);
    assert.equal((await f.read()).Connection.Default, "unrelated");
  }));
  it("rejects foreign legacy keys/endpoints, a surviving WSL VM and source mismatches before init", async () => fixture(async f => {
    for (const failure of ["foreign-key", "foreign-endpoint", "live-distro", "different-source"]) {
      const data = await f.read();
      data.Connection.Connections["easy-code"] = { URI: failure === "foreign-endpoint" ? f.foreign.URI : f.endpoint.uri,
        Identity: failure === "foreign-key" ? path.join(f.home, "other-key") : f.key };
      await f.write(data); f.state.distro = failure === "live-distro";
      if (failure === "different-source") {
        const other = path.join(f.home, "other.json"); await writeFile(other, JSON.stringify({ Connection: {} }));
        await assert.rejects(reconcileAbsentMachine(f.run, "podman", "easy-code", "win32", { home: f.home, connectionsFile: other }), /source mismatch/u);
      } else await assert.rejects(f.setup(), /Unverified orphan|not confirmed/u);
    }
    assert.ok(!f.calls.some(c => c.includes("init") || c.includes("remove")));
  }));
  it("does not replay failed init and resumes from the observed next state on the next invocation", async () => fixture(async f => {
    f.state.failInit = true;
    await assert.rejects(f.setup(), /init failed/u);
    assert.equal(f.calls.filter(c => c.includes("init")).length, 1);
    f.state.failInit = false; await f.setup();
    assert.equal(f.calls.filter(c => c.includes("init")).length, 2);
    assert.equal(f.state.generation, 1);
  }));
  it("binds receipts to the selected registry and refuses stale endpoint proof", async () => fixture(async f => {
    const customKey = path.join(f.home, "custom-machine-key");
    const data = await f.read();
    data.Connection.Connections["easy-code"] = { URI: f.endpoint.uri, Identity: customKey, IsMachine: false };
    await f.write(data);
    const resource: OwnedResource = { kind: "machine-connection", name: "easy-code", connection: "easy-code", path: f.file,
      identity: JSON.stringify({ uri: f.endpoint.uri, identity: customKey }) };
    assert.equal(machineConnectionReceipts([resource], "easy-code", path.join(f.home, "other.json"), "win32").size, 0);
    const stale = { ...resource, identity: JSON.stringify({ uri: f.endpoint.uri.replace("61206", "61207"), identity: customKey }) };
    await assert.rejects(reconcileAbsentMachine(f.run, "podman", "easy-code", "win32", { home: f.home, connectionsFile: f.file,
      receipts: machineConnectionReceipts([stale], "easy-code", f.file, "win32") }), /recorded endpoint\/identity changed/u);
    assert.ok(!f.calls.some(c => c.includes("remove")));
    await reconcileAbsentMachine(f.run, "podman", "easy-code", "win32", { home: f.home, connectionsFile: f.file,
      receipts: machineConnectionReceipts([resource], "easy-code", f.file, "win32") });
    assert.deepEqual((await f.read()).Connection.Connections, { unrelated: f.foreign });
  }));
  it("preserves an alias using the shared Podman key but pointing to another machine", async () => fixture(async f => {
    const data = await f.read(); data.Connection.Connections["easy-code"] = { URI: f.endpoint.uri, Identity: f.key };
    await f.write(data);
    const run: typeof f.run = async (program, args) => {
      if (args[0] === "machine" && args[1] === "list") return ok(JSON.stringify([{ Name: "other-machine" }]));
      if (args[0] === "machine" && args[1] === "inspect") return ok(JSON.stringify([{ Name: "other-machine", SSHConfig: { Port: 61206 } }]));
      return f.run(program, args);
    };
    await assert.rejects(reconcileAbsentMachine(run, "podman", "easy-code", "win32", { home: f.home, connectionsFile: f.file }), /another Podman machine/u);
    assert.ok(!f.calls.some(c => c.includes("remove")));
  }));
});
