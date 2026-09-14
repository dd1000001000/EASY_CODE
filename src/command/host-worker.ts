/** Windows host-permission execution with the same parent-owned Job Object
 * lifecycle as sandboxed execution. This is supervision, NOT an OS sandbox. */
import { readFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { execa } from "execa";
import { encodeSandboxControl } from "../sandbox/control.js";
import type { SandboxWorkerControl } from "../sandbox/types.js";
import type { ResolvedCommand } from "./types.js";

const payload = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  commandId: string; startupMs: number; cleanupMs: number;
  target: ResolvedCommand;
};
const emit = (event: SandboxWorkerControl) => writeSync(3, encodeSandboxControl(payload.commandId, event));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
async function authorization(expected: string, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const line = await Promise.race([iterator.next(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Command supervisor authorization timed out")), timeoutMs);
    })]);
    if (line.done || line.value !== expected) throw new Error("Command supervisor disconnected or sent invalid authorization");
  } finally { if (timer) clearTimeout(timer); }
}
let requestSent = false;
let targetStarted = false;
try {
  if (process.platform !== "win32" || process.env.EASY_CODE_JOB_HANDSHAKE !== "1") throw new Error("Missing Windows Job Object supervisor");
  await authorization("GO", payload.startupMs);
  emit({ type: "ready", backend: "host-unrestricted" });
  emit({ type: "execution_request_sent" }); requestSent = true;
  const physicalTarget = payload.target.launch ?? payload.target;
  const environment = { ...payload.target.environment,
    ...(payload.target.launch?.usesCommandPayload ? { EASY_CODE_LAUNCH_SPEC: process.argv[2]! } : {}) };
  const child = execa(physicalTarget.executablePath, physicalTarget.args, {
    cwd: payload.target.cwdAbsolute, env: environment, extendEnv: false,
    stdio: ["ignore", "inherit", "inherit"], shell: false, windowsHide: true,
    reject: false, cleanup: false,
  });
  await new Promise<void>((resolve, reject) => {
    if (child.pid) { resolve(); return; }
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  emit({ type: "target_started" }); targetStarted = true;
  const result = await child;
  emit({ type: "execution_exited", exitCode: result.exitCode ?? 1,
    outcome: typeof result.exitCode === "number" ? "exited" : "spawn_failed" });
  emit({ type: "cleanup_requested" });
  await authorization("CLEANUP", payload.cleanupMs);
  emit({ type: "cleanup_complete" });
  process.exitCode = result.exitCode ?? 1;
} catch (error) {
  if (requestSent && !targetStarted) {
    const message = `Windows could not start the approved host target. The command did not run: ${String(error).slice(0, 900)}`;
    emit({ type: "target_spawn_error", message });
    emit({ type: "execution_exited", exitCode: 125, outcome: "spawn_failed" });
    try {
      emit({ type: "cleanup_requested" });
      await authorization("CLEANUP", payload.cleanupMs);
      emit({ type: "cleanup_complete" });
    } catch (cleanupError) {
      emit({ type: "cleanup_error", message: String(cleanupError).slice(0, 1200) });
    }
  } else {
    emit({ type: "cleanup_error", message: String(error).slice(0, 1200) });
  }
  process.exitCode = 125;
} finally { lines.close(); process.stdin.destroy(); }
