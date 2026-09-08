import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { CommandPolicy, CommandRuntime } from "../src/command/index.js";
import type { ToolContext } from "../src/core/types.js";
import type {
  CommandExecutionBackend,
  PreparedCommand,
} from "../src/sandbox/index.js";
import {
  CancelCommandTool,
  PollCommandTool,
  RunCommandTool,
  StartCommandTool,
} from "../src/tools/index.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

class TrackingHostBackend implements CommandExecutionBackend {
  prepareCalls = 0;

  describe(): PreparedCommand["metadata"] {
    return {
      backend: "host-test-only",
      enforced: false,
      filesystem: "host",
      network: "host",
    };
  }

  async prepare(
    request: Parameters<CommandExecutionBackend["prepare"]>[0],
  ): Promise<PreparedCommand> {
    this.prepareCalls += 1;
    return {
      executablePath: request.command.executablePath,
      args: [...request.command.args],
      cwdAbsolute: request.command.cwdAbsolute,
      environment: { ...request.command.environment },
      metadata: this.describe(),
      cleanup: async () => undefined,
    };
  }
}

function context(root: string, timeoutMs = 120_000): ToolContext {
  return {
    workspaceRoot: root,
    mode: "code",
    threadId: "thread-command-contract",
    turnId: "turn-command-contract",
    approvalPolicy: "safe",
    requestApproval: async () => true,
    commandTimeoutMs: timeoutMs,
    maxOutputChars: 4_096,
  };
}

async function withTool(
  run: (
    root: string,
    tool: RunCommandTool,
    backend: TrackingHostBackend,
    lifecycle: {
      start: StartCommandTool;
      poll: PollCommandTool;
      cancel: CancelCommandTool;
    },
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(process.cwd(), ".easy-code-command-contract-"));
  try {
    const manager = await WorkspaceManager.create(root);
    const backend = new TrackingHostBackend();
    const runtime = new CommandRuntime(manager, new CommandPolicy(), backend, backend);
    await run(root, new RunCommandTool(manager, runtime), backend, {
      start: new StartCommandTool(manager, runtime),
      poll: new PollCommandTool(manager, runtime),
      cancel: new CancelCommandTool(manager, runtime),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("run_command model contract", () => {
  it("normalizes optional verification metadata without another model call", async () => {
    await withTool(async (root, tool, backend) => {
      const valid = await tool.execute(
        {
          program: "node",
          args: ["--version"],
          intent: "verify",
          verificationKind: "smoke_test",
        },
        context(root),
      );
      assert.equal(valid.ok, true);

      const missingKind = await tool.execute(
        { program: "node", args: ["--version"], intent: "verify" },
        context(root),
      );
      assert.equal(missingKind.ok, true);
      assert.equal((missingKind.data as { requestMetadata: { verificationKind: string } }).requestMetadata.verificationKind, "custom");

      const misplacedKind = await tool.execute(
        {
          program: "node",
          args: ["--version"],
          intent: "inspect",
          verificationKind: "smoke_test",
        },
        context(root),
      );
      assert.equal(misplacedKind.ok, true);
      assert.equal((misplacedKind.data as { requestMetadata: { verificationKind?: string } }).requestMetadata.verificationKind, undefined);
      assert.equal(backend.prepareCalls, 3);
      const invalidKind = await tool.execute({ program: "node", args: ["--version"], intent: "verify", verificationKind: { wrong: true } }, context(root));
      assert.equal(invalidKind.ok, true);
      const missingProgram = await tool.execute({ args: ["--version"], intent: "inspect" }, context(root));
      assert.equal(missingProgram.ok, false);
      assert.equal(backend.prepareCalls, 4);
    });
  });

  it("does not guess or remove a same-named script argument", async () => {
    await withTool(async (root, tool, backend) => {
      await writeFile(path.join(root, "node"), "console.log('same-named-script')");
      const result = await tool.execute(
        {
          program: "node",
          args: ["node"],
          intent: "inspect",
        },
        context(root),
      );

      assert.equal(result.ok, true);
      assert.equal(backend.prepareCalls, 1);
      assert.match((result.data as { stdout: { text: string } }).stdout.text, /same-named-script/u);
    });
  });

  it("uses approval, not shell syntax, as the command authorization boundary", async () => {
    await withTool(async (root, tool, backend) => {
      const command = process.platform === "win32"
        ? { program: "powershell", args: ["-NoProfile", "-Command", "Write-Output 'shell-approved'"], intent: "run" as const }
        : { program: "sh", args: ["-c", "printf shell-approved"], intent: "run" as const };
      const result = await tool.execute(command, { ...context(root), commandExecutionMode: "manual" });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(backend.prepareCalls, 1);
      const denied = await tool.execute(command, { ...context(root), requestApproval: async () => false });
      assert.equal(denied.ok, false);
      assert.equal(backend.prepareCalls, 1);
      assert.equal((denied.data as { failure: { kind: string } }).failure.kind, "approval");
    });
  });

  it("returns and displays the exact requested and capability-capped timeout", async () => {
    await withTool(async (root, tool) => {
      const result = await tool.execute(
        {
          program: "node",
          args: ["--version"],
          intent: "inspect",
          timeoutMs: 30 * 60_000,
        },
        context(root, 2 * 60_000),
      );

      assert.equal(result.ok, true);
      const output = result.data as {
        timeout: {
          requestedMs: number;
          effectiveMs: number;
          configuredLimitMs: number;
          capabilityLimitMs: number;
        };
      };
      assert.deepEqual(output.timeout, {
        requestedMs: 30 * 60_000,
        effectiveMs: 120_000,
        configuredLimitMs: 2 * 60_000,
        capabilityLimitMs: 900_000,
      });
      assert.match(result.summary, /requested=1800000ms/u);
      assert.match(result.summary, /effective=120000ms/u);
      assert.match(result.summary, /configured limit=120000ms/u);
      assert.match(result.summary, /capability limit=900000ms/u);
    });
  });

  it("keeps one timeout budget across start, status, and terminal cancellation", async () => {
    await withTool(async (root, _tool, _backend, lifecycle) => {
      await writeFile(
        path.join(root, "linger.cjs"),
        "setInterval(() => process.stdout.write('tick\\n'), 100);\n",
        "utf8",
      );
      const toolContext = context(root, 2_000);
      const started = await lifecycle.start.execute(
        {
          program: "node",
          args: ["linger.cjs"],
          intent: "test",
          timeoutMs: 5_000,
        },
        toolContext,
      );
      assert.equal(started.ok, true);
      const running = started.data as {
        commandId: string;
        status: string;
        timeout: Record<string, number>;
      };
      assert.equal(running.status, "running");
      assert.deepEqual(running.timeout, {
        requestedMs: 5_000,
        effectiveMs: 2_000,
        configuredLimitMs: 2_000,
        capabilityLimitMs: 15 * 60_000,
      });

      const polled = await lifecycle.poll.execute(
        { commandId: running.commandId, waitMs: 0 },
        toolContext,
      );
      assert.equal((polled.data as { status: string }).status, "running");
      assert.deepEqual(
        (polled.data as { timeout: Record<string, number> }).timeout,
        running.timeout,
      );

      const canceled = await lifecycle.cancel.execute(
        { commandId: running.commandId },
        toolContext,
      );
      assert.equal(canceled.ok, true);
      assert.equal((canceled.data as { status: string }).status, "canceled");
      assert.deepEqual(
        (canceled.data as { timeout: Record<string, number> }).timeout,
        running.timeout,
      );
    });
  });
});
