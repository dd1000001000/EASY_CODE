import { createCommandNetworkGate, type CommandNetworkGateOptions } from "../../command/network-gate.js";
import type { SandboxExecutionRequest } from "../types.js";
import type { NativeBackendPlatform, NativeBackendPlatformOptions } from "./backend-types.js";

export class MacNativeBackend implements NativeBackendPlatform {
  readonly startupTimeoutMs: number;
  readonly cooperativeTermination = true;
  readonly sandboxManagedTimeout = false;
  constructor(options: NativeBackendPlatformOptions) { this.startupTimeoutMs = options.limits.sandboxStartupPosixMs; }
  createNetworkGate(options: CommandNetworkGateOptions) { return createCommandNetworkGate(options); }
  async authorizedProxyPorts(existing?: readonly number[]) { return existing; }
  async recoverCleanup(_root: string, _request: SandboxExecutionRequest, _ports: readonly number[] | undefined, error: unknown): Promise<void> { throw error; }
}
