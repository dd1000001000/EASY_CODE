import { z } from "zod";
import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import { CommandRuntime } from "../command/runtime.js";
import type { RunCommandInput } from "../command/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace, toolFailure } from "./base.js";

export const runCommandInputSchema = z
  .object({
    program: z.string().min(1).max(4_096),
    args: z.array(z.string().max(16_384)).max(256).optional(),
    cwd: z.string().min(1).max(4_096).optional(),
    intent: z.enum(["inspect", "build", "test", "run", "install"]),
    timeoutMs: z.number().int().positive().optional(),
    reason: z.string().max(2_000).optional(),
  })
  .strict();

export class RunCommandTool implements AgentTool {
  readonly name = "run_command" as const;
  readonly mutating = true;
  readonly inputSchema = runCommandInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      description:
        "Run one structured program/argv command. Manual and auto-approved modes use Runtime policy plus the Anthropic workspace sandbox. User-confirmed dangerous mode runs directly as the current OS user with host filesystem, working-directory, environment, and internet access and no EASY CODE approval prompt. Explicit one-shot shells remain supported.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          program: {
            type: "string",
            description:
              "Executable name or workspace-relative executable; absolute host executables require dangerous mode",
          },
          args: { type: "array", items: { type: "string" }, maxItems: 256 },
          cwd: {
            type: "string",
            description:
              "Workspace-relative existing directory, or an absolute host directory only in dangerous mode",
          },
          intent: { type: "string", enum: ["inspect", "build", "test", "run", "install"] },
          timeoutMs: { type: "integer", minimum: 1 },
          reason: { type: "string" },
        },
        required: ["program", "intent"],
      },
    },
  };

  readonly runtime: CommandRuntime;

  constructor(private readonly workspace: WorkspaceManager, runtime?: CommandRuntime) {
    this.runtime = runtime ?? new CommandRuntime(workspace);
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      const parsed = this.inputSchema.parse(input) as RunCommandInput;
      const output = await this.runtime.run(parsed, context);
      const successful =
        output.status === "exited" &&
        output.exitCode === 0 &&
        output.workspaceDelta.deleted.length === 0;
      const summary = output.status === "policy_denied"
        ? `Command denied: ${output.policyDecision.reason}`
        : output.status === "sandbox_unavailable"
          ? `Command blocked because the OS sandbox is unavailable: ${output.stderr.text}`
        : output.status === "exited"
          ? `Command exited with code ${output.exitCode}`
          : `Command ${output.status.replace(/_/gu, " ")}`;
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
}
