import type { NativeAppServerClient } from "./app-server-client.js";
import { reconcileWindowsSandboxAccounts, resetElsewhereMessage } from "./windows-shared-accounts.js";

/** Codex may implicitly request elevated setup from command/exec when its
 * CODEX_HOME has no setup marker, or when its stored sandbox passwords were
 * replaced by another install's setup. Never let a target command trigger it. */
export async function assertProjectSandboxReady(
  service: Pick<NativeAppServerClient, "request">,
  timeoutMs: number,
  home: string,
  platform: NodeJS.Platform = process.platform,
  otherHomes?: readonly string[],
): Promise<void> {
  if (platform !== "win32") return;
  const readiness = await service.request("windowsSandbox/readiness", {}, timeoutMs);
  if (readiness?.status !== "ready") {
    throw new Error(
      `Project sandbox is not ready (${String(readiness?.status ?? "unknown")}); ` +
        "complete Windows sandbox setup before running commands",
    );
  }
  const accounts = await reconcileWindowsSandboxAccounts(home, otherHomes);
  if (accounts.kind === "reset_elsewhere")
    throw new Error(`Project sandbox is not ready: ${resetElsewhereMessage(accounts)}`);
}
