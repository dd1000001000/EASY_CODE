import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import type { SandboxReadiness, SandboxSetupResult, SandboxStartupService } from "./startup.js";
import { checkedPodman, podmanRunner, type PodmanRunner } from "./podman-client.js";
import { ensurePodmanInstalled } from "./podman-install.js";
import { recordOwnedResource } from "../install/ownership.js";
import { podmanConnectionsFile, podmanEnvironment, podmanExecutable } from "./podman-client.js";
import { execa } from "execa";
import os from "node:os";
import { withPodmanSetupLock } from "./podman-setup-lock.js";

export function podmanResource(name: string): string {
  const candidates = [new URL(`../../resources/podman/${name}`, import.meta.url), new URL(`../../../resources/podman/${name}`, import.meta.url)];
  const found = candidates.map(url => fileURLToPath(url)).find(existsSync);
  if (!found) throw new Error(`Packaged Podman resource missing: ${name}`);
  return found;
}
export const PODMAN_IPC_PROBE = `import asyncio, socket, multiprocessing, tempfile, os
a,b=socket.socketpair(); a.close(); b.close()
async def check(): return 1
assert asyncio.run(check()) == 1
s=multiprocessing.Semaphore(1); assert s.acquire(timeout=1); s.release()
with tempfile.TemporaryDirectory() as p:
 open(os.path.join(p,'probe'),'w').write('ok')
s=socket.socket(); s.settimeout(1)
try:
 s.connect(('1.1.1.1',443))
 raise RuntimeError('External network unexpectedly reachable')
except OSError: pass
finally: s.close()
print('PODMAN_IPC_OK')`;

export class PodmanStartupService implements SandboxStartupService {
  private readonly run: PodmanRunner;
  private readonly bootstrap: () => Promise<void>;
  private readonly recordInstallation: boolean;
  constructor(private readonly limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS, run?: PodmanRunner,
    bootstrap?: () => Promise<void>,
    private readonly report: (message: string) => void = () => undefined) {
    this.run = run ?? podmanRunner(limits);
    this.recordInstallation = !run;
    this.bootstrap = bootstrap ?? (() => run
      ? Promise.reject(new Error("An injected Podman runner requires an explicit setup bootstrap; system installation is disabled for test runners"))
      : ensurePodmanInstalled(limits, { report: this.report }));
  }
  private result(status: SandboxReadiness["status"], details: string[], canSetup = false): SandboxReadiness {
    return { status, platform: process.platform, backend: "Podman (rootless Linux task containers)", details, canSetup,
      warnings: process.platform === "linux" ? [] : ["Commands execute in Linux, not the native host OS. Podman machine must be running and able to bind the workspace."] };
  }
  private async diagnostics(): Promise<string[]> {
    if (!this.recordInstallation) return [];
    try {
      const details = [`Podman executable: ${podmanExecutable()}; connections file: ${podmanConnectionsFile()}; requested connection: ${this.limits.podmanMachineName}`];
      for (const command of [["machine", "list", "--format", "json"], ["system", "connection", "list", "--format", "json"]]) {
        const result = await execa(podmanExecutable(), command, { cwd: os.tmpdir(), env: podmanEnvironment(), extendEnv: false,
          shell: false, windowsHide: true, reject: false, timeout: this.limits.podmanControlTimeoutMs, maxBuffer: 1024 * 1024 });
        if (result.exitCode !== 0) details.push(`${command.slice(0, 2).join(" ")}: ${result.stderr.slice(0, 800)}`);
        else {
          const rows = JSON.parse(result.stdout);
          details.push(`${command[0] === "machine" ? "Machines" : "Connections"}: ${Array.isArray(rows) ? rows.map(row => row.Name).join(", ") || "(none)" : "invalid inventory"}`);
        }
      }
      return details;
    } catch (error) { return [`Podman diagnostics: ${String(error).slice(0, 1000)}`]; }
  }
  async inspect(): Promise<SandboxReadiness> {
    try {
      const info = JSON.parse(await checkedPodman(this.run, ["info", "--format", "json"]));
      if (info.host?.security?.rootless !== true && info.Host?.Security?.Rootless !== true)
        return this.result("probe_failed", ["Select a rootless Podman connection/machine; EASY CODE will not launch rootful containers."]);
    } catch (error) {
      const missing = /ENOENT|not recognized|executable.*not found/iu.test(String(error));
      return this.result(missing ? "dependencies_missing" : "setup_required", [
        missing ? "Podman executable is unavailable; setup will attempt installation."
          : "Podman connection/engine is not ready. Setup will verify the existing machine and restore a missing rootless connection; it will not recreate the VM.",
        String(error).slice(0, 1600), ...await this.diagnostics()], true);
    }
    const image = await this.run(["image", "exists", this.limits.podmanImage]);
    if (image.exitCode === 1) return this.result("setup_required", [`Image ${this.limits.podmanImage} is missing. Setup builds the packaged base image (downloads dependencies) or pulls a configured external image.`], true);
    if (image.exitCode !== 0) return this.result("probe_failed", ["Unable to inspect the configured image; engine state is unknown."]);
    const name = `easy-code-doctor-${randomUUID()}`;
    try {
      const output = await checkedPodman(this.run, ["run", "--name", name, "--rm", "--network=none", "--user", "0:0",
        "--security-opt=no-new-privileges", "--cap-drop=NET_RAW", "--pids-limit", "64", "--memory", "256m",
        "--shm-size", `${this.limits.podmanShmMb}m`, "--entrypoint", "python3", this.limits.podmanImage, "-I", "-u", "-c", PODMAN_IPC_PROBE]);
      if (output !== "PODMAN_IPC_OK") throw new Error("Container IPC probe did not return its expected result");
      return this.result("ready", ["Engine/image ready. Disposable Linux probe passed: asyncio, socketpair, semaphore, temporary files and external-network denial. Workspace mapping is verified separately at each dispatch."]);
    } catch (error) { return this.result("probe_failed", [String(error).slice(0, 1600)]); }
    finally {
      const exists = await this.run(["container", "exists", name]);
      if (exists.exitCode === 0) await checkedPodman(this.run, ["rm", "--force", name]);
      else if (exists.exitCode !== 1) throw new Error(`Doctor cleanup unknown; inspect ${name}`);
    }
  }
  async setup(before?: SandboxReadiness): Promise<SandboxSetupResult> {
    if (!this.recordInstallation) return this.prepare(before);
    try {
      return await withPodmanSetupLock(() => this.prepare(), this.limits.podmanControlTimeoutMs);
    } catch (error) {
      return { status: "failed", message: `Podman setup failed: ${String(error).slice(0, 1600)}`,
        readiness: this.result("setup_required", [String(error).slice(0, 1600)], true) };
    }
  }
  private async prepare(before?: SandboxReadiness): Promise<SandboxSetupResult> {
    before ??= await this.inspect();
    if (before.status === "ready") return { status: "already_ready", message: "Podman sandbox is ready.", readiness: before };
    let stage = "engine/machine/connection preparation";
    try {
      this.report(`Preparing Podman (${this.recordInstallation ? podmanConnectionsFile() : "test connection"}).`);
      await this.bootstrap();
      stage = "rootless engine verification";
      const info = JSON.parse(await checkedPodman(this.run, ["info", "--format", "json"]));
      if (info.host?.security?.rootless !== true && info.Host?.Security?.Rootless !== true)
        throw new Error("Rootful engine rejected. No images or task containers were created.");
      const image = await this.run(["image", "exists", this.limits.podmanImage]);
      stage = "sandbox image preparation";
      if (image.exitCode === 1) {
        this.report(`Preparing sandbox image ${this.limits.podmanImage}; downloading base tools may take several minutes.`);
        if (this.limits.podmanImage === DEFAULT_RUNTIME_LIMITS.podmanImage) {
          const file = podmanResource("Containerfile");
          await checkedPodman(this.run, ["build", "--tag", this.limits.podmanImage, "--file", file, path.dirname(file)], { timeoutMs: this.limits.podmanSetupTimeoutMs });
        } else await checkedPodman(this.run, ["pull", this.limits.podmanImage], { timeoutMs: this.limits.podmanSetupTimeoutMs });
        if (this.recordInstallation) {
          const rows = JSON.parse(await checkedPodman(this.run, ["image", "inspect", this.limits.podmanImage]));
          if (!Array.isArray(rows) || !rows[0]?.Id) throw new Error("Cannot record installed image identity");
          recordOwnedResource({ kind: "image", name: this.limits.podmanImage, identity: rows[0].Id,
            connection: process.platform === "linux" ? "" : this.limits.podmanMachineName });
        }
      } else if (image.exitCode !== 0) throw new Error("Image state unknown; refusing a blind rebuild");
      stage = "final IPC/offline verification";
      const after = await this.inspect();
      return { status: after.status === "ready" ? "completed" : "failed", message: "Podman installation, machine and image preparation finished; see readiness checks.", readiness: after };
    } catch (error) {
      const detail = `${stage}: ${String(error).slice(0, 1600)}`;
      return { status: "failed", message: `Podman setup failed at ${detail}`,
        readiness: this.result("setup_required", [detail, ...await this.diagnostics()], true) };
    }
  }
}
