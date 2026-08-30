import { execa } from "execa";
import type { ToolContext } from "../core/types.js";
import { createId } from "../utils/ids.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import {
  AnthropicSandboxBackend,
  extractSandboxControls,
  type CommandExecutionBackend,
  type PreparedCommand,
  type SandboxExecutionMetadata,
  type SandboxExecutionRequest,
} from "../sandbox/index.js";
import { terminateProcessTree } from "./lifecycle.js";
import { OutputCollector, sanitizeCommandOutput } from "./output-stream.js";
import { CommandPolicy } from "./policy.js";
import { CommandResolver } from "./resolver.js";
import {
  summarizeWorkspaceDelta,
  type CommandPolicyDecision,
  type OutputDigest,
  type ResolvedCommand,
  type RunCommandInput,
  type RunCommandOutput,
} from "./types.js";

interface ProcessResult {
  exitCode?: number;
  signal?: string;
  failed?: boolean;
  timedOut?: boolean;
  isCanceled?: boolean;
  killed?: boolean;
  code?: string;
}

function emptyDigest(): OutputDigest {
  return { head: "", tail: "", text: "", totalBytes: 0, truncated: false };
}

function redactArguments(args: readonly string[]): string[] {
  const secretFlag = /^(?:--?(?:api[-_]?key|token|password|passwd|secret|auth))$/iu;
  const secretAssignment = /^(--?(?:api[-_]?key|token|password|passwd|secret|auth)=).+$/iu;
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }
    if (secretFlag.test(argument)) {
      redactNext = true;
      return argument;
    }
    if (secretAssignment.test(argument)) return argument.replace(secretAssignment, "$1[REDACTED]");
    return sanitizeCommandOutput(argument);
  });
}

function commandPreview(command: ResolvedCommand): string {
  return JSON.stringify([command.executablePath, ...redactArguments(command.args)]);
}

function hardTimeoutFor(policy: CommandPolicyDecision): number {
  if (policy.capability === "safe_inspect") return 60_000;
  if (policy.capability === "registry_install") return 20 * 60_000;
  return 15 * 60_000;
}

export class CommandRuntime {
  readonly resolver: CommandResolver;
  readonly policy: CommandPolicy;
  private readonly executionBackend: CommandExecutionBackend;

  constructor(
    private readonly workspace: WorkspaceManager,
    policy = new CommandPolicy(),
    executionBackend?: CommandExecutionBackend,
  ) {
    this.resolver = new CommandResolver(workspace);
    this.policy = policy;
    this.executionBackend = executionBackend ?? new AnthropicSandboxBackend(workspace);
  }

  async run(input: RunCommandInput, context: ToolContext): Promise<RunCommandOutput> {
    const commandId = createId("command");
    const startedAt = Date.now();
    let resolved: ResolvedCommand;
    try {
      resolved = await this.resolver.resolve(input);
    } catch (error) {
      return this.resolutionFailure(commandId, startedAt, input, error, context);
    }
    let policyDecision = this.policy.classify(input, resolved, context.mode);
    const unrestricted = context.commandExecutionMode === "unrestricted";
    if (unrestricted) {
      policyDecision = {
        ...policyDecision,
        id: createId("policy"),
        effect: "allow",
        reason:
          "User explicitly enabled unrestricted command execution for this EASY CODE process",
        matchedRule: "allow.unrestricted",
      };
    }
    const fingerprint = this.policy.approvalFingerprint(resolved, policyDecision);

    const shouldAsk = !unrestricted &&
      (policyDecision.effect === "ask" || context.approvalPolicy === "ask");
    if (policyDecision.effect === "deny") {
      return this.denied(commandId, startedAt, resolved, policyDecision, context);
    }
    if (shouldAsk) {
      if (context.approvalPolicy === "never") {
        policyDecision = {
          ...policyDecision,
          effect: "deny",
          reason: `${policyDecision.reason}; approval prompts are disabled`,
        };
        return this.denied(commandId, startedAt, resolved, policyDecision, context);
      }
      let approved = false;
      try {
        approved = await context.requestApproval({
          id: fingerprint,
          title: `Run ${resolved.program}`,
          description: `${policyDecision.reason}. cwd=${resolved.cwdRelative}; exact approval=${fingerprint}`,
          risk: policyDecision.risk,
          // This value is produced by CommandResolver after PATH lookup and
          // realpath canonicalization. The UI must never derive a reusable
          // grant by parsing the redacted human-readable preview below.
          commandPrefix: resolved.executablePath,
          commandPreview: commandPreview(resolved),
        });
      } catch {
        approved = false;
      }
      if (!approved) {
        policyDecision = {
          ...policyDecision,
          effect: "deny",
          reason: `${policyDecision.reason}; approval was not granted`,
        };
        return this.denied(commandId, startedAt, resolved, policyDecision, context);
      }
    }

    const sandboxRequest: SandboxExecutionRequest = {
      commandId,
      command: resolved,
      policyDecision,
      context,
      commandPreview: commandPreview(resolved),
    };
    if (context.signal?.aborted) {
      return this.canceledBeforeStart(
        commandId,
        startedAt,
        resolved,
        policyDecision,
        context,
        this.executionBackend.describe(sandboxRequest),
      );
    }

    const before = await this.workspace.captureSnapshot();
    let prepared: PreparedCommand;
    try {
      prepared = await this.executionBackend.prepare(sandboxRequest);
    } catch (error) {
      return this.sandboxFailure(
        commandId,
        startedAt,
        resolved,
        policyDecision,
        context,
        error,
        sandboxRequest,
      );
    }
    if (context.signal?.aborted) {
      try {
        await prepared.cleanup();
      } catch {
        // The cancellation result remains authoritative; a later doctor run
        // can diagnose cleanup failures without starting the target command.
      }
      return this.canceledBeforeStart(
        commandId,
        startedAt,
        resolved,
        policyDecision,
        context,
        prepared.metadata,
      );
    }
    const maxOutputChars = Math.max(256, Math.min(context.maxOutputChars, 1_000_000));
    const stdout = new OutputCollector(maxOutputChars);
    const stderr = new OutputCollector(maxOutputChars);
    const requestedTimeout = input.timeoutMs ?? context.commandTimeoutMs;
    const timeoutMs = Math.max(
      1,
      Math.min(requestedTimeout, context.commandTimeoutMs, hardTimeoutFor(policyDecision)),
    );
    let timedOut = false;
    let canceled = false;
    let result: ProcessResult = {};
    let termination: Promise<void> | undefined;

    const subprocess = execa(prepared.executablePath, prepared.args, {
      cwd: prepared.cwdAbsolute,
      env: prepared.environment,
      extendEnv: false,
      shell: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      buffer: false,
      reject: false,
      cleanup: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stripFinalNewline: false,
    });

    subprocess.stdout?.on("data", (chunk: Buffer | string) => stdout.push(chunk));
    subprocess.stderr?.on("data", (chunk: Buffer | string) => stderr.push(chunk));

    const requestTermination = (): void => {
      termination ??= terminateProcessTree(subprocess);
    };
    const onAbort = (): void => {
      canceled = true;
      requestTermination();
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);
    timer.unref();

    try {
      result = (await subprocess) as ProcessResult;
    } catch (error) {
      result = error as ProcessResult;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
    }
    await termination;

    try {
      await prepared.cleanup();
    } catch (error) {
      stderr.push(
        `EASY CODE sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }

    const stdoutDigest = stdout.finish();
    const extractedStderr = extractSandboxControls(commandId, stderr.finish());
    const stderrDigest = extractedStderr.digest;
    const sandboxError = extractedStderr.controls.find((control) =>
      control.type === "sandbox_error"
    );
    const targetSpawnError = extractedStderr.controls.find((control) =>
      control.type === "target_spawn_error"
    );
    const sandboxReady = !prepared.metadata.enforced ||
      extractedStderr.controls.some((control) => control.type === "ready");
    const sandboxUnavailableMessage = sandboxError?.type === "sandbox_error"
      ? sandboxError.message
      : !sandboxReady
        ? "Sandbox worker exited without confirming that enforcement was active"
        : undefined;
    const after = await this.workspace.captureSnapshot();
    const delta = this.workspace.applyCommandSnapshots(before, after);

    const status: RunCommandOutput["status"] = canceled
      ? "canceled"
      : timedOut || result.timedOut
        ? "timed_out"
        : sandboxUnavailableMessage
          ? "sandbox_unavailable"
          : targetSpawnError
            ? "spawn_failed"
            : result.exitCode === undefined
              ? "spawn_failed"
              : "exited";
    const output: RunCommandOutput = {
      commandId,
      status,
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      signal: result.signal ?? null,
      durationMs: Date.now() - startedAt,
      stdout: stdoutDigest,
      stderr: stderrDigest,
      workspaceDelta: summarizeWorkspaceDelta(delta),
      policyDecision,
      sandbox: prepared.metadata,
      executed: this.executionSummary(resolved),
    };

    const summary = status === "exited"
      ? `Exited with code ${output.exitCode}`
      : status === "sandbox_unavailable" && sandboxUnavailableMessage
        ? `Sandbox unavailable: ${sandboxUnavailableMessage}`
        : status.replace(/_/gu, " ");
    this.audit(output, resolved, context, summary);
    return output;
  }

  private denied(
    commandId: string,
    startedAt: number,
    resolved: ResolvedCommand,
    policyDecision: CommandPolicyDecision,
    context: ToolContext,
  ): RunCommandOutput {
    const output: RunCommandOutput = {
      commandId,
      status: "policy_denied",
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      stdout: emptyDigest(),
      stderr: emptyDigest(),
      workspaceDelta: { created: [], updated: [], deleted: [], truncated: false },
      policyDecision,
      sandbox: this.executionBackend.describe({
        commandId,
        command: resolved,
        policyDecision,
        context,
        commandPreview: commandPreview(resolved),
      }),
      executed: this.executionSummary(resolved),
    };
    this.audit(output, resolved, context, policyDecision.reason);
    return output;
  }

  private canceledBeforeStart(
    commandId: string,
    startedAt: number,
    resolved: ResolvedCommand,
    policyDecision: CommandPolicyDecision,
    context: ToolContext,
    sandbox: SandboxExecutionMetadata,
  ): RunCommandOutput {
    const output: RunCommandOutput = {
      commandId,
      status: "canceled",
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      stdout: emptyDigest(),
      stderr: emptyDigest(),
      workspaceDelta: { created: [], updated: [], deleted: [], truncated: false },
      policyDecision,
      sandbox,
      executed: this.executionSummary(resolved),
    };
    this.audit(output, resolved, context, "Canceled before process start");
    return output;
  }

  private resolutionFailure(
    commandId: string,
    startedAt: number,
    input: RunCommandInput,
    error: unknown,
    context: ToolContext,
  ): RunCommandOutput {
    const message = sanitizeCommandOutput(error instanceof Error ? error.message : String(error));
    const notFound = /Executable not found/iu.test(message);
    const policyDecision: CommandPolicyDecision = {
      id: createId("policy"),
      effect: "deny",
      capability: "destructive",
      risk: "destructive",
      reason: `Command resolution failed: ${message}`,
      matchedRule: notFound ? "resolver.not_found" : "resolver.boundary_or_schema",
    };
    const status: RunCommandOutput["status"] = notFound ? "spawn_failed" : "policy_denied";
    const redactedArgs = redactArguments(input.args ?? []);
    const output: RunCommandOutput = {
      commandId,
      status,
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      stdout: emptyDigest(),
      stderr: emptyDigest(),
      workspaceDelta: { created: [], updated: [], deleted: [], truncated: false },
      policyDecision,
      sandbox: this.executionBackend.describe(),
      executed: {
        program: sanitizeCommandOutput(input.program),
        args: redactedArgs,
        cwd: input.cwd ?? ".",
        environmentKeys: [],
      },
    };
    try {
      context.recordCommand?.({
        id: commandId,
        program: sanitizeCommandOutput(input.program),
        args: redactedArgs,
        cwd: input.cwd ?? ".",
        status,
        exitCode: null,
        durationMs: output.durationMs,
        timestamp: new Date().toISOString(),
        summary: policyDecision.reason,
      });
    } catch {
      // See audit(): projection failures do not change the policy result.
    }
    return output;
  }

  private sandboxFailure(
    commandId: string,
    startedAt: number,
    resolved: ResolvedCommand,
    policyDecision: CommandPolicyDecision,
    context: ToolContext,
    error: unknown,
    request: SandboxExecutionRequest,
  ): RunCommandOutput {
    const message = sanitizeCommandOutput(error instanceof Error ? error.message : String(error));
    const text = `EASY CODE sandbox unavailable: ${message}`;
    const stderr: OutputDigest = {
      head: text,
      tail: "",
      text,
      totalBytes: Buffer.byteLength(text),
      truncated: false,
    };
    const output: RunCommandOutput = {
      commandId,
      status: "sandbox_unavailable",
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      stdout: emptyDigest(),
      stderr,
      workspaceDelta: { created: [], updated: [], deleted: [], truncated: false },
      policyDecision,
      sandbox: this.executionBackend.describe(request),
      executed: this.executionSummary(resolved),
    };
    this.audit(output, resolved, context, text);
    return output;
  }

  private executionSummary(command: ResolvedCommand): RunCommandOutput["executed"] {
    return {
      program: command.executablePath,
      args: redactArguments(command.args),
      cwd: command.cwdRelative,
      environmentKeys: command.environmentKeys,
    };
  }

  private audit(
    output: RunCommandOutput,
    command: ResolvedCommand,
    context: ToolContext,
    summary: string,
  ): void {
    try {
      context.recordCommand?.({
        id: output.commandId,
        program: command.executablePath,
        args: redactArguments(command.args),
        cwd: command.cwdRelative,
        status: output.status,
        exitCode: output.exitCode,
        durationMs: output.durationMs,
        timestamp: new Date().toISOString(),
        summary: sanitizeCommandOutput(summary),
      });
    } catch {
      // Audit projection failures must be handled by the owning event journal;
      // they should not reinterpret a command that already ran.
    }
  }
}
