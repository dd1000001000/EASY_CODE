import { z } from "zod";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { parseSemanticRequestPatch } from "../context/semantic-compaction.js";
import type {
  AgentTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../core/types.js";
import { toolFailure } from "./base.js";
import { documentToolSchema } from "./metadata.js";

/** Only V3 semantic content crosses the model boundary. */
export class CompactContextTool implements AgentTool {
  readonly name = "compact_context" as const;
  readonly mutating = false;
  constructor(private readonly limits = DEFAULT_RUNTIME_LIMITS) {}
  get inputSchema() { return z.unknown().transform(value => parseSemanticRequestPatch(value, this.limits.contextSemanticFieldMaxChars)); }
  get definition(): ToolDefinition { return {
    type: "function",
    function: { name: this.name, ...documentToolSchema(this.name, {
  type: "object", additionalProperties: false,
  properties: {
    currentWork: { type: "string", minLength: 1, maxLength: this.limits.contextSemanticFieldMaxChars },
    decisions: { type: "array", maxItems: 32, items: { type: "string", maxLength: this.limits.contextSemanticFieldMaxChars } },
    conclusions: { type: "array", maxItems: 32, items: {
      type: "object", additionalProperties: false, properties: {
        text: { type: "string", minLength: 1, maxLength: this.limits.contextSemanticFieldMaxChars },
        evidenceIds: { type: "array", maxItems: 12, items: { type: "string", pattern: "^ev_[a-f0-9]{24}$" } },
      }, required: ["text"],
    } },
    hypotheses: { type: "array", maxItems: 32, items: { type: "string", maxLength: this.limits.contextSemanticFieldMaxChars } },
    failedApproaches: { type: "array", maxItems: 32, items: { type: "string", maxLength: this.limits.contextSemanticFieldMaxChars } },
    nextStep: { type: "string", minLength: 1, maxLength: this.limits.contextSemanticFieldMaxChars },
  },
}) },
  }; }
  async execute(input: unknown, _context: ToolContext): Promise<ToolExecutionResult> {
    try {
      const patch = this.inputSchema.parse(input);
      return { ok: true, summary: "Semantic candidate patch received; Runtime has not committed compaction.",
        data: { formatVersion: 3 }, contextCompaction: { formatVersion: 3, summary: JSON.stringify(patch) } };
    } catch (error) {
      return toolFailure(error, "Unable to parse semantic compaction patch");
    }
  }
}
