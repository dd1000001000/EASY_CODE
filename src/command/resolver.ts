import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../utils/hash.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { buildCommandEnvironment } from "./environment.js";
import { analyzeNpmInstall } from "./npm-installer.js";
import { normalizeExplicitShellArgs } from "./shell.js";
import { trustedExecutableLocation } from "./security.js";
import { resolveLocalCommandPath } from "./local-path.js";
import type { ResolvedCommand, RunCommandInput } from "./types.js";

const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_CHARS = 64 * 1024;
const FORBIDDEN_PROGRAM_CHARACTERS = /[\u0000\r\n]/u;

/** A structurally valid request rejected by a Runtime security boundary. */
export class CommandPolicyBoundaryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CommandPolicyBoundaryError";
  }
}

function policyBoundaryMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:escapes the workspace boundary|Runtime resources cannot be accessed)/iu.test(message);
}

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
  // Match Windows command lookup semantics. An extensionless POSIX shim often
  // sits beside npm.cmd; choosing the shim first makes CreateProcess fail with
  // ERROR_BAD_EXE_FORMAT even though the Windows launcher is available.
  return [...pathExt.split(";").filter(Boolean).map((entry) => entry.toLowerCase()), ""];
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

  /** Resolve filesystem/PATH in Docker at dispatch, never on the controller.
   * A worker may create /tmp scripts or install an executable which does not
   * exist in the controller. Main benchmark bypasses approval; reviewers still
   * require exact permission within their immutable private image/copy scope. */
  resolveContainer(input: RunCommandInput): ResolvedCommand {
    this.validateRequest(input);
    const cwdAbsolute = path.posix.resolve(this.workspace.root, input.cwd ?? ".");
    const environment = buildCommandEnvironment();
    return { program: input.program, executablePath: input.program, args: [...(input.args ?? [])],
      cwdAbsolute, cwdRelative: path.posix.relative(this.workspace.root, cwdAbsolute) || ".",
      executableInsideWorkspace: false, trustedExecutable: false, environment,
      environmentKeys: Object.keys(environment).sort() };
  }

  async resolve(
    input: RunCommandInput,
    options: { unrestrictedHostAccess?: boolean; unrestrictedCommands?: boolean; networkEnabled?: boolean } = {},
  ): Promise<ResolvedCommand> {
    // Structural validation applies even to explicitly authorized host execution.
    this.validateRequest(input);
    const environment = buildCommandEnvironment();
    let cwdAbsolute = await this.resolveCwd(input.cwd, options.unrestrictedHostAccess);
    const executablePath = await this.resolveExecutable(
      options.unrestrictedHostAccess && /[\\/]/u.test(input.program) ? path.resolve(cwdAbsolute, input.program) : input.program,
      cwdAbsolute,
      environment,
      options.unrestrictedHostAccess,
    );

    let args = options.unrestrictedCommands ? [...(input.args ?? [])] : normalizeExplicitShellArgs(
      this.basename(executablePath),
      input.args ?? [],
    );
    this.validateArguments(args);
    if (this.basename(executablePath) === "git") {
      // Fold only Git's explicit directory option, never configuration/exec overrides.
      let index = 0;
      while (index < args.length) {
        const option = args[index]!;
        if (["--no-pager", "--no-optional-locks"].includes(option)) { index++; continue; }
        if (!option.startsWith("-C")) break;
        const directory = option === "-C" ? args[index + 1] : option.slice(2);
        if (directory === undefined) throw new Error("git -C requires a directory");
        if (directory) {
          const target = await resolveLocalCommandPath(directory, cwdAbsolute);
          cwdAbsolute = await this.resolveCwd(target, options.unrestrictedHostAccess);
        }
        args.splice(index, option === "-C" ? 2 : 1);
      }
    }
    const cwdRelative = this.displayCwd(cwdAbsolute);
    let approvalMaterialHash: string | undefined;
    if (this.basename(executablePath) === "npm" && !options.unrestrictedCommands) {
      const install = analyzeNpmInstall(args);
      if (install.isInstall && install.valid && !options.unrestrictedCommands) {
        args = options.networkEnabled && !(input.args ?? []).includes("--offline") ? install.normalizedArgs.filter(a => a !== "--offline") : install.normalizedArgs;
      }
      if (options.networkEnabled && !options.unrestrictedCommands && ["install", "i", "add", "ci"].includes(args[0] ?? "")) {
        args = [...args, "--ignore-scripts", "--no-audit", "--no-fund"];
      }
      this.hardenNpmEnvironment(environment);
      approvalMaterialHash = await this.inspectNpmProject(cwdAbsolute, args, !options.networkEnabled && !options.unrestrictedCommands && install.isInstall && install.valid);
    }
    // Disallow implicit curlrc behavior before classifying a read-only recipe.
    if (this.basename(executablePath) === "curl" && !options.unrestrictedCommands && args[0] !== "-q") args.unshift("-q");

    // Bind executable bytes as well as npm/config material across approval waits.
    const executableHash = sha256(await readFile(executablePath));
    approvalMaterialHash = sha256(JSON.stringify([approvalMaterialHash ?? null, executableHash]));
    const launch = await this.windowsScriptLaunch(executablePath);
    return {
      program: input.program,
      executablePath,
      executableHash,
      args,
      cwdAbsolute,
      cwdRelative,
      executableInsideWorkspace: isInsideWorkspace(this.workspace, executablePath),
      trustedExecutable: trustedExecutableLocation(executablePath, this.workspace.root),
      environment,
      environmentKeys: Object.keys(environment).sort((left, right) => left.localeCompare(right)),
      ...(launch ? { launch } : {}),
      ...(approvalMaterialHash ? { approvalMaterialHash } : {}),
    };
  }

  basename(executablePath: string): string {
    return path.basename(executablePath).replace(/\.(?:exe|cmd|bat|com)$/iu, "").toLowerCase();
  }

  private validateRequest(input: RunCommandInput): void {
    if (!input.program || input.program.length > 4_096 || FORBIDDEN_PROGRAM_CHARACTERS.test(input.program)) {
      throw new Error("program must be one executable name or path without NUL or line breaks");
    }
    if (/^(?:\\\\|\/\/)/u.test(input.program)) {
      throw new CommandPolicyBoundaryError(
        "Remote executable paths are not accepted",
        "policy.absolute_executable",
      );
    }
    this.validateArguments(input.args ?? []);
  }

  private validateArguments(args: readonly string[]): void {
    if (args.length > MAX_ARGUMENTS) throw new Error(`Command has more than ${MAX_ARGUMENTS} arguments`);
    let total = 0;
    for (const argument of args) {
      if (typeof argument !== "string" || /\u0000/u.test(argument)) {
        throw new Error("Command arguments must be strings without NUL characters");
      }
      total += argument.length;
    }
    if (total > MAX_ARGUMENT_CHARS) {
      throw new Error(`Command arguments exceed the ${MAX_ARGUMENT_CHARS}-character limit`);
    }
  }

  private async resolveCwd(requested: string | undefined, unrestricted = false): Promise<string> {
    if (!requested || requested === ".") return this.workspace.root;
    if (unrestricted) {
      const resolved = await realpath(path.resolve(this.workspace.root, requested));
      if (!(await lstat(resolved)).isDirectory()) throw new Error("cwd must be a directory");
      return resolved;
    }
    const cwdKey = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    try {
      if (/^(?:\\\\|\/\/)/u.test(requested)) throw new Error("Network working directories are not accepted");
      if (!path.isAbsolute(requested)) {
        if (process.platform !== "win32" && /^[a-z]:[\\/]/iu.test(requested)) {
          throw new Error("Foreign absolute working directories are not accepted");
        }

        // A command cwd is different from a file-tool path: harmless lexical
        // normalization such as `tests/..` is useful and must remain valid.
        // Select an explicit project-folder namespace when present, otherwise
        // resolve from the primary folder, then enforce the boundary against
        // both the lexical and canonical paths. This permits normalization
        // inside one root without allowing `..` to cross into another root.
        let base = this.workspace.root;
        let inner = requested;
        if (this.workspace.folders.length > 1) {
          const segments = requested.split(/[\\/]+/u);
          const selected = this.workspace.folders.find(folder => folder.key === segments[0]);
          if (selected) {
            base = selected.path;
            inner = segments.slice(1).join(path.sep) || ".";
          }
        }
        const lexical = path.resolve(base, inner);
        this.workspace.pathGuard.assertInside(lexical);
        if (cwdKey(this.workspace.rootForPath(lexical)) !== cwdKey(base)) {
          throw new Error("Working-directory traversal cannot cross project folder boundaries");
        }
        const relative = path.relative(base, lexical);
        const segments = relative.split(path.sep).filter(Boolean);
        if (segments.some(segment => segment.toLowerCase() === ".git")) {
          throw new Error("Git control paths are reserved for the EASY CODE Runtime");
        }
        if (segments[0]?.toLowerCase() === ".easy-code-runtime") {
          throw new Error("Sandbox scratch paths are reserved for the EASY CODE Runtime");
        }
        if (segments[0]?.toLowerCase() === ".easycode" && segments[1]?.toLowerCase() === "config.toml") {
          throw new Error("Workspace trust configuration cannot be used as a command working directory");
        }
        const canonical = await resolveLocalCommandPath(lexical, base);
        this.workspace.pathGuard.assertInside(canonical);
        if (cwdKey(this.workspace.rootForPath(canonical)) !== cwdKey(base)) {
          throw new Error("Working-directory links cannot cross project folder boundaries");
        }
        if (!(await lstat(canonical)).isDirectory()) throw new Error("cwd must be a directory");
        return canonical;
      }
      // Absolute paths can use Windows short aliases; their canonical boundary is checked below.
      const canonical = await resolveLocalCommandPath(requested, this.workspace.root);
      this.workspace.pathGuard.assertInside(canonical);
      if (cwdKey(canonical) === cwdKey(this.workspace.root)) return this.workspace.root;
      return canonical;
    } catch (error) {
      throw new CommandPolicyBoundaryError(
        error instanceof Error ? error.message : String(error),
        "policy.cwd_boundary",
      );
    }
  }

  private async resolveExecutable(
    requested: string,
    cwd: string,
    environment: NodeJS.ProcessEnv,
    unrestrictedHostAccess = false,
  ): Promise<string> {
    if (path.isAbsolute(requested)) {
      for (const extension of executableExtensions(requested, environment)) {
        const candidate = `${requested}${extension}`;
        if (!await isExecutable(candidate)) continue;
        const canonical = await resolveLocalCommandPath(candidate, cwd);
        if (await isExecutable(canonical)) return canonical;
      }
      throw new Error("Program is not executable");
    }
    if (requested.includes("/") || requested.includes("\\")) {
      for (const extension of executableExtensions(requested, environment)) {
        try {
          const lexical = path.resolve(cwd, `${requested}${extension}`);
          this.workspace.pathGuard.assertInside(lexical);
          this.workspace.pathGuard.normalizeRelative(this.workspace.pathGuard.toRelative(lexical));
        } catch (error) {
          throw new CommandPolicyBoundaryError(
            error instanceof Error ? error.message : String(error),
            "policy.executable_boundary",
          );
        }
        try {
          const target = await resolveLocalCommandPath(`${requested}${extension}`, cwd);
          if (isInsideWorkspace(this.workspace, target)) {
            this.workspace.pathGuard.normalizeRelative(this.workspace.pathGuard.toRelative(target));
          } else if (!trustedExecutableLocation(target, this.workspace.root)) {
            throw new Error("Executable link escapes the workspace boundary to an untrusted tool location");
          }
          if (await isExecutable(target)) return target;
        } catch (error) {
          if (policyBoundaryMessage(error)) {
            throw new CommandPolicyBoundaryError(
              error instanceof Error ? error.message : String(error),
              "policy.executable_boundary",
            );
          }
          // A missing PATHEXT candidate is normal; continue to the next one.
        }
      }
      throw new Error("Workspace program is not executable");
    }

    const extensions = executableExtensions(requested, environment);

    // Prefer a package-local binary only when cwd belongs to a project root.
    // Full-access commands may intentionally use a host cwd; in that case the
    // controlled PATH remains available but project boundary checks do not
    // accidentally turn valid host execution into a resolution failure.
    let workspaceRoot: string | undefined;
    try {
      workspaceRoot = this.workspace.rootForPath(cwd);
    } catch (error) {
      if (!unrestrictedHostAccess) throw error;
    }
    if (workspaceRoot) {
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
        if (directory === workspaceRoot) break;
        const parent = path.dirname(directory);
        if (parent === directory) break;
        if (!isInsideWorkspace(this.workspace, parent)) break;
        directory = parent;
      }
    }

    const pathValue = getEnvironmentValue(environment, "PATH") ?? "";
    for (const directoryEntry of pathValue.split(path.delimiter)) {
      if (!directoryEntry || !path.isAbsolute(directoryEntry.replace(/^"|"$/gu, ""))) continue;
      const directoryPath = directoryEntry.replace(/^"|"$/gu, "");
      if (/^(?:\\\\|\/\/)/u.test(directoryPath)) continue;
      for (const extension of extensions) {
        const candidate = path.join(directoryPath, `${requested}${extension}`);
        if (await isExecutable(candidate)) {
          return path.normalize(await realpath(candidate));
        }
      }
    }
    throw new Error(`Executable not found on the controlled PATH: ${requested}`);
  }

  private displayCwd(cwdAbsolute: string): string {
    if (cwdAbsolute === this.workspace.root) return ".";
    try {
      return this.workspace.pathGuard.toRelative(cwdAbsolute);
    } catch {
      return cwdAbsolute;
    }
  }

  private async windowsScriptLaunch(
    executablePath: string,
  ): Promise<ResolvedCommand["launch"]> {
    if (process.platform !== "win32" || !/\.(?:cmd|bat|ps1)$/iu.test(executablePath)) return undefined;
    const node = await realpath(process.execPath).catch(() => process.execPath);
    const launcher = fileURLToPath(new URL("./windows-script-launcher.js", import.meta.url));
    if (!await isExecutable(node)) throw new Error("Node.js executable is unavailable for Windows script launch");
    return {
      kind: "windows-script",
      executablePath: path.normalize(node),
      args: [launcher],
      usesCommandPayload: true,
    };
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
    const workspaceRoot = this.workspace.rootForPath(cwd);
    let directory = workspaceRoot;
    const relativeCwd = path.relative(workspaceRoot, cwd);
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
    const workspaceRoot = this.workspace.rootForPath(start);
    while (true) {
      const candidate = path.join(directory, "package.json");
      try {
        const info = await lstat(candidate);
        if (info.isFile()) return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (directory === workspaceRoot) return undefined;
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
        throw new CommandPolicyBoundaryError(
          "Project .npmrc overrides affecting registry, shell, proxy, or install location are not allowed for automatic install",
          "policy.npmrc_override",
        );
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
          throw new CommandPolicyBoundaryError(
            `Dependency ${name} uses a URL, Git, file, tarball, or alias source that automatic install forbids`,
            "policy.dependency_source",
          );
        }
      }
    }
  }
}
