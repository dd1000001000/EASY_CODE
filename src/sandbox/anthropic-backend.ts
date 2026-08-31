import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { WorkspaceManager } from "../workspace/manager.js";
import type {
  CommandExecutionBackend,
  PreparedCommand,
  SandboxExecutionMetadata,
  SandboxExecutionRequest,
  SandboxWorkerPayload,
} from "./types.js";

class AsyncGate {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
}

// SRT's Windows backend uses one machine-wide sandbox account/SID. Serializing
// within this EASY CODE process prevents concurrent child Worktrees from
// receiving overlapping ACL grants through that identity.
const SANDBOX_SCRATCH_PARENT = path.join(os.tmpdir(), "easy-code-srt-runtime");
const WINDOWS_SANDBOX_GATE = new AsyncGate();

export interface AnthropicSandboxBackendOptions {
  sensitiveReadPaths?: readonly string[];
}

function uniquePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(value);
    const directoryHint = /[\\/]$/u.test(value);
    const normalized = directoryHint ? `${resolved}${path.sep}` : resolved;
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function defaultSensitiveReadPaths(): string[] {
  const home = os.homedir();
  return uniquePaths([
    home,
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".config", "gcloud"),
  ]);
}

function sandboxMetadata(request: SandboxExecutionRequest): SandboxExecutionMetadata {
  const network = request.policyDecision.capability === "shell_exec"
    ? "allowed"
    : request.policyDecision.capability === "registry_install"
      ? "registry-only"
      : "denied";
  return {
    backend: process.platform === "win32"
      ? "anthropic-srt-windows"
      : process.platform === "darwin"
        ? "anthropic-srt-macos"
        : "anthropic-srt-linux",
    enforced: true,
    filesystem: "workspace-write",
    network,
  };
}

function networkDomains(request: SandboxExecutionRequest): string[] {
  if (
    request.policyDecision.capability === "shell_exec"
  ) {
    return ["*"];
  }
  if (request.policyDecision.capability === "registry_install") {
    return ["registry.npmjs.org"];
  }
  return [];
}

function assertScratchPath(scratchRoot: string): void {
  const temporaryRoot = path.resolve(SANDBOX_SCRATCH_PARENT);
  const resolved = path.resolve(scratchRoot);
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith("command-")) {
    throw new Error("Refusing to clean an invalid EASY CODE sandbox scratch path");
  }
}

async function protectedMetadataPaths(values: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(values.map(async (value) => {
    try {
      await stat(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // SRT uses a trailing separator to materialize a directory placeholder
        // instead of the old zero-byte file shape. Keeping the deny closes the
        // TOCTOU where a sandboxed command creates reserved metadata later.
        return `${value}${path.sep}`;
      }
      throw error;
    }
  }));
  return resolved;
}

export class AnthropicSandboxBackend implements CommandExecutionBackend {
  private readonly runtimeRoot: string;
  private readonly workerPath: string;
  private readonly bridgePath: string;
  private readonly srtPackageRoot: string;
  private readonly sensitiveReadPaths: string[];

  constructor(
    private readonly workspace: WorkspaceManager,
    options: AnthropicSandboxBackendOptions = {},
  ) {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    this.runtimeRoot = path.resolve(moduleDirectory, "..", "..");
    this.workerPath = path.join(moduleDirectory, "sandbox-worker.js");
    this.bridgePath = path.join(moduleDirectory, "argv-bridge.js");
    const srtEntry = createRequire(import.meta.url).resolve(
      "@anthropic-ai/sandbox-runtime",
    );
    this.srtPackageRoot = path.resolve(path.dirname(srtEntry), "..");
    this.sensitiveReadPaths = uniquePaths([
      ...defaultSensitiveReadPaths(),
      ...(options.sensitiveReadPaths ?? []),
    ]);
  }

  describe(request?: SandboxExecutionRequest): SandboxExecutionMetadata {
    if (request) return sandboxMetadata(request);
    return {
      backend: process.platform === "win32"
        ? "anthropic-srt-windows"
        : process.platform === "darwin"
          ? "anthropic-srt-macos"
          : "anthropic-srt-linux",
      enforced: true,
      filesystem: "workspace-write",
      network: "denied",
    };
  }

  async prepare(request: SandboxExecutionRequest): Promise<PreparedCommand> {
    if (request.context.commandExecutionMode === "unrestricted") {
      throw new Error("Dangerous full access must use the dedicated host backend");
    }
    const releaseGate = process.platform === "win32"
      ? await WINDOWS_SANDBOX_GATE.acquire()
      : () => undefined;
    let scratchRoot = "";
    try {
      await mkdir(SANDBOX_SCRATCH_PARENT, { recursive: true, mode: 0o700 });
      scratchRoot = await mkdtemp(path.join(SANDBOX_SCRATCH_PARENT, "command-"));
      const scratchHome = path.join(scratchRoot, "home");
      const scratchTemp = path.join(scratchRoot, "tmp");
      const scratchConfig = path.join(scratchRoot, "config");
      const scratchCache = path.join(scratchRoot, "cache");
      await Promise.all([
        mkdir(scratchHome),
        mkdir(scratchTemp),
        mkdir(scratchConfig),
        mkdir(scratchCache),
      ]);

      const targetEnvironment: NodeJS.ProcessEnv = {
        ...request.command.environment,
        HOME: scratchHome,
        USERPROFILE: scratchHome,
        TEMP: scratchTemp,
        TMP: scratchTemp,
        TMPDIR: scratchTemp,
        APPDATA: scratchConfig,
        LOCALAPPDATA: scratchCache,
        XDG_CONFIG_HOME: scratchConfig,
        XDG_CACHE_HOME: scratchCache,
        EASY_CODE_SANDBOXED: "1",
      };
      const protectedMetadata = await protectedMetadataPaths([
        path.join(this.workspace.root, ".easycode"),
        path.join(this.workspace.root, ".git"),
      ]);
      const protectedWorkspacePaths = [
        ...protectedMetadata,
        this.workerPath,
        this.bridgePath,
        this.srtPackageRoot,
      ];
      const payloadPath = path.join(scratchRoot, "worker-payload.json");

      const payload: SandboxWorkerPayload = {
        version: 1,
        commandId: request.commandId,
        commandPreview: request.commandPreview,
        workspaceRoot: this.workspace.root,
        scratchRoot,
        runtimeRoot: this.runtimeRoot,
        target: {
          executablePath: request.command.executablePath,
          args: [...request.command.args],
          cwdAbsolute: request.command.cwdAbsolute,
          environment: targetEnvironment,
        },
        filesystem: {
          // The target can read its own target-payload.json through the fixed
          // bridge, but it must not learn the parent-only commandId from this
          // worker payload and forge Runtime control markers.
          denyRead: uniquePaths([
            ...this.sensitiveReadPaths,
            SANDBOX_SCRATCH_PARENT,
            payloadPath,
          ]),
          allowRead: uniquePaths([
            this.workspace.root,
            scratchRoot,
            this.runtimeRoot,
            path.dirname(process.execPath),
            path.dirname(request.command.executablePath),
          ]),
          allowWrite: uniquePaths([this.workspace.root, scratchRoot]),
          denyWrite: uniquePaths(protectedWorkspacePaths),
          allowGitConfig: false,
        },
        network: { allowedDomains: networkDomains(request) },
      };
      await writeFile(payloadPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });

      let cleaned = false;
      return {
        executablePath: process.execPath,
        args: [this.workerPath, payloadPath],
        cwdAbsolute: request.command.cwdAbsolute,
        // The broker needs ordinary OS discovery variables, but this is still
        // the Resolver's credential-free environment. The target gets the
        // tighter scratch HOME/TEMP environment stored in the payload.
        environment: {
          ...request.command.environment,
          EASY_CODE_SRT_WORKER: "1",
        },
        metadata: this.describe(request),
        cleanup: async () => {
          if (cleaned) return;
          cleaned = true;
          try {
            assertScratchPath(scratchRoot);
            await rm(scratchRoot, { recursive: true, force: true });
          } finally {
            releaseGate();
          }
        },
      };
    } catch (error) {
      try {
        if (scratchRoot) {
          assertScratchPath(scratchRoot);
          await rm(scratchRoot, { recursive: true, force: true });
        }
      } finally {
        releaseGate();
      }
      throw error;
    }
  }
}
