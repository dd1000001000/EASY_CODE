import type { Language } from "../i18n/language.js";

/**
 * Elapsed time as `8s`, `1m 12s` or `1h 03m` (`8秒`, `1分12秒`, `1小时03分` in
 * Chinese). Shared by the terminal and the web page.
 */
export function formatDuration(durationMs: number, language?: Language): string {
  const [second, minute, hour, gap] = language === "zh_cn" ? ["秒", "分", "小时", ""] : ["s", "m", "h", " "];
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}${second}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${minute}${gap}${String(seconds % 60).padStart(2, "0")}${second}`;
  return `${Math.floor(minutes / 60)}${hour}${gap}${String(minutes % 60).padStart(2, "0")}${minute}`;
}

/** Requests at least this long notify on completion; shorter ones finish while the user still watches. */
export const LONG_TURN_NOTIFY_MS = 30_000;
