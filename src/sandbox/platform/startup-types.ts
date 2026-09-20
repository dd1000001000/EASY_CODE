import type { RuntimeLimits } from "../../config/runtime-limits.js";
import type { NativeAppServerClient } from "../app-server-client.js";
import type { SandboxReadiness, SandboxSetupResult } from "../startup.js";
import type { WindowsProxyPortLease } from "../windows-proxy-registry.js";

export interface NativeProxyState {
  lease: WindowsProxyPortLease;
  proxyURL: string;
  ports: readonly number[];
}

export type ReadinessResult = (
  status: SandboxReadiness["status"],
  details: string[],
  canSetup?: boolean,
) => SandboxReadiness;

export interface NativeStartupPlatform {
  readonly backendName: string;
  readonly startupTimeoutMs: number;
  readonly probeCommand: readonly string[];
  readonly successDetail: string;
  proxyState(): Promise<NativeProxyState | undefined>;
  checkReadiness(service: NativeAppServerClient, result: ReadinessResult): Promise<SandboxReadiness | undefined>;
  checkProbe(stdout: unknown, result: ReadinessResult): SandboxReadiness | undefined;
  probeSucceeded(proxy: NativeProxyState | undefined): Promise<void>;
  probeFailed(message: string, result: ReadinessResult): SandboxReadiness;
  inspect(unlocked: () => Promise<SandboxReadiness>, result: ReadinessResult): Promise<SandboxReadiness>;
  setup(readiness: SandboxReadiness, unlocked: () => Promise<SandboxReadiness>, result: ReadinessResult): Promise<SandboxSetupResult>;
}

export interface NativeStartupOptions {
  readonly limits: Readonly<RuntimeLimits>;
  readonly dataDir: string;
  readonly report: (message: string) => void;
}

export function startupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
