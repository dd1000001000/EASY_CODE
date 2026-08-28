import assert from "node:assert/strict";

import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolName,
} from "../src/core/types.js";
import {
  WorkspaceMutationLock,
  WorkspaceMutationLockAbortError,
  wrapAgentToolsWithWorkspaceMutationLock,
} from "../src/subagents/workspace-mutation-lock.js";
import { describe, it } from "./harness.js";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function context(signal?: AbortSignal): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    mode: "code",
    threadId: "thread_workspace_lock",
    turnId: "turn_workspace_lock",
    approvalPolicy: "never",
    requestApproval: async () => false,
    signal,
    commandTimeoutMs: 1_000,
    maxOutputChars: 4_096,
  };
}

function result(summary: string): ToolExecutionResult {
  return { ok: true, summary };
}

function fakeTool(
  name: ToolName,
  execute: AgentTool["execute"],
): AgentTool {
  const definition: ToolDefinition = {
    type: "function",
    function: {
      name,
      description: `${name} fixture`,
      parameters: { type: "object" },
    },
  };
  return {
    name,
    definition,
    mutating: name !== "read_file",
    execute,
  };
}

describe("WorkspaceMutationLock", () => {
  it("runs the four workspace mutation tools in FIFO order", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];
    const tools = [
      fakeTool("create_file", async () => {
        order.push("create:start");
        firstStarted.resolve();
        await releaseFirst.promise;
        order.push("create:end");
        return result("created");
      }),
      fakeTool("update_file", async () => {
        order.push("update:start", "update:end");
        return result("updated");
      }),
      fakeTool("delete_file", async () => {
        order.push("delete:start", "delete:end");
        return result("deleted");
      }),
      fakeTool("run_command", async () => {
        order.push("command:start", "command:end");
        return result("ran");
      }),
    ];
    const wrapped = wrapAgentToolsWithWorkspaceMutationLock(
      tools,
      new WorkspaceMutationLock(),
    );

    const executions = [
      wrapped[0]!.execute({}, context()),
      wrapped[1]!.execute({}, context()),
      wrapped[2]!.execute({}, context()),
      wrapped[3]!.execute({}, context()),
    ];
    await firstStarted.promise;
    assert.deepEqual(order, ["create:start"]);
    releaseFirst.resolve();
    await Promise.all(executions);

    assert.deepEqual(order, [
      "create:start",
      "create:end",
      "update:start",
      "update:end",
      "delete:start",
      "delete:end",
      "command:start",
      "command:end",
    ]);
  });

  it("leaves other tools unwrapped and preserves wrapped tool metadata and receiver", async () => {
    const expected = result("created");
    let receiver: AgentTool | undefined;
    const create = fakeTool("create_file", async function (this: AgentTool) {
      receiver = this;
      return expected;
    });
    const read = fakeTool("read_file", async () => result("read"));
    const wrapped = wrapAgentToolsWithWorkspaceMutationLock(
      [create, read],
      new WorkspaceMutationLock(),
    );

    assert.notEqual(wrapped[0], create);
    assert.equal(wrapped[1], read);
    assert.equal(wrapped[0]!.name, create.name);
    assert.equal(wrapped[0]!.definition, create.definition);
    assert.equal(wrapped[0]!.mutating, create.mutating);
    assert.equal(await wrapped[0]!.execute({}, context()), expected);
    assert.equal(receiver, create);
  });

  it("cancels a queued caller without blocking later FIFO waiters", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];
    const tools = [
      fakeTool("create_file", async () => {
        order.push("first:start");
        firstStarted.resolve();
        await releaseFirst.promise;
        order.push("first:end");
        return result("first");
      }),
      fakeTool("update_file", async () => {
        order.push("canceled:unexpected");
        return result("canceled");
      }),
      fakeTool("delete_file", async () => {
        order.push("third:start", "third:end");
        return result("third");
      }),
      fakeTool("run_command", async () => {
        order.push("fourth:start", "fourth:end");
        return result("fourth");
      }),
    ];
    const wrapped = wrapAgentToolsWithWorkspaceMutationLock(
      tools,
      new WorkspaceMutationLock(),
    );
    const canceled = new AbortController();

    const first = wrapped[0]!.execute({}, context());
    await firstStarted.promise;
    const second = wrapped[1]!.execute({}, context(canceled.signal));
    const third = wrapped[2]!.execute({}, context());
    canceled.abort();
    await assert.rejects(
      second,
      (error: unknown) =>
        error instanceof WorkspaceMutationLockAbortError && error.name === "AbortError",
    );

    releaseFirst.resolve();
    await Promise.all([first, third]);
    await wrapped[3]!.execute({}, context());
    assert.deepEqual(order, [
      "first:start",
      "first:end",
      "third:start",
      "third:end",
      "fourth:start",
      "fourth:end",
    ]);
  });

  it("does not release the lock early when an executing caller is aborted", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondStarted = deferred<void>();
    const activeController = new AbortController();
    const tools = [
      fakeTool("create_file", async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return result("first");
      }),
      fakeTool("update_file", async () => {
        secondStarted.resolve();
        return result("second");
      }),
    ];
    const wrapped = wrapAgentToolsWithWorkspaceMutationLock(
      tools,
      new WorkspaceMutationLock(),
    );

    const first = wrapped[0]!.execute({}, context(activeController.signal));
    await firstStarted.promise;
    const second = wrapped[1]!.execute({}, context());
    let secondRan = false;
    void secondStarted.promise.then(() => {
      secondRan = true;
    });
    activeController.abort();
    await Promise.resolve();
    assert.equal(secondRan, false);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.equal(secondRan, true);
  });

  it("releases the lock when the delegated tool throws", async () => {
    const secondStarted = deferred<void>();
    const tools = [
      fakeTool("create_file", async () => {
        throw new Error("fixture failure");
      }),
      fakeTool("update_file", async () => {
        secondStarted.resolve();
        return result("recovered");
      }),
    ];
    const wrapped = wrapAgentToolsWithWorkspaceMutationLock(
      tools,
      new WorkspaceMutationLock(),
    );

    const first = wrapped[0]!.execute({}, context());
    const second = wrapped[1]!.execute({}, context());
    await assert.rejects(first, /fixture failure/u);
    assert.equal((await second).summary, "recovered");
    await secondStarted.promise;
  });
});
