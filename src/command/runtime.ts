import { execa } from "execa";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { containWindowsWorker, type WindowsCommandJob } from "./windows-job.js";
import { ExecutionJournal } from "./execution-journal.js";
import type { ToolContext } from "../core/types.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hash.js";
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
import { SandboxControlStream } from "../sandbox/control.js";
import type { SandboxWorkerControl } from "../sandbox/types.js";
import { OutputCollector, sanitizeCommandOutput } from "./output-stream.js";
import { CommandPolicy } from "./policy.js";
import { commandRequestMetadata, normalizeCommandRequest } from "./normalize-request.js";
import { CommandVerificationCollector, packageScriptRunner, validationCheckKey } from "./verification.js";
import { captureValidationBaseline, compareValidationBaseline } from "../progress/validation-standard.js";
import { matchesReviewExperiment } from "../progress/experiment.js";
import { inspectNetworkOperation } from "./network-policy.js";
import { createCommandNetworkGate } from "./network-gate.js";
import { networkCommandApprovalPrefix } from "./approval.js";
import { requestNetworkApproval } from "./network-approval.js";
import { commandGrantPrefix } from "./command-grant.js";
import { UnrestrictedHostBackend } from "../sandbox/unrestricted-host-backend.js";
import {
  type CommandRequestValidationFailure,
} from "./request-validation.js";
import { CommandPolicyBoundaryError, CommandResolver } from "./resolver.js";
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
  /** Trusted host selection, never controlled by model arguments. */
  networkProfile?: "development" | "benchmark" | "review_offline";
  sandboxStartupTimeoutMs?: number;
  quarantinePath?: string;
  lifecycleDirectory?: string;
  recordLifecycle?: (context: ToolContext, commandId: string, type: string, payload: unknown) => void;
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
  private readonly backgroundJobs = new Map<string, BackgroundCommandJob>();
  private quarantineReason?: string;
  private readonly executionJournal: ExecutionJournal;

  assertEnvironmentSafe(backend: CommandExecutionBackend = this.executionBackend): void {
    backend.assertEnvironmentSafe?.();
    this.executionJournal.assertRecovered();
    if (this.quarantineReason || (this.options.quarantinePath && existsSync(this.options.quarantinePath))) {
      throw new Error(`Command environment quarantined; inspect cleanup before resuming mutations: ${this.quarantineReason ?? this.options.quarantinePath}`);
    }
  }

  private quarantine(reason: string): void {
    this.quarantineReason = reason;
    this.executionBackend.quarantine?.(reason);
    if (this.options.quarantinePath) {
      mkdirSync(path.dirname(this.options.quarantinePath), { recursive: true });
      writeFileSync(this.options.quarantinePath, JSON.stringify({ version: 1, workspace: this.workspace.root,
        reason: sanitizeCommandOutput(reason).slice(0, 2048), at: new Date().toISOString() }), { mode: 0o600 });
    }
  }

  constructor(
    private readonly workspace: WorkspaceManager,
    policy = new CommandPolicy(),
    executionBackend?: CommandExecutionBackend,
    private readonly unrestrictedExecutionBackend: CommandExecutionBackend = new UnrestrictedHostBackend(),
    private readonly options: CommandRuntimeOptions = {},
  ) {
    this.executionJournal = new ExecutionJournal(options.lifecycleDirectory);
    this.resolver = new CommandResolver(workspace);
    this.policy = policy;
    this.executionBackend = executionBackend ?? new AnthropicSandboxBackend(workspace);
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
      const signal = context.waitSignal && context.signal ? AbortSignal.any([context.waitSignal, context.signal])
        : context.waitSignal ?? context.signal;
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
    const normalized = normalizeCommandRequest(input);
    const baseline = context.validationBaseline;
    const before = baseline && normalized.verificationKind ? await captureValidationBaseline(context.workspaceRoot, context.limits) : undefined;
    const requestMetadata = commandRequestMetadata(normalized);
    // Publish one terminal audit only after the validation-standard comparison.
    // Otherwise the journal permanently loses information added below.
    const audits: import("../core/types.js").CommandAuditEntry[] = [];
    if (context.progressExperiment && matchesReviewExperiment(context.progressExperiment.report, normalized, context.workspaceRoot)) {
      requestMetadata.experimentIncidentId = context.progressExperiment.incidentId;
    }
    let output: RunCommandOutput | undefined;
    let completeAudit = false;
    try {
    output = await this.executeNormalizedCommand(normalized, { ...context, recordCommand: entry => audits.push(entry) }, {
      ...hooks,
      ...(hooks.onStarted ? { onStarted: (snapshot: () => RunningCommandOutput) =>
        hooks.onStarted!(() => ({ ...snapshot(), requestMetadata })) } : {}),
    });
    if (output.validation && baseline && before) {
      output.validation.standard = compareValidationBaseline(baseline, before, await captureValidationBaseline(context.workspaceRoot, context.limits));
      this.options.recordLifecycle?.(context, output.commandId, "command.validation.standard", output.validation.standard);
    }
    completeAudit = true;
    return { ...output, requestMetadata };
    } finally {
    // A post-execution comparison failure cannot erase that execution's audit.
    for (const entry of audits) context.recordCommand?.({ ...entry,
      ...(output?.validation ? { validation: { ...structuredClone(output.validation),
        ...(!completeAudit ? { status: "unknown" as const, confidence: "low" as const,
          reason: "Validation comparison did not complete; execution is recorded, not verified." } : {}) } } : {}),
      ...(normalized.verificationKind ? { verificationKind: normalized.verificationKind } : {}) });
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
    const unrestricted = context.commandExecutionMode === "unrestricted" &&
      (context.isUnrestrictedHostAccessActive?.() ?? true);
    const benchmark = this.options.networkProfile === "benchmark";
    const containerExecution = benchmark || this.options.networkProfile === "review_offline";
    const hostAccess = !containerExecution && (unrestricted || input.executionScope === "host");
    const executionBackend = hostAccess ? this.unrestrictedExecutionBackend : this.executionBackend;
    this.assertEnvironmentSafe(executionBackend);
    let resolved: ResolvedCommand;
    const networkEnabled = !benchmark && this.options.networkProfile !== "review_offline";
    const resolverOptions = { unrestrictedHostAccess: hostAccess || benchmark, unrestrictedCommands: true, networkEnabled };
    try {
      resolved = containerExecution ? this.resolver.resolveContainer(input) : await this.resolver.resolve(input, resolverOptions);
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
    const networkOperation = inspectNetworkOperation(resolved);
    let policyDecision = this.policy.classify(input, resolved, "code", networkEnabled);
    const scope = containerExecution ? "container" : hostAccess ? "host" : "workspace";
    const commandNetwork = hostAccess || Boolean(networkOperation) && networkEnabled;
    // PATH and executable bytes belong to the offline worker, not controller.
    // Without host-attested bytes, use one-shot approval, never a fake digest.
    const prefix = containerExecution ? `once:v1:${sha256(commandId)}` : commandGrantPrefix(resolved, scope, commandNetwork);
    const fingerprint = this.policy.approvalFingerprint(resolved, policyDecision);

    // A single approval authorizes this invocation, not the entire Thread.
    // Cache denial too: a command cannot generate an approval-prompt loop.
    let networkApproval: Promise<boolean> | undefined;
    const networkApprovalController = new AbortController();
    const networkSignal = context.signal ? AbortSignal.any([context.signal, networkApprovalController.signal]) : networkApprovalController.signal;
    const approveNetwork = (destination?: string): Promise<boolean> => networkApproval ??= (async () => {
      const effect = networkOperation?.effect ?? "unknown";
      if (!networkEnabled) return false;
      const prefix = commandGrantPrefix(resolved, scope, true);
      let granted = false;
      try {
        granted = await requestNetworkApproval({ ...context, signal: networkSignal }, {
          id: `${fingerprint}:network`, title: `Network: ${resolved.program}`,
          description: `${networkOperation?.description ?? "Unclassified program requests network access"}. This approval covers this command and its children. Downloads/uploads may expose data or change remote state.`,
          risk: effect === "read" ? "read" : "external", commandPrefix: prefix,
          commandPreview: commandPreview(resolved), network: { effect, ...(destination ? { destination } : {}) },
          command: { executable: resolved.executablePath, args: resolved.args, cwd: resolved.cwdAbsolute, scope, network: true },
        });
        this.options.recordLifecycle?.(context, commandId, "network.authorization", { effect, granted, ...(destination ? { destination } : {}) });
      } catch { granted = false; }
      return granted && !networkSignal.aborted;
    })();

    const shouldAsk = !unrestricted && !benchmark;
    if (shouldAsk) {
      let approved = false;
      let approvalUnavailable = false;
      try {
        approved = await context.requestApproval({
          id: fingerprint,
          signal: context.signal,
          title: `Run ${resolved.program}`,
          description: `${input.reason ?? "Execute requested command"}. Environment=${scope}; network=${commandNetwork}; cwd=${resolved.cwdAbsolute}; exact approval=${fingerprint}`,
          risk: hostAccess ? "system" : policyDecision.risk,
          // This value is produced by CommandResolver after PATH lookup and
          // realpath canonicalization. The UI must never derive a reusable
          // grant by parsing the redacted human-readable preview below.
          commandPrefix: prefix,
          allowPrompt: context.approvalPolicy !== "never",
          command: { executable: resolved.executablePath, args: resolved.args, cwd: resolved.cwdAbsolute, scope, network: commandNetwork },
          ...(commandNetwork ? { network: { effect: networkOperation?.effect ?? "unknown" } } : {}),
          commandPreview: commandPreview(resolved),
        });
      } catch {
        approvalUnavailable = true;
        approved = false;
      }
      if (!approved) {
        policyDecision = {
          ...policyDecision,
          effect: "deny",
          reason: `${policyDecision.reason}; approval ${approvalUnavailable ? "could not be obtained" : "was not granted"}`,
        };
        return this.denied(
          commandId,
          startedAt,
          resolved,
          policyDecision,
          context,
          executionBackend,
          "approval",
          approvalUnavailable ? "approval_unavailable" : "approval_not_granted",
        );
      }
      if (commandNetwork) networkApproval = Promise.resolve(true);
    }
    policyDecision = { ...policyDecision, effect: "allow", reason: benchmark ? "Container execution; external network boundary remains" : unrestricted ? "Full access" : "Command and requested permissions approved", matchedRule: `approved.${scope}` };

    if (unrestricted && !(context.isUnrestrictedHostAccessActive?.() ?? true)) {
      policyDecision = {
        ...policyDecision,
        effect: "deny",
        reason: "Host full-access authorization was revoked before the command started",
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
      hostExecutionAuthorized: hostAccess,
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

    // Re-resolve after an approval wait. Changed executable/npm material needs a
    // fresh invocation and cannot silently reuse the old approval.
    const fresh = containerExecution ? this.resolver.resolveContainer(input) : await this.resolver.resolve(input, resolverOptions);
    if (this.policy.approvalFingerprint(fresh, policyDecision) !== fingerprint) {
      throw new Error("Command material changed while awaiting approval; request again");
    }
    const networkGate = networkEnabled && !hostAccess
      ? await createCommandNetworkGate({
          signal: networkSignal,
          authorize: async (host, port) => {
            if (unrestricted && !(context.isUnrestrictedHostAccessActive?.() ?? true)) return false;
            return approveNetwork(`${host}:${port}`);
          },
          record: (host, port, outcome) => this.options.recordLifecycle?.(context, commandId, "network.connection", { host, port, outcome }),
        }) : undefined;
    if (networkGate) sandboxRequest.networkProxyURL = networkGate.proxyURL;
    try {
    const before = await this.workspace.beginCommandChangeTracking(context.signal);
    this.executionJournal.begin(commandId, context);
    this.options.recordLifecycle?.(context, commandId, "command.preparing", { execution: "not_started" });
    let prepared: PreparedCommand;
    try {
      prepared = await executionBackend.prepare(sandboxRequest);
    } catch (error) {
      if (error instanceof AggregateError) this.quarantine("Sandbox preparation cleanup was incomplete");
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
    if (context.signal?.aborted || unrestricted && !(context.isUnrestrictedHostAccessActive?.() ?? true)) {
      try {
        await prepared.cleanup();
        this.executionJournal.complete(commandId);
      } catch (error) {
        this.quarantine(`Canceled preparation cleanup failed: ${String(error)}`);
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
    const verification = new CommandVerificationCollector({ program: resolved.executablePath, args: resolved.args, cwd: resolved.cwdAbsolute,
      environmentDigest: sha256(JSON.stringify(Object.entries(resolved.environment).sort(([a], [b]) => a.localeCompare(b)))) },
      await packageScriptRunner({ program: resolved.executablePath, args: resolved.args }, resolved.cwdAbsolute));
    const timeout = resolveCommandTimeoutBudget(
      input.timeoutMs,
      context.commandTimeoutMs,
      policyDecision.capability,
    );
    const timeoutMs = timeout.effectiveMs;
    let timeoutPhase: "initialization" | "command" | undefined;
    let canceled = false;
    let result: ProcessResult = {};
    let termination: ReturnType<typeof terminateProcessTree> | undefined;
    const sandboxStartupTimeoutMs = Math.max(
      1,
      this.options.sandboxStartupTimeoutMs ??
        defaultSandboxStartupTimeout(prepared.metadata),
    );

    const subprocess = execa(prepared.executablePath, prepared.args, {
      cwd: prepared.cwdAbsolute,
      env: { ...prepared.environment, ...(prepared.controlPipe && process.platform === "win32" ? { EASY_CODE_JOB_HANDSHAKE: "1" } : {}) },
      extendEnv: false,
      shell: false,
      stdio: prepared.controlPipe ? [process.platform === "win32" ? "pipe" : "ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      buffer: false,
      reject: false,
      cleanup: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stripFinalNewline: false,
    });

    let windowsJob: WindowsCommandJob | undefined;
    let cooperativeStop: Promise<void> | undefined;
    let cleanupDeadline: NodeJS.Timeout | undefined;
    const forceTermination = (): void => {
      termination ??= windowsJob ? windowsJob.stop() : terminateProcessTree(subprocess);
    };
    const requestTermination = (): void => {
      networkApprovalController.abort();
      void networkGate?.close();
      // Leave the trusted Windows worker alive to revoke/restore its ACL lease.
      // Killing the entire Job here would prevent cleanup_complete forever.
      if (windowsJob && dispatched && !protocolError && !cleanupError) {
        if (!cooperativeStop) {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          cleanupDeadline = setTimeout(forceTermination, 45_000);
          cooperativeStop = windowsJob.quiesce().catch(error => {
            cleanupError = `Descendant cancellation failed: ${String(error)}`;
            forceTermination();
          });
        }
      } else if (prepared.cooperativeTermination && process.platform === "linux" && !protocolError) {
        if (!cooperativeStop) {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          cleanupDeadline = setTimeout(forceTermination, 15000);
          cooperativeStop = Promise.resolve();
          if (subprocess.pid) { try { process.kill(subprocess.pid, "SIGTERM"); } catch { forceTermination(); } }
        }
      } else forceTermination();
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
    let dispatched = !prepared.metadata.enforced;
    let targetExitCode: number | undefined;
    let targetOutcome: Extract<SandboxWorkerControl, { type: "execution_exited" }>["outcome"];
    let cleanupConfirmed = !prepared.metadata.enforced;
    let cleanupError: string | undefined;
    let protocolError: string | undefined;
    const lifecycleEvents: SandboxWorkerControl[] = [];
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
    const controlStream = new SandboxControlStream(commandId, (control) => {
      lifecycleEvents.push(control);
      this.options.recordLifecycle?.(context, commandId, `command.${control.type}`, control);
      if (control.type === "ready") { readyObserved = true; armTimeout("command", timeoutMs); }
      if (control.type === "execution_dispatched") { dispatched = true; announceStarted(); }
      if (control.type === "execution_exited") { targetExitCode = control.exitCode; targetOutcome = control.outcome; }
      if (control.type === "cleanup_complete") cleanupConfirmed = true;
      if (control.type === "cleanup_error") cleanupError = control.message;
      if (control.type === "cleanup_requested") {
        if (!windowsJob) throw new Error("Missing Windows job supervisor at cleanup");
        void windowsJob.quiesce().then(()=>subprocess.stdin?.end("CLEANUP\n"),error=>{
          cleanupError=String(error);requestTermination();
        });
      }
    }, prepared.controlPipe === true);
    if (prepared.controlPipe) subprocess.stdio[3]?.on("data", (chunk: Buffer) => {
      try { controlStream.push(chunk); } catch (error) {
        protocolError = error instanceof Error ? error.message : String(error);
        requestTermination();
      }
    });
    subprocess.stdout?.on("data", (chunk: Buffer | string) => { verification.push("stdout", chunk); stdout.push(chunk); });
    subprocess.stderr?.on("data", (chunk: Buffer | string) => {
      verification.push("stderr", chunk);
      stderr.push(chunk);
      if (!prepared.controlPipe) {
        observeReady(chunk);
        // Legacy/test workers: remember controls independently from clipped output.
        try { controlStream.push(chunk); } catch { /* Untrusted legacy stdout cannot prove an unstarted target. */ }
      }
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

    if (prepared.controlPipe && process.platform === "win32") {
      try {
        if (!subprocess.pid) throw new Error("Worker did not start");
        windowsJob = await containWindowsWorker(subprocess.pid);
        if (context.signal?.aborted) requestTermination();
        else subprocess.stdin?.write("GO\n");
      } catch (error) {
        protocolError = error instanceof Error ? error.message : String(error);
        requestTermination();
      }
    }

    try {
      result = (await subprocess) as ProcessResult;
    } catch (error) {
      result = error as ProcessResult;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (cleanupDeadline) clearTimeout(cleanupDeadline);
      if (revocationTimer) clearInterval(revocationTimer);
      context.signal?.removeEventListener("abort", onAbort);
    }
    const terminationResult = await (windowsJob?.stop() ?? termination);
    await networkGate?.close();
    if (terminationResult && !terminationResult.confirmed) {
      cleanupError = "Process tree termination could not be confirmed";
      this.quarantine(cleanupError);
    }

    try {
      if (!cleanupError && (!prepared.controlPipe || cleanupConfirmed)) await prepared.cleanup();
      else this.quarantine(cleanupError ?? "Sandbox cleanup was not confirmed");
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
      this.quarantine(cleanupError);
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
    const controls = prepared.controlPipe ? lifecycleEvents : [...lifecycleEvents, ...extractedStderr.controls];
    const sandboxError = controls.find((control) =>
      control.type === "sandbox_error"
    );
    const targetSpawnError = controls.find((control) =>
      control.type === "target_spawn_error"
    );
    const lastSandboxStage = [...controls].reverse().find((control) =>
      control.type === "stage"
    );
    const sandboxReady = readyObserved;
    const provenNotStarted = !dispatched && !readyObserved && !protocolError && cleanupConfirmed;
    const sandboxUnavailableMessage = protocolError ?? (sandboxError?.type === "sandbox_error"
      ? sandboxError.message
      : !sandboxReady
        ? timeoutPhase === "initialization" || result.timedOut
          ? `OS sandbox initialization did not become ready within ${sandboxStartupTimeoutMs}ms; ` +
            "the target process was not confirmed started" +
            (lastSandboxStage?.type === "stage"
              ? ` (last worker stage: ${lastSandboxStage.stage})`
              : " (the worker reported no startup stage)")
          : "Sandbox worker exited without confirming that enforcement was active"
        : undefined);
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
    // A normal turn cancellation aborts an in-progress verification pass. If
    // cancellation stopped the command, still complete the workspace audit so
    // command-side changes are never left untracked.
    let delta: Awaited<ReturnType<WorkspaceManager["completeCommandChangeTracking"]>>;
    try {
      delta = await this.workspace.completeCommandChangeTracking(before, context.signal?.aborted ? undefined : context.signal);
    } catch (error) {
      cleanupError = `Post-execution workspace audit failed: ${String(error)}`;
      this.quarantine(cleanupError);
      delta = { created: [], updated: [], deleted: [], truncated: true };
    }

    if (targetExitCode !== undefined) result.exitCode = targetExitCode;
    const status: RunCommandOutput["status"] = canceled || targetOutcome === "canceled"
      ? "canceled"
      : sandboxUnavailableMessage
          ? "sandbox_unavailable"
          : timeoutPhase === "command" || result.timedOut || targetOutcome === "timed_out"
            ? "timed_out"
          : targetSpawnError || targetOutcome === "spawn_failed" || targetOutcome === "unknown"
            ? "spawn_failed"
          : (targetExitCode ?? result.exitCode) === undefined
              ? "spawn_failed"
              : "exited";
    const failure: RunCommandOutput["failure"] = targetOutcome === "output_limit" ? {
      kind: "runtime", code: "command_output_limit", message: "Command exceeded the 32 MiB bridge output limit. Execution is incomplete; narrow output before a new call. No automatic replay.",
      processStarted: true, retryable: false,
    } : status === "exited" && result.exitCode !== 0
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
            message: `Process exceeded the effective command timeout of ${timeoutMs}ms and was terminated`,
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
                code: "target_spawn_failed",
                message: dispatched ? "Execution was dispatched but its target outcome is unknown; do not rerun automatically" : targetSpawnError?.type === "target_spawn_error"
                  ? targetSpawnError.message
                  : "Runtime could not start the target process",
                processStarted: dispatched,
                retryable: false,
              }
            : sandboxUnavailableMessage
              ? {
                  kind: "sandbox",
                  code: "sandbox_unavailable",
                  message: sandboxUnavailableMessage,
                  processStarted: !provenNotStarted,
                  executionState: targetExitCode !== undefined ? "exited" : provenNotStarted ? "not_started" : "unknown",
                  retryable: provenNotStarted && retryableSandboxFailure(sandboxUnavailableMessage),
                }
              : undefined;
    const output: RunCommandOutput = {
      validation: { ...verification.finish(targetOutcome === "output_limit" ? "spawn_failed" : status, typeof result.exitCode === "number" ? result.exitCode : null, input.verificationKind), targetKey: verification.targetKey,
        checkKey: validationCheckKey({ program: resolved.executablePath, args: resolved.args, cwd: resolved.cwdRelative }, this.workspace.root) },
      commandId,
      status,
      exitCode: targetExitCode ?? (typeof result.exitCode === "number" ? result.exitCode : null),
      lifecycle: {
        ...(targetOutcome ? { outcome: targetOutcome } : {}),
        execution: targetOutcome === "unknown" || targetOutcome === "spawn_failed" ? "unknown" : targetExitCode !== undefined ? "exited" : provenNotStarted ? "not_started" : "unknown",
        cleanup: cleanupError ? "failed" : !prepared.metadata.enforced ? "not_required" : cleanupConfirmed ? "confirmed" : "unconfirmed",
        ...(cleanupError ? { cleanupError } : {}),
      },
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
              phase: provenNotStarted ? "initialization" as const : "execution" as const,
              retryable: provenNotStarted && retryableSandboxFailure(sandboxUnavailableMessage),
            },
          }
        : {}),
      ...(failure ? { failure } : {}),
      executed: this.executionSummary(resolved),
    };

    try {
      this.options.recordLifecycle?.(context, commandId, "command.finished", { status: output.status, exitCode: output.exitCode, lifecycle: output.lifecycle, validation: output.validation });
      if (!cleanupError && (!prepared.controlPipe || cleanupConfirmed)) this.executionJournal.complete(commandId);
    } catch (error) {
      this.quarantine(`Execution outcome could not be durably finalized: ${String(error)}`);
      output.lifecycle!.cleanup = "unconfirmed";
    }

    const summary = status === "exited"
      ? `Exited with code ${output.exitCode}`
      : status === "sandbox_unavailable" && sandboxUnavailableMessage
        ? `Sandbox unavailable: ${sandboxUnavailableMessage}`
        : status.replace(/_/gu, " ");
    this.audit(output, resolved, context, summary);
    return output;
    } finally {
      networkApprovalController.abort();
      await networkGate?.close();
    }
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
    validationFailure?: CommandRequestValidationFailure,
  ): RunCommandOutput {
    const message = sanitizeCommandOutput(error instanceof Error ? error.message : String(error));
    const policyBoundary = error instanceof CommandPolicyBoundaryError;
    const notFound = !validationFailure && /Executable not found/iu.test(message);
    const policyDecision: CommandPolicyDecision = {
      id: createId("policy"),
      effect: "deny",
      capability: "destructive",
      risk: "destructive",
      reason: validationFailure?.reason ?? `Command resolution failed: ${message}`,
      matchedRule: validationFailure?.matchedRule ??
        (policyBoundary
          ? error.code
          : notFound
            ? "resolver.not_found"
            : "resolver.boundary_or_schema"),
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
      failure: {
        kind: "sandbox",
        code: "sandbox_prepare_failed",
        message,
        processStarted: false,
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
        outputEvidence: {
          capturedOutputDigest: `sha256:${sha256(JSON.stringify([output.stdout, output.stderr]))}`,
          stdoutTail: sanitizeCommandOutput(output.stdout.text).slice(-1_024),
          stderrTail: sanitizeCommandOutput(output.stderr.text).slice(-1_024),
          incomplete: output.stdout.truncated || output.stderr.truncated ||
            output.stdout.text.length > 1_024 || output.stderr.text.length > 1_024,
          ...(output.failure ? {
            failureKind: output.failure.kind,
            processStarted: output.failure.processStarted,
          } : {}),
        },
      });
    } catch {
      // Audit projection failures must be handled by the owning event journal;
      // they should not reinterpret a command that already ran.
    }
  }
}
