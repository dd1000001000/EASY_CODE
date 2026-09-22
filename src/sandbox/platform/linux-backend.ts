import { createCommandNetworkGate, type CommandNetworkGateOptions } from "../../command/network-gate.js";
import type { SandboxExecutionRequest } from "../types.js";
import type { NativeBackendPlatform, NativeBackendPlatformOptions } from "./backend-types.js";

export class LinuxNativeBackend implements NativeBackendPlatform {
  readonly startupTimeoutMs: number;
  readonly cooperativeTermination = true;
  // command/exec owns the target process and enforces timeoutMs. Give it the
  // cleanup window to report the terminal state instead of killing the local
  // bridge at the same millisecond and losing cleanup certainty.
  readonly sandboxManagedTimeout = true;
  constructor(options: NativeBackendPlatformOptions) { this.startupTimeoutMs = options.limits.sandboxStartupPosixMs; }
  createNetworkGate(options: CommandNetworkGateOptions) { return createCommandNetworkGate(options); }
  async authorizedProxyPorts(existing?: readonly number[]) { return existing; }
  async recoverCleanup(_root: string, _request: SandboxExecutionRequest, _ports: readonly number[] | undefined, error: unknown): Promise<void> { throw error; }
}
