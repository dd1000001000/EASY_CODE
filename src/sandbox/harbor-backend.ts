import path from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execa } from "execa";
import { resolveHarborOuterSandbox } from "../benchmarks/swebench.js";
import { sandboxGitArgs, sandboxGitEnvironment } from "./git-policy.js";
import type { WorkspaceManager } from "../workspace/index.js";
import type { CommandExecutionBackend, PreparedCommand, SandboxExecutionMetadata, SandboxExecutionRequest } from "./types.js";

export const HARBOR_SANDBOX_HELPER = "/opt/easy-code-harbor/harbor-sandbox";
const PRIVATE_ROOT = "/opt/easy-code-harbor/commands";
const READ = 13, WRITE = 32754, REMOVE = 48;
// Only regular IPC files: no execute, directories, devices, sockets or symlinks.
export const HARBOR_SHM_ACCESS = 2 | 4 | 8 | 32 | 256 | 8192 | 16384;

export function validateHarborShmMount(mountinfo: string): void {
  const mounts = mountinfo.trim().split("\n").map(line => line.split(" "));
  const matches = mounts.filter(fields => fields[4] === "/dev/shm");
  const fields = matches[0];
  const separator = fields?.indexOf("-") ?? -1;
  const options = new Set(fields?.[5]?.split(","));
  if (matches.length !== 1 || !fields || fields[3] !== "/" || separator < 6 ||
      fields[separator + 1] !== "tmpfs" ||
      !["rw", "nosuid", "nodev", "noexec"].every(option => options.has(option)) ||
      mounts.some(entry => entry[4]?.startsWith("/dev/shm/"))) {
    throw new Error("Harbor requires a dedicated rw,nosuid,nodev,noexec /dev/shm tmpfs without nested mounts");
  }
}
const inside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

export async function assertHarborHelper(): Promise<void> {
  if (resolveHarborOuterSandbox() !== "harbor" || process.getuid?.() !== 0)
    throw new Error("Harbor backend requires the trusted Linux Docker adapter and root supervisor");
  for (const item of ["/opt", "/opt/easy-code-harbor", HARBOR_SANDBOX_HELPER]) {
    const s = await lstat(item);
    if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) ||
      (item === HARBOR_SANDBOX_HELPER ? !s.isFile() || !(s.mode & 0o100) : !s.isDirectory()))
      throw new Error(`Untrusted Harbor supervisor path: ${item}`);
  }
}

export async function inspectHarborSandbox(): Promise<string> {
  await assertHarborHelper();
  const result = await execa(HARBOR_SANDBOX_HELPER, ["--doctor"], {
    env: { PATH: "/usr/bin:/bin" }, extendEnv: false, timeout: 15000,
  });
  return result.stdout;
}

/** Partition grants around excluded subtrees. Never grant an ancestor then
 * attempt to subtract rights: Landlock rules are additive, not deny ACLs. */
export async function harborPathRules(root: string, excluded: readonly string[], access: number): Promise<Array<[number, string]>> {
  excluded = excluded.map(item => path.resolve(item));
  const result: Array<[number, string]> = [];
  let visited = 0;
  const visit = async (item: string): Promise<void> => {
    if (++visited > 8192) throw new Error("Harbor filesystem rule bound exceeded");
    if (excluded.some(deny => inside(deny, item))) return;
    const stat = await lstat(item).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!stat || stat.isSymbolicLink()) return;
    const split = excluded.some(deny => inside(item, deny));
    if (!split || !stat.isDirectory()) { result.push([access, item]); return; }
    // Grant listing/creation on ancestors, but not removal of protected children.
    // New files need WRITE_FILE/TRUNCATE inherited from their parent. Protected
    // existing subtrees also have immutable-to-target DAC permissions (below).
    result.push([access & ~(REMOVE | 1 | 4), item]);
    for (const name of await readdir(item)) await visit(path.join(item, name));
  };
  await visit(root);
  return result.filter(([rights]) => rights !== 0);
}

/** Container-only defense complementary to Landlock's additive write grants.
 * The supervisor retains CAP_DAC_OVERRIDE; targets drop every capability and
 * seccomp forbids chmod/chown/xattr. Execute bits are preserved for Git diffs. */
async function sealProtectedTree(root: string): Promise<void> {
  let visited = 0;
  const visit = async (item: string): Promise<void> => {
    if (++visited > 50000) throw new Error("Harbor protected metadata bound exceeded");
    const stat = await lstat(item).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!stat || stat.isSymbolicLink()) return;
    const handle = await open(item, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { await handle.chmod(stat.mode & 0o7777 & ~0o222); } finally { await handle.close(); }
    if (stat.isDirectory()) for (const name of await readdir(item)) await visit(path.join(item, name));
  };
  await visit(root);
}

export class HarborSandboxBackend implements CommandExecutionBackend {
  constructor(private readonly workspace: WorkspaceManager, private readonly sensitivePaths: readonly string[]) {}

  describe(request?: SandboxExecutionRequest): SandboxExecutionMetadata {
    return { backend: "harbor-landlock", enforced: true,
      filesystem: request?.context.mode === "plan" ? "workspace-read" : "workspace-write", network: "denied" };
  }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    await assertHarborHelper();
    validateHarborShmMount(await readFile("/proc/self/mountinfo", "utf8"));
    if ((await realpath("/dev/shm")) !== "/dev/shm" ||
        this.sensitivePaths.some(item => inside(path.resolve(item), "/dev/shm") || inside("/dev/shm", path.resolve(item))))
      throw new Error("Harbor shared memory overlaps a protected or redirected path");
    if (request.networkProxyURL) throw new Error("Harbor command networking cannot be enabled");
    await mkdir(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
    const privateStat = await lstat(PRIVATE_ROOT);
    if (!privateStat.isDirectory() || privateStat.isSymbolicLink() || privateStat.uid !== 0 || (privateStat.mode & 0o077))
      throw new Error("Untrusted Harbor command spool");
    const privateDir = await mkdtemp(`${PRIVATE_ROOT}/command-`);
    const scratch = await mkdtemp("/tmp/easy-code-harbor-work-");
    const cleanup = async (): Promise<void> => {
      await rm(scratch, { recursive: true, force: true });
      await rm(privateDir, { recursive: true, force: true });
    };
    try {
      const workspace = await realpath(this.workspace.root);
      const sensitive = [...this.sensitivePaths, "/opt/easy-code-harbor", "/logs", "/proc", "/sys", "/dev", "/run", "/root", "/tmp"];
      const readRules = await harborPathRules("/", sensitive, READ);
      // Trusted NVM's runtime libraries live below /root; no general HOME grant.
      const nodeRoot = process.execPath.match(/^(\/root\/\.nvm\/versions\/node\/[^/]+)\//u)?.[1];
      if (nodeRoot) readRules.push(...await harborPathRules(nodeRoot, this.sensitivePaths, READ));
      for (const dev of ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"])
        readRules.push([READ | 2, dev]);
      const protectedPaths = [path.join(workspace, ".git"), path.join(workspace, ".easycode"),
        ...this.sensitivePaths, fileURLToPath(new URL("..", import.meta.url)),
        fileURLToPath(new URL("../../node_modules", import.meta.url))].map(item => path.resolve(item));
      // A workspace inside a denied global directory still receives only its
      // explicit, scoped grant. Runtime data never gets such a carve-out.
      if (this.sensitivePaths.some(item => inside(item, workspace)) || inside("/opt/easy-code-harbor", workspace) || workspace === "/")
        throw new Error("Harbor workspace overlaps protected Runtime data");
      for (const item of protectedPaths.filter(item => inside(workspace, item))) await sealProtectedTree(item);
      const rules = [...readRules,
        [HARBOR_SHM_ACCESS, "/dev/shm"] as [number, string],
        ...await harborPathRules(workspace, this.sensitivePaths, READ),
        ...await harborPathRules(scratch, [], READ | WRITE),
        ...(request.context.mode === "plan" ? [] : await harborPathRules(workspace, protectedPaths, WRITE))];
      const env = sandboxGitEnvironment({ ...request.command.environment,
        HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch }, "/dev/null");
      const args = sandboxGitArgs(request.command.executablePath, request.command.args);
      const environment = Object.entries(env).filter((pair): pair is [string, string] => pair[1] !== undefined).map(([k, v]) => `${k}=${v}`);
      const fields = ["harbor-v1", request.commandId, request.command.cwdAbsolute, request.command.executablePath,
        String(rules.length), ...rules.flatMap(([rights, p]) => [String(rights), p]),
        String(args.length), ...args, String(environment.length), ...environment];
      if (fields.some(field => field.includes("\0"))) throw new Error("NUL in Harbor payload");
      const bytes = Buffer.from(`${fields.join("\0")}\0`);
      if (bytes.length > 1048576) throw new Error("Harbor payload exceeds bound");
      const payload = path.join(privateDir, "request.bin");
      await writeFile(payload, bytes, { mode: 0o600, flag: "wx" });
      return { executablePath: HARBOR_SANDBOX_HELPER, args: ["--run", payload], cwdAbsolute: "/",
        environment: { PATH: "/usr/bin:/bin" }, metadata: this.describe(request), controlPipe: true,
        cooperativeTermination: true, cleanup };
    } catch (error) { await cleanup(); throw error; }
  }
}
