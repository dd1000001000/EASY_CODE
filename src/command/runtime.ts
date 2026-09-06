import { execa } from "execa";
import type { ToolContext } from "../core/types.js";
import { createId } from "../utils/ids.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import {
  AnthropicSandboxBackend,
  extractSandboxControls,
  UnrestrictedHostBackend,
  type CommandExecutionBackend,
  type PreparedCommand,
  type SandboxExecutionMetadata,
  type SandboxExecutionRequest,
} from "../sandbox/index.js";
import { terminateProcessTree } from "./lifecycle.js";
import { OutputCollector, sanitizeCommandOutput } from "./output-stream.js";
import { CommandPolicy } from "./policy.js";
import {
  validateCommandRequest,
  type CommandRequestValidationFailure,
} from "./request-validation.js";
import { CommandResolver } from "./resolver.js";
import { resolveCommandTimeoutBudget } from "./timeout.js";
import {
  summarizeWorkspaceDelta,
  type CommandExecutionOutput,
  type CommandPolicyDecision,
  type OutputDigest,
  type ResolvedCommand,
  type RunCommandInput,
  type RunCommandOutput,
  type RunningCommandOutput,
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

export interface CommandRuntimeOptions {
  sandboxStartupTimeoutMs?: number;
}

interface BackgroundCommandOwner {
  readonly threadId: string;
  readonly agentRole: "main_agent" | "subagent";
  readonly agentId?: string;
  readonly assignedTaskId?: string;
}

export type CommandRuntimeOwner = Pick<
  ToolContext,
  "threadId" | "agentRole" | "agentId" | "assignedTaskId"
>;

interface BackgroundCommandJob {
  readonly owner: BackgroundCommandOwner;
  readonly controller: AbortController;
  readonly completion: Promise<RunCommandOutput>;
  readonly snapshot: () => RunningCommandOutput;
  readonly startedAt: number;
  final?: RunCommandOutput;
  failure?: Error;
  /** Set only after the owning agent receives a terminal status/cancel result. */
  terminalObserved: boolean;
}

interface CommandExecutionHooks {
  readonly onStarted?: (snapshot: () => RunningCommandOutput) => void;
}

const MAX_STATUS_WAIT_MS = 30_000;
const COMPLETED_JOB_RETENTION_MS = 60 * 60_000;
const MAX_RETAINED_JOBS = 64;

const WINDOWS_SANDBOX_STARTUP_TIMEOUT_MS = 75_000;
const POSIX_SANDBOX_STARTUP_TIMEOUT_MS = 30_000;

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

function defaultSandboxStartupTimeout(metadata: SandboxExecutionMetadata): number {
  return metadata.backend === "anthropic-srt-windows"
    ? WINDOWS_SANDBOX_STARTUP_TIMEOUT_MS
    : POSIX_SANDBOX_STARTUP_TIMEOUT_MS;
}

function retryableSandboxFailure(message: string): boolean {
  return /(?:srt-win\s+acl\s+(?:grant|stamp|restore|revoke).*timed\s+out|OS\s+sandbox\s+initialization\s+did\s+not\s+become\s+ready|Windows\s+SRT\s+ACL\s+lease|database\s+is\s+locked|resource\s+(?:is\s+)?busy)/iu.test(message);
}

function containsReadyControl(commandId: string, value: string): boolean {
  if (!value.includes("[[EASY_CODE_SRT:")) return false;
  const digest: OutputDigest = {
    head: value,
    tail: "",
    text: value,
    totalBytes: Buffer.byteLength(value),
    truncated: false,
  };
  return extractSandboxControls(commandId, digest).controls.some(
    (control) => control.type === "ready",
  );
}

export class CommandRuntime {
  readonly resolver: CommandResolver;
  readonly policy: CommandPolicy;
  private readonly executionBackend: CommandExecutionBackend;
  private readonly unrestrictedExecutionBackend: CommandExecutionBackend;
  private readonly backgroundJobs = new Map<string, BackgroundCommandJob>();

  constructor(
    private readonly workspace: WorkspaceManager,
    policy = new CommandPolicy(),
    executionBackend?: CommandExecutionBackend,
    unrestrictedExecutionBackend?: CommandExecutionBackend,
    private readonly options: CommandRuntimeOptions = {},
  ) {
    this.resolver = new CommandResolver(workspace);
    this.policy = policy;
    this.executionBackend = executionBackend ?? new AnthropicSandboxBackend(workspace);
    this.unrestrictedExecutionBackend = unrestrictedExecutionBackend ??
      new UnrestrictedHostBackend();
  }

  async run(input: RunCommandInput, context: ToolContext): Promise<RunCommandOutput> {
    return this.executeCommand(input, context);
  }

  /**
   * Start a command only after its normal policy, approval and sandbox-ready
   * boundary succeeds. The returned handle never grants authority beyond the
   * exact invocation that was already approved.
   */
  async start(
    input: RunCommandInput,
    context: ToolContext,
  ): Promise<CommandExecutionOutput> {
    this.pruneBackgroundJobs();
    const controller = new AbortController();
    const onSourceAbort = (): void => controller.abort();
    context.signal?.addEventListener("abort", onSourceAbort, { once: true });
    if (context.signal?.aborted) controller.abort();

    let initialSettled = false;
    let resolveInitial!: (output: CommandExecutionOutput) => void;
    let rejectInitial!: (error: Error) => void;
    const initial = new Promise<CommandExecutionOutput>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });
    const settleInitial = (output: CommandExecutionOutput): void => {
      if (initialSettled) return;
      initialSettled = true;
      resolveInitial(output);
    };
    const failInitial = (error: unknown): void => {
      if (initialSettled) return;
      initialSettled = true;
      rejectInitial(error instanceof Error ? error : new Error(String(error)));
    };

    let completion!: Promise<RunCommandOutput>;
    completion = this.executeCommand(
      input,
      { ...context, signal: controller.signal },
      {
        onStarted: (snapshot) => {
          const running = snapshot();
          const job: BackgroundCommandJob = {
            owner: this.ownerFor(context),
            controller,
            completion,
            snapshot,
            startedAt: Date.now(),
            terminalObserved: false,
          };
          this.backgroundJobs.set(running.commandId, job);
          settleInitial(running);
        },
      },
    );
    void completion.then(
      (output) => {
        const job = this.backgroundJobs.get(output.commandId);
        if (job) job.final = output;
        settleInitial(output);
      },
      (error: unknown) => {
        for (const job of this.backgroundJobs.values()) {
          if (job.completion !== completion) continue;
          job.failure = error instanceof Error ? error : new Error(String(error));
          break;
        }
        failInitial(error);
      },
    ).finally(() => {
      context.signal?.removeEventListener("abort", onSourceAbort);
    });
    return initial;
  }

  async status(
    commandId: string,
    context: ToolContext,
    waitMs = 0,
  ): Promise<CommandExecutionOutput> {
    const job = this.requireOwnedJob(commandId, context);
    if (!job.final && !job.failure && waitMs > 0) {
      await this.waitForStatus(job, Math.min(waitMs, MAX_STATUS_WAIT_MS), context.signal);
    }
    if (job.failure) {
      job.terminalObserved = true;
      throw job.failure;
    }
    const output = job.final ?? job.snapshot();
    if (output.status !== "running") job.terminalObserved = true;
    return output;
  }

  async cancel(commandId: string, context: ToolContext): Promise<RunCommandOutput> {
    const job = this.requireOwnedJob(commandId, context);
    if (!job.final && !job.failure) job.controller.abort();
    try {
      const output = job.final ?? await job.completion;
      job.final = output;
      job.terminalObserved = true;
      return output;
    } catch (error) {
      job.failure = error instanceof Error ? error : new Error(String(error));
      job.terminalObserved = true;
      throw job.failure;
    }
  }

  /** Internal lifecycle hook used by the workspace mutation-lock wrapper. */
  whenSettled(commandId: string): Promise<void> | undefined {
    const job = this.backgroundJobs.get(commandId);
    return job?.completion.then(() => undefined, () => undefined);
  }

  hasRunningCommands(owner?: CommandRuntimeOwner): boolean {
    const expectedOwner = owner ? this.ownerFor(owner) : undefined;
    return [...this.backgroundJobs.values()].some((job) =>
      !job.final &&
      !job.failure &&
      (!expectedOwner || this.ownersMatch(job.owner, expectedOwner))
    );
  }

  /**
   * True after action=start returned a handle and until its owner has received
   * a terminal status/cancel result. This deliberately remains true when the
   * OS process finishes between model steps, because its result is not yet in
   * the model context.
   */
  hasOpenCommandHandles(owner?: CommandRuntimeOwner): boolean {
    const expectedOwner = owner ? this.ownerFor(owner) : undefined;
    return [...this.backgroundJobs.values()].some((job) =>
      !job.terminalObserved &&
      (!expectedOwner || this.ownersMatch(job.owner, expectedOwner))
    );
  }

  async cancelAll(owner?: CommandRuntimeOwner): Promise<void> {
    const expectedOwner = owner ? this.ownerFor(owner) : undefined;
    const running = [...this.backgroundJobs.values()].filter(
      (job) =>
        !job.final &&
        !job.failure &&
        (!expectedOwner || this.ownersMatch(job.owner, expectedOwner)),
    );
    for (const job of running) job.controller.abort();
    await Promise.all(running.map((job) => job.completion.catch(() => undefined)));
  }

  private async executeCommand(
    input: RunCommandInput,
    context: ToolContext,
    hooks: CommandExecutionHooks = {},
  ): Promise<RunCommandOutput> {
    const commandId = createId("command");
    const startedAt = Date.now();
    const unrestricted = context.commandExecutionMode === "unrestricted" &&
      (context.isUnrestrictedHostAccessActive?.() ?? true);
    const executionBackend = unrestricted
      ? this.unrestrictedExecutionBackend
      : this.executionBackend;
    const validationFailure = validateCommandRequest(input);
    if (validationFailure) {
      return this.resolutionFailure(
        commandId,
        startedAt,
        input,
        validationFailure.reason,
        context,
        executionBackend,
        validationFailure,
      );
    }
    let resolved: ResolvedCommand;
    try {
      resolved = await this.resolver.resolve(input, {
        unrestrictedHostAccess: unrestricted,
      });
    } catch (error) {
      return this.resolutionFailure(
        commandId,
        startedAt,
        input,
        error,
        context,
        executionBackend,
      );
    }
    let policyDecision = this.policy.classify(input, resolved, context.mode);
    if (unrestricted) {
      policyDecision = {
        ...policyDecision,
        id: createId("policy"),
        effect: "allow",
        reason:
          "User explicitly enabled dangerous full-computer access for this EASY CODE process",
        matchedRule: "allow.unrestricted",
      };
    }
    const fingerprint = this.policy.approvalFingerprint(resolved, policyDecision);

    const shouldAsk = !unrestricted &&
      (policyDecision.effect === "ask" || context.approvalPolicy === "ask");
    if (policyDecision.effect === "deny") {
      return this.denied(commandId, startedAt, resolved, policyDecision, context, executionBackend);
    }
    if (shouldAsk) {
      if (context.approvalPolicy === "never") {
        policyDecision = {
          ...policyDecision,
          effect: "deny",
          reason: `${policyDecision.reason}; approval prompts are disabled`,
        };
        return this.denied(commandId, startedAt, resolved, policyDecision, context, executionBackend);
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
        return this.denied(commandId, startedAt, resolved, policyDecision, context, executionBackend);
      }
    }

    if (unrestricted && !(context.isUnrestrictedHostAccessActive?.() ?? true)) {
      policyDecision = {
        ...policyDecision,
        effect: "deny",
        reason: "Unrestricted host access was revoked before the command started",
        matchedRule: "deny.unrestricted_revoked",
      };
      return this.denied(commandId, startedAt, resolved, policyDecision, context, executionBackend);
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
        executionBackend.describe(sandboxRequest),
      );
    }

    const before = await this.workspace.captureSnapshot(context.signal);
    let prepared: PreparedCommand;
    try {
      prepared = await executionBackend.prepare(sandboxRequest);
    } catch (error) {
      if (context.signal?.aborted) {
        return this.canceledBeforeStart(
          commandId,
          startedAt,
          resolved,
          policyDecision,
          context,
          executionBackend.describe(sandboxRequest),
        );
      }
      return this.sandboxFailure(
        commandId,
        startedAt,
        resolved,
        policyDecision,
        context,
        error,
        sandboxRequest,
        executionBackend,
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
    const timeout = resolveCommandTimeoutBudget(
      input.timeoutMs,
      context.commandTimeoutMs,
      policyDecision.capability,
    );
    const timeoutMs = timeout.effectiveMs;
    let timeoutPhase: "initialization" | "command" | undefined;
    let canceled = false;
    let result: ProcessResult = {};
    let termination: Promise<void> | undefined;
    const sandboxStartupTimeoutMs = Math.max(
      1,
      this.options.sandboxStartupTimeoutMs ??
        defaultSandboxStartupTimeout(prepared.metadata),
    );

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

    const requestTermination = (): void => {
      termination ??= terminateProcessTree(subprocess);
    };
    let timeoutTimer: NodeJS.Timeout | undefined;
    const armTimeout = (
      phase: "initialization" | "command",
      durationMs: number,
    ): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        timeoutPhase = phase;
        requestTermination();
      }, durationMs);
      timeoutTimer.unref();
    };
    let readyProbe = "";
    let readyObserved = !prepared.metadata.enforced;
    let startedAnnounced = false;
    const runningSnapshot = (): RunningCommandOutput => {
      const stdoutDigest = stdout.snapshot();
      const rawStderr = stderr.snapshot();
      const stderrDigest = prepared.metadata.enforced
        ? extractSandboxControls(commandId, rawStderr).digest
        : rawStderr;
      return {
        commandId,
        status: "running",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdout: stdoutDigest,
        stderr: stderrDigest,
        workspaceDelta: { created: [], updated: [], deleted: [], truncated: false },
        policyDecision,
        sandbox: prepared.metadata,
        timeout,
        executed: this.executionSummary(resolved),
      };
    };
    const announceStarted = (): void => {
      if (startedAnnounced) return;
      startedAnnounced = true;
      hooks.onStarted?.(runningSnapshot);
    };
    const observeReady = (chunk: Buffer | string): void => {
      if (readyObserved) return;
      readyProbe = `${readyProbe}${chunk.toString()}`;
      if (!containsReadyControl(commandId, readyProbe)) {
        readyProbe = readyProbe.slice(-16_384);
        return;
      }
      readyObserved = true;
      armTimeout("command", timeoutMs);
      announceStarted();
    };
    subprocess.stdout?.on("data", (chunk: Buffer | string) => stdout.push(chunk));
    subprocess.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(chunk);
      observeReady(chunk);
    });

    const onAbort = (): void => {
      canceled = true;
      requestTermination();
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    const revocationTimer = unrestricted && context.isUnrestrictedHostAccessActive
      ? setInterval(() => {
        if (context.isUnrestrictedHostAccessActive?.()) return;
        canceled = true;
        requestTermination();
      }, 250)
      : undefined;
    revocationTimer?.unref();
    armTimeout(
      prepared.metadata.enforced ? "initialization" : "command",
      prepared.metadata.enforced ? sandboxStartupTimeoutMs : timeoutMs,
    );
    if (!prepared.metadata.enforced) announceStarted();

    try {
      result = (await subprocess) as ProcessResult;
    } catch (error) {
      result = error as ProcessResult;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (revocationTimer) clearInterval(revocationTimer);
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
    const rawStderr = stderr.finish();
    const extractedStderr = prepared.metadata.enforced
      ? extractSandboxControls(commandId, rawStderr)
      : { digest: rawStderr, controls: [] };
    const stderrDigest = extractedStderr.digest;
    const sandboxError = extractedStderr.controls.find((control) =>
      control.type === "sandbox_error"
    );
    const targetSpawnError = extractedStderr.controls.find((control) =>
      control.type === "target_spawn_error"
    );
    const lastSandboxStage = [...extractedStderr.controls].reverse().find((control) =>
      control.type === "stage"
    );
    const sandboxReady = !prepared.metadata.enforced ||
      extractedStderr.controls.some((control) => control.type === "ready");
    const sandboxUnavailableMessage = sandboxError?.type === "sandbox_error"
      ? sandboxError.message
      : !sandboxReady
        ? timeoutPhase === "initialization" || result.timedOut
          ? `OS sandbox initialization did not become ready within ${sandboxStartupTimeoutMs}ms; ` +
            "the target process was not confirmed started" +
            (lastSandboxStage?.type === "stage"
              ? ` (last worker stage: ${lastSandboxStage.stage})`
              : " (the worker reported no startup stage)")
          : "Sandbox worker exited without confirming that enforcement was active"
        : undefined;
    const reportedStderr = sandboxUnavailableMessage
      ? (() => {
          const collector = new OutputCollector(maxOutputChars);
          if (stderrDigest.text) collector.push(stderrDigest.text);
          collector.push(
            `${stderrDigest.text ? "\n" : ""}EASY CODE sandbox unavailable: ` +
            `${sandboxUnavailableMessage}\n`,
          );
          return collector.finish();
        })()
      : stderrDigest;
    // A normal turn cancellation aborts an in-progress verification scan. If
    // the cancellation is what stopped the command, still take the final
    // authoritative snapshot so command-side changes are never left unaudited.
    const after = await this.workspace.captureSnapshot(
      context.signal?.aborted ? undefined : context.signal,
    );
    const delta = this.workspace.applyCommandSnapshots(before, after);

    const status: RunCommandOutput["status"] = canceled
      ? "canceled"
      : sandboxUnavailableMessage
          ? "sandbox_unavailable"
          : timeoutPhase === "command" || result.timedOut
            ? "timed_out"
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
      stderr: reportedStderr,
      workspaceDelta: summarizeWorkspaceDelta(delta),
      policyDecision,
      sandbox: prepared.metadata,
      timeout,
      ...(sandboxUnavailableMessage
        ? {
            sandboxFailure: {
              phase: "initialization" as const,
              retryable: retryableSandboxFailure(sandboxUnavailableMessage),
            },
          }
        : {}),
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

  private ownerFor(context: CommandRuntimeOwner): BackgroundCommandOwner {
    return {
      threadId: context.threadId,
      agentRole: context.agentRole ?? "main_agent",
      ...(context.agentId ? { agentId: context.agentId } : {}),
      ...(context.assignedTaskId ? { assignedTaskId: context.assignedTaskId } : {}),
    };
  }

  private ownersMatch(
    actual: BackgroundCommandOwner,
    expected: BackgroundCommandOwner,
  ): boolean {
    return actual.threadId === expected.threadId &&
      actual.agentRole === expected.agentRole &&
      actual.agentId === expected.agentId &&
      actual.assignedTaskId === expected.assignedTaskId;
  }

  private waitForStatus(
    job: BackgroundCommandJob,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      const error = new Error("Background command status wait was canceled");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => {
        const error = new Error("Background command status wait was canceled");
        error.name = "AbortError";
        finish(error);
      };
      const timer = setTimeout(() => finish(), waitMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      // Completion failures are surfaced from job.failure below. This branch
      // only wakes the waiter and always removes its timer/listener.
      void job.completion.then(() => finish(), () => finish());
      if (signal?.aborted) onAbort();
    });
  }

  private requireOwnedJob(
    commandId: string,
    context: ToolContext,
  ): BackgroundCommandJob {
    const job = this.backgroundJobs.get(commandId);
    const owner = this.ownerFor(context);
    if (
      !job ||
      !this.ownersMatch(job.owner, owner)
    ) {
      // Do not reveal whether another Thread or child owns a live handle.
      throw new Error(`Unknown or inaccessible background command handle: ${commandId}`);
    }
    return job;
  }

  private pruneBackgroundJobs(): void {
    const cutoff = Date.now() - COMPLETED_JOB_RETENTION_MS;
    for (const [commandId, job] of this.backgroundJobs) {
      if (job.terminalObserved && (job.final || job.failure) && job.startedAt < cutoff) {
        this.backgroundJobs.delete(commandId);
      }
    }
    if (this.backgroundJobs.size <= MAX_RETAINED_JOBS) return;
    const completed = [...this.backgroundJobs.entries()]
      .filter(([, job]) => job.terminalObserved && Boolean(job.final || job.failure))
      .sort((left, right) => left[1].startedAt - right[1].startedAt);
    for (const [commandId] of completed) {
      if (this.backgroundJobs.size <= MAX_RETAINED_JOBS) break;
      this.backgroundJobs.delete(commandId);
    }
  }

  private denied(
    commandId: string,
    startedAt: number,
    resolved: ResolvedCommand,
    policyDecision: CommandPolicyDecision,
    context: ToolContext,
    executionBackend: CommandExecutionBackend = this.executionBackend,
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
      sandbox: executionBackend.describe({
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
    executionBackend: CommandExecutionBackend,
    validationFailure?: CommandRequestValidationFailure,
  ): RunCommandOutput {
    const message = sanitizeCommandOutput(error instanceof Error ? error.message : String(error));
    const notFound = !validationFailure && /Executable not found/iu.test(message);
    const policyDecision: CommandPolicyDecision = {
      id: createId("policy"),
      effect: "deny",
      capability: "destructive",
      risk: "destructive",
      reason: validationFailure?.reason ?? `Command resolution failed: ${message}`,
      matchedRule: validationFailure?.matchedRule ??
        (notFound ? "resolver.not_found" : "resolver.boundary_or_schema"),
      ...(validationFailure?.recommendation
        ? { recommendation: validationFailure.recommendation }
        : {}),
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
      sandbox: executionBackend.describe(),
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
    executionBackend: CommandExecutionBackend,
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
      sandbox: executionBackend.describe(request),
      sandboxFailure: {
        phase: "prepare",
        retryable: retryableSandboxFailure(message),
      },
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
