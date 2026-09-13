export interface ProcessGroupSignals {
  (pid: number, signal: NodeJS.Signals | 0): unknown;
}

/** Only the original process group is covered. setsid descendants are NOT tracked. */
export async function stopPosixProcessGroup(
  pid: number,
  graceMs: number,
  signal: ProcessGroupSignals = process.kill.bind(process),
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  const send = (value: NodeJS.Signals | 0): "present" | "gone" | "unknown" => {
    try { signal(-pid, value); return "present"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
  };
  for (const action of ["SIGTERM", "SIGKILL"] as const) {
    const sent = send(action);
    if (sent === "gone") return true;
    if (sent === "unknown") return false;
    const deadline = Date.now() + Math.max(0, graceMs);
    for (;;) {
      const state = send(0);
      if (state === "gone") return true;
      if (state === "unknown") return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, remaining)));
    }
  }
  return false;
}
