/** Windows host-permission execution with the same parent-owned Job Object
 * lifecycle as sandboxed execution. This is supervision, NOT an OS sandbox. */
import { readFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { execa } from "execa";
import { encodeSandboxControl } from "../sandbox/control.js";
import type { SandboxWorkerControl } from "../sandbox/types.js";

const payload = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  commandId: string; startupMs: number; cleanupMs: number;
  target: { executablePath: string; args: string[]; cwdAbsolute: string; environment: NodeJS.ProcessEnv };
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
try {
  if (process.platform !== "win32" || process.env.EASY_CODE_JOB_HANDSHAKE !== "1") throw new Error("Missing Windows Job Object supervisor");
  await authorization("GO", payload.startupMs);
  emit({ type: "ready", backend: "host-unrestricted" });
  emit({ type: "execution_dispatched" });
  const result = await execa(payload.target.executablePath, payload.target.args, {
    cwd: payload.target.cwdAbsolute, env: payload.target.environment, extendEnv: false,
    stdio: ["ignore", "inherit", "inherit"], shell: false, windowsHide: true,
    reject: false, cleanup: false,
  });
  emit({ type: "execution_exited", exitCode: result.exitCode ?? 1,
    outcome: typeof result.exitCode === "number" ? "exited" : "spawn_failed" });
  emit({ type: "cleanup_requested" });
  await authorization("CLEANUP", payload.cleanupMs);
  emit({ type: "cleanup_complete" });
  process.exitCode = result.exitCode ?? 1;
} catch (error) {
  emit({ type: "cleanup_error", message: String(error).slice(0, 1200) });
  process.exitCode = 125;
} finally { lines.close(); process.stdin.destroy(); }
