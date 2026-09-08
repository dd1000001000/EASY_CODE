import path from "node:path";
import type { AgentMode } from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import { createId } from "../utils/ids.js";
import { analyzeNpmInstall } from "./npm-installer.js";
import { inspectExplicitShellInvocation, shellCommandWords } from "./shell.js";
import { inspectNetworkOperation } from "./network-policy.js";
import type {
  CommandCapability,
  CommandPolicyDecision,
  ResolvedCommand,
  RunCommandInput,
} from "./types.js";

const SCRIPT_HOSTS = new Set(["wscript", "cscript"]);

const SYSTEM_PROGRAMS = new Set([
  "sudo",
  "su",
  "runas",
  "apt",
  "apt-get",
  "aptitude",
  "brew",
  "winget",
  "choco",
  "scoop",
  "dnf",
  "yum",
  "pacman",
  "apk",
  "systemctl",
  "reg",
  "regedit",
]);

const EXTERNAL_PROGRAMS = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "rsync",
]);

const DESTRUCTIVE_PROGRAMS = new Set([
  "shred",
  "mkfs",
  "format",
  "dd",
  "shutdown",
  "reboot",
  "kill",
  "killall",
  "pkill",
  "taskkill",
]);
const LOCAL_FILE_PROGRAMS = new Set(["rm", "rmdir", "del", "erase", "unlink", "mv", "move", "remove-item", "move-item"]);
const LOCAL_WORK_PROGRAMS = new Set(["ls", "dir", "cat", "head", "tail", "wc", "rg", "grep", "find", "sort", "sed", "awk", "echo", "printf", "pwd", "cp", "copy", "mkdir", "touch", "sleep", "timeout", "pytest", "pytest3", "make", "cmake", "ninja", "gcc", "g++", "clang", "clang++", "go", "cargo", "rustc", "java", "javac", "mvn", "gradle", "dotnet", "tsc", "eslint"]);

function highRiskFileArguments(args: readonly string[], cwd: string): boolean {
  const targets = args.filter(argument => !argument.startsWith("-"));
  return args.some(argument => /^(?:--recursive|-recurse|\/s)$/iu.test(argument) || /^-[dfirRv]+$/u.test(argument) && /r/iu.test(argument)) || targets.length === 0 || targets.some(target => {
    const relative = path.relative(cwd, path.resolve(cwd, target));
    return !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || /[*?\[\]$%]/u.test(target);
  });
}

const INTERPRETER_EVAL_FLAGS = new Set([
  "-c",
  "-e",
  "--eval",
  "--print",
  "-p",
  "--command",
  "-command",
  "-encodedcommand",
  "--encoded-command",
]);

const INTERPRETERS = new Set(["node", "python", "python3", "perl", "ruby", "php"]);
const ASYNC_WORKAROUND_PROGRAMS = new Set(["nohup", "disown"]);
const GIT_EXTERNAL = new Set(["push", "send-email"]);
const GIT_DESTRUCTIVE = new Set([
  "clean",
  "reset",
  "checkout",
  "restore",
  "switch",
  "rebase",
  "merge",
  "commit",
  "cherry-pick",
  "revert",
  "gc",
]);
const GIT_SAFE_READ = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "branch"]);
const NPM_REMOTE_OR_SYSTEM = new Set([
  "publish",
  "unpublish",
  "deprecate",
  "owner",
  "access",
  "dist-tag",
  "token",
  "login",
  "logout",
  "adduser",
  "profile",
  "star",
  "unstar",
]);

function executableName(command: ResolvedCommand): string {
  return path.basename(command.executablePath).replace(/\.(?:exe|cmd|bat|com)$/iu, "").toLowerCase();
}

function firstNonFlag(args: readonly string[]): string | undefined {
  return args.find((argument) => !argument.startsWith("-"))?.toLowerCase();
}

function decision(
  effect: CommandPolicyDecision["effect"],
  capability: CommandCapability,
  reason: string,
  matchedRule: string,
  recommendation?: string,
): CommandPolicyDecision {
  const risk: CommandPolicyDecision["risk"] =
    capability === "safe_inspect"
      ? "read"
      : capability === "workspace_exec" || capability === "shell_exec"
        ? "workspace"
        : capability === "registry_install"
          ? "install"
          : capability === "system_write"
            ? "system"
            : capability === "external_write"
              ? "external"
              : "destructive";
  return {
    id: createId("policy"),
    effect,
    capability,
    risk,
    reason,
    matchedRule,
    ...(recommendation ? { recommendation } : {}),
  };
}

function modeDecision(
  mode: AgentMode,
  capability: CommandCapability,
  reason: string,
  rule: string,
): CommandPolicyDecision {
  if (capability === "safe_inspect") return decision("allow", capability, reason, rule);
  if (mode === "plan") {
    return decision("deny", capability, "Plan mode only permits safe inspection recipes", "mode.plan");
  }
  if (capability === "registry_install") {
    return decision("allow", capability, reason, rule);
  }
  // Approval remains independent from the OS sandbox. Repository or
  // third-party code still requires an exact, one-shot approval even though
  // the process will be confined to its Runtime-selected workspace.
  return decision("ask", capability, reason, rule);
}

export class CommandPolicy {
  classify(input: RunCommandInput, command: ResolvedCommand, mode: AgentMode, networkEnabled = false): CommandPolicyDecision {
    const name = executableName(command);
    const lowerArgs = command.args.map((argument) => argument.toLowerCase());
    const curlInfoArgs = command.args.filter(a => a !== "-q");
    if (name === "curl" && command.trustedExecutable === true && !command.executableInsideWorkspace &&
        curlInfoArgs.length === 1 && ["--version", "--help", "-h"].includes(curlInfoArgs[0]!)) {
      return decision("allow", "safe_inspect", "Reads local curl version/help without networking", "allow.curl_info");
    }
    const network = networkEnabled ? inspectNetworkOperation(command) : undefined;
    if (network) {
      if (mode === "plan" && network.effect !== "read") return decision("deny", "external_write", "Plan permits only proven read-only network commands", "mode.plan_network");
      return decision("ask", network.effect === "read" ? "safe_inspect" : "external_write", network.description, `ask.network_${network.effect}`);
    }

    if (SCRIPT_HOSTS.has(name)) {
      return modeDecision(mode, "destructive", "Script Host effects require explicit approval", "ask.script_host");
    }
    if (ASYNC_WORKAROUND_PROGRAMS.has(name)) {
      return decision(
        "deny",
        "destructive",
        name === "nohup"
          ? "Detached nohup processes are disabled; run the real executable directly"
          : `${name} polling is disabled; run the real executable directly`,
        "deny.async_workaround",
        "Use one synchronous run_command call with structured program and args; set timeoutMs when needed.",
      );
    }
    const shell = inspectExplicitShellInvocation(name, command.args);
    if (shell && !shell.valid) {
      return decision(
        "deny",
        "shell_exec",
        shell.reason ?? "Invalid explicit shell invocation",
        "deny.shell_protocol",
      );
    }
    if (shell) {
      const highRisk = shellCommandWords(command.executablePath, command.args).some(words => {
        const name = path.basename(words[0] ?? "").replace(/\.(exe|cmd|bat)$/iu, "").toLowerCase();
        return SYSTEM_PROGRAMS.has(name) || DESTRUCTIVE_PROGRAMS.has(name) ||
          LOCAL_FILE_PROGRAMS.has(name) && highRiskFileArguments(words.slice(1), command.cwdAbsolute);
      });
      return modeDecision(
        mode,
        highRisk ? "destructive" : "shell_exec",
        highRisk ? "Shell contains explicitly high-risk local effects" : "Executes explicit project shell code inside the workspace OS sandbox",
        highRisk ? "ask.shell_high_risk" : "ask.shell_exec",
      );
    }
    if (SYSTEM_PROGRAMS.has(name)) {
      return modeDecision(mode, "system_write", "System-level effects require explicit approval; sandbox boundaries remain enforced", "ask.system");
    }
    if (EXTERNAL_PROGRAMS.has(name)) {
      return decision("deny", "external_write", "Direct network and remote commands are disabled", "deny.external");
    }
    if (DESTRUCTIVE_PROGRAMS.has(name)) {
      return modeDecision(mode, "destructive", "High-risk process or filesystem effects require explicit approval", "ask.destructive");
    }
    if (LOCAL_FILE_PROGRAMS.has(name)) {
      const highRisk = highRiskFileArguments(command.args, command.cwdAbsolute);
      return modeDecision(mode, highRisk ? "destructive" : "workspace_exec",
        highRisk ? "Recursive or uncertain file effects require explicit approval" : "Changes explicitly named workspace-local files inside the sandbox",
        highRisk ? "ask.file_scope" : "ask.local_file");
    }
    if (name === "npx") {
      return decision("deny", "external_write", "npx may download and execute an unpinned package", "deny.npx");
    }
    if ((INTERPRETERS.has(name) || /^python\d+(?:\.\d+)*$/u.test(name)) && lowerArgs.some((argument) => INTERPRETER_EVAL_FLAGS.has(argument))) {
      return modeDecision(mode, "workspace_exec", "Executes inline interpreter code inside the OS sandbox", "ask.interpreter_eval");
    }

    // Names never grant a read-only exemption to repository code. Permanent
    // request denials above still apply even when a local shim has that name.
    if (command.executableInsideWorkspace) {
      return modeDecision(mode, "workspace_exec", "Executes untrusted project code", "ask.workspace_executable");
    }
    if ((name === "git" || name === "npm" || name === "node") && command.trustedExecutable !== true) {
      return modeDecision(mode, "workspace_exec", "Executable is not from a trusted tool location", "ask.untrusted_executable");
    }
    if (name === "git") return this.classifyGit(command, mode);
    if (name === "npm") return this.classifyNpm(input, command, mode);

    if (name === "node" && command.args.length === 1 && ["-v", "--version"].includes(lowerArgs[0] ?? "")) {
      return decision("allow", "safe_inspect", "Reads the installed Node.js version", "allow.node_version");
    }

    if (INTERPRETERS.has(name) || /^python\d+(?:\.\d+)*$/u.test(name) || command.executableInsideWorkspace) {
      return modeDecision(
        mode,
        "workspace_exec",
        "Executes workspace or interpreter code inside the workspace OS sandbox",
        "ask.workspace_exec",
      );
    }

    return modeDecision(
      mode,
      LOCAL_WORK_PROGRAMS.has(name) ? "workspace_exec" : "destructive",
      "Command is not a recognized read-only recipe and may have side effects",
      "ask.unknown_command",
    );
  }

  approvalFingerprint(command: ResolvedCommand, policy: CommandPolicyDecision): string {
    return sha256(
      JSON.stringify({
        executablePath: command.executablePath,
        args: command.args,
        cwd: command.cwdAbsolute,
        environmentKeys: command.environmentKeys,
        approvalMaterialHash: command.approvalMaterialHash,
        capability: policy.capability,
      }),
    );
  }

  private classifyGit(command: ResolvedCommand, mode: AgentMode): CommandPolicyDecision {
    if (command.args.some((argument) =>
      argument.startsWith("-C") ||
      argument.startsWith("--git-dir") ||
      argument.startsWith("--work-tree") ||
      argument.startsWith("-c") ||
      argument.startsWith("--exec-path") || argument === "--paginate" || argument === "-p" ||
      argument.startsWith("--config-env"),
    )) {
      return decision("deny", "destructive", "Git path/config overrides can escape command policy", "deny.git_override");
    }
    if (command.args.length === 1 && command.args[0] === "--version") {
      return decision("allow", "safe_inspect", "Reads the installed Git version", "allow.git_version");
    }

    const subcommand = firstNonFlag(command.args);
    if (!subcommand) return decision("deny", "destructive", "Git subcommand is required", "deny.git_missing");
    if (GIT_EXTERNAL.has(subcommand)) {
      return decision("deny", "external_write", `git ${subcommand} writes to an external system`, "deny.git_external");
    }
    if (GIT_DESTRUCTIVE.has(subcommand) || ["pull", "fetch", "clone"].includes(subcommand)) {
      return decision("deny", "destructive", `git ${subcommand} is outside the MVP command scope`, "deny.git_mutation");
    }
    if (GIT_SAFE_READ.has(subcommand)) {
      if (subcommand === "branch" && command.args.slice(command.args.indexOf("branch") + 1)
        .some((argument) => !["--list", "--all", "-a", "--remotes", "-r", "--show-current", "--no-color"].includes(argument))) {
        return decision("deny", "destructive", "Only explicit branch listing is read-only", "deny.git_branch_mutation");
      }
      if (command.args.some((argument) =>
        argument.startsWith("--output") || argument === "--ext-diff" || argument === "--textconv",
      )) {
        return decision("deny", "destructive", "Git external diff/output options are disabled", "deny.git_output");
      }
      return decision("allow", "safe_inspect", `git ${subcommand} is an approved read-only recipe`, "allow.git_read");
    }
    return modeDecision(mode, "workspace_exec", `git ${subcommand} is not a safe inspection recipe`, "ask.git_unknown");
  }

  private classifyNpm(
    input: RunCommandInput,
    command: ResolvedCommand,
    mode: AgentMode,
  ): CommandPolicyDecision {
    const lowerArgs = command.args.map((argument) => argument.toLowerCase());
    if (lowerArgs.some((argument) =>
      argument === "-g" ||
      argument === "--global" ||
      argument === "--location=global" ||
      argument.startsWith("--prefix"),
    )) {
      return decision("deny", "system_write", "Global or redirected npm operations are disabled", "deny.npm_global");
    }
    if (lowerArgs.includes("exec") || lowerArgs.includes("x")) {
      return decision("deny", "external_write", "npm exec may download and execute packages", "deny.npm_exec");
    }
    if (command.args.length === 1 && ["-v", "--version"].includes(lowerArgs[0] ?? "")) {
      return decision("allow", "safe_inspect", "Reads the installed npm version", "allow.npm_version");
    }

    const npmSubcommand = firstNonFlag(command.args);
    if (npmSubcommand && NPM_REMOTE_OR_SYSTEM.has(npmSubcommand)) {
      return decision("deny", "external_write", `npm ${npmSubcommand} modifies an external service`, "deny.npm_remote");
    }

    const install = analyzeNpmInstall(command.args);
    if (install.isInstall) {
      if (!install.valid) {
        return decision(
          "deny",
          "registry_install",
          install.reason ?? "npm install request is not a strict local install",
          "deny.npm_install_invalid",
          "Use an exact registry version and local install flags; lifecycle scripts stay disabled.",
        );
      }
      if (mode === "plan") {
        return decision("deny", "registry_install", "Dependency installation is disabled in plan mode", "mode.plan_install");
      }
      return decision(
        "allow",
        "registry_install",
        install.packageSpecs.length > 0
          ? "Strict project-local npm install with exact direct package versions and lifecycle scripts disabled"
          : "Project-local npm install from the existing manifest/lockfile with lifecycle scripts disabled",
        "allow.npm_local_install",
      );
    }

    if (npmSubcommand && ["run", "run-script", "test", "start"].includes(npmSubcommand)) {
      return modeDecision(
        mode,
        "workspace_exec",
        `npm ${npmSubcommand} executes project-defined code inside the workspace OS sandbox`,
        "ask.npm_script",
      );
    }

    return modeDecision(
      mode,
      "workspace_exec",
      `npm ${npmSubcommand ?? input.intent} is not a safe inspection recipe`,
      "ask.npm_other",
    );
  }
}
