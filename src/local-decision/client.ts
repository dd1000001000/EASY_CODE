import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ensurePrivateSocketDirectory, localModelEnvironment, LOCAL_DECISION_PROTOCOL, MAX_IPC_LINE_BYTES,
  sharedLayaEndpoint, type SharedLayaOptions,
} from "./endpoint.js";

export type LocalDecisionTask = "route" | "delivery";
export interface LocalDecisionResult {
  task: LocalDecisionTask;
  input: string;
  inputTokens: number;
  truncated: boolean;
  optionOrder: string[];
  scores: Record<string, number>;
  decision: string;
  modelSha256: string;
  device: string;
}
interface PendingRequest {
  resolve: (result: LocalDecisionResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_WORKER = path.join(REPOSITORY_ROOT, "resources", "laya-decision", "worker.py");
const SERVICE_PATH = fileURLToPath(new URL("./service.js", import.meta.url));
const RETRYABLE_CONNECT_ERRORS = new Set(["ENOENT", "ECONNREFUSED", "EADDRNOTAVAIL", "ETIMEDOUT"]);
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

/** One IPC client per EASY CODE application; one model service per user and exact worker. */
export class LocalLayaClient {
  private readonly options: SharedLayaOptions;
  private readonly endpoint: ReturnType<typeof sharedLayaEndpoint>;
  private socket?: Socket;
  private buffer = "";
  private ready?: { modelSha256: string; device: string };
  private startup?: Promise<void>;
  private settleStartup?: (error?: Error) => void;
  private pending = new Map<string, PendingRequest>();
  private stopped = false;

  constructor(private readonly limits: { startupMs: number; decisionMs: number; idleMs: number },
    options: { dataDir: string; python: string; workerPath?: string }) {
    if (!path.isAbsolute(options.dataDir) || !path.isAbsolute(options.python) ||
        (options.workerPath && !path.isAbsolute(options.workerPath)))
      throw new Error("Local Laya service paths must be absolute");
    this.options = { dataDir: options.dataDir, python: options.python,
      workerPath: options.workerPath ?? DEFAULT_WORKER };
    this.endpoint = sharedLayaEndpoint(this.options);
  }

  async decide(task: LocalDecisionTask, input: string, signal?: AbortSignal): Promise<LocalDecisionResult> {
    if (this.stopped) throw new Error("Local Laya client is closed");
    if (signal?.aborted) throw asError(signal.reason ?? "Local decision canceled");
    await this.ensureReady(signal);
    if (signal?.aborted) throw asError(signal.reason ?? "Local decision canceled");
    if (!this.socket || !this.ready) throw new Error("Shared Laya service is unavailable");
    const id = randomUUID();
    return new Promise<LocalDecisionResult>((resolve, reject) => {
      const finishWithError = (error: Error) => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        if (signal && request.abort) signal.removeEventListener("abort", request.abort);
        try { this.socket?.write(JSON.stringify({ type: "cancel", id }) + "\n"); }
        catch { /* The local error still belongs only to this request. */ }
        reject(error);
      };
      const timer = setTimeout(() => finishWithError(new Error("Local Laya decision timed out")),
        this.limits.decisionMs);
      const abort = signal ? () => finishWithError(asError(signal.reason ?? "Local decision canceled")) : undefined;
      this.pending.set(id, { resolve, reject, timer, signal, abort });
      signal?.addEventListener("abort", abort!, { once: true });
      if (signal?.aborted) { abort?.(); return; }
      try { this.socket!.write(JSON.stringify({ type: "decide", id, task, input }) + "\n"); }
      catch (error) { finishWithError(asError(error)); }
    });
  }

  private async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.ready && this.socket && !this.socket.destroyed) return;
    this.startup ??= this.connectAndStart().finally(() => { this.startup = undefined; });
    if (!signal) { await this.startup; return; }
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(asError(signal.reason ?? "Local decision canceled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      this.startup!.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private async connectOnce(timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint.address);
      const timer = setTimeout(() => socket.destroy(Object.assign(new Error("Local IPC connection timed out"),
        { code: "ETIMEDOUT" })), timeoutMs);
      const fail = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); };
      socket.once("error", fail);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", fail);
        resolve(socket);
      });
    });
  }

  private async spawnService(): Promise<void> {
    if (!existsSync(SERVICE_PATH)) throw new Error("Bundled Laya service is missing; rebuild or reinstall EASY CODE");
    if (path.isAbsolute(this.options.python) && !existsSync(this.options.python))
      throw new Error("Managed Laya Python runtime is missing; rerun EASY CODE installation");
    if (this.endpoint.directory) await ensurePrivateSocketDirectory(this.endpoint.directory);
    const encoded = Buffer.from(JSON.stringify({ ...this.options, idleMs: this.limits.idleMs }), "utf8").toString("base64url");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [SERVICE_PATH, encoded], {
        cwd: REPOSITORY_ROOT, detached: true, windowsHide: true,
        stdio: "ignore", env: localModelEnvironment(),
      });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  }

  private async connectAndStart(): Promise<void> {
    const deadline = Date.now() + this.limits.startupMs;
    const bindDeadline = Math.min(deadline, Date.now() + 10_000);
    let launched = false;
    let lastError: Error = new Error("Shared Laya service did not start");
    while (!this.stopped && Date.now() < bindDeadline) {
      try {
        const socket = await this.connectOnce(Math.max(100, Math.min(1000, deadline - Date.now())));
        if (this.stopped) { socket.destroy(); throw new Error("Local Laya client is closed"); }
        this.socket = socket;
        this.buffer = "";
        socket.setEncoding("utf8");
        socket.setNoDelay(true);
        socket.on("data", chunk => this.receive(socket, String(chunk)));
        socket.once("close", () => this.transportFailed(socket, new Error("Shared Laya service disconnected")));
        socket.on("error", error => this.transportFailed(socket, error));
        return await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => this.transportFailed(socket,
            new Error("Shared Laya startup timed out")), Math.max(1, deadline - Date.now()));
          this.settleStartup = error => {
            clearTimeout(timer);
            this.settleStartup = undefined;
            if (error) reject(error); else resolve();
          };
          if (this.ready) this.settleStartup();
        });
      } catch (error) {
        lastError = asError(error);
        if (this.socket) throw lastError;
        if (!RETRYABLE_CONNECT_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) throw lastError;
        if (!launched) { await this.spawnService(); launched = true; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    throw this.stopped ? new Error("Local Laya client is closed") :
      new Error(`Shared Laya endpoint did not open: ${lastError.message}`);
  }

  private receive(socket: Socket, chunk: string): void {
    if (this.socket !== socket) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_IPC_LINE_BYTES) {
      this.transportFailed(socket, new Error("Shared Laya response exceeds its limit")); return;
    }
    for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; }
      catch { this.transportFailed(socket, new Error("Invalid shared Laya response")); return; }
      if (message.type === "ready") {
        if (message.protocol !== LOCAL_DECISION_PROTOCOL || message.identity !== this.endpoint.identity ||
            typeof message.modelSha256 !== "string" || typeof message.device !== "string") {
          this.transportFailed(socket, new Error("Shared Laya service identity mismatch")); return;
        }
        this.ready = { modelSha256: message.modelSha256, device: message.device };
        this.settleStartup?.();
        continue;
      }
      if (message.type === "fatal") {
        this.transportFailed(socket, new Error(String(message.error ?? "Shared Laya service failed"))); return;
      }
      const id = String(message.id ?? "");
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
      if (message.type === "error") { pending.reject(new Error(String(message.error ?? "Local Laya inference failed"))); continue; }
      if (message.type !== "result" || !this.ready || !this.validResult(message)) {
        pending.reject(new Error("Invalid local Laya decision result")); continue;
      }
      pending.resolve({ task: message.task as LocalDecisionTask, input: message.input as string,
        inputTokens: message.inputTokens as number, truncated: message.truncated as boolean,
        optionOrder: message.optionOrder as string[], scores: message.scores as Record<string, number>,
        decision: message.decision as string, ...this.ready });
    }
  }

  private validResult(value: Record<string, unknown>): boolean {
    if (value.task !== "route" && value.task !== "delivery") return false;
    const expected = value.task === "route" ? ["DIRECT", "PLAN", "CODE"] : ["RELEASE", "CHALLENGE"];
    if (typeof value.input !== "string" || !Number.isSafeInteger(value.inputTokens) ||
        typeof value.truncated !== "boolean" || !Array.isArray(value.optionOrder) ||
        JSON.stringify(value.optionOrder) !== JSON.stringify(expected) ||
        !value.scores || typeof value.scores !== "object" || Array.isArray(value.scores) ||
        !expected.includes(String(value.decision))) return false;
    return expected.every(label => Number.isFinite((value.scores as Record<string, number>)[label]));
  }

  private transportFailed(socket: Socket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.ready = undefined;
    this.buffer = "";
    socket.destroy();
    this.settleStartup?.(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      if (request.signal && request.abort) request.signal.removeEventListener("abort", request.abort);
      request.reject(error);
    }
    this.pending.clear();
  }

  /** Disconnect this CLI only. Other clients keep using the model. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.socket) this.transportFailed(this.socket, new Error("Local Laya client closed"));
  }
}
