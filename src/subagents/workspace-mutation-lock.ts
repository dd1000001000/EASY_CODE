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
  readonly owner: string | undefined;
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
 * A small Node 20-compatible mutex for operations that may modify one shared
 * workspace. Ordinary operations are FIFO. A declared service reserves the
 * workspace for its owning agent without holding the short-operation mutex:
 * that agent may continue to work while other agents remain excluded. A
 * background job still holds the mutex until it settles. Cancellation affects
 * only queued callers.
 */
export class WorkspaceMutationLock {
  private locked = false;
  private currentOwner: string | undefined;
  private serviceOwner: string | undefined;
  private serviceLeases = 0;
  private readonly waiters: LockWaiter[] = [];

  async runExclusive<Result>(
    operation: () => Promise<Result> | Result,
    signal?: AbortSignal,
    owner?: string,
  ): Promise<Result> {
    const release = await this.acquire(signal, owner);
    try {
      if (signal?.aborted) throw new WorkspaceMutationLockAbortError();
      return await operation();
    } finally {
      release();
    }
  }

  /** Acquire a lease that the caller may retain across an asynchronous operation. */
  acquire(signal?: AbortSignal, owner?: string): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new WorkspaceMutationLockAbortError());
    }

    return new Promise((resolve, reject) => {
      const waiter: LockWaiter = {
        signal,
        owner,
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

  /** Convert an acquired service start into an owner reservation. The caller
   * must still release its short-operation lock after registering the lease. */
  retainService(owner: string): () => void {
    if (!this.locked || this.currentOwner !== owner ||
      (this.serviceOwner !== undefined && this.serviceOwner !== owner)) {
      throw new Error("Service lease requires the owning agent's acquired workspace lock");
    }
    this.serviceOwner = owner;
    this.serviceLeases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.serviceLeases -= 1;
      if (this.serviceLeases === 0) {
        this.serviceOwner = undefined;
        this.dispatch();
      }
    };
  }

  private dispatch(): void {
    if (this.locked) return;

    while (this.waiters.length > 0) {
      const index = this.serviceOwner === undefined
        ? 0
        : this.waiters.findIndex((candidate) => candidate.owner === this.serviceOwner);
      if (index < 0) return;
      const [waiter] = this.waiters.splice(index, 1);
      if (!waiter || waiter.canceled) continue;
      if (waiter.signal?.aborted) {
        waiter.canceled = true;
        this.removeAbortListener(waiter);
        waiter.reject(new WorkspaceMutationLockAbortError());
        continue;
      }

      this.locked = true;
      this.currentOwner = waiter.owner;
      this.removeAbortListener(waiter);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.locked = false;
        this.currentOwner = undefined;
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

function mutationOwner(context: Parameters<AgentTool["execute"]>[1]): string | undefined {
  if (context.agentRole === "subagent" && !context.agentId) return undefined;
  return JSON.stringify([
    context.threadId,
    context.agentRole ?? "main_agent",
    context.agentId ?? "",
  ]);
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
      get metadata() {
        return tool.metadata;
      },
      get inputSchema() {
        return tool.inputSchema;
      },
      execute(input, context): Promise<ToolExecutionResult> {
        if (tool.name === "start_command") {
          return runCommandStartWithLease(tool, input, context, lock);
        }
        return lock.runExclusive(
          () => tool.execute(input, context),
          context.signal,
          mutationOwner(context),
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
  const owner = mutationOwner(context);
  const serviceRequested = input !== null && typeof input === "object" &&
    (input as { backgroundKind?: unknown }).backgroundKind === "service";
  if (serviceRequested && !owner) {
    throw new Error("Service mode requires a Runtime-issued agent identity");
  }
  const release = await lock.acquire(context.signal, owner);
  let releaseOnCompletion = false;
  try {
    if (context.signal?.aborted) throw new WorkspaceMutationLockAbortError();
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
      if (serviceRequested) {
        const releaseService = lock.retainService(owner!);
        void settlement.then(releaseService, releaseService);
      } else {
        releaseOnCompletion = true;
        void settlement.then(release, release);
      }
    }
    return result;
  } finally {
    if (!releaseOnCompletion) release();
  }
}
