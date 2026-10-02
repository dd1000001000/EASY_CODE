import { execa } from "execa";
import path from "node:path";
import type { HostPlatform } from "../core/host-platform.js";
import type { ToolContext } from "../core/types.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import { SandboxControlStream, extractSandboxControls } from "../sandbox/control.js";
import { SandboxFailure } from "../sandbox/failure.js";
import type { CommandExecutionBackend, PreparedCommand, SandboxWorkerControl } from "../sandbox/types.js";
import { sha256 } from "../utils/hash.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { ExecutionJournal } from "./execution-journal.js";
import type { TerminationResult } from "./lifecycle.js";
import type { CommandNetworkGate } from "./network-gate.js";
import type { CommandOutputArchive } from "./output-archive.js";
import { OutputCollector } from "./output-stream.js";
import { createCommandWorker } from "./platform/index.js";
import type { CommandWorkerPlatform } from "./platform/worker-types.js";
import type { CommandRuntimeOptions } from "./runtime.js";
import type { CommandTimeoutBudget } from "./timeout.js";
import type {
  CommandPolicyDecision,
  OutputDigest,
  ResolvedCommand,
  RunCommandOutput,
  RunningCommandOutput,
} from "./types.js";
import { CommandVerificationCollector, packageScriptRunner, workspacePackageManifest } from "./verification.js";

export interface ProcessResult {
  exitCode?: number;
  signal?: string;
  failed?: boolean;
  timedOut?: boolean;
  isCanceled?: boolean;
  killed?: boolean;
  code?: string;
}

/** What a command process run needs from the CommandRuntime that owns it. */
export interface CommandProcessHost {
  readonly hostPlatform: HostPlatform;
  readonly limits: Readonly<RuntimeLimits>;
  readonly workspace: WorkspaceManager;
  readonly executionJournal: ExecutionJournal;
  readonly options: Pick<CommandRuntimeOptions, "sandboxStartupTimeoutMs" | "createOutputArchive" | "recordLifecycle">;
  quarantine(reason: string, backend: CommandExecutionBackend, code?: string): void;
  executionSummary(command: ResolvedCommand): RunCommandOutput["executed"];
}

/** The authorized, prepared command a process run executes. */
export interface CommandProcessRequest {
  readonly commandId: string;
  readonly startedAt: number;
  readonly context: ToolContext;
  readonly onStarted: ((snapshot: () => RunningCommandOutput) => void) | undefined;
  readonly prepared: PreparedCommand;
  readonly resolved: ResolvedCommand;
  readonly executionBackend: CommandExecutionBackend;
  readonly policyDecision: CommandPolicyDecision;
  readonly timeout: CommandTimeoutBudget;
  readonly unrestricted: boolean;
  readonly networkApprovalController: AbortController;
  readonly networkGate: CommandNetworkGate | undefined;
}

type BoundaryViolation = Extract<SandboxWorkerControl, { type: "sandbox_boundary_violation" }>;
type TargetSpawnError = Extract<SandboxWorkerControl, { type: "target_spawn_error" }>;
type TargetOutcome = Extract<SandboxWorkerControl, { type: "execution_exited" }>["outcome"];

/** The finished streams and what the control protocol proved about the target. */
export interface CommandProcessReport {
  readonly stdout: OutputDigest;
  readonly stderr: OutputDigest;
  readonly boundaryViolation: BoundaryViolation | undefined;
  readonly targetSpawnError: TargetSpawnError | undefined;
  readonly provenSpawnNotStarted: boolean;
  readonly provenNotStarted: boolean;
  readonly retryableInitialization: boolean;
  readonly sandboxUnavailableMessage: string | undefined;
}

function containsReadyControl(commandId: string, value: string): boolean {
  if (!value.includes("[[EASY_CODE_SANDBOX:")) return false;
  const digest: OutputDigest = {
    head: value,
    tail: "",
    text: value,
    totalBytes: Buffer.byteLength(value),
    truncated: false,
  };
  return extractSandboxControls(commandId, digest).controls.some((control) => control.type === "ready");
}

function spawnWorker(worker: CommandWorkerPlatform, prepared: PreparedCommand) {
  return execa(prepared.executablePath, prepared.args, {
    cwd: prepared.cwdAbsolute,
    env: worker.launchEnvironment(prepared),
    extendEnv: false,
    shell: false,
    stdio: prepared.controlPipe ? [worker.stdinMode(prepared), "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    buffer: false,
    reject: false,
    cleanup: true,
    detached: worker.detached,
    windowsHide: true,
    stripFinalNewline: false,
  });
}

type WorkerSubprocess = ReturnType<typeof spawnWorker>;

interface LaunchedWorker {
  readonly maxOutputChars: number;
  readonly archive: CommandOutputArchive | undefined;
  readonly stdout: OutputCollector;
  readonly stderr: OutputCollector;
  readonly verification: CommandVerificationCollector;
  readonly workerStartedAt: number;
  readonly worker: CommandWorkerPlatform;
  readonly sandboxStartupTimeoutMs: number;
  readonly subprocess: WorkerSubprocess;
}

/**
 * One prepared command's process: the worker subprocess, its sandbox control protocol, the initialization, command
 * and cleanup deadlines, cooperative or forced termination, and backend cleanup. The public fields record what the
 * run observed; CommandRuntime turns them into the command's result.
 */
export class CommandProcessRun {
  readonly maxOutputChars: number;
  readonly verification: CommandVerificationCollector;
  readonly workerStartedAt: number;
  readonly sandboxStartupTimeoutMs: number;
  readonly timeoutMs: number;
  timeoutPhase: "initialization" | "command" | "cleanup" | undefined;
  requestSentAt: number | undefined;
  executionEndedAt: number | undefined;
  canceled = false;
  result: ProcessResult = {};
  readyObserved: boolean;
  requestSent: boolean;
  targetStarted: boolean;
  targetExitCode: number | undefined;
  targetOutcome: TargetOutcome;
  cleanupConfirmed: boolean;
  cleanupError: string | undefined;
  protocolError: string | undefined;
  pendingCleanupFiles: string[] | undefined;
  private readonly lifecycleEvents: SandboxWorkerControl[] = [];
  private readonly archive: CommandOutputArchive | undefined;
  private readonly stdout: OutputCollector;
  private readonly stderr: OutputCollector;
  private readonly worker: CommandWorkerPlatform;
  private readonly subprocess: WorkerSubprocess;
  private termination: Promise<TerminationResult> | undefined;
  private cooperativeStop: Promise<void> | undefined;
  private cleanupDeadline: NodeJS.Timeout | undefined;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private readyProbe = "";
  private startedAnnounced = false;

  /** Set up output capture and verification, then spawn the worker; its streams are observed from the first chunk. */
  static async launch(host: CommandProcessHost, request: CommandProcessRequest): Promise<CommandProcessRun> {
    const { commandId, context, executionBackend, prepared, resolved } = request;
    const maxOutputChars = Math.max(256, Math.min(context.maxOutputChars, 1_000_000));
    const archive = host.options.createOutputArchive?.(commandId, context);
    const stdout = new OutputCollector(maxOutputChars, (text) => archive?.push("stdout", text));
    const stderr = new OutputCollector(maxOutputChars, (text) => archive?.push("stderr", text));
    const verification = new CommandVerificationCollector(
      {
        program: resolved.executablePath,
        args: resolved.args,
        cwd: resolved.cwdAbsolute,
        environmentDigest: sha256(
          JSON.stringify(Object.entries(resolved.environment).sort(([a], [b]) => a.localeCompare(b))),
        ),
      },
      await packageScriptRunner({ program: resolved.executablePath, args: resolved.args }, resolved.cwdAbsolute, () =>
        workspacePackageManifest(
          host.workspace,
          executionBackend.workspaceRelativeCwd
            ? executionBackend.workspaceRelativeCwd(resolved)
            : path.relative(host.workspace.root, resolved.cwdAbsolute),
        ),
      ),
    );
    const workerStartedAt = Date.now();
    const worker = createCommandWorker(host.hostPlatform);
    const sandboxStartupTimeoutMs = Math.max(
      1,
      host.options.sandboxStartupTimeoutMs ?? worker.startupTimeoutMs(host.limits),
    );
    const subprocess = spawnWorker(worker, prepared);
    return new CommandProcessRun(host, request, {
      maxOutputChars,
      archive,
      stdout,
      stderr,
      verification,
      workerStartedAt,
      worker,
      sandboxStartupTimeoutMs,
      subprocess,
    });
  }

  private constructor(
    private readonly host: CommandProcessHost,
    private readonly request: CommandProcessRequest,
    launched: LaunchedWorker,
  ) {
    this.maxOutputChars = launched.maxOutputChars;
    this.archive = launched.archive;
    this.stdout = launched.stdout;
    this.stderr = launched.stderr;
    this.verification = launched.verification;
    this.workerStartedAt = launched.workerStartedAt;
    this.worker = launched.worker;
    this.sandboxStartupTimeoutMs = launched.sandboxStartupTimeoutMs;
    this.subprocess = launched.subprocess;
    this.timeoutMs = request.timeout.effectiveMs;
    const { prepared } = request;
    const unenforced = !prepared.metadata.enforced && !prepared.controlPipe;
    this.readyObserved = unenforced;
    this.requestSent = unenforced;
    this.targetStarted = unenforced;
    this.cleanupConfirmed = unenforced;
    this.observeStreams();
  }

  /** Supervise the worker until it exits, confirm its termination and settle backend cleanup. */
  async complete(): Promise<void> {
    await this.supervise();
    await this.cooperativeStop;
    const { executionBackend, networkGate, prepared } = this.request;
    const terminationResult = await (this.worker.stopAttached() ?? this.termination);
    await networkGate?.close();
    if (terminationResult && !terminationResult.confirmed && !prepared.externalLifecycle) {
      this.cleanupError = "Process tree termination could not be confirmed";
      this.host.quarantine(this.cleanupError, executionBackend);
    }
    await this.cleanUp(terminationResult);
  }

  /** Finish the output streams and read what the control protocol proved about the target. */
  report(): CommandProcessReport {
    const { commandId, prepared } = this.request;
    const archive = this.archive;
    const stdoutDigest = this.stdout.finish();
    const rawStderr = this.stderr.finish();
    archive?.finish();
    if (archive) {
      stdoutDigest.archive = archive.reference("stdout");
      rawStderr.archive = archive.reference("stderr");
    }
    const extractedStderr = prepared.metadata.enforced
      ? extractSandboxControls(commandId, rawStderr)
      : { digest: rawStderr, controls: [] };
    const stderrDigest = extractedStderr.digest;
    if (archive) stderrDigest.archive = archive.reference("stderr");
    const controls = prepared.controlPipe
      ? this.lifecycleEvents
      : [...this.lifecycleEvents, ...extractedStderr.controls];
    const sandboxError = controls.find((control) => control.type === "sandbox_error");
    const targetSpawnError = controls.find((control) => control.type === "target_spawn_error");
    const boundaryViolation = controls.find((control) => control.type === "sandbox_boundary_violation");
    const lastSandboxStage = [...controls].reverse().find((control) => control.type === "stage");
    const sandboxReady = this.readyObserved;
    const provenSpawnNotStarted =
      targetSpawnError?.type === "target_spawn_error" && !this.targetStarted && this.cleanupConfirmed;
    const provenNotStarted =
      provenSpawnNotStarted ||
      (!this.requestSent &&
        !this.protocolError &&
        this.cleanupConfirmed &&
        (!prepared.externalLifecycle || sandboxError?.type === "sandbox_error"));
    const retryableInitialization = provenNotStarted && this.timeoutPhase === "initialization";
    const sandboxUnavailableMessage =
      this.protocolError ??
      (sandboxError?.type === "sandbox_error"
        ? sandboxError.message
        : !sandboxReady
          ? this.timeoutPhase === "initialization" || this.result.timedOut
            ? `OS sandbox initialization did not become ready within ${this.sandboxStartupTimeoutMs}ms; ` +
              "the target process was not confirmed started" +
              (lastSandboxStage?.type === "stage"
                ? ` (last worker stage: ${lastSandboxStage.stage})`
                : " (the worker reported no startup stage)")
            : "Sandbox worker exited without confirming that enforcement was active"
          : undefined);
    const reportedStderr = sandboxUnavailableMessage
      ? (() => {
          const collector = new OutputCollector(this.maxOutputChars);
          if (stderrDigest.text) collector.push(stderrDigest.text);
          collector.push(
            `${stderrDigest.text ? "\n" : ""}EASY CODE sandbox unavailable: ` + `${sandboxUnavailableMessage}\n`,
          );
          return collector.finish();
        })()
      : stderrDigest;
    if (archive) reportedStderr.archive = archive.reference("stderr");
    return {
      stdout: stdoutDigest,
      stderr: reportedStderr,
      boundaryViolation: boundaryViolation?.type === "sandbox_boundary_violation" ? boundaryViolation : undefined,
      targetSpawnError: targetSpawnError?.type === "target_spawn_error" ? targetSpawnError : undefined,
      provenSpawnNotStarted,
      provenNotStarted,
      retryableInitialization,
      sandboxUnavailableMessage,
    };
  }

  /** The command's terminal status. */
  status(report: CommandProcessReport): RunCommandOutput["status"] {
    const { targetOutcome, targetExitCode, result, timeoutPhase } = this;
    return this.canceled || targetOutcome === "canceled"
      ? "canceled"
      : report.sandboxUnavailableMessage
        ? "sandbox_unavailable"
        : timeoutPhase === "command" || result.timedOut || targetOutcome === "timed_out"
          ? "timed_out"
          : report.targetSpawnError || targetOutcome === "spawn_failed" || targetOutcome === "unknown"
            ? "spawn_failed"
            : (targetExitCode ?? result.exitCode) === undefined
              ? "spawn_failed"
              : "exited";
  }

  /** Phase timings, the proven execution state and the cleanup state for the command's result. */
  lifecycle(report: CommandProcessReport, preparingAt: number): NonNullable<RunCommandOutput["lifecycle"]> {
    const { prepared } = this.request;
    const { cleanupError, pendingCleanupFiles, requestSentAt, result, targetExitCode, targetOutcome, timeoutPhase } =
      this;
    const executionEndedAt = this.executionEndedAt!;
    const { provenNotStarted } = report;
    return {
      timings: {
        preparationMs: this.workerStartedAt - preparingAt,
        initializationMs: (requestSentAt ?? executionEndedAt) - this.workerStartedAt,
        executionMs: requestSentAt === undefined ? 0 : executionEndedAt - requestSentAt,
        cleanupMs: Date.now() - executionEndedAt,
      },
      ...(timeoutPhase ? { timeoutPhase } : {}),
      ...(targetOutcome ? { outcome: targetOutcome } : {}),
      execution: provenNotStarted
        ? "not_started"
        : targetOutcome === "unknown" || targetOutcome === "spawn_failed"
          ? "unknown"
          : targetExitCode !== undefined ||
              (!prepared.controlPipe && !prepared.metadata.enforced && typeof result.exitCode === "number")
            ? "exited"
            : "unknown",
      cleanup: cleanupError
        ? "failed"
        : !prepared.metadata.enforced && !prepared.controlPipe
          ? "not_required"
          : this.cleanupConfirmed
            ? "confirmed"
            : "unconfirmed",
      ...(cleanupError ? { cleanupError } : {}),
      ...(pendingCleanupFiles?.length ? { pendingCleanupFiles } : {}),
    };
  }

  private observeStreams(): void {
    const { commandId, prepared } = this.request;
    const controlStream = new SandboxControlStream(
      commandId,
      (control) => this.onControl(control),
      prepared.controlPipe === true,
    );
    if (prepared.controlPipe)
      this.subprocess.stdio[3]?.on("data", (chunk: Buffer) => {
        try {
          controlStream.push(chunk);
        } catch (error) {
          this.protocolError = error instanceof Error ? error.message : String(error);
          this.requestTermination();
        }
      });
    this.subprocess.stdout?.on("data", (chunk: Buffer | string) => {
      this.verification.push("stdout", chunk);
      this.stdout.push(chunk);
    });
    this.subprocess.stderr?.on("data", (chunk: Buffer | string) => {
      this.verification.push("stderr", chunk);
      this.stderr.push(chunk);
      if (!prepared.controlPipe) this.observeReady(chunk);
    });
  }

  private onControl(control: SandboxWorkerControl): void {
    const { commandId, context, prepared } = this.request;
    this.lifecycleEvents.push(control);
    this.host.executionJournal.record(commandId, control.type, control);
    this.host.options.recordLifecycle?.(context, commandId, `command.${control.type}`, control);
    if (control.type === "ready") {
      this.readyObserved = true;
      if (!prepared.controlPipe) this.armTimeout("command", this.timeoutMs);
    }
    if (control.type === "execution_request_sent") {
      this.requestSent = true;
      this.requestSentAt = Date.now();
      this.armTimeout("command", this.timeoutMs);
      this.announceStarted();
    }
    if (control.type === "target_started") {
      this.targetStarted = true;
    }
    if (control.type === "execution_exited") {
      this.targetExitCode = control.exitCode;
      this.targetOutcome = control.outcome;
      this.executionEndedAt = Date.now();
      if (!["spawn_failed", "unknown"].includes(control.outcome ?? "exited")) this.targetStarted = true;
      // Cleanup latency must not turn a completed target into a test timeout.
      this.armTimeout("cleanup", this.host.limits.sandboxCleanupTimeoutMs);
    }
    if (control.type === "cleanup_complete") this.cleanupConfirmed = true;
    if (control.type === "cleanup_error") this.cleanupError = control.message;
    if (control.type === "cleanup_requested") {
      if (!this.worker.hasSupervisor()) throw new Error("Missing Windows job supervisor at cleanup");
      void this.worker.cleanupRequested(this.subprocess).catch((error) => {
        this.cleanupError = String(error);
        this.requestTermination();
      });
    }
  }

  private observeReady(chunk: Buffer | string): void {
    if (this.readyObserved) return;
    this.readyProbe = `${this.readyProbe}${chunk.toString()}`;
    if (!containsReadyControl(this.request.commandId, this.readyProbe)) {
      this.readyProbe = this.readyProbe.slice(-16_384);
      return;
    }
    this.readyObserved = true;
    this.armTimeout("command", this.timeoutMs);
    this.announceStarted();
  }

  private runningSnapshot(): RunningCommandOutput {
    const { commandId, policyDecision, prepared, resolved, startedAt, timeout } = this.request;
    const stdoutDigest = this.stdout.snapshot();
    const rawStderr = this.stderr.snapshot();
    const stderrDigest = prepared.metadata.enforced ? extractSandboxControls(commandId, rawStderr).digest : rawStderr;
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
      ...(resolved.notices?.length ? { notices: resolved.notices } : {}),
      executed: this.host.executionSummary(resolved),
    };
  }

  private announceStarted(): void {
    if (this.startedAnnounced) return;
    this.startedAnnounced = true;
    this.request.onStarted?.(() => this.runningSnapshot());
  }

  private armTimeout(phase: "initialization" | "command" | "cleanup", durationMs: number): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      this.timeoutPhase = phase;
      if (phase === "cleanup")
        this.cleanupError = "Sandbox cleanup deadline exceeded after target exit; command is not a test timeout";
      this.requestTermination();
    }, durationMs);
    this.timeoutTimer.unref();
  }

  private forceTermination(): void {
    this.termination ??= this.worker.forceStop(this.subprocess);
  }

  /** Begin a cooperative stop and arm the cleanup deadline for a forced one. */
  private beginCooperativeStop(stop: () => Promise<void>): void {
    if (this.cooperativeStop) return;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.cleanupDeadline = setTimeout(() => this.forceTermination(), this.host.limits.sandboxCleanupTimeoutMs);
    this.cooperativeStop = stop();
  }

  private requestTermination(): void {
    const { networkApprovalController, networkGate, prepared } = this.request;
    networkApprovalController.abort();
    void networkGate?.close();
    // Let the owning supervisor stop its workload before finalizing cleanup.
    // Killing only the local client cannot prove container termination.
    if (prepared.externalLifecycle && prepared.cancel) {
      const cancel = prepared.cancel;
      this.beginCooperativeStop(() =>
        cancel
          .call(prepared)
          .catch((error) => {
            this.cleanupError = `Container cancellation failed: ${String(error)}`;
          })
          .finally(() => this.forceTermination()),
      );
    } else if (prepared.sandboxManagedTimeout && !this.canceled && this.timeoutPhase === "command") {
      this.beginCooperativeStop(() => Promise.resolve());
    } else if (prepared.cooperativeTermination && !this.protocolError) {
      if (!this.cooperativeStop) {
        this.beginCooperativeStop(() => Promise.resolve());
        if (!this.worker.cooperativeStop(this.subprocess) && this.subprocess.pid) this.forceTermination();
      }
    } else if (this.worker.hasSupervisor() && this.requestSent && !this.protocolError && !this.cleanupError) {
      this.beginCooperativeStop(() =>
        this.worker.quiesce().catch((error) => {
          this.cleanupError = `Descendant cancellation failed: ${String(error)}`;
          this.forceTermination();
        }),
      );
    } else this.forceTermination();
  }

  /** Arm the first deadline, follow cancellation and host-access revocation, and wait for the worker to exit. */
  private async supervise(): Promise<void> {
    const { context, prepared, unrestricted } = this.request;
    const onAbort = (): void => {
      this.canceled = true;
      this.requestTermination();
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    const revocationTimer =
      unrestricted && context.isUnrestrictedHostAccessActive
        ? setInterval(() => {
            if (context.isUnrestrictedHostAccessActive?.()) return;
            this.canceled = true;
            this.requestTermination();
          }, 250)
        : undefined;
    revocationTimer?.unref();
    this.armTimeout(
      prepared.metadata.enforced || prepared.controlPipe ? "initialization" : "command",
      prepared.metadata.enforced || prepared.controlPipe ? this.sandboxStartupTimeoutMs : this.timeoutMs,
    );
    if (!prepared.metadata.enforced && !prepared.controlPipe) {
      this.requestSentAt = Date.now();
      this.announceStarted();
    }

    if (this.worker.needsAttachment(prepared)) {
      try {
        await this.worker.attach(this.subprocess);
        if (context.signal?.aborted) this.requestTermination();
        else this.worker.continueWorker(this.subprocess);
      } catch (error) {
        this.protocolError = error instanceof Error ? error.message : String(error);
        this.requestTermination();
      }
    } else if (context.signal?.aborted) {
      // An abort during launch preparation fired before the listener existed.
      onAbort();
    }

    try {
      this.result = (await this.subprocess) as ProcessResult;
    } catch (error) {
      this.result = error as ProcessResult;
    } finally {
      this.executionEndedAt ??= Date.now();
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      if (this.cleanupDeadline) clearTimeout(this.cleanupDeadline);
      if (revocationTimer) clearInterval(revocationTimer);
      context.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Run the backend cleanup that the observed lifecycle allows, or quarantine when cleanup cannot be proven. */
  private async cleanUp(terminationResult: TerminationResult | undefined): Promise<void> {
    const { executionBackend, prepared } = this.request;
    const targetSpawnReported = this.lifecycleEvents.some((control) => control.type === "target_spawn_error");
    const targetOutcome = this.targetOutcome;
    try {
      if (prepared.externalLifecycle) {
        const cleanup = await prepared.cleanup();
        this.pendingCleanupFiles = cleanup?.pendingFiles;
        if (this.pendingCleanupFiles?.length)
          this.stderr.push(
            `EASY CODE: process cleanup confirmed; ${this.pendingCleanupFiles.length} temporary item(s) await garbage collection.\n`,
          );
        // Only backend engine inspection, never a killed local client, may
        // recover cleanup certainty. Execution remains unknown/non-retryable.
        this.cleanupConfirmed = true;
        this.cleanupError = undefined;
        if (this.requestSent && this.targetExitCode === undefined) this.targetOutcome = "unknown";
      } else if (
        prepared.cleanupAfterWorkerExit &&
        (targetOutcome === "exited" ||
          targetOutcome === "timed_out" ||
          targetOutcome === "canceled" ||
          (targetOutcome === "spawn_failed" && targetSpawnReported && !this.targetStarted))
      ) {
        await prepared.cleanup();
        this.cleanupConfirmed = true;
        this.cleanupError = undefined;
      } else if (prepared.cleanupAfterWorkerExit && !this.requestSent && !this.protocolError) {
        // Initialization ended before the target request. The backend owns the
        // scratch directory, so no target-process cleanup is required.
        await prepared.cleanup();
        this.cleanupConfirmed = true;
        this.cleanupError = undefined;
      } else if (
        prepared.cleanupAfterTermination &&
        terminationResult?.confirmed &&
        (this.cleanupError !== undefined || !this.cleanupConfirmed)
      ) {
        // The supervisor has independently proved that the process tree is
        // empty. A killed worker cannot finish its own cleanup protocol, so
        // let the backend re-enter the sandbox identity and verify cleanup.
        await prepared.cleanup();
        this.cleanupConfirmed = true;
        this.cleanupError = undefined;
      } else if (!this.cleanupError && (!prepared.controlPipe || this.cleanupConfirmed)) await prepared.cleanup();
      else this.host.quarantine(this.cleanupError ?? "Sandbox cleanup was not confirmed", executionBackend);
    } catch (error) {
      this.cleanupError = error instanceof Error ? error.message : String(error);
      this.host.quarantine(
        this.cleanupError,
        executionBackend,
        error instanceof SandboxFailure ? error.code : "cleanup_unknown",
      );
      this.stderr.push(`EASY CODE sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

/** Classify why a command did not complete normally (sandbox startup, spawn, timeout, protocol or target failure) for the structured result. */
export function classifyCommandFailure(
  run: CommandProcessRun,
  report: CommandProcessReport,
  status: RunCommandOutput["status"],
  timeout: CommandTimeoutBudget,
): RunCommandOutput["failure"] {
  const { readyObserved, requestSent, result, targetExitCode, targetOutcome, targetStarted, timeoutMs } = run;
  const {
    boundaryViolation,
    provenNotStarted,
    provenSpawnNotStarted,
    retryableInitialization,
    sandboxUnavailableMessage,
    targetSpawnError,
  } = report;
  return boundaryViolation?.type === "sandbox_boundary_violation"
    ? {
        kind: "sandbox",
        code: "sandbox_boundary_violation",
        message: boundaryViolation.message,
        processStarted: true,
        executionState: "exited",
        retryable: false,
      }
    : targetOutcome === "output_limit"
      ? {
          kind: "runtime",
          code: "command_output_limit",
          message:
            "Command exceeded the sandbox bridge output limit. Execution is incomplete; narrow output before a new call. No automatic replay.",
          processStarted: true,
          retryable: false,
        }
      : status === "exited" && result.exitCode !== 0
        ? {
            kind: "exit",
            code: "nonzero_exit",
            message: `Process exited with code ${String(result.exitCode)}`,
            processStarted: true,
            retryable: false,
          }
        : status === "timed_out"
          ? {
              kind: "timeout",
              code: "command_timeout",
              message: `Process exceeded the effective ${timeout.kind === "background" ? "background lifetime" : "command timeout"} of ${timeoutMs}ms and was terminated`,
              processStarted: true,
              retryable: false,
            }
          : status === "canceled"
            ? {
                kind: "runtime",
                code: "command_canceled",
                message: "Process was canceled and terminated",
                processStarted: readyObserved,
                retryable: false,
              }
            : status === "spawn_failed"
              ? {
                  kind: "runtime",
                  code: provenNotStarted ? "command_spawn_not_started" : "target_spawn_failed",
                  message:
                    provenSpawnNotStarted && targetSpawnError?.type === "target_spawn_error"
                      ? targetSpawnError.message
                      : requestSent
                        ? "The target outcome is unknown; do not rerun automatically"
                        : "Runtime could not start the target process",
                  processStarted: targetStarted,
                  executionState: provenNotStarted ? "not_started" : "unknown",
                  retryable: false,
                }
              : sandboxUnavailableMessage
                ? {
                    kind: "sandbox",
                    code: "sandbox_unavailable",
                    message: sandboxUnavailableMessage,
                    processStarted: !provenNotStarted,
                    executionState:
                      targetExitCode !== undefined ? "exited" : provenNotStarted ? "not_started" : "unknown",
                    retryable: retryableInitialization,
                  }
                : undefined;
}
