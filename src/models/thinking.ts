import type {
  ProviderName,
  ThinkingEffort,
} from "../core/types.js";
import { resolveCatalogModel, type ThinkingProfile } from "./catalog.js";

export interface ProviderThinkingParameters {
  enable_thinking?: boolean;
  thinking_budget?: number;
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: "low" | "medium" | "high";
}

const QWEN_THINKING_BUDGETS: Readonly<Record<Exclude<ThinkingEffort, "none">, number>> = {
  low: 4_096,
  medium: 16_384,
  high: 32_768,
};

/** Whether EASY CODE can translate this exact selection into documented API fields. */
export function thinkingEffortIsApplied(
  provider: ProviderName,
  model: string,
  effort: ThinkingEffort,
): boolean {
  const profile = resolveCatalogModel(provider, model)?.thinking ?? "unsupported";
  return profile !== "unsupported" &&
    !(profile === "glm_forced_effort" && effort === "none");
}

/** Build only fields documented for the exact provider/model combination. */
export function thinkingRequestParameters(
  provider: ProviderName,
  model: string,
  effort: ThinkingEffort | undefined,
): ProviderThinkingParameters {
  if (!effort) return {};
  const profile = resolveCatalogModel(provider, model)?.thinking ?? "unsupported";
  switch (profile) {
    case "qwen_budget":
      return effort === "none"
        ? { enable_thinking: false }
        : {
            enable_thinking: true,
            thinking_budget: QWEN_THINKING_BUDGETS[effort],
          };
    case "deepseek_effort":
      return effort === "none"
        ? { thinking: { type: "disabled" } }
        : {
            thinking: { type: "enabled" },
            // DeepSeek accepts medium for compatibility but treats it as high.
            reasoning_effort: effort === "medium" ? "high" : effort,
          };
    case "glm_forced_effort":
      if (effort === "none") return {};
      return {
        thinking: { type: "enabled" },
        // GLM 5.3 accepts low/high/max, so EASY CODE's medium maps to high.
        reasoning_effort: effort === "medium" ? "high" : effort,
      };
    case "glm_optional_effort":
      return effort === "none"
        ? { thinking: { type: "disabled" } }
        : {
            thinking: { type: "enabled" },
            reasoning_effort: effort,
          };
    case "unsupported":
      return {};
    default:
      return assertNeverProfile(profile);
  }
}

function assertNeverProfile(profile: never): ProviderThinkingParameters {
  throw new Error(`Unsupported thinking profile: ${String(profile)}`);
}
