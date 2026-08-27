import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovalRequest, CommandAuditEntry, ToolContext } from "../src/core/types.js";
import {
  analyzeNpmInstall,
  buildCommandEnvironment,
  CommandPolicy,
  CommandResolver,
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

describe("command runtime", () => {
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
      NODE_OPTIONS: "--require bad.js",
      SAFE_CUSTOM: "also omitted",
    });
    assert.equal(environment.QWEN_API_KEY, undefined);
    assert.equal(environment.DEEPSEEK_API_KEY, undefined);
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
