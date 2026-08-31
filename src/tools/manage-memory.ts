import { z } from "zod";
import type {
  AgentTool,
  LongTermMemory,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import {
  MAX_MEMORY_CONTENT_CHARS,
  MAX_MEMORY_REASON_CHARS,
  MAX_MEMORY_SEARCH_CHARS,
  MEMORY_ID_PATTERN,
  MIN_MEMORY_CONTENT_CHARS,
  type MemoryManager,
} from "../memory/memory-manager.js";
import {
  containsSensitiveInformation,
  redactSensitiveInformation,
} from "../memory/sensitive.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import {
  assertMatchingWorkspace,
  toolFailure,
  toolSuccess,
} from "./base.js";
import { documentToolSchema } from "./metadata.js";

const memoryCategorySchema = z.enum([
  "preference",
  "convention",
  "architecture",
  "decision",
  "environment",
]);
const memoryContentSchema = z
  .string()
  .trim()
  .min(MIN_MEMORY_CONTENT_CHARS)
  .max(MAX_MEMORY_CONTENT_CHARS);
const memoryReasonSchema = z.string().trim().min(1).max(MAX_MEMORY_REASON_CHARS);
const memoryIdSchema = z.string().trim().regex(MEMORY_ID_PATTERN);
const tentativeMemory = /(?:可能|也许|猜测|未验证|perhaps|maybe|might|unverified)/iu;
const MAX_SEARCHED_MEMORY_IDS_PER_TURN = 100;

function memoryForModel(memory: Readonly<LongTermMemory>): object {
  return {
    id: memory.id,
    category: memory.category,
    content: memory.content,
    confidence: memory.confidence,
    status: memory.status,
    updatedAt: memory.updatedAt,
  };
}

export const manageMemoryInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("search"),
      query: z.string().trim().min(1).max(MAX_MEMORY_SEARCH_CHARS),
      limit: z.number().int().min(1).max(20).optional(),
      includeInactive: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("remember"),
      content: memoryContentSchema,
      category: memoryCategorySchema,
      reason: memoryReasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("revise"),
      memoryId: memoryIdSchema,
      content: memoryContentSchema,
      category: memoryCategorySchema.optional(),
      reason: memoryReasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("forget"),
      memoryId: memoryIdSchema,
      reason: memoryReasonSchema,
    })
    .strict(),
]);

export type ManageMemoryInput = z.infer<typeof manageMemoryInputSchema>;

/**
 * Runtime/model-only memory surface. The CLI's /memory commands intentionally
 * use MemoryManager's read methods instead of exposing these mutations.
 */
export class ManageMemoryTool implements AgentTool {
  readonly name = "manage_memory" as const;
  readonly mutating = true;
  readonly inputSchema = manageMemoryInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["search", "remember", "revise", "forget"],
          },
          query: {
            type: "string",
            minLength: 1,
            maxLength: MAX_MEMORY_SEARCH_CHARS,
          },
          limit: { type: "integer", minimum: 1, maximum: 20 },
          includeInactive: { type: "boolean" },
          memoryId: {
            type: "string",
            pattern: MEMORY_ID_PATTERN.source,
          },
          content: {
            type: "string",
            minLength: MIN_MEMORY_CONTENT_CHARS,
            maxLength: MAX_MEMORY_CONTENT_CHARS,
          },
          category: {
            type: "string",
            enum: ["preference", "convention", "architecture", "decision", "environment"],
          },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: MAX_MEMORY_REASON_CHARS,
          },
        },
        required: ["action"],
      }),
    },
  };

  constructor(
    private readonly manager: MemoryManager,
    private readonly workspace: WorkspaceManager,
  ) {}

  private searched = false;
  private activeTurnId: string | undefined;
  private readonly searchedMemoryIds = new Set<string>();

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      this.beginTurn(context.turnId);
      const parsed = this.inputSchema.parse(input);
      const workspaceId = workspaceIdFromRoot(this.workspace.root);

      if (parsed.action === "search") {
        if (
          containsSensitiveInformation(parsed.query) ||
          redactSensitiveInformation(parsed.query) !== parsed.query
        ) {
          throw new Error("Memory search queries must not contain sensitive information");
        }
        const exact = MEMORY_ID_PATTERN.test(parsed.query)
          ? this.manager.get(workspaceId, parsed.query)
          : undefined;
        const memories = exact
          ? exact.status === "active" || parsed.includeInactive === true
            ? [exact]
            : []
          : await this.manager.searchHybrid(workspaceId, parsed.query, {
              limit: parsed.limit,
              includeInactive: parsed.includeInactive,
            });
        this.searched = true;
        for (const memory of memories) {
          if (
            !this.searchedMemoryIds.has(memory.id) &&
            this.searchedMemoryIds.size >= MAX_SEARCHED_MEMORY_IDS_PER_TURN
          ) {
            const oldest = this.searchedMemoryIds.values().next().value as string | undefined;
            if (oldest) this.searchedMemoryIds.delete(oldest);
          }
          this.searchedMemoryIds.add(memory.id);
        }
        return toolSuccess(`Found ${memories.length} long-term memories.`, {
          memories: memories.map(memoryForModel),
          count: memories.length,
        });
      }

      if (parsed.action === "remember") {
        this.assertSearched();
        this.assertSafeWrite(parsed.content, parsed.reason);
        this.assertPlanCategory(context, parsed.category);
        return {
          ok: true,
          summary:
            "The long-term memory proposal was staged and will be committed only if this turn completes successfully.",
          data: { staged: true, action: parsed.action },
          memoryMutation: {
            action: "remember",
            content: parsed.content,
            category: parsed.category,
            reason: parsed.reason,
          },
        };
      }

      this.assertSearchedMemoryId(parsed.memoryId);
      const existing = this.manager.get(workspaceId, parsed.memoryId);
      if (!existing) {
        throw new Error("Long-term memory was not found in this workspace");
      }

      if (parsed.action === "revise") {
        const category = parsed.category ?? existing.category;
        this.assertSafeWrite(parsed.content, parsed.reason);
        this.assertPlanCategory(context, category);
        return {
          ok: true,
          summary:
            `Revision of long-term memory ${parsed.memoryId} was staged and will commit only if this turn succeeds.`,
          data: { staged: true, action: parsed.action, memoryId: parsed.memoryId },
          memoryMutation: {
            action: "revise",
            memoryId: parsed.memoryId,
            content: parsed.content,
            category,
            reason: parsed.reason,
          },
        };
      }

      this.assertSafeWrite(undefined, parsed.reason);
      this.assertPlanCategory(context, existing.category);
      return {
        ok: true,
        summary:
          `Expiration of long-term memory ${parsed.memoryId} was staged and will commit only if this turn succeeds.`,
        data: { staged: true, action: parsed.action, memoryId: parsed.memoryId },
        memoryMutation: {
          action: "forget",
          memoryId: parsed.memoryId,
          reason: parsed.reason,
        },
      };
    } catch (error) {
      return toolFailure(error, "Unable to manage long-term memory");
    }
  }

  private assertSearched(): void {
    if (!this.searched) {
      throw new Error("Search long-term memory before proposing a memory change");
    }
  }

  private beginTurn(turnId: string): void {
    if (this.activeTurnId === turnId) return;
    this.activeTurnId = turnId;
    this.searched = false;
    this.searchedMemoryIds.clear();
  }

  private assertSearchedMemoryId(memoryId: string): void {
    this.assertSearched();
    if (!this.searchedMemoryIds.has(memoryId)) {
      throw new Error(
        "revise and forget require a memory ID returned by manage_memory search in this turn",
      );
    }
  }

  private assertSafeWrite(content: string | undefined, reason: string): void {
    if (
      (content !== undefined && (
        containsSensitiveInformation(content) ||
        redactSensitiveInformation(content) !== content
      )) ||
      containsSensitiveInformation(reason) ||
      redactSensitiveInformation(reason) !== reason
    ) {
      throw new Error("Sensitive information cannot be staged as long-term memory");
    }
    if (
      (content !== undefined && tentativeMemory.test(content)) ||
      tentativeMemory.test(reason)
    ) {
      throw new Error("Tentative or unverified evidence cannot be staged as long-term memory");
    }
  }

  private assertPlanCategory(
    context: ToolContext,
    category: "preference" | "convention" | "architecture" | "decision" | "environment",
  ): void {
    if (
      context.mode === "plan" &&
      category !== "preference" &&
      category !== "convention"
    ) {
      throw new Error(
        "Plan mode may maintain preference and convention memories only; repository facts require completed work",
      );
    }
  }
}
