import { z } from "zod";
import type { SessionState } from "../core/types.js";
import { sha256 } from "../utils/hash.js";

export const deliverySchema = z.object({ id: z.string().min(1), request: z.string(),
  sourceMessageIndex: z.number().int().nonnegative(), changeStart: z.number().int().nonnegative(),
}).strict();
export type DeliveryObligation = z.infer<typeof deliverySchema>;
/** A task obligation survives turn IDs, summary changes and Resume. */
export function pendingDelivery(state: Readonly<SessionState>): boolean {
  const last = [...(state.reviewSessions ?? [])].reverse().find(s => s.purpose === "delivery");
  return Boolean(last && (!last.approval || last.status !== "applied")) || state.changes.length > (last?.changeCount ?? 0) || Boolean(state.delivery &&
    !state.reviewSessions?.some(s => s.scope === state.delivery!.id && s.purpose === "delivery" && s.approval && s.status === "applied"));
}
export function newDelivery(state: Readonly<SessionState>, request: string, sourceMessageIndex: number, changeStart: number): DeliveryObligation {
  return { id: `delivery_${sha256(JSON.stringify([state.threadId, sourceMessageIndex, changeStart]))}`,
    request, sourceMessageIndex, changeStart };
}
export function foldDelivery(state: SessionState, value: unknown): void {
  const next = deliverySchema.parse(value);
  if (state.delivery && !state.reviewSessions?.some(s => s.scope === state.delivery!.id && s.approval && s.status === "applied"))
    throw new Error("An unresolved delivery obligation cannot be replaced");
  if (next.changeStart > state.changes.length || next.sourceMessageIndex >= state.messages.length)
    throw new Error("Invalid delivery source binding");
  state.delivery = next;
}
