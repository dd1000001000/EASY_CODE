/** Host-owned installation recipes. Never receives model commands or secrets. */
import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { recordOwnedResource, readOwnedResources, type OwnedResource } from "../install/ownership.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import { podmanArguments, podmanConnectionsFile, podmanEnvironment, podmanExecutable, type PodmanResult } from "./podman-client.js";
import { machineEndpoint, machineIdentity, rootMachineEndpoint } from "./podman-connection.js";
import { machineConnectionReceipts, reconcileAbsentMachine, reconcileLiveMachineConnections } from "./podman-machine-state.js";

export type InstallRunner = (program: string, args: string[], timeoutMs: number) => Promise<PodmanResult>;
export interface PodmanInstallOptions {
  platform?: NodeJS.Platform;
  run?: InstallRunner;
  exists?: (name: string) => boolean;
  executable?: () => string;
  uid?: number;
  osRelease?: string;
  installMac?: () => Promise<void>;
  report?: (message: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
  home?: string;
  connectionsFile?: string;
  resources?: readonly OwnedResource[];
  record?: (resource: OwnedResource) => void;
}

const installRunner = (env: NodeJS.ProcessEnv): InstallRunner => async (program, args, timeoutMs) => {
  const result = await execa(program, args, { cwd: os.tmpdir(), env, extendEnv: false,
    shell: false, windowsHide: true, reject: false, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return { exitCode: result.exitCode ?? 125, stdout: result.stdout, stderr: result.stderr };
};

/** Fixed distro recipes; never eval/source /etc/os-release or install a shell pipeline. */
export function linuxPodmanPackages(osRelease: string): [string, string[]][] {
  const ids = [...osRelease.matchAll(/^(?:ID|ID_LIKE)=["']?([^\r\n"']+)/gmu)].flatMap(match => match[1]!.split(/\s+/u));
  if (ids.some(id => ["debian", "ubuntu"].includes(id))) return [
    ["/usr/bin/apt-get", ["update"]],
    ["/usr/bin/apt-get", ["install", "-y", "podman", "uidmap", "slirp4netns", "fuse-overlayfs"]],
  ];
  if (ids.some(id => ["fedora", "rhel", "centos"].includes(id)))
    return [["/usr/bin/dnf", ["install", "-y", "podman", "shadow-utils", "fuse-overlayfs"]]];
  if (ids.some(id => ["arch", "manjaro"].includes(id)))
    return [["/usr/bin/pacman", ["-S", "--needed", "--noconfirm", "podman", "fuse-overlayfs"]]];
  if (ids.some(id => ["opensuse", "opensuse-tumbleweed", "opensuse-leap", "suse"].includes(id)))
    return [["/usr/bin/zypper", ["--non-interactive", "install", "podman", "fuse-overlayfs"]]];
  throw new Error("No automatic Podman package recipe for this Linux distribution. Install rootless Podman, then rerun easy-code sandbox setup.");
}

async function installMacPackage(run: InstallRunner, timeout: number): Promise<void> {
  // Official signed package fallback for machines without Homebrew. Do not install Homebrew itself.
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined;
  if (!arch) throw new Error("No official Podman macOS package for this CPU architecture");
  const signal = AbortSignal.timeout(timeout);
  const release = await fetch("https://api.github.com/repos/containers/podman/releases/latest", { signal });
  if (!release.ok) throw new Error(`Podman release lookup failed: HTTP ${release.status}`);
  const metadata = await release.json() as { assets?: Array<{ name: string; browser_download_url: string; digest?: string; size?: number }> };
  const asset = metadata.assets?.find(item => item.name === `podman-installer-macos-${arch}.pkg`);
  if (!asset || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest ?? "") || !asset.size || asset.size > 512 * 1024 * 1024)
    throw new Error("Official Podman release has no supported, checksummed macOS installer for this architecture");
  const url = new URL(asset.browser_download_url);
  if (url.origin !== "https://github.com" || !["/containers/podman/releases/download/", "/podman-container-tools/podman/releases/download/"].some(prefix => url.pathname.startsWith(prefix)))
    throw new Error("Unexpected Podman installer origin");
  const directory = await mkdtemp(path.join(os.tmpdir(), "easy-code-podman-installer-"));
  const file = path.join(directory, "podman.pkg");
  try {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(`Podman download failed: HTTP ${response.status}`);
    const chunks: Uint8Array[] = []; let bytes = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > asset.size) throw new Error("Podman installer exceeds its declared size");
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    if (bytes !== asset.size || `sha256:${createHash("sha256").update(content).digest("hex")}` !== asset.digest)
      throw new Error("Podman installer checksum mismatch");
    await writeFile(file, content, { mode: 0o600, flag: "wx" });
    const signature = await run("/usr/sbin/pkgutil", ["--check-signature", file], timeout);
    if (signature.exitCode !== 0 || !/Developer ID Installer: Red Hat/iu.test(signature.stdout))
      throw new Error("Podman package does not have the expected trusted Red Hat installer signature");
    // OS-owned installer requests the user's administrator approval. Never collect a password.
    const command = `/usr/sbin/installer -pkg '${file.replace(/'/gu, "'\\''")}' -target /`;
    const installed = await run("/usr/bin/osascript", ["-e", `do shell script ${JSON.stringify(command)} with administrator privileges`], timeout);
    if (installed.exitCode !== 0) throw new Error(`Podman system installation was not completed: ${installed.stderr.slice(0, 1600)}`);
  } finally {
    // Only the exact private mkdtemp directory created above, never an engine or user's directory.
    await rm(directory, { recursive: true, force: true });
  }
}

export async function ensurePodmanInstalled(limits: Readonly<RuntimeLimits>, options: PodmanInstallOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (!["win32", "darwin", "linux"].includes(platform)) throw new Error(`Automatic Podman setup is unsupported on ${platform}`);
  // Capture one control environment per transaction. Inventory, mutations and
  // verification must not drift between registries when npm/worker env changes.
  const environment = podmanEnvironment();
  const run = options.run ?? installRunner(environment);
  const exists = options.exists ?? existsSync;
  const executable = options.executable ?? podmanExecutable;
  const report = options.report ?? (() => undefined);
  const timeout = limits.podmanSetupTimeoutMs;
  const home = options.home ?? os.homedir();
  const file = options.connectionsFile ?? (!options.run ? environment.PODMAN_CONNECTIONS_CONF : undefined);
  if (!options.run && options.connectionsFile && options.connectionsFile !== podmanConnectionsFile())
    throw new Error("A custom connection registry requires its matching command runner");
  const resources = options.resources ?? (!options.run ? readOwnedResources(home) : []);
  const record = (resource: OwnedResource) => {
    if (options.record) options.record(resource);
    else if (!options.run) recordOwnedResource(resource, home);
  };
  const checked = async (program: string, args: string[]) => {
    const result = await run(program, args, timeout);
    if (result.exitCode !== 0) throw new Error(`${path.basename(program)} ${args.slice(0, 2).join(" ")} setup failed (${result.exitCode}): ${(result.stderr || result.stdout).slice(-1600)}`);
    return result.stdout;
  };
  const version = await run(executable(), ["--version"], limits.podmanControlTimeoutMs).catch(() => undefined);
  report(`Checking Podman executable: ${executable()}`);
  if (!version || version.exitCode !== 0) {
    report("Installing Podman; system authorization may be requested.");
    if (platform === "win32") {
      await checked("winget", ["install", "--id", "RedHat.Podman", "--exact", "--source", "winget", "--silent",
        "--accept-package-agreements", "--accept-source-agreements", "--no-upgrade"]);
    } else if (platform === "darwin") {
      const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(exists);
      if (brew) await checked(brew, ["install", "podman"]);
      else await (options.installMac ?? (() => installMacPackage(run, timeout)))();
    } else {
      const recipes = linuxPodmanPackages(options.osRelease ?? await readFile("/etc/os-release", "utf8"));
      for (const [program, args] of recipes) {
        if ((options.uid ?? process.getuid?.()) === 0) await checked(program, args);
        else await checked("/usr/bin/sudo", ["-n", "--", program, ...args]);
      }
    }
    await checked(executable(), ["--version"]);
    record({ kind: "podman-install", method: platform === "win32" ? "winget" : platform === "darwin"
      ? (["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(exists) ? "brew" : "signed-pkg") : "linux-packages",
      ...(platform === "darwin" ? { path: ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(exists) } : {}) });
  }
  if (platform === "linux") {
    if ((options.uid ?? process.getuid?.()) === 0)
      throw new Error("Podman is installed, but rootless sandbox preparation must run as the ordinary EASY CODE user, not root. Rerun easy-code sandbox setup without sudo.");
    return;
  }
  if (platform === "win32") {
    const wsl = await run("wsl.exe", ["--status"], limits.podmanControlTimeoutMs);
    if (wsl.exitCode !== 0) {
      report("Preparing WSL. Windows may request administrator authorization; automatic reboot is disabled.");
      // Fixed OS recipe only. Never interpolate configuration or model text into this script.
      await checked("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$setupProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\wsl.exe') -ArgumentList '--install','--no-distribution','--no-launch' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $setupProcess.ExitCode"]);
      const after = await run("wsl.exe", ["--status"], limits.podmanControlTimeoutMs);
      if (after.exitCode !== 0) throw new Error("WSL is not ready. Complete the requested Windows restart, then rerun easy-code sandbox setup. No machine was created.");
    }
  }
  // Machine commands are local CLI management operations, not --connection calls.
  const machines = JSON.parse(await checked(executable(), ["machine", "list", "--format", "json"]));
  if (!Array.isArray(machines)) throw new Error("Invalid Podman machine list; refusing to change it");
  const name = limits.podmanMachineName;
  let created = false;
  if (!machines.some(machine => machine.Name === name)) {
    await reconcileAbsentMachine((program, args) => run(program, args, limits.podmanControlTimeoutMs), executable(), name, platform,
      { home, connectionsFile: file, receipts: machineConnectionReceipts(resources, name, file, platform) }, report);
    report(`Creating rootless Podman machine ${name}. Other machines are left unchanged.`);
    await checked(executable(), ["machine", "init", "--rootful=false",
      "--cpus", String(limits.podmanMachineCpus), "--memory", String(limits.podmanMachineMemoryMb),
      "--disk-size", String(limits.podmanMachineDiskGb), name]);
    created = true;
  }
  const inspect = async () => {
    const data = JSON.parse(await checked(executable(), ["machine", "inspect", name]));
    if (!Array.isArray(data) || data.length !== 1 || data[0]?.Name !== name || data[0]?.Rootful !== false)
      throw new Error(`Machine ${name} is not the expected rootless machine; it has not been changed`);
    if (platform === "win32" && !/[\\/]wsl(?:[\\/]|$)/iu.test(data[0].ConfigDir?.Path ?? ""))
      throw new Error(`Machine ${name} does not use WSL; Windows workspace mapping requires WSL`);
    return data[0];
  };
  const machine = await inspect();
  if (created) record({ kind: "machine", name, identity: machineIdentity(machine) });
  if (machine.State === "stopped") {
    report(`Starting Podman machine ${name}.`);
    // Podman 5 has neither this flag nor the prompt; Podman 6 must explicitly
    // suppress switching defaults. Inspect capability before mutating anything.
    const help = await checked(executable(), ["machine", "start", "--help"]);
    await checked(executable(), ["machine", "start", ...(help.includes("--update-connection") ? ["--update-connection=false"] : []), name]);
  } else if (machine.State !== "running") throw new Error(`Machine ${name} is ${machine.State}; wait for its existing operation to finish`);
  const runningMachine = await inspect();
  if (runningMachine.State !== "running") throw new Error(`Machine ${name} did not reach running state`);

  // A surviving VM is not sufficient: a lost connections file used to make
  // every subsequent setup fail without ever repairing anything.
  report(`Verifying rootless connection ${name}.`);
  const endpoint = await machineEndpoint(runningMachine, platform,
    () => checked(executable(), ["machine", "ssh", name, "id", "-u"]), exists);
  await reconcileLiveMachineConnections((program, args) => run(program, args, limits.podmanControlTimeoutMs),
    executable(), runningMachine, platform, endpoint, { connectionsFile: file, createMissing: true, report });
  const expected = new Map([[name, endpoint], [name + "-root", rootMachineEndpoint(endpoint)]]);
  for (const [alias, target] of expected) {
    // Our ownership is endpoint + registry provenance, independent of Podman's
    // optional IsMachine field (ordinary `connection add` does not set it).
    if (file) record({ kind: "machine-connection", name: alias, connection: name, path: file, identity: JSON.stringify(target) });
  }
  // Only readiness reads may be repeated. Never replay init/start/install or a
  // user command when its execution result is unknown.
  const deadline = Date.now() + limits.podmanControlTimeoutMs;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  while (true) {
    const result = await run(executable(), podmanArguments(["info", "--format", "json"], limits, platform), limits.podmanControlTimeoutMs);
    if (result.exitCode === 0) {
      const info = JSON.parse(result.stdout);
      if (info.host?.security?.rootless !== true && info.Host?.Security?.Rootless !== true)
        throw new Error("The selected Podman endpoint is not rootless");
      break;
    }
    const detail = (result.stderr || result.stdout).slice(-1600);
    if (!/connection refused|actively refused|connection reset|no such file|service.*unavailable/iu.test(detail) || Date.now() >= deadline)
      throw new Error(`Podman connection ${name} is registered but engine verification failed: ${detail}`);
    report(`Waiting for the rootless engine of ${name} to become ready.`);
    await wait(Math.min(500, Math.max(0, deadline - Date.now())));
  }
}
