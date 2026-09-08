import type {
  CommandExecutionBackend,
  PreparedCommand,
  SandboxExecutionMetadata,
  SandboxExecutionRequest,
} from "./types.js";

const HOST_METADATA: SandboxExecutionMetadata = {
  backend: "host-unrestricted",
  enforced: false,
  filesystem: "host",
  network: "host",
};

/** Legacy import/audit compatibility only. No authorization enables host execution. */
export class UnrestrictedHostBackend implements CommandExecutionBackend {
  describe(request?: SandboxExecutionRequest): SandboxExecutionMetadata {
    // Metadata is safe to produce for denied/resolution-failure audit records;
    // authorization is enforced only at prepare(), immediately before spawn.
    void request;
    return { ...HOST_METADATA };
  }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    void request;
    throw new Error("Unrestricted host execution was removed: model commands require OS isolation and Runtime-mediated networking");
  }
}
