import { z } from "zod";
import type { AgentTool, ToolContext, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { truncateSubagentMessage } from "../subagents/types.js";
import type { SubagentParentMessage } from "../subagents/types.js";
import { toolFailure } from "./base.js";
import { documentToolSchema } from "./metadata.js";

export interface ParentMessageBinding {
  agentId: string;
  childThreadId: string;
  parentThreadId: string;
  taskId: string;
  taskTitle: string;
}

export class SendParentMessageTool implements AgentTool {
  readonly name = "send_parent_message" as const;
  readonly mutating = true;
  readonly inputSchema;

  constructor(
    private readonly binding: ParentMessageBinding,
    private readonly post: (message: Omit<SubagentParentMessage, "id" | "createdAt">,
      childThreadId: string, toolCallId: string) => SubagentParentMessage,
    maximum = DEFAULT_RUNTIME_LIMITS.subagentParentMessageMaxChars,
  ) {
    this.inputSchema = z.object({
      message: z.string().transform((value) => truncateSubagentMessage(value, maximum))
        .pipe(z.string().min(1).max(maximum)),
    }).strict();
  }

  get definition(): ToolDefinition { return {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, {
        type: "object",
        additionalProperties: false,
        properties: { message: { type: "string", minLength: 1 } },
        required: ["message"],
      }),
    },
  }; }

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      if (context.agentRole !== "subagent" ||
          context.agentId !== this.binding.agentId ||
          context.threadId !== this.binding.childThreadId ||
          context.assignedTaskId !== this.binding.taskId || !context.toolCallId) {
        throw new Error("Only the bound child may message its parent");
      }
      const { message } = this.inputSchema.parse(input);
      const posted = this.post({
        agentId: this.binding.agentId,
        taskId: this.binding.taskId,
        taskTitle: this.binding.taskTitle,
        text: message,
      }, this.binding.childThreadId, context.toolCallId);
      return {
        ok: true,
        summary: `Sent an update to the parent for task ${this.binding.taskId}.`,
        data: { messageId: posted.id, delivery: "next_parent_model_boundary" },
      };
    } catch (error) {
      return toolFailure(error, "Unable to send a parent message");
    }
  }
}
