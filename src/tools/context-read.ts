import { z } from "zod";
import type { AgentTool, ToolContext, ToolDefinition } from "../core/types.js";
import { toolFailure, toolSuccess } from "./base.js";
import { documentToolSchema } from "./metadata.js";

export const recallContextSchema = z.object({ evidenceId: z.string().min(1).max(160),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(16000).default(8000),
}).strict();

export class RecallContextTool implements AgentTool {
  readonly name = "recall_context" as const;
  readonly mutating = false;
  readonly inputSchema = recallContextSchema;
  readonly definition: ToolDefinition = { type: "function", function: { name: this.name,
    ...documentToolSchema(this.name, { type: "object", additionalProperties: false,
      properties: { evidenceId: { type: "string", minLength: 1, maxLength: 160 },
        offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16000 } }, required: ["evidenceId"] }) } };
  async execute(input: unknown, context: ToolContext) {
    try {
      const value = this.inputSchema.parse(input);
      if (!context.recallContext) throw new Error("Context recall unavailable in this Runtime profile");
      return await context.recallContext(value);
    } catch (error) { return toolFailure(error, "Unable to recall historical evidence"); }
  }
}

export class SearchContextTool implements AgentTool {
  readonly name = "search_context" as const;
  readonly mutating = false;
  readonly inputSchema = z.object({ query: z.string().trim().min(1).max(500),
    scope: z.enum(["history", "long_term"]).default("history"),
    limit: z.number().int().min(1).max(20).default(6) }).strict();
  readonly definition: ToolDefinition = { type: "function", function: { name: this.name,
    ...documentToolSchema(this.name, { type: "object", additionalProperties: false,
      properties: { query: { type: "string", minLength: 1, maxLength: 500 },
        scope: { type: "string", enum: ["history", "long_term"] },
        limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] }) } };
  async execute(input: unknown, context: ToolContext) {
    try {
      const value = this.inputSchema.parse(input);
      if (value.scope === "long_term") {
        if (!context.searchProjectMemory) throw new Error("Project memory unavailable");
        return toolSuccess("Read-only project memory; check relevance and source version before relying on it.",
          { memories: (await context.searchProjectMemory(value.query)).slice(0, value.limit) });
      }
      if (!context.searchHistory) throw new Error("Thread history search unavailable");
      return toolSuccess("Historical evidence previews. Recall an ID for detail; these are not current file observations.",
        { evidence: await context.searchHistory(value.query, value.limit) });
    } catch (error) { return toolFailure(error, "Unable to search context"); }
  }
}
