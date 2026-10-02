import path from "node:path";
import { sha256 } from "../utils/hash.js";
import { createId } from "../utils/ids.js";
import { inspectNetworkOperation } from "./network-policy.js";
import { explicitShellKind } from "./shell.js";
import type { CommandPolicyDecision, ResolvedCommand, RunCommandInput } from "./types.js";

const PACKAGE_INSTALL_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  npm: ["install", "i", "add", "ci"],
  pnpm: ["install", "i", "add"],
  yarn: ["install", "add"],
  bun: ["install", "i", "add"],
  pip: ["install"],
  pip3: ["install"],
  uv: ["add", "sync"],
  poetry: ["install", "add"],
  bundle: ["install"],
  composer: ["install", "require"],
};

/** Dependency installation by a package manager; it only selects the longer install timeout. */
function packageInstall(name: string, args: readonly string[]): boolean {
  if (/^python(?:\d+(?:\.\d+)*)?$/u.test(name) && args[0] === "-m" && args[1] === "pip") {
    return args[2] === "install";
  }
  if (name === "uv" && args[0] === "pip") return args[1] === "install";
  // A bare `yarn` installs the project's dependencies.
  if (name === "yarn" && args.length === 0) return true;
  const sub = args.find((argument) => !argument.startsWith("-"));
  return Boolean(sub && PACKAGE_INSTALL_COMMANDS[name]?.includes(sub));
}

/** Risk annotations, not permission rules. Every new command is authorized by
 * the approval service; actual boundaries belong to the execution backend. */
export class CommandPolicy {
  classify(input: RunCommandInput, command: ResolvedCommand): CommandPolicyDecision {
    const name = path
      .basename(command.executablePath)
      .replace(/\.(exe|cmd|bat)$/iu, "")
      .toLowerCase();
    const network = inspectNetworkOperation(command);
    let capability: CommandPolicyDecision["capability"] = "workspace_exec";
    let risk: CommandPolicyDecision["risk"] = "workspace";
    if (["sudo", "su", "runas", "apt", "apt-get", "brew", "winget", "reg", "systemctl"].includes(name)) {
      capability = "system_write";
      risk = "system";
    } else if (["rm", "del", "rmdir", "remove-item", "mkfs", "dd", "shutdown", "kill", "pkill"].includes(name)) {
      capability = "destructive";
      risk = "destructive";
    } else if (
      packageInstall(name, command.args) ||
      (input.intent === "install" && (!network || network.effect === "download"))
    ) {
      capability = "registry_install";
      risk = "install";
    } else if (network) {
      capability = "external_write";
      risk = "external";
    } else if (explicitShellKind(name)) {
      // By resolved executable: /bin/sh is commonly a link to dash.
      capability = "shell_exec";
    } else if (
      !command.executableInsideWorkspace &&
      command.trustedExecutable &&
      (["ls", "pwd", "rg", "cat", "head", "tail"].includes(name) ||
        (name === "git" && ["status", "diff", "log", "show"].includes(command.args[0] ?? "")))
    ) {
      capability = "safe_inspect";
      risk = "read";
    }
    return {
      id: createId("policy"),
      effect: "ask",
      capability,
      risk,
      reason: "Command requires authorization",
      matchedRule: "approval.required",
    };
  }
  approvalFingerprint(command: ResolvedCommand, policy: CommandPolicyDecision): string {
    return sha256(
      JSON.stringify({
        executablePath: command.executablePath,
        executableHash: command.executableHash,
        args: command.args,
        cwd: command.cwdAbsolute,
        environment: command.environment,
        approvalMaterialHash: command.approvalMaterialHash,
        capability: policy.capability,
      }),
    );
  }
}
