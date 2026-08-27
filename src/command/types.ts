import type { AgentMode, ApprovalRequest } from "../core/types.js";
import type { WorkspaceDelta } from "../workspace/snapshot.js";

export type CommandIntent = "inspect" | "build" | "test" | "run" | "install";

export interface RunCommandInput {
  program: string;
  args?: string[];
  cwd?: string;
  intent: CommandIntent;
  timeoutMs?: number;
  reason?: string;
}

export type CommandCapability =
  | "safe_inspect"
  | "workspace_exec"
  | "shell_exec"
  | "registry_install"
  | "system_write"
  | "external_write"
  | "destructive";

export interface ResolvedCommand {
  program: string;
  executablePath: string;
  args: string[];
  cwdAbsolute: string;
  cwdRelative: string;
  executableInsideWorkspace: boolean;
  environment: NodeJS.ProcessEnv;
  environmentKeys: string[];
  /** Hash of npm script/package/.npmrc material bound into exact approval. */
  approvalMaterialHash?: string;
}

export interface CommandPolicyDecision {
  id: string;
  effect: "allow" | "ask" | "deny";
  capability: CommandCapability;
  risk: ApprovalRequest["risk"];
  reason: string;
  matchedRule: string;
  recommendation?: string;
}

export interface OutputDigest {
  head: string;
  tail: string;
  text: string;
  totalBytes: number;
  truncated: boolean;
}

export interface WorkspaceDeltaSummary {
  created: string[];
  updated: string[];
  deleted: string[];
  truncated: boolean;
}

export interface RunCommandOutput {
  commandId: string;
  status: "exited" | "timed_out" | "canceled" | "spawn_failed" | "policy_denied";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: OutputDigest;
  stderr: OutputDigest;
  workspaceDelta: WorkspaceDeltaSummary;
  policyDecision: CommandPolicyDecision;
  executed: {
    program: string;
    args: string[];
    cwd: string;
    environmentKeys: string[];
  };
}

export interface CommandClassificationContext {
  mode: AgentMode;
}

export function summarizeWorkspaceDelta(delta: WorkspaceDelta): WorkspaceDeltaSummary {
  return {
    created: delta.created.map((entry) => entry.path),
    updated: delta.updated.map((entry) => entry.after.path),
    deleted: delta.deleted.map((entry) => entry.path),
    truncated: delta.truncated,
  };
}
