export type ProviderAttemptAbortSource = "turn" | "steering";

export interface ProviderAttemptSignal {
  /** Pass this signal only to the active provider request attempt. */
  readonly signal: AbortSignal;
  /**
   * Why the active attempt was canceled. A turn cancellation takes priority
   * if it races with steering so Ctrl+C can never be mistaken for a retry.
   */
  readonly abortSource: ProviderAttemptAbortSource | undefined;
  /** Detach source listeners after the provider attempt settles. */
  dispose(): void;
}

export interface ProviderAttemptSignalOptions {
  /** Long-lived cancellation for the complete logical turn (for example Ctrl+C). */
  readonly turnSignal?: AbortSignal;
  /** One-shot cancellation used to replace only the active provider attempt. */
  readonly steeringSignal?: AbortSignal;
}

/**
 * Combine logical-turn and steering cancellation for one provider attempt.
 *
 * The returned controller is intentionally private to this scope: aborting a
 * steering signal cancels the current HTTP/provider request without aborting
 * the logical turn. The caller can then dispose this scope, create a fresh
 * steering signal, and retry with updated messages. Completed responses,
 * usage, and audit events remain the caller's responsibility and are not
 * mutated here.
 */
export function createProviderAttemptSignal(
  options: ProviderAttemptSignalOptions = {},
): ProviderAttemptSignal {
  const controller = new AbortController();
  const { turnSignal, steeringSignal } = options;
  let observedTurnAbort = false;
  let observedSteeringAbort = false;
  let disposed = false;

  const forwardAbort = (
    source: ProviderAttemptAbortSource,
    sourceSignal: AbortSignal,
  ): void => {
    if (source === "turn") observedTurnAbort = true;
    else observedSteeringAbort = true;
    if (!controller.signal.aborted) {
      controller.abort(sourceSignal.reason);
    }
  };
  const onTurnAbort = (): void => {
    if (turnSignal) forwardAbort("turn", turnSignal);
  };
  const onSteeringAbort = (): void => {
    if (steeringSignal) forwardAbort("steering", steeringSignal);
  };

  turnSignal?.addEventListener("abort", onTurnAbort, { once: true });
  steeringSignal?.addEventListener("abort", onSteeringAbort, { once: true });

  // Close listener-registration races. Check the turn first so two signals
  // that were already aborted are represented as a terminal turn cancel.
  if (turnSignal?.aborted) {
    onTurnAbort();
  } else if (steeringSignal?.aborted) {
    onSteeringAbort();
  }

  return {
    signal: controller.signal,
    get abortSource(): ProviderAttemptAbortSource | undefined {
      // The combined AbortSignal retains its first reason. Classification must
      // still let a near-simultaneous Ctrl+C override a steering retry.
      if (observedTurnAbort) return "turn";
      if (observedSteeringAbort) return "steering";
      return undefined;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      turnSignal?.removeEventListener("abort", onTurnAbort);
      steeringSignal?.removeEventListener("abort", onSteeringAbort);
    },
  };
}
