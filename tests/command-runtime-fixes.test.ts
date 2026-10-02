import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "./harness.js";
import { buildCommandEnvironment } from "../src/command/environment.js";
import { inspectNetworkOperation } from "../src/command/network-policy.js";
import { CommandPolicy } from "../src/command/policy.js";
import { CommandResolver } from "../src/command/resolver.js";
import { CommandRuntime } from "../src/command/runtime.js";
import type { ResolvedCommand } from "../src/command/types.js";
import type { ToolContext } from "../src/core/types.js";
import { executionCapabilities } from "../src/sandbox/capabilities.js";
import type { CommandExecutionBackend } from "../src/sandbox/types.js";
import { projectToolResult } from "../src/tools/output-projection.js";
import { WorkspaceManager } from "../src/workspace/manager.js";

async function fixture(run: (root: string, workspace: WorkspaceManager, context: ToolContext) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-command-fixes-"));
  try {
    const context: ToolContext = {
      workspaceRoot: root,
      mode: "code",
      threadId: "thread-command-fixes",
      turnId: "turn",
      approvalPolicy: "safe",
      commandExecutionMode: "auto_approve",
      requestApproval: async () => true,
      commandTimeoutMs: 20_000,
      maxOutputChars: 2048,
    };
    await run(root, await WorkspaceManager.create(root), context);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** An unenforced backend that runs `node -e <script>` in place of the requested target. */
function nodeBackend(script: string, prepared: string[] = []): CommandExecutionBackend {
  const metadata = {
    backend: "native" as const,
    enforced: false,
    filesystem: "host" as const,
    network: "host" as const,
    capabilities: executionCapabilities("native"),
  };
  return {
    describe: () => ({ ...metadata }),
    async prepare(request) {
      prepared.push(request.commandId);
      return {
        executablePath: process.execPath,
        args: ["-e", script],
        cwdAbsolute: request.command.cwdAbsolute,
        environment: { PATH: process.env.PATH },
        metadata: { ...metadata },
        cleanup: async () => {},
      };
    },
  };
}

function command(program: string, args: string[], extra: Partial<ResolvedCommand> = {}): ResolvedCommand {
  return {
    program,
    executablePath: `/usr/bin/${program}`,
    args,
    cwdAbsolute: "/workspace",
    cwdRelative: ".",
    executableInsideWorkspace: false,
    trustedExecutable: true,
    environment: {},
    environmentKeys: [],
    ...extra,
  };
}

describe("command runtime fixes", () => {
  it("cancels a command whose turn was aborted while the process was being launched", async () =>
    fixture(async (_, workspace, context) => {
      const controller = new AbortController();
      const runtime = new CommandRuntime(workspace, undefined, nodeBackend("setTimeout(() => {}, 15000)"), undefined, {
        // Runs inside the launch, after the last pre-spawn abort check.
        createOutputArchive: () => {
          controller.abort();
          return undefined as never;
        },
      });
      const started = Date.now();
      const result = await runtime.run(
        { program: "node", args: ["--version"], intent: "run" },
        { ...context, signal: controller.signal },
      );
      assert.equal(result.status, "canceled");
      assert.ok(Date.now() - started < 10_000, "the aborted command must not run to its timeout");
    }));

  it("reports material changed during approval as a not-started, resubmittable denial", async () =>
    fixture(async (_, workspace, context) => {
      const prepared: string[] = [];
      const resolver = new CommandResolver(workspace);
      let resolutions = 0;
      const backend: CommandExecutionBackend = {
        ...nodeBackend("", prepared),
        async resolveCommand(input) {
          const resolved = await resolver.resolve(input, { unrestrictedCommands: true });
          resolutions += 1;
          return resolutions === 1 ? resolved : { ...resolved, executableHash: "changed-during-approval" };
        },
      };
      const runtime = new CommandRuntime(workspace, undefined, backend);
      const result = await runtime.run({ program: "node", args: ["--version"], intent: "run" }, context);
      assert.equal(result.status, "policy_denied");
      assert.equal(result.failure?.code, "approval.material_changed");
      assert.equal(result.failure?.processStarted, false);
      assert.equal(result.failure?.retryable, true);
      assert.match(result.policyDecision.recommendation ?? "", /Submit the command again/u);
      assert.deepEqual(prepared, []);
    }));

  it("keeps a long background job's result for the retention window after it finishes", async () =>
    fixture(async (_, workspace, context) => {
      const runtime = new CommandRuntime(workspace, undefined, nodeBackend("process.stdout.write('done')"));
      const first = await runtime.start({ program: "node", args: ["--version"], intent: "run" }, context);
      await runtime.whenSettled(first.commandId);
      assert.equal((await runtime.status(first.commandId, context)).status, "exited");
      // Simulate a job that started two hours ago but finished just now.
      const jobs = (runtime as unknown as { backgroundJobs: Map<string, { startedAt: number }> }).backgroundJobs;
      jobs.get(first.commandId)!.startedAt = Date.now() - 2 * 60 * 60_000;
      const second = await runtime.start({ program: "node", args: ["--version"], intent: "run" }, context);
      await runtime.whenSettled(second.commandId);
      assert.equal((await runtime.status(first.commandId, context)).status, "exited");
    }));

  it("classifies package installs for the install timeout without hiding uploads", () => {
    const policy = new CommandPolicy();
    const classify = (resolved: ResolvedCommand, intent: "run" | "install" = "run") =>
      policy.classify({ program: resolved.program, intent }, resolved).capability;
    assert.equal(classify(command("npm", ["install"])), "registry_install");
    assert.equal(classify(command("pnpm", ["add", "left-pad"])), "registry_install");
    assert.equal(classify(command("python3", ["-m", "pip", "install", "requests"])), "registry_install");
    assert.equal(classify(command("yarn", [])), "registry_install");
    assert.equal(classify(command("npm", ["test"])), "workspace_exec");
    assert.equal(classify(command("make", ["deps"]), "install"), "registry_install");
    assert.equal(classify(command("curl", ["-q", "-d", "x", "https://example.invalid"]), "install"), "external_write");
    assert.equal(policy.classify({ program: "npm", intent: "run" }, command("npm", ["ci"])).risk, "install");
  });

  it("forwards toolchain variables, user passthrough and host environment without credentials", () => {
    const source = {
      PATH: "/bin",
      JAVA_HOME: "/opt/jdk",
      ProgramFiles: "C:\\Program Files",
      SSL_CERT_FILE: "/etc/ca.pem",
      HTTPS_PROXY: "http://proxy:8080",
      DEEPSEEK_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      DATABASE_URL: "postgres://user:hunter2@db/app",
      EASY_CODE_VSCODE_BRIDGE_TOKEN: "secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      MY_TOOL_HOME: "/opt/tool",
    };
    const sandbox = buildCommandEnvironment(source);
    assert.equal(sandbox.JAVA_HOME, "/opt/jdk");
    assert.equal(sandbox.ProgramFiles, "C:\\Program Files");
    assert.equal(sandbox.SSL_CERT_FILE, "/etc/ca.pem");
    for (const key of ["HTTPS_PROXY", "DEEPSEEK_API_KEY", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "MY_TOOL_HOME"])
      assert.equal(sandbox[key], undefined, key);

    assert.equal(buildCommandEnvironment(source, { passthrough: ["my_tool_home"] }).MY_TOOL_HOME, "/opt/tool");

    const host = buildCommandEnvironment(source, { host: true });
    assert.equal(host.HTTPS_PROXY, "http://proxy:8080");
    assert.equal(host.SSH_AUTH_SOCK, "/tmp/agent.sock");
    assert.equal(host.MY_TOOL_HOME, "/opt/tool");
    for (const key of [
      "DEEPSEEK_API_KEY",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_URL",
      "EASY_CODE_VSCODE_BRIDGE_TOKEN",
    ])
      assert.equal(host[key], undefined, key);
    assert.equal(host.CI, "1");
  });

  it("tells the model when sandboxed npm install skips dependency scripts", async () =>
    fixture(async (root, workspace) => {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
      const resolver = new CommandResolver(workspace);
      const added = await resolver.resolve(
        { program: "npm", args: ["install"], intent: "install" },
        { networkEnabled: true },
      );
      assert.equal(added.args.filter((argument) => argument === "--ignore-scripts").length, 1);
      assert.match(added.notices?.[0] ?? "", /--ignore-scripts.*npm rebuild/su);
      const explicit = await resolver.resolve(
        { program: "npm", args: ["install", "--ignore-scripts"], intent: "install" },
        { networkEnabled: true },
      );
      assert.equal(explicit.args.filter((argument) => argument === "--ignore-scripts").length, 1);
      assert.equal(explicit.notices, undefined);
    }));

  it("does not treat a project-installed npx binary as a network download", async () =>
    fixture(async (root, workspace) => {
      const bin = path.join(root, "node_modules", ".bin");
      await mkdir(bin, { recursive: true });
      const shim = path.join(bin, process.platform === "win32" ? "localtool.cmd" : "localtool");
      await writeFile(shim, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
      await chmod(shim, 0o755);
      const resolver = new CommandResolver(workspace);
      const local = await resolver.resolve({ program: "npx", args: ["localtool"], intent: "run" });
      assert.equal(local.localPackageBinary, true);
      assert.equal(inspectNetworkOperation(local), undefined);
      const versioned = await resolver.resolve({ program: "npx", args: ["localtool@1.0.0"], intent: "run" });
      assert.equal(versioned.localPackageBinary, undefined);
      assert.equal(inspectNetworkOperation(versioned)?.effect, "unknown");
      const missing = await resolver.resolve({ program: "npx", args: ["not-installed"], intent: "run" });
      assert.equal(inspectNetworkOperation(missing)?.effect, "unknown");
    }));

  it("gives a short stream's unused output budget to the other stream", () => {
    const projected = (stdout: string, stderr: string) => {
      const data = projectToolResult({
        ok: true,
        summary: "ok",
        data: {
          commandId: "command_00000000-0000-4000-8000-000000000002",
          status: "exited",
          exitCode: 0,
          requestMetadata: { intent: "run", warnings: [] },
          stdout: { text: stdout, totalBytes: stdout.length, truncated: false },
          stderr: { text: stderr, totalBytes: stderr.length, truncated: false },
          notices: ["fixture notice"],
        },
      }).data as { stdout: { text: string }; stderr: { text: string }; notices?: string[] };
      return data;
    };
    const longStdout = projected("o".repeat(5_000), "warn");
    assert.equal(longStdout.stderr.text, "warn");
    assert.ok(longStdout.stdout.text.length > 1_900, String(longStdout.stdout.text.length));
    assert.deepEqual(longStdout.notices, ["fixture notice"]);
    const both = projected("o".repeat(5_000), "e".repeat(5_000));
    assert.ok(both.stdout.text.length <= 1_000 && both.stderr.text.length <= 1_000);
  });
});
