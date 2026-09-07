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
  it("rejects a duplicated program before resolution, approval, or process preparation", async () => {
    await withTool(async (root, tool, backend) => {
      const result = await tool.execute(
        {
          program: "definitely-not-an-installed-program",
          args: ["definitely-not-an-installed-program", "--version"],
          intent: "inspect",
        },
        context(root),
      );

      assert.equal(result.ok, false);
      assert.equal(backend.prepareCalls, 0);
      const output = result.data as {
        status: string;
        policyDecision: { matchedRule: string; recommendation?: string };
        failure: { kind: string; processStarted: boolean };
      };
      assert.equal(output.status, "policy_denied");
      assert.equal(output.failure.kind, "parameter");
      assert.equal(output.failure.processStarted, false);
      assert.equal(output.policyDecision.matchedRule, "input.duplicate_program_argument");
      assert.match(output.policyDecision.recommendation ?? "", /remove.*args/iu);
      assert.match(result.error ?? "", /process was not started/iu);
      assert.match(result.error ?? "", /Recovery:.*remove.*args/iu);
    });
  });

  it("does not let unrestricted mode bypass wait/detach input rejection", async () => {
    await withTool(async (root, tool, backend) => {
      const result = await tool.execute(
        { program: "sleep", args: ["30"], intent: "run" },
        {
          ...context(root),
          commandExecutionMode: "unrestricted",
          isUnrestrictedHostAccessActive: () => true,
        },
      );

      assert.equal(result.ok, false);
      assert.equal(backend.prepareCalls, 0);
      assert.equal(
        (result.data as { policyDecision: { matchedRule: string } }).policyDecision.matchedRule,
        "input.async_workaround",
      );
      assert.match(result.error ?? "", /real executable directly/iu);
      assert.match(result.error ?? "", /timeoutMs/u);
    });
  });

  it("does not let unrestricted mode bypass explicit-shell lifecycle supervision", async () => {
    await withTool(async (root, tool, backend) => {
      for (const input of [
        {
          program: "sh",
          args: ["-c", "echo ready\nsleep 30"],
          intent: "run" as const,
        },
        {
          program: "powershell",
          args: ["-Command", "saps node -ArgumentList '--version'"],
          intent: "run" as const,
        },
      ]) {
        const result = await tool.execute(input, {
          ...context(root),
          commandExecutionMode: "unrestricted",
          isUnrestrictedHostAccessActive: () => true,
        });

        assert.equal(result.ok, false);
        assert.equal(
          (result.data as { policyDecision: { matchedRule: string } }).policyDecision.matchedRule,
          "input.shell_protocol",
        );
        assert.match(result.error ?? "", /process was not started/iu);
      }
      assert.equal(backend.prepareCalls, 0);
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
        effectiveMs: 60_000,
        configuredLimitMs: 2 * 60_000,
        capabilityLimitMs: 60_000,
      });
      assert.match(result.summary, /requested=1800000ms/u);
      assert.match(result.summary, /effective=60000ms/u);
      assert.match(result.summary, /configured limit=120000ms/u);
      assert.match(result.summary, /capability limit=60000ms/u);
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
