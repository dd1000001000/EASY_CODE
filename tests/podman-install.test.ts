import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execa } from "execa";
import { ensurePodmanInstalled, linuxPodmanPackages, type InstallRunner } from "../src/sandbox/podman-install.js";
import { podmanArguments, podmanConnectionsFile, podmanEnvironment, podmanExecutable } from "../src/sandbox/podman-client.js";
import { PodmanStartupService, PODMAN_IPC_PROBE } from "../src/sandbox/podman-startup.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import { describe, it } from "./harness.js";
import { withPodmanSetupLock } from "../src/sandbox/podman-setup-lock.js";
import { addPodman } from "../src/uninstall/podman.js";
import type { UninstallPlan } from "../src/uninstall/plan.js";

const limits = DEFAULT_RUNTIME_LIMITS;
const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string) => ({ exitCode: 125, stdout: "", stderr });
function fakeInstall(options: { installed?: boolean; machine?: boolean; running?: boolean; rootful?: boolean; collision?: boolean; denyInstall?: boolean; legacy?: boolean; missingConnection?: boolean; wrongConnection?: boolean } = {}) {
  let installed = options.installed ?? true;
  let machine = options.machine ?? false;
  let running = options.running ?? false;
  let registered = !options.missingConnection;
  let rootRegistered = !options.missingConnection;
  const connection = { Name: "easy-code", URI: `ssh://user@${options.wrongConnection ? "foreign-host" : "127.0.0.1"}:61206/run/user/1000/podman/podman.sock`, Identity: "/test/key" };
  const rootConnection = { ...connection, Name: "easy-code-root", URI: "ssh://root@127.0.0.1:61206/run/podman/podman.sock" };
  const calls: Array<[string, string[]]> = [];
  const run: InstallRunner = async (program, args) => {
    calls.push([program, args]);
    if (program === "winget" || program.endsWith("brew")) {
      if (options.denyInstall) return fail("System authorization denied");
      installed = true; return ok();
    }
    if (program === "wsl.exe") return ok();
    if (args[0] === "--version") return installed ? ok("podman version 5") : fail("not installed");
    if (args.join(" ").startsWith("system connection list")) return ok(JSON.stringify(options.collision ? [{ Name: "easy-code" }] : [{ Name: "unrelated", Default: true },
      ...(machine && registered ? [connection] : []), ...(machine && rootRegistered ? [rootConnection] : [])]));
    if (args.join(" ").startsWith("system connection add")) { if (args.at(-2) === "easy-code-root") rootRegistered = true; else registered = true; return ok(); }
    if (args[0] === "--connection") return ok(JSON.stringify({ host: { security: { rootless: true } } }));
    if (args[1] === "list") return ok(JSON.stringify(machine ? [{ Name: "easy-code" }] : [{ Name: "unrelated", Running: true }]));
    if (args[1] === "init") { machine = true; return ok(); }
    if (args[1] === "start" && args.includes("--help")) return ok(options.legacy ? "--no-info" : "--update-connection");
    if (args[1] === "start") { running = true; return ok(); }
    if (args[1] === "ssh") return ok("1000\n");
    if (args[1] === "inspect") return ok(JSON.stringify([{ Name: "easy-code", Rootful: options.rootful ?? false,
      SSHConfig: { RemoteUsername: "user", Port: 61206, IdentityPath: "/test/key" },
      ConfigDir: { Path: "C:\\Users\\test\\podman\\machine\\wsl" }, State: running ? "running" : "stopped" }]));
    return fail(`unexpected: ${program} ${args.join(" ")}`);
  };
  return { run, calls, exists: (name: string) => name === "/test/key" };
}

describe("Podman automatic installation", () => {
  it("optionally repairs an isolated real registry without changing the installed VM or real connections", async () => {
    if (process.env.EASY_CODE_TEST_REAL_PODMAN !== "1") return;
    if (!["win32", "darwin"].includes(process.platform)) throw new Error("This real-machine test requires an existing desktop Podman machine");
    const realFile = podmanConnectionsFile();
    const before = await readFile(realFile);
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-connections-test-"));
    const env = { ...podmanEnvironment(), PODMAN_CONNECTIONS_CONF: path.join(directory, "connections.json") };
    const run: InstallRunner = async (program, args, timeout) => {
      if (program !== podmanExecutable() || args.some(arg => ["init", "start", "stop", "rm", "reset", "prune"].includes(arg)))
        throw new Error("Real registry test forbids system installation and VM changes");
      const result = await execa(program, args, { cwd: directory, env, extendEnv: false, shell: false, windowsHide: true,
        reject: false, timeout });
      return { exitCode: result.exitCode ?? 125, stdout: result.stdout, stderr: result.stderr };
    };
    try {
      const missing = await run(podmanExecutable(), podmanArguments(["info", "--format", "json"], limits), 10000);
      assert.equal(missing.exitCode, 125); assert.match(missing.stderr, /connection.*not found/u);
      // Skip only the WSL status probe; OS setup is forbidden by the adapter above.
      const setupRunner: InstallRunner = (program, args, timeout) => program === "wsl.exe" ? Promise.resolve(ok()) : run(program, args, timeout);
      await ensurePodmanInstalled(limits, { run: setupRunner, connectionsFile: env.PODMAN_CONNECTIONS_CONF });
      const after = await run(podmanExecutable(), podmanArguments(["info", "--format", "json"], limits), 10000);
      assert.equal(after.exitCode, 0, after.stderr);
      assert.equal(JSON.parse(after.stdout).host.security.rootless, true);
      // Reproduce the user's *actual* topology on real Podman: running VM,
      // only rootless alias, no IsMachine, and an outdated forwarding port.
      const current = JSON.parse((await run(podmanExecutable(), ["system", "connection", "list", "--format", "json"], 10000)).stdout)
        .find((row: any) => row.Name === "easy-code");
      const old = new URL(current.URI); old.port = old.port === "61206" ? "61207" : "61206";
      const legacy = { Connection: { Default: "easy-code", Connections: { "easy-code": { URI: old.href, Identity: current.Identity } } }, Farm: {} };
      await writeFile(env.PODMAN_CONNECTIONS_CONF, JSON.stringify(legacy));
      const plan: UninstallPlan = { actions: [], warnings: [], blockers: [], resources: [], home: os.homedir(), roots: { data: [], config: [], cache: [] } };
      await addPodman(plan, (program, args) => setupRunner(program, args, 20000), process.platform, podmanExecutable(), env.PODMAN_CONNECTIONS_CONF);
      assert.deepEqual(plan.blockers, []);
      assert.ok(plan.actions.some(action => action.id === "machine:easy-code"));
      assert.deepEqual(JSON.parse(await readFile(env.PODMAN_CONNECTIONS_CONF, "utf8")), legacy, "Uninstall preview must not repair aliases");
      await ensurePodmanInstalled(limits, { run: setupRunner, connectionsFile: env.PODMAN_CONNECTIONS_CONF });
      const fixed = JSON.parse(await readFile(env.PODMAN_CONNECTIONS_CONF, "utf8"));
      assert.equal(fixed.Connection.Connections["easy-code"].URI, current.URI);
      assert.ok(fixed.Connection.Connections["easy-code-root"]);
      assert.equal(fixed.Connection.Default, "easy-code");
      assert.equal((await run(podmanExecutable(), podmanArguments(["info", "--format", "json"], limits), 10000)).exitCode, 0);
      assert.deepEqual(await readFile(realFile), before);
    } finally {
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.ok(path.basename(directory).startsWith("easy-code-connections-test-"));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("pins one absolute connections file in setup and runtime, with Windows fallback and explicit override", () => {
    const source = { USERPROFILE: "C:\\Users\\Test", APPDATA: "C:\\Users\\Test\\AppData\\Roaming", ProgramData: "C:\\ProgramData" };
    assert.equal(podmanConnectionsFile(source, "win32"), "C:\\Users\\Test\\AppData\\Roaming\\containers\\podman-connections.json");
    assert.equal(podmanEnvironment([], { USERPROFILE: source.USERPROFILE }, "win32").PODMAN_CONNECTIONS_CONF,
      podmanConnectionsFile(source, "win32"));
    assert.equal(podmanEnvironment([], { ...source, PODMAN_CONNECTIONS_CONF: "D:\\custom\\connections.json", API_KEY: "secret" }, "win32").PODMAN_CONNECTIONS_CONF, "D:\\custom\\connections.json");
    assert.equal(podmanEnvironment([], { ...source, API_KEY: "secret" }, "win32").API_KEY, undefined);
    assert.equal(podmanConnectionsFile({ HOME: "/home/test", XDG_CONFIG_HOME: "/home/test/config" }, "linux"), "/home/test/config/containers/podman-connections.json");
    assert.equal(podmanConnectionsFile({ HOME: "/Users/test" }, "darwin"), "/Users/test/.config/containers/podman-connections.json");
    assert.throws(() => podmanConnectionsFile({ PODMAN_CONNECTIONS_CONF: "relative.json" }), /absolute/u);
  });
  it("restores a missing connection for an existing running machine without recreating it", async () => {
    const fake = fakeInstall({ machine: true, running: true, missingConnection: true });
    await ensurePodmanInstalled(limits, { platform: "win32", ...fake });
    const additions = fake.calls.filter(([, args]) => args.slice(0, 3).join(" ") === "system connection add");
    assert.equal(additions.length, 2);
    assert.equal(additions[0]![1].at(-1), "ssh://user@127.0.0.1:61206/run/user/1000/podman/podman.sock");
    assert.ok(fake.calls.every(([, args]) => !args.some(arg => ["init", "start", "rm", "default", "--default"].includes(arg))));
    await ensurePodmanInstalled(limits, { platform: "win32", ...fake });
    assert.equal(fake.calls.filter(([, args]) => args.slice(0, 3).join(" ") === "system connection add").length, 2);
  });
  it("never overwrites a colliding endpoint or regenerates missing SSH keys", async () => {
    const wrong = fakeInstall({ machine: true, running: true, wrongConnection: true });
    await assert.rejects(ensurePodmanInstalled(limits, { platform: "win32", ...wrong }), /does not match/u);
    assert.ok(wrong.calls.every(([, args]) => !args.includes("add")));
    const missingKey = fakeInstall({ machine: true, running: true });
    await assert.rejects(ensurePodmanInstalled(limits, { platform: "win32", ...missingKey, exists: () => false }), /SSH identity/u);
  });
  it("repeats only engine readiness reads after startup, never the installation", async () => {
    const fake = fakeInstall({ machine: true, running: true }); let probes = 0;
    await ensurePodmanInstalled(limits, { platform: "win32", ...fake, wait: async () => {},
      run: async (program, args, timeout) => args[0] === "--connection" && ++probes === 1
        ? fail("connection refused") : fake.run(program, args, timeout) });
    assert.equal(probes, 2);
  });
  it("serializes simultaneous setup callers and releases the lock after a failed setup", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "easy-code-setup-lock-"));
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    try {
      const first = withPodmanSetupLock(async () => { order.push("first"); started(); await blocked; }, 2000, home);
      await entered;
      const second = withPodmanSetupLock(async () => { order.push("second"); }, 2000, home);
      release(); await Promise.all([first, second]);
      assert.deepEqual(order, ["first", "second"]);
      await assert.rejects(withPodmanSetupLock(async () => { throw new Error("test failure"); }, 2000, home), /test failure/);
      await withPodmanSetupLock(async () => {}, 2000, home);
      assert.equal(existsSync(path.join(home, ".easy_code", "podman-setup.lock")), false);
    } finally { release(); await rm(home, { recursive: true, force: true }); }
  });
  it("preserves Windows OpenSSH's ProgramData but never inherits arbitrary host secrets", () => {
    const previous = process.env.ProgramData;
    const secret = process.env.EASY_CODE_TEST_SECRET;
    try {
      process.env.ProgramData = "C:\\ProgramData";
      process.env.EASY_CODE_TEST_SECRET = "must-not-be-inherited";
      const environment = podmanEnvironment();
      assert.equal(environment.ProgramData, "C:\\ProgramData");
      assert.equal(environment.EASY_CODE_TEST_SECRET, undefined);
    } finally {
      if (previous === undefined) delete process.env.ProgramData; else process.env.ProgramData = previous;
      if (secret === undefined) delete process.env.EASY_CODE_TEST_SECRET; else process.env.EASY_CODE_TEST_SECRET = secret;
    }
  });
  it("can generate a temporary Windows machine key using the filtered control environment", async () => {
    if (process.platform !== "win32") return;
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh-keygen.exe");
    if (!existsSync(executable)) return;
    const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-keygen-test-"));
    try {
      const key = path.join(directory, "probe");
      const result = await execa(executable, ["-q", "-t", "ed25519", "-N", "", "-f", key], {
        env: podmanEnvironment(), extendEnv: false, cwd: directory, shell: false, windowsHide: true,
        reject: false, timeout: 10000,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.ok(existsSync(key) && existsSync(`${key}.pub`));
    } finally {
      // Only this test's newly allocated directory, never real Podman/user keys.
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.ok(path.basename(directory).startsWith("easy-code-keygen-test-"));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("installs Windows Podman, creates only the dedicated WSL machine and never changes the default connection", async () => {
    const fake = fakeInstall({ installed: false });
    await ensurePodmanInstalled(limits, { platform: "win32", ...fake, executable: () => "podman" });
    assert.equal(fake.calls.filter(([name]) => name === "winget").length, 1);
    const init = fake.calls.find(([, args]) => args[1] === "init")![1];
    assert.ok(init.includes("--rootful=false")); assert.ok(!init.includes("--provider"));
    assert.equal(init.at(-1), "easy-code");
    assert.ok(fake.calls.some(([, args]) => args[1] === "start" && args.includes("--update-connection=false")));
    assert.ok(fake.calls.every(([, args]) => !args.includes("rm") && !args.includes("stop") && !args.includes("default")));
  });
  it("reuses a running dedicated machine without reinstalling, resizing or restarting anything", async () => {
    const fake = fakeInstall({ machine: true, running: true });
    await ensurePodmanInstalled(limits, { platform: "win32", ...fake });
    assert.ok(fake.calls.every(([name, args]) => name !== "winget" && !["init", "start", "set", "rm"].includes(args[1]!)));
  });
  it("supports Podman 5 machine flags without speculative mutation retries", async () => {
    const fake = fakeInstall({ legacy: true });
    await ensurePodmanInstalled(limits, { platform: "win32", ...fake });
    const start = fake.calls.filter(([, args]) => args[1] === "start" && !args.includes("--help"));
    assert.equal(start.length, 1);
    assert.deepEqual(start[0]![1], ["machine", "start", "easy-code"]);
  });
  it("does not turn a rootful machine into a different configuration or overwrite a colliding connection", async () => {
    for (const options of [{ machine: true, rootful: true }, { collision: true }]) {
      const fake = fakeInstall(options);
      await assert.rejects(ensurePodmanInstalled(limits, { platform: "win32", ...fake }), /rootless|Unverified orphan/u);
      assert.ok(fake.calls.every(([, args]) => !["init", "start", "set", "rm"].includes(args[1]!)));
    }
  });
  it("stops after denied installation, without creating a machine or retrying privileged commands", async () => {
    const fake = fakeInstall({ installed: false, denyInstall: true });
    await assert.rejects(ensurePodmanInstalled(limits, { platform: "win32", ...fake }), /authorization denied/u);
    assert.equal(fake.calls.filter(([name]) => name === "winget").length, 1);
    assert.ok(fake.calls.every(([, args]) => args[0] !== "machine"));
  });
  it("uses Homebrew on macOS when present, otherwise invokes the signed-package installer", async () => {
    const brew = fakeInstall({ installed: false });
    await ensurePodmanInstalled(limits, { platform: "darwin", ...brew, exists: name => name === "/opt/homebrew/bin/brew" || name === "/test/key" });
    assert.ok(brew.calls.some(([name]) => name === "/opt/homebrew/bin/brew"));
    const pkg = fakeInstall(); let downloads = 0; let first = true;
    await ensurePodmanInstalled(limits, { platform: "darwin", exists: name => name === "/test/key",
      run: async (program, args, ms) => { if (args[0] === "--version" && first) { first = false; return fail("missing"); } return pkg.run(program, args, ms); },
      installMac: async () => { downloads++; } });
    assert.equal(downloads, 1);
  });
  it("uses only fixed Linux package argv, preserves privilege boundaries and rejects unknown distros", async () => {
    assert.deepEqual(linuxPodmanPackages('ID=ubuntu\nID_LIKE="debian"')[1],
      ["/usr/bin/apt-get", ["install", "-y", "podman", "uidmap", "slirp4netns", "fuse-overlayfs"]]);
    assert.throws(() => linuxPodmanPackages('ID="$(curl attacker)"'), /No automatic/u);
    const calls: Array<[string, string[]]> = []; let installed = false;
    await ensurePodmanInstalled(limits, { platform: "linux", uid: 1000, osRelease: "ID=ubuntu", executable: () => "podman",
      run: async (program, args) => { calls.push([program, args]); if (program === "/usr/bin/sudo") { installed = true; return ok(); } return installed ? ok() : fail("missing"); } });
    assert.equal(calls.filter(([name]) => name === "/usr/bin/sudo").length, 2);
    assert.ok(calls.filter(([name]) => name === "/usr/bin/sudo").every(([, args]) => args[0] === "-n" && args[1] === "--"));
    await assert.rejects(ensurePodmanInstalled(limits, { platform: "linux", uid: 0, run: async () => ok() }), /not root/u);
  });
  it("pins all desktop engine calls to the configured connection, never the global default", () => {
    assert.deepEqual(podmanArguments(["exec", "task", "python3"], limits, "win32"), ["--connection", "easy-code", "exec", "task", "python3"]);
    assert.deepEqual(podmanArguments(["info"], limits, "darwin"), ["--connection", "easy-code", "info"]);
    assert.deepEqual(podmanArguments(["info"], limits, "linux"), ["info"]);
  });
  it("builds a missing image once, then runs a real readiness contract; probe failure is not readiness", async () => {
    let image = false; let badProbe = false; let bootstraps = 0; let builds = 0;
    const service = new PodmanStartupService(limits, async args => {
      if (args[0] === "info") return ok(JSON.stringify({ host: { security: { rootless: true } } }));
      if (args[0] === "image") return { ...ok(), exitCode: image ? 0 : 1 };
      if (args[0] === "build") { builds++; image = true; return ok(); }
      if (args[0] === "run") { assert.equal(args.at(-1), PODMAN_IPC_PROBE); return badProbe ? fail("IPC failed") : ok("PODMAN_IPC_OK"); }
      if (args[0] === "container") return { ...ok(), exitCode: 1 };
      return fail("unexpected");
    }, async () => { bootstraps++; });
    assert.equal((await service.setup()).status, "completed");
    assert.equal((await service.setup()).status, "already_ready");
    assert.equal(builds, 1); assert.equal(bootstraps, 1);
    badProbe = true;
    assert.equal((await service.setup()).status, "failed");
    assert.equal(builds, 1);
  });
  it("npm install reports ready only after the complete setup result and exposes failure", async () => {
    const postinstall = createRequire(import.meta.url)(path.join(process.cwd(), "scripts", "postinstall.cjs"));
    const logs: string[] = [];
    const output = { write: (message: string) => { logs.push(message); } };
    for (const ready of [true, false]) {
      const result = await postinstall.checkSandboxPrerequisites({ stdout: output, stderr: output, service: {
        setup: async () => ({ message: "test", readiness: { status: ready ? "ready" : "probe_failed", details: ["probe failed"] } }),
      } });
      assert.equal(result.ready, ready);
    }
    assert.ok(logs.some(line => line.includes("sandbox NOT ready")));
  });
  it("reports a missing connection as setup required and keeps the latest failure stage", async () => {
    const service = new PodmanStartupService(limits, async () => fail('connection "easy-code" not found'),
      async () => { throw new Error("SSH identity unavailable"); });
    const before = await service.inspect();
    assert.equal(before.status, "setup_required");
    const result = await service.setup(before);
    assert.match(result.message, /engine\/machine\/connection preparation/u);
    assert.match(result.readiness.details.join(" "), /SSH identity unavailable/u);
    assert.ok(!result.readiness.details.join(" ").includes('connection "easy-code" not found'));
  });
});
