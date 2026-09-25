import type { NativeAppServerClient } from "./app-server-client.js";

/** Codex may implicitly request elevated setup from command/exec when its
 * CODEX_HOME has no setup marker. Never let a target command trigger it. */
export async function assertProjectSandboxReady(
  service: Pick<NativeAppServerClient, "request">,
  timeoutMs: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32") return;
  const readiness = await service.request("windowsSandbox/readiness", {}, timeoutMs);
  if (readiness?.status !== "ready") {
    throw new Error(
      `Project sandbox is not ready (${String(readiness?.status ?? "unknown")}); ` +
      "complete Windows sandbox setup before running commands",
    );
  }
}
