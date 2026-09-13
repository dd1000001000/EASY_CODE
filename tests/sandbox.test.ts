import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CommandPolicy, CommandRuntime } from "../src/command/index.js";
import type { CommandAuditEntry, ToolContext } from "../src/core/types.js";
import {
  encodeSandboxControl,
  extractSandboxControls,
  runSandboxStartupGuide,
  UnrestrictedHostBackend,
  type CommandExecutionBackend,
  type PreparedCommand,
  type SandboxReadiness,
  type SandboxExecutionMetadata,
  type SandboxExecutionRequest,
  type SandboxStartupService,
  type SandboxStartupTerminal,
} from "../src/sandbox/index.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

async function withWorkspace(
  run: (root: string, manager: WorkspaceManager) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(process.cwd(), ".easy-code-sandbox-test-"));
  try {
    const manager = await WorkspaceManager.create(root);
    await run(root, manager);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function toolContext(
  root: string,
  options: { audit?: CommandAuditEntry[] } = {},
): ToolContext {
  return {
    workspaceRoot: root,
    mode: "code",
    threadId: "thread-sandbox-test",
    turnId: "turn-sandbox-test",
    approvalPolicy: "safe",
    requestApproval: async () => true,
    commandTimeoutMs: 2_000,
    maxOutputChars: 4_096,
    recordCommand: (entry) => options.audit?.push(entry),
  };
}

function sandboxRequest(root: string): SandboxExecutionRequest {
  return {
    commandId: "command-sandbox-payload",
    commandPreview: "structured command preview",
    command: {
      program: "node",
      executablePath: process.execPath,
      args: ["fixture.cjs", "argument with spaces", "literal;&|value"],
      cwdAbsolute: root,
      cwdRelative: ".",
      executableInsideWorkspace: false,
      environment: {
        PATH: process.env.PATH,
        EASY_CODE_TEST_ENV: "preserved-value",
        GIT_EXTERNAL_DIFF: "must-not-inherit",
        GIT_CONFIG_PARAMETERS: "must-not-inherit",
      },
      environmentKeys: ["EASY_CODE_TEST_ENV", "PATH"],
    },
    policyDecision: {
      id: "policy-sandbox-payload",
      effect: "allow",
      capability: "safe_inspect",
      risk: "read",
      reason: "Focused sandbox preparation test",
      matchedRule: "test.sandbox_prepare",
    },
    context: toolContext(root),
  };
}

class ThrowingSandboxBackend implements CommandExecutionBackend {
  prepareCalls = 0;
  lastRequest?: SandboxExecutionRequest;

  constructor(private readonly enforced = false) {}

  describe(): SandboxExecutionMetadata {
    return {
      backend: "host-test-only",
      enforced: this.enforced,
      filesystem: this.enforced ? "container" : "host",
      network: this.enforced ? "denied" : "host",
    };
  }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    this.prepareCalls += 1;
    this.lastRequest = request;
    throw new Error("focused backend preparation failure");
  }
}

class NeverReadySandboxBackend implements CommandExecutionBackend {
  describe(): SandboxExecutionMetadata {
    return {
      backend: "podman",
      enforced: true,
      filesystem: "container",
      network: "denied",
    };
  }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    const stage = encodeSandboxControl(request.commandId, {
      type: "stage",
      stage: "relay_start",
    });
    return {
      executablePath: process.execPath,
      args: [
        "-e",
        `process.stderr.write(${JSON.stringify(stage)}); setInterval(() => {}, 1000);`,
      ],
      cwdAbsolute: request.command.cwdAbsolute,
      environment: { ...process.env },
      metadata: this.describe(),
      cleanup: async () => undefined,
    };
  }
}

class DelayedReadySandboxBackend extends NeverReadySandboxBackend {
  constructor(private readonly readyDelayMs: number) {
    super();
  }

  override async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    const ready = encodeSandboxControl(request.commandId, {
      type: "ready",
      backend: "podman",
    });
    return {
      executablePath: process.execPath,
      args: [
        "-e",
        `setTimeout(() => { process.stderr.write(${JSON.stringify(ready)}); ` +
          "setInterval(() => {}, 1000); }, " +
          `${String(this.readyDelayMs)});`,
      ],
      cwdAbsolute: request.command.cwdAbsolute,
      environment: { ...process.env },
      metadata: this.describe(),
      cleanup: async () => undefined,
    };
  }
}

function readiness(
  status: SandboxReadiness["status"],
  options: {
    platform?: NodeJS.Platform;
    canSetup?: boolean;
    details?: readonly string[];
  } = {},
): SandboxReadiness {
  const platform = options.platform ?? "linux";
  return {
    status,
    platform,
    backend: `test sandbox for ${platform}`,
    details: options.details ?? [],
    warnings: [],
    canSetup: options.canSetup ?? false,
  };
}

class ScriptedSandboxTerminal implements SandboxStartupTerminal {
  readonly choices: Array<{
    title: string;
    ids: string[];
    initialId?: string;
  }> = [];
  readonly infoMessages: string[] = [];
  readonly successMessages: string[] = [];
  readonly warningMessages: string[] = [];
  readonly errorMessages: string[] = [];
  readonly activities: string[] = [];
  stopCount = 0;

  constructor(private readonly selections: Array<string | undefined> = []) {}

  async selectChoice(
    title: string,
    choices: readonly { id: string; label: string; detail?: string }[],
    initialId?: string,
  ): Promise<string | undefined> {
    this.choices.push({
      title,
      ids: choices.map((choice) => choice.id),
      ...(initialId === undefined ? {} : { initialId }),
    });
    return this.selections.shift();
  }

  info(text: string): void {
    this.infoMessages.push(text);
  }

  success(text: string): void {
    this.successMessages.push(text);
  }

  warning(text: string): void {
    this.warningMessages.push(text);
  }

  error(text: string): void {
    this.errorMessages.push(text);
  }

  startActivity(text: string): void {
    this.activities.push(text);
  }

  stopActivity(): void {
    this.stopCount += 1;
  }
}

describe("sandbox command execution boundary", () => {
  it("requires a Runtime-issued host permit even when caller labels the context unrestricted", async () => {
    await withWorkspace(async (root) => {
      const request = sandboxRequest(root);
      const host = new UnrestrictedHostBackend();
      for (const commandExecutionMode of ["manual", "auto_approve", "unrestricted"] as const) {
        await assert.rejects(() => host.prepare({ ...request, context: { ...request.context, commandExecutionMode } }), /not authorized/iu);
      }
    });
  });

  it("encodes, extracts, and scopes sandbox worker control markers", () => {
    const commandId = "command-owned";
    const owned = encodeSandboxControl(commandId, {
      type: "ready",
      backend: "podman",
    });
    const foreign = encodeSandboxControl("command-foreign", {
      type: "sandbox_error",
      message: "belongs to another command",
    });
    const originalText = `before\n${owned}middle\n${foreign}after`;

    assert.doesNotMatch(owned, /"type"|podman/u);
    const extracted = extractSandboxControls(commandId, {
      head: `before\n${owned}middle\n`,
      tail: `${foreign}after`,
      text: originalText,
      totalBytes: Buffer.byteLength(originalText),
      truncated: false,
    });

    assert.deepEqual(extracted.controls, [
      { type: "ready", backend: "podman" },
    ]);
    assert.equal(extracted.digest.text, `before\nmiddle\n${foreign}after`);
    assert.equal(extracted.digest.head, "before\nmiddle\n");
    assert.equal(extracted.digest.tail, `${foreign}after`);
    assert.equal(extracted.digest.truncated, false);
  });

  it("fails closed when backend preparation fails and never starts the target", async () => {
    await withWorkspace(async (root, manager) => {
      const markerPath = path.join(root, "target-started.txt");
      await writeFile(
        path.join(root, "would-start.cjs"),
        "require('node:fs').writeFileSync('target-started.txt', 'started');\n",
        "utf8",
      );
      await manager.refreshManifest();

      const backend = new ThrowingSandboxBackend();
      const audit: CommandAuditEntry[] = [];
      const runtime = new CommandRuntime(manager, new CommandPolicy(), backend);
      const output = await runtime.run(
        {
          program: "node",
          args: ["would-start.cjs"],
          intent: "run",
          reason: "The fake target would leave a marker if it were launched",
        },
        toolContext(root, { audit }),
      );

      assert.equal(backend.prepareCalls, 1);
      assert.equal(backend.lastRequest?.command.args[0], "would-start.cjs");
      assert.equal(output.status, "sandbox_unavailable");
      assert.equal(output.exitCode, null);
      assert.equal(output.failure?.kind, "sandbox");
      assert.equal(output.failure?.processStarted, false);
      assert.match(output.stderr.text, /sandbox unavailable/iu);
      assert.match(output.stderr.text, /focused backend preparation failure/u);
      assert.deepEqual(output.workspaceDelta, {
        created: [],
        updated: [],
        deleted: [],
        truncated: false,
      });
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.status, "sandbox_unavailable");
      await assert.rejects(
        access(markerPath),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    });
  });

  it("does not leak a sandbox failure cooldown across independent command calls", async () => {
    await withWorkspace(async (root, manager) => {
      const backend = new ThrowingSandboxBackend(true);
      const runtime = new CommandRuntime(manager, new CommandPolicy(), backend);
      const input = {
        program: "node",
        args: ["--version"],
        intent: "inspect" as const,
      };

      const first = await runtime.run(input, toolContext(root));
      const second = await runtime.run(input, toolContext(root));

      assert.equal(first.status, "sandbox_unavailable");
      assert.equal(second.status, "sandbox_unavailable");
      assert.equal(backend.prepareCalls, 2);
      assert.match(first.stderr.text, /focused backend preparation failure/u);
      assert.match(second.stderr.text, /focused backend preparation failure/u);
    });
  });

  it("classifies a timeout before the ready marker as sandbox initialization failure", async () => {
    await withWorkspace(async (root, manager) => {
      const runtime = new CommandRuntime(
        manager,
        new CommandPolicy(),
        new NeverReadySandboxBackend(),
        undefined,
        { sandboxStartupTimeoutMs: 50 },
      );

      const output = await runtime.run(
        {
          program: "node",
          args: ["--version"],
          intent: "inspect",
          timeoutMs: 50,
        },
        toolContext(root),
      );

      assert.equal(output.status, "sandbox_unavailable");
      assert.match(output.stderr.text, /not confirmed started/iu);
      assert.match(output.stderr.text, /last worker stage: relay_start/iu);
      assert.equal(output.sandboxFailure?.phase, "execution");
      assert.equal(output.sandboxFailure?.retryable, false);
      assert.equal(output.lifecycle?.execution, "unknown");
    });
  });

  it("starts the requested command timeout only after the sandbox ready marker", async () => {
    await withWorkspace(async (root, manager) => {
      const runtime = new CommandRuntime(
        manager,
        new CommandPolicy(),
        new DelayedReadySandboxBackend(70),
        undefined,
        { sandboxStartupTimeoutMs: 500 },
      );
      const startedAt = Date.now();
      const output = await runtime.run(
        {
          program: "node",
          args: ["--version"],
          intent: "inspect",
          timeoutMs: 35,
        },
        toolContext(root),
      );

      assert.equal(output.status, "timed_out");
      assert.equal(output.sandboxFailure, undefined);
      assert.ok(
        Date.now() - startedAt >= 80,
        "the target timeout fired before delayed sandbox initialization completed",
      );
    });
  });
});

describe("sandbox first-interactive startup guide", () => {
  it("continues immediately without rendering a menu when the sandbox is ready", async () => {
    let inspectCalls = 0;
    let setupCalls = 0;
    const service: SandboxStartupService = {
      inspect: async () => {
        inspectCalls += 1;
        return readiness("ready");
      },
      setup: async () => {
        setupCalls += 1;
        throw new Error("setup must not be called for a ready sandbox");
      },
    };
    const terminal = new ScriptedSandboxTerminal();

    assert.equal(await runSandboxStartupGuide(service, terminal), true);
    assert.equal(inspectCalls, 1);
    assert.equal(setupCalls, 0);
    assert.deepEqual(terminal.choices, []);
    assert.deepEqual(terminal.warningMessages, []);
    assert.deepEqual(terminal.activities, ["Checking the command sandbox"]);
    assert.equal(terminal.stopCount, 1);
  });

  it("runs setup once, uses its verified readiness, and clears activity", async () => {
    const before = readiness("setup_required", {
      platform: "win32",
      canSetup: true,
      details: ["Filesystem identity: not initialized"],
    });
    const after = readiness("ready", { platform: "win32" });
    let setupInput: SandboxReadiness | undefined;
    const service: SandboxStartupService = {
      inspect: async () => before,
      setup: async (input) => {
        setupInput = input;
        return {
          status: "completed",
          message: "Setup and verification completed.",
          readiness: after,
        };
      },
    };
    const terminal = new ScriptedSandboxTerminal(["setup"]);

    assert.equal(await runSandboxStartupGuide(service, terminal), true);
    assert.equal(setupInput, before);
    assert.deepEqual(terminal.choices[0]?.ids, ["setup", "recheck", "continue", "exit"]);
    assert.equal(terminal.choices[0]?.initialId, "setup");
    assert.deepEqual(terminal.activities, [
      "Checking the command sandbox",
      "Setting up the command sandbox",
    ]);
    assert.equal(terminal.stopCount, 2);
    assert.deepEqual(terminal.successMessages, ["Setup and verification completed."]);
  });

  it("allows an explicit fail-closed continuation and stops on exit or cancellation", async () => {
    const unavailable = readiness("probe_failed", {
      details: ["probe fixture failed"],
    });
    const service: SandboxStartupService = {
      inspect: async () => unavailable,
      setup: async () => ({
        status: "unavailable",
        message: "not available",
        readiness: unavailable,
      }),
    };

    const continuing = new ScriptedSandboxTerminal(["continue"]);
    assert.equal(await runSandboxStartupGuide(service, continuing), true);
    assert.match(
      continuing.warningMessages.at(-1) ?? "",
      /Workspace-sandbox commands remain fail-closed/iu,
    );

    const exiting = new ScriptedSandboxTerminal(["exit"]);
    assert.equal(await runSandboxStartupGuide(service, exiting), false);

    const canceling = new ScriptedSandboxTerminal([undefined]);
    assert.equal(await runSandboxStartupGuide(service, canceling), false);
  });
});
