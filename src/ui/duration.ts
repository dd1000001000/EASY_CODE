/** Elapsed time as `8s`, `1m 12s` or `1h 03m`. Shared by the terminal and the web page. */
export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Requests at least this long notify on completion; shorter ones finish while the user still watches. */
export const LONG_TURN_NOTIFY_MS = 30_000;
