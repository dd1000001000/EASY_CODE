import { z } from "zod";
import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import { CommandRuntime } from "../command/runtime.js";
import { normalizeCommandRequest } from "../command/normalize-request.js";
import { formatCommandTimeoutBudget } from "../command/timeout.js";
import type {
  CancelCommandInput,
  CommandExecutionOutput,
  CommandFailureKind,
  PollCommandInput,
} from "../command/types.js";
import {
  COMMAND_INTENTS,
  VERIFICATION_KINDS,
} from "../command/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace } from "./base.js";
import { documentToolSchema } from "./metadata.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { EXECUTION_CAPABILITIES } from "../sandbox/capabilities.js";

const commandInvocationObjectSchema = z
  .object({
    program: z.string().min(1).max(4_096),
    args: z.array(z.string().max(16_384)).max(256).optional(),
    cwd: z.string().min(1).max(4_096).optional(),
    intent: z.enum(COMMAND_INTENTS),
    verificationKind: z.unknown().optional(),
    timeoutMs: z.number().int().positive().optional(),
    reason: z.string().max(2_000).optional(),
    executionScope: z.enum(["workspace", "host"]).optional(),
    requiredCapabilities: z.array(z.enum(EXECUTION_CAPABILITIES)).max(EXECUTION_CAPABILITIES.length).optional(),
  })
  .strict();

const commandHandleSchema = z.string().regex(/^command_[0-9a-f-]{36}$/u);

export const runCommandInputSchema = commandInvocationObjectSchema.transform(normalizeCommandRequest);
export const startCommandInputSchema = commandInvocationObjectSchema.extend({
  backgroundKind: z.enum(["job", "service"]).optional().default("job"),
}).transform(({ backgroundKind, ...request }) => ({
  ...normalizeCommandRequest(request),
  backgroundKind,
}));
export const pollCommandInputSchema = z.object({
  commandId: commandHandleSchema,
  waitMs: z.number().int().min(0).max(30_000).optional(),
}).strict();
export const cancelCommandInputSchema = z.object({
  commandId: commandHandleSchema,
}).strict();

function commandInvocationDefinition(includeBackgroundKind = false): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      program: { type: "string", minLength: 1, maxLength: 4_096 },
      args: {
        type: "array",
        items: { type: "string", maxLength: 16_384 },
        maxItems: 256,
      },
      cwd: { type: "string", minLength: 1, maxLength: 4_096 },
      intent: { type: "string", enum: [...COMMAND_INTENTS] },
      verificationKind: { type: "string", enum: [...VERIFICATION_KINDS] },
      timeoutMs: { type: "integer", minimum: 1 },
      reason: { type: "string", maxLength: 2_000 },
      executionScope: { type: "string", enum: ["workspace", "host"], description: "Default workspace sandbox. Request host only when this exact command needs permissions outside the workspace; approval includes this escalation. Benchmark always stays container-confined." },
      requiredCapabilities: { type: "array", items: { type: "string", enum: [...EXECUTION_CAPABILITIES] }, maxItems: EXECUTION_CAPABILITIES.length, description: "Compatibility requirements, NOT permissions. Test/verify defaults to requiring loopback TCP for runtime IPC. Set [] only for checks known not to need IPC; otherwise request host scope with normal approval if the sandbox reports missing capabilities. Never rewrite libraries to bypass isolation." },
      ...(includeBackgroundKind ? { backgroundKind: { type: "string", enum: ["job", "service"], description: "Default job retains the workspace mutation lock until completion. Service reserves the workspace for its agent while allowing that same agent to run dependent tools concurrently with the service; other agents remain blocked." } } : {}),
    },
    required: ["program", "intent"],
  };
}

function commandHandleDefinition(includeWait: boolean): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: { type: "string", pattern: "^command_[0-9a-f-]{36}$" },
      ...(includeWait
        ? { waitMs: { type: "integer", minimum: 0, maximum: 30_000 } }
        : {}),
    },
    required: ["commandId"],
  };
}

type CommandOperation = "run" | "start" | "poll" | "cancel";

function commandResult(
  output: CommandExecutionOutput,
  operation: CommandOperation,
  context: ToolContext,
): ToolExecutionResult {
  const cleanupUnsafe = output.status !== "running" && (output.lifecycle?.cleanup === "failed" || output.lifecycle?.cleanup === "unconfirmed");
  const outputLimited = output.status !== "running" && output.lifecycle?.outcome === "output_limit";
  const successful = !cleanupUnsafe && !outputLimited && (operation === "cancel"
    ? output.status === "canceled" || output.status === "exited" || output.status === "timed_out"
    : output.status === "running" || (output.status === "exited" && output.exitCode === 0 &&
        !(output.requestMetadata?.verificationKind && output.validation?.status === "failed")));
  const retryableSandboxFailure =
    output.status === "sandbox_unavailable" &&
    output.sandboxFailure?.retryable === true;
  const sandboxRecovery = retryableSandboxFailure
    ? (
        "This is a proven-not-started transient sandbox failure. You may resubmit " +
        `this exact ${operation === "start" ? "start_command" : "run_command"} once now; ` +
        "Runtime applies the configured startup retry budget; it never repeats the command itself. Do not mark the task permanently " +
        "blocked after this first failure."
      )
    : (
        "Do not automatically replay this command. Report the sandbox failure and execution uncertainty; " +
        "other independent work may continue. Child failure is reported to its parent without an automatic rerun."
      );
  const timeoutSummary = output.timeout
    ? `; ${formatCommandTimeoutBudget(output.timeout)}`
    : "";
  const boundary = output.status !== "running" ? output.sandboxBoundary : undefined;
  const boundarySummary = boundary
    ? boundary.action === "adjust_command"
      ? `The sandbox stopped this command at a known boundary (attempt ${boundary.attempt}). Cleanup is confirmed. Adjust paths or cache/temp environment to remain inside the workspace/sandbox, then submit a new command. Do not wrap or obfuscate the same operation to bypass enforcement.`
      : boundary.action === "approved_once" || boundary.action === "approved_prefix"
        ? `The sandbox stopped this command at a known boundary (attempt ${boundary.attempt}). The user approved ${boundary.action === "approved_once" ? "one exact host resubmission" : "the matching host permission prefix"}. Runtime did not replay the stopped command; submit the intended command again and the exact authorization will be applied.`
        : boundary.action === "benchmark_allow_once"
          ? `The benchmark sandbox stopped this command at a known boundary. Benchmark policy approved a new attempt inside the task container only; Runtime did not replay it and did not grant host or network escape.`
          : boundary.action === "rejected" || boundary.action === "benchmark_rejected"
            ? "The sandbox stopped this command at a known boundary and broader execution was rejected. Do not bypass or resubmit the same outside-sandbox operation."
            : "The sandbox stopped this command at a known boundary. Human approval is still required; no broader permission was granted and Runtime did not replay it."
    : undefined;
  const policyRecovery = output.policyDecision.recommendation
    ? ` Recovery: ${output.policyDecision.recommendation}`
    : "";
  const baseSummary = boundarySummary ?? (outputLimited ? "Command output exceeded the 32 MiB bridge limit. Cleanup and execution are reported separately; do not automatically rerun it."
    : output.status === "running"
    ? `Command ${output.commandId} is running; use poll_command with commandId and optional waitMs`
    : operation === "cancel" && output.status === "canceled"
      ? `Command ${output.commandId} canceled and its process tree terminated`
    : output.status === "policy_denied"
      ? `Command denied: ${output.policyDecision.reason}${policyRecovery}`
    : output.status === "sandbox_unavailable"
      ? `Command blocked because the OS sandbox is unavailable: ${output.stderr.text}. ` +
        `${output.lifecycle?.execution === "not_started" ? "The target process did not start." : "Execution may already have occurred; do not rerun automatically."} ${sandboxRecovery} ` +
        (retryableSandboxFailure
          ? ""
          : "Run `easy-code sandbox doctor` outside the agent.")
    : output.status === "spawn_failed"
      ? output.lifecycle?.execution === "not_started"
        ? `Command did not start: ${output.failure?.message ?? output.stderr.text}. Correct the executable or Windows launcher and submit a new command; Runtime did not replay it.`
        : `Command execution could not be confirmed: ${output.failure?.message ?? output.stderr.text}`
    : output.status === "timed_out"
      ? "Command timed out and its process tree was terminated"
    : output.status === "canceled"
      ? `Command ${output.commandId} canceled and its process tree terminated`
    : `Command exited with code ${output.exitCode}` +
      (output.requestMetadata?.verificationKind && output.validation
        ? `; validation ${output.validation.status}: ${output.validation.reason}` +
          (output.validation.standard?.status === "changed" ? "; original tests/configuration changed: this result cannot resolve the original failure" :
            output.validation.standard?.status === "unknown" ? "; original-test coverage was not established (report only the checks actually run)" : "") : ""));
  const summary = cleanupUnsafe
    ? `${baseSummary}; cleanup is not confirmed. Do not rerun the command. The execution environment is quarantined.${timeoutSummary}`
    : `${baseSummary}${timeoutSummary}`;
  return {
    ok: successful,
    summary,
    data: output,
    ...(cleanupUnsafe ? { failure: {
      version: 1 as const, kind: "execution" as const, code: "command_environment_quarantined",
      execution: "unknown" as const, recovery: "none" as const, issues: [],
      instruction: "Pause the task. Execution and cleanup are separate outcomes; repair and verify the environment outside the agent before resuming. Do not retry commands or start review experiments.",
    } } : boundary ? { failure: {
      version: 1 as const, kind: "execution" as const, code: "sandbox_boundary_violation",
      execution: "exited" as const,
      recovery: boundary.action === "adjust_command" || boundary.action === "benchmark_allow_once" ? "adjust_request" as const
        : boundary.action === "approved_once" || boundary.action === "approved_prefix" ? "resubmit_exact" as const : "none" as const,
      issues: [], instruction: boundarySummary!,
    } } : {}),
    ...(successful ? {} : { error: summary }),
  };
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
}

function commandToolFailure(
  error: unknown,
  summary: string,
  kind: CommandFailureKind,
  code: string,
): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    summary,
    error: message,
    data: {
      failure: {
        kind,
        code,
        message,
        processStarted: false,
        retryable: false,
      },
    },
  };
}

async function validateWorkspace(
  workspace: WorkspaceManager,
  context: ToolContext,
): Promise<ToolExecutionResult | undefined> {
  try {
    await assertMatchingWorkspace(workspace, context);
    return undefined;
  } catch (error) {
    return commandToolFailure(
      error,
      "Command Runtime rejected the tool context",
      "runtime",
      "workspace_context_mismatch",
    );
  }
}

export class RunCommandTool implements AgentTool {
  readonly name = "run_command" as const;
  readonly mutating = true;
  readonly inputSchema = runCommandInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, commandInvocationDefinition()),
    },
  };

  readonly runtime: CommandRuntime;

  constructor(private readonly workspace: WorkspaceManager, runtime?: CommandRuntime) {
    this.runtime = runtime ?? new CommandRuntime(workspace);
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const parsed = this.inputSchema.safeParse(input);
    if (!parsed.success) {
      return commandToolFailure(
        new Error(validationMessage(parsed.error)),
        "Invalid run_command parameters",
        "parameter",
        "invalid_parameters",
      );
    }
    const workspaceFailure = await validateWorkspace(this.workspace, context);
    if (workspaceFailure) return workspaceFailure;
    try {
      return commandResult(await this.runtime.run(parsed.data, context), "run", context);
    } catch (error) {
      return commandToolFailure(error, "Unable to run command", "runtime", "runtime_error");
    }
  }
}

export class StartCommandTool implements AgentTool {
  readonly name = "start_command" as const;
  readonly mutating = true;
  readonly inputSchema = startCommandInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, commandInvocationDefinition(true)),
    },
  };

  constructor(
    private readonly workspace: WorkspaceManager,
    readonly runtime: CommandRuntime,
  ) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const parsed = this.inputSchema.safeParse(input);
    if (!parsed.success) {
      return commandToolFailure(
        new Error(validationMessage(parsed.error)),
        "Invalid start_command parameters",
        "parameter",
        "invalid_parameters",
      );
    }
    const workspaceFailure = await validateWorkspace(this.workspace, context);
    if (workspaceFailure) return workspaceFailure;
    try {
      const { backgroundKind, ...request } = parsed.data;
      return commandResult(await this.runtime.start(request, context, backgroundKind), "start", context);
    } catch (error) {
      return commandToolFailure(error, "Unable to start command", "runtime", "runtime_error");
    }
  }

  /** Used by the mutation-lock wrapper to release a start lease on completion. */
  whenCommandSettled(commandId: string): Promise<void> | undefined {
    return this.runtime.whenSettled(commandId);
  }
}

export class PollCommandTool implements AgentTool {
  readonly name = "poll_command" as const;
  readonly mutating = false;
  readonly inputSchema = pollCommandInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, commandHandleDefinition(true)),
    },
  };

  constructor(
    private readonly workspace: WorkspaceManager,
    readonly runtime: CommandRuntime,
  ) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const parsed = this.inputSchema.safeParse(input);
    if (!parsed.success) {
      return commandToolFailure(
        new Error(validationMessage(parsed.error)),
        "Invalid poll_command parameters",
        "parameter",
        "invalid_parameters",
      );
    }
    const workspaceFailure = await validateWorkspace(this.workspace, context);
    if (workspaceFailure) return workspaceFailure;
    const request: PollCommandInput = parsed.data;
    try {
      const configuredWait = (context.limits ?? DEFAULT_RUNTIME_LIMITS).commandPollWaitMs;
      const deadline = Date.now() + Math.min(request.waitMs ?? configuredWait, configuredWait);
      let output: CommandExecutionOutput;
      do {
        output = await this.runtime.status(request.commandId, context, Math.max(0, Math.min(30000, deadline - Date.now())));
      } while (output.status === "running" && Date.now() < deadline && !context.waitSignal?.aborted && !context.signal?.aborted);
      return commandResult(output, "poll", context);
    } catch (error) {
      return commandToolFailure(error, "Unable to poll command", "runtime", "unknown_handle");
    }
  }
}

export class CancelCommandTool implements AgentTool {
  readonly name = "cancel_command" as const;
  readonly mutating = true;
  readonly inputSchema = cancelCommandInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, commandHandleDefinition(false)),
    },
  };

  constructor(
    private readonly workspace: WorkspaceManager,
    readonly runtime: CommandRuntime,
  ) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const parsed = this.inputSchema.safeParse(input);
    if (!parsed.success) {
      return commandToolFailure(
        new Error(validationMessage(parsed.error)),
        "Invalid cancel_command parameters",
        "parameter",
        "invalid_parameters",
      );
    }
    const workspaceFailure = await validateWorkspace(this.workspace, context);
    if (workspaceFailure) return workspaceFailure;
    const request: CancelCommandInput = parsed.data;
    try {
      return commandResult(
        await this.runtime.cancel(request.commandId, context),
        "cancel",
        context,
      );
    } catch (error) {
      return commandToolFailure(error, "Unable to cancel command", "runtime", "unknown_handle");
    }
  }
}
