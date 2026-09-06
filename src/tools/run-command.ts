import { z } from "zod";
import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import { CommandRuntime } from "../command/runtime.js";
import { formatCommandTimeoutBudget } from "../command/timeout.js";
import type {
  CommandExecutionOutput,
  RunCommandInput,
  RunCommandToolInput,
} from "../command/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace, toolFailure } from "./base.js";
import { documentToolSchema } from "./metadata.js";

const commandInvocationSchema = z
  .object({
    program: z.string().min(1).max(4_096),
    args: z.array(z.string().max(16_384)).max(256).optional(),
    cwd: z.string().min(1).max(4_096).optional(),
    intent: z.enum(["inspect", "build", "test", "run", "install"]),
    timeoutMs: z.number().int().positive().optional(),
    reason: z.string().max(2_000).optional(),
  })
  .strict();

const commandHandleSchema = z.string().regex(/^command_[0-9a-f-]{36}$/u);

function commandInvocationProperties(): Record<string, unknown> {
  return {
    program: { type: "string", minLength: 1, maxLength: 4_096 },
    args: {
      type: "array",
      items: { type: "string", maxLength: 16_384 },
      maxItems: 256,
    },
    cwd: { type: "string", minLength: 1, maxLength: 4_096 },
    intent: { type: "string", enum: ["inspect", "build", "test", "run", "install"] },
    timeoutMs: { type: "integer", minimum: 1 },
    reason: { type: "string", maxLength: 2_000 },
  };
}

function commandInvocationDefinition(action?: "run" | "start"): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...(action
        ? { action: { type: "string", enum: [action] } }
        : {}),
      ...commandInvocationProperties(),
    },
    required: action ? ["action", "program", "intent"] : ["program", "intent"],
  };
}

export const runCommandInputSchema = z.union([
  commandInvocationSchema.extend({ action: z.literal("run") }).strict(),
  commandInvocationSchema.extend({ action: z.literal("start") }).strict(),
  z.object({
    action: z.literal("status"),
    commandId: commandHandleSchema,
    waitMs: z.number().int().min(0).max(30_000).optional(),
  }).strict(),
  z.object({
    action: z.literal("cancel"),
    commandId: commandHandleSchema,
  }).strict(),
  // Compatibility for callers using the original 1.0 synchronous contract.
  commandInvocationSchema,
]);

export class RunCommandTool implements AgentTool {
  readonly name = "run_command" as const;
  readonly mutating = true;
  readonly inputSchema = runCommandInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, {
        oneOf: [
          commandInvocationDefinition(),
          commandInvocationDefinition("run"),
          commandInvocationDefinition("start"),
          {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", enum: ["status"] },
              commandId: {
                type: "string",
                pattern: "^command_[0-9a-f-]{36}$",
              },
              waitMs: { type: "integer", minimum: 0, maximum: 30_000 },
            },
            required: ["action", "commandId"],
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", enum: ["cancel"] },
              commandId: {
                type: "string",
                pattern: "^command_[0-9a-f-]{36}$",
              },
            },
            required: ["action", "commandId"],
          },
        ],
      }),
    },
  };

  readonly runtime: CommandRuntime;

  constructor(private readonly workspace: WorkspaceManager, runtime?: CommandRuntime) {
    this.runtime = runtime ?? new CommandRuntime(workspace);
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      const parsed = this.inputSchema.parse(input) as RunCommandToolInput;
      const action = parsed.action ?? "run";
      let output: CommandExecutionOutput;
      if (parsed.action === "status") {
        output = await this.runtime.status(parsed.commandId, context, parsed.waitMs);
      } else if (parsed.action === "cancel") {
        output = await this.runtime.cancel(parsed.commandId, context);
      } else {
        const { action: _action, ...invocation } = parsed as RunCommandInput & {
          action?: "run" | "start";
        };
        output = action === "start"
          ? await this.runtime.start(invocation, context)
          : await this.runtime.run(invocation, context);
      }
      const successful = action === "cancel"
        ? output.status === "canceled" || output.status === "exited" || output.status === "timed_out"
        : output.status === "running" ||
          (output.status === "exited" &&
            output.exitCode === 0 &&
            output.workspaceDelta.deleted.length === 0);
      const retryableSandboxFailure =
        output.status === "sandbox_unavailable" &&
        output.sandboxFailure?.retryable === true;
      const sandboxRecovery = retryableSandboxFailure
        ? (
            "This appears to be a transient Windows SRT initialization/ACL failure. Retry " +
            "this exact command once now; Runtime permits only that bounded recovery attempt. " +
            "Do not mark the task permanently blocked after this first failure."
          )
        : context.agentRole === "subagent"
        ? (
            "Do not retry run_command in this turn. Continue file work if possible; otherwise " +
            "submit a blocked child result naming the transient sandbox condition so the parent " +
            "can requeue the assignment."
          )
        : (
            "Do not retry run_command in this turn and do not persistently block a DAG task " +
            "solely for this transient failure. Continue with file tools or return a plain-text " +
            "pause report; Runtime re-enables commands next turn."
          );
      const timeoutSummary = output.timeout
        ? `; ${formatCommandTimeoutBudget(output.timeout)}`
        : "";
      const policyRecovery = output.policyDecision.recommendation
        ? ` Recovery: ${output.policyDecision.recommendation}`
        : "";
      const baseSummary = output.status === "running"
        ? `Command ${output.commandId} is running; use action=status with commandId and optional waitMs`
        : action === "cancel" && output.status === "canceled"
          ? `Command ${output.commandId} canceled`
        : output.status === "policy_denied"
        ? `Command denied: ${output.policyDecision.reason}${policyRecovery}`
        : output.status === "sandbox_unavailable"
          ? `Command blocked because the OS sandbox is unavailable: ${output.stderr.text}. ` +
            `The command did not start. ${sandboxRecovery} ` +
            (retryableSandboxFailure
              ? ""
              : "Run `easy-code sandbox doctor` outside the agent.")
        : output.status === "exited"
          ? `Command exited with code ${output.exitCode}`
          : `Command ${output.status.replace(/_/gu, " ")}`;
      const summary = `${baseSummary}${timeoutSummary}`;
      return {
        ok: successful,
        summary,
        data: output,
        ...(successful ? {} : { error: summary }),
      };
    } catch (error) {
      return toolFailure(error, "Unable to run command");
    }
  }

  /** Used by the mutation-lock wrapper to release a start lease on completion. */
  whenCommandSettled(commandId: string): Promise<void> | undefined {
    return this.runtime.whenSettled(commandId);
  }
}
