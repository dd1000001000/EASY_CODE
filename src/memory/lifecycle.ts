import type { LongTermMemoryScope } from "../core/types.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function memoryExpiryDays(scope: LongTermMemoryScope, limits: Readonly<RuntimeLimits>): number {
  return scope === "global" ? limits.memoryGlobalExpiryDays : limits.memoryProjectExpiryDays;
}

/** How many of the sorted YYYY-MM-DD activeDays fall after the day of timestamp. */
export function activeDaysSince(activeDays: readonly string[], timestamp: number): number {
  const day = new Date(timestamp).toISOString().slice(0, 10);
  let low = 0;
  let high = activeDays.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (activeDays[middle]! <= day) low = middle + 1;
    else high = middle;
  }
  return activeDays.length - low;
}

/**
 * Quadratic decay: recent evidence changes rank slowly; exhausted evidence is ineligible.
 * With activeDays, age counts only days the memory's owner was in use, so a
 * project left alone for months still remembers what it knew when work resumes.
 */
export function memoryFreshnessWeight(
  lastRecalledAt: string | null | undefined,
  createdAt: string,
  expiryDays: number,
  now = Date.now(),
  activeDays?: readonly string[],
): number {
  const timestamp = Date.parse(lastRecalledAt || createdAt);
  if (!Number.isFinite(timestamp)) return 0;
  const elapsedDays = activeDays ? activeDaysSince(activeDays, timestamp) : Math.max(0, now - timestamp) / DAY_MS;
  const fraction = Math.min(1, elapsedDays / expiryDays);
  return 1 - fraction * fraction;
}
