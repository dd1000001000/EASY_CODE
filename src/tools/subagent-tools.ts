import { z } from "zod";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { THINKING_EFFORTS } from "../core/types.js";

import type { AgentTool, ToolContext, ToolDefinition, ToolExecutionResult } from "../core/types.js";
import {
  MAX_SUBAGENT_AGENT_IDS_PER_CALL,
  MAX_SUBAGENT_STOP_REASON_CHARS,
  MAX_SUBAGENT_WAIT_MS,
  sanitizeSubagentText,
  truncateSubagentMessage,
  type SubagentControl,
} from "../subagents/types.js";
import { MAX_SUBAGENT_DISPLAY_NAME_CHARS } from "../subagents/display-name.js";
import type { SubagentToolName } from "../subagents/tool-names.js";
import { MAX_TASK_LIST_ITEMS, MAX_TASK_TEXT_CHARS } from "../tasks/task-graph.js";
import { toolFailure } from "./base.js";
import { documentToolSchema } from "./metadata.js";

const TASK_ID_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,39}$";
const SUBAGENT_ID_PATTERN = "^subagent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const taskIdSchema = z.string().trim().regex(new RegExp(TASK_ID_PATTERN, "u"));
const subagentIdSchema = z.string().trim().regex(new RegExp(SUBAGENT_ID_PATTERN, "u"));
const isolationSchema = z.enum(["auto", "shared", "worktree"]);
const thinkingEffortSchema = z.enum(THINKING_EFFORTS);
const branchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/u);

function boundedAgentText(maximum: number): z.ZodPipeline<z.ZodEffects<z.ZodString, string, string>, z.ZodString> {
  return z.string().max(maximum).transform(sanitizeSubagentText).pipe(z.string().min(1).max(maximum));
}

function truncatedAgentMessage(maximum: number) {
  return z
    .string()
    .transform((value) => truncateSubagentMessage(value, maximum))
    .pipe(z.string().min(1).max(maximum));
}

// A single display line: sanitized, whitespace-collapsed and bounded after cleanup.
const displayNameSchema = z
  .string()
  .max(MAX_SUBAGENT_DISPLAY_NAME_CHARS * 4)
  .transform((value) => sanitizeSubagentText(value).replace(/\s+/gu, " "))
  .pipe(z.string().min(1).max(MAX_SUBAGENT_DISPLAY_NAME_CHARS));

const agentIdsSchema = z
  .array(subagentIdSchema)
  .min(1)
  .max(MAX_SUBAGENT_AGENT_IDS_PER_CALL)
  .refine((values) => new Set(values).size === values.length, {
    message: "Subagent IDs must be unique",
  });

const standaloneTaskSchema = z
  .object({
    title: boundedAgentText(MAX_TASK_TEXT_CHARS),
    description: boundedAgentText(MAX_TASK_TEXT_CHARS),
    completionChecks: z.array(boundedAgentText(MAX_TASK_TEXT_CHARS)).min(1).max(MAX_TASK_LIST_ITEMS),
  })
  .strict();

export function createSpawnSubagentInputSchema(limits = DEFAULT_RUNTIME_LIMITS) {
  return z
    .object({
      name: displayNameSchema,
      taskId: taskIdSchema.optional(),
      task: standaloneTaskSchema.optional(),
      instructions: truncatedAgentMessage(limits.subagentInstructionsMaxChars),
      isolation: isolationSchema.optional(),
      thinkingEffort: thinkingEffortSchema.optional(),
    })
    .strict()
    .refine((value) => (value.taskId === undefined) !== (value.task === undefined), {
      message: "Provide exactly one of taskId (a DAG task) or task (a standalone assignment)",
    });
}

const observeSubagentsInputSchema = z
  .object({
    agentIds: agentIdsSchema.optional(),
    timeoutMs: z.number().int().min(0).max(MAX_SUBAGENT_WAIT_MS).default(0),
  })
  .strict();

export function createMessageSubagentInputSchema(limits = DEFAULT_RUNTIME_LIMITS) {
  return z
    .object({
      agentId: subagentIdSchema,
      message: truncatedAgentMessage(limits.subagentFollowUpMaxChars),
    })
    .strict();
}

const stopSubagentInputSchema = z
  .object({
    agentId: subagentIdSchema,
    reason: boundedAgentText(MAX_SUBAGENT_STOP_REASON_CHARS),
  })
  .strict();

const handoffSubagentInputSchema = z
  .object({
    agentId: subagentIdSchema,
    destination: z.enum(["local", "branch"]),
    branchName: branchNameSchema.optional(),
  })
  .strict()
  .refine((value) => value.destination === "branch" || value.branchName === undefined, {
    message: "branchName is valid only for branch handoff",
  });

const agentIdProperty = { type: "string", pattern: SUBAGENT_ID_PATTERN };

function definition(name: SubagentToolName, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      strict: true,
      ...documentToolSchema(name, {
        type: "object",
        additionalProperties: false,
        properties,
        required,
      }),
    },
  };
}

/**
 * Main-agent child controls. The injected controller is the authority for
 * role checks, assignment binding, concurrency, persistence, and lifecycle
 * transitions; each tool only validates its own input shape.
 */
abstract class SubagentTool {
  constructor(
    protected readonly control: SubagentControl,
    protected readonly limits = DEFAULT_RUNTIME_LIMITS,
  ) {}

  protected async run<T>(
    context: ToolContext,
    parse: () => T,
    apply: (request: T) => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> {
    try {
      const request = parse();
      await this.control.assertAuthorized(context);
      return await apply(request);
    } catch (error) {
      return toolFailure(error, "Unable to manage subagents");
    }
  }
}

export class SpawnSubagentTool extends SubagentTool implements AgentTool {
  readonly name = "spawn_subagent" as const;
  readonly mutating = true;
  get inputSchema() {
    return createSpawnSubagentInputSchema(this.limits);
  }
  get definition(): ToolDefinition {
    return definition(
      this.name,
      {
        name: { type: "string", minLength: 1, maxLength: MAX_SUBAGENT_DISPLAY_NAME_CHARS },
        taskId: { type: "string", pattern: TASK_ID_PATTERN },
        task: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: MAX_TASK_TEXT_CHARS },
            description: { type: "string", minLength: 1, maxLength: MAX_TASK_TEXT_CHARS },
            completionChecks: {
              type: "array",
              minItems: 1,
              maxItems: MAX_TASK_LIST_ITEMS,
              items: { type: "string", minLength: 1, maxLength: MAX_TASK_TEXT_CHARS },
            },
          },
          required: ["title", "description", "completionChecks"],
        },
        instructions: { type: "string", minLength: 1 },
        isolation: { type: "string", enum: ["auto", "shared", "worktree"] },
        thinkingEffort: { type: "string", enum: [...THINKING_EFFORTS] },
      },
      ["name", "instructions"],
    );
  }

  execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    return this.run(
      context,
      () => {
        const request = this.inputSchema.parse(input);
        if (context.selectedMode === "auto") {
          throw new Error("Subagent dispatch requires an explicitly selected Plan or Code mode");
        }
        return request;
      },
      (request) => this.control.spawn(request, context),
    );
  }
}

export class ObserveSubagentsTool extends SubagentTool implements AgentTool {
  readonly name = "observe_subagents" as const;
  readonly mutating = true;
  readonly inputSchema = observeSubagentsInputSchema;
  get definition(): ToolDefinition {
    return definition(
      this.name,
      {
        agentIds: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SUBAGENT_AGENT_IDS_PER_CALL,
          uniqueItems: true,
          items: agentIdProperty,
        },
        timeoutMs: { type: "integer", minimum: 0, maximum: MAX_SUBAGENT_WAIT_MS },
      },
      [],
    );
  }

  execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    return this.run(
      context,
      () => this.inputSchema.parse(input),
      (request) => this.control.observe(request, context),
    );
  }
}

export class MessageSubagentTool extends SubagentTool implements AgentTool {
  readonly name = "message_subagent" as const;
  readonly mutating = false;
  get inputSchema() {
    return createMessageSubagentInputSchema(this.limits);
  }
  get definition(): ToolDefinition {
    return definition(this.name, { agentId: agentIdProperty, message: { type: "string", minLength: 1 } }, [
      "agentId",
      "message",
    ]);
  }

  execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    return this.run(
      context,
      () => this.inputSchema.parse(input),
      (request) => this.control.followUp(request, context),
    );
  }
}

export class StopSubagentTool extends SubagentTool implements AgentTool {
  readonly name = "stop_subagent" as const;
  readonly mutating = false;
  readonly inputSchema = stopSubagentInputSchema;
  get definition(): ToolDefinition {
    return definition(
      this.name,
      {
        agentId: agentIdProperty,
        reason: { type: "string", minLength: 1, maxLength: MAX_SUBAGENT_STOP_REASON_CHARS },
      },
      ["agentId", "reason"],
    );
  }

  execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    return this.run(
      context,
      () => this.inputSchema.parse(input),
      (request) => this.control.stop(request, context),
    );
  }
}

export class HandoffSubagentTool extends SubagentTool implements AgentTool {
  readonly name = "handoff_subagent" as const;
  readonly mutating = true;
  readonly inputSchema = handoffSubagentInputSchema;
  get definition(): ToolDefinition {
    return definition(
      this.name,
      {
        agentId: agentIdProperty,
        destination: { type: "string", enum: ["local", "branch"] },
        branchName: { type: "string", maxLength: 160 },
      },
      ["agentId", "destination"],
    );
  }

  execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    return this.run(
      context,
      () => this.inputSchema.parse(input),
      (request) => this.control.handoff(request, context),
    );
  }
}

/** Every child control backed by one Runtime controller, in prompt order. */
export function createSubagentTools(control: SubagentControl, limits = DEFAULT_RUNTIME_LIMITS): AgentTool[] {
  return [
    new SpawnSubagentTool(control, limits),
    new ObserveSubagentsTool(control, limits),
    new MessageSubagentTool(control, limits),
    new StopSubagentTool(control, limits),
    new HandoffSubagentTool(control, limits),
  ];
}
