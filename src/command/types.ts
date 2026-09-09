import type { AgentMode, ApprovalRequest } from "../core/types.js";
import type { SandboxExecutionMetadata } from "../sandbox/types.js";
import type { WorkspaceDelta } from "../workspace/snapshot.js";
import type { CommandTimeoutBudget } from "./timeout.js";
import type { CommandRequestMetadata } from "./normalize-request.js";
import type { CommandValidation } from "./verification.js";

export const COMMAND_INTENTS = [
  "inspect",
  "build",
  "test",
  "verify",
  "run",
  "install",
] as const;

export type CommandIntent = typeof COMMAND_INTENTS[number];

export const VERIFICATION_KINDS = [
  "unit_test",
  "integration_test",
  "build",
  "typecheck",
  "lint",
  "format_check",
  "smoke_test",
  "benchmark",
  "custom",
] as const;

export type VerificationKind = typeof VERIFICATION_KINDS[number];

/**
 * Return the durable verification category for a validated command request.
 * Legacy test/build calls remain verification commands without requiring the
 * newer field; generic legacy tests use custom because Runtime cannot safely
 * infer whether they are unit, integration, smoke, or benchmark checks.
 */
export function commandVerificationKind(
  input: Pick<RunCommandInput, "intent" | "verificationKind">,
): VerificationKind | undefined {
  if (!["verify", "test", "build"].includes(input.intent)) return undefined;
  if (input.verificationKind) return input.verificationKind;
  if (input.intent === "build") return "build";
  if (input.intent === "test" || input.intent === "verify") return "custom";
  return undefined;
}

export interface RunCommandInput {
  program: string;
  args?: string[];
  cwd?: string;
  intent: CommandIntent;
  /** Optional metadata; Runtime defaults verify/test to custom and build to build. */
  verificationKind?: VerificationKind;
  /** Runtime-issued; not accepted as a model tool argument. */
  normalizationWarnings?: string[];
  timeoutMs?: number;
  reason?: string;
  /** Explicit per-command escalation, reviewed together with the exact argv. */
  executionScope?: "workspace" | "host";
}

/** Canonical flat input for a bounded background-command status poll. */
export interface PollCommandInput {
  commandId: string;
  /** Bounded long-poll duration. This replaces shell-level sleep/poll loops. */
  waitMs?: number;
}

/** Canonical flat input for background-command cancellation. */
export interface CancelCommandInput {
  commandId: string;
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
  /** Issued by Resolver, never by model input. */
  trustedExecutable?: boolean;
  environment: NodeJS.ProcessEnv;
  environmentKeys: string[];
  /** Hash of npm script/package/.npmrc material bound into exact approval. */
  approvalMaterialHash?: string;
  /** Canonical executable content identity for reusable network grants. */
  executableHash?: string;
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

/** Stable model-facing failure category independent of platform error wording. */
export type CommandFailureKind =
  | "parameter"
  | "policy"
  | "approval"
  | "sandbox"
  | "exit"
  | "timeout"
  | "runtime";

export interface CommandFailure {
  executionState?: "not_started" | "unknown" | "started" | "exited";
  kind: CommandFailureKind;
  /** Stable, concise reason suitable for recovery decisions and tests. */
  code: string;
  message: string;
  /** Whether the requested target process crossed the confirmed start boundary. */
  processStarted: boolean;
  retryable: boolean;
}

export interface RunCommandOutput {
  validation?: CommandValidation;
  requestMetadata?: CommandRequestMetadata;
  lifecycle?: {
    outcome?: "exited" | "timed_out" | "canceled" | "output_limit" | "spawn_failed" | "unknown";
    execution: "not_started" | "unknown" | "started" | "exited";
    cleanup: "not_required" | "confirmed" | "failed" | "unconfirmed";
    cleanupError?: string;
  };
  commandId: string;
  status:
    | "exited"
    | "timed_out"
    | "canceled"
    | "spawn_failed"
    | "policy_denied"
    | "sandbox_unavailable";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: OutputDigest;
  stderr: OutputDigest;
  workspaceDelta: WorkspaceDeltaSummary;
  policyDecision: CommandPolicyDecision;
  sandbox: SandboxExecutionMetadata;
  /** Present once Runtime can classify and apply the invocation's command-phase budget. */
  timeout?: CommandTimeoutBudget;
  sandboxFailure?: {
    phase: "prepare" | "initialization" | "execution";
    retryable: boolean;
  };
  /** Present for every unsuccessful terminal execution result. */
  failure?: CommandFailure;
  executed: {
    program: string;
    args: string[];
    cwd: string;
    environmentKeys: string[];
  };
}

/** A command whose policy/approval and sandbox startup have completed successfully. */
export interface RunningCommandOutput {
  requestMetadata?: CommandRequestMetadata;
  commandId: string;
  status: "running";
  exitCode: null;
  signal: null;
  durationMs: number;
  stdout: OutputDigest;
  stderr: OutputDigest;
  /** Workspace changes are authoritative only after the command reaches a terminal state. */
  workspaceDelta: WorkspaceDeltaSummary;
  policyDecision: CommandPolicyDecision;
  sandbox: SandboxExecutionMetadata;
  timeout: CommandTimeoutBudget;
  executed: RunCommandOutput["executed"];
}

export type CommandExecutionOutput = RunCommandOutput | RunningCommandOutput;

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
