import { z } from "zod";
import { MAX_CONTEXT_SUMMARY_CHARS } from "../context/manager.js";
import type {
  AgentTool,
  ContextCompactionCoverageCheck,
  ContextIntentLedger,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { toolFailure } from "./base.js";
import { documentToolSchema } from "./metadata.js";

const MAX_MESSAGE_INDEX = 10_000_000;
const MAX_PRIMARY_REQUEST_CHARS = 2_400;
const MAX_CONSTRAINT_CHARS = 1_000;
const MAX_ITEM_CHARS = 800;
const MAX_PATH_CHARS = 500;
const MAX_REFERENCE_CHARS = 500;
const MAX_COVERAGE_NOTE_CHARS = 400;
const MAX_INTENT_QUOTE_CHARS = 400;
const MAX_CONSTRAINTS = 24;
const MAX_DECISIONS = 24;
const MAX_FILES_AND_CHANGES = 48;
const MAX_VERIFIED_RESULTS = 32;
const MAX_ERRORS_AND_BLOCKERS = 24;
const MAX_PENDING_WORK = 32;
const MAX_EVIDENCE_REFS = 64;
const MAX_EVIDENCE_REFS_PER_ITEM = 12;
const MAX_COVERED_MESSAGE_INDICES = 128;
const MAX_USER_CORRECTIONS = 32;
const MAX_SUPERSEDED_REQUESTS = 32;

const messageIndexSchema = z.number().int().min(0).max(MAX_MESSAGE_INDEX);

function boundedNonBlankText(maximum: number): z.ZodType<string> {
  return z.string().min(1).max(maximum).refine(
    (value) => value.trim().length > 0,
    "Text must contain a non-whitespace character",
  );
}

const evidenceRefIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);

const evidenceRefIdsSchema = z.array(evidenceRefIdSchema)
  .max(MAX_EVIDENCE_REFS_PER_ITEM)
  .refine((items) => new Set(items).size === items.length, "Evidence references must be unique");

const coverageMessageIndicesSchema = z.array(messageIndexSchema)
  .max(MAX_COVERED_MESSAGE_INDICES)
  .refine(
    (items) => items.every((item, index) => index === 0 || item > (items[index - 1] ?? -1)),
    "Covered message indices must be unique and strictly ascending",
  );

const intentQuoteSchema = z.object({
  sourceMessageIndex: messageIndexSchema,
  text: boundedNonBlankText(MAX_INTENT_QUOTE_CHARS),
}).strict();

const compactContextV2InputSchema = z.object({
  formatVersion: z.literal(2),
  primaryRequest: z.object({
    sourceMessageIndex: messageIndexSchema,
    text: boundedNonBlankText(MAX_PRIMARY_REQUEST_CHARS),
  }).strict(),
  activeConstraints: z.array(z.object({
    sourceMessageIndex: messageIndexSchema,
    text: boundedNonBlankText(MAX_CONSTRAINT_CHARS),
  }).strict()).max(MAX_CONSTRAINTS),
  technicalDecisions: z.array(z.object({
    decision: boundedNonBlankText(MAX_ITEM_CHARS),
    evidenceRefIds: evidenceRefIdsSchema,
  }).strict()).max(MAX_DECISIONS),
  filesAndChanges: z.array(z.object({
    path: boundedNonBlankText(MAX_PATH_CHARS),
    status: z.enum(["read", "created", "updated", "deleted", "planned", "unchanged"]),
    summary: boundedNonBlankText(MAX_ITEM_CHARS),
    evidenceRefIds: evidenceRefIdsSchema,
  }).strict()).max(MAX_FILES_AND_CHANGES),
  verifiedResults: z.array(z.object({
    result: boundedNonBlankText(MAX_ITEM_CHARS),
    evidenceRefIds: evidenceRefIdsSchema,
  }).strict()).max(MAX_VERIFIED_RESULTS),
  errorsAndBlockers: z.array(z.object({
    kind: z.enum(["error", "blocker"]),
    message: boundedNonBlankText(MAX_ITEM_CHARS),
    evidenceRefIds: evidenceRefIdsSchema,
  }).strict()).max(MAX_ERRORS_AND_BLOCKERS),
  pendingWork: z.array(boundedNonBlankText(MAX_ITEM_CHARS)).max(MAX_PENDING_WORK),
  currentWork: boundedNonBlankText(MAX_ITEM_CHARS),
  nextStep: boundedNonBlankText(MAX_ITEM_CHARS),
  evidenceRefs: z.array(z.object({
    id: evidenceRefIdSchema,
    kind: z.enum(["message", "file", "command", "test", "task", "artifact"]),
    reference: boundedNonBlankText(MAX_REFERENCE_CHARS),
  }).strict()).max(MAX_EVIDENCE_REFS)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "Evidence reference IDs must be unique",
    ),
  intentLedger: z.object({
    userCorrections: z.array(intentQuoteSchema).max(MAX_USER_CORRECTIONS),
    supersededRequests: z.array(intentQuoteSchema).max(MAX_SUPERSEDED_REQUESTS),
  }).strict(),
  coverageCheck: z.object({
    coveredMessageIndices: coverageMessageIndicesSchema,
    latestMessageIndex: messageIndexSchema,
    latestRequestPreserved: z.boolean(),
    activeConstraintsPreserved: z.boolean(),
    activePlanOrTaskPreserved: z.boolean(),
    unresolvedErrorsPreserved: z.boolean(),
    currentWorkPreserved: z.boolean(),
    nextStepPreserved: z.boolean(),
    note: z.string().max(MAX_COVERAGE_NOTE_CHARS),
  }).strict(),
}).strict();

export const compactContextInputSchema = compactContextV2InputSchema;

export type CompactContextInput = z.infer<typeof compactContextInputSchema>;

type PersistedCompactionSummaryV2 = Omit<
  CompactContextInput,
  "coverageCheck" | "intentLedger"
>;

function redactSummaryFields(input: PersistedCompactionSummaryV2): PersistedCompactionSummaryV2 {
  return JSON.parse(
    JSON.stringify(input, (_key, value: unknown) =>
      typeof value === "string" ? redactSensitiveInformation(value) : value
    ),
  ) as PersistedCompactionSummaryV2;
}

function buildPersistedSummary(input: CompactContextInput): string {
  const {
    coverageCheck: _coverageCheck,
    intentLedger: _intentLedger,
    ...summaryFields
  } = input;
  return JSON.stringify(redactSummaryFields(summaryFields));
}

function copyIntentLedger(input: CompactContextInput): ContextIntentLedger {
  const copyQuote = (quote: { sourceMessageIndex: number; text: string }) => ({
    sourceMessageIndex: quote.sourceMessageIndex,
    text: redactSensitiveInformation(quote.text),
  });
  return {
    latestRequest: copyQuote(input.primaryRequest),
    activeConstraints: input.activeConstraints.map(copyQuote),
    userCorrections: input.intentLedger.userCorrections.map(copyQuote),
    supersededRequests: input.intentLedger.supersededRequests.map(copyQuote),
  };
}

function copyCoverageCheck(
  coverageCheck: CompactContextInput["coverageCheck"],
): ContextCompactionCoverageCheck {
  return {
    ...coverageCheck,
    coveredMessageIndices: [...coverageCheck.coveredMessageIndices],
  };
}

/** Runtime-owned tool: it proposes a summary but never edits workspace files or history. */
export class CompactContextTool implements AgentTool {
  readonly name = "compact_context" as const;
  readonly mutating = false;
  readonly inputSchema = compactContextInputSchema;
  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: this.name,
      strict: true,
      ...documentToolSchema(this.name, {
        type: "object",
        additionalProperties: false,
        properties: {
          formatVersion: { type: "integer", enum: [2] },
          primaryRequest: {
            type: "object",
            additionalProperties: false,
            properties: {
              sourceMessageIndex: {
                type: "integer",
                minimum: 0,
                maximum: MAX_MESSAGE_INDEX,
              },
              text: {
                type: "string",
                minLength: 1,
                maxLength: MAX_PRIMARY_REQUEST_CHARS,
              },
            },
            required: ["sourceMessageIndex", "text"],
          },
          activeConstraints: {
            type: "array",
            maxItems: MAX_CONSTRAINTS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                sourceMessageIndex: {
                  type: "integer",
                  minimum: 0,
                  maximum: MAX_MESSAGE_INDEX,
                },
                text: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_CONSTRAINT_CHARS,
                },
              },
              required: ["sourceMessageIndex", "text"],
            },
          },
          technicalDecisions: {
            type: "array",
            maxItems: MAX_DECISIONS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                decision: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS },
                evidenceRefIds: {
                  type: "array",
                  maxItems: MAX_EVIDENCE_REFS_PER_ITEM,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1, maxLength: 64 },
                },
              },
              required: ["decision", "evidenceRefIds"],
            },
          },
          filesAndChanges: {
            type: "array",
            maxItems: MAX_FILES_AND_CHANGES,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", minLength: 1, maxLength: MAX_PATH_CHARS },
                status: {
                  type: "string",
                  enum: ["read", "created", "updated", "deleted", "planned", "unchanged"],
                },
                summary: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS },
                evidenceRefIds: {
                  type: "array",
                  maxItems: MAX_EVIDENCE_REFS_PER_ITEM,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1, maxLength: 64 },
                },
              },
              required: ["path", "status", "summary", "evidenceRefIds"],
            },
          },
          verifiedResults: {
            type: "array",
            maxItems: MAX_VERIFIED_RESULTS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                result: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS },
                evidenceRefIds: {
                  type: "array",
                  maxItems: MAX_EVIDENCE_REFS_PER_ITEM,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1, maxLength: 64 },
                },
              },
              required: ["result", "evidenceRefIds"],
            },
          },
          errorsAndBlockers: {
            type: "array",
            maxItems: MAX_ERRORS_AND_BLOCKERS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: ["error", "blocker"] },
                message: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS },
                evidenceRefIds: {
                  type: "array",
                  maxItems: MAX_EVIDENCE_REFS_PER_ITEM,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1, maxLength: 64 },
                },
              },
              required: ["kind", "message", "evidenceRefIds"],
            },
          },
          pendingWork: {
            type: "array",
            maxItems: MAX_PENDING_WORK,
            items: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS },
          },
          currentWork: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS },
          nextStep: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS },
          evidenceRefs: {
            type: "array",
            maxItems: MAX_EVIDENCE_REFS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 64,
                  pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$",
                },
                kind: {
                  type: "string",
                  enum: ["message", "file", "command", "test", "task", "artifact"],
                },
                reference: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_REFERENCE_CHARS,
                },
              },
              required: ["id", "kind", "reference"],
            },
          },
          intentLedger: {
            type: "object",
            additionalProperties: false,
            properties: {
              userCorrections: {
                type: "array",
                maxItems: MAX_USER_CORRECTIONS,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    sourceMessageIndex: {
                      type: "integer",
                      minimum: 0,
                      maximum: MAX_MESSAGE_INDEX,
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      maxLength: MAX_INTENT_QUOTE_CHARS,
                    },
                  },
                  required: ["sourceMessageIndex", "text"],
                },
              },
              supersededRequests: {
                type: "array",
                maxItems: MAX_SUPERSEDED_REQUESTS,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    sourceMessageIndex: {
                      type: "integer",
                      minimum: 0,
                      maximum: MAX_MESSAGE_INDEX,
                    },
                    text: {
                      type: "string",
                      minLength: 1,
                      maxLength: MAX_INTENT_QUOTE_CHARS,
                    },
                  },
                  required: ["sourceMessageIndex", "text"],
                },
              },
            },
            required: ["userCorrections", "supersededRequests"],
          },
          coverageCheck: {
            type: "object",
            additionalProperties: false,
            properties: {
              coveredMessageIndices: {
                type: "array",
                maxItems: MAX_COVERED_MESSAGE_INDICES,
                uniqueItems: true,
                items: {
                  type: "integer",
                  minimum: 0,
                  maximum: MAX_MESSAGE_INDEX,
                },
              },
              latestMessageIndex: {
                type: "integer",
                minimum: 0,
                maximum: MAX_MESSAGE_INDEX,
              },
              latestRequestPreserved: { type: "boolean" },
              activeConstraintsPreserved: { type: "boolean" },
              activePlanOrTaskPreserved: { type: "boolean" },
              unresolvedErrorsPreserved: { type: "boolean" },
              currentWorkPreserved: { type: "boolean" },
              nextStepPreserved: { type: "boolean" },
              note: { type: "string", maxLength: MAX_COVERAGE_NOTE_CHARS },
            },
            required: [
              "coveredMessageIndices",
              "latestMessageIndex",
              "latestRequestPreserved",
              "activeConstraintsPreserved",
              "activePlanOrTaskPreserved",
              "unresolvedErrorsPreserved",
              "currentWorkPreserved",
              "nextStepPreserved",
              "note",
            ],
          },
        },
        required: [
          "formatVersion",
          "primaryRequest",
          "activeConstraints",
          "technicalDecisions",
          "filesAndChanges",
          "verifiedResults",
          "errorsAndBlockers",
          "pendingWork",
          "currentWork",
          "nextStep",
          "evidenceRefs",
          "intentLedger",
          "coverageCheck",
        ],
      }),
    },
  };

  async execute(input: unknown, _context: ToolContext): Promise<ToolExecutionResult> {
    try {
      const parsed = this.inputSchema.parse(input);
      const summary = buildPersistedSummary(parsed);
      if (summary.length > MAX_CONTEXT_SUMMARY_CHARS) {
        throw new Error(
          `Structured context summary exceeds ${MAX_CONTEXT_SUMMARY_CHARS} characters`,
        );
      }
      return {
        ok: true,
        summary: "The cumulative context summary was accepted.",
        data: { formatVersion: 2, summaryChars: summary.length },
        contextCompaction: {
          summary,
          formatVersion: 2,
          intentLedger: copyIntentLedger(parsed),
          coverageCheck: copyCoverageCheck(parsed.coverageCheck),
        },
      };
    } catch (error) {
      return toolFailure(error, "Unable to compact context");
    }
  }
}
