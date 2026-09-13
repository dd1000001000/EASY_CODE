import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { execa } from "execa";
import { ensurePodmanInstalled, linuxPodmanPackages, type InstallRunner } from "../src/sandbox/podman-install.js";
import { podmanArguments, podmanEnvironment } from "../src/sandbox/podman-client.js";
import { PodmanStartupService, PODMAN_IPC_PROBE } from "../src/sandbox/podman-startup.js";
import { DEFAULT_RUNTIME_LIMITS } from "../src/config/runtime-limits.js";
import { describe, it } from "./harness.js";

const limits = DEFAULT_RUNTIME_LIMITS;
const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string) => ({ exitCode: 125, stdout: "", stderr });
function fakeInstall(options: { installed?: boolean; machine?: boolean; running?: boolean; rootful?: boolean; collision?: boolean; denyInstall?: boolean; legacy?: boolean } = {}) {
  let installed = options.installed ?? true;
  let machine = options.machine ?? false;
  let running = options.running ?? false;
  const calls: Array<[string, string[]]> = [];
  const run: InstallRunner = async (program, args) => {
    calls.push([program, args]);
    if (program === "winget" || program.endsWith("brew")) {
      if (options.denyInstall) return fail("System authorization denied");
      installed = true; return ok();
    }
    if (program === "wsl.exe") return ok();
    if (args[0] === "--version") return installed ? ok("podman version 5") : fail("not installed");
    if (args.join(" ").startsWith("system connection list")) return ok(JSON.stringify(options.collision ? [{ Name: "easy-code" }] : [{ Name: "unrelated", Default: true }]));
    if (args[1] === "list") return ok(JSON.stringify(machine ? [{ Name: "easy-code" }] : [{ Name: "unrelated", Running: true }]));
    if (args[1] === "init") { machine = true; return ok(); }
    if (args[1] === "start" && args.includes("--help")) return ok(options.legacy ? "--no-info" : "--update-connection");
    if (args[1] === "start") { running = true; return ok(); }
    if (args[1] === "inspect") return ok(JSON.stringify([{ Name: "easy-code", Rootful: options.rootful ?? false,
      ConfigDir: { Path: "C:\\Users\\test\\podman\\machine\\wsl" }, State: running ? "running" : "stopped" }]));
    return fail(`unexpected: ${program} ${args.join(" ")}`);
  };
  return { run, calls };
}

describe("Podman automatic installation", () => {
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
      await assert.rejects(ensurePodmanInstalled(limits, { platform: "win32", ...fake }), /rootless|already in use/u);
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
    await ensurePodmanInstalled(limits, { platform: "darwin", ...brew, exists: name => name === "/opt/homebrew/bin/brew" });
    assert.ok(brew.calls.some(([name]) => name === "/opt/homebrew/bin/brew"));
    const pkg = fakeInstall(); let downloads = 0; let first = true;
    await ensurePodmanInstalled(limits, { platform: "darwin", exists: () => false,
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
});
