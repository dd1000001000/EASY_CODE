/** Trusted per-command bridge. The private fd 3 carries lifecycle facts; target
 * output can never forge them. Codex app-server is used only for command/exec. */
import { readFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { NativeAppServerClient } from "./app-server-client.js";
import { sandboxBoundaryResultFromError, targetSpawnFailureFromError } from "./native-command-error.js";
import { nativeSandboxProxyEnvironment } from "./native-runtime.js";
import { encodeSandboxControl } from "./control.js";
import { nativePermissionProfile } from "./native-policy.js";
import type { ResolvedCommand } from "../command/types.js";
import type { SandboxWorkerControl } from "./types.js";

interface Payload {
  commandId: string; entrypoint: string; home: string;
  tempRoot: string; timeoutMs: number; startupMs: number; cleanupMs: number;
  target: ResolvedCommand; readOnly?: boolean; proxyURL?: string; proxyPorts?: number[];
}

const payload = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Payload;
const emit = (event: SandboxWorkerControl) => writeSync(3, encodeSandboxControl(payload.commandId, event));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function authorization(expected: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); input.off("line", onLine); input.off("close", onClose); };
    const onLine = (line: string) => { cleanup(); line === expected ? resolve() : reject(new Error("Command supervisor sent invalid authorization")); };
    const onClose = () => { cleanup(); reject(new Error("Command supervisor disconnected before authorization")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Command supervisor authorization timed out")); }, timeoutMs);
    input.once("line", onLine); input.once("close", onClose);
  });
}

const environment: NodeJS.ProcessEnv = { ...payload.target.environment, TEMP: payload.tempRoot, TMP: payload.tempRoot,
  TMPDIR: payload.tempRoot, NPM_CONFIG_CACHE: path.join(payload.tempRoot, "npm-cache"),
  npm_config_cache: path.join(payload.tempRoot, "npm-cache"), PIP_CACHE_DIR: path.join(payload.tempRoot, "pip-cache"),
  XDG_CACHE_HOME: path.join(payload.tempRoot, "xdg-cache"), YARN_CACHE_FOLDER: path.join(payload.tempRoot, "yarn-cache"),
  ...nativeSandboxProxyEnvironment(payload.proxyURL, payload.proxyPorts) };
const physicalTarget = payload.target.launch ?? {
  executablePath: payload.target.executablePath,
  args: payload.target.args,
};
if (payload.target.launch?.usesCommandPayload) environment.EASY_CODE_LAUNCH_SPEC = process.argv[2]!;
const permission = nativePermissionProfile(payload.readOnly);

let service: NativeAppServerClient | undefined;
let requestSent = false;
let targetStarted = false;
let executionReported = false;
let streamedStdout = false, streamedStderr = false;
try {
  emit({ type: "stage", stage: "worker_started" });
  if (process.platform === "win32" && process.env.EASY_CODE_JOB_HANDSHAKE === "1")
    await authorization("GO", payload.startupMs);
  // The target receives the approved proxy environment. The app-server itself
  // is infrastructure and must not be attributed as target network traffic.
  service = new NativeAppServerClient(payload.entrypoint, payload.home, environment, undefined, payload.proxyPorts);
  await service.initialize(payload.startupMs);
  const stopListening = service.onNotification(message => {
    if (message?.method !== "command/exec/outputDelta") return;
    const encoded = message.params?.deltaBase64;
    if (typeof encoded !== "string" || encoded.length > 16 * 1024 * 1024) return;
    if (!targetStarted) { emit({ type: "target_started" }); targetStarted = true; }
    const output = Buffer.from(encoded, "base64");
    if (message.params?.stream === "stderr") { streamedStderr = true; writeSync(2, output); }
    else { streamedStdout = true; writeSync(1, output); }
  });
  emit({ type: "ready", backend: "native" });
  emit({ type: "stage", stage: "dispatch_start" });
  emit({ type: "execution_request_sent" }); requestSent = true;
  const streamOutput = process.platform !== "win32";
  let result: any;
  let commandTimedOut = false;
  try {
    result = await service.request("command/exec", { command: [physicalTarget.executablePath, ...physicalTarget.args],
      cwd: payload.target.cwdAbsolute, env: environment, ...permission, timeoutMs: payload.timeoutMs,
      ...(streamOutput ? { processId: payload.commandId, streamStdoutStderr: true } : {}) },
      payload.timeoutMs + payload.cleanupMs);
  } catch (error) {
    const violation = sandboxBoundaryResultFromError(error);
    if (violation) {
      if (!targetStarted) { emit({ type: "target_started" }); targetStarted = true; }
      emit(violation.event);
      result = violation;
    } else {
      const spawnFailure = targetSpawnFailureFromError(error);
      if (spawnFailure) {
        emit(spawnFailure.event);
        result = { ...spawnFailure, spawnFailed: true };
      } else {
        if (!/command timed out/iu.test(String(error))) throw error;
        if (!targetStarted) { emit({ type: "target_started" }); targetStarted = true; }
        commandTimedOut = true;
        result = { exitCode: 124, stdout: "", stderr: "" };
      }
    }
  } finally {
    stopListening();
  }
  if (!streamedStdout && typeof result?.stdout === "string") writeSync(1, result.stdout);
  if (!streamedStderr && typeof result?.stderr === "string") writeSync(2, result.stderr);
  const code = Number.isSafeInteger(result?.exitCode) ? result.exitCode : 125;
  if (!result?.spawnFailed && !targetStarted) { emit({ type: "target_started" }); targetStarted = true; }
  emit({ type: "execution_exited", exitCode: code, outcome: result?.spawnFailed ? "spawn_failed" : commandTimedOut ? "timed_out" : Number.isSafeInteger(result?.exitCode) ? "exited" : "unknown" });
  executionReported = true;
  emit({ type: "stage", stage: "cleanup_start" });
  // The host created this command root and removes it only after this worker
  // exits. If Windows ACL inheritance prevents that, the backend re-enters the
  // same native identity for one bounded fallback cleanup.
  process.exitCode = code;
} catch (error) {
  if (requestSent && !executionReported) emit({ type: "execution_exited", exitCode: 125, outcome: "unknown" });
  else if (!executionReported) emit({ type: "sandbox_error", message: String(error).slice(0, 1200) });
  // Before request_sent, the target definitely did not run and the host-owned
  // backend can remove its scratch directory after this worker exits.
  if (requestSent) emit({ type: "cleanup_error", message: String(error).slice(0, 1200) });
  process.exitCode = 125;
} finally {
  await service?.close(250).catch(() => undefined);
  input.close(); process.stdin.destroy();
}
