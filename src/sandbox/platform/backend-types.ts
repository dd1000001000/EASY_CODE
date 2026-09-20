import type { RuntimeLimits } from "../../config/runtime-limits.js";
import type { CommandNetworkGate, CommandNetworkGateOptions } from "../../command/network-gate.js";
import type { SandboxExecutionRequest } from "../types.js";

export interface NativeBackendPlatform {
  readonly startupTimeoutMs: number;
  readonly cooperativeTermination: boolean;
  readonly sandboxManagedTimeout: boolean;
  readonly windowsJobContainment?: boolean;
  createNetworkGate(options: CommandNetworkGateOptions): Promise<CommandNetworkGate>;
  authorizedProxyPorts(existing?: readonly number[]): Promise<readonly number[] | undefined>;
  recoverCleanup(root: string, request: SandboxExecutionRequest, proxyPorts: readonly number[] | undefined, originalError: unknown): Promise<void>;
}

export interface NativeBackendPlatformOptions {
  readonly limits: Readonly<RuntimeLimits>;
  readonly dataDir: string;
  readonly home: string;
  readonly workspaceRoot: string;
}
