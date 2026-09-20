import { z } from "zod";

import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { estimatedTokens } from "../context/token-budget.js";
import { assertDurableMemory } from "../memory/admission.js";
import {
  MAX_MEMORY_REASON_CHARS,
  MEMORY_ID_PATTERN,
  MIN_MEMORY_CONTENT_CHARS,
  type MemoryManager,
} from "../memory/memory-manager.js";
import {
  containsSensitiveInformation,
  redactSensitiveInformation,
} from "../memory/sensitive.js";
import { projectMemoryIdFromRoot } from "../memory/memory-manager.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { displayTextSchema, projectText } from "../utils/bounded-text.js";
import { sha256 } from "../utils/hash.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace, toolFailure, toolSuccess } from "./base.js";
import { documentToolSchema } from "./metadata.js";
import type { MemoryToolSession } from "./memory-tool-session.js";

const memoryCategorySchema = z.enum([
  "preference",
  "convention",
  "architecture",
  "decision",
  "environment",
]);
const memoryContentSchema = z.string().trim().min(MIN_MEMORY_CONTENT_CHARS);
const memoryReasonSchema = displayTextSchema(MAX_MEMORY_REASON_CHARS);
const memoryIdSchema = z.string().trim().regex(MEMORY_ID_PATTERN);

/**
 * A deliberately flat write-only schema. Operation-specific required fields
 * are checked inside the tool so provider schemas never need oneOf support.
 * Harmless write-side fields may be present for another operation and are
 * ignored; read-side fields remain unknown and are rejected before execution.
 */
export const writeMemoryInputSchema = z.object({
  operation: z.enum(["remember", "revise", "forget", "move"]),
  scope: z.enum(["global", "project"]).optional(),
  sourceRefs: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
  memoryId: memoryIdSchema.optional(),
  content: memoryContentSchema.optional(),
  category: memoryCategorySchema.optional(),
  reason: memoryReasonSchema,
}).strict();

export type WriteMemoryInput = z.infer<typeof writeMemoryInputSchema>;

/** Runtime/model-only mutation surface; CLI /memory commands remain read-only. */
export class WriteMemoryTool implements AgentTool {
  readonly name = "write_memory" as const;
  readonly mutating = true;
  readonly inputSchema = writeMemoryInputSchema;
  get definition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        strict: true,
        ...documentToolSchema(this.name, {
          type: "object",
          additionalProperties: false,
          properties: {
            operation: {
              type: "string",
              enum: ["remember", "revise", "forget", "move"],
            },
            scope: { type: "string", enum: ["global", "project"] },
            sourceRefs: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: { type: "string" },
            },
            memoryId: { type: "string", pattern: MEMORY_ID_PATTERN.source },
            content: {
              type: "string",
              minLength: MIN_MEMORY_CONTENT_CHARS,
              maxLength: this.manager.limits.memoryContentMaxChars,
            },
            category: {
              type: "string",
              enum: [
                "preference",
                "convention",
                "architecture",
                "decision",
                "environment",
              ],
            },
            reason: {
              type: "string",
              minLength: 1,
              maxLength: MAX_MEMORY_REASON_CHARS,
            },
          },
          required: ["operation", "reason"],
        }),
      },
    };
  }

  constructor(
    private readonly manager: MemoryManager,
    private readonly workspace: WorkspaceManager,
    private readonly session: MemoryToolSession,
  ) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      await assertMatchingWorkspace(this.workspace, context);
      if (context.agentRole && context.agentRole !== "main_agent") {
        throw new Error("Only the main agent may propose long-term memory mutations");
      }
      const parsed = this.inputSchema.parse(input);
      this.session.beginTurn(context.turnId);
      const projectId = projectMemoryIdFromRoot(this.workspace.root);
      const workspaceId = workspaceIdFromRoot(this.workspace.root);

      if (parsed.operation === "remember" || parsed.operation === "revise") {
        const content = this.requireField(parsed.content, "content", parsed.operation);
        const limits = context.limits ?? DEFAULT_RUNTIME_LIMITS;
        if (
          content.length > limits.memoryContentMaxChars ||
          estimatedTokens(content) > limits.maxDurableMemoryTokens
        ) {
          this.assertSafeWrite(content, parsed.reason);
          const sourceRef = this.manager.evidenceStore.capture(
            workspaceId,
            context.threadId,
            `memory-preview:${context.turnId}:${sha256(content)}`,
            "write_memory",
            {
              ok: false,
              summary: "Uncommitted memory proposal; not a verified fact",
              data: { content },
            },
          );
          const preview = projectText(
            projectText(content, limits.memoryContentMaxChars).text,
            limits.maxDurableMemoryTokens,
            estimatedTokens,
          );
          return toolSuccess(
            "Length-only overflow archived as a lossy preview; no long-term fact or revision was committed. No retry is required.",
            {
              staged: false,
              committed: false,
              historical: true,
              truncated: true,
              sourceRef,
              content: preview.text,
              originalChars: content.length,
              retainedChars: preview.text.length,
            },
          );
        }
        assertDurableMemory(content, limits);
      }

      if (parsed.operation === "remember") {
        const content = this.requireField(parsed.content, "content", parsed.operation);
        const category = this.requireField(parsed.category, "category", parsed.operation);
        const scope = parsed.scope ?? "project";
        if (scope === "global" && category !== "preference" && category !== "convention") {
          throw new Error("Global memory is reserved for cross-project preferences and conventions");
        }
        if (scope === "global" && !parsed.sourceRefs?.includes("user")) {
          throw new Error("Global memory requires sourceRefs: [\"user\"] from this turn");
        }
        this.assertSafeWrite(content, parsed.reason);
        this.assertPlanCategory(context, category);
        return {
          ok: true,
          summary:
            "The long-term memory proposal was staged and will be committed only if this turn completes successfully.",
          data: { staged: true, operation: parsed.operation, scope },
          memoryMutation: {
            action: "remember",
            scope,
            ...(parsed.sourceRefs ? { sourceRefs: parsed.sourceRefs } : {}),
            content,
            category,
            reason: parsed.reason,
          },
        };
      }

      const memoryId = this.requireField(parsed.memoryId, "memoryId", parsed.operation);
      this.session.assertReturned(context.turnId, memoryId);
      const existing = this.manager.getAccessible(projectId, memoryId);
      if (!existing) {
        throw new Error("Long-term memory was not found in the current project or global scope");
      }

      if (parsed.operation !== "move" && parsed.scope && parsed.scope !== existing.scope) {
        throw new Error("Changing memory scope requires the move operation");
      }

      if (parsed.operation === "move") {
        const scope = this.requireField(parsed.scope, "scope", parsed.operation);
        if (scope === existing.scope) throw new Error("Memory already belongs to the target scope");
        this.assertSafeWrite(undefined, parsed.reason);
        if (scope === "global" && existing.category !== "preference" && existing.category !== "convention") {
          throw new Error("Only preferences and conventions may move to global memory");
        }
        if (scope === "global" && !parsed.sourceRefs?.includes("user")) {
          throw new Error("Moving memory to global requires sourceRefs: [\"user\"] from this turn");
        }
        return {
          ok: true,
          summary: `Memory ${memoryId} scope change was staged until this turn succeeds.`,
          data: { staged: true, operation: parsed.operation, memoryId, scope },
          memoryMutation: { action: "move", memoryId, scope, reason: parsed.reason,
            ...(parsed.sourceRefs ? { sourceRefs: parsed.sourceRefs } : {}) },
        };
      }

      if (parsed.operation === "revise") {
        const content = this.requireField(parsed.content, "content", parsed.operation);
        const category = parsed.category ?? existing.category;
        if (existing.scope === "global" && category !== "preference" && category !== "convention") {
          throw new Error("Global memory may contain only preferences or conventions");
        }
        this.assertSafeWrite(content, parsed.reason);
        this.assertPlanCategory(context, category);
        return {
          ok: true,
          summary:
            `Revision of long-term memory ${memoryId} was staged and will commit only if this turn succeeds.`,
          data: { staged: true, operation: parsed.operation, memoryId },
          memoryMutation: {
            action: "revise",
            scope: existing.scope,
            ...(parsed.sourceRefs ? { sourceRefs: parsed.sourceRefs } : {}),
            memoryId,
            content,
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
          `Expiration of long-term memory ${memoryId} was staged and will commit only if this turn succeeds.`,
        data: { staged: true, operation: parsed.operation, memoryId },
        memoryMutation: {
          action: "forget",
          scope: existing.scope,
          memoryId,
          reason: parsed.reason,
        },
      };
    } catch (error) {
      return toolFailure(error, "Unable to write long-term memory");
    }
  }

  private requireField<T>(
    value: T | undefined,
    field: string,
    operation: WriteMemoryInput["operation"],
  ): T {
    if (value === undefined) {
      throw new Error(`write_memory ${operation} requires field \"${field}\"`);
    }
    return value;
  }

  private assertSafeWrite(content: string | undefined, reason: string): void {
    if (
      (content !== undefined &&
        (containsSensitiveInformation(content) ||
          redactSensitiveInformation(content) !== content)) ||
      containsSensitiveInformation(reason) ||
      redactSensitiveInformation(reason) !== reason
    ) {
      throw new Error("Sensitive information cannot be staged as long-term memory");
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
