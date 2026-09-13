import type { ToolContext } from "../core/types.js";
import type {
  CommandPolicyDecision,
  ResolvedCommand,
} from "../command/types.js";

export type SandboxBackendName =
  | "podman"
  | "benchmark-container"
  | "host-unrestricted"
  | "host-test-only";

export interface SandboxExecutionMetadata {
  capabilities?: import("./capabilities.js").ExecutionCapabilities;
  /** Host-owned review worker attestation, not model-authored stdout. */
  reviewEnvironmentUnchanged?: boolean;
  backend: SandboxBackendName;
  enforced: boolean;
  filesystem: "host" | "container";
  network: "denied" | "host" | "brokered";
}

export interface PreparedCommand {
  executablePath: string;
  args: string[];
  cwdAbsolute: string;
  environment: NodeJS.ProcessEnv;
  metadata: SandboxExecutionMetadata;
  /** Private fd 3, not inherited by model-controlled target processes. */
  controlPipe?: boolean;
  /** Trusted POSIX worker handles SIGTERM before Runtime's hard deadline. */
  cooperativeTermination?: boolean;
  /** Host-owned container supervisor, independent of the local client process tree. */
  externalLifecycle?: boolean;
  cancel?(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface SandboxExecutionRequest {
  timeoutMs?: number;
  commandId: string;
  command: ResolvedCommand;
  policyDecision: CommandPolicyDecision;
  context: ToolContext;
  commandPreview: string;
  /** Runtime-issued per-command capability; never copied into target environment. */
  networkProxyURL?: string;
  /** Set only by Runtime after explicit host permission; never a tool field. */
  hostExecutionAuthorized?: boolean;
}

export interface CommandExecutionBackend {
  /** Host-relative metadata lookup only; undefined means the cwd is not a shared checkout. */
  workspaceRelativeCwd?(command: ResolvedCommand): string | undefined;
  /** Container paths must never be looked up or executed on the host. */
  resolveCommand?(input: import("../command/types.js").RunCommandInput, context: ToolContext): ResolvedCommand | Promise<ResolvedCommand>;
  approvalPrefix?(command: ResolvedCommand, context: ToolContext, network: boolean): string;
  assertEnvironmentSafe?(): void;
  quarantine?(reason: string): void;
  describe(request?: SandboxExecutionRequest): SandboxExecutionMetadata;
  prepare(request: SandboxExecutionRequest): Promise<PreparedCommand>;
}

export type SandboxWorkerControl =
  | { type: "cleanup_requested" }
  | { type: "execution_dispatched" }
  | { type: "execution_exited"; exitCode: number; outcome?: "exited" | "timed_out" | "canceled" | "output_limit" | "spawn_failed" | "unknown" }
  | { type: "cleanup_complete" }
  | { type: "cleanup_error"; message: string }
  | { type: "ready"; backend: SandboxBackendName }
  | {
      type: "stage";
      stage:
        | "worker_started"
        | "relay_start"
        | "dispatch_start"
        | "cleanup_start";
    }
  | { type: "sandbox_error"; message: string }
  | { type: "target_spawn_error"; message: string };
