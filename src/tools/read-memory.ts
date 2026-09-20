import { z } from "zod";

import type {
  AgentTool,
  LongTermMemory,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import { MAX_MEMORY_SEARCH_CHARS } from "../memory/memory-manager.js";
import {
  containsSensitiveInformation,
  redactSensitiveInformation,
} from "../memory/sensitive.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace, toolFailure, toolSuccess } from "./base.js";
import { documentToolSchema } from "./metadata.js";
import type { MemoryToolSession } from "./memory-tool-session.js";

const MAX_MEMORY_RESULTS = 20;

function memoryForModel(memory: Readonly<LongTermMemory>): object {
  return {
    id: memory.id,
    scope: memory.scope,
    category: memory.category,
    content: memory.content,
    confidence: memory.confidence,
    status: memory.status,
    updatedAt: memory.updatedAt,
  };
}

export const readMemoryInputSchema = z.object({
  query: z.string().trim().min(1).max(MAX_MEMORY_SEARCH_CHARS),
  limit: z.number().int().min(1).max(MAX_MEMORY_RESULTS).default(6),
  scope: z.enum(["all", "global", "project"]).default("all"),
  includeInactive: z.boolean().default(false),
}).strict();

export type ReadMemoryInput = z.infer<typeof readMemoryInputSchema>;

/** Read-only search of durable workspace memory. */
export class ReadMemoryTool implements AgentTool {
  readonly name = "read_memory" as const;
  readonly mutating = false;
  readonly inputSchema = readMemoryInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: MAX_MEMORY_SEARCH_CHARS,
          },
          limit: { type: "integer", minimum: 1, maximum: MAX_MEMORY_RESULTS },
          scope: { type: "string", enum: ["all", "global", "project"] },
          includeInactive: { type: "boolean" },
        },
        required: ["query"],
      }),
    },
  };

  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly session: MemoryToolSession,
  ) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      const parsed = this.inputSchema.parse(input);
      if (
        containsSensitiveInformation(parsed.query) ||
        redactSensitiveInformation(parsed.query) !== parsed.query
      ) {
        throw new Error("Memory search queries must not contain sensitive information");
      }
      if (!context.searchProjectMemory) {
        throw new Error("Project memory is unavailable in this Runtime profile");
      }
      const memories = (await context.searchProjectMemory(parsed.query, {
        limit: parsed.limit,
        scope: parsed.scope,
        includeInactive: parsed.includeInactive,
      })).slice(0, parsed.limit);
      this.session.record(context.turnId, memories.map((memory) => memory.id));
      return toolSuccess(`Found ${memories.length} long-term memories.`, {
        memories: memories.map(memoryForModel),
        count: memories.length,
      });
    } catch (error) {
      return toolFailure(error, "Unable to read long-term memory");
    }
  }
}
