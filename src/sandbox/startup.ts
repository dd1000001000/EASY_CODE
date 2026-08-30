import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

export type SandboxReadinessStatus =
  | "ready"
  | "setup_required"
  | "dependencies_missing"
  | "unsupported"
  | "probe_failed";

export interface SandboxReadiness {
  readonly status: SandboxReadinessStatus;
  readonly platform: NodeJS.Platform;
  readonly backend: string;
  readonly details: readonly string[];
  readonly warnings: readonly string[];
  readonly canSetup: boolean;
}

export type SandboxSetupStatus =
  | "completed"
  | "already_ready"
  | "cancelled"
  | "unavailable"
  | "failed";

export interface SandboxSetupResult {
  readonly status: SandboxSetupStatus;
  readonly message: string;
  readonly readiness: SandboxReadiness;
}

export interface SandboxStartupService {
  inspect(): Promise<SandboxReadiness>;
  setup(readiness?: SandboxReadiness): Promise<SandboxSetupResult>;
}

export interface SandboxSystemCommand {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface SandboxSystemCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

interface SandboxRuntimeModule {
  readonly SandboxManager: {
    isSupportedPlatform(): boolean;
    checkDependenciesAsync(ripgrepConfig?: {
      command: string;
      args?: string[];
    }): Promise<{ errors: string[]; warnings: string[] }>;
    initialize(config: Record<string, unknown>): Promise<void>;
    wrapWithSandboxArgv(
      command: string,
      binShell?: string,
      customConfig?: Record<string, unknown>,
      abortSignal?: AbortSignal,
      cwd?: string,
      options?: { commandId?: string; commandText?: string },
    ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
    cleanupAfterCommand(): void;
    reset(): Promise<void>;
  };
  readonly VENDORED_SRT_WIN_EXE: string;
  resolveSrtWin(options: { path: string }): unknown;
  checkWindowsSandboxStatusAsync(options: { srtWin: unknown }): Promise<{
    user: {
      provisioned: boolean;
      credPresent: boolean;
      groupExists: boolean;
      inSandboxGroup: boolean;
    };
    wfp: { state: string };
  }>;
  verifyWindowsWfpEgress(options: { srtWin: unknown }): Promise<unknown>;
  installWindowsSandboxAsync(options: { srtWin: unknown }): Promise<{ cancelled: boolean }>;
}

export interface DefaultSandboxStartupServiceOptions {
  readonly platform?: NodeJS.Platform;
  readonly loadRuntime?: () => Promise<SandboxRuntimeModule>;
  readonly runCommand?: (command: SandboxSystemCommand) => Promise<SandboxSystemCommandResult>;
  readonly readTextFile?: (filePath: string) => Promise<string>;
  readonly resolveExecutable?: (candidates: readonly string[]) => Promise<string | undefined>;
  readonly getUid?: () => number | undefined;
  readonly probe?: (runtime: SandboxRuntimeModule) => Promise<void>;
}

interface LinuxInstallRecipe {
  readonly manager: LinuxPackageManager;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
}

type LinuxPackageManager = "apt-get" | "apt" | "dnf" | "yum" | "pacman" | "zypper" | "apk";

const POSIX_INSTALL_TIMEOUT_MS = 10 * 60 * 1_000;
const PROBE_TIMEOUT_MS = 20_000;
const SYSTEM_EXECUTABLE_ROOTS = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew",
  "/usr/local/bin",
  "/usr/local/Homebrew",
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeDetail(value: string, maximum = 2_000): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function backendLabel(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Anthropic SRT for Windows (alpha)";
  if (platform === "darwin") return "Anthropic SRT for macOS";
  if (platform === "linux") return "Anthropic SRT for Linux";
  return `Anthropic SRT (${platform})`;
}

export function sandboxIsReady(readiness: SandboxReadiness): boolean {
  return readiness.status === "ready";
}

export function formatSandboxReadiness(readiness: SandboxReadiness): string[] {
  const lines = [`Sandbox backend: ${readiness.backend}`];
  if (readiness.status === "ready") {
    lines.push("Filesystem and network sandbox checks passed.");
  } else if (readiness.status === "setup_required") {
    lines.push("One-time operating-system sandbox setup is required.");
  } else if (readiness.status === "dependencies_missing") {
    lines.push("Required operating-system sandbox dependencies are missing.");
  } else if (readiness.status === "unsupported") {
    lines.push("This platform cannot provide the required command sandbox.");
  } else {
    lines.push("The sandbox enforcement probe did not pass.");
  }
  for (const detail of readiness.details) lines.push(`Detail: ${safeDetail(detail)}`);
  for (const warning of readiness.warnings) lines.push(`Warning: ${safeDetail(warning)}`);
  return lines;
}

function parseOsRelease(source: string): Set<string> {
  const identities = new Set<string>();
  for (const line of source.split(/\r?\n/gu)) {
    const match = /^(ID|ID_LIKE)=(.*)$/u.exec(line.trim());
    if (!match) continue;
    const raw = (match[2] ?? "").replace(/^['"]|['"]$/gu, "");
    for (const value of raw.toLowerCase().split(/\s+/u)) {
      if (value) identities.add(value);
    }
  }
  return identities;
}

function packageManagerCandidates(identities: ReadonlySet<string>): readonly LinuxPackageManager[] {
  const has = (...values: string[]): boolean => values.some((value) => identities.has(value));
  if (has("debian", "ubuntu", "linuxmint", "pop")) return ["apt-get", "apt"];
  if (has("fedora")) return ["dnf"];
  if (has("rhel", "centos", "rocky", "almalinux")) return ["dnf", "yum"];
  if (has("arch", "manjaro")) return ["pacman"];
  if (has("suse", "opensuse", "opensuse-leap", "opensuse-tumbleweed")) return ["zypper"];
  if (has("alpine")) return ["apk"];
  return [];
}

function executableCandidates(manager: LinuxPackageManager): readonly string[] {
  if (manager === "apk") return ["/sbin/apk", "/usr/sbin/apk", "/bin/apk", "/usr/bin/apk"];
  return [`/usr/bin/${manager}`, `/bin/${manager}`, `/usr/sbin/${manager}`, `/sbin/${manager}`];
}

function packagesFromErrors(errors: readonly string[]): string[] {
  let bubblewrap = false;
  let socat = false;
  let ripgrep = false;
  for (const error of errors) {
    const lower = error.toLowerCase();
    if (lower.includes("bubblewrap") || lower.includes("bwrap")) bubblewrap = true;
    if (lower.includes("socat")) socat = true;
    if (lower.includes("ripgrep") || /\brg\b/u.test(lower)) ripgrep = true;
  }
  return [
    ...(bubblewrap ? ["bubblewrap"] : []),
    ...(socat ? ["socat"] : []),
    ...(ripgrep ? ["ripgrep"] : []),
  ];
}

function installerEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: "/opt/homebrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
  for (const name of [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...extra };
}

function managerArguments(manager: LinuxPackageManager, packages: readonly string[]): string[] {
  if (manager === "apt-get" || manager === "apt" || manager === "dnf" || manager === "yum") {
    return ["install", "-y", ...packages];
  }
  if (manager === "pacman") return ["-S", "--needed", "--noconfirm", ...packages];
  if (manager === "zypper") {
    return ["--non-interactive", "install", "--no-recommends", ...packages];
  }
  return ["add", "--no-cache", ...packages];
}

export async function resolveTrustedSystemExecutable(
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const resolved = await realpath(candidate);
      const trusted = SYSTEM_EXECUTABLE_ROOTS.some((root) => {
        const relative = path.posix.relative(root, resolved);
        return relative !== "" && !relative.startsWith("..") && !path.posix.isAbsolute(relative);
      });
      if (trusted) return resolved;
    } catch {
      // Try the next fixed system path.
    }
  }
  return undefined;
}

async function defaultRunCommand(
  command: SandboxSystemCommand,
): Promise<SandboxSystemCommandResult> {
  try {
    const result = await execa(command.executablePath, [...command.args], {
      cwd: command.cwd,
      env: command.environment,
      extendEnv: false,
      shell: false,
      reject: false,
      timeout: command.timeoutMs ?? POSIX_INSTALL_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  } catch (error) {
    const typed = error as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      timedOut?: boolean;
    };
    return {
      exitCode: typeof typed.exitCode === "number" ? typed.exitCode : null,
      stdout: typeof typed.stdout === "string" ? typed.stdout : "",
      stderr: typeof typed.stderr === "string" ? typed.stderr : errorMessage(error),
      timedOut: typed.timedOut === true,
    };
  }
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

async function defaultProbe(runtime: SandboxRuntimeModule): Promise<void> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "easy-code-sandbox-doctor-"));
  let initialized = false;
  try {
    const truePath = await resolveTrustedSystemExecutable(["/usr/bin/true", "/bin/true"]);
    if (!truePath) throw new Error("A trusted `true` executable was not found for the sandbox probe");
    const linuxPaths = process.platform === "linux"
      ? {
          bwrapPath: await resolveTrustedSystemExecutable(["/usr/bin/bwrap", "/bin/bwrap"]),
          socatPath: await resolveTrustedSystemExecutable(["/usr/bin/socat", "/bin/socat"]),
          ripgrepPath: await resolveTrustedSystemExecutable(["/usr/bin/rg", "/bin/rg"]),
        }
      : undefined;
    if (
      linuxPaths &&
      (!linuxPaths.bwrapPath || !linuxPaths.socatPath || !linuxPaths.ripgrepPath)
    ) {
      throw new Error("Trusted Linux sandbox dependency paths could not be resolved");
    }
    await runtime.SandboxManager.initialize({
      network: {
        allowedDomains: [],
        deniedDomains: [],
        strictAllowlist: true,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
      filesystem: {
        denyRead: [],
        allowRead: [scratch],
        allowWrite: [scratch],
        denyWrite: [],
        allowGitConfig: false,
      },
      credentials: { envVars: [] },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
      allowPty: false,
      git: { safeDirectories: [] },
      ...(linuxPaths
        ? {
            bwrapPath: linuxPaths.bwrapPath,
            socatPath: linuxPaths.socatPath,
            ripgrep: { command: linuxPaths.ripgrepPath },
          }
        : {}),
    });
    initialized = true;
    const wrapped = await runtime.SandboxManager.wrapWithSandboxArgv(
      posixQuote(truePath),
      "/bin/sh",
      undefined,
      undefined,
      scratch,
      { commandId: "easy-code-sandbox-doctor", commandText: "sandbox readiness probe" },
    );
    const executablePath = wrapped.argv[0];
    if (!executablePath) throw new Error("Sandbox probe did not return an executable");
    const probeEnvironment = { ...wrapped.env };
    for (const name of [
      "QWEN_API_KEY",
      "DASHSCOPE_API_KEY",
      "DEEPSEEK_API_KEY",
      "ZAI_API_KEY",
      "GLM_API_KEY",
      "ZHIPUAI_API_KEY",
    ]) delete probeEnvironment[name];
    const result = await defaultRunCommand({
      executablePath,
      args: wrapped.argv.slice(1),
      cwd: scratch,
      environment: probeEnvironment,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      const detail = safeDetail(result.stderr || result.stdout || "probe exited without output", 1_000);
      throw new Error(`Sandboxed process probe failed (exit ${String(result.exitCode)}): ${detail}`);
    }
  } finally {
    try {
      if (initialized) runtime.SandboxManager.cleanupAfterCommand();
      await runtime.SandboxManager.reset();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

export class DefaultSandboxStartupService implements SandboxStartupService {
  private readonly platform: NodeJS.Platform;
  private readonly loadRuntime: () => Promise<SandboxRuntimeModule>;
  private readonly runCommand: (command: SandboxSystemCommand) => Promise<SandboxSystemCommandResult>;
  private readonly readTextFile: (filePath: string) => Promise<string>;
  private readonly resolveExecutable: (candidates: readonly string[]) => Promise<string | undefined>;
  private readonly getUid: () => number | undefined;
  private readonly probe: (runtime: SandboxRuntimeModule) => Promise<void>;

  constructor(options: DefaultSandboxStartupServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.loadRuntime = options.loadRuntime ?? (async () =>
      await import("@anthropic-ai/sandbox-runtime") as unknown as SandboxRuntimeModule);
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.readTextFile = options.readTextFile ?? (async (filePath) => await readFile(filePath, "utf8"));
    this.resolveExecutable = options.resolveExecutable ?? resolveTrustedSystemExecutable;
    this.getUid = options.getUid ?? (() => process.getuid?.());
    this.probe = options.probe ?? defaultProbe;
  }

  async inspect(): Promise<SandboxReadiness> {
    const backend = backendLabel(this.platform);
    let runtime: SandboxRuntimeModule;
    try {
      runtime = await this.loadRuntime();
    } catch (error) {
      return {
        status: "probe_failed",
        platform: this.platform,
        backend,
        details: [`Unable to load Anthropic Sandbox Runtime: ${errorMessage(error)}`],
        warnings: [],
        canSetup: false,
      };
    }

    if (!runtime.SandboxManager.isSupportedPlatform()) {
      return {
        status: "unsupported",
        platform: this.platform,
        backend,
        details: [`Anthropic Sandbox Runtime does not support ${this.platform}`],
        warnings: [],
        canSetup: false,
      };
    }

    if (this.platform === "win32") return this.inspectWindows(runtime, backend);

    let dependencies: { errors: string[]; warnings: string[] };
    try {
      if (this.platform === "linux") {
        const bwrapPath = await this.resolveExecutable(["/usr/bin/bwrap", "/bin/bwrap"]);
        const socatPath = await this.resolveExecutable(["/usr/bin/socat", "/bin/socat"]);
        const ripgrepPath = await this.resolveExecutable(["/usr/bin/rg", "/bin/rg"]);
        const trustedErrors = [
          ...(!bwrapPath ? ["bubblewrap (bwrap) not installed in a trusted system path"] : []),
          ...(!socatPath ? ["socat not installed in a trusted system path"] : []),
          ...(!ripgrepPath ? ["ripgrep (rg) not installed in a trusted system path"] : []),
        ];
        if (trustedErrors.length) {
          return {
            status: "dependencies_missing",
            platform: this.platform,
            backend,
            details: trustedErrors,
            warnings: [],
            canSetup: true,
          };
        }
        dependencies = await runtime.SandboxManager.checkDependenciesAsync({
          command: ripgrepPath!,
        });
        // SRT's pre-initialize API accepts a fixed ripgrep path but not fixed
        // bwrap/socat paths. Those two were independently resolved above and
        // are injected into the actual probe and command worker.
        dependencies.errors = dependencies.errors.filter((value) => {
          const lower = value.toLowerCase();
          return !lower.includes("bubblewrap") &&
            !lower.includes("bwrap") &&
            !lower.includes("socat");
        });
      } else {
        dependencies = await runtime.SandboxManager.checkDependenciesAsync();
      }
    } catch (error) {
      return {
        status: "probe_failed",
        platform: this.platform,
        backend,
        details: [`Unable to check sandbox dependencies: ${errorMessage(error)}`],
        warnings: [],
        canSetup: false,
      };
    }
    const details = dependencies.errors.map((value) => safeDetail(value));
    const warnings = dependencies.warnings.map((value) => safeDetail(value));
    if (details.length) {
      return {
        status: "dependencies_missing",
        platform: this.platform,
        backend,
        details,
        warnings,
        canSetup: this.platform === "linux" || this.platform === "darwin",
      };
    }
    if (warnings.length) {
      return {
        status: "probe_failed",
        platform: this.platform,
        backend,
        details: [
          "The installed runtime reported a reduced-isolation warning; EASY CODE requires the full sandbox boundary.",
        ],
        warnings,
        canSetup: false,
      };
    }

    try {
      await this.probe(runtime);
      return {
        status: "ready",
        platform: this.platform,
        backend,
        details: [],
        warnings: [],
        canSetup: false,
      };
    } catch (error) {
      return {
        status: "probe_failed",
        platform: this.platform,
        backend,
        details: [
          `${errorMessage(error)}. Check User Namespace, AppArmor, container, or enterprise sandbox policy settings.`,
        ],
        warnings: [],
        canSetup: false,
      };
    }
  }

  async setup(readiness?: SandboxReadiness): Promise<SandboxSetupResult> {
    const before = readiness ?? await this.inspect();
    if (sandboxIsReady(before)) {
      return { status: "already_ready", message: "The command sandbox is already ready.", readiness: before };
    }
    if (!before.canSetup) {
      return {
        status: "unavailable",
        message: "This sandbox state requires an administrator or platform policy change; EASY CODE did not modify the system.",
        readiness: before,
      };
    }

    if (this.platform === "win32") return this.setupWindows(before);
    if (this.platform === "linux") return this.setupLinux(before);
    if (this.platform === "darwin") return this.setupMacOs(before);
    return {
      status: "unavailable",
      message: `Automatic sandbox setup is not available for ${this.platform}.`,
      readiness: before,
    };
  }

  private async inspectWindows(
    runtime: SandboxRuntimeModule,
    backend: string,
  ): Promise<SandboxReadiness> {
    try {
      const srtWin = runtime.resolveSrtWin({ path: runtime.VENDORED_SRT_WIN_EXE });
      const status = await runtime.checkWindowsSandboxStatusAsync({ srtWin });
      const userReady = status.user.provisioned &&
        status.user.credPresent &&
        status.user.groupExists &&
        status.user.inSandboxGroup;
      let networkReady = false;
      let networkDetail = status.wfp.state;
      if (userReady) {
        try {
          await runtime.verifyWindowsWfpEgress({ srtWin });
          networkReady = true;
          networkDetail = "verified";
        } catch (error) {
          networkDetail = errorMessage(error);
        }
      }
      if (userReady && networkReady) {
        return {
          status: "ready",
          platform: this.platform,
          backend,
          details: [],
          warnings: [],
          canSetup: false,
        };
      }
      return {
        status: "setup_required",
        platform: this.platform,
        backend,
        details: [
          `Filesystem identity: ${userReady ? "ready" : "not initialized"}`,
          `Network fence: ${safeDetail(networkDetail)}`,
        ],
        warnings: [],
        canSetup: true,
      };
    } catch (error) {
      return {
        status: "probe_failed",
        platform: this.platform,
        backend,
        details: [`Windows sandbox status check failed: ${errorMessage(error)}`],
        warnings: [],
        canSetup: false,
      };
    }
  }

  private async setupWindows(before: SandboxReadiness): Promise<SandboxSetupResult> {
    try {
      const runtime = await this.loadRuntime();
      const srtWin = runtime.resolveSrtWin({ path: runtime.VENDORED_SRT_WIN_EXE });
      const result = await runtime.installWindowsSandboxAsync({ srtWin });
      if (result.cancelled) {
        return {
          status: "cancelled",
          message: "Windows sandbox setup was canceled; command execution remains unavailable.",
          readiness: before,
        };
      }
      const after = await this.inspect();
      return sandboxIsReady(after)
        ? { status: "completed", message: "Windows sandbox setup and verification completed.", readiness: after }
        : { status: "failed", message: "Windows setup finished, but the verification check did not pass.", readiness: after };
    } catch (error) {
      return {
        status: "failed",
        message: `Windows sandbox setup failed: ${errorMessage(error)}`,
        readiness: before,
      };
    }
  }

  private async setupLinux(before: SandboxReadiness): Promise<SandboxSetupResult> {
    const packages = packagesFromErrors(before.details);
    if (!packages.length) {
      return {
        status: "unavailable",
        message: "The missing Linux prerequisite is not part of EASY CODE's fixed installation allowlist.",
        readiness: before,
      };
    }
    let osRelease: string;
    try {
      osRelease = await this.readTextFile("/etc/os-release");
    } catch (error) {
      return {
        status: "unavailable",
        message: `Unable to identify the Linux distribution safely: ${errorMessage(error)}`,
        readiness: before,
      };
    }
    const candidates = packageManagerCandidates(parseOsRelease(osRelease));
    let recipe: LinuxInstallRecipe | undefined;
    for (const manager of candidates) {
      const executablePath = await this.resolveExecutable(executableCandidates(manager));
      if (!executablePath) continue;
      const selectedPackages = manager === "apk" && !packages.includes("bash")
        ? [...packages, "bash"]
        : packages;
      recipe = {
        manager,
        executablePath,
        args: managerArguments(manager, selectedPackages),
        ...(manager === "apt-get" || manager === "apt"
          ? { environment: installerEnvironment({ DEBIAN_FRONTEND: "noninteractive" }) }
          : { environment: installerEnvironment() }),
      };
      break;
    }
    if (!recipe) {
      return {
        status: "unavailable",
        message: "No trusted, supported package manager was found for this Linux distribution.",
        readiness: before,
      };
    }

    let command: SandboxSystemCommand = {
      executablePath: recipe.executablePath,
      args: recipe.args,
      environment: recipe.environment,
      timeoutMs: POSIX_INSTALL_TIMEOUT_MS,
    };
    if (this.getUid() !== 0) {
      const sudoPath = await this.resolveExecutable(["/usr/bin/sudo", "/bin/sudo"]);
      if (!sudoPath) {
        return {
          status: "unavailable",
          message: `Administrator access is required. Run ${recipe.executablePath} ${recipe.args.join(" ")} as root, then rerun sandbox doctor.`,
          readiness: before,
        };
      }
      const sudoCheck = await this.runCommand({
        executablePath: sudoPath,
        args: ["-n", "true"],
        environment: installerEnvironment(),
        timeoutMs: 10_000,
      });
      if (sudoCheck.exitCode !== 0) {
        return {
          status: "unavailable",
          message: `A non-interactive sudo credential is not available. Run sudo ${recipe.executablePath} ${recipe.args.join(" ")}, then rerun sandbox doctor.`,
          readiness: before,
        };
      }
      command = {
        executablePath: sudoPath,
        args: ["-n", "--", recipe.executablePath, ...recipe.args],
        environment: recipe.environment,
        timeoutMs: POSIX_INSTALL_TIMEOUT_MS,
      };
    }

    const installed = await this.runCommand(command);
    if (installed.exitCode !== 0) {
      const detail = safeDetail(installed.stderr || installed.stdout || "package manager exited without output");
      return {
        status: "failed",
        message: `Sandbox dependency installation failed${installed.timedOut ? " (timed out)" : ""}: ${detail}`,
        readiness: before,
      };
    }
    const after = await this.inspect();
    return sandboxIsReady(after)
      ? { status: "completed", message: "Linux sandbox dependencies were installed and verified.", readiness: after }
      : { status: "failed", message: "Dependencies were installed, but the enforcement probe did not pass.", readiness: after };
  }

  private async setupMacOs(before: SandboxReadiness): Promise<SandboxSetupResult> {
    const packages = packagesFromErrors(before.details);
    if (!packages.includes("ripgrep")) {
      return {
        status: "unavailable",
        message: "macOS Seatbelt is provided by the operating system; this failure cannot be repaired by installing a package.",
        readiness: before,
      };
    }
    const brewPath = await this.resolveExecutable([
      "/opt/homebrew/bin/brew",
      "/usr/local/bin/brew",
    ]);
    if (!brewPath) {
      return {
        status: "unavailable",
        message: "Homebrew was not found in a trusted installation path. Install ripgrep manually and rerun sandbox doctor.",
        readiness: before,
      };
    }
    const installed = await this.runCommand({
      executablePath: brewPath,
      args: ["install", "ripgrep"],
      environment: installerEnvironment(),
      timeoutMs: POSIX_INSTALL_TIMEOUT_MS,
    });
    if (installed.exitCode !== 0) {
      return {
        status: "failed",
        message: `Homebrew could not install ripgrep: ${safeDetail(installed.stderr || installed.stdout)}`,
        readiness: before,
      };
    }
    const after = await this.inspect();
    return sandboxIsReady(after)
      ? { status: "completed", message: "macOS sandbox prerequisites were installed and verified.", readiness: after }
      : { status: "failed", message: "The prerequisite was installed, but the enforcement probe did not pass.", readiness: after };
  }
}

export interface SandboxStartupTerminal {
  selectChoice(
    title: string,
    choices: readonly { id: string; label: string; detail?: string }[],
    initialId?: string,
  ): Promise<string | undefined>;
  info(text: string): void;
  success(text: string): void;
  warning(text: string): void;
  error(text: string): void;
  startActivity(text: string): void;
  stopActivity(): void;
}

/** Run the first-interactive-start guide inside the existing retained terminal. */
export async function runSandboxStartupGuide(
  service: SandboxStartupService,
  terminal: SandboxStartupTerminal,
): Promise<boolean> {
  let readiness = await service.inspect();
  if (sandboxIsReady(readiness)) return true;

  while (true) {
    for (const line of formatSandboxReadiness(readiness)) terminal.warning(line);
    const choices = [
      ...(readiness.canSetup
        ? [{
            id: "setup",
            label: "Set up sandbox now (Recommended)",
            detail: readiness.platform === "win32"
              ? "A one-time UAC confirmation is required"
              : "Install only the fixed missing prerequisite packages",
          }]
        : []),
      { id: "recheck", label: "Recheck sandbox", detail: "Run the readiness probe again" },
      {
        id: "continue",
        label: "Continue with sandboxed commands blocked",
        detail: "Chat and workspace file tools remain available; dangerous full access requires a separate confirmation",
      },
      { id: "exit", label: "Exit EASY CODE", detail: "Make no system changes" },
    ];
    const selected = await terminal.selectChoice(
      "Command sandbox is not ready",
      choices,
      readiness.canSetup ? "setup" : "recheck",
    );
    if (!selected || selected === "exit") return false;
    if (selected === "continue") {
      terminal.warning(
        "Continuing without a ready OS sandbox. Manual and auto-approved commands remain fail-closed. " +
          "Commands can run on the host only if you later choose Dangerous full access and confirm its separate warning.",
      );
      return true;
    }

    terminal.startActivity(
      selected === "setup" ? "Setting up the command sandbox" : "Checking the command sandbox",
    );
    try {
      if (selected === "setup") {
        const result = await service.setup(readiness);
        readiness = result.readiness;
        if (result.status === "completed" || result.status === "already_ready") {
          terminal.success(result.message);
          return true;
        }
        if (result.status === "cancelled" || result.status === "unavailable") {
          terminal.warning(result.message);
        } else {
          terminal.error(result.message);
        }
      } else {
        readiness = await service.inspect();
        if (sandboxIsReady(readiness)) {
          terminal.success("Command sandbox verification passed.");
          return true;
        }
      }
    } catch (error) {
      terminal.error(`Sandbox startup operation failed: ${safeDetail(errorMessage(error))}`);
      readiness = await service.inspect();
    } finally {
      terminal.stopActivity();
    }
  }
}
