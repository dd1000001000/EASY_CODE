import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { nativeSandboxEnvironment } from "./native-runtime.js";

interface PendingRequest { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }

/** Minimal, model-free client for Codex's documented app-server command and
 * Windows setup APIs. It never starts a thread or sends a model request. */
export class NativeAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stderr = "";
  private closed = false;
  private terminated = false;
  private notifications = new Set<(message: any) => void>();

  constructor(entrypoint: string, home: string, environment: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(entrypoint, ["app-server"], {
      env: nativeSandboxEnvironment(home, environment), cwd: home, shell: false,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
    this.lines.on("line", line => this.receive(line));
    const failed = (error: Error) => this.failAll(error);
    this.exited = new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      this.child.once("error", error => { this.terminated = true; failed(error); finish(); });
      this.child.once("close", code => {
        this.terminated = true;
        failed(new Error(`Native sandbox service exited (${String(code)}): ${this.stderr}`)); finish();
      });
    });
  }

  async initialize(timeoutMs = 30_000): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "easy_code", title: "EASY CODE", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, timeoutMs);
    this.send({ method: "initialized", params: {} });
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.closed || this.terminated) return Promise.reject(new Error("Native sandbox service is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ method, id, params });
    });
  }

  waitFor(method: string, predicate: (params: any) => boolean, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const listener = (message: any) => {
        if (message?.method !== method || !predicate(message.params)) return;
        clearTimeout(timer); this.notifications.delete(listener); resolve(message.params);
      };
      timer = setTimeout(() => { this.notifications.delete(listener); reject(new Error(`${method} notification timed out`)); }, timeoutMs);
      this.notifications.add(listener);
    });
  }

  onNotification(listener: (message: any) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  async close(waitMs = 2_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill();
    const timer = setTimeout(() => this.child.kill(), Math.max(100, Math.floor(waitMs / 2)));
    await Promise.race([this.exited, new Promise<void>(resolve => setTimeout(resolve, waitMs))]);
    clearTimeout(timer);
  }

  private send(message: unknown): void { this.child.stdin.write(JSON.stringify(message) + "\n"); }
  private receive(line: string): void {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (Number.isSafeInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(String(message.error.message ?? JSON.stringify(message.error))));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.notifications) listener(message);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); }
  }
}
