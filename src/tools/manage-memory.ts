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
import { assertDurableMemory } from "../memory/admission.js";
import { displayTextSchema, projectText } from "../utils/bounded-text.js";
import { estimatedTokens } from "../context/token-budget.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { sha256 } from "../utils/hash.js";

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
  .min(MIN_MEMORY_CONTENT_CHARS);
const memoryReasonSchema = displayTextSchema(MAX_MEMORY_REASON_CHARS);
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

export function createManageMemoryInputSchema(limits = DEFAULT_RUNTIME_LIMITS) { return z.discriminatedUnion("action", [
  z.object({ action: z.literal("recall"), evidenceId: z.string().regex(/^(?:evidence_[a-f0-9]{64}|command_output_[a-f0-9]{64}|context_[a-f0-9]{48}|ev_[a-f0-9]{24}|journal_message_[0-9]+|journal_summary_[a-f0-9]{64})$/u),
    offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(limits.evidenceRecallMaxChars).optional() }).strict(),
  z
    .object({
      action: z.literal("search"),
      query: z.string().trim().min(1).max(MAX_MEMORY_SEARCH_CHARS),
      scope: z.enum(["long_term", "history"]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
      includeInactive: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("remember"),
      sourceRefs: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
      content: memoryContentSchema,
      category: memoryCategorySchema,
      reason: memoryReasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("revise"),
      sourceRefs: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
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
]); }
export const manageMemoryInputSchema = createManageMemoryInputSchema();

export type ManageMemoryInput = z.infer<typeof manageMemoryInputSchema>;

/**
 * Runtime/model-only memory surface. The CLI's /memory commands intentionally
 * use MemoryManager's read methods instead of exposing these mutations.
 */
export class ManageMemoryTool implements AgentTool {
  readonly name = "manage_memory" as const;
  readonly mutating = true;
  get inputSchema() { return createManageMemoryInputSchema(this.manager.limits); }
  get definition(): ToolDefinition { return {
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
            enum: ["search", "remember", "revise", "forget", "recall"],
          },
          query: {
            type: "string",
            minLength: 1,
            maxLength: MAX_MEMORY_SEARCH_CHARS,
          },
          limit: { type: "integer", minimum: 1, maximum: this.manager.limits.evidenceRecallMaxChars },
          evidenceId: { type: "string", pattern: "^(?:evidence_[a-f0-9]{64}|command_output_[a-f0-9]{64}|context_[a-f0-9]{48}|ev_[a-f0-9]{24}|journal_message_[0-9]+|journal_summary_[a-f0-9]{64})$" },
          scope: { type: "string", enum: ["long_term", "history"] },
          sourceRefs: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
          offset: { type: "integer", minimum: 0 },
          includeInactive: { type: "boolean" },
          memoryId: {
            type: "string",
            pattern: MEMORY_ID_PATTERN.source,
          },
          content: {
            type: "string",
            minLength: MIN_MEMORY_CONTENT_CHARS,
            maxLength: this.manager.limits.memoryContentMaxChars,
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
  }; }

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
      if (context.agentRole && context.agentRole !== "main_agent" &&
          parsed.action !== "search" && parsed.action !== "recall") {
        throw new Error("Only the main agent may propose long-term memory mutations");
      }
      const workspaceId = workspaceIdFromRoot(this.workspace.root);
      if (parsed.action === "remember" || parsed.action === "revise") {
        const limits = context.limits ?? DEFAULT_RUNTIME_LIMITS;
        // A prefix may omit qualifications: archive it as a historical preview,
        // not a durable fact or an applied revision. Do not ask the model to retry for length.
        if (parsed.content.length > limits.memoryContentMaxChars || estimatedTokens(parsed.content) > limits.maxDurableMemoryTokens) {
          this.assertSafeWrite(parsed.content, parsed.reason);
          const sourceRef = this.manager.evidenceStore.capture(workspaceId, context.threadId,
            `memory-preview:${context.turnId}:${sha256(parsed.content)}`, "manage_memory",
            { ok: false, summary: "Uncommitted memory proposal; not a verified fact", data: { content: parsed.content } });
          const preview = projectText(projectText(parsed.content, limits.memoryContentMaxChars).text,
            limits.maxDurableMemoryTokens, estimatedTokens);
          return toolSuccess("Length-only overflow archived as a lossy preview; no long-term fact or revision was committed. No retry is required.",
            { staged: false, committed: false, historical: true, truncated: true, sourceRef,
              content: preview.text, originalChars: parsed.content.length, retainedChars: preview.text.length });
        }
        assertDurableMemory(parsed.content, limits);
      }
      if (parsed.action === "recall") {
        return toolSuccess("Retrieved historical captured evidence; it does not establish current file or test state.",
          this.manager.evidenceStore.read(workspaceId, context.threadId, parsed.evidenceId, parsed.offset, parsed.limit));
      }

      if (parsed.action === "search") {
        if (
          containsSensitiveInformation(parsed.query) ||
          redactSensitiveInformation(parsed.query) !== parsed.query
        ) {
          throw new Error("Memory search queries must not contain sensitive information");
        }
        if (parsed.scope === "history") {
          if (!context.searchHistory) throw new Error("History search is unavailable in this Runtime profile");
          const evidence = await context.searchHistory(parsed.query, parsed.limit ?? 4);
          return toolSuccess("Historical previews only; use recall to expand a returned ID. History does not establish current state.",
            { evidence, count: evidence.length });
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
        this.assertSafeWrite(parsed.content, parsed.reason);
        this.assertPlanCategory(context, parsed.category);
        return {
          ok: true,
          summary:
            "The long-term memory proposal was staged and will be committed only if this turn completes successfully.",
          data: { staged: true, action: parsed.action },
          memoryMutation: {
            action: "remember",
            ...(parsed.sourceRefs ? { sourceRefs: parsed.sourceRefs } : {}),
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
            ...(parsed.sourceRefs ? { sourceRefs: parsed.sourceRefs } : {}),
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
