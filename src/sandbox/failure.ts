/** Machine-readable control-plane errors. Human messages are diagnostics only. */
export type SandboxFailureCode = "engine_unavailable" | "invalid_inventory" | "identity_conflict" |
  "environment_missing" | "environment_busy" | "cleanup_unknown" | "state_persistence" | "configuration_changed";

export class SandboxFailure extends Error {
  readonly cause?: unknown;
  constructor(readonly code: SandboxFailureCode, message: string,
    readonly retryableBeforeDispatch = false, options?: { cause?: unknown }) {
    super(message); this.name = "SandboxFailure"; this.cause = options?.cause;
  }
}

export interface SandboxCleanupResult {
  processes: "confirmed";
  /** Garbage collection does not change process-cleanup certainty. */
  pendingFiles?: string[];
}
