/** SRT reset() logs ACL anomalies instead of throwing. Check raw outcomes first. */
export function assertWindowsAclCleanup(outcomes: unknown): void {
  const accepted = new Set(["revoked", "stillHeld", "restored", "alreadyOriginal"]);
  if (!Array.isArray(outcomes) || outcomes.some(outcome =>
    !outcome || typeof outcome !== "object" || !accepted.has(outcome.status))) {
    throw new Error("Windows ACL cleanup did not report confirmed per-path outcomes");
  }
}
