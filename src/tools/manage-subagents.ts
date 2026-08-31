import { z } from "zod";

import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import {
  DEFAULT_SUBAGENT_WAIT_MS,
  MAX_SUBAGENT_AGENT_IDS_PER_CALL,
  MAX_SUBAGENT_FOLLOW_UP_CHARS,
  MAX_SUBAGENT_INSTRUCTIONS_CHARS,
  MAX_SUBAGENT_STOP_REASON_CHARS,
  MAX_SUBAGENT_WAIT_MS,
  sanitizeSubagentText,
  type ManageSubagentsInput,
  type SubagentControl,
} from "../subagents/types.js";
import {
  MAX_TASK_LIST_ITEMS,
  MAX_TASK_TEXT_CHARS,
} from "../tasks/task-graph.js";
import { toolFailure } from "./base.js";
import { documentToolSchema } from "./metadata.js";

const TASK_ID_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,39}$";
const SUBAGENT_ID_PATTERN =
  "^subagent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const taskIdSchema = z.string().trim().regex(new RegExp(TASK_ID_PATTERN, "u"));
const subagentIdSchema = z.string().trim().regex(new RegExp(SUBAGENT_ID_PATTERN, "u"));
const isolationSchema = z.enum(["auto", "shared", "worktree"]);
const branchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/u);

function boundedAgentText(maximum: number): z.ZodPipeline<
  z.ZodEffects<z.ZodString, string, string>,
  z.ZodString
> {
  return z
    .string()
    .max(maximum)
    .transform(sanitizeSubagentText)
    .pipe(z.string().min(1).max(maximum));
}

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
    completionChecks: z
      .array(boundedAgentText(MAX_TASK_TEXT_CHARS))
      .min(1)
      .max(MAX_TASK_LIST_ITEMS),
  })
  .strict();

export const manageSubagentsInputSchema = z.union([
  z
    .object({
      action: z.literal("spawn"),
      taskId: taskIdSchema,
      instructions: boundedAgentText(MAX_SUBAGENT_INSTRUCTIONS_CHARS),
      isolation: isolationSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("spawn"),
      task: standaloneTaskSchema,
      instructions: boundedAgentText(MAX_SUBAGENT_INSTRUCTIONS_CHARS),
      isolation: isolationSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("status"),
      agentIds: agentIdsSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("wait"),
      agentIds: agentIdsSchema,
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_SUBAGENT_WAIT_MS)
        .default(DEFAULT_SUBAGENT_WAIT_MS),
    })
    .strict(),
  z
    .object({
      action: z.literal("follow_up"),
      agentId: subagentIdSchema,
      message: boundedAgentText(MAX_SUBAGENT_FOLLOW_UP_CHARS),
    })
    .strict(),
  z
    .object({
      action: z.literal("stop"),
      agentId: subagentIdSchema,
      reason: boundedAgentText(MAX_SUBAGENT_STOP_REASON_CHARS),
    })
    .strict(),
  z
    .object({
      action: z.literal("handoff"),
      agentId: subagentIdSchema,
      destination: z.enum(["local", "branch"]),
      branchName: branchNameSchema.optional(),
    })
    .strict()
    .refine((value) => value.destination === "branch" || value.branchName === undefined, {
      message: "branchName is valid only for branch handoff",
    }),
]);

/**
 * Main-agent control surface. The injected controller is the authority for
 * role checks, assignment binding, concurrency, persistence, and lifecycle
 * transitions.
 */
export class ManageSubagentsTool implements AgentTool {
  readonly name = "manage_subagents" as const;
  readonly mutating = true;
  readonly inputSchema = manageSubagentsInputSchema;
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
            enum: ["spawn", "status", "wait", "follow_up", "stop", "handoff"],
          },
          taskId: {
            type: "string",
            pattern: TASK_ID_PATTERN,
          },
          task: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: {
                type: "string",
                minLength: 1,
                maxLength: MAX_TASK_TEXT_CHARS,
              },
              description: {
                type: "string",
                minLength: 1,
                maxLength: MAX_TASK_TEXT_CHARS,
              },
              completionChecks: {
                type: "array",
                minItems: 1,
                maxItems: MAX_TASK_LIST_ITEMS,
                items: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_TASK_TEXT_CHARS,
                },
              },
            },
            required: ["title", "description", "completionChecks"],
          },
          instructions: {
            type: "string",
            minLength: 1,
            maxLength: MAX_SUBAGENT_INSTRUCTIONS_CHARS,
          },
          isolation: {
            type: "string",
            enum: ["auto", "shared", "worktree"],
          },
          agentId: {
            type: "string",
            pattern: SUBAGENT_ID_PATTERN,
          },
          agentIds: {
            type: "array",
            minItems: 1,
            maxItems: MAX_SUBAGENT_AGENT_IDS_PER_CALL,
            uniqueItems: true,
            items: { type: "string", pattern: SUBAGENT_ID_PATTERN },
          },
          timeoutMs: {
            type: "integer",
            minimum: 0,
            maximum: MAX_SUBAGENT_WAIT_MS,
          },
          message: {
            type: "string",
            minLength: 1,
            maxLength: MAX_SUBAGENT_FOLLOW_UP_CHARS,
          },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: MAX_SUBAGENT_STOP_REASON_CHARS,
          },
          destination: {
            type: "string",
            enum: ["local", "branch"],
          },
          branchName: {
            type: "string",
            maxLength: 160,
          },
        },
        required: ["action"],
      }),
    },
  };

  constructor(private readonly control: SubagentControl) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      const parsed = this.inputSchema.parse(input) as ManageSubagentsInput;
      if (context.mode === "plan") {
        throw new Error("manage_subagents is unavailable in Plan mode");
      }
      await this.control.assertAuthorized(context);
      switch (parsed.action) {
        case "spawn":
          return await this.control.spawn(parsed, context);
        case "status":
          return await this.control.status(parsed, context);
        case "wait":
          return await this.control.wait(parsed, context);
        case "follow_up":
          return await this.control.followUp(parsed, context);
        case "stop":
          return await this.control.stop(parsed, context);
        case "handoff":
          return await this.control.handoff(parsed, context);
      }
    } catch (error) {
      return toolFailure(error, "Unable to manage subagents");
    }
  }
}
