import { z } from "zod";

import type {
  AgentTool,
  MemoryMutationRequest,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { assertDurableMemory } from "../memory/admission.js";
import {
  MAX_MEMORY_REASON_CHARS,
  MEMORY_ID_PATTERN,
  MIN_MEMORY_CONTENT_CHARS,
  type MemoryManager,
} from "../memory/memory-manager.js";
import { containsSensitiveInformation, redactSensitiveInformation } from "../memory/sensitive.js";
import { projectMemoryIdFromRoot } from "../memory/memory-manager.js";
import { displayTextSchema } from "../utils/bounded-text.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { assertMatchingWorkspace, toolFailure } from "./base.js";
import { documentToolSchema } from "./metadata.js";
import type { MemoryToolSession } from "./memory-tool-session.js";

const memoryCategorySchema = z.enum(["preference", "convention", "architecture", "decision", "environment"]);
const memoryContentSchema = z.string().trim().min(MIN_MEMORY_CONTENT_CHARS);
const memoryReasonSchema = displayTextSchema(MAX_MEMORY_REASON_CHARS);
const memoryIdSchema = z.string().trim().regex(MEMORY_ID_PATTERN);

/**
 * A deliberately flat write-only schema. Operation-specific required fields
 * are checked inside the tool so provider schemas never need oneOf support.
 * Harmless write-side fields may be present for another operation and are
 * ignored; read-side fields remain unknown and are rejected before execution.
 */
export const writeMemoryInputSchema = z
  .object({
    operation: z.enum(["remember", "revise", "forget", "move"]),
    scope: z.enum(["global", "project"]).optional(),
    memoryId: memoryIdSchema.optional(),
    content: memoryContentSchema.optional(),
    category: memoryCategorySchema.optional(),
    reason: memoryReasonSchema,
  })
  .strict();

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
            memoryId: { type: "string", pattern: MEMORY_ID_PATTERN.source },
            content: {
              type: "string",
              minLength: MIN_MEMORY_CONTENT_CHARS,
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
      const projectId = this.workspace.projectId ?? projectMemoryIdFromRoot(this.workspace.root);
      let writeContent: string | undefined;
      if (parsed.operation === "remember" || parsed.operation === "revise") {
        const content = this.requireField(parsed.content, "content", parsed.operation);
        this.assertSafeWrite(content, parsed.reason);
        const limits = context.limits ?? DEFAULT_RUNTIME_LIMITS;
        const maxChars = Math.min(limits.memoryContentMaxChars, this.manager.limits.memoryContentMaxChars);
        // A shortened fact can lose the qualification that made it true, so an oversized one is refused, not cut.
        if (content.length > maxChars) {
          throw new Error(
            `Memory content has ${content.length} characters; the limit is ${maxChars}. Store one fact per memory: split it or shorten it.`,
          );
        }
        assertDurableMemory(content, limits);
        assertDurableMemory(content, this.manager.limits);
        writeContent = content;
      }

      const check = (mutation: MemoryMutationRequest): MemoryMutationRequest => {
        this.manager.checkModelMutation({
          workspaceId: projectId,
          threadId: context.threadId,
          turnId: context.turnId,
          outcome: context.mode === "plan" ? "planned" : "success",
          mutations: [mutation],
        });
        return mutation;
      };

      if (parsed.operation === "remember") {
        const content = writeContent!;
        const category = this.requireField(parsed.category, "category", parsed.operation);
        this.assertSafeWrite(content, parsed.reason);
        const userStated = await this.manager.statedByUser(content, context.userRequest);
        // Global memory reaches every project, so only the user's own words may put something there.
        const requested = parsed.scope ?? "project";
        const scope = requested === "global" && !userStated ? "project" : requested;
        const memoryMutation = check({
          action: "remember",
          scope,
          content,
          category,
          reason: parsed.reason,
          userStated,
        });
        return {
          ok: true,
          summary:
            scope === requested
              ? "The long-term memory proposal was staged and will be committed only if this turn completes successfully."
              : "Staged as project memory: global memory needs the user's own message in this turn to state it. It commits only if this turn completes successfully.",
          data: { staged: true, operation: parsed.operation, scope },
          memoryMutation,
        };
      }

      const memoryId = this.requireField(parsed.memoryId, "memoryId", parsed.operation);
      // A memory already shown in this turn's runtime context needs no second search.
      if (!context.deliveredMemoryIds?.has(memoryId)) this.session.assertReturned(context.turnId, memoryId);
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
        if (scope === "global" && !(await this.manager.statedByUser(existing.content, context.userRequest))) {
          throw new Error("Moving a memory to global scope needs the user's own message in this turn to ask for it");
        }
        return {
          ok: true,
          summary: `Memory ${memoryId} scope change was staged until this turn succeeds.`,
          data: { staged: true, operation: parsed.operation, memoryId, scope },
          memoryMutation: check({ action: "move", memoryId, scope, reason: parsed.reason }),
        };
      }

      if (parsed.operation === "revise") {
        const content = writeContent!;
        const category = parsed.category ?? existing.category;
        this.assertSafeWrite(content, parsed.reason);
        return {
          ok: true,
          summary: `Revision of long-term memory ${memoryId} was staged and will commit only if this turn succeeds.`,
          data: { staged: true, operation: parsed.operation, memoryId },
          memoryMutation: check({
            action: "revise",
            scope: existing.scope,
            memoryId,
            content,
            category,
            reason: parsed.reason,
            userStated: await this.manager.statedByUser(content, context.userRequest),
          }),
        };
      }

      this.assertSafeWrite(undefined, parsed.reason);
      return {
        ok: true,
        summary: `Expiration of long-term memory ${memoryId} was staged and will commit only if this turn succeeds.`,
        data: { staged: true, operation: parsed.operation, memoryId },
        memoryMutation: check({
          action: "forget",
          scope: existing.scope,
          memoryId,
          reason: parsed.reason,
        }),
      };
    } catch (error) {
      return toolFailure(error, "Unable to write long-term memory");
    }
  }

  private requireField<T>(value: T | undefined, field: string, operation: WriteMemoryInput["operation"]): T {
    if (value === undefined) {
      throw new Error(`write_memory ${operation} requires field \"${field}\"`);
    }
    return value;
  }

  private assertSafeWrite(content: string | undefined, reason: string): void {
    if (
      (content !== undefined &&
        (containsSensitiveInformation(content) || redactSensitiveInformation(content) !== content)) ||
      containsSensitiveInformation(reason) ||
      redactSensitiveInformation(reason) !== reason
    ) {
      throw new Error("Sensitive information cannot be staged as long-term memory");
    }
  }
}
