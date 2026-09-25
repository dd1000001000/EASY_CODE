import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, mkdir, rmdir, unlink } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  ensurePrivateSocketDirectory, localModelEnvironment, LOCAL_DECISION_PROTOCOL,
  MAX_IPC_LINE_BYTES, sharedLayaEndpoint, type SharedLayaEndpoint, type SharedLayaOptions,
} from "./endpoint.js";

interface ServiceOptions extends SharedLayaOptions { idleMs: number }
interface ClientConnection { socket: Socket; buffer: string; requests: Set<string> }
interface DecisionRequest { id: string; task: "route" | "delivery"; input: string; client: ClientConnection; canceled: boolean }

function send(socket: Socket, message: Record<string, unknown>): void {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
}

function probeEndpoint(address: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(address);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
  });
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ path: address, readableAll: false, writableAll: false });
  });
}

/** Only one contender may remove a verified stale Unix socket. */
async function recoverStaleSocket(endpoint: SharedLayaEndpoint): Promise<boolean> {
  if (!endpoint.directory) return false;
  const lock = path.join(endpoint.directory, "recovery.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(lock);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe Laya socket recovery lock");
    // Recovery takes milliseconds. A dead contender's lock is reclaimable.
    if (Date.now() - info.mtimeMs <= 30_000) return false;
    await rmdir(lock);
    return recoverStaleSocket(endpoint);
  }
  try {
    if (await probeEndpoint(endpoint.address)) return false;
    const socket = await lstat(endpoint.address).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!socket) return true;
    if (!socket.isSocket() || (process.getuid && socket.uid !== process.getuid()))
      throw new Error("Refusing to replace an unowned or non-socket Laya endpoint");
    await unlink(endpoint.address);
    return true;
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

export async function runSharedLayaService(options: ServiceOptions): Promise<void> {
  const endpoint = sharedLayaEndpoint(options);
  if (endpoint.directory) await ensurePrivateSocketDirectory(endpoint.directory);
  const clients = new Set<ClientConnection>();
  const queue: DecisionRequest[] = [];
  let active: DecisionRequest | undefined;
  let worker: ChildProcessWithoutNullStreams | undefined;
  let ready: { modelSha256: string; device: string } | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let initialTimer: NodeJS.Timeout | undefined;
  let emptyTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  let everUsed = false;

  const server = createServer(socket => {
    const client: ClientConnection = { socket, buffer: "", requests: new Set() };
    clients.add(client);
    if (emptyTimer) { clearTimeout(emptyTimer); emptyTimer = undefined; }
    if (initialTimer) { clearTimeout(initialTimer); initialTimer = undefined; }
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    if (ready) send(socket, { type: "ready", protocol: LOCAL_DECISION_PROTOCOL,
      identity: endpoint.identity, ...ready });
    socket.on("data", chunk => {
      client.buffer += String(chunk);
      if (Buffer.byteLength(client.buffer) > MAX_IPC_LINE_BYTES) {
        socket.destroy(new Error("Local decision IPC request exceeds its limit")); return;
      }
      for (let newline = client.buffer.indexOf("\n"); newline >= 0; newline = client.buffer.indexOf("\n")) {
        const line = client.buffer.slice(0, newline);
        client.buffer = client.buffer.slice(newline + 1);
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; }
        catch { socket.destroy(new Error("Invalid local decision IPC JSON")); return; }
        if (message.type === "cancel" && typeof message.id === "string") {
          const request = queue.find(item => item.id === message.id && item.client === client) ??
            (active?.id === message.id && active.client === client ? active : undefined);
          if (request) { request.canceled = true; client.requests.delete(request.id); }
          continue;
        }
        if (message.type !== "decide" || typeof message.id !== "string" ||
            !/^[a-zA-Z0-9-]{1,100}$/u.test(message.id) || client.requests.has(message.id) ||
            (message.task !== "route" && message.task !== "delivery") ||
            typeof message.input !== "string" || !message.input.trim() || message.input.length > 2_000_000 ||
            queue.length >= 64) {
          send(socket, { type: "error", id: message.id, error: "Invalid or overloaded local decision request" });
          continue;
        }
        const request: DecisionRequest = { id: message.id, task: message.task, input: message.input,
          client, canceled: false };
        client.requests.add(request.id);
        queue.push(request);
        everUsed = true;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
        dispatch();
      }
    });
    socket.once("close", () => {
      clients.delete(client);
      for (const request of queue) if (request.client === client) request.canceled = true;
      if (active?.client === client) active.canceled = true;
      if (clients.size === 0 && !stopping) {
        if (everUsed) stop();
        else emptyTimer = setTimeout(stop, 1000);
      }
    });
    socket.on("error", () => undefined);
  });

  function stop(): void {
    if (stopping) return;
    stopping = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (initialTimer) clearTimeout(initialTimer);
    if (emptyTimer) clearTimeout(emptyTimer);
    for (const client of clients) client.socket.destroy();
    server.close();
    worker?.kill();
  }

  function scheduleIdle(): void {
    if (stopping || active || queue.some(item => !item.canceled)) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, options.idleMs);
  }

  function dispatch(): void {
    if (stopping || !ready || !worker || active) return;
    while (queue.length) {
      const request = queue.shift()!;
      if (request.canceled || request.client.socket.destroyed) continue;
      active = request;
      worker.stdin.write(JSON.stringify({ id: request.id, task: request.task, input: request.input }) + "\n");
      return;
    }
    scheduleIdle();
  }

  function workerFailure(error: Error): void {
    if (stopping) return;
    for (const client of clients) send(client.socket, { type: "fatal", error: error.message.slice(0, 500) });
    stop();
  }

  try {
    await listen(server, endpoint.address);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (await probeEndpoint(endpoint.address)) return; // Another process won startup.
    if (!await recoverStaleSocket(endpoint)) return;
    await listen(server, endpoint.address);
  }
  if (endpoint.directory) await chmod(endpoint.address, 0o600);
  initialTimer = setTimeout(() => { if (!clients.size) stop(); }, 10_000);
  worker = spawn(options.python, [options.workerPath], {
    cwd: path.dirname(path.dirname(path.dirname(options.workerPath))), shell: false,
    windowsHide: true, env: localModelEnvironment(), stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  worker.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2_000); });
  createInterface({ input: worker.stdout }).on("line", line => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; }
    catch { workerFailure(new Error("Invalid Laya model worker response")); return; }
    if (message.type === "ready") {
      if (typeof message.modelSha256 !== "string" || typeof message.device !== "string") {
        workerFailure(new Error("Invalid Laya model identity")); return;
      }
      ready = { modelSha256: message.modelSha256, device: message.device };
      for (const client of clients) send(client.socket, { type: "ready", protocol: LOCAL_DECISION_PROTOCOL,
        identity: endpoint.identity, ...ready });
      dispatch();
      return;
    }
    if (!active || message.id !== active.id) {
      workerFailure(new Error("Unexpected Laya model response ID")); return;
    }
    const request = active;
    active = undefined;
    request.client.requests.delete(request.id);
    if (!request.canceled) send(request.client.socket, message);
    dispatch();
  });
  worker.once("error", error => workerFailure(error));
  worker.once("exit", code => workerFailure(new Error(`Laya model worker exited (${code ?? "unknown"}): ${stderr.slice(-500)}`)));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const raw = process.argv[2];
    if (!raw || raw.length > 8192) throw new Error("Missing local decision service options");
    const options = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ServiceOptions;
    if (!options || typeof options.python !== "string" || typeof options.workerPath !== "string" ||
        typeof options.dataDir !== "string" || !Number.isSafeInteger(options.idleMs) ||
        !path.isAbsolute(options.python) || !path.isAbsolute(options.workerPath) ||
        !path.isAbsolute(options.dataDir) ||
        options.idleMs < 1000 || options.idleMs > 3_600_000)
      throw new Error("Invalid local decision service options");
    await runSharedLayaService(options);
  } catch (error) {
    process.stderr.write(`Local Laya service failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
