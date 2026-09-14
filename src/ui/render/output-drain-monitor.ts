// A stalled terminal is a frontend failure, not a model/runtime timeout. Keep
// the value local to the renderer so it cannot become user configuration.
const OUTPUT_DRAIN_TIMEOUT_MS = 5_000;

export interface OutputDrainMonitorOptions {
  readonly onDrain?: () => void;
  readonly onFailure?: (error: Error) => void;
}

/**
 * Shared Writable backpressure supervision for terminal renderers.
 *
 * Node accepts the write that returns false, but callers must wait for drain
 * before producing more replaceable frames. This class owns that small state
 * machine and turns a permanently stalled output into one explicit UI fault.
 */
export class OutputDrainMonitor {
  private blocked = false;
  private closed = false;
  private failed = false;
  private drainTimer?: NodeJS.Timeout;
  private readonly onDrain = (): void => {
    if (this.closed || this.failed) return;
    this.blocked = false;
    this.clearTimer();
    try {
      this.options.onDrain?.();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  constructor(
    private readonly output: NodeJS.WritableStream,
    private readonly options: Readonly<OutputDrainMonitorOptions> = {},
  ) {}

  get isBlocked(): boolean {
    return this.blocked;
  }

  write(value: string, allowWhileBlocked = false): boolean {
    if (!value || this.closed || this.failed) return !this.blocked;
    if (this.blocked && !allowWhileBlocked) return false;
    try {
      const accepted = this.output.write(value);
      if (!accepted && !this.blocked) {
        this.blocked = true;
        this.output.once("drain", this.onDrain);
        this.drainTimer = setTimeout(() => {
          this.fail(new Error(
            `Terminal output did not drain within ${OUTPUT_DRAIN_TIMEOUT_MS}ms.`,
          ));
        }, OUTPUT_DRAIN_TIMEOUT_MS);
        this.drainTimer.unref();
      }
      return accepted;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.output.removeListener("drain", this.onDrain);
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
  }

  private fail(error: Error): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.output.removeListener("drain", this.onDrain);
    this.clearTimer();
    this.options.onFailure?.(error);
  }
}
