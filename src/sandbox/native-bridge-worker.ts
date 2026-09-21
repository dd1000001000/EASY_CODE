/** Host-side, authenticated bridge into a live Linux service sandbox. It never
 * executes the requested program on the host. */
import net from "node:net";
import { readFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { encodeSandboxControl } from "./control.js";

const payload = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  commandId: string; target: unknown; timeoutMs: number; bridgeSocketPath: string;
};
const secret = process.env.EASY_CODE_SERVICE_SECRET;
if (!secret || !/^[a-f0-9]{64}$/u.test(secret)) throw new Error("Linux service bridge credential is missing");
const emit = (event: import("./types.js").SandboxWorkerControl): void => {
  writeSync(3, encodeSandboxControl(payload.commandId, event));
};
let accepted = false, started = false, finished = false;
let pending = "";
emit({ type: "stage", stage: "worker_started" });
const socket = net.createConnection(payload.bridgeSocketPath);
socket.once("connect", () => {
  emit({ type: "ready", backend: "native" });
  emit({ type: "stage", stage: "dispatch_start" });
  socket.write(`${JSON.stringify({ type: "run", secret, commandId: payload.commandId,
    target: payload.target, timeoutMs: payload.timeoutMs, payloadPath: process.argv[2] })}\n`);
});
socket.on("data", bytes => {
  pending += bytes.toString("utf8");
  if (pending.length > 4 * 1024 * 1024) { socket.destroy(new Error("Service bridge frame exceeded limit")); return; }
  let newline: number;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    let frame: { type?: string; commandId?: string; data?: string; exitCode?: number; outcome?: string; message?: string };
    try { frame = JSON.parse(line); } catch { socket.destroy(new Error("Invalid service bridge frame")); return; }
    if (frame.commandId && frame.commandId !== payload.commandId) continue;
    if (frame.type === "accepted") { accepted = true; emit({ type: "execution_request_sent" }); }
    else if (frame.type === "started") { started = true; emit({ type: "target_started" }); }
    else if ((frame.type === "stdout" || frame.type === "stderr") && typeof frame.data === "string") {
      writeSync(frame.type === "stdout" ? 1 : 2, Buffer.from(frame.data, "base64"));
    } else if (frame.type === "spawn_failed") {
      finished = true;
      emit({ type: "target_spawn_error", message: String(frame.message ?? "Linux service command could not be started") });
      emit({ type: "execution_exited", exitCode: 125, outcome: "spawn_failed" });
      emit({ type: "stage", stage: "cleanup_start" });
      process.exitCode = 125;
      socket.end();
    } else if (frame.type === "exit" && Number.isInteger(frame.exitCode)) {
      finished = true;
      if (frame.outcome === "spawn_failed" && !started)
        emit({ type: "target_spawn_error", message: "Linux service command could not be started" });
      emit({ type: "execution_exited", exitCode: frame.exitCode!,
        outcome: frame.outcome === "timed_out" ? "timed_out" : frame.outcome === "canceled" ? "canceled"
          : frame.outcome === "spawn_failed" ? "spawn_failed" : "exited" });
      emit({ type: "stage", stage: "cleanup_start" });
      process.exitCode = frame.exitCode;
      socket.end();
    }
  }
});
socket.once("error", error => {
  if (finished) return;
  finished = true;
  emit(accepted ? { type: "cleanup_error", message: String(error).slice(0, 1200) }
    : { type: "sandbox_error", message: String(error).slice(0, 1200) });
  process.exitCode = 125;
});
socket.once("close", () => {
  if (finished) return;
  if (accepted || started) emit({ type: "cleanup_error", message: "Linux service bridge closed before command exit" });
  else emit({ type: "sandbox_error", message: "Linux service bridge closed before authorization" });
  process.exitCode = 125;
});
process.once("SIGTERM", () => {
  if (!finished) socket.write(`${JSON.stringify({ type: "cancel", secret, commandId: payload.commandId })}\n`);
  setTimeout(() => { socket.destroy(); process.exitCode = 130; }, 850).unref();
});
