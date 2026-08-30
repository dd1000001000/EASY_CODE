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
  filesystem: "workspace-write" | "host";
  network: "denied" | "registry-only" | "allowed" | "host";
}

export interface PreparedCommand {
  executablePath: string;
  args: string[];
  cwdAbsolute: string;
  environment: NodeJS.ProcessEnv;
  metadata: SandboxExecutionMetadata;
  cleanup(): Promise<void>;
}

export interface SandboxExecutionRequest {
  commandId: string;
  command: ResolvedCommand;
  policyDecision: CommandPolicyDecision;
  context: ToolContext;
  commandPreview: string;
}

export interface CommandExecutionBackend {
  describe(request?: SandboxExecutionRequest): SandboxExecutionMetadata;
  prepare(request: SandboxExecutionRequest): Promise<PreparedCommand>;
}

export interface SandboxWorkerPayload {
  version: 1;
  commandId: string;
  commandPreview: string;
  workspaceRoot: string;
  scratchRoot: string;
  runtimeRoot: string;
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
  };
}

export type SandboxWorkerControl =
  | { type: "ready"; backend: SandboxBackendName }
  | { type: "sandbox_error"; message: string }
  | { type: "target_spawn_error"; message: string };
