import { z } from "zod";

import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import type { AgentTool, ToolContext, ToolDefinition, ToolExecutionResult, UserQuestion } from "../core/types.js";
import {
  USER_QUESTION_DESCRIPTION_MAX_CHARS,
  USER_QUESTION_HEADER_MAX_CHARS,
  USER_QUESTION_LABEL_MAX_CHARS,
  USER_QUESTION_TEXT_MAX_CHARS,
  cleanQuestionText,
  isReservedOptionLabel,
} from "../core/user-questions.js";
import { toolFailure, toolSuccess } from "./base.js";
import { documentToolSchema } from "./metadata.js";

type AskUserLimits = Pick<
  RuntimeLimits,
  "askUserMinQuestions" | "askUserMaxQuestions" | "askUserMinOptions" | "askUserMaxOptions"
>;

const text = (maximum: number) => z.string().transform(cleanQuestionText).pipe(z.string().min(1).max(maximum));

export function askUserInputSchema(limits: Readonly<AskUserLimits>) {
  const option = z
    .object({
      label: text(USER_QUESTION_LABEL_MAX_CHARS).refine((label) => !isReservedOptionLabel(label), {
        message: 'Do not offer an "Other" option; every question already lets the user type their own answer.',
      }),
      description: z.string().transform(cleanQuestionText).pipe(z.string().max(USER_QUESTION_DESCRIPTION_MAX_CHARS)),
    })
    .strict();
  const question = z
    .object({
      header: text(USER_QUESTION_HEADER_MAX_CHARS),
      question: text(USER_QUESTION_TEXT_MAX_CHARS),
      multi_select: z.boolean(),
      options: z
        .array(option)
        .min(limits.askUserMinOptions)
        .max(limits.askUserMaxOptions)
        .refine((options) => new Set(options.map((item) => item.label)).size === options.length, {
          message: "Option labels must be different within a question.",
        }),
    })
    .strict();
  return z
    .object({
      questions: z.array(question).min(limits.askUserMinQuestions).max(limits.askUserMaxQuestions),
    })
    .strict();
}

/**
 * Ask the user one to a few multiple-choice questions and wait for the answer.
 * Every question also takes the user's own text. Main agent only.
 */
export class AskUserTool implements AgentTool {
  readonly name = "ask_user" as const;
  readonly mutating = false;
  readonly inputSchema: ReturnType<typeof askUserInputSchema>;
  readonly definition: ToolDefinition;

  constructor(limits: Readonly<AskUserLimits> = DEFAULT_RUNTIME_LIMITS) {
    this.inputSchema = askUserInputSchema(limits);
    this.definition = {
      type: "function",
      function: {
        name: this.name,
        strict: true,
        ...documentToolSchema(this.name, {
          type: "object",
          additionalProperties: false,
          properties: {
            questions: {
              type: "array",
              minItems: limits.askUserMinQuestions,
              maxItems: limits.askUserMaxQuestions,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  header: { type: "string", minLength: 1, maxLength: USER_QUESTION_HEADER_MAX_CHARS },
                  question: { type: "string", minLength: 1, maxLength: USER_QUESTION_TEXT_MAX_CHARS },
                  multi_select: { type: "boolean" },
                  options: {
                    type: "array",
                    minItems: limits.askUserMinOptions,
                    maxItems: limits.askUserMaxOptions,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        label: { type: "string", minLength: 1, maxLength: USER_QUESTION_LABEL_MAX_CHARS },
                        description: { type: "string", maxLength: USER_QUESTION_DESCRIPTION_MAX_CHARS },
                      },
                      required: ["label", "description"],
                    },
                  },
                },
                required: ["header", "question", "multi_select", "options"],
              },
            },
          },
          required: ["questions"],
        }),
      },
    };
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      if (context.agentRole === "subagent") throw new Error("Only the main agent can ask the user.");
      if (!context.askUser) throw new Error("ask_user needs an interactive EASY CODE session.");
      const parsed = this.inputSchema.parse(input);
      const questions: UserQuestion[] = parsed.questions.map((item) => ({
        header: item.header,
        question: item.question,
        multiSelect: item.multi_select,
        options: item.options.map((option) => ({ label: option.label, description: option.description || null })),
      }));
      const outcome = await context.askUser(questions, {
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.waitSignal ? { supersede: context.waitSignal } : {}),
      });
      switch (outcome.status) {
        case "answered":
          return toolSuccess(`The user answered ${questions.length === 1 ? "the question" : "the questions"}.`, {
            status: "answered",
            answers: questions.map((question, index) => ({
              header: question.header,
              question: question.question,
              selected: outcome.answers[index]?.selected ?? [],
              custom: outcome.answers[index]?.custom ?? null,
            })),
          });
        case "unanswered":
          return {
            ok: true,
            summary:
              outcome.reason === "timeout"
                ? "The user did not answer in time; the request ends here."
                : "The user skipped the question; the request ends here.",
            data: { status: "unanswered", reason: outcome.reason },
            unansweredQuestions: { reason: outcome.reason, questions },
          };
        case "superseded":
          return toolSuccess("The user sent a message instead of answering. Read it and continue from there.", {
            status: "superseded",
          });
        case "cancelled":
          return {
            ok: false,
            summary: "The question closed because the request ended.",
            error: "question_cancelled",
          };
      }
    } catch (error) {
      return toolFailure(error, "Unable to ask the user");
    }
  }
}
