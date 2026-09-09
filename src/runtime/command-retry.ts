import type { ToolExecutionResult } from "../core/types.js";
import { sha256 } from "../utils/hash.js";

/** Permits a model-authored retry only when startup was proven not to execute. */
export class CommandRetryTracker {
  private failures = new Map<string, { count: number; execution: "not_started" | "unknown" }>();
  private handles = new Map<string, string>();
  private terminalHandles = new Set<string>();
  constructor(private readonly startupRetries: number) {}
  private key(tool: string, input: any): string | undefined {
    if (tool === "poll_command") return this.handles.get(input?.commandId);
    if (!["run_command", "start_command"].includes(tool)) return undefined;
    return sha256(JSON.stringify([input?.program, input?.args ?? [], input?.cwd ?? ".", input?.executionScope ?? "workspace", input?.env ?? {}]));
  }
  before(tool: string, input: unknown): ToolExecutionResult | undefined {
    const key = this.key(tool, input);
    const previous = key ? this.failures.get(key) : undefined;
    if (tool === "poll_command" || !previous || previous.count <= this.startupRetries) return;
    return this.unavailable(previous.execution);
  }
  after(tool: string, input: unknown, result: ToolExecutionResult): ToolExecutionResult {
    const data = result.data as { commandId?: string; status?: string; lifecycle?: { execution?: string };
      failure?: { executionState?: string }; sandboxFailure?: { retryable?: boolean } } | undefined;
    const key = this.key(tool, input);
    if (!key) return result;
    if (data?.commandId && tool !== "poll_command") this.handles.set(data.commandId, key);
    if (data?.status !== "sandbox_unavailable") return result;
    // Re-observing one terminal handle is not another startup attempt.
    if (data.commandId && this.terminalHandles.has(data.commandId)) return result;
    if (data.commandId) this.terminalHandles.add(data.commandId);
    const execution = data.lifecycle?.execution ?? data.failure?.executionState;
    const provenNotStarted = execution === "not_started";
    const count = data.sandboxFailure?.retryable && provenNotStarted ? (this.failures.get(key)?.count ?? 0) + 1 : this.startupRetries + 1;
    const state = provenNotStarted ? "not_started" : "unknown";
    this.failures.set(key, { count, execution: state });
    return count <= this.startupRetries ? result : { ...result, ...this.unavailable(state),
      data: { ...data, sandboxFailure: { ...data.sandboxFailure, retryable: false } } };
  }
  private unavailable(execution: "not_started" | "unknown"): ToolExecutionResult {
    return { ok: false, summary: "Sandbox initialization failed; this command cannot be executed. Startup retry budget exhausted.",
      error: "command_sandbox_unavailable", failure: { version: 1, kind: "execution", code: "command_sandbox_unavailable",
        execution, recovery: "none", issues: [],
        instruction: "Do not resend this command. Report the sandbox failure; other independent work may continue. No command effects were replayed." } };
  }
}
