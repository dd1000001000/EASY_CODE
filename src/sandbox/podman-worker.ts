/** Host-side supervisor. Container stdout can never forge private fd 3 events. */
import { readFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { podmanResource } from "./podman-startup.js";
import { execa, type ExecaChildProcess } from "execa";
import { encodeSandboxControl } from "./control.js";
import { podmanEnvironment, podmanExecutable, podmanArguments, podmanRunner, stopTaskContainer } from "./podman-client.js";
import os from "node:os";
import { attachPodmanProxy } from "./podman-proxy.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import type { ResolvedCommand } from "../command/types.js";
import type { SandboxWorkerControl } from "./types.js";

const payload = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  name: string; owner: string; commandId: string; proxyURL?: string; timeoutMs?: number; limits: RuntimeLimits; target: ResolvedCommand;
};
const run = podmanRunner(payload.limits);
const emit = (value: SandboxWorkerControl) => writeSync(3, encodeSandboxControl(payload.commandId, value));
let relay: ExecaChildProcess<string> | undefined;
let proxy: ReturnType<typeof attachPodmanProxy> | undefined;
let dispatched = false;
try {
  emit({ type: "stage", stage: "worker_started" });
  if (payload.proxyURL) {
    emit({ type: "stage", stage: "relay_start" });
    const script = await readFile(podmanResource("proxy.py"), "utf8");
    relay = execa(podmanExecutable(), podmanArguments(["exec", "-i", "--", payload.name, "python3", "-u", "-c", script], payload.limits), { cwd: os.tmpdir(),
      env: podmanEnvironment(), extendEnv: false, shell: false, windowsHide: true, reject: false, buffer: false,
      stdio: ["pipe", "pipe", "ignore"] });
    proxy = attachPodmanProxy(relay.stdout!, relay.stdin!, payload.proxyURL, {
      maxConnections: payload.limits.podmanProxyMaxConnections, maxBytes: payload.limits.podmanProxyMaxBytes });
    void relay.catch(() => proxy?.close());
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([proxy.ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Podman relay startup timed out")), payload.limits.podmanControlTimeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  const target = payload.target;
  const env = Object.entries(target.environment).flatMap(([key, value]) => value === undefined ? [] : ["--env", `${key}=${value}`]);
  emit({ type: "ready", backend: "podman" });
  emit({ type: "stage", stage: "dispatch_start" });
  emit({ type: "execution_dispatched" }); dispatched = true;
  const result = await execa(podmanExecutable(), podmanArguments(["exec", "--workdir", target.cwdAbsolute, ...env,
    "--", payload.name, target.executablePath, ...target.args], payload.limits), { cwd: os.tmpdir(),
    env: podmanEnvironment(), extendEnv: false, shell: false, windowsHide: true, reject: false,
    stdio: ["ignore", "inherit", "inherit"], cleanup: false, timeout: payload.timeoutMs ?? payload.limits.commandTimeoutMs,
  });
  const code = result.exitCode ?? 125;
  // Podman 125 indicates a client/engine error, not a test failure. A lost
  // response might follow actual dispatch, so never infer safe replay.
  emit({ type: "execution_exited", exitCode: code, outcome: result.timedOut ? "timed_out" : code === 125 ? "unknown" : "exited" });
  process.exitCode = code;
} catch (error) {
  if (dispatched) emit({ type: "execution_exited", exitCode: 125, outcome: "unknown" });
  else emit({ type: "sandbox_error", message: String(error).slice(0, 1200) });
  process.exitCode = 125;
} finally {
  emit({ type: "stage", stage: "cleanup_start" });
  proxy?.close();
  try { await stopTaskContainer(run, payload.name, payload.owner); emit({ type: "cleanup_complete" }); }
  catch (error) { emit({ type: "cleanup_error", message: String(error).slice(0, 1200) }); }
  if (relay) { relay.kill(); await relay.catch(() => undefined); }
}
