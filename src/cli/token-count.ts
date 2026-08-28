/** Format a non-negative token estimate with compact decimal SI suffixes. */
export function formatTokenCount(value: number): string {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  if (normalized < 1_000) return String(normalized);

  const suffixes = ["", "k", "m", "b"] as const;
  let unit = Math.min(3, Math.floor(Math.log10(normalized) / 3));
  let scaled = normalized / (1_000 ** unit);
  let rounded = Number(scaled.toFixed(1));
  if (rounded >= 1_000 && unit < suffixes.length - 1) {
    unit += 1;
    scaled = normalized / (1_000 ** unit);
    rounded = Number(scaled.toFixed(1));
  }
  return `${rounded}${suffixes[unit]}`;
}
