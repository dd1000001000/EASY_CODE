import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import type { SandboxReadiness, SandboxSetupResult, SandboxStartupService } from "./startup.js";
import { checkedPodman, podmanRunner, type PodmanRunner } from "./podman-client.js";
import { ensurePodmanInstalled } from "./podman-install.js";

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
  constructor(private readonly limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS, run?: PodmanRunner,
    private readonly bootstrap = () => run
      ? Promise.reject(new Error("An injected Podman runner requires an explicit setup bootstrap; system installation is disabled for test runners"))
      : ensurePodmanInstalled(limits),
    private readonly report: (message: string) => void = () => undefined) {
    this.run = run ?? podmanRunner(limits);
  }
  private result(status: SandboxReadiness["status"], details: string[], canSetup = false): SandboxReadiness {
    return { status, platform: process.platform, backend: "Podman (rootless Linux task containers)", details, canSetup,
      warnings: process.platform === "linux" ? [] : ["Commands execute in Linux, not the native host OS. Podman machine must be running and able to bind the workspace."] };
  }
  async inspect(): Promise<SandboxReadiness> {
    try {
      const info = JSON.parse(await checkedPodman(this.run, ["info", "--format", "json"]));
      if (info.host?.security?.rootless !== true && info.Host?.Security?.Rootless !== true)
        return this.result("probe_failed", ["Select a rootless Podman connection/machine; EASY CODE will not launch rootful containers."]);
    } catch (error) {
      return this.result("dependencies_missing", ["Automatic sandbox preparation is incomplete. Run easy-code sandbox setup to install Podman and prepare its dedicated rootless machine/image. OS authorization or a WSL reboot may be required.", String(error).slice(0, 1600)], true);
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
    before ??= await this.inspect();
    if (before.status === "ready") return { status: "already_ready", message: "Podman sandbox is ready.", readiness: before };
    try {
      await this.bootstrap();
      const info = JSON.parse(await checkedPodman(this.run, ["info", "--format", "json"]));
      if (info.host?.security?.rootless !== true && info.Host?.Security?.Rootless !== true)
        throw new Error("Rootful engine rejected. No images or task containers were created.");
      const image = await this.run(["image", "exists", this.limits.podmanImage]);
      if (image.exitCode === 1) {
        this.report(`Preparing sandbox image ${this.limits.podmanImage}; downloading base tools may take several minutes.`);
        if (this.limits.podmanImage === DEFAULT_RUNTIME_LIMITS.podmanImage) {
          const file = podmanResource("Containerfile");
          await checkedPodman(this.run, ["build", "--tag", this.limits.podmanImage, "--file", file, path.dirname(file)], { timeoutMs: this.limits.podmanSetupTimeoutMs });
        } else await checkedPodman(this.run, ["pull", this.limits.podmanImage], { timeoutMs: this.limits.podmanSetupTimeoutMs });
      } else if (image.exitCode !== 0) throw new Error("Image state unknown; refusing a blind rebuild");
      const after = await this.inspect();
      return { status: after.status === "ready" ? "completed" : "failed", message: "Podman installation, machine and image preparation finished; see readiness checks.", readiness: after };
    } catch (error) { return { status: "failed", message: `Podman setup failed: ${String(error).slice(0, 1600)}`, readiness: before }; }
  }
}
