import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../utils/hash.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { buildCommandEnvironment } from "./environment.js";
import { analyzeNpmInstall } from "./npm-installer.js";
import type { ResolvedCommand, RunCommandInput } from "./types.js";

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_CHARS = 64 * 1024;
const FORBIDDEN_PROGRAM_CHARACTERS = /[\u0000\r\n;&|<>`]/u;

function isInsideWorkspace(workspace: WorkspaceManager, filename: string): boolean {
  try {
    workspace.pathGuard.assertInside(filename);
    return true;
  } catch {
    return false;
  }
}

function getEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

function executableExtensions(program: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [""];
  if (path.extname(program)) return [""];
  const pathExt = getEnvironmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  return ["", ...pathExt.split(";").filter(Boolean).map((entry) => entry.toLowerCase())];
}

async function isExecutable(filename: string): Promise<boolean> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() && !info.isSymbolicLink()) return false;
    await access(filename, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class CommandResolver {
  constructor(private readonly workspace: WorkspaceManager) {}

  async resolve(input: RunCommandInput): Promise<ResolvedCommand> {
    this.validateRequest(input);
    const environment = buildCommandEnvironment();
    const cwdAbsolute = await this.resolveCwd(input.cwd);
    const cwdRelative = cwdAbsolute === this.workspace.root
      ? "."
      : this.workspace.pathGuard.toRelative(cwdAbsolute);
    const executablePath = await this.resolveExecutable(input.program, cwdAbsolute, environment);

    let args = [...(input.args ?? [])];
    let approvalMaterialHash: string | undefined;
    if (this.basename(executablePath) === "npm") {
      const install = analyzeNpmInstall(args);
      if (install.isInstall && install.valid) args = install.normalizedArgs;
      this.hardenNpmEnvironment(environment);
      approvalMaterialHash = await this.inspectNpmProject(cwdAbsolute, args, install.isInstall && install.valid);
    }

    return {
      program: input.program,
      executablePath,
      args,
      cwdAbsolute,
      cwdRelative,
      executableInsideWorkspace: isInsideWorkspace(this.workspace, executablePath),
      environment,
      environmentKeys: Object.keys(environment).sort((left, right) => left.localeCompare(right)),
      ...(approvalMaterialHash ? { approvalMaterialHash } : {}),
    };
  }

  basename(executablePath: string): string {
    return path.basename(executablePath).replace(/\.(?:exe|cmd|bat|com)$/iu, "").toLowerCase();
  }

  private validateRequest(input: RunCommandInput): void {
    if (!input.program || input.program.length > 4_096 || FORBIDDEN_PROGRAM_CHARACTERS.test(input.program)) {
      throw new Error("program must be one executable name or workspace-relative executable path");
    }
    if (path.isAbsolute(input.program) || /^[a-zA-Z]:[\\/]/u.test(input.program)) {
      throw new Error("Absolute executable paths are not accepted from the model");
    }
    const args = input.args ?? [];
    if (args.length > MAX_ARGUMENTS) throw new Error(`Command has more than ${MAX_ARGUMENTS} arguments`);
    let total = 0;
    for (const argument of args) {
      if (typeof argument !== "string" || /[\u0000\r\n]/u.test(argument)) {
        throw new Error("Command arguments must be strings without control characters");
      }
      total += argument.length;
    }
    if (total > MAX_ARGUMENT_CHARS) {
      throw new Error(`Command arguments exceed the ${MAX_ARGUMENT_CHARS}-character limit`);
    }
  }

  private async resolveCwd(requested?: string): Promise<string> {
    if (!requested || requested === ".") return this.workspace.root;
    return this.workspace.pathGuard.resolveExisting(requested, {
      kind: "directory",
      allowFinalSymlink: true,
    });
  }

  private async resolveExecutable(
    requested: string,
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<string> {
    if (requested.includes("/") || requested.includes("\\")) {
      const target = await this.workspace.pathGuard.resolveExisting(requested, {
        kind: "file",
        allowFinalSymlink: true,
      });
      if (!(await isExecutable(target))) throw new Error("Workspace program is not executable");
      return target;
    }

    const extensions = executableExtensions(requested, environment);

    // Prefer a package-local binary, walking only as far as the workspace root.
    let directory = cwd;
    while (true) {
      for (const extension of extensions) {
        const candidate = path.join(directory, "node_modules", ".bin", `${requested}${extension}`);
        if (await isExecutable(candidate)) {
          const canonical = path.normalize(await realpath(candidate));
          this.workspace.pathGuard.assertInside(canonical);
          return canonical;
        }
      }
      if (directory === this.workspace.root) break;
      const parent = path.dirname(directory);
      if (!isInsideWorkspace(this.workspace, parent)) break;
      directory = parent;
    }

    const pathValue = getEnvironmentValue(environment, "PATH") ?? "";
    for (const directoryEntry of pathValue.split(path.delimiter)) {
      if (!directoryEntry) continue;
      const directoryPath = directoryEntry.replace(/^"|"$/gu, "");
      for (const extension of extensions) {
        const candidate = path.join(directoryPath, `${requested}${extension}`);
        if (await isExecutable(candidate)) {
          return path.normalize(await realpath(candidate));
        }
      }
    }
    throw new Error(`Executable not found on the controlled PATH: ${requested}`);
  }

  private hardenNpmEnvironment(environment: NodeJS.ProcessEnv): void {
    // npm rejects loading the exact same path as both user and global config.
    // Windows treats NUL with any extension as the null device; on POSIX the
    // missing global path is ignored while /dev/null is an empty user config.
    environment.NPM_CONFIG_USERCONFIG = process.platform === "win32" ? "NUL.user" : "/dev/null";
    environment.NPM_CONFIG_GLOBALCONFIG = process.platform === "win32"
      ? "NUL.global"
      : "/dev/null.easy-code-global";
    environment.NPM_CONFIG_AUDIT = "false";
    environment.NPM_CONFIG_FUND = "false";
    environment.NPM_CONFIG_UPDATE_NOTIFIER = "false";
    environment.NPM_CONFIG_COLOR = "false";
  }

  private async inspectNpmProject(
    cwd: string,
    args: readonly string[],
    validateInstall: boolean,
  ): Promise<string | undefined> {
    const packagePath = await this.findNearestPackageJson(cwd);
    const npmrcContents: Array<{ path: string; content: string }> = [];
    let directory = this.workspace.root;
    const relativeCwd = path.relative(this.workspace.root, cwd);
    const directories = [directory];
    if (relativeCwd) {
      for (const segment of relativeCwd.split(path.sep)) {
        directory = path.join(directory, segment);
        directories.push(directory);
      }
    }
    for (const candidateDirectory of directories) {
      const npmrcPath = path.join(candidateDirectory, ".npmrc");
      try {
        npmrcContents.push({
          path: this.workspace.pathGuard.toRelative(npmrcPath),
          content: await readFile(npmrcPath, "utf8"),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    if (validateInstall) {
      if (!packagePath) throw new Error("A project-local npm install requires package.json");
      for (const npmrc of npmrcContents) this.validateInstallNpmrc(npmrc.content);
    }

    if (!packagePath && npmrcContents.length === 0) return undefined;
    let packageContent = "";
    if (packagePath) packageContent = await readFile(packagePath, "utf8");
    if (validateInstall && packageContent) this.validateDependencySources(packageContent);

    return sha256(JSON.stringify({ packageContent, npmrcContents, args }));
  }

  private async findNearestPackageJson(start: string): Promise<string | undefined> {
    let directory = start;
    while (true) {
      const candidate = path.join(directory, "package.json");
      try {
        const info = await lstat(candidate);
        if (info.isFile()) return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (directory === this.workspace.root) return undefined;
      const parent = path.dirname(directory);
      if (!isInsideWorkspace(this.workspace, parent)) return undefined;
      directory = parent;
    }
  }

  private validateInstallNpmrc(content: string): void {
    const forbiddenKey = /^(?:registry|script-shell|prefix|global|proxy|https-proxy|userconfig|globalconfig)\s*=/iu;
    for (const line of content.split(/\r?\n/gu)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      if (forbiddenKey.test(trimmed)) {
        throw new Error("Project .npmrc overrides affecting registry, shell, proxy, or install location are not allowed for automatic install");
      }
    }
  }

  private validateDependencySources(packageContent: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(packageContent) as unknown;
    } catch {
      throw new Error("package.json must be valid JSON before npm install");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
      const dependencies = record[section];
      if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
      for (const [name, spec] of Object.entries(dependencies as Record<string, unknown>)) {
        if (typeof spec !== "string") continue;
        if (
          /^(?:git\+|git:|github:|gitlab:|bitbucket:|file:|link:|https?:|ssh:|npm:)/iu.test(spec) ||
          spec.endsWith(".tgz")
        ) {
          throw new Error(`Dependency ${name} uses a URL, Git, file, tarball, or alias source that automatic install forbids`);
        }
      }
    }
  }
}
