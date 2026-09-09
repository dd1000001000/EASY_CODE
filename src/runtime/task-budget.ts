import type { ModelRequest, ProviderUsage } from "../core/types.js";
import { requestTokens } from "../context/token-budget.js";
import { z } from "zod";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const snapshotSchema = z.object({ requests: count, tokens: count, reservedTokens: count,
  heldRequests: count.optional(), heldTokens: count.optional(), maxRequests: count.min(1), maxTokens: count }).strict();
export type TaskBudgetSnapshot = z.infer<typeof snapshotSchema>;

export class TaskBudgetExceeded extends Error {
  constructor(detail: string) { super(`task_budget_exhausted: ${detail}. Work is paused, not completed.`); }
}

/** Per-user-turn budget shared by parent, children, reviewer and compaction.
 * Synchronous reservations prevent concurrent children spending the same slot.
 * Cached/reasoning tokens are subsets of usage, not additional charges.
 */
export class TaskBudget {
  private requests = 0;
  private tokens = 0;
  private reserved = 0;
  private heldRequests = 0;
  private heldTokens = 0;
  constructor(readonly maxRequests: number, readonly maxTokens: number,
    private readonly persist?: (snapshot: TaskBudgetSnapshot) => void, restored?: TaskBudgetSnapshot) {
    if (restored) {
      this.requests = restored.requests;
      // A crashed in-flight request may have consumed its entire reservation.
      this.tokens = restored.tokens + restored.reservedTokens;
    }
    snapshotSchema.parse(this.snapshot());
    this.persist?.(this.snapshot());
  }
  static restore(value: unknown, persist?: (snapshot: TaskBudgetSnapshot) => void): TaskBudget {
    const saved = snapshotSchema.parse(value);
    return new TaskBudget(saved.maxRequests, saved.maxTokens, persist, saved);
  }
  snapshot() { return { requests: this.requests, tokens: this.tokens, reservedTokens: this.reserved,
    ...(this.heldRequests ? { heldRequests: this.heldRequests, heldTokens: this.heldTokens } : {}),
    maxRequests: this.maxRequests, maxTokens: this.maxTokens }; }
  /** Future closing requests are protected from concurrent workers. Unlike an
   * in-flight reservation, an unclaimed hold did not call a provider on crash. */
  hold(count: number, tokensPerRequest: number) {
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(tokensPerRequest) || tokensPerRequest < 0)
      throw new Error("Invalid task budget hold");
    if (this.requests + this.heldRequests + count > this.maxRequests || this.maxTokens > 0 &&
        this.tokens + this.reserved + this.heldTokens + count * tokensPerRequest > this.maxTokens)
      throw new TaskBudgetExceeded("cannot reserve independent closing summaries");
    let remaining = count;
    this.heldRequests += count; this.heldTokens += count * tokensPerRequest;
    try { this.persist?.(this.snapshot()); }
    catch (error) { this.heldRequests -= count; this.heldTokens -= count * tokensPerRequest; throw error; }
    return {
      reserve: (request: ModelRequest) => {
        if (remaining < 1) throw new TaskBudgetExceeded("closing reservation exhausted");
        remaining--; this.heldRequests--; this.heldTokens -= tokensPerRequest;
        try { return this.reserve(request); }
        catch (error) { remaining++; this.heldRequests++; this.heldTokens += tokensPerRequest; throw error; }
      },
      release: () => { this.heldRequests -= remaining; this.heldTokens -= remaining * tokensPerRequest;
        remaining = 0; this.persist?.(this.snapshot()); },
    };
  }
  reserve(request: ModelRequest, estimate = requestTokens): (usage?: ProviderUsage) => void {
    // Reservation is an estimate, not a server-enforced ceiling. Settle actual usage.
    const reservation = estimate(request.messages, request.tools) + (request.outputReserveTokens ?? DEFAULT_RUNTIME_LIMITS.maxResponseTokens);
    if (this.requests + this.heldRequests >= this.maxRequests) throw new TaskBudgetExceeded("shared model-request limit reached");
    if (this.maxTokens > 0 && this.tokens + this.reserved + this.heldTokens + reservation > this.maxTokens) {
      throw new TaskBudgetExceeded("next request does not fit the shared token budget");
    }
    this.requests += 1;
    this.reserved += reservation;
    // Commit the debit before dispatch. A journal failure cannot grant a free retry.
    this.persist?.(this.snapshot());
    let settled = false;
    return (usage) => {
      if (settled) return;
      settled = true;
      this.reserved -= reservation;
      const reported = usage?.totalTokens ?? (usage?.promptTokens !== undefined && usage?.completionTokens !== undefined
        ? usage.promptTokens + usage.completionTokens : undefined);
      this.tokens += reported !== undefined && Number.isFinite(reported) && reported >= 0 ? reported : reservation;
      // The durable reservation remains a conservative upper charge if settlement
      // cannot be written; never replace an otherwise successful model response.
      try { this.persist?.(this.snapshot()); } catch { /* retained reservation */ }
    };
  }
}
