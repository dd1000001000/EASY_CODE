import type {
  ProviderName,
  ThinkingEffort,
} from "../core/types.js";
import { providerCatalogEntry, resolveCatalogModel } from "./catalog.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";

export type ProviderThinkingParameters = Record<string, never>;

export const THINKING_EFFORT_BUDGET_MULTIPLIERS: Readonly<Record<ThinkingEffort, number>> = {
  none: 1,
  low: 1,
  medium: 1,
  high: 2,
};

/**
 * Context pressure is independent of reasoning depth. A deeper reasoning
 * setting may use more model steps, but it must not postpone compaction and
 * allow the fixed recent-message working set to evict history first.
 */
export const THINKING_EFFORT_CONTEXT_LIMIT_MULTIPLIERS: Readonly<
  Record<ThinkingEffort, number>
> = {
  none: 1,
  low: 1,
  medium: 1,
  high: 1,
};

export const DEFAULT_BASE_STEP_LIMIT = DEFAULT_RUNTIME_LIMITS.steps.none;
export const DEFAULT_BASE_CONTEXT_CHAR_LIMIT = DEFAULT_RUNTIME_LIMITS.maxContextChars;
export const THINKING_EFFORT_TIMEOUT_MS = DEFAULT_RUNTIME_LIMITS.providerTimeoutMs;

export const THINKING_EFFORT_STEP_LIMITS = DEFAULT_RUNTIME_LIMITS.steps;

/** Scale a configurable none/low budget for the selected thinking effort. */
export function thinkingEffortBudget(
  effort: ThinkingEffort,
  baseBudget: number,
): number {
  if (!Number.isSafeInteger(baseBudget) || baseBudget < 1) {
    throw new RangeError("baseBudget must be a positive safe integer");
  }
  const budget = baseBudget * THINKING_EFFORT_BUDGET_MULTIPLIERS[effort];
  if (!Number.isSafeInteger(budget)) {
    throw new RangeError("scaled thinking-effort budget exceeds the safe integer range");
  }
  return budget;
}

/** Return the step limit derived from the configurable none/low base limit. */
export function thinkingEffortStepLimit(
  effort: ThinkingEffort,
  baseStepLimit = DEFAULT_BASE_STEP_LIMIT,
): number {
  return thinkingEffortBudget(effort, baseStepLimit);
}

/** Return the common context character limit used by every thinking effort. */
export function thinkingEffortContextCharLimit(
  effort: ThinkingEffort,
  baseContextCharLimit = DEFAULT_BASE_CONTEXT_CHAR_LIMIT,
): number {
  if (!Number.isSafeInteger(baseContextCharLimit) || baseContextCharLimit < 1) {
    throw new RangeError("baseContextCharLimit must be a positive safe integer");
  }
  const budget =
    baseContextCharLimit * THINKING_EFFORT_CONTEXT_LIMIT_MULTIPLIERS[effort];
  if (!Number.isSafeInteger(budget)) {
    throw new RangeError("context character limit exceeds the safe integer range");
  }
  return budget;
}

/** Return the default provider request timeout for the selected effort. */
export function thinkingEffortTimeoutMs(
  effort: ThinkingEffort,
): number {
  return THINKING_EFFORT_TIMEOUT_MS[effort];
}

/** Whether EASY CODE can translate this exact selection into documented API fields. */
export function thinkingEffortIsApplied(
  provider: ProviderName,
  model: string,
  effort: ThinkingEffort,
): boolean {
  return effort !== "none" &&
    providerCatalogEntry(provider).wireApi === "responses" &&
    Boolean(resolveCatalogModel(provider, model)?.reasoning);
}

/** Build only fields documented for the exact provider/model combination. */
export function thinkingRequestParameters(
  _provider: ProviderName,
  _model: string,
  _effort: ThinkingEffort | undefined,
): ProviderThinkingParameters {
  // Chat Completions dialects do not share a portable reasoning contract.
  // EASY CODE therefore lets those providers use their defaults. The generic
  // Responses driver serializes the standardized `reasoning.effort` field.
  return {};
}
