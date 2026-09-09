import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandExecutionBackend, PreparedCommand, SandboxExecutionRequest } from "./types.js";
import { benchmarkResultSchema } from "./benchmark-result.js";

export const BENCHMARK_BRIDGE_ROOT = "/opt/easy-code-command-bridge";
export async function inspectBenchmarkBridge(): Promise<string> {
  const binding = JSON.parse(await readFile(path.join(BENCHMARK_BRIDGE_ROOT, "binding.json"), "utf8"));
  if (process.platform !== "linux" || !binding || binding.version !== 1 || !/^[a-f0-9]{64}$/u.test(binding.workerId) ||
      binding.network !== "none" || await realpath(BENCHMARK_BRIDGE_ROOT) !== BENCHMARK_BRIDGE_ROOT) throw new Error("Trusted Benchmark controller bridge is unavailable");
  return "Benchmark bridge ready: container full access; external networking disabled; host-owned Docker supervisor.";
}
/** The bridge is mounted into the trusted controller ONLY. The offline worker
 * has no Docker socket, bridge files, API keys or Runtime data mounts. */
export class BenchmarkContainerBackend implements CommandExecutionBackend {
  private readonly reviewFailed = new AbortController();
  constructor(private readonly review?: { id: string; actor: "author" | "reviewer"; root: string }) {}
  private static slot: Promise<void> = Promise.resolve();
  private static failed = new AbortController();
  quarantine(reason: string): void { (this.review ? this.reviewFailed : BenchmarkContainerBackend.failed).abort(new Error(reason)); }
  private static async acquire(signal?: AbortSignal): Promise<() => void> {
    signal = signal ? AbortSignal.any([signal, this.failed.signal]) : this.failed.signal;
    const previous = this.slot;
    let release!: () => void;
    this.slot = new Promise<void>(resolve => { release = resolve; });
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([previous, new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Benchmark command canceled while queued"));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      })]);
      if (signal?.aborted) throw new Error("Benchmark command canceled while queued");
      return release;
    } catch (error) { void previous.then(release); throw error; }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }
  describe() { return { backend: "benchmark-container" as const, enforced: true, filesystem: "container" as const, network: "denied" as const }; }
  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    // Command timeout starts only after this slot is acquired. All child
    // backends in the controller share it; restarting a worker never kills
    // another child's active command. Parent-side cancellation remains live.
    const signal = request.context.signal ? AbortSignal.any([request.context.signal, this.reviewFailed.signal]) : this.reviewFailed.signal;
    const release = await BenchmarkContainerBackend.acquire(signal);
    let dir: string | undefined;
    try {
    await inspectBenchmarkBridge();
    if (this.review && (!/^review_[a-f0-9-]{36}$/u.test(this.review.id) ||
        this.review.root !== `/tmp/easy-code-${this.review.id}/${this.review.actor}` || await realpath(this.review.root) !== this.review.root))
      throw new Error("Invalid benchmark review copy binding");
    await mkdir(path.join(BENCHMARK_BRIDGE_ROOT, "commands"), { recursive: true });
    dir = await mkdtemp(path.join(BENCHMARK_BRIDGE_ROOT, "commands", "request-"));
    await writeFile(path.join(dir, "request.pending"), JSON.stringify({ version: 1, commandId: request.commandId,
      program: request.command.executablePath, args: request.command.args, cwd: request.command.cwdAbsolute,
      environment: request.command.environment, timeoutMs: 1200000, ...(this.review ? { review: this.review } : {}) }), { flag: "wx", mode: 0o600 });
    await rename(path.join(dir, "request.pending"), path.join(dir, "request.json"));
    const metadata: import("./types.js").SandboxExecutionMetadata = { ...this.describe(), ...(this.review ? { reviewEnvironmentUnchanged: false } : {}) };
    return { executablePath: process.execPath,
      args: [fileURLToPath(new URL("benchmark-worker.js", import.meta.url)), dir, request.commandId],
      cwdAbsolute: "/", environment: { PATH: "/usr/bin:/bin" }, metadata, controlPipe: true,
      cooperativeTermination: true,
      cleanup: async () => { try {
        const result = benchmarkResultSchema.parse(JSON.parse(await readFile(path.join(dir!, "result.json"), "utf8")));
        if (result.cleanup !== "confirmed" || !result.workerRestored) throw new Error("Benchmark worker cleanup/restoration was not confirmed");
        if (this.review) {
          metadata.reviewEnvironmentUnchanged = result.reviewEnvironmentUnchanged === true;
        }
        await rm(dir!, { recursive: true, force: true });
      } finally { release(); } } };
    } catch (error) {
      try { if (dir) await rm(dir, { recursive: true, force: true }); }
      finally { release(); }
      throw error;
    }
  }
}
