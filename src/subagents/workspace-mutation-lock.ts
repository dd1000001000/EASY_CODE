import type {
  AgentTool,
  ToolExecutionResult,
  ToolName,
} from "../core/types.js";

const SERIALIZED_WORKSPACE_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  "create_file",
  "update_file",
  "delete_file",
  "run_command",
  "start_command",
]);

interface LockWaiter {
  readonly signal: AbortSignal | undefined;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  onAbort?: () => void;
  canceled: boolean;
}

/** Cancellation raised before a queued workspace mutation begins. */
export class WorkspaceMutationLockAbortError extends Error {
  constructor() {
    super("Workspace mutation was canceled while waiting for the shared lock");
    this.name = "AbortError";
  }
}

/**
 * A small Node 20-compatible FIFO mutex for operations that may modify one
 * shared workspace. Cancellation affects only callers that have not started;
 * once an operation owns the lock, its own ToolContext signal controls it and
 * the lock remains held until the operation settles.
 */
export class WorkspaceMutationLock {
  private locked = false;
  private readonly waiters: LockWaiter[] = [];

  async runExclusive<Result>(
    operation: () => Promise<Result> | Result,
    signal?: AbortSignal,
  ): Promise<Result> {
    const release = await this.acquire(signal);
    try {
      if (signal?.aborted) throw new WorkspaceMutationLockAbortError();
      return await operation();
    } finally {
      release();
    }
  }

  /** Acquire a lease that the caller may retain across an asynchronous operation. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new WorkspaceMutationLockAbortError());
    }

    return new Promise((resolve, reject) => {
      const waiter: LockWaiter = {
        signal,
        resolve,
        reject,
        canceled: false,
      };

      const onAbort = (): void => {
        if (waiter.canceled) return;
        waiter.canceled = true;
        this.removeWaiter(waiter);
        this.removeAbortListener(waiter);
        reject(new WorkspaceMutationLockAbortError());
        this.dispatch();
      };
      waiter.onAbort = onAbort;
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });

      // Close the small race between the initial check and listener setup.
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.locked) return;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.canceled) continue;
      if (waiter.signal?.aborted) {
        waiter.canceled = true;
        this.removeAbortListener(waiter);
        waiter.reject(new WorkspaceMutationLockAbortError());
        continue;
      }

      this.locked = true;
      this.removeAbortListener(waiter);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.locked = false;
        this.dispatch();
      });
      return;
    }
  }

  private removeWaiter(waiter: LockWaiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private removeAbortListener(waiter: LockWaiter): void {
    if (!waiter.onAbort) return;
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.onAbort = undefined;
  }
}

/**
 * Wrap only tools whose execution may mutate the shared workspace. Untargeted
 * tools retain object identity; targeted wrappers delegate metadata through
 * getters and invoke the original tool as its own receiver.
 */
export function wrapAgentToolsWithWorkspaceMutationLock(
  tools: readonly AgentTool[],
  lock: WorkspaceMutationLock,
): AgentTool[] {
  return tools.map((tool) => {
    if (!SERIALIZED_WORKSPACE_TOOL_NAMES.has(tool.name)) return tool;

    return {
      get name() {
        return tool.name;
      },
      get definition() {
        return tool.definition;
      },
      get mutating() {
        return tool.mutating;
      },
      execute(input, context): Promise<ToolExecutionResult> {
        if (tool.name === "start_command") {
          return runCommandStartWithLease(tool, input, context, lock);
        }
        return lock.runExclusive(
          () => tool.execute(input, context),
          context.signal,
        );
      },
    };
  });
}

interface AsyncCommandLifecycleTool extends AgentTool {
  whenCommandSettled(commandId: string): Promise<void> | undefined;
}

function hasAsyncCommandLifecycle(tool: AgentTool): tool is AsyncCommandLifecycleTool {
  return "whenCommandSettled" in tool &&
    typeof (tool as Partial<AsyncCommandLifecycleTool>).whenCommandSettled === "function";
}

async function runCommandStartWithLease(
  tool: AgentTool,
  input: unknown,
  context: Parameters<AgentTool["execute"]>[1],
  lock: WorkspaceMutationLock,
): Promise<ToolExecutionResult> {
  const release = await lock.acquire(context.signal);
  let releaseOnCompletion = false;
  try {
    const result = await tool.execute(input, context);
    const data = result.data && typeof result.data === "object"
      ? result.data as { commandId?: unknown; status?: unknown }
      : undefined;
    if (
      result.ok &&
      data?.status === "running" &&
      typeof data.commandId === "string"
    ) {
      if (!hasAsyncCommandLifecycle(tool)) {
        throw new Error("start_command returned no Runtime completion lifecycle");
      }
      const settlement = tool.whenCommandSettled(data.commandId);
      if (!settlement) {
        throw new Error("start_command returned an unknown Runtime command handle");
      }
      releaseOnCompletion = true;
      void settlement.then(release, release);
    }
    return result;
  } finally {
    if (!releaseOnCompletion) release();
  }
}
