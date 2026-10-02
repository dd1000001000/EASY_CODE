import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hostPlatform, type HostPlatform } from "../core/host-platform.js";
import { ExecutionJournal } from "./execution-journal.js";
import type { CommandOutputArchive } from "./output-archive.js";
import type { ToolContext } from "../core/types.js";
import type { CommandJournalEventType } from "../threads/events.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hash.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type {
  CommandExecutionBackend,
  PreparedCommand,
  SandboxExecutionMetadata,
  SandboxExecutionRequest,
} from "../sandbox/types.js";
import { NativeSandboxBackend } from "../sandbox/native-backend.js";
import { SandboxFailure } from "../sandbox/failure.js";
import type { SandboxWorkerControl } from "../sandbox/types.js";
import { sanitizeCommandOutput } from "./output-stream.js";
import { CommandProcessRun, classifyCommandFailure, type CommandProcessHost } from "./process-run.js";
import { CommandPolicy } from "./policy.js";
import { commandRequestMetadata, normalizeCommandRequest } from "./normalize-request.js";
import { validationCheckKey } from "./verification.js";
import { targetedValidationChanges } from "./validation-changes.js";
import { inspectNetworkOperation } from "./network-policy.js";
import { createCommandNetworkGate, type CommandNetworkGate } from "./network-gate.js";
import { requestNetworkApproval } from "./network-approval.js";
import { commandGrantPrefix } from "./command-grant.js";
import { sharedSandboxBoundaryStore, type SandboxBoundaryStore } from "./sandbox-boundary.js";
import { UnrestrictedHostBackend } from "../sandbox/unrestricted-host-backend.js";
import { CommandPolicyBoundaryError, CommandResolver } from "./resolver.js";
import {
  resolveBackgroundCommandTimeoutBudget,
  resolveCommandTimeoutBudget,
  type CommandTimeoutBudget,
} from "./timeout.js";
import { CommandEnvironmentQuarantined } from "../sandbox/environment-fault.js";
import {
  assertExecutionCapabilities,
  SandboxCapabilityError,
  type ExecutionCapabilities,
  type ExecutionCapability,
} from "../sandbox/capabilities.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { windowsCreateProcessFailureCode } from "../sandbox/native-command-error.js";
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

export interface CommandRuntimeOptions {
  limits?: Readonly<RuntimeLimits>;
  /** Trusted host selection, never controlled by model arguments. */
  networkProfile?: "development" | "benchmark" | "review_offline";
  sandboxStartupTimeoutMs?: number;
  quarantinePath?: string;
  lifecycleDirectory?: string;
  /** Runtime-owned state; persists correction counts and exact one-shot grants across Resume. */
  boundaryStatePath?: string;
  createOutputArchive?: (commandId: string, context: ToolContext) => CommandOutputArchive;
  recordLifecycle?: (context: ToolContext, commandId: string, type: CommandJournalEventType, payload: unknown) => void;
}

interface BackgroundCommandOwner {
  readonly threadId: string;
  readonly agentRole: "main_agent" | "subagent";
  readonly agentId?: string;
  readonly assignedTaskId?: string;
}

export type CommandRuntimeOwner = Pick<ToolContext, "threadId" | "agentRole" | "agentId" | "assignedTaskId">;

interface BackgroundCommandJob {
  readonly owner: BackgroundCommandOwner;
  readonly controller: AbortController;
  readonly completion: Promise<RunCommandOutput>;
  readonly snapshot: () => RunningCommandOutput;
  readonly startedAt: number;
  /** When the process reached a terminal state; retention is measured from here. */
  finishedAt?: number;
  final?: RunCommandOutput;
  failure?: Error;
  /** Set only after the owning agent receives a terminal status/cancel result. */
  terminalObserved: boolean;
}

interface CommandExecutionHooks {
  readonly onStarted?: (snapshot: () => RunningCommandOutput) => void;
  readonly background?: boolean;
  readonly backgroundKind?: "job" | "service";
}

const MAX_STATUS_WAIT_MS = 30_000;
const COMPLETED_JOB_RETENTION_MS = 60 * 60_000;
const MAX_RETAINED_JOBS = 64;

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

/** Values authorizeCommand reads from the enclosing turn; see AgentRuntime.executeNormalizedCommand. */
interface CommandAuthorizationContext {
  readonly benchmark: boolean;
  readonly commandId: string;
  readonly context: ToolContext;
  readonly hooks: CommandExecutionHooks;
  readonly input: RunCommandInput;
  readonly startedAt: number;
  readonly unrestricted: boolean;
}

/** Where an authorized command runs. Target resolution may move it to the host before approval; then it is fixed. */
interface CommandTarget {
  hostAccess: boolean;
  executionBackend: CommandExecutionBackend;
  resolved: ResolvedCommand;
  readonly containerExecution: boolean;
  readonly networkEnabled: boolean;
  readonly resolverOptions: { unrestrictedHostAccess: boolean; unrestrictedCommands: boolean; networkEnabled: boolean };
  readonly boundaryScope: string;
  readonly boundaryHostPrefix: string | undefined;
  readonly boundaryCommandFamily: string;
  readonly boundaryIncidentKey: string;
  boundaryGrantConsumed: boolean;
  capabilityEscalation: string | undefined;
}

/** One invocation's network approval; the first answer, including a denial, is reused for every later connection. */
interface CommandNetworkApproval {
  approve(destination?: string): Promise<boolean>;
  /** The command approval already covered network access. */
  grant(): void;
}

type AuthorizeCommandFlow =
  | {
      kind: "next";
      outputs: {
        executionBackend: CommandExecutionBackend;
        resolved: ResolvedCommand;
        boundaryScope: string;
        boundaryHostPrefix: string | undefined;
        boundaryCommandFamily: string;
        boundaryIncidentKey: string;
        policyDecision: CommandPolicyDecision;
        networkApprovalController: AbortController;
        timeout: CommandTimeoutBudget;
        sandboxRequest: SandboxExecutionRequest;
        networkGate: CommandNetworkGate | undefined;
      };
    }
  | { kind: "return"; value: RunCommandOutput | Promise<RunCommandOutput> };

/** Values requestBoundaryHostGrant reads from the enclosing turn; see AgentRuntime.executeNormalizedCommand. */
interface BoundaryHostGrantContext {
  readonly boundaryHostPrefix: string | undefined;
  readonly boundaryIncidentKey: string;
  readonly boundaryScope: string;
  readonly commandId: string;
  readonly context: ToolContext;
  readonly output: RunCommandOutput;
  readonly resolved: ResolvedCommand;
}

/** Values recordSandboxBoundaryViolation reads from the enclosing turn; see AgentRuntime.executeNormalizedCommand. */
interface SandboxBoundaryViolationContext {
  readonly benchmark: boolean;
  readonly boundaryScope: string;
  readonly boundaryViolation: Extract<SandboxWorkerControl, { type: "sandbox_boundary_violation" }> | undefined;
  readonly commandId: string;
  readonly context: ToolContext;
  readonly resolved: ResolvedCommand;
}

/** Turn-local variables recordSandboxBoundaryViolation updates; written back when it returns or throws. */
interface SandboxBoundaryViolationState {
  boundaryCommandFamily: string;
  boundaryHostPrefix: string | undefined;
  boundaryIncidentKey: string;
}

export class CommandRuntime {
  private readonly hostPlatform: HostPlatform;
  readonly resolver: CommandResolver;
  readonly policy: CommandPolicy;
  private readonly executionBackend: CommandExecutionBackend;
  private readonly backgroundJobs = new Map<string, BackgroundCommandJob>();
  private quarantineReason?: string;
  private readonly executionJournal: ExecutionJournal;
  private readonly limits: Readonly<RuntimeLimits>;
  private readonly boundaryStore: SandboxBoundaryStore;

  assertEnvironmentSafe(backend: CommandExecutionBackend = this.executionBackend): void {
    this.reconcileDeterministicSpawnFailures();
    try {
      backend.assertEnvironmentSafe?.();
      this.executionJournal.assertRecovered();
    } catch (error) {
      if (error instanceof CommandEnvironmentQuarantined) throw error;
      throw new CommandEnvironmentQuarantined(
        `Command environment is not safe for mutations: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (this.quarantineReason || (this.options.quarantinePath && existsSync(this.options.quarantinePath))) {
      throw new CommandEnvironmentQuarantined(
        `Command environment quarantined; inspect cleanup before resuming mutations: ${this.quarantineReason ?? this.options.quarantinePath}`,
      );
    }
  }

  /** Health projection may reconcile authoritative not-started evidence. It
   * never runs/replays a command or guesses an unknown outcome. */
  environmentFault(): string | undefined {
    try {
      this.assertEnvironmentSafe();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private quarantine(
    reason: string,
    backend: CommandExecutionBackend = this.executionBackend,
    code = "cleanup_unknown",
  ): void {
    this.quarantineReason = reason;
    backend.quarantine?.(reason);
    if (this.options.quarantinePath) {
      mkdirSync(path.dirname(this.options.quarantinePath), { recursive: true });
      writeFileSync(
        this.options.quarantinePath,
        JSON.stringify({
          version: 2,
          code,
          workspace: this.workspace.root,
          backend: backend.describe().backend,
          reason: sanitizeCommandOutput(reason).slice(0, 2048),
          at: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
    }
  }

  private reconcileDeterministicSpawnFailures(): void {
    const recovered = this.executionJournal.reconcileDeterministicNotStarted();
    if (this.executionJournal.hasUnfinishedLeases()) return;
    const markerPath = this.options.quarantinePath;
    if (!recovered.length && (!markerPath || !existsSync(markerPath))) return;
    if (markerPath && existsSync(markerPath)) {
      try {
        const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
          version?: unknown;
          backend?: unknown;
          workspace?: unknown;
          reason?: unknown;
        };
        if (
          marker.version !== 2 ||
          marker.backend !== "native" ||
          typeof marker.workspace !== "string" ||
          path.resolve(marker.workspace) !== path.resolve(this.workspace.root) ||
          typeof marker.reason !== "string" ||
          windowsCreateProcessFailureCode(marker.reason) === undefined
        )
          return;
        unlinkSync(markerPath);
      } catch {
        // Malformed or concurrently changed recovery state stays fail-closed.
        return;
      }
    }
    this.quarantineReason = undefined;
  }

  constructor(
    private readonly workspace: WorkspaceManager,
    policy = new CommandPolicy(),
    executionBackend?: CommandExecutionBackend,
    private readonly unrestrictedExecutionBackend: CommandExecutionBackend = new UnrestrictedHostBackend(),
    private readonly options: CommandRuntimeOptions = {},
  ) {
    this.hostPlatform = hostPlatform();
    this.executionJournal = new ExecutionJournal(options.lifecycleDirectory);
    this.limits = options.limits ?? DEFAULT_RUNTIME_LIMITS;
    this.boundaryStore = sharedSandboxBoundaryStore(
      options.boundaryStatePath,
      this.limits.sandboxBoundaryIncidentLimit,
    );
    this.resolver = new CommandResolver(workspace, {
      environmentPassthrough: this.limits.commandEnvironmentPassthrough,
    });
    this.policy = policy;
    this.executionBackend = executionBackend ?? new NativeSandboxBackend(workspace, { limits: this.limits });
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
    backgroundKind: "job" | "service" = "job",
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
        background: true,
        backgroundKind,
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
    void completion
      .then(
        (output) => {
          const job = this.backgroundJobs.get(output.commandId);
          if (job) {
            job.final = output;
            job.finishedAt ??= Date.now();
          }
          settleInitial(output);
        },
        (error: unknown) => {
          for (const job of this.backgroundJobs.values()) {
            if (job.completion !== completion) continue;
            job.failure = error instanceof Error ? error : new Error(String(error));
            job.finishedAt ??= Date.now();
            break;
          }
          failInitial(error);
        },
      )
      .finally(() => {
        context.signal?.removeEventListener("abort", onSourceAbort);
      });
    return initial;
  }

  async status(commandId: string, context: ToolContext, waitMs = 0): Promise<CommandExecutionOutput> {
    const job = this.requireOwnedJob(commandId, context);
    if (!job.final && !job.failure && waitMs > 0) {
      const signal =
        context.waitSignal && context.signal
          ? AbortSignal.any([context.waitSignal, context.signal])
          : (context.waitSignal ?? context.signal);
      try {
        await this.waitForStatus(job, Math.min(waitMs, MAX_STATUS_WAIT_MS), signal);
      } catch (error) {
        // Steering wakes the wait, not the process. Return its real current
        // status and let Runtime apply the queued user instruction.
        if (!context.waitSignal?.aborted || context.signal?.aborted) throw error;
      }
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
      const output = job.final ?? (await job.completion);
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
    return job?.completion.then(
      () => undefined,
      () => undefined,
    );
  }

  hasRunningCommands(owner?: CommandRuntimeOwner): boolean {
    const expectedOwner = owner ? this.ownerFor(owner) : undefined;
    return [...this.backgroundJobs.values()].some(
      (job) => !job.final && !job.failure && (!expectedOwner || this.ownersMatch(job.owner, expectedOwner)),
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
    return [...this.backgroundJobs.values()].some(
      (job) => !job.terminalObserved && (!expectedOwner || this.ownersMatch(job.owner, expectedOwner)),
    );
  }

  async cancelAll(owner?: CommandRuntimeOwner): Promise<void> {
    const expectedOwner = owner ? this.ownerFor(owner) : undefined;
    const running = [...this.backgroundJobs.values()].filter(
      (job) => !job.final && !job.failure && (!expectedOwner || this.ownersMatch(job.owner, expectedOwner)),
    );
    for (const job of running) job.controller.abort();
    await Promise.all(running.map((job) => job.completion.catch(() => undefined)));
  }

  private async executeCommand(
    input: RunCommandInput,
    context: ToolContext,
    hooks: CommandExecutionHooks = {},
  ): Promise<RunCommandOutput> {
    const normalized = normalizeCommandRequest(input);
    const requestMetadata = commandRequestMetadata(normalized);
    // Record the actual command outcome. A repository-wide inventory is not a
    // prerequisite for reporting a verification result; modified tests remain
    // visible in the workspace change journal and review diff.
    const audits: import("../core/types.js").CommandAuditEntry[] = [];
    let output: RunCommandOutput | undefined;
    let completeAudit = false;
    try {
      output = await this.executeNormalizedCommand(
        normalized,
        { ...context, recordCommand: (entry) => audits.push(entry) },
        {
          ...hooks,
          ...(hooks.onStarted
            ? {
                onStarted: (snapshot: () => RunningCommandOutput) =>
                  hooks.onStarted!(() => ({ ...snapshot(), requestMetadata })),
              }
            : {}),
        },
      );
      if (output.validation && normalized.verificationKind) {
        const targeted = targetedValidationChanges(context.validationPriorChanges ?? [], output.workspaceDelta);
        if (targeted) {
          output.validation.standard = { status: "changed", ...targeted };
          this.options.recordLifecycle?.(
            context,
            output.commandId,
            "command.validation.standard",
            output.validation.standard,
          );
        }
      }
      completeAudit = true;
      return { ...output, requestMetadata };
    } finally {
      // A post-execution comparison failure cannot erase that execution's audit.
      for (const entry of audits)
        context.recordCommand?.({
          ...entry,
          ...(output?.validation
            ? {
                validation: {
                  ...structuredClone(output.validation),
                  ...(!completeAudit
                    ? {
                        status: "unknown" as const,
                        confidence: "low" as const,
                        reason: "Validation comparison did not complete; execution is recorded, not verified.",
                      }
                    : {}),
                },
              }
            : {}),
          ...(normalized.verificationKind ? { verificationKind: normalized.verificationKind } : {}),
        });
    }
  }

  private async executeNormalizedCommand(
    input: RunCommandInput,
    context: ToolContext,
    hooks: CommandExecutionHooks = {},
  ): Promise<RunCommandOutput> {
    const commandId = createId("command");
    const startedAt = Date.now();
    this.options.recordLifecycle?.(context, commandId, "command.request_normalized", commandRequestMetadata(input));
    const unrestricted =
      context.commandExecutionMode === "unrestricted" && (context.isUnrestrictedHostAccessActive?.() ?? true);
    const benchmark = this.options.networkProfile === "benchmark";
    const authorizeCommandFlow = await this.authorizeCommand({
      benchmark,
      commandId,
      context,
      hooks,
      input,
      startedAt,
      unrestricted,
    });
    if (authorizeCommandFlow.kind === "return") return authorizeCommandFlow.value;
    const authorized = authorizeCommandFlow.outputs;
    const {
      executionBackend,
      resolved,
      boundaryScope,
      policyDecision,
      networkApprovalController,
      timeout,
      sandboxRequest,
      networkGate,
    } = authorized;
    try {
      const before = await this.workspace.beginCommandChangeTracking(context.signal);
      this.executionJournal.begin(commandId, context);
      sandboxRequest.lifecycleFile = this.executionJournal.file(commandId);
      sandboxRequest.recordLifecycle = (type, payload) => this.executionJournal.record(commandId, type, payload);
      this.options.recordLifecycle?.(context, commandId, "command.preparing", { execution: "not_started" });
      let prepared: PreparedCommand;
      const preparingAt = Date.now();
      try {
        prepared = await executionBackend.prepare(sandboxRequest);
      } catch (error) {
        if (error instanceof SandboxFailure && ["cleanup_unknown", "state_persistence"].includes(error.code))
          this.quarantine(error.message, executionBackend, error.code);
        else this.executionJournal.complete(commandId);
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
      if (context.signal?.aborted || (unrestricted && !(context.isUnrestrictedHostAccessActive?.() ?? true))) {
        try {
          await prepared.cleanup();
          this.executionJournal.complete(commandId);
        } catch (error) {
          this.quarantine(`Canceled preparation cleanup failed: ${String(error)}`, executionBackend);
        }
        return this.canceledBeforeStart(commandId, startedAt, resolved, policyDecision, context, prepared.metadata);
      }
      const run = await CommandProcessRun.launch(this.processHost(), {
        commandId,
        startedAt,
        context,
        onStarted: hooks.onStarted,
        prepared,
        resolved,
        executionBackend,
        policyDecision,
        timeout,
        unrestricted,
        networkApprovalController,
        networkGate,
      });
      await run.complete();
      const report = run.report();
      // A normal turn cancellation aborts an in-progress verification pass. If
      // cancellation stopped the command, still complete the workspace audit so
      // command-side changes are never left untracked.
      let delta: Awaited<ReturnType<WorkspaceManager["completeCommandChangeTracking"]>>;
      try {
        delta = await this.workspace.completeCommandChangeTracking(
          before,
          context.signal?.aborted ? undefined : context.signal,
        );
      } catch (error) {
        run.cleanupError = `Post-execution workspace audit failed: ${String(error)}`;
        this.quarantine(run.cleanupError, executionBackend, "state_persistence");
        delta = { created: [], updated: [], deleted: [], truncated: true };
      }

      if (run.targetExitCode !== undefined) run.result.exitCode = run.targetExitCode;
      const status = run.status(report);
      const failure = classifyCommandFailure(run, report, status, timeout);
      const { sandboxBoundary } = this.recordSandboxBoundaryViolation(
        { benchmark, boundaryScope, boundaryViolation: report.boundaryViolation, commandId, context, resolved },
        authorized,
      );
      const { result, targetExitCode, targetOutcome } = run;
      const output: RunCommandOutput = {
        validation: {
          ...run.verification.finish(
            targetOutcome === "output_limit" || report.boundaryViolation ? "spawn_failed" : status,
            typeof result.exitCode === "number" ? result.exitCode : null,
            input.verificationKind,
          ),
          targetKey: run.verification.targetKey,
          checkKey: validationCheckKey(
            { program: resolved.executablePath, args: resolved.args, cwd: resolved.cwdRelative },
            this.workspace.root,
          ),
        },
        commandId,
        status,
        exitCode: targetExitCode ?? (typeof result.exitCode === "number" ? result.exitCode : null),
        lifecycle: run.lifecycle(report, preparingAt),
        signal: result.signal ?? null,
        durationMs: Date.now() - startedAt,
        stdout: report.stdout,
        stderr: report.stderr,
        workspaceDelta: summarizeWorkspaceDelta(delta),
        policyDecision,
        sandbox: prepared.metadata,
        timeout,
        ...(report.sandboxUnavailableMessage
          ? {
              sandboxFailure: {
                phase: report.provenNotStarted ? ("initialization" as const) : ("execution" as const),
                retryable: report.retryableInitialization,
              },
            }
          : {}),
        ...(failure ? { failure } : {}),
        ...(sandboxBoundary ? { sandboxBoundary } : {}),
        ...(resolved.notices?.length ? { notices: resolved.notices } : {}),
        executed: this.executionSummary(resolved),
      };

      try {
        this.options.recordLifecycle?.(context, commandId, "command.finished", {
          status: output.status,
          exitCode: output.exitCode,
          lifecycle: output.lifecycle,
          validation: output.validation,
        });
        this.executionJournal.record(commandId, "finished", {
          status: output.status,
          exitCode: output.exitCode,
          lifecycle: output.lifecycle,
        });
        if (!run.cleanupError && (!prepared.controlPipe || run.cleanupConfirmed))
          this.executionJournal.complete(commandId);
      } catch (error) {
        this.quarantine(
          `Execution outcome could not be durably finalized: ${String(error)}`,
          executionBackend,
          "state_persistence",
        );
        output.lifecycle!.cleanup = "unconfirmed";
      }

      // Ask only after the denied execution and its cleanup are durably closed.
      // Approval authorizes a future exact resubmission; Runtime never replays it.
      await this.requestBoundaryHostGrant({
        boundaryHostPrefix: authorized.boundaryHostPrefix,
        boundaryIncidentKey: authorized.boundaryIncidentKey,
        boundaryScope,
        commandId,
        context,
        output,
        resolved,
      });

      const summary =
        status === "exited"
          ? `Exited with code ${output.exitCode}`
          : status === "sandbox_unavailable" && report.sandboxUnavailableMessage
            ? `Sandbox unavailable: ${report.sandboxUnavailableMessage}`
            : status.replace(/_/gu, " ");
      this.audit(output, resolved, context, summary);
      return output;
    } finally {
      networkApprovalController.abort();
      await networkGate?.close();
    }
  }

  /** The slice of this runtime a CommandProcessRun reports to. */
  private processHost(): CommandProcessHost {
    return {
      hostPlatform: this.hostPlatform,
      limits: this.limits,
      workspace: this.workspace,
      executionJournal: this.executionJournal,
      options: this.options,
      quarantine: (reason, backend, code) => this.quarantine(reason, backend, code),
      executionSummary: (command) => this.executionSummary(command),
    };
  }

  /** Turn a sandbox-boundary violation into a durable incident and decide the follow-up action for this command family. */
  private recordSandboxBoundaryViolation(
    ctx: SandboxBoundaryViolationContext,
    updates: SandboxBoundaryViolationState,
  ): { sandboxBoundary: RunCommandOutput["sandboxBoundary"] | undefined } {
    const { benchmark, boundaryScope, boundaryViolation, commandId, context, resolved } = ctx;
    let { boundaryCommandFamily, boundaryHostPrefix, boundaryIncidentKey } = updates;
    try {
      let sandboxBoundary: RunCommandOutput["sandboxBoundary"] | undefined;
      if (boundaryViolation?.type === "sandbox_boundary_violation") {
        if (!benchmark) boundaryHostPrefix ??= commandGrantPrefix(resolved, "host", true);
        boundaryCommandFamily = sha256(JSON.stringify({ cwd: resolved.cwdAbsolute }));
        boundaryIncidentKey = sha256(
          JSON.stringify({
            family: boundaryCommandFamily,
            access: boundaryViolation.access,
            destinationCategory: boundaryViolation.destinationCategory,
          }),
        );
        let attempt: number;
        try {
          attempt = this.boundaryStore.recordViolation(boundaryScope, boundaryCommandFamily, boundaryIncidentKey);
        } catch (error) {
          // A command with a known exit remains known even if intervention state
          // cannot be saved. Fail closed by asking the user immediately.
          attempt = this.limits.sandboxBoundaryApprovalThreshold;
          this.options.recordLifecycle?.(context, commandId, "command.boundary_state_failed", {
            error: String(error).slice(0, 1200),
          });
        }
        const escalate = attempt >= this.limits.sandboxBoundaryApprovalThreshold;
        const action: NonNullable<RunCommandOutput["sandboxBoundary"]>["action"] = !escalate
          ? "adjust_command"
          : benchmark
            ? this.limits.benchmarkBoundaryApproval === "allow_once"
              ? "benchmark_allow_once"
              : "benchmark_rejected"
            : "user_required";
        sandboxBoundary = {
          attempt,
          modelCorrectionBudget: this.limits.sandboxBoundaryModelCorrections,
          action,
          access: boundaryViolation.access,
          ...(boundaryViolation.destination ? { destination: boundaryViolation.destination } : {}),
          destinationCategory: boundaryViolation.destinationCategory,
          hostRetryAuthorized: false,
          autoReplay: false,
        };
        try {
          if (action === "benchmark_allow_once")
            this.boundaryStore.recordDecision(boundaryScope, boundaryIncidentKey, "benchmark_allow_once");
          else if (action === "benchmark_rejected")
            this.boundaryStore.recordDecision(boundaryScope, boundaryIncidentKey, "reject");
        } catch (error) {
          this.options.recordLifecycle?.(context, commandId, "command.boundary_state_failed", {
            error: String(error).slice(0, 1200),
          });
        }
      }
      return { sandboxBoundary };
    } finally {
      updates.boundaryCommandFamily = boundaryCommandFamily;
      updates.boundaryHostPrefix = boundaryHostPrefix;
      updates.boundaryIncidentKey = boundaryIncidentKey;
    }
  }

  /** After a sandbox-boundary denial whose cleanup is confirmed, ask the user whether the next exact resubmission may run once on the host. */
  private async requestBoundaryHostGrant(ctx: BoundaryHostGrantContext): Promise<void> {
    const { boundaryHostPrefix, boundaryIncidentKey, boundaryScope, commandId, context, output, resolved } = ctx;
    if (
      output.sandboxBoundary?.action === "user_required" &&
      boundaryHostPrefix &&
      output.lifecycle?.cleanup === "confirmed"
    ) {
      let observedDecision: import("../core/types.js").ApprovalDecision | undefined;
      let approved = false;
      try {
        approved = await context.requestApproval({
          id: `${sha256(boundaryHostPrefix)}:sandbox-boundary`,
          signal: context.signal,
          title: `Allow outside sandbox: ${resolved.program}`,
          description:
            `The enforced workspace sandbox rejected this exact command on attempt ${output.sandboxBoundary.attempt}. ` +
            "The command has stopped and cleanup is confirmed. Approving does not replay it; it gives the next exact resubmission one host execution with host filesystem and network access.",
          risk: "system",
          commandPrefix: boundaryHostPrefix,
          commandPreview: commandPreview(resolved),
          allowPrompt: context.approvalPolicy !== "never",
          requiredReviewer: "user",
          executionTiming: "future_resubmission",
          observeDecision: (decision) => {
            observedDecision = decision;
          },
          command: {
            executable: resolved.executablePath,
            args: resolved.args,
            cwd: resolved.cwdAbsolute,
            scope: "host",
            network: true,
          },
        });
      } catch {
        approved = false;
      }
      const decision = approved
        ? (observedDecision ?? "allow_once")
        : observedDecision === "reject"
          ? "reject"
          : "user_required";
      let decisionStored = true;
      try {
        this.boundaryStore.recordDecision(boundaryScope, boundaryIncidentKey, decision, boundaryHostPrefix);
      } catch (error) {
        decisionStored = false;
        this.options.recordLifecycle?.(context, commandId, "command.boundary_state_failed", {
          error: String(error).slice(0, 1200),
        });
      }
      if (!decisionStored && (decision === "allow_once" || decision === "allow_prefix")) {
        output.sandboxBoundary.action = "user_required";
        output.sandboxBoundary.hostRetryAuthorized = false;
      } else {
        output.sandboxBoundary.action =
          decision === "allow_once"
            ? "approved_once"
            : decision === "allow_prefix"
              ? "approved_prefix"
              : decision === "reject"
                ? "rejected"
                : "user_required";
        output.sandboxBoundary.hostRetryAuthorized = decision === "allow_once" || decision === "allow_prefix";
      }
      this.options.recordLifecycle?.(context, commandId, "command.boundary_intervention", {
        attempt: output.sandboxBoundary.attempt,
        action: output.sandboxBoundary.action,
        fingerprint: sha256(boundaryHostPrefix),
        autoReplay: false,
      });
    }
  }

  /** Resolve the execution backend and permission profile, apply boundary grants, policy and approvals (including network), and build the sandbox request; returns early with a refusal result when execution must not start. */
  private async authorizeCommand(ctx: CommandAuthorizationContext): Promise<AuthorizeCommandFlow> {
    const { benchmark, commandId, context, input, startedAt, unrestricted } = ctx;
    const targetFlow = await this.resolveCommandTarget(ctx);
    if (targetFlow.kind === "return") return targetFlow;
    const { target } = targetFlow;
    const { containerExecution, executionBackend, hostAccess, networkEnabled, resolved } = target;
    const networkOperation = inspectNetworkOperation(resolved);
    const classified = this.policy.classify(input, resolved);
    const scope = containerExecution ? "container" : hostAccess ? "host" : "workspace";
    const commandNetwork = hostAccess || (Boolean(networkOperation) && networkEnabled);
    // PATH and executable bytes belong to the offline worker, not controller.
    // Without host-attested bytes, use one-shot approval, never a fake digest.
    const prefix =
      executionBackend.approvalPrefix?.(resolved, context, commandNetwork) ??
      (containerExecution ? `once:v1:${sha256(commandId)}` : commandGrantPrefix(resolved, scope, commandNetwork));
    const fingerprint = this.policy.approvalFingerprint(resolved, classified);

    // A single approval authorizes this invocation, not the entire Thread.
    // Cache denial too: a command cannot generate an approval-prompt loop.
    const networkApprovalController = new AbortController();
    const networkSignal = context.signal
      ? AbortSignal.any([context.signal, networkApprovalController.signal])
      : networkApprovalController.signal;
    const network = this.networkApproval(ctx, target, { scope, fingerprint, networkOperation, networkSignal });

    if (!unrestricted && !benchmark && !target.boundaryGrantConsumed) {
      const refusal = await this.requestCommandApproval(ctx, target, classified, {
        scope,
        commandNetwork,
        prefix,
        fingerprint,
        networkOperation,
      });
      if (refusal) return refusal;
      if (commandNetwork) network.grant();
    }
    let policyDecision: CommandPolicyDecision = {
      ...classified,
      effect: "allow",
      reason: benchmark
        ? "Container execution; external network boundary remains"
        : unrestricted
          ? "Full access"
          : target.boundaryGrantConsumed
            ? "Exact one-shot host approval consumed after sandbox boundary denial"
            : "Command and requested permissions approved",
      matchedRule: target.boundaryGrantConsumed ? "approved.boundary_once" : `approved.${scope}`,
    };

    if (unrestricted && !(context.isUnrestrictedHostAccessActive?.() ?? true)) {
      policyDecision = {
        ...policyDecision,
        effect: "deny",
        reason: "Host full-access authorization was revoked before the command started",
        matchedRule: "deny.unrestricted_revoked",
      };
      return {
        kind: "return",
        value: this.denied(commandId, startedAt, resolved, policyDecision, context, executionBackend),
      };
    }
    return this.prepareAuthorizedLaunch(ctx, target, policyDecision, {
      fingerprint,
      network,
      networkSignal,
      networkApprovalController,
    });
  }

  /**
   * Resolve the command for its execution scope. A consumed one-shot boundary grant, or a sandbox that lacks a
   * required capability when host escalation is allowed, moves the command to the host before approval.
   */
  private async resolveCommandTarget(
    ctx: CommandAuthorizationContext,
  ): Promise<{ kind: "target"; target: CommandTarget } | Extract<AuthorizeCommandFlow, { kind: "return" }>> {
    const { benchmark, commandId, context, input, startedAt, unrestricted } = ctx;
    const containerExecution = benchmark || this.options.networkProfile === "review_offline";
    const hostAccess = !containerExecution && (unrestricted || input.executionScope === "host");
    const executionBackend = hostAccess ? this.unrestrictedExecutionBackend : this.executionBackend;
    this.assertEnvironmentSafe(executionBackend);
    let resolved: ResolvedCommand;
    const networkEnabled = !benchmark && this.options.networkProfile !== "review_offline";
    const resolverOptions = {
      unrestrictedHostAccess: hostAccess || benchmark,
      unrestrictedCommands: true,
      networkEnabled,
    };
    try {
      resolved = executionBackend.resolveCommand
        ? await executionBackend.resolveCommand(input, context)
        : containerExecution
          ? this.resolver.resolveContainer(input)
          : await this.resolver.resolve(input, resolverOptions);
    } catch (error) {
      return {
        kind: "return",
        value: this.resolutionFailure(commandId, startedAt, input, error, context, executionBackend),
      };
    }
    const boundaryCommandFamily = sha256(JSON.stringify({ cwd: resolved.cwdAbsolute }));
    const target: CommandTarget = {
      hostAccess,
      executionBackend,
      resolved,
      containerExecution,
      networkEnabled,
      resolverOptions,
      boundaryScope: this.boundaryStore.scope(context),
      boundaryHostPrefix: !containerExecution && !unrestricted ? commandGrantPrefix(resolved, "host", true) : undefined,
      boundaryCommandFamily,
      boundaryIncidentKey: boundaryCommandFamily,
      boundaryGrantConsumed: false,
      capabilityEscalation: undefined,
    };
    const { boundaryHostPrefix, boundaryScope } = target;
    if (!hostAccess && boundaryHostPrefix && this.boundaryStore.consumeHostGrant(boundaryScope, boundaryHostPrefix)) {
      // A user approved this exact command after its previous sandbox denial.
      // The grant is consumed before resolution/dispatch and cannot be replayed.
      target.boundaryGrantConsumed = true;
      await this.moveCommandToHost(target, input);
      this.options.recordLifecycle?.(context, commandId, "command.boundary_grant_consumed", {
        fingerprint: sha256(boundaryHostPrefix),
        execution: "not_started",
      });
    }
    if (!target.hostAccess && !containerExecution && this.limits.sandboxAllowHostEscalation) {
      const capabilities = target.executionBackend.describe().capabilities;
      const required = this.requiredCapabilities(input, capabilities);
      try {
        this.assertCapabilities(capabilities, required);
      } catch (error) {
        if (!(error instanceof SandboxCapabilityError)) throw error;
        // No target or worker exists yet. Propose the broader scope BEFORE
        // approval so an old workspace grant can never authorize this launch.
        target.capabilityEscalation = error.message;
        await this.moveCommandToHost(target, input);
        this.options.recordLifecycle?.(context, commandId, "command.host_escalation_requested", {
          required,
          capabilities,
          execution: "not_started",
        });
      }
    }
    return { kind: "target", target };
  }

  /** Switch the target to the host backend and re-resolve the command with host access. */
  private async moveCommandToHost(target: CommandTarget, input: RunCommandInput): Promise<void> {
    target.hostAccess = true;
    target.executionBackend = this.unrestrictedExecutionBackend;
    this.assertEnvironmentSafe(target.executionBackend);
    target.resolverOptions.unrestrictedHostAccess = true;
    target.resolved = await this.resolver.resolve(input, target.resolverOptions);
  }

  /** The invocation's network approval: asked at most once, when the network gate first sees a connection. */
  private networkApproval(
    ctx: CommandAuthorizationContext,
    target: CommandTarget,
    request: {
      scope: "host" | "container" | "workspace";
      fingerprint: string;
      networkOperation: ReturnType<typeof inspectNetworkOperation>;
      networkSignal: AbortSignal;
    },
  ): CommandNetworkApproval {
    const { commandId, context } = ctx;
    const { executionBackend, networkEnabled, resolved } = target;
    const { fingerprint, networkOperation, networkSignal, scope } = request;
    let networkApproval: Promise<boolean> | undefined;
    return {
      grant: () => {
        networkApproval = Promise.resolve(true);
      },
      approve: (destination?: string): Promise<boolean> =>
        (networkApproval ??= (async () => {
          const effect = networkOperation?.effect ?? "unknown";
          if (!networkEnabled) return false;
          const prefix =
            executionBackend.approvalPrefix?.(resolved, context, true) ?? commandGrantPrefix(resolved, scope, true);
          let granted = false;
          try {
            granted = await requestNetworkApproval(
              { ...context, signal: networkSignal },
              {
                id: `${fingerprint}:network`,
                title: `Network: ${resolved.program}`,
                description: `${networkOperation?.description ?? "Unclassified program requests network access"}. This approval covers this command and its children. Downloads/uploads may expose data or change remote state.`,
                risk: effect === "read" ? "read" : "external",
                commandPrefix: prefix,
                commandPreview: commandPreview(resolved),
                network: { effect, ...(destination ? { destination } : {}) },
                command: {
                  executable: resolved.executablePath,
                  args: resolved.args,
                  cwd: resolved.cwdAbsolute,
                  scope,
                  network: true,
                },
              },
            );
            this.options.recordLifecycle?.(context, commandId, "network.authorization", {
              effect,
              granted,
              ...(destination ? { destination } : {}),
            });
          } catch {
            granted = false;
          }
          return granted && !networkSignal.aborted;
        })()),
    };
  }

  /** Ask for this exact invocation; a refusal or an unavailable approver ends it as denied. */
  private async requestCommandApproval(
    ctx: CommandAuthorizationContext,
    target: CommandTarget,
    classified: CommandPolicyDecision,
    request: {
      scope: "host" | "container" | "workspace";
      commandNetwork: boolean;
      prefix: string;
      fingerprint: string;
      networkOperation: ReturnType<typeof inspectNetworkOperation>;
    },
  ): Promise<Extract<AuthorizeCommandFlow, { kind: "return" }> | undefined> {
    const { commandId, context, input, startedAt } = ctx;
    const { capabilityEscalation, executionBackend, hostAccess, resolved } = target;
    const { commandNetwork, fingerprint, networkOperation, prefix, scope } = request;
    let approved = false;
    let approvalUnavailable = false;
    try {
      approved = await context.requestApproval({
        id: fingerprint,
        signal: context.signal,
        title: `${capabilityEscalation ? "Run outside sandbox: " : "Run "}${resolved.program}`,
        description: `${capabilityEscalation ? `${capabilityEscalation} Requesting HOST execution with host filesystem and network permissions, not sandbox execution. ` : ""}${input.reason ?? "Execute requested command"}. Environment=${scope}; network=${commandNetwork}; cwd=${resolved.cwdAbsolute}; exact approval=${fingerprint}`,
        risk: hostAccess ? "system" : classified.risk,
        // This value is produced by CommandResolver after PATH lookup and
        // realpath canonicalization. The UI must never derive a reusable
        // grant by parsing the redacted human-readable preview below.
        commandPrefix: prefix,
        allowPrompt: context.approvalPolicy !== "never",
        command: {
          executable: resolved.executablePath,
          args: resolved.args,
          cwd: resolved.cwdAbsolute,
          scope,
          network: commandNetwork,
        },
        ...(commandNetwork ? { network: { effect: networkOperation?.effect ?? "unknown" } } : {}),
        commandPreview: commandPreview(resolved),
      });
    } catch {
      approvalUnavailable = true;
      approved = false;
    }
    if (approved) return undefined;
    const policyDecision: CommandPolicyDecision = {
      ...classified,
      effect: "deny",
      reason: `${classified.reason}; approval ${approvalUnavailable ? "could not be obtained" : "was not granted"}`,
    };
    return {
      kind: "return",
      value: this.denied(
        commandId,
        startedAt,
        resolved,
        policyDecision,
        context,
        executionBackend,
        "approval",
        approvalUnavailable ? "approval_unavailable" : "approval_not_granted",
      ),
    };
  }

  /**
   * Build the sandbox request for an approved command, check sandbox compatibility, confirm the command material did
   * not change while approval was pending, and open the network gate.
   */
  private async prepareAuthorizedLaunch(
    ctx: CommandAuthorizationContext,
    target: CommandTarget,
    policyDecision: CommandPolicyDecision,
    approval: {
      fingerprint: string;
      network: CommandNetworkApproval;
      networkSignal: AbortSignal;
      networkApprovalController: AbortController;
    },
  ): Promise<AuthorizeCommandFlow> {
    const { commandId, context, hooks, input, startedAt, unrestricted } = ctx;
    const { containerExecution, executionBackend, hostAccess, networkEnabled, resolved, resolverOptions } = target;
    const timeout = hooks.background
      ? resolveBackgroundCommandTimeoutBudget(input.timeoutMs, this.limits)
      : resolveCommandTimeoutBudget(input.timeoutMs, context.commandTimeoutMs, policyDecision.capability, this.limits);
    const sandboxRequest: SandboxExecutionRequest = {
      timeoutMs: timeout.effectiveMs,
      ...(hooks.backgroundKind ? { backgroundKind: hooks.backgroundKind } : {}),
      commandId,
      command: resolved,
      policyDecision,
      context,
      commandPreview: commandPreview(resolved),
      hostExecutionAuthorized: hostAccess,
    };
    // These are compatibility requirements, not permission grants. Scope changes
    // always go through a new approved invocation; never replay here.
    if (!hostAccess) {
      const report = executionBackend.describe(sandboxRequest).capabilities;
      const required = this.requiredCapabilities(input, report);
      try {
        this.assertCapabilities(report, required);
      } catch (error) {
        this.options.recordLifecycle?.(context, commandId, "command.capability_rejected", {
          required,
          report,
          execution: "not_started",
        });
        return {
          kind: "return",
          value: this.sandboxFailure(
            commandId,
            startedAt,
            resolved,
            policyDecision,
            context,
            error,
            sandboxRequest,
            executionBackend,
          ),
        };
      }
    }
    if (context.signal?.aborted) {
      return {
        kind: "return",
        value: this.canceledBeforeStart(
          commandId,
          startedAt,
          resolved,
          policyDecision,
          context,
          executionBackend.describe(sandboxRequest),
        ),
      };
    }

    // Re-resolve after an approval wait. Changed executable/npm material needs a
    // fresh invocation and cannot silently reuse the old approval.
    const fresh = executionBackend.resolveCommand
      ? await executionBackend.resolveCommand(input, context)
      : containerExecution
        ? this.resolver.resolveContainer(input)
        : await this.resolver.resolve(input, resolverOptions);
    if (this.policy.approvalFingerprint(fresh, policyDecision) !== approval.fingerprint) {
      approval.networkApprovalController.abort();
      const output = this.denied(
        commandId,
        startedAt,
        resolved,
        {
          ...policyDecision,
          effect: "deny",
          reason: "The executable or its project files changed while approval was pending; the command did not start",
          matchedRule: "approval.material_changed",
          recommendation: "Submit the command again so approval covers the current files.",
        },
        context,
        executionBackend,
        "approval",
      );
      output.failure!.retryable = true;
      return { kind: "return", value: output };
    }
    const networkGateOptions = {
      signal: approval.networkSignal,
      authorize: async (host: string, port: number) => {
        if (unrestricted && !(context.isUnrestrictedHostAccessActive?.() ?? true)) return false;
        return approval.network.approve(`${host}:${port}`);
      },
      record: (host: string, port: number, outcome: string) =>
        this.options.recordLifecycle?.(context, commandId, "network.connection", { host, port, outcome }),
    };
    const networkGate =
      networkEnabled && !hostAccess
        ? executionBackend.createNetworkGate
          ? await executionBackend.createNetworkGate(networkGateOptions)
          : await createCommandNetworkGate(networkGateOptions)
        : undefined;
    if (networkGate) {
      sandboxRequest.networkProxyURL = networkGate.proxyURL;
      if (networkGate.proxyPorts) sandboxRequest.networkProxyPorts = networkGate.proxyPorts;
    }
    return {
      kind: "next",
      outputs: {
        executionBackend,
        resolved,
        boundaryScope: target.boundaryScope,
        boundaryHostPrefix: target.boundaryHostPrefix,
        boundaryCommandFamily: target.boundaryCommandFamily,
        boundaryIncidentKey: target.boundaryIncidentKey,
        policyDecision,
        networkApprovalController: approval.networkApprovalController,
        timeout,
        sandboxRequest,
        networkGate,
      },
    };
  }

  /** Compatibility requirements for this invocation; test/verify default to loopback IPC. */
  private requiredCapabilities(
    input: RunCommandInput,
    report: ExecutionCapabilities | undefined,
  ): readonly ExecutionCapability[] {
    if (input.requiredCapabilities) return input.requiredCapabilities;
    return report && this.limits.sandboxVerificationRequiresLoopback && ["test", "verify"].includes(input.intent)
      ? ["loopback_tcp"]
      : [];
  }

  private assertCapabilities(
    report: ExecutionCapabilities | undefined,
    required: readonly ExecutionCapability[],
  ): void {
    if (report?.features.process_tree === "blocked") throw new SandboxCapabilityError(["process_tree"], report);
    assertExecutionCapabilities(report, required);
  }

  private ownerFor(context: CommandRuntimeOwner): BackgroundCommandOwner {
    return {
      threadId: context.threadId,
      agentRole: context.agentRole ?? "main_agent",
      ...(context.agentId ? { agentId: context.agentId } : {}),
      ...(context.assignedTaskId ? { assignedTaskId: context.assignedTaskId } : {}),
    };
  }

  private ownersMatch(actual: BackgroundCommandOwner, expected: BackgroundCommandOwner): boolean {
    return (
      actual.threadId === expected.threadId &&
      actual.agentRole === expected.agentRole &&
      actual.agentId === expected.agentId &&
      actual.assignedTaskId === expected.assignedTaskId
    );
  }

  private waitForStatus(job: BackgroundCommandJob, waitMs: number, signal?: AbortSignal): Promise<void> {
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
      void job.completion.then(
        () => finish(),
        () => finish(),
      );
      if (signal?.aborted) onAbort();
    });
  }

  private requireOwnedJob(commandId: string, context: ToolContext): BackgroundCommandJob {
    const job = this.backgroundJobs.get(commandId);
    const owner = this.ownerFor(context);
    if (!job || !this.ownersMatch(job.owner, owner)) {
      // Do not reveal whether another Thread or child owns a live handle.
      throw new Error(`Unknown or inaccessible background command handle: ${commandId}`);
    }
    return job;
  }

  private pruneBackgroundJobs(): void {
    const cutoff = Date.now() - COMPLETED_JOB_RETENTION_MS;
    for (const [commandId, job] of this.backgroundJobs) {
      if (job.terminalObserved && (job.final || job.failure) && (job.finishedAt ?? job.startedAt) < cutoff) {
        this.backgroundJobs.delete(commandId);
      }
    }
    if (this.backgroundJobs.size <= MAX_RETAINED_JOBS) return;
    const completed = [...this.backgroundJobs.entries()]
      .filter(([, job]) => job.terminalObserved && Boolean(job.final || job.failure))
      .sort((left, right) => (left[1].finishedAt ?? left[1].startedAt) - (right[1].finishedAt ?? right[1].startedAt));
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
    failureKind: "policy" | "approval" = "policy",
    failureCode = policyDecision.matchedRule,
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
      failure: {
        kind: failureKind,
        code: failureCode,
        message: policyDecision.reason,
        processStarted: false,
        retryable: false,
      },
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
      failure: {
        kind: "runtime",
        code: "command_canceled_before_start",
        message: "Command was canceled before the target process started",
        processStarted: false,
        retryable: false,
      },
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
  ): RunCommandOutput {
    const message = sanitizeCommandOutput(error instanceof Error ? error.message : String(error));
    const policyBoundary = error instanceof CommandPolicyBoundaryError;
    const notFound = /Executable not found/iu.test(message);
    const policyDecision: CommandPolicyDecision = {
      id: createId("policy"),
      effect: "deny",
      capability: "destructive",
      risk: "destructive",
      reason: `Command resolution failed: ${message}`,
      matchedRule: policyBoundary ? error.code : notFound ? "resolver.not_found" : "resolver.boundary_or_schema",
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
      failure: {
        kind: policyBoundary ? "policy" : "parameter",
        code: policyBoundary ? error.code : policyDecision.matchedRule,
        message: policyDecision.reason,
        processStarted: false,
        retryable: false,
      },
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
      lifecycle: {
        execution: "not_started",
        cleanup:
          error instanceof SandboxFailure && ["cleanup_unknown", "state_persistence"].includes(error.code)
            ? "unconfirmed"
            : "not_required",
      },
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
        retryable: error instanceof SandboxFailure && error.retryableBeforeDispatch,
      },
      failure: {
        kind: "sandbox",
        code:
          error instanceof SandboxCapabilityError || error instanceof SandboxFailure
            ? error.code
            : "sandbox_prepare_failed",
        message,
        processStarted: false,
        executionState: "not_started",
        retryable: error instanceof SandboxFailure && error.retryableBeforeDispatch,
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

  private audit(output: RunCommandOutput, command: ResolvedCommand, context: ToolContext, summary: string): void {
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
        outputEvidence: {
          capturedOutputDigest: `sha256:${sha256(JSON.stringify([output.stdout, output.stderr]))}`,
          stdoutTail: sanitizeCommandOutput(output.stdout.text).slice(-1_024),
          stderrTail: sanitizeCommandOutput(output.stderr.text).slice(-1_024),
          incomplete:
            output.stdout.truncated ||
            output.stderr.truncated ||
            output.stdout.text.length > 1_024 ||
            output.stderr.text.length > 1_024,
          ...(output.failure
            ? {
                failureKind: output.failure.kind,
                processStarted: output.failure.processStarted,
              }
            : {}),
        },
      });
    } catch {
      // Audit projection failures must be handled by the owning event journal;
      // they should not reinterpret a command that already ran.
    }
  }
}
