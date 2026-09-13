/** Host-owned installation recipes. Never receives model commands or secrets. */
import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import { podmanEnvironment, podmanExecutable, type PodmanResult } from "./podman-client.js";

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
}

const runInstall: InstallRunner = async (program, args, timeoutMs) => {
  const result = await execa(program, args, { cwd: os.tmpdir(), env: podmanEnvironment(), extendEnv: false,
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
  const run = options.run ?? runInstall;
  const exists = options.exists ?? existsSync;
  const executable = options.executable ?? podmanExecutable;
  const report = options.report ?? (() => undefined);
  const timeout = limits.podmanSetupTimeoutMs;
  const checked = async (program: string, args: string[]) => {
    const result = await run(program, args, timeout);
    if (result.exitCode !== 0) throw new Error(`${path.basename(program)} setup failed (${result.exitCode}): ${(result.stderr || result.stdout).slice(-1600)}`);
    return result.stdout;
  };
  const version = await run(executable(), ["--version"], limits.podmanControlTimeoutMs).catch(() => undefined);
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
  if (!machines.some(machine => machine.Name === name)) {
    const connections = JSON.parse(await checked(executable(), ["system", "connection", "list", "--format", "json"]));
    if (!Array.isArray(connections) || connections.some(connection => connection.Name === name || connection.Name === `${name}-root`))
      throw new Error(`Podman connection name ${name} is already in use without the expected machine; choose another podmanMachineName`);
    report(`Creating rootless Podman machine ${name}. Other machines are left unchanged.`);
    await checked(executable(), ["machine", "init", "--rootful=false",
      "--cpus", String(limits.podmanMachineCpus), "--memory", String(limits.podmanMachineMemoryMb),
      "--disk-size", String(limits.podmanMachineDiskGb), name]);
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
  if (machine.State === "stopped") {
    report(`Starting Podman machine ${name}.`);
    // Podman 5 has neither this flag nor the prompt; Podman 6 must explicitly
    // suppress switching defaults. Inspect capability before mutating anything.
    const help = await checked(executable(), ["machine", "start", "--help"]);
    await checked(executable(), ["machine", "start", ...(help.includes("--update-connection") ? ["--update-connection=false"] : []), name]);
  } else if (machine.State !== "running") throw new Error(`Machine ${name} is ${machine.State}; wait for its existing operation to finish`);
  if ((await inspect()).State !== "running") throw new Error(`Machine ${name} did not reach running state`);
}
