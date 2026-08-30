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

/**
 * Explicit danger-mode backend. It is intentionally separate from the
 * Anthropic sandbox backend so a routing mistake fails instead of silently
 * weakening Manual or Auto approval modes.
 */
export class UnrestrictedHostBackend implements CommandExecutionBackend {
  describe(request?: SandboxExecutionRequest): SandboxExecutionMetadata {
    // Metadata is safe to produce for denied/resolution-failure audit records;
    // authorization is enforced only at prepare(), immediately before spawn.
    void request;
    return { ...HOST_METADATA };
  }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    this.assertAuthorized(request);
    return {
      executablePath: request.command.executablePath,
      args: [...request.command.args],
      cwdAbsolute: request.command.cwdAbsolute,
      environment: { ...request.command.environment },
      metadata: { ...HOST_METADATA },
      cleanup: async () => undefined,
    };
  }

  private assertAuthorized(request: SandboxExecutionRequest): void {
    if (
      request.context.commandExecutionMode !== "unrestricted" ||
      !(request.context.isUnrestrictedHostAccessActive?.() ?? true)
    ) {
      throw new Error("Unrestricted host backend requires active user-confirmed dangerous mode");
    }
  }
}
