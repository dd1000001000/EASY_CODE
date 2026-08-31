import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { CommandPolicy, CommandRuntime } from "../src/command/index.js";
import type { CommandAuditEntry, ToolContext } from "../src/core/types.js";
import {
  AnthropicSandboxBackend,
  DefaultSandboxStartupService,
  encodeSandboxControl,
  extractSandboxControls,
  formatWindowsAclPreflightFailure,
  isWindowsSharedExecutablePath,
  runSandboxStartupGuide,
  UnrestrictedHostBackend,
  type CommandExecutionBackend,
  type PreparedCommand,
  type SandboxReadiness,
  type SandboxExecutionMetadata,
  type SandboxExecutionRequest,
  type SandboxStartupService,
  type SandboxStartupTerminal,
  type SandboxSystemCommand,
  type SandboxWorkerPayload,
} from "../src/sandbox/index.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { WindowsSandboxProcessLock } from "../src/sandbox/windows-process-lock.js";
import { describe, it } from "./harness.js";

const execFileAsync = promisify(execFile);

const runtimeReadableWindowsProbe = {
  pathAccess: async (paths: readonly string[]) => {
    return new Map(paths.map((candidate) => {
      const normalized = path.win32.resolve(candidate).toLowerCase();
      return [
        normalized,
        path.win32.basename(normalized) === "node.exe" ? "readable" : "denied",
      ] as const;
    }));
  },
};

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

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
      filesystem: this.enforced ? "workspace-write" : "host",
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
      backend: "anthropic-srt-windows",
      enforced: true,
      filesystem: "workspace-write",
      network: "denied",
    };
  }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    const stage = encodeSandboxControl(request.commandId, {
      type: "stage",
      stage: "initialize_start",
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
      backend: "anthropic-srt-windows",
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

function runtimeFixture(options: {
  dependencies?: () => { errors: string[]; warnings: string[] };
  windowsReady?: () => boolean;
  installCancelled?: () => boolean;
  onInstall?: () => void;
  onVerify?: () => void;
} = {}) {
  return {
    SandboxManager: {
      isSupportedPlatform: () => true,
      checkDependenciesAsync: async () =>
        options.dependencies?.() ?? { errors: [], warnings: [] },
      initialize: async (_config: Record<string, unknown>) => undefined,
      wrapWithSandboxArgv: async () => ({
        argv: [process.execPath, "--version"],
        env: { ...process.env },
      }),
      cleanupAfterCommand: () => undefined,
      reset: async () => undefined,
    },
    VENDORED_SRT_WIN_EXE: "C:\\trusted\\srt-win.exe",
    resolveSrtWin: (_options: { path: string }) => ({ path: "resolved-srt-win" }),
    checkWindowsSandboxStatusAsync: async () => {
      const ready = options.windowsReady?.() ?? true;
      return {
        user: {
          provisioned: ready,
          credPresent: ready,
          groupExists: ready,
          inSandboxGroup: ready,
        },
        wfp: { state: ready ? "installed" : "absent" },
      };
    },
    verifyWindowsWfpEgress: async () => {
      options.onVerify?.();
      if (!(options.windowsReady?.() ?? true)) throw new Error("WFP is not ready");
      return {};
    },
    installWindowsSandboxAsync: async () => {
      options.onInstall?.();
      return { cancelled: options.installCancelled?.() ?? false };
    },
  };
}

describe("sandbox command execution boundary", () => {
  it("serializes the Windows SRT ACL lease and recovers an abandoned owner", async () => {
    await withWorkspace(async (root) => {
      const livePath = path.join(root, "live-windows-acl.lock");
      let token = 0;
      const lock = new WindowsSandboxProcessLock(livePath, {
        waitTimeoutMs: 1_000,
        pollIntervalMs: 5,
        createToken: () => `token-${String(++token)}`,
      });
      const releaseFirst = await lock.acquire();
      let secondAcquired = false;
      const second = lock.acquire().then((release) => {
        secondAcquired = true;
        return release;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(secondAcquired, false);
      await releaseFirst();
      const releaseSecond = await second;
      assert.equal(secondAcquired, true);
      await releaseSecond();

      const abandonedPath = path.join(root, "abandoned-windows-acl.lock");
      await mkdir(abandonedPath);
      await writeFile(
        path.join(abandonedPath, "owner.json"),
        JSON.stringify({
          pid: 999_999,
          token: "abandoned",
          acquiredAt: new Date(0).toISOString(),
        }),
        "utf8",
      );
      const recovery = new WindowsSandboxProcessLock(abandonedPath, {
        waitTimeoutMs: 1_000,
        pollIntervalMs: 5,
        isProcessAlive: () => false,
      });
      const releaseRecovered = await recovery.acquire();
      await releaseRecovered();
      await assert.rejects(
        access(abandonedPath),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    });
  });

  it("uses a dedicated host backend only for active dangerous full access", async () => {
    await withWorkspace(async (root, manager) => {
      const request = sandboxRequest(root);
      const dangerousRequest: SandboxExecutionRequest = {
        ...request,
        context: {
          ...request.context,
          commandExecutionMode: "unrestricted",
          isUnrestrictedHostAccessActive: () => true,
        },
      };
      const host = new UnrestrictedHostBackend();
      const prepared = await host.prepare(dangerousRequest);
      assert.equal(prepared.executablePath, process.execPath);
      assert.deepEqual(prepared.args, request.command.args);
      assert.equal(prepared.cwdAbsolute, root);
      assert.deepEqual(prepared.metadata, {
        backend: "host-unrestricted",
        enforced: false,
        filesystem: "host",
        network: "host",
      });
      await prepared.cleanup();

      await assert.rejects(
        () => host.prepare(request),
        /requires active user-confirmed dangerous mode/iu,
      );
      await assert.rejects(
        () => new AnthropicSandboxBackend(manager).prepare(dangerousRequest),
        /dedicated host backend/iu,
      );
    });
  });

  it("encodes, extracts, and scopes sandbox worker control markers", () => {
    const commandId = "command-owned";
    const owned = encodeSandboxControl(commandId, {
      type: "ready",
      backend: "anthropic-srt-linux",
    });
    const foreign = encodeSandboxControl("command-foreign", {
      type: "sandbox_error",
      message: "belongs to another command",
    });
    const originalText = `before\n${owned}middle\n${foreign}after`;

    assert.doesNotMatch(owned, /"type"|anthropic-srt-linux/u);
    const extracted = extractSandboxControls(commandId, {
      head: `before\n${owned}middle\n`,
      tail: `${foreign}after`,
      text: originalText,
      totalBytes: Buffer.byteLength(originalText),
      truncated: false,
    });

    assert.deepEqual(extracted.controls, [
      { type: "ready", backend: "anthropic-srt-linux" },
    ]);
    assert.equal(extracted.digest.text, `before\nmiddle\n${foreign}after`);
    assert.equal(extracted.digest.head, "before\nmiddle\n");
    assert.equal(extracted.digest.tail, `${foreign}after`);
    assert.equal(extracted.digest.truncated, false);
  });

  it("prepares a structured worker payload and removes its scratch data", async () => {
    await withWorkspace(async (root, manager) => {
      const backend = new AnthropicSandboxBackend(manager, {
        sensitiveReadPaths: [path.join(root, "private-fixture")],
        windowsAclPreflight: { check: async () => undefined },
        windowsSandboxReadProbe: runtimeReadableWindowsProbe,
      });
      const request = sandboxRequest(root);
      const prepared = await backend.prepare(request);
      const payloadPath = prepared.args[1];
      assert.ok(payloadPath, "sandbox worker payload path was not provided");

      try {
        assert.equal(prepared.executablePath, process.execPath);
        assert.equal(prepared.args.length, 2);
        assert.equal(prepared.cwdAbsolute, root);
        assert.equal(prepared.environment.EASY_CODE_TEST_ENV, "preserved-value");
        assert.equal(prepared.environment.EASY_CODE_SRT_WORKER, "1");

        const payload = JSON.parse(
          await readFile(payloadPath, "utf8"),
        ) as SandboxWorkerPayload;
        assert.equal(payload.version, 1);
        assert.equal(payload.commandId, request.commandId);
        assert.equal(payload.commandPreview, request.commandPreview);
        assert.equal(payload.workspaceRoot, root);
        assert.equal(pathIsWithin(payload.scratchRoot, payload.bridgePath), true);
        assert.match(payload.bridgePath, /argv-bridge\.mjs$/u);
        assert.match(await readFile(payload.bridgePath, "utf8"), /node:child_process/u);
        assert.equal(
          await access(path.join(path.dirname(payload.bridgePath), "node_modules"))
            .then(() => true, () => false),
          false,
        );
        assert.equal(payload.target.executablePath, process.execPath);
        assert.deepEqual(payload.target.args, request.command.args);
        assert.equal(payload.target.cwdAbsolute, root);
        assert.equal(payload.target.environment.EASY_CODE_TEST_ENV, "preserved-value");
        assert.equal(payload.target.environment.EASY_CODE_SANDBOXED, "1");
        assert.equal(payload.target.environment.HOME, path.join(payload.scratchRoot, "home"));
        assert.deepEqual(payload.network.allowedDomains, []);
        assert.equal(payload.filesystem.allowWrite.includes(root), true);
        assert.equal(
          payload.filesystem.denyRead.includes(path.resolve(root, "private-fixture")),
          true,
        );
        assert.equal(
          payload.filesystem.denyRead.includes(path.dirname(payload.scratchRoot)),
          process.platform !== "win32",
        );
        assert.equal(payload.filesystem.denyRead.includes(payloadPath), true);
        if (process.platform === "win32") {
          assert.equal(payload.filesystem.denyRead.includes(path.resolve(os.homedir())), false);
          assert.equal(
            payload.filesystem.denyRead.includes(path.resolve(os.homedir(), ".ssh")),
            false,
          );
        }
        assert.equal(payload.filesystem.allowRead.includes(path.dirname(process.execPath)), false);
        assert.equal(payload.filesystem.allowRead.includes(root), false);
        const runtimeRoot = path.resolve(path.dirname(prepared.args[0]!), "..", "..");
        assert.equal(payload.filesystem.allowRead.includes(runtimeRoot), false);
        assert.equal(
          payload.filesystem.denyWrite.every((filename) => pathIsWithin(root, filename)),
          true,
        );
        assert.equal(
          payload.filesystem.denyWrite.includes(
            `${path.join(root, ".easycode")}${path.sep}`,
          ),
          true,
        );
        assert.equal(
          payload.filesystem.denyWrite.includes(
            `${path.join(root, ".git")}${path.sep}`,
          ),
          true,
        );
      } finally {
        await prepared.cleanup();
        await prepared.cleanup();
      }

      await assert.rejects(
        access(payloadPath),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    });
  });

  it("does not request redundant Windows grants for shared installed-program roots", () => {
    const environment = {
      SystemDrive: "C:",
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramW6432: "C:\\Program Files",
      ProgramData: "C:\\ProgramData",
    };
    assert.equal(
      isWindowsSharedExecutablePath("C:\\Program Files\\Git\\cmd\\git.exe", environment),
      true,
    );
    assert.equal(
      isWindowsSharedExecutablePath("C:\\Windows\\System32\\cmd.exe", environment),
      true,
    );
    assert.equal(
      isWindowsSharedExecutablePath("E:\\nvm\\v20.20.2\\node.exe", environment),
      false,
    );
  });

  it("omits an external sensitive deny only after the restricted account proves it unreadable", async () => {
    if (process.platform !== "win32") return;
    const outside = await mkdtemp(path.join(os.tmpdir(), "easy-code-sensitive-unreadable-"));
    try {
      await withWorkspace(async (root, manager) => {
        const backend = new AnthropicSandboxBackend(manager, {
          sensitiveReadPaths: [outside],
          windowsAclPreflight: { check: async () => undefined },
          windowsSandboxReadProbe: runtimeReadableWindowsProbe,
        });
        const prepared = await backend.prepare(sandboxRequest(root));
        try {
          const payload = JSON.parse(
            await readFile(prepared.args[1]!, "utf8"),
          ) as SandboxWorkerPayload;
          assert.equal(
            payload.filesystem.denyRead.includes(path.resolve(outside)),
            false,
          );
        } finally {
          await prepared.cleanup();
        }
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("fails fast when the restricted-account read proof is unavailable", async () => {
    if (process.platform !== "win32") return;
    const outside = await mkdtemp(path.join(os.tmpdir(), "easy-code-sensitive-unknown-"));
    try {
      await withWorkspace(async (root, manager) => {
        const backend = new AnthropicSandboxBackend(manager, {
          sensitiveReadPaths: [outside],
          windowsAclPreflight: { check: async () => undefined },
          windowsSandboxReadProbe: {
            pathAccess: async () => {
              throw new Error("probe unavailable");
            },
          },
        });
        const startedAt = Date.now();
        await assert.rejects(
          backend.prepare(sandboxRequest(root)),
          /Windows SRT restricted-account preflight failed before sandbox initialization: probe unavailable/u,
        );
        assert.ok(Date.now() - startedAt < 5_000);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("cancels Windows sensitive-path preparation and releases the process lease", async () => {
    if (process.platform !== "win32") return;
    await withWorkspace(async (root, manager) => {
      const backend = new AnthropicSandboxBackend(manager, {
        windowsAclPreflight: { check: async () => undefined },
        windowsSandboxReadProbe: runtimeReadableWindowsProbe,
      });
      const cancelled = sandboxRequest(root);
      const controller = new AbortController();
      controller.abort();
      cancelled.context.signal = controller.signal;
      await assert.rejects(
        backend.prepare(cancelled),
        (error: Error) => error.name === "AbortError",
      );

      const prepared = await backend.prepare(sandboxRequest(root));
      await prepared.cleanup();
    });
  });

  it("uses an exact-file grant when a private Windows executable is not readable", async () => {
    if (process.platform !== "win32") return;
    await withWorkspace(async (root, manager) => {
      const backend = new AnthropicSandboxBackend(manager, {
        windowsAclPreflight: { check: async () => undefined },
        windowsSandboxReadProbe: {
          pathAccess: async (paths) => new Map(paths.map((candidate) => [
            path.win32.resolve(candidate).toLowerCase(),
            "unknown" as const,
          ])),
        },
      });
      const prepared = await backend.prepare(sandboxRequest(root));
      try {
        const payload = JSON.parse(
          await readFile(prepared.args[1]!, "utf8"),
        ) as SandboxWorkerPayload;
        const executable = await realpath(process.execPath);
        assert.equal(payload.filesystem.allowRead.includes(executable), true);
        assert.equal(
          payload.filesystem.allowRead.includes(path.dirname(executable)),
          false,
        );
      } finally {
        await prepared.cleanup();
      }
    });
  });

  it("stages a standalone argv bridge that preserves structured arguments", async () => {
    await withWorkspace(async (root, manager) => {
      const backend = new AnthropicSandboxBackend(manager, {
        windowsAclPreflight: { check: async () => undefined },
        windowsSandboxReadProbe: runtimeReadableWindowsProbe,
      });
      const prepared = await backend.prepare(sandboxRequest(root));
      const workerPayloadPath = prepared.args[1]!;
      try {
        const workerPayload = JSON.parse(
          await readFile(workerPayloadPath, "utf8"),
        ) as SandboxWorkerPayload;
        const fixturePath = path.join(workerPayload.scratchRoot, "capture-argv.cjs");
        const outputPath = path.join(workerPayload.scratchRoot, "captured.json");
        const targetPayloadPath = path.join(workerPayload.scratchRoot, "bridge-target.json");
        await writeFile(
          fixturePath,
          "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n",
          "utf8",
        );
        const expected = ["argument with spaces", "literal;&|value", "quote\"value", "tail\\"];
        await writeFile(targetPayloadPath, JSON.stringify({
          executablePath: process.execPath,
          args: [fixturePath, outputPath, ...expected],
          cwdAbsolute: root,
          environment: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
          },
        }), "utf8");

        await execFileAsync(process.execPath, [workerPayload.bridgePath, targetPayloadPath]);
        assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), expected);

        if (process.platform === "win32") {
          const batchPath = path.join(workerPayload.scratchRoot, "capture-argv.cmd");
          const batchOutputPath = path.join(workerPayload.scratchRoot, "captured-batch.json");
          const batchPayloadPath = path.join(workerPayload.scratchRoot, "bridge-batch-target.json");
          await writeFile(
            batchPath,
            `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`,
            "utf8",
          );
          await writeFile(batchPayloadPath, JSON.stringify({
            executablePath: batchPath,
            args: [batchOutputPath, ...expected],
            cwdAbsolute: root,
            environment: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
            },
          }), "utf8");
          await execFileAsync(process.execPath, [workerPayload.bridgePath, batchPayloadPath]);
          assert.deepEqual(JSON.parse(await readFile(batchOutputPath, "utf8")), expected);
        }
      } finally {
        await prepared.cleanup();
      }
    });
  });

  it("fails fast with the owner and path when Windows cannot change a required DACL", async () => {
    await withWorkspace(async (root, manager) => {
      let observedProbes: readonly { path: string; reasons: readonly string[] }[] = [];
      const backend = new AnthropicSandboxBackend(manager, {
        platform: "win32",
        windowsSandboxReadProbe: runtimeReadableWindowsProbe,
        windowsAclPreflight: {
          check: async (probes) => {
            observedProbes = probes;
            const message = formatWindowsAclPreflightFailure(
              {
                identity: "DESKTOP\\developer",
                entries: [{
                  path: root,
                  owner: "DESKTOP\\CodexSandboxOffline",
                  canWriteDacl: false,
                }],
              },
              probes,
              root,
            );
            assert.ok(message);
            throw new Error(message);
          },
        },
      });
      const startedAt = Date.now();
      await assert.rejects(
        () => backend.prepare(sandboxRequest(root)),
        (error: Error) => {
          assert.match(error.message, /WRITE_DAC \(Change permissions\)/u);
          assert.match(error.message, /CodexSandboxOffline/u);
          assert.match(error.message, /target command was not started/u);
          assert.match(error.message, /before the 75-second SRT initialization timeout/u);
          assert.match(error.message, /sandbox repair-workspace --target/u);
          assert.match(error.message, /--apply --confirm/u);
          assert.match(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
          return true;
        },
      );
      assert.ok(Date.now() - startedAt < 1_000, "ACL preflight did not fail fast");
      const workspaceProbe = observedProbes.find(
        (probe) => path.resolve(probe.path).toLowerCase() === path.resolve(root).toLowerCase(),
      );
      assert.ok(workspaceProbe, "workspace ACL was not preflighted");
      assert.equal(workspaceProbe.reasons.includes("allow-write grant"), true);
    });
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
      assert.match(output.stderr.text, /last worker stage: initialize_start/iu);
      assert.equal(output.sandboxFailure?.phase, "initialization");
      assert.equal(output.sandboxFailure?.retryable, true);
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
      /manual and auto-approved commands remain fail-closed/iu,
    );

    const exiting = new ScriptedSandboxTerminal(["exit"]);
    assert.equal(await runSandboxStartupGuide(service, exiting), false);

    const canceling = new ScriptedSandboxTerminal([undefined]);
    assert.equal(await runSandboxStartupGuide(service, canceling), false);
  });
});

describe("platform sandbox startup service", () => {
  it("recognizes a fully provisioned Windows sandbox", async () => {
    let verifyCalls = 0;
    let probeCommand: SandboxSystemCommand | undefined;
    const service = new DefaultSandboxStartupService({
      platform: "win32",
      environment: {},
      loadRuntime: async () => runtimeFixture({
        onVerify: () => {
          verifyCalls += 1;
        },
      }),
      runWindowsProbeWorker: async (command) => {
        probeCommand = command;
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    });

    const result = await service.inspect();
    assert.equal(result.status, "ready");
    assert.equal(result.canSetup, false);
    assert.equal(verifyCalls, 1);
    assert.equal(probeCommand?.executablePath, process.execPath);
    assert.match(probeCommand?.args[0] ?? "", /sandbox-probe-worker\.js$/u);
    assert.equal(probeCommand?.timeoutMs, 30_000);
    assert.equal(probeCommand?.environment?.EASY_CODE_SANDBOX_PROBE_WORKER, "1");
    assert.equal(probeCommand?.environment?.DEEPSEEK_API_KEY, undefined);
  });

  it("fails a hung Windows ACL probe at the parent-owned deadline", async () => {
    let workerCalls = 0;
    const service = new DefaultSandboxStartupService({
      platform: "win32",
      environment: { DEEPSEEK_API_KEY: "must-not-reach-probe" },
      loadRuntime: async () => runtimeFixture(),
      windowsProbeTimeoutMs: 37,
      runWindowsProbeWorker: async (command) => {
        workerCalls += 1;
        assert.equal(command.timeoutMs, 37);
        assert.equal(command.environment?.DEEPSEEK_API_KEY, undefined);
        return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      },
    });

    const result = await service.inspect();

    assert.equal(workerCalls, 1);
    assert.equal(result.status, "probe_failed");
    assert.equal(result.canSetup, false);
    assert.match(result.details.join(" "), /timed out after 37ms/iu);
    assert.match(result.details.join(" "), /process tree was terminated/iu);
  });

  it("requires Windows setup, installs once, and verifies the live result", async () => {
    let ready = false;
    let installCalls = 0;
    let statusCalls = 0;
    let verifyCalls = 0;
    const runtime = runtimeFixture({
      windowsReady: () => ready,
      onInstall: () => {
        installCalls += 1;
        ready = true;
      },
      onVerify: () => {
        verifyCalls += 1;
      },
    });
    const originalStatus = runtime.checkWindowsSandboxStatusAsync;
    runtime.checkWindowsSandboxStatusAsync = async () => {
      statusCalls += 1;
      return await originalStatus();
    };
    const service = new DefaultSandboxStartupService({
      platform: "win32",
      environment: {},
      loadRuntime: async () => runtime,
      probe: async () => undefined,
    });

    const before = await service.inspect();
    assert.equal(before.status, "setup_required");
    assert.equal(before.canSetup, true);
    const result = await service.setup(before);

    assert.equal(result.status, "completed");
    assert.equal(result.readiness.status, "ready");
    assert.equal(installCalls, 1);
    assert.equal(statusCalls, 2, "Windows setup did not perform a fresh status check");
    assert.equal(verifyCalls, 1, "Windows setup did not verify the WFP fence");
  });

  it("reports Windows UAC cancellation without claiming readiness", async () => {
    let installCalls = 0;
    const service = new DefaultSandboxStartupService({
      platform: "win32",
      environment: {},
      loadRuntime: async () => runtimeFixture({
        windowsReady: () => false,
        installCancelled: () => true,
        onInstall: () => {
          installCalls += 1;
        },
      }),
    });
    const before = await service.inspect();
    const result = await service.setup(before);

    assert.equal(result.status, "cancelled");
    assert.equal(result.readiness, before);
    assert.equal(result.readiness.status, "setup_required");
    assert.equal(installCalls, 1);
  });

  it("fails fast when Windows SRT is nested inside a restricted Codex process", async () => {
    let runtimeLoads = 0;
    const service = new DefaultSandboxStartupService({
      platform: "win32",
      environment: {
        CODEX_PERMISSION_PROFILE: ":workspace",
        CODEX_SANDBOX_NETWORK_DISABLED: "1",
      },
      loadRuntime: async () => {
        runtimeLoads += 1;
        return runtimeFixture();
      },
    });

    const result = await service.inspect();

    assert.equal(result.status, "probe_failed");
    assert.equal(result.canSetup, false);
    assert.equal(runtimeLoads, 0);
    assert.match(result.details.join(" "), /restricted Codex process sandbox/iu);
    assert.match(result.details.join(" "), /ordinary PowerShell/iu);
  });

  it("does not mistake a full-access Codex profile for a restricted outer sandbox", async () => {
    let workerCalls = 0;
    const service = new DefaultSandboxStartupService({
      platform: "win32",
      environment: { CODEX_PERMISSION_PROFILE: ":full" },
      loadRuntime: async () => runtimeFixture(),
      runWindowsProbeWorker: async () => {
        workerCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    });

    const result = await service.inspect();

    assert.equal(result.status, "ready");
    assert.equal(workerCalls, 1);
  });

  it("uses only fixed Linux package-manager argv and non-interactive sudo", async () => {
    const cases = [
      {
        osRelease: "ID=ubuntu\nID_LIKE=debian\n",
        managerPath: "/usr/bin/apt-get",
        managerArgs: ["install", "-y", "bubblewrap", "socat", "ripgrep"],
      },
      {
        osRelease: "ID=fedora\n",
        managerPath: "/usr/bin/dnf",
        managerArgs: ["install", "-y", "bubblewrap", "socat", "ripgrep"],
      },
      {
        osRelease: "ID=arch\n",
        managerPath: "/usr/bin/pacman",
        managerArgs: ["-S", "--needed", "--noconfirm", "bubblewrap", "socat", "ripgrep"],
      },
      {
        osRelease: "ID=opensuse-tumbleweed\nID_LIKE=suse\n",
        managerPath: "/usr/bin/zypper",
        managerArgs: [
          "--non-interactive",
          "install",
          "--no-recommends",
          "bubblewrap",
          "socat",
          "ripgrep",
        ],
      },
      {
        osRelease: "ID=alpine\n",
        managerPath: "/sbin/apk",
        managerArgs: ["add", "--no-cache", "bubblewrap", "socat", "ripgrep", "bash"],
      },
    ] as const;

    for (const fixture of cases) {
      let dependenciesMissing = true;
      const commands: SandboxSystemCommand[] = [];
      const runtime = runtimeFixture({
        dependencies: () => dependenciesMissing
          ? {
              errors: ["bubblewrap is missing", "socat is missing", "ripgrep is missing"],
              warnings: [],
            }
          : { errors: [], warnings: [] },
      });
      const service = new DefaultSandboxStartupService({
        platform: "linux",
        loadRuntime: async () => runtime,
        readTextFile: async (filename) => {
          assert.equal(filename, "/etc/os-release");
          return fixture.osRelease;
        },
        resolveExecutable: async (candidates) => {
          if (!dependenciesMissing) {
            if (candidates.includes("/usr/bin/bwrap")) return "/usr/bin/bwrap";
            if (candidates.includes("/usr/bin/socat")) return "/usr/bin/socat";
            if (candidates.includes("/usr/bin/rg")) return "/usr/bin/rg";
          }
          if (candidates.includes(fixture.managerPath)) return fixture.managerPath;
          if (candidates.includes("/usr/bin/sudo")) return "/usr/bin/sudo";
          return undefined;
        },
        getUid: () => 1_000,
        runCommand: async (command) => {
          commands.push(command);
          if (command.args[0] === "-n" && command.args[1] === "--") {
            dependenciesMissing = false;
          }
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
        probe: async () => undefined,
      });

      const before = await service.inspect();
      assert.equal(before.status, "dependencies_missing", fixture.osRelease);
      const result = await service.setup(before);
      assert.equal(result.status, "completed", fixture.osRelease);
      assert.equal(result.readiness.status, "ready", fixture.osRelease);
      assert.equal(commands.length, 2, fixture.osRelease);
      assert.equal(commands[0]?.executablePath, "/usr/bin/sudo");
      assert.deepEqual(commands[0]?.args, ["-n", "true"]);
      assert.equal(commands[0]?.timeoutMs, 10_000);
      assert.equal(
        commands[0]?.environment?.PATH,
        "/opt/homebrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      );
      assert.equal(commands[1]?.executablePath, "/usr/bin/sudo");
      assert.deepEqual(
        commands[1]?.args,
        ["-n", "--", fixture.managerPath, ...fixture.managerArgs],
      );
      if (fixture.managerPath === "/usr/bin/apt-get") {
        assert.equal(commands[1]?.environment?.DEBIAN_FRONTEND, "noninteractive");
      }
    }
  });

  it("fails closed for an unknown Linux distribution without running a command", async () => {
    let commandCalls = 0;
    const runtime = runtimeFixture({
      dependencies: () => ({
        errors: ["bubblewrap is missing"],
        warnings: [],
      }),
    });
    const service = new DefaultSandboxStartupService({
      platform: "linux",
      loadRuntime: async () => runtime,
      readTextFile: async () => "ID=unknown-fixture\n",
      resolveExecutable: async () => undefined,
      runCommand: async () => {
        commandCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
      getUid: () => 1_000,
      probe: async () => undefined,
    });

    const before = await service.inspect();
    const result = await service.setup(before);
    assert.equal(result.status, "unavailable");
    assert.match(result.message, /No trusted, supported package manager/u);
    assert.equal(result.readiness, before);
    assert.equal(commandCalls, 0);
  });
});
