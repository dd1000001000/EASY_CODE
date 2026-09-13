import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import { buildFilePlan, type UninstallPlan } from "../src/uninstall/plan.js";
import { executeUninstall, activeOwners } from "../src/uninstall/execute.js";
import { runUninstall } from "../src/uninstall/cli.js";
import { addPodman, machineIdentity } from "../src/uninstall/podman.js";
import { finishMachineRemoval, validateOrphanConnections } from "../src/sandbox/podman-machine-state.js";
import { rootMachineEndpoint } from "../src/sandbox/podman-connection.js";
import { addWorktrees } from "../src/uninstall/worktrees.js";
import { addCredentials, addExtensions, addPackage, EXTENSION_ID } from "../src/uninstall/integrations.js";
import { assertNoUninstall, maintenanceLock, recordOwnedResource, readOwnedResources } from "../src/install/ownership.js";
import { registerRuntimeSession } from "../src/install/session.js";
import type { SystemRunner } from "../src/uninstall/system.js";
import { describe, it } from "./harness.js";
import { podmanArguments, podmanConnectionsFile, podmanEnvironment, podmanExecutable } from "../src/sandbox/podman-client.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";

function put(file: string, value = "data") { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); }
async function fixture(run: (t: { root: string; home: string; data: string; config: string; cache: string; plan: () => Promise<UninstallPlan> }) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "easy-code-full-uninstall-test-"));
  const home = path.join(root, "home"), data = path.join(root, "data"), config = path.join(root, "config"), cache = path.join(root, "cache");
  mkdirSync(home); const temporaryRoot = path.join(root, "tmp"); mkdirSync(temporaryRoot);
  try { await run({ root, home, data, config, cache, plan: () => buildFilePlan({ home, paths: { data, config, cache }, env: {}, temporaryRoot }) }); }
  finally { assert.equal(path.dirname(root), os.tmpdir()); rmSync(root, { recursive: true, force: true }); }
}
const ok = (value = "") => ({ exitCode: 0, stdout: value, stderr: "" });
const rows = (value: unknown) => ok(JSON.stringify(value));
function fakeMachine(root: string, state = "running") {
  const key = path.join(root, "fixture-ssh-key"); put(key, "fixture, never an actual key");
  return { Name: "easy-code", Created: "fixture", ConfigDir: { Path: "fixture" }, Rootful: false, State: state,
    SSHConfig: { IdentityPath: key, Port: 61206, RemoteUsername: "user" } };
}

describe("full uninstall ownership and lifecycle", () => {
  it("previews without changes, removes all known data/config/cache, and preserves project siblings", async () => fixture(async t => {
    put(path.join(t.data, "threads", "one", "events.jsonl"));
    put(path.join(t.data, "podman", "cache"));
    put(path.join(t.config, "config.toml"), "invalid toml [");
    put(path.join(t.cache, "models", "embedding", "model.onnx"));
    put(path.join(t.home, ".easy_code", "models.toml"), "invalid model [");
    put(path.join(t.data, "user-sentinel.txt"), "keep");
    const project = path.join(t.root, "project", "source.ts"); put(project, "keep");
    const plan = await t.plan();
    assert.equal(plan.blockers.length, 0, plan.blockers.join("\n"));
    assert.ok(existsSync(path.join(t.home, ".easy_code", "models.toml")));
    assert.ok(!existsSync(maintenanceLock(t.home)));
    await executeUninstall(plan, { activity: async () => [] });
    assert.ok(!existsSync(path.join(t.data, "threads")));
    assert.ok(!existsSync(t.config)); assert.ok(!existsSync(t.cache)); assert.ok(!existsSync(path.join(t.home, ".easy_code")));
    assert.equal(readFileSync(project, "utf8"), "keep");
    assert.equal(readFileSync(path.join(t.data, "user-sentinel.txt"), "utf8"), "keep");
    await executeUninstall(await t.plan(), { activity: async () => [] });
  }));
  it("never follows an ancestor junction or deletes an unverified custom root", async () => fixture(async t => {
    const external = path.join(t.root, "external"); put(path.join(external, "threads", "keep"));
    mkdirSync(t.data); symlinkSync(external, path.join(t.data, "threads"), process.platform === "win32" ? "junction" : "dir");
    const plan = await t.plan();
    await executeUninstall(plan, { activity: async () => [] });
    assert.ok(existsSync(path.join(external, "threads", "keep")));
    recordOwnedResource({ kind: "data", path: external }, t.home);
    const unknown = await t.plan();
    assert.ok(unknown.blockers.some(s => s.includes("Unverified")));
    await assert.rejects(executeUninstall(unknown), /blocked/u);
  }));
  it("requires the executor caller to carry full-plan consent before ANY mutation", async () => fixture(async t => {
    const file = path.join(t.config, "config.toml"); put(file);
    const plan = await t.plan(); plan.actions[0]!.confirmation = "separate-resource";
    await assert.rejects(executeUninstall(plan, { activity: async () => [] }), /not fully confirmed/u);
    assert.ok(existsSync(file)); assert.ok(!existsSync(maintenanceLock(t.home)));
  }));
  it("retains data and recovery state on failure; a second run can finish without the old config", async () => fixture(async t => {
    put(path.join(t.config, "config.toml"));
    const plan = await t.plan();
    plan.actions.push({ id: "broken-sandbox", phase: 20, target: "fixture", description: "fail", execute: async () => { throw new Error("engine unreachable"); } });
    await assert.rejects(executeUninstall(plan, { activity: async () => [] }), /unreachable/u);
    assert.ok(existsSync(path.join(t.config, "config.toml")));
    assert.ok(existsSync(path.join(t.home, ".easy-code-uninstall-state.json")));
    assert.ok(!existsSync(maintenanceLock(t.home)));
    await executeUninstall(await t.plan(), { activity: async () => [] });
    assert.ok(!existsSync(path.join(t.home, ".easy-code-uninstall-state.json")));
  }));
  it("rejects newly registered resources after preview before deleting any data", async () => fixture(async t => {
    put(path.join(t.config, "config.toml"));
    const plan = await t.plan();
    recordOwnedResource({ kind: "credential", name: "late.api-key" }, t.home);
    await assert.rejects(executeUninstall(plan, { activity: async () => [] }), /New resources/u);
    assert.ok(existsSync(path.join(t.config, "config.toml")));
  }));
  it("blocks new runtime sessions and cooperatively drains an existing session before deleting", async () => fixture(async t => {
    let notified = 0; let release: () => void = () => {};
    release = registerRuntimeSession(() => { notified++; release(); }, t.home);
    const plan = await t.plan();
    plan.actions.unshift({ id: "check-lock", phase: 1, target: "fixture", description: "check", execute: async () => {
      assert.throws(() => assertNoUninstall(t.home), /uninstall/u);
      assert.throws(() => registerRuntimeSession(() => {}, t.home), /uninstall/u);
    } });
    await executeUninstall(plan, { shutdownTimeoutMs: 3000 });
    assert.equal(notified, 1);
    assertNoUninstall(t.home);
  }));
  it("does not erase active/unknown leases or advance to npm after a shutdown timeout", async () => fixture(async t => {
    put(path.join(t.config, "config.toml"));
    const plan = await t.plan(); let removed = false;
    plan.actions.push({ id: "npm", phase: 100, target: "npm", description: "npm", execute: async () => { removed = true; } });
    await assert.rejects(executeUninstall(plan, { activity: async () => ["unknown PID"], shutdownTimeoutMs: 0 }), /active\/unknown/u);
    assert.equal(removed, false); assert.ok(existsSync(path.join(t.config, "config.toml")));
  }));
  it("removes only the EASY CODE credential service and extension, without reading key contents", async () => fixture(async t => {
    const plan = await t.plan(); const removed: string[] = [];
    recordOwnedResource({ kind: "credential", name: "custom.api-key" }, t.home);
    plan.resources = readOwnedResources(t.home);
    await addCredentials(plan, async slot => { removed.push(slot); });
    let installed = true; const calls: string[][] = [];
    await addExtensions(plan, { programs: ["fixture-code"], run: (_program, args) => {
      calls.push(args); if (args[0] === "--uninstall-extension") installed = false;
      return { status: 0, stdout: installed ? EXTENSION_ID + "\nother.extension" : "other.extension" };
    } });
    await executeUninstall(plan, { activity: async () => [] });
    assert.ok(removed.includes("custom.api-key"));
    assert.deepEqual(calls.filter(c => c[0] === "--uninstall-extension"), [["--uninstall-extension", EXTENSION_ID]]);
  }));
  it("uninstalls an npm junction through npm, never recursively deletes its source checkout", async () => fixture(async t => {
    const source = path.join(t.root, "source"), prefix = path.join(t.root, "prefix"), root = path.join(prefix, "node_modules");
    put(path.join(source, "package.json"), JSON.stringify({ name: "easy-code-agent" }));
    put(path.join(source, "source.ts"), "keep"); mkdirSync(root, { recursive: true });
    const linked = path.join(root, "easy-code-agent");
    symlinkSync(source, linked, process.platform === "win32" ? "junction" : "dir");
    const plan = await t.plan(); const calls: string[][] = [];
    await addPackage(plan, { command: "node", args: ["npm-cli.js", "uninstall", "--global", "easy-code-agent"], shell: false },
      async invocation => { calls.push([...invocation.args]); const { unlink } = await import("node:fs/promises"); await unlink(linked); },
      async (_p, args) => ok(args.includes("root") ? root : prefix), source);
    assert.equal(plan.blockers.length, 0);
    await executeUninstall(plan, { activity: async () => [] });
    assert.ok(calls[0]!.includes("--ignore-scripts")); assert.ok(existsSync(path.join(source, "source.ts")));
  }));
});

describe("full uninstall Podman isolation", () => {
  it("optionally previews a real VM with a missing registry without creating a connection or deleting anything", async () => fixture(async t => {
    if (process.env.EASY_CODE_TEST_REAL_PODMAN !== "1") return;
    if (!["win32", "darwin"].includes(process.platform)) throw new Error("Real uninstall preview test requires a desktop machine");
    const realFile = podmanConnectionsFile(), before = readFileSync(realFile);
    const isolated = path.join(t.root, "missing-connections.json");
    const env = { ...podmanEnvironment(), PODMAN_CONNECTIONS_CONF: isolated };
    const calls: string[][] = [];
    const run: SystemRunner = async (program, args) => {
      assert.equal(program, podmanExecutable()); calls.push(args);
      assert.ok(args.every(arg => !["init", "start", "stop", "rm", "add", "default", "reset", "prune", "build", "pull"].includes(arg)), "Preview must not mutate Podman");
      const result = await execa(program, args, { cwd: t.root, env, extendEnv: false, reject: false, shell: false, windowsHide: true, timeout: 30000 });
      return { exitCode: result.exitCode ?? 125, stdout: result.stdout, stderr: result.stderr };
    };
    const missing = await run(podmanExecutable(), podmanArguments(["info", "--format", "json"], DEFAULT_RUNTIME_LIMITS));
    assert.equal(missing.exitCode, 125); assert.match(missing.stderr, /connection.*not found/u);
    const plan = await t.plan();
    await addPodman(plan, run);
    assert.deepEqual(plan.blockers, []);
    assert.ok(plan.actions.some(action => action.id === "machine:easy-code"));
    assert.ok(calls.some(args => args[0] === "--url" && args.includes("info")));
    assert.equal(existsSync(isolated), false, "Read-only preview must not repair the registry");
    assert.deepEqual(readFileSync(realFile), before);
  }));
  it("blocks foreign aliases and changed endpoints instead of deleting through a stale preview", async () => fixture(async t => {
    for (const change of ["foreign-before", "foreign-after", "port", "rootful", "unreachable"] as const) {
      const plan = await t.plan(), machine = fakeMachine(t.root);
      const calls: string[][] = []; let foreign = change === "foreign-before";
      const run: SystemRunner = async (_p, args) => {
        calls.push(args);
        if (args[0] === "--version") return ok();
        if (args[0] === "machine" && args[1] === "list") return rows([{ Name: machine.Name }]);
        if (args[0] === "machine" && args[1] === "inspect") return rows([machine]);
        if (args[0] === "machine" && args[1] === "ssh") return ok("1000");
        if (args[0] === "system") return rows(foreign ? [{ Name: "easy-code", URI: "ssh://foreign.example/run/podman.sock", Identity: machine.SSHConfig.IdentityPath }] : []);
        if (args.includes("info")) return change === "unreachable" ? { exitCode: 125, stdout: "", stderr: "connection refused" } : rows({ host: { security: { rootless: true } } });
        if (args.includes("stop") || args.includes("rm") || args.includes("add")) throw new Error("Unexpected mutation");
        return rows([]);
      };
      await addPodman(plan, run, "win32", "podman");
      if (change === "foreign-before" || change === "unreachable") assert.ok(plan.blockers.length > 0);
      else {
        assert.deepEqual(plan.blockers, []);
        if (change === "port") machine.SSHConfig.Port++;
        if (change === "rootful") machine.Rootful = true;
        if (change === "foreign-after") foreign = true;
        await assert.rejects(plan.actions.find(action => action.id === "machine:easy-code")!.execute(), /changed|different endpoint|does not match/u);
      }
      assert.ok(calls.every(args => !args.some(arg => ["stop", "rm", "add", "--connection"].includes(arg))));
    }
  }));
  it("only uninstalls an auto-installed macOS Podman when no machines or connections remain", async () => fixture(async t => {
    for (const shared of [false, true]) {
      const plan = await t.plan();
      plan.resources.push({ kind: "podman-install", method: "brew", path: "/opt/homebrew/bin/brew" });
      const calls: Array<[string, string[]]> = [];
      const run: SystemRunner = async (program, args) => {
        calls.push([program, args]);
        if (args[0] === "--version") return ok();
        if (args[0] === "machine") return rows([]);
        if (args[0] === "system") return rows(shared ? [{ Name: "other-remote" }] : []);
        if (program === "/opt/homebrew/bin/brew") return ok();
        throw new Error("Unexpected operation");
      };
      await addPodman(plan, run, "darwin", "podman");
      await executeUninstall(plan, { activity: async () => [] });
      assert.equal(calls.some(([program]) => program === "/opt/homebrew/bin/brew"), !shared);
    }
  }));
  it("does not start a stopped machine during preview; verifies it after confirmation", async () => fixture(async t => {
    const plan = await t.plan(); let present = true; const calls: string[][] = [];
    const machine = fakeMachine(t.root, "stopped");
    const run: SystemRunner = async (_p, args) => {
      calls.push(args);
      if (args[0] === "--version") return ok();
      if (args[0] === "machine") {
        if (args[1] === "list") return rows(present ? [{ Name: machine.Name, Running: machine.State === "running" }] : []);
        if (args[1] === "inspect") return rows([machine]);
        if (args[1] === "ssh") return ok("1000");
        if (args[1] === "start" && args.includes("--help")) return ok("--update-connection");
        if (args[1] === "start") machine.State = "running";
        if (args[1] === "stop") machine.State = "stopped";
        if (args[1] === "rm") present = false;
        return ok();
      }
      if (args.includes("info")) return rows({ host: { security: { rootless: true } } });
      return rows([]);
    };
    await addPodman(plan, run, "win32", "podman");
    assert.equal(plan.blockers.length, 0);
    assert.ok(calls.every(a => a[1] !== "start"));
    await executeUninstall(plan, { confirmations: ["machine:easy-code"], activity: async () => [] });
    assert.equal(present, false);
    assert.ok(calls.some(a => a.includes("--update-connection=false")));
  }));
  it("on Linux removes only owned resources and leaves foreign containers and software alone", async () => fixture(async t => {
    const owner = "a".repeat(64), id = "b".repeat(64), name = "easy-code-" + "c".repeat(32);
    put(path.join(t.data, "podman", owner, "task.json"), JSON.stringify({ owner, name }));
    const plan = await t.plan(); const removed = new Set<string>(); const calls: string[][] = [];
    const owned = { Id: id, Names: [name], Labels: { "io.easy-code.owner": owner }, State: { Running: true } };
    const foreign = { Id: "foreign-id", Names: ["database"], Labels: {} };
    const run: SystemRunner = async (_program, args) => {
      calls.push(args);
      if (args[0] === "--version") return ok();
      if (args[0] === "info") return rows({ host: { security: { rootless: true } } });
      if (args[0] === "ps") return rows([...(removed.has(id) ? [] : [owned]), foreign]);
      if (args[0] === "images" || args[0] === "volume") return rows([]);
      if (args[0] === "container" && args[1] === "inspect") return rows([owned]);
      if (args[0] === "container" && args[1] === "exists") return { ...ok(), exitCode: removed.has(id) ? 1 : 0 };
      if (args[0] === "stop") { owned.State.Running = false; return ok(); }
      if (args[0] === "rm") { removed.add(args[1]!); return ok(); }
      throw new Error("Unexpected fake engine call: " + args.join(" "));
    };
    await addPodman(plan, run, "linux", "podman");
    assert.deepEqual(plan.blockers, []);
    await executeUninstall(plan, { activity: async () => [] });
    assert.deepEqual([...removed], [id]);
    assert.ok(calls.every(args => !args.includes("machine") && !args.includes("prune") && !args.includes("foreign-id")));
  }));
  it("includes legacy machines in full-plan consent and never uses global reset/prune", async () => fixture(async t => {
    const plan = await t.plan(); let present = true; const calls: string[][] = [];
    const machine = fakeMachine(t.root);
    const run: SystemRunner = async (_p, args) => {
      calls.push(args);
      if (args[0] === "--version") return ok("podman");
      if (args[0] === "machine") {
        if (args[1] === "list") return rows(present ? [{ Name: "easy-code" }] : []);
        if (args[1] === "inspect") return rows([machine]);
        if (args[1] === "ssh") return ok("1000");
        if (args[1] === "rm") present = false;
        return ok();
      }
      if (args[0] === "system") return rows([]);
      if (args.includes("info")) return rows({ host: { security: { rootless: true } } });
      return rows([]);
    };
    await addPodman(plan, run, "win32", "podman");
    assert.equal(plan.blockers.length, 0);
    assert.equal(plan.actions.find(a => a.id === "machine:easy-code")?.confirmation, "machine:easy-code");
    assert.ok(plan.warnings.some(line => line.includes("No connection was created")));
    assert.ok(calls.some(args => args[0] === "--url" && args.includes("--identity")));
    assert.ok(calls.every(args => !args.includes("--connection") && !args.includes("add")));
    await assert.rejects(executeUninstall(plan, { activity: async () => [] }), /not fully confirmed/u);
    assert.equal(present, true);
    await executeUninstall(plan, { confirmations: ["machine:easy-code"], activity: async () => [] });
    assert.equal(present, false); assert.ok(calls.every(a => !a.includes("prune") && !a.includes("reset")));
  }));
  it("preserves foreign workloads and rejects machine identity changes", async () => fixture(async t => {
    for (const changed of [false, true]) {
      const plan = await t.plan();
      const machine = { ...fakeMachine(t.root), Created: "now" };
      if (changed) plan.resources.push({ kind: "machine", name: "easy-code", identity: machineIdentity({ ...machine, Created: "before" }) });
      const run: SystemRunner = async (_p, args) => {
        if (args[0] === "--version") return ok();
        if (args[0] === "machine") return args[1] === "ssh" ? ok("1000") : rows(args[1] === "inspect" ? [machine] : [{ Name: "easy-code" }]);
        if (args.includes("info")) return rows({ host: { security: { rootless: true } } });
        if (args.includes("ps")) return rows([{ Id: "foreign", Names: ["user-container"], Labels: {} }]);
        return rows([]);
      };
      await addPodman(plan, run, "win32", "podman");
      assert.ok(plan.blockers.length > 0); assert.ok(!plan.actions.some(a => a.id.startsWith("machine:")));
    }
  }));
});

function orphanEngine(home: string) {
  const endpoint = { uri: "ssh://user@127.0.0.1:61206/run/user/1000/podman/podman.sock",
    identity: path.join(home, ".local", "share", "containers", "podman", "machine", "machine") };
  const root = rootMachineEndpoint(endpoint);
  const engine = {
    endpoint, present: false, distroPresent: false, ignoreRemoval: false,
    connections: [
      { Name: "easy-code", URI: endpoint.uri, Identity: endpoint.identity, IsMachine: true, ReadWrite: true, Default: false },
      { Name: "easy-code-root", URI: root.uri, Identity: root.identity, IsMachine: true, ReadWrite: true, Default: false },
      { Name: "unrelated", URI: "ssh://user@server.invalid/run/podman.sock", Identity: "foreign", IsMachine: false, ReadWrite: true, Default: true },
    ], calls: [] as string[][],
  };
  const run: SystemRunner = async (program, args) => {
    engine.calls.push([program, ...args]);
    if (args[0] === "--version") return ok("podman version 5.8.3");
    if (program === "wsl.exe") return ok("U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\r\u0000\n\u0000" + (engine.distroPresent ? "podman-easy-code\r\n" : ""));
    if (args[0] === "machine" && args[1] === "list") return rows(engine.present ? [{ Name: "easy-code" }] : []);
    if (args.slice(0, 3).join(" ") === "system connection list") return rows(engine.connections);
    if (args.slice(0, 3).join(" ") === "system connection remove") {
      if (!engine.ignoreRemoval) engine.connections = engine.connections.filter(row => row.Name !== args[3]);
      return ok();
    }
    throw new Error("Unexpected engine operation: " + args.join(" "));
  };
  return { engine, run };
}

function connectionRegistry(connections: readonly { Name: string; URI: string; Identity: string; IsMachine?: boolean }[]) {
  return { Connection: { Default: "unrelated", Connections: Object.fromEntries(connections.map(row => [row.Name, {
    URI: row.URI, Identity: row.Identity, IsMachine: row.IsMachine,
  }])) }, Farm: {} };
}
function omitMachineFlag(run: SystemRunner): SystemRunner {
  return async (program, args, cwd) => {
    const result = await run(program, args, cwd);
    if (result.exitCode === 0 && args.slice(0, 3).join(" ") === "system connection list") {
      const entries = JSON.parse(result.stdout);
      for (const entry of entries) delete entry.IsMachine;
      return { ...result, stdout: JSON.stringify(entries) };
    }
    return result;
  };
}

describe("partial Podman uninstall recovery", () => {
  const missingRoot = { exitCode: 125, stdout: "Unregistering...", stderr: 'Error: failed to remove machines files: unable to find connection named "easy-code-root"' };
  it("normalizes short/long identity paths even when the key has already been removed", async () => fixture(async t => {
    const { engine } = orphanEngine(realpathSync.native(t.home));
    const own = engine.connections.filter(row => row.Name.startsWith("easy-code"));
    assert.equal(existsSync(own[0]!.Identity), false);
    assert.doesNotThrow(() => validateOrphanConnections(own, "easy-code", t.home, process.platform));
  }));
  it("reports the exact failed ownership check instead of an undifferentiated rejection", async () => fixture(async t => {
    const { engine } = orphanEngine(t.home), own = engine.connections.filter(row => row.Name.startsWith("easy-code"));
    own[0]!.IsMachine = false;
    assert.throws(() => validateOrphanConnections(own, "easy-code", t.home, process.platform), /missing registry\/receipt ownership evidence/u);
    own[0]!.IsMachine = true; own[0]!.Identity = path.join(t.home, "other-key");
    assert.throws(() => validateOrphanConnections(own, "easy-code", t.home, process.platform), /identity path mismatch: expected .*received/u);
  }));
  it("recovers omitted CLI machine flags only from the selected matching registry", async () => fixture(async t => {
    const { engine, run } = orphanEngine(t.home), file = path.join(t.root, "connections.json"), plan = await t.plan();
    const registry = connectionRegistry(engine.connections);
    // Canonical/short paths still describe the same (already deleted) key.
    registry.Connection.Connections["easy-code"]!.Identity = path.join(realpathSync.native(t.home), ".local", "share", "containers", "podman", "machine", "machine");
    put(file, JSON.stringify(registry));
    await addPodman(plan, omitMachineFlag(run), "win32", "podman", file);
    assert.deepEqual(plan.blockers, []);
    assert.ok(plan.actions.some(action => action.id === "orphan-connections:easy-code"));
    assert.ok(engine.calls.every(call => !call.includes("remove")), "Preview must be read-only");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), registry, "Fallback must not rewrite metadata");
    await executeUninstall(plan, { activity: async () => [] });
    assert.deepEqual(engine.connections.map(row => row.Name), ["unrelated"]);
  }));
  it("does not borrow a host registry or accept unreadable or redirected fallback metadata", async () => fixture(async t => {
    for (const reason of ["not-supplied", "missing-file", "invalid-json", "redirected"] as const) {
      const { engine, run } = orphanEngine(t.home), file = path.join(t.root, reason, "connections.json"), plan = await t.plan();
      if (reason === "invalid-json") put(file, "{");
      if (reason === "redirected") {
        const target = path.join(t.root, "other-directory"); put(path.join(target, "connections.json"), JSON.stringify(connectionRegistry(engine.connections)));
        symlinkSync(target, path.dirname(file), process.platform === "win32" ? "junction" : "dir");
      }
      await addPodman(plan, omitMachineFlag(run), "win32", "podman", reason === "not-supplied" ? undefined : file);
      assert.match(plan.blockers.join("\n"), /missing registry\/receipt|cannot safely read connection registry/u, reason);
      assert.ok(engine.calls.every(call => !call.includes("remove")));
    }
  }));
  it("rejects malformed registry markers and mismatched source entries", async () => fixture(async t => {
    for (const reason of ["missing-entry", "string-flag", "other-uri", "other-key", "no-registry"] as const) {
      const { engine, run } = orphanEngine(t.home), file = path.join(t.root, "connections.json"), plan = await t.plan();
      const registry: any = connectionRegistry(engine.connections), entry = registry.Connection.Connections["easy-code"];
      if (reason === "missing-entry") delete registry.Connection.Connections["easy-code"];
      if (reason === "string-flag") entry.IsMachine = "true";
      if (reason === "other-uri") entry.URI = engine.endpoint.uri.replace("61206", "61207");
      if (reason === "other-key") entry.Identity = path.join(t.home, "other-key");
      put(file, JSON.stringify(reason === "no-registry" ? null : registry));
      await addPodman(plan, omitMachineFlag(run), "win32", "podman", file);
      assert.match(plan.blockers.join("\n"), /inventory source mismatch|Invalid registry IsMachine/u, reason);
      assert.ok(engine.calls.every(call => !call.includes("remove")));
    }
  }));
  it("never accepts malformed CLI flags or a non-writable entry with registry data", async () => fixture(async t => {
    for (const reason of ["null-flag", "string-flag", "read-only", "missing-writable"] as const) {
      const { engine, run } = orphanEngine(t.home), file = path.join(t.root, "connections.json"), plan = await t.plan();
      put(file, JSON.stringify(connectionRegistry(engine.connections)));
      const entry: any = engine.connections[0];
      if (reason === "null-flag") entry.IsMachine = null;
      if (reason === "string-flag") entry.IsMachine = "true";
      if (reason === "read-only") { delete entry.IsMachine; entry.ReadWrite = false; }
      if (reason === "missing-writable") { delete entry.IsMachine; delete entry.ReadWrite; }
      await addPodman(plan, run, "win32", "podman", file);
      assert.match(plan.blockers.join("\n"), /IsMachine=|ReadWrite=/u, reason);
      assert.ok(engine.calls.every(call => !call.includes("remove")));
    }
  }));
  it("rechecks fallback registry ownership before each deletion and preserves remaining data if it changes", async () => fixture(async t => {
    for (const afterFirstRemoval of [false, true]) {
      const { engine, run } = orphanEngine(t.home), file = path.join(t.root, "connections.json");
      const config = path.join(t.config, "config.toml"); put(config, "keep");
      const registry = connectionRegistry(engine.connections); put(file, JSON.stringify(registry));
      const changeRegistry = () => { registry.Connection.Connections["easy-code-root"]!.URI = "ssh://root@foreign.invalid/run/podman/podman.sock"; put(file, JSON.stringify(registry)); };
      const runner: SystemRunner = async (program, args, cwd) => {
        const result = await omitMachineFlag(run)(program, args, cwd);
        if (afterFirstRemoval && args.slice(0, 4).join(" ") === "system connection remove easy-code") changeRegistry();
        return result;
      };
      const plan = await t.plan(); await addPodman(plan, runner, "win32", "podman", file);
      assert.deepEqual(plan.blockers, []);
      if (!afterFirstRemoval) changeRegistry();
      await assert.rejects(executeUninstall(plan, { activity: async () => [] }), /inventory source mismatch/u);
      assert.equal(engine.connections.some(row => row.Name === "easy-code"), !afterFirstRemoval);
      assert.ok(engine.connections.some(row => row.Name === "easy-code-root"));
      assert.ok(engine.connections.some(row => row.Name === "unrelated"));
      assert.equal(readFileSync(config, "utf8"), "keep");
    }
  }));
  it("recovers the exact missing-connection failure only after verifying removal and clearing matching aliases", async () => fixture(async t => {
    for (const onlyRoot of [false, true]) {
      const { engine, run } = orphanEngine(t.home);
      if (onlyRoot) engine.connections = engine.connections.filter(row => row.Name !== "easy-code");
      await finishMachineRemoval(run, "podman", "easy-code", "win32", engine.endpoint, missingRoot);
      assert.deepEqual(engine.connections.map(row => row.Name), ["unrelated"]);
      assert.equal(engine.connections[0]!.Default, true);
      assert.ok(engine.calls.every(call => !call.includes("rm") && !call.includes("--all") && !call.includes("start")));
    }
  }));
  it("does not turn permission failures, unknown execution, or mixed cleanup errors into success", async () => fixture(async t => {
    for (const stderr of ["Permission denied", "Command timed out", missingRoot.stderr + "\nPermission denied", missingRoot.stderr.replace("easy-code-root", "foreign-root")]) {
      const { engine, run } = orphanEngine(t.home);
      await assert.rejects(finishMachineRemoval(run, "podman", "easy-code", "win32", engine.endpoint, { ...missingRoot, stderr }), /machine rm failed/u);
      assert.equal(engine.calls.length, 0);
    }
  }));
  it("blocks recovery if the machine or WSL distro survives, or an alias has changed", async () => fixture(async t => {
    for (const state of ["machine", "distro", "alias"] as const) {
      const { engine, run } = orphanEngine(t.home);
      if (state === "machine") engine.present = true;
      if (state === "distro") engine.distroPresent = true;
      if (state === "alias") engine.connections[0]!.URI = "ssh://user@foreign.invalid/run/podman.sock";
      await assert.rejects(finishMachineRemoval(run, "podman", "easy-code", "win32", engine.endpoint, missingRoot), /not confirmed|different endpoint/u);
      assert.ok(engine.calls.every(call => !call.includes("remove")));
    }
  }));
  it("resumes a previous failed uninstall with no VM, preserving unrelated connections and avoiding machine recreation", async () => fixture(async t => {
    const { engine, run } = orphanEngine(t.home), plan = await t.plan();
    await addPodman(plan, run, "win32", "podman");
    assert.deepEqual(plan.blockers, []);
    assert.ok(plan.actions.some(action => action.id === "orphan-connections:easy-code"));
    assert.ok(engine.calls.every(call => !call.includes("remove")), "Preview must be read-only");
    await executeUninstall(plan, { activity: async () => [] });
    assert.deepEqual(engine.connections.map(row => row.Name), ["unrelated"]);
    const resumed = await t.plan(); await addPodman(resumed, run, "win32", "podman");
    assert.deepEqual(resumed.blockers, []);
    assert.ok(!resumed.actions.some(action => action.id.startsWith("orphan-connections:")));
    assert.ok(engine.calls.every(call => !call.some(value => ["init", "start", "stop", "--all", "prune", "reset"].includes(value))));
  }));
  it("never deletes orphan aliases based on names alone", async () => fixture(async t => {
    for (const reason of ["remote", "not-machine", "read-only", "other-key", "other-port", "distro"] as const) {
      const { engine, run } = orphanEngine(t.home), plan = await t.plan();
      if (reason === "remote") engine.connections[0]!.URI = "ssh://user@server.invalid/run/user/1000/podman/podman.sock";
      if (reason === "not-machine") engine.connections[0]!.IsMachine = false;
      if (reason === "read-only") engine.connections[0]!.ReadWrite = false;
      if (reason === "other-key") engine.connections[0]!.Identity = path.join(t.home, "private-user-key");
      if (reason === "other-port") engine.connections[0]!.URI = engine.endpoint.uri.replace("61206", "61207");
      if (reason === "distro") engine.distroPresent = true;
      await addPodman(plan, run, "win32", "podman");
      assert.ok(plan.blockers.length > 0, reason);
      assert.ok(engine.calls.every(call => !call.includes("remove")));
    }
  }));
  it("rechecks disappearance and aliases at execution and keeps later data when cleanup is unconfirmed", async () => fixture(async t => {
    for (const reason of ["new-machine", "changed-alias", "unremoved-alias"] as const) {
      const file = path.join(t.config, "config.toml"); put(file, "");
      const { engine, run } = orphanEngine(t.home), plan = await t.plan();
      await addPodman(plan, run, "win32", "podman");
      if (reason === "new-machine") engine.present = true;
      if (reason === "changed-alias") engine.connections[1]!.URI = "ssh://root@other.invalid/run/podman/podman.sock";
      if (reason === "unremoved-alias") engine.ignoreRemoval = true;
      await assert.rejects(executeUninstall(plan, { activity: async () => [] }), /not confirmed|different endpoint|Unverified orphan/u);
      assert.ok(existsSync(file));
    }
  }));
  it("optionally clears aliases using real Podman against a fixture registry, without touching real machines or connections", async () => fixture(async t => {
    if (process.env.EASY_CODE_TEST_REAL_PODMAN_CONNECTIONS !== "1") return;
    const realFile = podmanConnectionsFile(), before = readFileSync(realFile);
    const { engine } = orphanEngine(t.home), isolated = path.join(t.root, "connections.json");
    const run: SystemRunner = async (program, args) => {
      if (program === "wsl.exe") return ok("Ubuntu");
      if (args[0] === "machine") { assert.deepEqual(args, ["machine", "list", "--format", "json"]); return rows([]); }
      assert.ok(args[0] === "--version" || args.slice(0, 3).join(" ") === "system connection list" ||
        args.slice(0, 3).join(" ") === "system connection remove" && ["easy-code", "easy-code-root"].includes(args[3]!));
      const result = await execa(program, args, { env: { ...podmanEnvironment(), PODMAN_CONNECTIONS_CONF: isolated }, extendEnv: false,
        reject: false, timeout: 10000, windowsHide: true });
      return { exitCode: result.exitCode ?? 125, stdout: result.stdout, stderr: result.stderr };
    };
    for (const omitFlag of [false, true]) {
      if (omitFlag) for (const connection of engine.connections) delete (connection as { IsMachine?: boolean }).IsMachine;
      put(isolated, JSON.stringify(connectionRegistry(engine.connections)));
      const plan = await t.plan(); await addPodman(plan, omitFlag ? omitMachineFlag(run) : run, "win32", podmanExecutable(), isolated);
      assert.deepEqual(plan.blockers, [], "omit IsMachine=" + omitFlag);
      await executeUninstall(plan, { activity: async () => [] });
      const after = JSON.parse(readFileSync(isolated, "utf8"));
      assert.deepEqual(Object.keys(after.Connection.Connections), ["unrelated"]); assert.equal(after.Connection.Default, "unrelated");
      assert.deepEqual(readFileSync(realFile), before);
    }
  }));
});

describe("full uninstall Git and startup", () => {
  it("removes a real managed detached Worktree after full-plan consent for its dirty files", async () => fixture(async t => {
    const repo = path.join(t.root, "repository"); mkdirSync(repo);
    const git = async (args: string[], cwd = repo) => (await execa("git", args, { cwd })).stdout;
    await git(["init"]); await git(["config", "user.email", "test@example.invalid"]); await git(["config", "user.name", "Fixture"]);
    put(path.join(repo, "main.txt"), "keep"); await git(["add", "."]); await git(["commit", "-m", "base"]);
    const id = "env_fixture"; const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    const normalized = (process.platform === "win32" ? repo.toLowerCase() : repo).replace(/\\/gu, "/");
    const root = path.join(t.data, "worktrees", "r-" + hash(normalized).slice(0, 16), "e-" + hash(id).slice(0, 20));
    await git(["worktree", "add", "--detach", root]);
    put(path.join(root, "new.txt"), "unintegrated");
    put(path.join(t.data, "subagent-environments", id + ".json"), JSON.stringify({ schemaVersion: 1, environment: { id, kind: "worktree", worktreeRoot: root, repositoryRoot: repo } }));
    const plan = await t.plan(); await addWorktrees(plan);
    assert.equal(plan.blockers.length, 0, plan.blockers.join("\n"));
    await assert.rejects(executeUninstall(plan, { activity: async () => [] }), /not fully confirmed/u);
    await executeUninstall(plan, { confirmations: [root], activity: async () => [] });
    assert.ok(!existsSync(root)); assert.ok(existsSync(path.join(repo, "main.txt")));
    assert.ok(!(await git(["worktree", "list", "--porcelain"])).includes(root.replace(/\\/gu, "/")));
  }));
  it("uninstall help does not load or recreate an invalid user model registry", async () => fixture(async t => {
    put(path.join(t.home, ".easy_code", "models.toml"), "broken [");
    const result = await execa(process.execPath, [path.join(process.cwd(), "dist-test", "src", "index.js"), "uninstall", "--help"], {
      env: { HOME: t.home, USERPROFILE: t.home }, reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr); assert.match(result.stdout, /--dry-run/u);
    assert.ok(!result.stdout.includes("--confirm-resource"));
    assert.equal(readFileSync(path.join(t.home, ".easy_code", "models.toml"), "utf8"), "broken [");
    assert.deepEqual(await activeOwners(await t.plan()), []);
  }));
});

describe("full uninstall single-confirmation CLI", () => {
  it("one y covers all flagged resources and prints each cleanup group only once", async () => fixture(async t => {
    const file = path.join(t.config, "config.toml"); put(file, "");
    const legacy = path.join(t.root, "tmp", "easy-code-srt-runtime"); put(path.join(legacy, "old-state"));
    const plan = await t.plan(), messages: string[] = [], removed: string[] = [];
    for (const [id, phase] of [["machine:easy-code", 20], ["dirty-worktree", 30], ["corrupt-store:fixture", 5]] as const)
      plan.actions.push({ id, phase, confirmation: id, target: id, description: "fixture resource",
        execute: async () => { removed.push(id); } });
    let questions = 0;
    await runUninstall({}, {
      prepare: async () => plan, owners: async () => [], interactive: true, write: message => { messages.push(message); },
      question: async message => { questions++; assert.ok(message.endsWith("[y/N] ")); return "y"; },
      execute: (p, options) => executeUninstall(p, { ...options, activity: async () => [] }),
    });
    assert.equal(questions, 1);
    assert.deepEqual(removed, ["corrupt-store:fixture", "machine:easy-code", "dirty-worktree"]);
    assert.equal(existsSync(file), false); assert.equal(existsSync(legacy), false);
    assert.equal(messages.filter(message => message === "Removing: Data, configuration, history and caches").length, 1);
    assert.ok(messages.some(message => message.startsWith("Uninstall completed")));
    assert.ok(messages.every(message => !/type exactly|--confirm-resource|Separate confirmation/u.test(message)));
  }));
  it("--yes authorizes the same full plan with no prompts", async () => fixture(async t => {
    const legacy = path.join(t.root, "tmp", "easy-code-srt-runtime"); put(path.join(legacy, "state"));
    const plan = await t.plan();
    await runUninstall({ yes: true }, {
      prepare: async () => plan, owners: async () => [], interactive: false, write: () => {},
      question: async () => { throw new Error("Must not prompt"); },
      execute: (p, options) => executeUninstall(p, { ...options, activity: async () => [] }),
    });
    assert.equal(existsSync(legacy), false);
  }));
  it("cancel, dry-run (even with --yes) and non-interactive invocation never execute", async () => fixture(async t => {
    const file = path.join(t.config, "config.toml"); put(file, "");
    for (const mode of ["cancel", "dry-run", "non-interactive"] as const) {
      const plan = await t.plan(), messages: string[] = []; let questions = 0;
      const run = runUninstall(mode === "dry-run" ? { dryRun: true, yes: true } : {}, {
        prepare: async () => plan, owners: async () => [], interactive: mode !== "non-interactive",
        write: message => { messages.push(message); },
        question: async () => { questions++; return "n"; },
        execute: async () => { throw new Error("Must not execute"); },
      });
      if (mode === "non-interactive") await assert.rejects(run, /requires --yes/u); else await run;
      assert.equal(questions, mode === "cancel" ? 1 : 0);
      if (mode === "dry-run") assert.ok(messages.some(message => message.includes(file)));
      assert.ok(existsSync(file)); assert.ok(!existsSync(maintenanceLock(t.home)));
    }
  }));
  it("global consent does not override preflight blockers or active owners", async () => fixture(async t => {
    const file = path.join(t.config, "config.toml"); put(file, "");
    for (const blocked of [true, false]) {
      const plan = await t.plan(); if (blocked) plan.blockers.push("Foreign sandbox resources");
      await assert.rejects(runUninstall({ yes: true }, {
        prepare: async () => plan, owners: async () => [], interactive: true, write: () => {},
        question: async () => { throw new Error("Must not prompt"); },
        execute: (p, options) => executeUninstall(p, { ...options, activity: async () => ["Unknown active owner"], shutdownTimeoutMs: 0 }),
      }), blocked ? /preflight failed/u : /active\/unknown/u);
      assert.ok(existsSync(file)); assert.ok(!existsSync(maintenanceLock(t.home)));
    }
  }));
});

describe("uninstall temporary review identification", () => {
  it("recognizes real-path review bindings under a Windows short-path temp directory", async () => fixture(async t => {
    const name = "easy-code-review_11111111-1111-1111-1111-111111111111";
    const directory = path.join(t.root, "tmp", name);
    mkdirSync(path.join(directory, "author"), { recursive: true }); mkdirSync(path.join(directory, "reviewer"));
    const canonical = realpathSync.native(directory);
    put(path.join(directory, "binding.json"), JSON.stringify({ id: name.slice("easy-code-".length), snapshotId: "sha256:" + "a".repeat(64),
      roots: { author: path.join(canonical, "author"), reviewer: path.join(canonical, "reviewer") } }));
    const plan = await t.plan();
    assert.deepEqual(plan.blockers, []); assert.ok(plan.actions.some(action => action.target === canonical));
    assert.ok(!plan.warnings.some(message => message.includes(name)));
    assert.ok(existsSync(directory), "Preview is read-only");
    await executeUninstall(plan, { activity: async () => [] });
    assert.ok(!existsSync(directory));
  }));
  it("preserves malformed, foreign, unbound and redirected review directories", async () => fixture(async t => {
    const external = path.join(t.root, "external"); put(path.join(external, "keep"), "user data");
    for (const [index, kind] of ["unbound", "wrong-id", "foreign", "malformed", "redirected"].entries()) {
      const name = `easy-code-review_${String(index).repeat(8)}-1111-1111-1111-111111111111`;
      const directory = path.join(t.root, "tmp", name);
      mkdirSync(path.join(directory, "author"), { recursive: true });
      if (kind === "redirected") symlinkSync(external, path.join(directory, "reviewer"), process.platform === "win32" ? "junction" : "dir");
      else mkdirSync(path.join(directory, "reviewer"));
      if (kind !== "unbound") put(path.join(directory, "binding.json"), JSON.stringify({
        id: kind === "wrong-id" ? "review_other" : name.slice("easy-code-".length), snapshotId: "sha256:" + "a".repeat(64),
        roots: { author: kind === "malformed" ? 42 : path.join(directory, "author"), reviewer: kind === "foreign" ? external : path.join(directory, "reviewer") },
      }));
    }
    const plan = await t.plan();
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.warnings.filter(message => message.includes("unidentified temporary review directory")).length, 5);
    assert.ok(!plan.actions.some(action => action.target.includes("easy-code-review_")));
    await executeUninstall(plan, { activity: async () => [] });
    assert.equal(readFileSync(path.join(external, "keep"), "utf8"), "user data");
  }));
});
