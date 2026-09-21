/** Runs inside one Codex Linux sandbox. Every child inherits its mount,
 * network and syscall boundaries, including the initial long-lived service. */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

interface CommandSpec {
  commandId: string;
  executablePath: string;
  args: string[];
  cwdAbsolute: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  launch?: { executablePath: string; args: string[]; usesCommandPayload?: boolean };
  payloadPath?: string;
}

type Incoming = { type: "run"; command: CommandSpec } | { type: "cancel"; commandId: string };
type Frame = { type: "ready" } | { type: "started" | "exit"; commandId: string; exitCode?: number; outcome?: string }
  | { type: "stdout" | "stderr"; commandId: string; data: string };

const payload = JSON.parse(await readFile(process.argv[2]!, "utf8")) as { initial: CommandSpec };
const running = new Map<string, { child: ChildProcess; timer: NodeJS.Timeout; outcome?: "timed_out" | "canceled" | "spawn_failed" }>();
const initialId = payload.initial.commandId;
const emit = (frame: Frame): void => { process.stdout.write(`${JSON.stringify(frame)}\n`); };
let stopping = false;
let primaryExitCode = 0;

function terminate(commandId: string, outcome: "timed_out" | "canceled"): void {
  const entry = running.get(commandId);
  if (!entry) return;
  entry.outcome = outcome;
  const pid = entry.child.pid;
  try { if (pid) process.kill(-pid, "SIGTERM"); else entry.child.kill("SIGTERM"); } catch { /* exited */ }
  setTimeout(() => {
    if (!running.has(commandId)) return;
    try { if (pid) process.kill(-pid, "SIGKILL"); else entry.child.kill("SIGKILL"); } catch { /* exited */ }
  }, 750).unref();
}

function run(command: CommandSpec): void {
  if (stopping || running.has(command.commandId)) return;
  const launch = command.launch ?? { executablePath: command.executablePath, args: command.args };
  const environment = { ...process.env, ...command.environment };
  // The service sandbox's domain-filtering proxy is part of its enforcement.
  // A model-controlled command cannot replace it with a direct host proxy.
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  if (launch.usesCommandPayload && command.payloadPath) environment.EASY_CODE_LAUNCH_SPEC = command.payloadPath;
  const child = spawn(launch.executablePath, launch.args, {
    cwd: command.cwdAbsolute, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const timer = setTimeout(() => terminate(command.commandId, "timed_out"), command.timeoutMs);
  running.set(command.commandId, { child, timer });
  child.once("spawn", () => emit({ type: "started", commandId: command.commandId }));
  child.stdout?.on("data", (bytes: Buffer) => emit({ type: "stdout", commandId: command.commandId, data: bytes.toString("base64") }));
  child.stderr?.on("data", (bytes: Buffer) => emit({ type: "stderr", commandId: command.commandId, data: bytes.toString("base64") }));
  child.once("error", error => {
    const entry = running.get(command.commandId);
    if (entry) entry.outcome = "spawn_failed";
    emit({ type: "stderr", commandId: command.commandId, data: Buffer.from(String(error)).toString("base64") });
  });
  child.once("close", (code, signal) => {
    const entry = running.get(command.commandId);
    if (!entry) return;
    clearTimeout(entry.timer);
    running.delete(command.commandId);
    const exitCode = entry.outcome === "timed_out" ? 124 : entry.outcome === "canceled" ? 130 : entry.outcome === "spawn_failed" ? 125
      : Number.isInteger(code) ? code! : signal ? 128 : 125;
    emit({ type: "exit", commandId: command.commandId, exitCode,
      outcome: entry.outcome ?? (signal ? "canceled" : "exited") });
    if (command.commandId === initialId) {
      stopping = true;
      primaryExitCode = exitCode;
      for (const id of running.keys()) terminate(id, "canceled");
    }
    if (stopping && running.size === 0) {
      input.close();
      process.stdin.destroy();
      process.exitCode = primaryExitCode;
    }
  });
}

process.stdin.setRawMode?.(true);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (line.length > 1024 * 1024) return;
  let message: Incoming;
  try { message = JSON.parse(line) as Incoming; } catch { return; }
  if (message.type === "run" && message.command && typeof message.command.commandId === "string") run(message.command);
  else if (message.type === "cancel" && typeof message.commandId === "string") terminate(message.commandId, "canceled");
});
process.once("SIGTERM", () => {
  stopping = true;
  for (const id of running.keys()) terminate(id, "canceled");
  setTimeout(() => process.exit(143), 850).unref();
});
emit({ type: "ready" });
run(payload.initial);
