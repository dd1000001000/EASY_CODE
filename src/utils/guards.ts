/** A plain object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An integer in [minimum, maximum]; a missing or non-finite value falls back to `fallback`, which is clamped too. */
export function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const resolved = value !== undefined && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(Math.trunc(resolved), maximum));
}
