import { z } from "zod";
import { MAX_CONTEXT_SUMMARY_CHARS } from "../context/manager.js";
import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { toolFailure } from "./base.js";
import { documentToolSchema } from "./metadata.js";

export const compactContextInputSchema = z
  .object({
    summary: z.string().trim().min(1).max(MAX_CONTEXT_SUMMARY_CHARS),
  })
  .strict();

export type CompactContextInput = z.infer<typeof compactContextInputSchema>;

/** Runtime-owned tool: it proposes a summary but never edits workspace files or history. */
export class CompactContextTool implements AgentTool {
  readonly name = "compact_context" as const;
  readonly mutating = false;
  readonly inputSchema = compactContextInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: {
            type: "string",
            minLength: 1,
            maxLength: MAX_CONTEXT_SUMMARY_CHARS,
          },
        },
        required: ["summary"],
      }),
    },
  };

  async execute(input: unknown, _context: ToolContext): Promise<ToolExecutionResult> {
    try {
      const parsed = this.inputSchema.parse(input);
      const summary = redactSensitiveInformation(parsed.summary);
      return {
        ok: true,
        summary: "The cumulative context summary was accepted.",
        data: { summaryChars: summary.length },
        contextCompaction: { summary },
      };
    } catch (error) {
      return toolFailure(error, "Unable to compact context");
    }
  }
}
