import type {
  CommandExecutionBackend,
  PreparedCommand,
  SandboxExecutionMetadata,
  SandboxExecutionRequest,
} from "./types.js";
import { executionCapabilities } from "./capabilities.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";

const HOST_METADATA: SandboxExecutionMetadata = {
  backend: "host-unrestricted",
  enforced: false,
  filesystem: "host",
  network: "host",
  capabilities: executionCapabilities("host-unrestricted"),
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
    if (process.platform === "win32") {
      const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-host-command-"));
      const payloadPath = path.join(root, "payload.json");
      const limits = request.context.limits ?? DEFAULT_RUNTIME_LIMITS;
      try {
        await writeFile(payloadPath, JSON.stringify({ commandId: request.commandId,
          startupMs: limits.sandboxStartupWindowsMs, cleanupMs: limits.sandboxCleanupTimeoutMs,
          target: command }), { mode: 0o600 });
      } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
      return { executablePath: process.execPath, args: [fileURLToPath(new URL("../command/host-worker.js", import.meta.url)), payloadPath],
        cwdAbsolute: command.cwdAbsolute, environment: { ...command.environment }, controlPipe: true,
        metadata: { ...HOST_METADATA }, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
    }
    return { executablePath: command.executablePath, args: [...command.args], cwdAbsolute: command.cwdAbsolute,
      environment: { ...command.environment }, metadata: { ...HOST_METADATA }, cleanup: async () => undefined };
  }
}
