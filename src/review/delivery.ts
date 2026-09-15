import { z } from "zod";
import type { SessionState } from "../core/types.js";
import { sha256 } from "../utils/hash.js";

export const deliverySchema = z.object({ id: z.string().min(1), request: z.string(),
  sourceMessageIndex: z.number().int().nonnegative(), changeStart: z.number().int().nonnegative(),
}).strict();
export type DeliveryObligation = z.infer<typeof deliverySchema>;
/** Advisory review material survives turn IDs, summary changes and Resume. */
export function newDelivery(state: Readonly<SessionState>, request: string, sourceMessageIndex: number, changeStart: number): DeliveryObligation {
  return { id: `delivery_${sha256(JSON.stringify([state.threadId, sourceMessageIndex, changeStart]))}`,
    request, sourceMessageIndex, changeStart };
}
export function foldDelivery(state: SessionState, value: unknown): void {
  const next = deliverySchema.parse(value);
  // A later explicit user request starts new review material. A same-request
  // replacement still cannot erase an unresolved durable review.
  if (state.delivery && next.sourceMessageIndex <= state.delivery.sourceMessageIndex &&
      !state.reviewSessions?.some(s => s.scope === state.delivery!.id && s.approval && s.status === "applied"))
    throw new Error("An unresolved delivery obligation cannot be replaced");
  if (next.changeStart > state.changes.length || next.sourceMessageIndex >= state.messages.length)
    throw new Error("Invalid delivery source binding");
  state.delivery = next;
}
