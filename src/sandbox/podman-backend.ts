import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, realpath, lstat, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { resolveEasyCodePaths } from "../config/defaults.js";
import { CommandResolver } from "../command/resolver.js";
import { podmanCommandGrant } from "../command/podman-grant.js";
import { capturePodmanReview, validateReviewVolumes, writePodmanRecord, PodmanReviewCleanupError, type PodmanReviewSnapshot } from "./podman-review.js";
import type { ResolvedCommand, RunCommandInput } from "../command/types.js";
import type { ToolContext } from "../core/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { CommandExecutionBackend, PreparedCommand, SandboxExecutionRequest } from "./types.js";
import { executionCapabilities } from "./capabilities.js";
import { checkedPodman, inspectTaskContainer, podmanEnvironment, podmanRunner, stopTaskContainer, type PodmanRunner } from "./podman-client.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const PODMAN_WORKSPACE = "/workspace";
const inside = (root: string, value: string) => {
  const rel = path.relative(root, value);
  return rel === "" || !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
};
export function podmanMount(source: string, target: string, readonly = false): string {
  if (/[\r\n\0,]/u.test(source + target)) throw new Error("Podman mount paths cannot contain commas or control characters");
  // Windows Podman machine uses WSL drive mounts; --mount sources are engine-
  // side paths, not paths on the remote CLI host. A nonce probe verifies this.
  const engineSource = /^[a-zA-Z]:[\\/]/u.test(source)
    ? `/mnt/${source[0]!.toLowerCase()}/${source.slice(3).replace(/\\/gu, "/")}` : source;
  return `type=bind,src=${engineSource},dst=${target}${readonly ? ",ro=true" : ""}`;
}

export function resolvePodmanCommand(workspace: WorkspaceManager, input: RunCommandInput): ResolvedCommand {
  // Reuse structural ceilings only. Linux PATH/cwd are not resolved on Windows.
  new CommandResolver(workspace).resolveContainer({ ...input, cwd: "." });
  const map = (value: string): string => {
    if (path.isAbsolute(value) && inside(workspace.root, path.resolve(value)))
      return path.posix.join(PODMAN_WORKSPACE, path.relative(workspace.root, value).split(path.sep).join("/"));
    if (/^[a-zA-Z]:|^\\\\/u.test(value)) throw new Error("Podman runs Linux: use /workspace or a container executable, not a Windows path");
    return value;
  };
  const program = map(input.program);
  if (program.includes("\\") || program.startsWith("-")) throw new Error("Use a Linux executable name/path in the Podman sandbox");
  const cwd = path.posix.resolve(PODMAN_WORKSPACE, map(input.cwd ?? ".").replace(/\\/gu, "/"));
  // argv is deliberately opaque: never rewrite code, interpolate a shell or truncate.
  const environment = { HOME: "/root", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8", TERM: "dumb", PYTHONUNBUFFERED: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat", PAGER: "cat" };
  return { program, executablePath: program, args: [...(input.args ?? [])], cwdAbsolute: cwd,
    cwdRelative: path.posix.relative(PODMAN_WORKSPACE, cwd) || ".", executableInsideWorkspace: program.startsWith(PODMAN_WORKSPACE + "/"),
    trustedExecutable: false, environment, environmentKeys: Object.keys(environment).sort() };
}

export interface PodmanBackendOptions {
  limits?: Readonly<RuntimeLimits>;
  stateRoot?: string;
  sensitiveReadPaths?: readonly string[];
  /** Review dependency image is immutable; its workspace/tmp remain private writable copies. */
  readOnlyRootfs?: boolean;
  reviewSnapshot?: PodmanReviewSnapshot;
  /** Test seam; production always invokes the installed Podman CLI directly. */
  run?: PodmanRunner;
}

/** One durable, offline Linux container per workspace + thread. Each command
 * owns it exclusively until stop/inspect confirms *all* processes are gone.
 * Rootfs/dependencies survive stop; no host ACL mutation or language hooks. */
export class PodmanSandboxBackend implements CommandExecutionBackend {
  private readonly limits: Readonly<RuntimeLimits>;
  private readonly run: PodmanRunner;
  private readonly stateRoot: string;
  private static readonly slots = new Map<string, Promise<void>>();
  constructor(private readonly workspace: WorkspaceManager, private readonly options: PodmanBackendOptions = {}) {
    this.limits = options.limits ?? DEFAULT_RUNTIME_LIMITS;
    this.run = options.run ?? podmanRunner(this.limits, [workspace.root]);
    this.stateRoot = options.stateRoot ?? path.join(resolveEasyCodePaths().dataDir, "podman");
    if (inside(workspace.root, path.resolve(this.stateRoot))) throw new Error("Podman control state must be outside the workspace");
  }
  describe(request?: SandboxExecutionRequest) {
    return { backend: "podman" as const, enforced: true, filesystem: "container" as const,
      network: request?.networkProxyURL ? "brokered" as const : "denied" as const, capabilities: executionCapabilities("podman") };
  }
  resolveCommand(input: RunCommandInput): ResolvedCommand { return resolvePodmanCommand(this.workspace, input); }
  workspaceRelativeCwd(command: ResolvedCommand): string | undefined {
    const relative = path.posix.relative(PODMAN_WORKSPACE, command.cwdAbsolute);
    return relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative) ? undefined : relative;
  }
  /** Prefix authority belongs to this task's container, NOT a host executable.
   * No untrusted in-container hash can attest executable bytes. */
  approvalPrefix(command: ResolvedCommand, context: ToolContext, network: boolean): string {
    // Grant persistence/inheritance is already scoped by the approval service.
    // Bind additionally to the Linux image and cwd; never match host grants.
    return podmanCommandGrant(command, hash(this.limits.podmanImage), network);
  }
  private scope(context: Pick<ToolContext, "threadId">): string {
    return hash(JSON.stringify([this.workspace.root, context.threadId, this.limits.podmanImage, this.limits.podmanMachineName]));
  }
  async snapshotForReview(threadId: string, signal?: AbortSignal): Promise<PodmanReviewSnapshot> {
    const owner = this.scope({ threadId });
    const directory = path.join(this.stateRoot, owner);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (inside(await realpath(this.workspace.root), await realpath(directory))) throw new Error("Podman state resolves inside workspace");
    const lockPath = path.join(directory, "command.lease");
    const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error("Cannot snapshot a task container with an active/unfinished command"); });
    const name = `easy-code-${owner.slice(0, 32)}`;
    try {
      await lock.writeFile(JSON.stringify({ version: 1, owner, name, threadId, pid: process.pid, operation: "review_snapshot" }));
      await lock.sync();
    } finally { await lock.close(); }
    try {
      const info = JSON.parse(await checkedPodman(this.run, ["info", "--format", "json"], { signal }));
      if (info.host?.security?.rootless !== true && info.Host?.Security?.Rootless !== true) throw new Error("Review requires rootless Podman");
      const result = await capturePodmanReview({ run: this.run, limits: this.limits, owner, directory, containerName: name,
        mounts: await this.mounts(directory, true), signal });
      await rm(lockPath);
      return result;
    } catch (error) {
      // Bad dependency contents are not uncertain execution. Only an unknown
      // helper cleanup keeps the lease and blocks future mutations.
      if (!(error instanceof PodmanReviewCleanupError)) await rm(lockPath);
      throw error;
    }
  }
  /** Explicit fixture/user teardown only; normal task completion retains state. */
  async removeTask(threadId: string): Promise<void> {
    const owner = this.scope({ threadId });
    const name = `easy-code-${owner.slice(0, 32)}`;
    const directory = path.join(this.stateRoot, owner);
    if (existsSync(path.join(directory, "command.lease"))) throw new Error(`Inspect unfinished Podman command before removing ${name}`);
    await stopTaskContainer(this.run, name, owner);
    if (await inspectTaskContainer(this.run, name)) await checkedPodman(this.run, ["rm", name]);
    if (await inspectTaskContainer(this.run, name)) throw new Error(`Container removal not confirmed: ${name}`);
    if (path.dirname(path.resolve(directory)) !== path.resolve(this.stateRoot) || !/^[a-f0-9]{64}$/u.test(path.basename(directory)))
      throw new Error("Invalid Podman task cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    const owner = this.scope(request.context);
    const name = `easy-code-${owner.slice(0, 32)}`;
    const directory = path.join(this.stateRoot, owner);
    const previous = PodmanSandboxBackend.slots.get(owner) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>(resolve => { release = resolve; });
    PodmanSandboxBackend.slots.set(owner, slot);
    // Abort a queued command promptly, without opening a second execution slot.
    const signal = request.context.signal;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([previous, new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Podman command canceled before dispatch"));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      })]);
    } catch (error) { void previous.then(release); throw error; }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
    let locked = false;
    let scratch: string | undefined;
    let touched = false;
    const lockPath = path.join(directory, "command.lease");
    const unlock = async () => {
      try {
        if (scratch) await rm(scratch, { recursive: true, force: true });
        if (locked) { await rm(lockPath); locked = false; }
      } finally {
        release();
        if (PodmanSandboxBackend.slots.get(owner) === slot) PodmanSandboxBackend.slots.delete(owner);
      }
    };
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (inside(await realpath(this.workspace.root), await realpath(directory))) throw new Error("Podman control state resolves inside workspace");
      const lock = await open(lockPath, "wx", 0o600).catch(() => {
        throw new Error(`Podman task has an unfinished command lease. Inspect ${name} and ${lockPath}; do not replay the command.`);
      });
      locked = true;
      await writePodmanRecord(path.join(directory, "task.json"), { version: 1, owner, name,
        threadId: request.context.threadId, workspaceRoot: this.workspace.root,
        kind: this.options.readOnlyRootfs ? "review" : "task", updatedAt: new Date().toISOString() });
      try { await lock.writeFile(JSON.stringify({ version: 1, owner, name, commandId: request.commandId, threadId: request.context.threadId, pid: process.pid })); await lock.sync(); }
      finally { await lock.close(); }
      const info = JSON.parse(await checkedPodman(this.run, ["info", "--format", "json"], { signal }));
      if (info.host?.security?.rootless !== true && info.Host?.Security?.Rootless !== true)
        throw new Error("EASY CODE requires rootless Podman. Select a rootless local machine/connection; host-root containers are not used.");
      let container = await inspectTaskContainer(this.run, name);
      // Engine-owned hard lifetime also bounds orphans if the entire CLI dies.
      const maxRunSeconds = Math.ceil((Math.max(this.limits.commandInspectTimeoutMaxMs, this.limits.commandExecuteTimeoutMaxMs,
        this.limits.commandInstallTimeoutMaxMs) + Math.max(this.limits.sandboxStartupWindowsMs, this.limits.sandboxStartupPosixMs) +
        this.limits.podmanControlTimeoutMs * 3 + this.limits.sandboxCleanupTimeoutMs) / 1000);
      const spec = hash(JSON.stringify([this.limits.podmanImage, this.limits.podmanMemoryMb, this.limits.podmanCpus,
        this.limits.podmanPidsLimit, this.limits.podmanShmMb, this.limits.podmanTmpMb, maxRunSeconds, this.options.readOnlyRootfs === true,
        this.workspace.pathGuard.protectedPaths(), this.options.sensitiveReadPaths, this.options.reviewSnapshot?.revision]));
      if (container) {
        if (container.Config?.Labels?.["io.easy-code.owner"] !== owner || container.Config?.Labels?.["io.easy-code.spec"] !== spec)
          throw new Error(`Container ${name} does not match this task/configuration. Retain it for inspection; create a new thread or explicitly remove the old container.`);
        if (container.State?.Running || container.State?.Paused) throw new Error(`Container ${name} is unexpectedly active. Inspect its previous command; it will not be reused or replayed.`);
      } else {
        await checkedPodman(this.run, ["image", "inspect", this.limits.podmanImage]);
        const mounts = await this.mounts(directory);
        const args = ["create", "--name", name, "--label", `io.easy-code.owner=${owner}`, "--label", `io.easy-code.spec=${spec}`,
          "--network=none", "--http-proxy=false", "--restart=no", "--timeout", String(maxRunSeconds),
          "--user", "0:0", "--security-opt=no-new-privileges", "--cap-drop=NET_RAW",
          ...(this.options.readOnlyRootfs ? ["--read-only"] : []),
          "--memory", `${this.limits.podmanMemoryMb}m`, "--memory-swap", `${this.limits.podmanMemoryMb}m`,
          "--cpus", String(this.limits.podmanCpus), "--pids-limit", String(this.limits.podmanPidsLimit),
          "--shm-size", `${this.limits.podmanShmMb}m`, "--tmpfs", `/tmp:rw,nosuid,nodev,size=${this.limits.podmanTmpMb}m`,
          "--workdir", PODMAN_WORKSPACE, "--entrypoint", "/bin/sleep", ...mounts,
          this.limits.podmanImage, "infinity"];
        touched = true; // A failed create response is ambiguous; cleanup must query it.
        await checkedPodman(this.run, args, { signal });
        container = await inspectTaskContainer(this.run, name);
      }
      if (container?.HostConfig?.NetworkMode !== "none" || container?.HostConfig?.Privileged === true)
        throw new Error("Podman container isolation does not match the offline, unprivileged policy");
      if (this.options.readOnlyRootfs && container?.HostConfig?.ReadonlyRootfs !== true)
        throw new Error("Podman review dependency image is not read-only");
      if (signal?.aborted) throw new Error("Podman command canceled before start");
      await writePodmanRecord(path.join(directory, "environment.revision"), { commandId: request.commandId, nonce: randomBytes(16).toString("hex") });
      touched = true;
      await checkedPodman(this.run, ["start", name], { signal });
      if (existsSync(path.join(directory, "git")) && !existsSync(path.join(directory, "git", "index"))) {
        const head = await this.run(["exec", "--env", "GIT_DIR=/easy-code-git", name, "git", "rev-parse", "--verify", "HEAD"]);
        if (head.exitCode === 0) await checkedPodman(this.run, ["exec", "--env", "GIT_DIR=/easy-code-git", name, "git", "read-tree", "HEAD"]);
      }
      // Verify VM-side bind mapping against an exact host-created nonce. Never
      // silently run on an empty remote path or copy back over the user's files.
      const probe = `.easy-code-mount-${randomBytes(12).toString("hex")}`;
      const nonce = randomBytes(32).toString("hex");
      await writeFile(path.join(this.workspace.root, probe), nonce, { flag: "wx" });
      try {
        const echoed = await checkedPodman(this.run, ["exec", name, "/bin/cat", `${PODMAN_WORKSPACE}/${probe}`], { signal });
        if (echoed !== nonce) throw new Error("Podman workspace mount does not match the host workspace");
      } finally { await rm(path.join(this.workspace.root, probe), { force: true }); }
      scratch = await mkdtemp(path.join(directory, "command-"));
      const payloadPath = path.join(scratch, "payload.json");
      const proxy = request.networkProxyURL ? new URL(request.networkProxyURL) : undefined;
      if (proxy) { proxy.hostname = "127.0.0.1"; proxy.port = "18080"; }
      const environment = { ...request.command.environment,
        ...(existsSync(path.join(directory, "git")) ? { GIT_DIR: "/easy-code-git", GIT_WORK_TREE: PODMAN_WORKSPACE } : {}),
        ...(proxy ? { HTTP_PROXY: proxy.href, HTTPS_PROXY: proxy.href,
          http_proxy: proxy.href, https_proxy: proxy.href, NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" } : {}) };
      await writeFile(payloadPath, JSON.stringify({ name, owner, commandId: request.commandId, target: { ...request.command, environment },
        proxyURL: request.networkProxyURL, timeoutMs: request.timeoutMs, limits: this.limits }), { mode: 0o600 });
      let cleanup: Promise<void> | undefined;
      return { executablePath: process.execPath, args: [fileURLToPath(new URL("podman-worker.js", import.meta.url)), payloadPath],
        cwdAbsolute: os.tmpdir(), environment: podmanEnvironment([this.workspace.root]), metadata: { ...this.describe(request),
          ...(this.options.readOnlyRootfs ? { reviewEnvironmentUnchanged: true } : {}) },
        controlPipe: true, externalLifecycle: true,
        cancel: () => stopTaskContainer(this.run, name, owner),
        cleanup: () => cleanup ??= (async () => {
          // Called even when the local worker is killed, its output is lost or
          // initialization fails. Only the engine's inspected state proves stop.
          try { await stopTaskContainer(this.run, name, owner); }
          catch (error) { release(); throw error; } // retain durable lease on uncertainty
          await unlock();
        })() };
    } catch (error) {
      try { if (touched) await stopTaskContainer(this.run, name, owner); }
      catch (cleanupError) { release(); throw new AggregateError([error, cleanupError], `Podman setup cleanup unknown; inspect ${name}`); }
      await unlock();
      throw error;
    }
  }
  private async mounts(directory: string, snapshotSource = false): Promise<string[]> {
    const mounts = ["--mount", podmanMount(this.workspace.root, PODMAN_WORKSPACE, snapshotSource)];
    const protectedPaths = [...this.workspace.pathGuard.protectedPaths(), ...(this.options.sensitiveReadPaths ?? [])];
    const blank = path.join(directory, "empty");
    await writeFile(blank, "", { mode: 0o600 });
    const blankDirectory = path.join(directory, "empty-directory");
    await mkdir(blankDirectory, { recursive: true, mode: 0o700 });
    const hidden: string[] = [];
    for (const candidate of [...new Set(protectedPaths)].sort((a, b) => a.length - b.length)) {
      if (inside(candidate, this.workspace.root)) throw new Error("Workspace overlaps protected Runtime data");
      if (!inside(this.workspace.root, candidate) || !existsSync(candidate)) continue;
      if (hidden.some(parent => inside(parent, candidate))) continue;
      if (path.resolve(candidate) === this.workspace.root) throw new Error("Workspace overlaps protected Runtime data");
      const relative = path.relative(this.workspace.root, candidate).split(path.sep).join("/");
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error("Protected workspace mount cannot be a symlink");
      const target = path.posix.join(PODMAN_WORKSPACE, relative);
      if (info.isDirectory()) {
        // Podman otherwise copies the underlying bind subtree into tmpfs,
        // which would expose the very secrets this mount is intended to hide.
        mounts.push("--mount", podmanMount(blankDirectory, target, true));
        hidden.push(candidate);
      }
      else mounts.push("--mount", podmanMount(blank, target, true));
    }
    const gitPath = path.join(this.workspace.root, ".git");
    if (existsSync(gitPath) && !snapshotSource) {
      mounts.push("--mount", podmanMount(gitPath, `${PODMAN_WORKSPACE}/.git`, true));
      // A private Git object/index/config copy makes container commits harmless
      // to host Git metadata and supports Windows/managed-worktree .git pointers.
      const git = path.join(directory, "git");
      if (!existsSync(git)) {
        const result = await execa("git", ["-c", "core.hooksPath=/dev/null", "clone", "--bare", "--no-hardlinks", "--", this.workspace.root, git],
          { cwd: os.tmpdir(), env: { ...podmanEnvironment([this.workspace.root]), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
            extendEnv: false, windowsHide: true, timeout: this.limits.podmanControlTimeoutMs, reject: false });
        if (result.exitCode !== 0) throw new Error(`Cannot prepare private container Git metadata: ${result.stderr.slice(0, 1000)}`);
        await writeFile(path.join(git, "config"), "[core]\n\tbare = false\n\thooksPath = /dev/null\n\tautocrlf = false\n");
      }
      mounts.push("--mount", podmanMount(git, "/easy-code-git"));
    }
    if (!snapshotSource && this.options.reviewSnapshot) {
      await validateReviewVolumes(this.run, this.options.reviewSnapshot);
      for (const [name, volume] of Object.entries(this.options.reviewSnapshot.volumes))
        mounts.push("--volume", `${volume}:${PODMAN_WORKSPACE}/${name}:ro,nocopy`);
    }
    return mounts;
  }
}
