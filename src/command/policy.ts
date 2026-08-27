import path from "node:path";
import type { AgentMode } from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import { createId } from "../utils/ids.js";
import { analyzeNpmInstall } from "./npm-installer.js";
import { inspectExplicitShellInvocation } from "./shell.js";
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
  "rm",
  "rmdir",
  "del",
  "erase",
  "unlink",
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
  "remove-item",
  "move-item",
]);

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
      : capability === "workspace_exec"
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
  // No OS sandbox is implemented in this module. Executing repository or
  // third-party code therefore requires an exact, one-shot approval.
  return decision("ask", capability, reason, rule);
}

export class CommandPolicy {
  classify(input: RunCommandInput, command: ResolvedCommand, mode: AgentMode): CommandPolicyDecision {
    const name = executableName(command);
    const lowerArgs = command.args.map((argument) => argument.toLowerCase());

    if (SCRIPT_HOSTS.has(name)) {
      return decision("deny", "destructive", "Windows Script Host execution is disabled", "deny.script_host");
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
      return modeDecision(
        mode,
        "shell_exec",
        "Executes an explicit shell command as the current OS user without an OS sandbox",
        "ask.shell_exec",
      );
    }
    if (SYSTEM_PROGRAMS.has(name)) {
      return decision("deny", "system_write", "System-level package and configuration commands are disabled", "deny.system");
    }
    if (EXTERNAL_PROGRAMS.has(name)) {
      return decision("deny", "external_write", "Direct network and remote commands are disabled", "deny.external");
    }
    if (DESTRUCTIVE_PROGRAMS.has(name)) {
      return decision("deny", "destructive", "Destructive process or filesystem commands are disabled", "deny.destructive");
    }
    if (name === "npx") {
      return decision("deny", "external_write", "npx may download and execute an unpinned package", "deny.npx");
    }
    if (INTERPRETERS.has(name) && lowerArgs.some((argument) => INTERPRETER_EVAL_FLAGS.has(argument))) {
      return decision("deny", "destructive", "Interpreter inline-code flags are disabled", "deny.interpreter_eval");
    }
    if (lowerArgs.some((argument) => ["&&", "||", ";", "|", ">", ">>", "<", "&"].includes(argument))) {
      return decision("deny", "destructive", "Shell operators are not valid structured command arguments", "deny.shell_operator");
    }

    if (name === "git") return this.classifyGit(command, mode);
    if (name === "npm") return this.classifyNpm(input, command, mode);

    if (name === "node" && command.args.length === 1 && ["-v", "--version"].includes(lowerArgs[0] ?? "")) {
      return decision("allow", "safe_inspect", "Reads the installed Node.js version", "allow.node_version");
    }

    if (INTERPRETERS.has(name) || command.executableInsideWorkspace) {
      return modeDecision(
        mode,
        "workspace_exec",
        "Executes workspace or interpreter code without an OS sandbox",
        "ask.workspace_exec",
      );
    }

    return modeDecision(
      mode,
      "workspace_exec",
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
      argument === "-C" ||
      argument.startsWith("--git-dir") ||
      argument.startsWith("--work-tree") ||
      argument === "-c" ||
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
        `npm ${npmSubcommand} executes project-defined code without an OS sandbox`,
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
