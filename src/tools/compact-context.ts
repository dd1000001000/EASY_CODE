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
      description:
        "Replace all conversation context through this tool call with one cumulative, self-contained summary. Call this tool alone after a meaningful milestone or when context is growing. Preserve the current objective, user constraints, key decisions, verified findings, relevant files and symbols, commands and test results, unresolved blockers, and exact next steps. The original audit history remains stored locally.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: {
            type: "string",
            minLength: 1,
            maxLength: MAX_CONTEXT_SUMMARY_CHARS,
            description:
              "A replacement cumulative summary of everything still needed to continue correctly. Do not include secrets.",
          },
        },
        required: ["summary"],
      },
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
