import type { LongTermMemoryScope } from "../core/types.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function memoryExpiryDays(scope: LongTermMemoryScope, limits: Readonly<RuntimeLimits>): number {
  return scope === "global" ? limits.memoryGlobalExpiryDays : limits.memoryProjectExpiryDays;
}

/** Quadratic decay: recent evidence changes rank slowly; exhausted evidence is ineligible. */
export function memoryFreshnessWeight(
  lastRecalledAt: string | null | undefined,
  createdAt: string,
  expiryDays: number,
  now = Date.now(),
): number {
  const timestamp = Date.parse(lastRecalledAt || createdAt);
  if (!Number.isFinite(timestamp)) return 0;
  const elapsedDays = Math.max(0, now - timestamp) / DAY_MS;
  const fraction = Math.min(1, elapsedDays / expiryDays);
  return 1 - fraction * fraction;
}
