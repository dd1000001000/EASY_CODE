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

/** Only selected by Runtime after full-access activation or exact host approval. */
export class UnrestrictedHostBackend implements CommandExecutionBackend {
  describe(request?: SandboxExecutionRequest): SandboxExecutionMetadata {
    // Metadata is safe to produce for denied/resolution-failure audit records;
    // authorization is enforced only at prepare(), immediately before spawn.
    void request;
    return { ...HOST_METADATA };
  }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    if (!request.hostExecutionAuthorized || request.context.signal?.aborted || request.policyDecision.effect !== "allow") throw new Error("Host execution is not authorized");
    const command = request.command;
    return { executablePath: command.executablePath, args: [...command.args], cwdAbsolute: command.cwdAbsolute,
      environment: { ...command.environment }, metadata: { ...HOST_METADATA }, cleanup: async () => undefined };
  }
}
