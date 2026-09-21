/** Host-side supervisor for a Linux service broker. The broker, service and
 * follow-up commands all execute inside one Codex-enforced sandbox. */
import { createServer, type Socket } from "node:net";
import { chmodSync, writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { NativeAppServerClient } from "./app-server-client.js";
import { encodeSandboxControl } from "./control.js";
import { nativeSandboxProxyEnvironment } from "./native-runtime.js";
import type { ResolvedCommand } from "../command/types.js";
import type { SandboxWorkerControl } from "./types.js";

interface Payload {
  commandId: string; entrypoint: string; home: string; tempRoot: string;
  timeoutMs: number; startupMs: number; cleanupMs: number;
  target: ResolvedCommand; proxyURL?: string; proxyPorts?: number[];
  bridgeSocketPath: string;
}

const payloadPath = process.argv[2]!;
const payload = JSON.parse(await readFile(payloadPath, "utf8")) as Payload;
const secret = process.env.EASY_CODE_SERVICE_SECRET;
if (!secret || !/^[a-f0-9]{64}$/u.test(secret)) throw new Error("Linux service credential is missing");
const emit = (event: SandboxWorkerControl): void => { writeSync(3, encodeSandboxControl(payload.commandId, event)); };
const environment: NodeJS.ProcessEnv = { ...payload.target.environment,
  TEMP: payload.tempRoot, TMP: payload.tempRoot, TMPDIR: payload.tempRoot,
  ...nativeSandboxProxyEnvironment(payload.proxyURL, payload.proxyPorts) };
const initial = { ...payload.target, commandId: payload.commandId, timeoutMs: payload.timeoutMs,
  payloadPath, environment };
const brokerPayloadPath = path.join(path.dirname(payloadPath), "broker.json");
await writeFile(brokerPayloadPath, JSON.stringify({ initial }), { flag: "wx", mode: 0o600 });

let service: NativeAppServerClient | undefined;
let brokerReady = false, initialStarted = false, initialExited = false;
let primaryExitCode = 125;
let frameBuffer = "";
const bridges = new Map<string, Socket>();
let writeQueue = Promise.resolve();
const sendBroker = (frame: unknown): Promise<void> => {
  const data = Buffer.from(`${JSON.stringify(frame)}\n`).toString("base64");
  const next = writeQueue.then(async () => {
    if (!service) throw new Error("Service sandbox is not running");
    await service.request("command/exec/write", { processId: payload.commandId, deltaBase64: data }, 5_000);
  });
  writeQueue = next.catch(() => undefined);
  return next;
};
process.once("SIGTERM", () => {
  if (initialExited) return;
  void sendBroker({ type: "cancel", commandId: payload.commandId }).catch(() => undefined);
});
const trusted = (value: unknown): boolean => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return false;
  return timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(secret, "hex"));
};

function brokerFrame(frame: { type?: string; commandId?: string; data?: string; exitCode?: number; outcome?: string }): void {
  if (frame.type === "ready") { brokerReady = true; return; }
  if (frame.commandId === payload.commandId) {
    if (frame.type === "started" && !initialStarted) { initialStarted = true; emit({ type: "target_started" }); }
    else if ((frame.type === "stdout" || frame.type === "stderr") && typeof frame.data === "string")
      writeSync(frame.type === "stdout" ? 1 : 2, Buffer.from(frame.data, "base64"));
    else if (frame.type === "exit" && Number.isInteger(frame.exitCode)) {
      initialExited = true;
      primaryExitCode = frame.exitCode!;
      if (frame.outcome === "spawn_failed" && !initialStarted)
        emit({ type: "target_spawn_error", message: "Linux service target could not be started" });
      emit({ type: "execution_exited", exitCode: primaryExitCode,
        outcome: frame.outcome === "timed_out" ? "timed_out" : frame.outcome === "canceled" ? "canceled"
          : frame.outcome === "spawn_failed" ? "spawn_failed" : "exited" });
    }
    return;
  }
  const socket = frame.commandId ? bridges.get(frame.commandId) : undefined;
  if (!socket || socket.destroyed) return;
  socket.write(`${JSON.stringify(frame)}\n`);
  if (frame.type === "exit") { bridges.delete(frame.commandId!); socket.end(); }
}

const server = createServer(socket => {
  let pending = "";
  let commandId: string | undefined;
  socket.on("data", bytes => {
    pending += bytes.toString("utf8");
    if (pending.length > 4 * 1024 * 1024) { socket.destroy(); return; }
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let request: any;
      try { request = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!trusted(request.secret)) { socket.destroy(); return; }
      if (request.type === "run" && !commandId && brokerReady && !initialExited &&
          typeof request.commandId === "string" && request.commandId !== payload.commandId &&
          request.target && Number.isInteger(request.timeoutMs) && request.timeoutMs > 0) {
        commandId = request.commandId;
        bridges.set(request.commandId, socket);
        socket.write(`${JSON.stringify({ type: "accepted", commandId })}\n`);
        const target = request.target as ResolvedCommand;
        void sendBroker({ type: "run", command: { ...target, commandId,
          timeoutMs: request.timeoutMs, payloadPath: request.payloadPath } }).catch(error => {
          if (bridges.get(commandId!) === socket) {
            bridges.delete(commandId!);
            socket.end(`${JSON.stringify({ type: "spawn_failed", commandId, message: String(error) })}\n`);
          }
        });
      } else if (request.type === "cancel" && commandId === request.commandId) {
        void sendBroker({ type: "cancel", commandId }).catch(() => undefined);
      } else socket.destroy();
    }
  });
  socket.once("close", () => {
    if (commandId && bridges.get(commandId) === socket) {
      bridges.delete(commandId);
      void sendBroker({ type: "cancel", commandId }).catch(() => undefined);
    }
  });
});

try {
  emit({ type: "stage", stage: "worker_started" });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(payload.bridgeSocketPath, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(payload.bridgeSocketPath, 0o600);
  service = new NativeAppServerClient(payload.entrypoint, payload.home, environment);
  await service.initialize(payload.startupMs);
  service.onNotification(message => {
    if (message?.method !== "command/exec/outputDelta" || typeof message.params?.deltaBase64 !== "string") return;
    frameBuffer += Buffer.from(message.params.deltaBase64, "base64").toString("utf8");
    if (frameBuffer.length > 4 * 1024 * 1024) { frameBuffer = ""; return; }
    let newline: number;
    while ((newline = frameBuffer.indexOf("\n")) >= 0) {
      const line = frameBuffer.slice(0, newline).replace(/\r$/u, "");
      frameBuffer = frameBuffer.slice(newline + 1);
      try { brokerFrame(JSON.parse(line)); } catch { /* reject malformed sandbox output */ }
    }
  });
  emit({ type: "ready", backend: "native" });
  emit({ type: "stage", stage: "dispatch_start" });
  emit({ type: "execution_request_sent" });
  const result = await service.request("command/exec", {
    command: [process.execPath, fileURLToPath(new URL("service-broker.js", import.meta.url)), brokerPayloadPath],
    cwd: payload.target.cwdAbsolute, env: environment, permissionProfile: "easy-code-local-service",
    processId: payload.commandId, streamStdoutStderr: true, tty: true, timeoutMs: payload.timeoutMs,
  }, payload.timeoutMs + payload.cleanupMs);
  if (!initialExited) {
    primaryExitCode = Number.isInteger(result?.exitCode) ? result.exitCode : 125;
    if (!initialStarted) emit({ type: "target_spawn_error", message: "Linux service broker did not start its target" });
    emit({ type: "execution_exited", exitCode: primaryExitCode,
      outcome: initialStarted ? "exited" : "spawn_failed" });
  }
  emit({ type: "stage", stage: "cleanup_start" });
  process.exitCode = primaryExitCode;
} catch (error) {
  if (!initialStarted) emit({ type: "sandbox_error", message: String(error).slice(0, 1200) });
  else emit({ type: "cleanup_error", message: String(error).slice(0, 1200) });
  process.exitCode = 125;
} finally {
  for (const socket of bridges.values()) socket.destroy();
  bridges.clear();
  server.close();
  await service?.close(500).catch(() => undefined);
}
