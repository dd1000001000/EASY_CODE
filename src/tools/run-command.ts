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

const commandInvocationSchema = z
  .object({
    program: z.string().min(1).max(4_096),
    args: z.array(z.string().max(16_384)).max(256).optional(),
    cwd: z.string().min(1).max(4_096).optional(),
    intent: z.enum(COMMAND_INTENTS),
    verificationKind: z.unknown().optional(),
    timeoutMs: z.number().int().positive().optional(),
    reason: z.string().max(2_000).optional(),
    executionScope: z.enum(["workspace", "host"]).optional(),
  })
  .strict()
  .transform(normalizeCommandRequest);

const commandHandleSchema = z.string().regex(/^command_[0-9a-f-]{36}$/u);

export const runCommandInputSchema = commandInvocationSchema;
export const startCommandInputSchema = commandInvocationSchema;
export const pollCommandInputSchema = z.object({
  commandId: commandHandleSchema,
  waitMs: z.number().int().min(0).max(30_000).optional(),
}).strict();
export const cancelCommandInputSchema = z.object({
  commandId: commandHandleSchema,
}).strict();

function commandInvocationDefinition(): Record<string, unknown> {
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
  const successful = !cleanupUnsafe && (operation === "cancel"
    ? output.status === "canceled" || output.status === "exited" || output.status === "timed_out"
    : output.status === "running" || (output.status === "exited" && output.exitCode === 0 &&
        !(output.requestMetadata?.verificationKind && output.validation?.status === "failed")));
  const retryableSandboxFailure =
    output.status === "sandbox_unavailable" &&
    output.sandboxFailure?.retryable === true;
  const sandboxRecovery = retryableSandboxFailure
    ? (
        "This appears to be a transient Windows SRT initialization/ACL failure. Retry " +
        `this exact ${operation === "start" ? "start_command" : "run_command"} once now; ` +
        "Runtime permits only that bounded recovery attempt. Do not mark the task permanently " +
        "blocked after this first failure."
      )
    : context.agentRole === "subagent"
    ? (
        "Do not retry a command-starting tool in this turn. Continue file work if possible; " +
        "otherwise submit a blocked child result naming the transient sandbox condition so " +
        "the parent can requeue the assignment."
      )
    : (
        "Do not retry a command-starting tool in this turn and do not persistently block a DAG " +
        "task solely for this transient failure. Continue with file tools or return a plain-text " +
        "pause report; Runtime re-enables commands next turn."
      );
  const timeoutSummary = output.timeout
    ? `; ${formatCommandTimeoutBudget(output.timeout)}`
    : "";
  const policyRecovery = output.policyDecision.recommendation
    ? ` Recovery: ${output.policyDecision.recommendation}`
    : "";
  const baseSummary = output.status === "running"
    ? `Command ${output.commandId} is running; use poll_command with commandId and optional waitMs`
    : operation === "cancel" && output.status === "canceled"
      ? `Command ${output.commandId} canceled and its process tree terminated`
    : output.status === "policy_denied"
      ? `Command denied: ${output.policyDecision.reason}${policyRecovery}`
    : output.status === "sandbox_unavailable"
      ? `Command blocked because the OS sandbox is unavailable: ${output.stderr.text}. ` +
        `${output.failure?.processStarted ? "Execution may already have occurred; do not rerun automatically." : "The target process did not start."} ${sandboxRecovery} ` +
        (retryableSandboxFailure
          ? ""
          : "Run `easy-code sandbox doctor` outside the agent.")
    : output.status === "spawn_failed"
      ? `Command execution could not be confirmed: ${output.failure?.message ?? output.stderr.text}`
    : output.status === "timed_out"
      ? "Command timed out and its process tree was terminated"
    : output.status === "canceled"
      ? `Command ${output.commandId} canceled and its process tree terminated`
    : `Command exited with code ${output.exitCode}` +
      (output.requestMetadata?.verificationKind && output.validation
        ? `; validation ${output.validation.status}: ${output.validation.reason}` +
          (output.validation.standard?.status === "changed" ? "; original tests/configuration changed: this result cannot resolve the original failure" :
            output.validation.standard?.status === "unknown" ? "; testing-standard coverage is incomplete: no verified recovery can be claimed" : "") : "");
  const summary = cleanupUnsafe
    ? `Command outcome retained (exit=${output.exitCode}); cleanup is not confirmed. Do not rerun the command. The execution environment is quarantined.${timeoutSummary}`
    : `${baseSummary}${timeoutSummary}`;
  return {
    ok: successful,
    summary,
    data: output,
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
      ...documentToolSchema(this.name, commandInvocationDefinition()),
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
      return commandResult(await this.runtime.start(parsed.data, context), "start", context);
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
