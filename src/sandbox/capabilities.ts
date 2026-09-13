import type { SandboxBackendName } from "./types.js";

export const EXECUTION_CAPABILITIES = ["temporary_files", "child_processes", "loopback_tcp", "unix_sockets", "shared_memory", "process_tree"] as const;
export type ExecutionCapability = typeof EXECUTION_CAPABILITIES[number];
export type CapabilityStatus = "supported" | "blocked" | "unknown";
export interface ExecutionCapabilities {
  /** A policy declaration is NOT a successful live probe of a language runtime. */
  source: "policy";
  isolation: "host" | "container";
  features: Record<ExecutionCapability, CapabilityStatus>;
  notes: string[];
}

export function executionCapabilities(backend: SandboxBackendName): ExecutionCapabilities {
  const features: ExecutionCapabilities["features"] = {
    temporary_files: "unknown", child_processes: "unknown", loopback_tcp: "unknown",
    unix_sockets: "unknown", shared_memory: "unknown", process_tree: "unknown",
  };
  if (backend === "host-unrestricted" || backend === "host-test-only") {
    return { source: "policy", isolation: "host", features, notes: ["Host permissions apply; no sandbox isolation or toolchain compatibility is claimed."] };
  }
  features.temporary_files = features.child_processes = "supported";
  if (backend === "benchmark-container" || backend === "podman") {
    features.loopback_tcp = features.unix_sockets = features.shared_memory = features.process_tree = "supported";
    return { source: "policy", isolation: "container", features, notes: [backend === "podman"
      ? "Linux task container; local IPC allowed, direct external networking disabled. HTTP(S) egress uses an approved per-command broker. Commands are serialized; start a service and its client in one command."
      : "Container-local IPC; external network disabled. Shared memory remains resource-limited."] };
  }
  return { source: "policy", isolation: "host", features, notes: ["Unknown execution capabilities; never infer them from an exit code."] };
}

export class SandboxCapabilityError extends Error {
  readonly code = "sandbox_capability_missing";
  constructor(readonly missing: ExecutionCapability[], report: ExecutionCapabilities) {
    super(`Required sandbox capabilities unavailable: ${missing.join(", ")}. Target was not started. ` + report.notes.join(" "));
    this.name = "SandboxCapabilityError";
  }
}

export function assertExecutionCapabilities(report: ExecutionCapabilities | undefined, required: readonly ExecutionCapability[]): void {
  if (!required.length) return;
  const effective = report ?? executionCapabilities("host-test-only");
  const missing = required.filter(key => effective.features[key] !== "supported");
  if (missing.length) throw new SandboxCapabilityError(missing, effective);
}
