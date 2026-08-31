export interface TurnSteeringAttempt {
  /** One-shot signal for the active provider attempt. */
  readonly signal: AbortSignal;
  /** Release this attempt before opening the next one. Idempotent. */
  dispose(): void;
}

/**
 * Process-local wakeup bridge for the durable turn-steering inbox.
 *
 * Durable inbox sequence numbers are the source of truth. This controller
 * only coalesces wakeups and aborts the provider request that is active when a
 * new durable entry arrives. It deliberately stores no message content.
 */
export class TurnSteeringAttemptNotifier {
  private notifiedThrough = 0;
  private consumedThrough = 0;
  private activeAttempt?: {
    readonly controller: AbortController;
    disposed: boolean;
  };

  /** Highest durable inbox sequence observed by this process-local notifier. */
  get notifiedThroughSequence(): number {
    return this.notifiedThrough;
  }

  /** Highest durable inbox sequence acknowledged as applied to model context. */
  get consumedThroughSequence(): number {
    return this.consumedThrough;
  }

  /** Whether a durable notification still needs to be consumed. */
  get pending(): boolean {
    return this.notifiedThrough > this.consumedThrough;
  }

  /**
   * Notify the active attempt after an inbox entry has been durably enqueued.
   * Duplicate and out-of-order notifications are harmless and multiple newer
   * notifications coalesce into one abort plus the highest sequence watermark.
   */
  notify(sequence: number): void {
    assertSteeringSequence(sequence, false);
    if (sequence <= this.notifiedThrough) return;
    this.notifiedThrough = sequence;
    this.abortActiveAttemptIfPending();
  }

  /**
   * Open the one-shot signal for exactly one provider request attempt.
   * A notification received between attempts is represented by an already
   * aborted signal, so the next request cannot accidentally run without first
   * draining the durable inbox.
   */
  openAttempt(): TurnSteeringAttempt {
    if (this.activeAttempt) {
      throw new Error(
        "Cannot open a steering attempt before disposing the active attempt",
      );
    }
    const active = {
      controller: new AbortController(),
      disposed: false,
    };
    this.activeAttempt = active;
    this.abortActiveAttemptIfPending();

    return {
      signal: active.controller.signal,
      dispose: (): void => {
        if (active.disposed) return;
        active.disposed = true;
        if (this.activeAttempt === active) this.activeAttempt = undefined;
      },
    };
  }

  /**
   * Acknowledge the durable batch applied through `throughSequence`.
   * Notifications above this watermark remain pending, closing the drain/reset
   * race without requiring one process-local notification per inbox entry.
   */
  consume(throughSequence: number): void {
    assertSteeringSequence(throughSequence, true);
    if (throughSequence <= this.consumedThrough) return;
    this.consumedThrough = throughSequence;
    // A restored durable batch can be consumed without a matching process-local
    // notify. Advance the observed floor so delayed duplicate notify calls do
    // not cause a spurious provider cancellation.
    if (throughSequence > this.notifiedThrough) {
      this.notifiedThrough = throughSequence;
    }
    this.abortActiveAttemptIfPending();
  }

  /**
   * Start a new logical-turn lifecycle at a durable consumed watermark.
   * Reset is intentionally forbidden while a provider attempt is active: doing
   * so could orphan the request or erase an unhandled wakeup.
   */
  reset(consumedThroughSequence = 0): void {
    assertSteeringSequence(consumedThroughSequence, true);
    if (this.activeAttempt) {
      throw new Error("Cannot reset steering notifications during an active attempt");
    }
    this.notifiedThrough = consumedThroughSequence;
    this.consumedThrough = consumedThroughSequence;
  }

  private abortActiveAttemptIfPending(): void {
    if (!this.pending || !this.activeAttempt) return;
    if (!this.activeAttempt.controller.signal.aborted) {
      this.activeAttempt.controller.abort();
    }
  }
}

function assertSteeringSequence(sequence: number, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(sequence) || sequence < minimum) {
    throw new Error(
      `Steering sequence must be a safe integer greater than or equal to ${String(minimum)}`,
    );
  }
}
