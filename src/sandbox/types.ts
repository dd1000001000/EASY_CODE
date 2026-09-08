import type { ToolContext } from "../core/types.js";
import type {
  CommandPolicyDecision,
  ResolvedCommand,
} from "../command/types.js";

export type SandboxBackendName =
  | "anthropic-srt-macos"
  | "anthropic-srt-linux"
  | "anthropic-srt-windows"
  | "host-unrestricted"
  | "host-test-only";

export interface SandboxExecutionMetadata {
  backend: SandboxBackendName;
  enforced: boolean;
  filesystem: "workspace-write" | "workspace-read" | "host";
  network: "denied" | "registry-only" | "allowed" | "host" | "brokered";
}

export interface PreparedCommand {
  executablePath: string;
  args: string[];
  cwdAbsolute: string;
  environment: NodeJS.ProcessEnv;
  metadata: SandboxExecutionMetadata;
  /** Private fd 3, not inherited by model-controlled target processes. */
  controlPipe?: boolean;
  cleanup(): Promise<void>;
}

export interface SandboxExecutionRequest {
  commandId: string;
  command: ResolvedCommand;
  policyDecision: CommandPolicyDecision;
  context: ToolContext;
  commandPreview: string;
  /** Runtime-issued per-command capability; never copied into target environment. */
  networkProxyURL?: string;
}

export interface CommandExecutionBackend {
  assertEnvironmentSafe?(): void;
  quarantine?(reason: string): void;
  describe(request?: SandboxExecutionRequest): SandboxExecutionMetadata;
  prepare(request: SandboxExecutionRequest): Promise<PreparedCommand>;
}

export interface SandboxWorkerPayload {
  version: 1;
  commandId: string;
  commandPreview: string;
  workspaceRoot: string;
  scratchRoot: string;
  /** Standalone ESM launcher staged inside this command's scratch root. */
  bridgePath: string;
  target: {
    executablePath: string;
    args: string[];
    cwdAbsolute: string;
    environment: NodeJS.ProcessEnv;
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
    allowGitConfig: boolean;
  };
  network: {
    allowedDomains: string[];
    proxyURL?: string;
  };
}

export type SandboxWorkerControl =
  | { type: "cleanup_requested" }
  | { type: "execution_dispatched" }
  | { type: "execution_exited"; exitCode: number }
  | { type: "cleanup_complete" }
  | { type: "cleanup_error"; message: string }
  | { type: "ready"; backend: SandboxBackendName }
  | {
      type: "stage";
      stage:
        | "worker_started"
        | "runtime_loaded"
        | "initialize_start"
        | "initialize_complete"
        | "wrap_start"
        | "wrap_complete";
    }
  | { type: "sandbox_error"; message: string }
  | { type: "target_spawn_error"; message: string };
