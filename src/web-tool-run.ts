import type { WebEntry } from "./web-contracts.js";

const noticeKinds = new Set<WebEntry["kind"]>(["info", "success", "warning", "error"]);

/** Whether a visible tool run crosses a raw-entry boundary, ignoring notices. */
export function toolRunContinuesAcross(entries: readonly WebEntry[], boundary: number): boolean {
  let left = boundary - 1;
  let right = boundary;
  while (left >= 0 && noticeKinds.has(entries[left]!.kind)) left -= 1;
  while (right < entries.length && noticeKinds.has(entries[right]!.kind)) right += 1;
  return entries[left]?.kind === "tool" && entries[right]?.kind === "tool";
}
