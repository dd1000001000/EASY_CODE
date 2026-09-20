import { z } from "zod";
import type { AgentTool, ToolContext, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import { ThreadTitleStore } from "../threads/thread-title.js";
import { toolFailure, toolSuccess } from "./base.js";
import { documentToolSchema } from "./metadata.js";

export const nameThreadInputSchema = z.object({ title: z.string().min(1).max(120) }).strict();

/** Names only the current main-agent Thread, never a model-selected Thread ID. */
export class NameThreadTool implements AgentTool {
  readonly name = "name_thread" as const;
  readonly mutating = false; // No project-file or command-environment mutation.
  readonly inputSchema = nameThreadInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "name_thread",
      strict: true,
      ...documentToolSchema("name_thread", {
        type: "object", additionalProperties: false,
        properties: { title: { type: "string", minLength: 1, maxLength: 120 } },
        required: ["title"],
      }),
    },
  };

  constructor(private readonly titles: ThreadTitleStore) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      if (context.agentRole === "subagent") throw new Error("Only the main agent can name a Thread.");
      const { title } = this.inputSchema.parse(input);
      if (!this.titles.claim(context.threadId, title)) {
        return { ok: false, summary: "Thread already has a title; it cannot be renamed again.",
          error: "thread_title_already_claimed" };
      }
      return toolSuccess("Named the current Thread.", { title: title.trim() });
    } catch (error) {
      return toolFailure(error, "Unable to name the current Thread");
    }
  }
}
