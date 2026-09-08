import { open, readFile, writeFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { encodeSandboxControl } from "./control.js";
import { BENCHMARK_BRIDGE_ROOT } from "./benchmark-backend.js";

const [directory, commandId] = process.argv.slice(2);
if (!directory?.startsWith(`${BENCHMARK_BRIDGE_ROOT}/commands/request-`) || !/^command_[a-f0-9-]{36}$/u.test(commandId ?? "")) throw new Error("Invalid controller request");
const emit = (value: Parameters<typeof encodeSandboxControl>[1]) => { writeSync(3, encodeSandboxControl(commandId!, value)); };
let canceled = false;
process.on("SIGTERM", () => { canceled = true; void writeFile(path.join(directory, "cancel"), "cancel"); });
const positions = { stdout: 0, stderr: 0 };
const pump = async () => {
  for (const kind of ["stdout", "stderr"] as const) {
    const handle = await open(path.join(directory, kind), "r").catch(() => undefined);
    if (!handle) continue;
    try {
      const bytes = Buffer.alloc(65536);
      let read;
      do {
        read = await handle.read(bytes, 0, bytes.length, positions[kind]);
        if (read.bytesRead) { process[kind].write(bytes.subarray(0, read.bytesRead)); positions[kind] += read.bytesRead; }
      } while (read.bytesRead);
    } finally { await handle.close(); }
  }
};
await emit({ type: "ready", backend: "benchmark-container" });
await emit({ type: "execution_dispatched" });
try {
  for (;;) {
    await pump();
    const result = await readFile(path.join(directory, "result.json"), "utf8").catch(() => undefined);
    if (result) {
      const terminal = JSON.parse(result);
      await pump();
      if (!Number.isInteger(terminal.exitCode)) throw new Error("Invalid Docker execution result");
      await emit({ type: "execution_exited", exitCode: terminal.exitCode });
      if (terminal.error) await emit({ type: "cleanup_error", message: terminal.error });
      else await emit({ type: "cleanup_complete" });
      process.exitCode = canceled ? 130 : terminal.exitCode;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
} catch (error) { await emit({ type: "cleanup_error", message: String(error) }); process.exitCode = 1; }
