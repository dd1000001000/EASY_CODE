import path from "node:path";
import type { AgentMode } from "../core/types.js";
import { sha256 } from "../utils/hash.js";
import { createId } from "../utils/ids.js";
import { inspectNetworkOperation } from "./network-policy.js";
import type { CommandPolicyDecision, ResolvedCommand, RunCommandInput } from "./types.js";

/** Risk annotations, not permission rules. Every new command is authorized by
 * the approval service; actual boundaries belong to the execution backend. */
export class CommandPolicy {
  classify(_input: RunCommandInput, command: ResolvedCommand, _mode: AgentMode, _networkEnabled = true): CommandPolicyDecision {
    const name = path.basename(command.executablePath).replace(/\.(exe|cmd|bat)$/iu, "").toLowerCase();
    const network = inspectNetworkOperation(command);
    let capability: CommandPolicyDecision["capability"] = "workspace_exec";
    let risk: CommandPolicyDecision["risk"] = "workspace";
    if (network) { capability = "external_write"; risk = "external"; }
    else if (["sudo", "su", "runas", "apt", "apt-get", "brew", "winget", "reg", "systemctl"].includes(name)) { capability = "system_write"; risk = "system"; }
    else if (["rm", "del", "rmdir", "remove-item", "mkfs", "dd", "shutdown", "kill", "pkill"].includes(name)) { capability = "destructive"; risk = "destructive"; }
    else if (["sh", "bash", "cmd", "powershell", "pwsh"].includes(name)) capability = "shell_exec";
    else if (!command.executableInsideWorkspace && command.trustedExecutable &&
      (["ls", "pwd", "rg", "cat", "head", "tail"].includes(name) || name === "git" && ["status", "diff", "log", "show"].includes(command.args[0] ?? ""))) { capability = "safe_inspect"; risk = "read"; }
    return { id: createId("policy"), effect: "ask", capability, risk, reason: "Command requires authorization", matchedRule: "approval.required" };
  }
  approvalFingerprint(command: ResolvedCommand, policy: CommandPolicyDecision): string {
    return sha256(JSON.stringify({ executablePath: command.executablePath, executableHash: command.executableHash,
      args: command.args, cwd: command.cwdAbsolute, environment: command.environment,
      approvalMaterialHash: command.approvalMaterialHash, capability: policy.capability }));
  }
}
