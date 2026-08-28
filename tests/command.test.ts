import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovalRequest, CommandAuditEntry, ToolContext } from "../src/core/types.js";
import {
  analyzeNpmInstall,
  buildCommandEnvironment,
  CommandPolicy,
  CommandResolver,
  inspectExplicitShellInvocation,
  normalizeExplicitShellArgs,
  sanitizeCommandOutput,
  type RunCommandInput,
} from "../src/command/index.js";
import { RunCommandTool } from "../src/tools/index.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

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
    assert.equal(inspectExplicitShellInvocation("zsh", ["-c", "pwd"]), undefined);
    assert.equal(
      sanitizeCommandOutput("cmd /c set TOKEN=top-secret-token-value").includes("top-secret-token-value"),
      false,
    );
    for (const assignment of [
      "GLM_API_KEY=glm-secret-value",
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
        "deny.shell_protocol",
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
      assert.equal(escaped.ok, false);
      assert.match(escaped.error ?? "", /traversal|workspace/iu);
    });
  });

  it("requires exact approval for unsandboxed workspace code and records generated files", async () => {
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
      const childPid = Number.parseInt(await readFile(path.join(root, "child.pid"), "utf8"), 10);
      assert.equal(Number.isInteger(childPid), true);
      assert.equal(processIsAlive(childPid), false, "timed-out descendant is still running");
      // A timed-out command must not return while its process tree still holds
      // the workspace as its cwd. This specifically guards the Node 16 Windows
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
      ZAI_API_KEY: "secret",
      ZHIPUAI_API_KEY: "secret",
      NODE_OPTIONS: "--require bad.js",
      SAFE_CUSTOM: "also omitted",
    });
    assert.equal(environment.QWEN_API_KEY, undefined);
    assert.equal(environment.DEEPSEEK_API_KEY, undefined);
    assert.equal(environment.GLM_API_KEY, undefined);
    assert.equal(environment.ZAI_API_KEY, undefined);
    assert.equal(environment.ZHIPUAI_API_KEY, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.SAFE_CUSTOM, undefined);
    assert.equal(environment.CI, "1");
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
