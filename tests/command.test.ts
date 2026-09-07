import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApprovalRequest, CommandAuditEntry, ToolContext } from "../src/core/types.js";
import {
  analyzeNpmInstall,
  buildCommandEnvironment,
  buildUnrestrictedCommandEnvironment,
  CommandPolicy,
  CommandResolver,
  CommandRuntime,
  inspectExplicitShellInvocation,
  normalizeExplicitShellArgs,
  sanitizeCommandOutput,
  type RunCommandInput,
} from "../src/command/index.js";
import type {
  CommandExecutionBackend,
  PreparedCommand,
} from "../src/sandbox/index.js";
import {
  CancelCommandTool,
  PollCommandTool,
  RunCommandTool as ProductionRunCommandTool,
  StartCommandTool,
} from "../src/tools/index.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

class HostCommandBackend implements CommandExecutionBackend {
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

class RunCommandTool extends ProductionRunCommandTool {
  constructor(manager: WorkspaceManager) {
    super(
      manager,
      new CommandRuntime(manager, new CommandPolicy(), new HostCommandBackend()),
    );
  }
}

function commandTools(manager: WorkspaceManager): {
  run: RunCommandTool;
  start: StartCommandTool;
  poll: PollCommandTool;
  cancel: CancelCommandTool;
  runtime: CommandRuntime;
} {
  const run = new RunCommandTool(manager);
  return {
    run,
    start: new StartCommandTool(manager, run.runtime),
    poll: new PollCommandTool(manager, run.runtime),
    cancel: new CancelCommandTool(manager, run.runtime),
    runtime: run.runtime,
  };
}

async function withWorkspace(run: (root: string, manager: WorkspaceManager) => Promise<void>): Promise<void> {
  // Keep spawned-process fixtures under the checked-out workspace. Some CI and
  // agent sandboxes allow the parent process to create OS temp files but deny a
  // child process while it resolves the user's profile-backed temp directory.
  const root = await mkdtemp(path.join(process.cwd(), ".easy-code-command-"));
  try {
    const manager = await WorkspaceManager.create(root);
    await run(root, manager);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function context(
  root: string,
  options: {
    mode?: ToolContext["mode"];
    approvalPolicy?: ToolContext["approvalPolicy"];
    commandExecutionMode?: ToolContext["commandExecutionMode"];
    approve?: boolean;
    approvals?: ApprovalRequest[];
    audit?: CommandAuditEntry[];
    timeoutMs?: number;
    maxOutputChars?: number;
  } = {},
): ToolContext {
  return {
    workspaceRoot: root,
    mode: options.mode ?? "code",
    threadId: "thread-command",
    turnId: "turn-command",
    approvalPolicy: options.approvalPolicy ?? "safe",
    commandExecutionMode: options.commandExecutionMode,
    requestApproval: async (request) => {
      options.approvals?.push(request);
      return options.approve ?? false;
    },
    commandTimeoutMs: options.timeoutMs ?? 2_000,
    maxOutputChars: options.maxOutputChars ?? 4_096,
    recordCommand: (entry) => options.audit?.push(entry),
  };
}

function explicitShellInput(command: string): RunCommandInput {
  return process.platform === "win32"
    ? {
        program: "cmd",
        args: ["/s", "/c", command],
        intent: "run",
        reason: "Run an explicit one-shot Windows shell command",
      }
    : {
        program: "sh",
        args: ["-c", command],
        intent: "run",
        reason: "Run an explicit one-shot POSIX shell command",
      };
}

describe("command runtime", () => {
  it("normalizes shell hosts and rejects encoded or login protocols", () => {
    assert.deepEqual(
      normalizeExplicitShellArgs("cmd", ["/c", "dir"]),
      ["/d", "/c", "dir"],
    );
    assert.deepEqual(
      normalizeExplicitShellArgs("cmd", ["/c", "dir", "/d"]),
      ["/d", "/c", "dir", "/d"],
    );
    assert.deepEqual(
      normalizeExplicitShellArgs("powershell", ["-Command", "Get-ChildItem"]),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem"],
    );
    assert.equal(
      inspectExplicitShellInvocation("powershell", ["-EncodedCommand", "ZQBjAGgAbwA="])?.valid,
      false,
    );
    assert.equal(inspectExplicitShellInvocation("bash", ["-lc", "pwd"])?.valid, false);
    assert.equal(inspectExplicitShellInvocation("sh", ["-c", "pwd"])?.valid, true);
    assert.equal(
      inspectExplicitShellInvocation("sh", ["-c", "node test.js > test.log 2>&1"])?.valid,
      true,
    );
    assert.equal(
      inspectExplicitShellInvocation("sh", ["-c", "node test.js &> test.log"])?.valid,
      true,
    );
    assert.equal(
      inspectExplicitShellInvocation("sh", [
        "-c",
        "printf '%s\\n' 'sleep 10 &' # sleep 30 &",
      ])?.valid,
      true,
    );
    assert.equal(
      inspectExplicitShellInvocation("powershell", [
        "-Command",
        "Write-Output 'Start-Process node &' # Start-Sleep 30",
      ])?.valid,
      true,
    );
    assert.equal(
      inspectExplicitShellInvocation("powershell", ["-Command", "node test.js 2>&1"])?.valid,
      true,
    );
    assert.equal(
      inspectExplicitShellInvocation("cmd", ["/c", "rem start /b node"])?.valid,
      true,
    );
    assert.match(
      inspectExplicitShellInvocation("sh", ["-c", "node test.js &"])?.reason ?? "",
      /synchronous run_command/u,
    );
    assert.match(
      inspectExplicitShellInvocation("sh", ["-c", "sleep 5; tail test.log"])?.reason ?? "",
      /timeoutMs/u,
    );
    assert.match(
      inspectExplicitShellInvocation("powershell", ["-Command", "Start-Sleep 5"])?.reason ?? "",
      /timeoutMs/u,
    );
    assert.match(
      inspectExplicitShellInvocation("cmd", ["/c", "timeout /t 5"])?.reason ?? "",
      /timeoutMs/u,
    );
    assert.match(
      inspectExplicitShellInvocation("sh", ["-c", "echo ready\nsleep 5"])?.reason ?? "",
      /timeoutMs/u,
    );
    assert.match(
      inspectExplicitShellInvocation("sh", ["-c", "e''val 'node test.js &'"])?.reason ?? "",
      /eval/iu,
    );
    assert.match(
      inspectExplicitShellInvocation("sh", ["-c", "sh -c 'node test.js &'"])?.reason ?? "",
      /nested shell/iu,
    );
    assert.match(
      inspectExplicitShellInvocation("sh", ["-c", "node <<EOF\ninput\nEOF"])?.reason ?? "",
      /heredoc/iu,
    );
    assert.match(
      inspectExplicitShellInvocation("powershell", [
        "-Command",
        "Write-Output ready\r\nStart-Process node",
      ])?.reason ?? "",
      /synchronous run_command/u,
    );
    assert.match(
      inspectExplicitShellInvocation("powershell", ["-Command", "& 'node' test.js"])?.reason ?? "",
      /call\/background/iu,
    );
    for (const command of [
      "start node",
      "saps node",
      "sajb { Get-ChildItem }",
      "Start-ThreadJob { Get-ChildItem }",
    ]) {
      assert.match(
        inspectExplicitShellInvocation("powershell", ["-Command", command])?.reason ?? "",
        /synchronous run_command/u,
      );
    }
    assert.match(
      inspectExplicitShellInvocation("powershell", ["-Command", "iex 'Start-Process node'"])?.reason ?? "",
      /expression dispatch/iu,
    );
    assert.match(
      inspectExplicitShellInvocation("powershell", [
        "-Command",
        "ForEach-Object -Parallel { Write-Output ok } -AsJob",
      ])?.reason ?? "",
      /-AsJob/iu,
    );
    assert.match(
      inspectExplicitShellInvocation("powershell", [
        "-Command",
        "pwsh -Command 'Start-Process node'",
      ])?.reason ?? "",
      /nested shell/iu,
    );
    assert.match(
      inspectExplicitShellInvocation("cmd", ["/c", "echo ready\r\nstart /b node"])?.reason ?? "",
      /synchronous run_command/u,
    );
    assert.equal(inspectExplicitShellInvocation("zsh", ["-c", "pwd"]), undefined);
    assert.equal(
      sanitizeCommandOutput("cmd /c set TOKEN=top-secret-token-value").includes("top-secret-token-value"),
      false,
    );
    for (const assignment of [
      "GLM_API_KEY=glm-secret-value",
      "GLM_CODING_PLAN_API_KEY=glm-coding-plan-secret-value",
      "ZAI_API_KEY=zai-secret-value",
      "ZHIPUAI_API_KEY=zhipu-secret-value",
    ]) {
      const sanitized = sanitizeCommandOutput(assignment);
      assert.match(sanitized, /\[REDACTED\]/u);
      assert.doesNotMatch(sanitized, /secret-value/u);
    }
    assert.equal(sanitizeCommandOutput("left\u202Eright"), "left\\u{202e}right");
  });

  it("allows a recipe-based Node version inspection in plan mode", async () => {
    await withWorkspace(async (root, manager) => {
      const audit: CommandAuditEntry[] = [];
      const tool = new RunCommandTool(manager);
      const result = await tool.execute(
        { program: "node", args: ["--version"], intent: "inspect" },
        context(root, { mode: "plan", audit }),
      );

      assert.equal(result.ok, true);
      const output = result.data as { stdout: { text: string }; policyDecision: { capability: string } };
      assert.match(output.stdout.text, /^v\d+/u);
      assert.equal(output.policyDecision.capability, "safe_inspect");
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.status, "exited");
    });
  });

  it("runs npm shims directly without enabling a shell", async () => {
    await withWorkspace(async (root, manager) => {
      const tool = new RunCommandTool(manager);
      const result = await tool.execute(
        { program: "npm", args: ["--version"], intent: "inspect" },
        context(root, { mode: "plan" }),
      );
      assert.equal(result.ok, true);
      const output = result.data as { stdout: { text: string }; executed: { program: string } };
      assert.match(output.stdout.text, /^\d+\.\d+/u);
      assert.match(output.executed.program, /npm(?:\.cmd)?$/iu);
    });
  });

  it("runs an explicit one-shot shell after exact approval", async () => {
    await withWorkspace(async (root, manager) => {
      const approvals: ApprovalRequest[] = [];
      const tool = new RunCommandTool(manager);
      const result = await tool.execute(
        explicitShellInput("echo easy-code-shell-ok"),
        context(root, { mode: "code", approve: true, approvals }),
      );

      assert.equal(result.ok, true);
      assert.equal(approvals.length, 1);
      assert.match(approvals[0]?.description ?? "", /exact approval=/u);
      assert.equal(approvals[0]?.risk, "destructive");
      assert.equal(path.isAbsolute(approvals[0]?.commandPrefix ?? ""), true);
      const output = result.data as {
        stdout: { text: string };
        policyDecision: { capability: string; effect: string; matchedRule: string };
        executed: { args: string[] };
      };
      assert.match(output.stdout.text, /easy-code-shell-ok/u);
      assert.equal(output.policyDecision.capability, "shell_exec");
      assert.equal(output.policyDecision.effect, "ask");
      assert.equal(output.policyDecision.matchedRule, "ask.shell_exec");
      if (process.platform === "win32") {
        assert.equal(output.executed.args[0]?.toLowerCase(), "/d");
      }
    });
  });

  it("binds the exact shell script into the approval fingerprint", async () => {
    await withWorkspace(async (_root, manager) => {
      const resolver = new CommandResolver(manager);
      const policy = new CommandPolicy();
      const first = await resolver.resolve(explicitShellInput("echo first"));
      const second = await resolver.resolve(explicitShellInput("echo second"));
      const firstDecision = policy.classify(explicitShellInput("echo first"), first, "code");
      const secondDecision = policy.classify(explicitShellInput("echo second"), second, "code");

      assert.notEqual(
        policy.approvalFingerprint(first, firstDecision),
        policy.approvalFingerprint(second, secondDecision),
      );
    });
  });

  it("keeps explicit shells out of plan mode and disabled approval sessions", async () => {
    await withWorkspace(async (root, manager) => {
      const tool = new RunCommandTool(manager);
      const planApprovals: ApprovalRequest[] = [];
      const plan = await tool.execute(
        explicitShellInput("echo must-not-run"),
        context(root, { mode: "plan", approve: true, approvals: planApprovals }),
      );
      assert.equal(plan.ok, false);
      assert.equal(planApprovals.length, 0);
      assert.equal(
        (plan.data as { policyDecision: { matchedRule: string } }).policyDecision.matchedRule,
        "mode.plan",
      );
      assert.equal(
        (plan.data as { failure: { kind: string; code: string } }).failure.kind,
        "policy",
      );
      assert.equal(
        (plan.data as { failure: { code: string } }).failure.code,
        "mode.plan",
      );

      const neverApprovals: ApprovalRequest[] = [];
      const never = await tool.execute(
        explicitShellInput("echo must-not-run"),
        context(root, {
          mode: "code",
          approvalPolicy: "never",
          approve: true,
          approvals: neverApprovals,
        }),
      );
      assert.equal(never.ok, false);
      assert.equal(neverApprovals.length, 0);
      assert.match(
        (never.data as { policyDecision: { reason: string } }).policyDecision.reason,
        /approval prompts are disabled/u,
      );
      assert.equal(
        (never.data as { failure: { kind: string; code: string } }).failure.kind,
        "approval",
      );
      assert.equal(
        (never.data as { failure: { code: string } }).failure.code,
        "approval_unavailable",
      );
    });
  });

  it("rejects interactive shell protocols and redacts secrets from approval previews", async () => {
    await withWorkspace(async (root, manager) => {
      const tool = new RunCommandTool(manager);
      const invalid = process.platform === "win32"
        ? { program: "cmd", args: ["/k"], intent: "run" as const }
        : { program: "sh", args: ["-i"], intent: "run" as const };
      const invalidResult = await tool.execute(invalid, context(root, { approve: true }));
      assert.equal(invalidResult.ok, false);
      assert.equal(
        (invalidResult.data as { policyDecision: { matchedRule: string } }).policyDecision.matchedRule,
        "input.shell_protocol",
      );

      const secret = "shell-preview-secret-value";
      const bidi = "\u202E";
      const approvals: ApprovalRequest[] = [];
      const rejected = await tool.execute(
        explicitShellInput(`echo TOKEN=${secret} --token ${secret} left${bidi}right`),
        context(root, { approve: false, approvals }),
      );
      assert.equal(rejected.ok, false);
      assert.equal(approvals.length, 1);
      assert.doesNotMatch(approvals[0]?.commandPreview ?? "", new RegExp(secret, "u"));
      assert.doesNotMatch(approvals[0]?.commandPreview ?? "", new RegExp(bidi, "u"));
      assert.match(approvals[0]?.commandPreview ?? "", /\[REDACTED\]/u);
      assert.equal((approvals[0]?.commandPreview ?? "").includes("\\\\u{202e}"), true);
    });
  });

  it("redacts shell assignments from output, executed args, and command audit", async () => {
    await withWorkspace(async (root, manager) => {
      const secret = "shell-audit-secret-value";
      const audit: CommandAuditEntry[] = [];
      const tool = new RunCommandTool(manager);
      const result = await tool.execute(
        explicitShellInput(`echo TOKEN=${secret}`),
        context(root, { approve: true, audit }),
      );

      assert.equal(result.ok, true);
      assert.equal(audit.length, 1);
      assert.doesNotMatch(JSON.stringify(result.data), new RegExp(secret, "u"));
      assert.doesNotMatch(JSON.stringify(audit), new RegExp(secret, "u"));
      assert.match(JSON.stringify(result.data), /\[REDACTED\]/u);
    });
  });

  it("rejects interpreter inline code and unsafe cwd before execution", async () => {
    await withWorkspace(async (root, manager) => {
      const tool = new RunCommandTool(manager);
      const inline = await tool.execute(
        { program: "node", args: ["-e", "console.log('unsafe')"], intent: "inspect" },
        context(root),
      );
      const escaped = await tool.execute(
        { program: "node", args: ["--version"], cwd: "../", intent: "inspect" },
        context(root),
      );
      assert.equal(inline.ok, false);
      assert.match(inline.summary, /denied/iu);
      assert.deepEqual(
        (inline.data as { failure: { kind: string; code: string } }).failure,
        {
          kind: "policy",
          code: "deny.interpreter_eval",
          message: "Interpreter inline-code flags are disabled",
          processStarted: false,
          retryable: false,
        },
      );
      assert.equal(escaped.ok, false);
      assert.match(escaped.error ?? "", /traversal|workspace/iu);
      assert.equal(
        (escaped.data as { failure: { kind: string; code: string } }).failure.kind,
        "policy",
      );
      assert.equal(
        (escaped.data as { failure: { code: string } }).failure.code,
        "policy.cwd_boundary",
      );
      assert.equal(
        (escaped.data as { policyDecision: { matchedRule: string } }).policyDecision.matchedRule,
        "policy.cwd_boundary",
      );
    });
  });

  it("classifies direct network policy denials separately from approval", async () => {
    await withWorkspace(async (root, manager) => {
      const executable = path.join(root, "curl");
      await writeFile(executable, "fixture\n", "utf8");
      await chmod(executable, 0o755);
      const approvals: ApprovalRequest[] = [];
      const result = await new RunCommandTool(manager).execute(
        { program: "./curl", args: ["https://example.invalid"], intent: "run" },
        context(root, { approve: true, approvals }),
      );

      assert.equal(result.ok, false);
      assert.equal(approvals.length, 0);
      const output = result.data as {
        policyDecision: { matchedRule: string };
        failure: { kind: string; code: string; processStarted: boolean };
      };
      assert.equal(output.policyDecision.matchedRule, "deny.external");
      assert.equal(output.failure.kind, "policy");
      assert.equal(output.failure.code, "deny.external");
      assert.equal(output.failure.processStarted, false);
    });
  });

  it("bypasses every command policy and approval rule in unrestricted mode", async () => {
    await withWorkspace(async (root, manager) => {
      const hostCwd = await mkdtemp(path.join(os.tmpdir(), "easy-code-host-command-"));
      const canonicalHostCwd = path.normalize(await realpath(hostCwd));
      const approvals: ApprovalRequest[] = [];
      const tool = new RunCommandTool(manager);
      const environmentName = "EASY_CODE_DANGER_ENV_TEST";
      const previousEnvironment = process.env[environmentName];
      process.env[environmentName] = "inherited-host-value";
      try {
        const result = await tool.execute(
          {
            program: process.execPath,
            args: [
              "-e",
              "require('node:fs').writeFileSync('outside.txt', process.env.EASY_CODE_DANGER_ENV_TEST); process.stdout.write('unrestricted-ok')",
            ],
            cwd: hostCwd,
            intent: "run",
          },
          context(root, {
            mode: "plan",
            approvalPolicy: "never",
            commandExecutionMode: "unrestricted",
            approvals,
          }),
        );

        assert.equal(result.ok, true);
        assert.equal(approvals.length, 0);
        const output = result.data as {
          stdout: { text: string };
          policyDecision: { effect: string; matchedRule: string };
          sandbox: { backend: string; enforced: boolean; filesystem: string; network: string };
          executed: { cwd: string };
        };
        assert.equal(output.stdout.text, "unrestricted-ok");
        assert.equal(output.policyDecision.effect, "allow");
        assert.equal(output.policyDecision.matchedRule, "allow.unrestricted");
        assert.deepEqual(output.sandbox, {
          backend: "host-unrestricted",
          enforced: false,
          filesystem: "host",
          network: "host",
        });
        assert.equal(output.executed.cwd, canonicalHostCwd);
        assert.equal(
          await readFile(path.join(hostCwd, "outside.txt"), "utf8"),
          "inherited-host-value",
        );

        const relativeEscape = await tool.execute(
          { program: "node", args: ["--version"], cwd: "../", intent: "run" },
          context(root, {
            mode: "code",
            approvalPolicy: "never",
            commandExecutionMode: "unrestricted",
          }),
        );
        assert.equal(relativeEscape.ok, false);
        assert.match(relativeEscape.error ?? "", /absolute path/iu);
      } finally {
        if (previousEnvironment === undefined) delete process.env[environmentName];
        else process.env[environmentName] = previousEnvironment;
        await rm(hostCwd, { recursive: true, force: true });
      }
    });
  });

  it("requires exact approval for sandboxed workspace code and records generated files", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(
        path.join(root, "generate.cjs"),
        "require('node:fs').writeFileSync('generated.txt', 'made by command');\n",
        "utf8",
      );
      await manager.refreshManifest();
      const approvals: ApprovalRequest[] = [];
      const audit: CommandAuditEntry[] = [];
      const tool = new RunCommandTool(manager);
      const result = await tool.execute(
        { program: "node", args: ["generate.cjs"], intent: "build" },
        context(root, { approvalPolicy: "safe", approve: true, approvals, audit }),
      );

      assert.equal(result.ok, true);
      assert.equal(approvals.length, 1);
      assert.match(approvals[0]?.description ?? "", /exact approval=/u);
      assert.equal(await readFile(path.join(root, "generated.txt"), "utf8"), "made by command");
      const output = result.data as { workspaceDelta: { created: string[] } };
      assert.deepEqual(output.workspaceDelta.created, ["generated.txt"]);
      assert.equal(manager.getChangeSet().some((change) => change.path === "generated.txt"), true);
      assert.equal(audit.length, 1);
    });
  });

  it("treats a successful command deletion as a successful command result", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "temporary.txt"), "temporary", "utf8");
      await writeFile(
        path.join(root, "remove-temporary.cjs"),
        "require('node:fs').unlinkSync('temporary.txt');\n",
        "utf8",
      );
      await manager.refreshManifest();
      const tool = new RunCommandTool(manager);
      const result = await tool.execute(
        { program: "node", args: ["remove-temporary.cjs"], intent: "test" },
        context(root, { approve: true }),
      );

      assert.equal(result.ok, true);
      const output = result.data as {
        status: string;
        exitCode: number | null;
        workspaceDelta: { deleted: string[] };
        failure?: unknown;
      };
      assert.equal(output.status, "exited");
      assert.equal(output.exitCode, 0);
      assert.deepEqual(output.workspaceDelta.deleted, ["temporary.txt"]);
      assert.equal(output.failure, undefined);
      const deletion = manager.getChangeSet().find(
        (change) => change.path === "temporary.txt" && change.operation === "deleted_by_command",
      );
      assert.equal(deletion?.status, "verified");
    });
  });

  it("denies an approval-requiring command when prompts are disabled", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "script.cjs"), "process.stdout.write('no');", "utf8");
      const approvals: ApprovalRequest[] = [];
      const tool = new RunCommandTool(manager);
      const result = await tool.execute(
        { program: "node", args: ["script.cjs"], intent: "run" },
        context(root, { approvalPolicy: "never", approve: true, approvals }),
      );
      assert.equal(result.ok, false);
      assert.equal(approvals.length, 0);
      assert.match(result.summary, /denied/iu);
      assert.equal(
        (result.data as { failure: { kind: string; code: string } }).failure.kind,
        "approval",
      );
      assert.equal(
        (result.data as { failure: { code: string } }).failure.code,
        "approval_unavailable",
      );
    });
  });

  it("distinguishes rejected and unavailable approval from policy denial", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "approval.cjs"), "process.stdout.write('no');\n", "utf8");
      const tool = new RunCommandTool(manager);
      const rejected = await tool.execute(
        { program: "node", args: ["approval.cjs"], intent: "run" },
        context(root, { approve: false }),
      );
      assert.equal(
        (rejected.data as { failure: { kind: string; code: string } }).failure.kind,
        "approval",
      );
      assert.equal(
        (rejected.data as { failure: { code: string } }).failure.code,
        "approval_not_granted",
      );

      const unavailable = await tool.execute(
        { program: "node", args: ["approval.cjs"], intent: "run" },
        {
          ...context(root, { approve: true }),
          requestApproval: async () => {
            throw new Error("approval UI unavailable");
          },
        },
      );
      assert.equal(
        (unavailable.data as { failure: { kind: string; code: string } }).failure.kind,
        "approval",
      );
      assert.equal(
        (unavailable.data as { failure: { code: string } }).failure.code,
        "approval_unavailable",
      );
    });
  });

  it("distinguishes parameter, exit, and command-tool Runtime failures", async () => {
    await withWorkspace(async (root, manager) => {
      const tools = commandTools(manager);
      const owner = context(root, { approve: true });
      const invalid = await tools.run.execute(
        { action: "run", program: "node", intent: "inspect" },
        owner,
      );
      assert.equal(
        (invalid.data as { failure: { kind: string } }).failure.kind,
        "parameter",
      );

      await writeFile(path.join(root, "exit-seven.cjs"), "process.exit(7);\n", "utf8");
      const exited = await tools.run.execute(
        { program: "node", args: ["exit-seven.cjs"], intent: "test" },
        owner,
      );
      assert.equal(exited.ok, false);
      assert.equal(
        (exited.data as { failure: { kind: string; processStarted: boolean } }).failure.kind,
        "exit",
      );
      assert.equal(
        (exited.data as { failure: { processStarted: boolean } }).failure.processStarted,
        true,
      );

      const unknown = await tools.poll.execute(
        { commandId: "command_00000000-0000-4000-8000-000000000000" },
        owner,
      );
      assert.equal(unknown.ok, false);
      assert.equal(
        (unknown.data as { failure: { kind: string; code: string } }).failure.kind,
        "runtime",
      );
      assert.equal(
        (unknown.data as { failure: { code: string } }).failure.code,
        "unknown_handle",
      );
    });
  });

  it("starts, long-polls, and audits a structured background command", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(
        path.join(root, "background.cjs"),
        [
          "process.stdout.write('started\\n');",
          "setTimeout(() => {",
          "  require('node:fs').writeFileSync('background.txt', 'complete');",
          "  process.stdout.write('finished\\n');",
          "}, 150);",
        ].join("\n"),
        "utf8",
      );
      await manager.refreshManifest();
      const audit: CommandAuditEntry[] = [];
      const tools = commandTools(manager);
      const owner = context(root, { approve: true, audit, timeoutMs: 2_000 });
      const started = await tools.start.execute(
        {
          program: "node",
          args: ["background.cjs"],
          intent: "test",
          timeoutMs: 1_500,
        },
        owner,
      );

      assert.equal(started.ok, true);
      const running = started.data as { commandId: string; status: string };
      assert.equal(running.status, "running");
      assert.match(running.commandId, /^command_[0-9a-f-]{36}$/u);
      assert.equal(audit.length, 0, "a running command must not be audited as complete");

      const inaccessible = await tools.poll.execute(
        { commandId: running.commandId },
        { ...owner, threadId: "thread-other" },
      );
      assert.equal(inaccessible.ok, false);
      assert.match(inaccessible.error ?? "", /unknown or inaccessible/iu);

      const completed = await tools.poll.execute(
        { commandId: running.commandId, waitMs: 2_000 },
        owner,
      );
      assert.equal(completed.ok, true);
      const output = completed.data as {
        status: string;
        stdout: { text: string };
        workspaceDelta: { created: string[] };
      };
      assert.equal(output.status, "exited");
      assert.match(output.stdout.text, /started[\s\S]*finished/u);
      assert.deepEqual(output.workspaceDelta.created, ["background.txt"]);
      assert.equal(await readFile(path.join(root, "background.txt"), "utf8"), "complete");
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.status, "exited");
    });
  });

  it("keeps a naturally finished handle open until its owner observes the terminal result", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(
        path.join(root, "finish-between-steps.cjs"),
        "setTimeout(() => process.stdout.write('done\\n'), 40);\n",
        "utf8",
      );
      const tools = commandTools(manager);
      const owner = context(root, { approve: true, timeoutMs: 2_000 });
      const started = await tools.start.execute(
        {
          program: "node",
          args: ["finish-between-steps.cjs"],
          intent: "test",
        },
        owner,
      );
      const commandId = (started.data as { commandId: string }).commandId;
      assert.equal(tools.runtime.hasOpenCommandHandles(), true);
      const settlement = tools.runtime.whenSettled(commandId);
      assert.ok(settlement);
      await settlement;

      assert.equal(tools.runtime.hasRunningCommands(), false);
      assert.equal(tools.runtime.hasOpenCommandHandles(), true);
      const observed = await tools.poll.execute({ commandId }, owner);
      assert.equal((observed.data as { status: string }).status, "exited");
      assert.equal(tools.runtime.hasOpenCommandHandles(), false);
    });
  });

  it("cancels a structured background command and its process tree", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "background-hang.cjs"), "setInterval(() => {}, 1000);\n", "utf8");
      const audit: CommandAuditEntry[] = [];
      const tools = commandTools(manager);
      const owner = context(root, { approve: true, audit, timeoutMs: 2_000 });
      const started = await tools.start.execute(
        {
          program: "node",
          args: ["background-hang.cjs"],
          intent: "test",
        },
        owner,
      );
      const commandId = (started.data as { commandId: string }).commandId;

      const canceled = await tools.cancel.execute({ commandId }, owner);
      assert.equal(canceled.ok, true);
      assert.equal((canceled.data as { status: string }).status, "canceled");
      assert.equal(tools.runtime.hasRunningCommands(), false);
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.status, "canceled");
    });
  });

  it("aborts a status long-poll without canceling its background command", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "status-hang.cjs"), "setInterval(() => {}, 1000);\n", "utf8");
      const tools = commandTools(manager);
      const owner = context(root, { approve: true, timeoutMs: 5_000 });
      const started = await tools.start.execute(
        {
          program: "node",
          args: ["status-hang.cjs"],
          intent: "test",
        },
        owner,
      );
      const commandId = (started.data as { commandId: string }).commandId;
      const controller = new AbortController();
      const waiting = tools.runtime.status(
        commandId,
        { ...owner, signal: controller.signal },
        30_000,
      );
      const abortStartedAt = Date.now();
      controller.abort();

      await assert.rejects(
        waiting,
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
      assert.ok(Date.now() - abortStartedAt < 1_000, "status wait did not abort promptly");
      assert.equal(tools.runtime.hasRunningCommands(), true);
      await tools.cancel.execute({ commandId }, owner);
    });
  });

  it("binds command handles to every agent owner field but not to a turn", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "owned-hang.cjs"), "setInterval(() => {}, 1000);\n", "utf8");
      const tools = commandTools(manager);
      const owner: ToolContext = {
        ...context(root, { approve: true, timeoutMs: 5_000 }),
        agentRole: "subagent",
        agentId: "agent-owner",
        assignedTaskId: "task-owner",
      };
      const started = await tools.start.execute(
        {
          program: "node",
          args: ["owned-hang.cjs"],
          intent: "test",
        },
        owner,
      );
      const commandId = (started.data as { commandId: string }).commandId;

      for (const inaccessible of [
        { ...owner, agentRole: "main_agent" as const },
        { ...owner, agentId: "agent-other" },
        { ...owner, assignedTaskId: "task-other" },
      ]) {
        await assert.rejects(
          tools.runtime.status(commandId, inaccessible),
          /unknown or inaccessible/iu,
        );
      }

      const acrossTurn = await tools.runtime.status(commandId, {
        ...owner,
        turnId: "turn-next",
      });
      assert.equal(acrossTurn.status, "running");
      await tools.cancel.execute({ commandId }, owner);
    });
  });

  it("terminates timed-out commands and reports a timed_out status", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "hang-child.cjs"), "setInterval(() => {}, 1000);", "utf8");
      await writeFile(
        path.join(root, "hang.cjs"),
        [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          'const child = spawn(process.execPath, ["hang-child.cjs"], { cwd: __dirname, stdio: "ignore" });',
          'writeFileSync("child.pid", String(child.pid));',
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );
      const tool = new RunCommandTool(manager);
      const result = await tool.execute(
        { program: "node", args: ["hang.cjs"], intent: "test", timeoutMs: 500 },
        context(root, { approve: true, timeoutMs: 750 }),
      );
      assert.equal(result.ok, false);
      assert.equal((result.data as { status: string }).status, "timed_out");
      assert.equal(
        (result.data as { failure: { kind: string; processStarted: boolean } }).failure.kind,
        "timeout",
      );
      assert.equal(
        (result.data as { failure: { processStarted: boolean } }).failure.processStarted,
        true,
      );
      const childPid = Number.parseInt(await readFile(path.join(root, "child.pid"), "utf8"), 10);
      assert.equal(Number.isInteger(childPid), true);
      assert.equal(processIsAlive(childPid), false, "timed-out descendant is still running");
      // A timed-out command must not return while its process tree still holds
      // the workspace as its cwd. This specifically guards the Windows
      // EBUSY race between direct-child exit and asynchronous taskkill cleanup.
      await rm(root, { recursive: true, force: true });
    });
  });

  it("truncates, sanitizes and redacts command output", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(
        path.join(root, "output.cjs"),
        "process.stdout.write('API_KEY=super-secret-token\\n' + 'x'.repeat(2000));\n",
        "utf8",
      );
      const tool = new RunCommandTool(manager);
      const result = await tool.execute(
        { program: "node", args: ["output.cjs"], intent: "test" },
        context(root, { approve: true, maxOutputChars: 256 }),
      );
      assert.equal(result.ok, true);
      const output = (result.data as { stdout: { text: string; truncated: boolean } }).stdout;
      assert.equal(output.truncated, true);
      assert.equal(output.text.includes("super-secret-token"), false);
      assert.match(output.text, /\[REDACTED\]/u);
    });
  });

  it("uses a small environment allowlist and never forwards provider keys", () => {
    const environment = buildCommandEnvironment({
      PATH: process.env.PATH,
      TEMP: process.env.TEMP,
      QWEN_API_KEY: "secret",
      DEEPSEEK_API_KEY: "secret",
      GLM_API_KEY: "secret",
      GLM_CODING_PLAN_API_KEY: "secret",
      ZAI_API_KEY: "secret",
      ZHIPUAI_API_KEY: "secret",
      NODE_OPTIONS: "--require bad.js",
      SAFE_CUSTOM: "also omitted",
    });
    assert.equal(environment.QWEN_API_KEY, undefined);
    assert.equal(environment.DEEPSEEK_API_KEY, undefined);
    assert.equal(environment.GLM_API_KEY, undefined);
    assert.equal(environment.GLM_CODING_PLAN_API_KEY, undefined);
    assert.equal(environment.ZAI_API_KEY, undefined);
    assert.equal(environment.ZHIPUAI_API_KEY, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.SAFE_CUSTOM, undefined);
    assert.equal(environment.CI, "1");
  });

  it("does not expose the private VS Code navigation channel in dangerous mode", () => {
    const environment = buildUnrestrictedCommandEnvironment({
      PATH: process.env.PATH,
      EASY_CODE_VSCODE_BRIDGE_ENDPOINT: "127.0.0.1:43123",
      EASY_CODE_VSCODE_BRIDGE_TOKEN: "a".repeat(64),
      CUSTOM_TOOLCHAIN_SETTING: "preserved",
    });
    assert.equal(environment.EASY_CODE_VSCODE_BRIDGE_ENDPOINT, undefined);
    assert.equal(environment.EASY_CODE_VSCODE_BRIDGE_TOKEN, undefined);
    assert.equal(environment.CUSTOM_TOOLCHAIN_SETTING, "preserved");
  });

  it("strictly validates local npm installs and adds safe defaults", () => {
    const valid = analyzeNpmInstall(["install", "prettier@3.3.3", "--save-dev"]);
    assert.equal(valid.isInstall, true);
    assert.equal(valid.valid, true);
    assert.equal(valid.normalizedArgs.includes("--ignore-scripts"), true);
    assert.equal(valid.normalizedArgs.includes("--no-audit"), true);
    assert.equal(valid.normalizedArgs.includes("--no-fund"), true);
    assert.equal(valid.normalizedArgs.includes("--save-exact"), true);

    for (const args of [
      ["install", "-g", "prettier@3.3.3"],
      ["install", "prettier"],
      ["install", "https://example.invalid/tool.tgz"],
      ["install", "git+https://example.invalid/repo.git"],
      ["install", "file:../outside"],
    ]) {
      assert.equal(analyzeNpmInstall(args).valid, false, args.join(" "));
    }
  });

  it("classifies npm scripts as approval-required workspace execution", async () => {
    await withWorkspace(async (root, manager) => {
      const resolver = new CommandResolver(manager);
      const input = { program: "npm", args: ["run", "test"], intent: "test" as const };
      const resolved = await resolver.resolve(input);
      const decision = new CommandPolicy().classify(input, resolved, "code");
      assert.equal(decision.capability, "workspace_exec");
      assert.equal(decision.effect, "ask");
    });
  });
});
