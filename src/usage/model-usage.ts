import type {
  ModelUsagePurpose,
  ModelUsageRecord,
  ProviderUsage,
} from "../core/types.js";

export interface ModelUsageTotals {
  requests: number;
  reportedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export interface ModelUsageSummary extends ModelUsageTotals {
  unreportedRequests: number;
  retryRequests: number;
  uncachedInputTokens: number;
  byPurpose: Record<ModelUsagePurpose, ModelUsageTotals>;
  byActor: {
    mainAgent: ModelUsageTotals;
    subagents: ModelUsageTotals;
  };
  /** Provider/model totals remain separate across in-session model switches. */
  byModel: Record<string, ModelUsageTotals>;
}

const PURPOSES: readonly ModelUsagePurpose[] = [
  "auto_route",
  "agent_step",
  "context_compaction",
];
const PROVIDERS = new Set(["qwen", "deepseek", "glm"]);

function safeLabel(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/iu.test(value)
  );
}

function emptyTotals(): ModelUsageTotals {
  return {
    requests: 0,
    reportedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function parseUsage(value: unknown): ProviderUsage | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const usage: ProviderUsage = {};
  for (const [key, outputKey] of [
    ["promptTokens", "promptTokens"],
    ["completionTokens", "completionTokens"],
    ["totalTokens", "totalTokens"],
    ["cachedInputTokens", "cachedInputTokens"],
    ["reasoningTokens", "reasoningTokens"],
  ] as const) {
    if (!(key in input)) continue;
    // Provider adapters construct a normalized object whose unsupported
    // optional fields can still exist with value undefined before JSON
    // serialization. Treat those exactly like omitted fields.
    if (input[key] === undefined) continue;
    const parsed = nonNegativeInteger(input[key]);
    if (parsed === undefined) return undefined;
    usage[outputKey] = parsed;
  }
  return Object.keys(usage).length ? usage : undefined;
}

/** Parse an untrusted journal payload without accepting forged accounting data. */
export function parseModelUsageRecord(value: unknown): ModelUsageRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    (input.actor !== "main_agent" && input.actor !== "subagent") ||
    !PURPOSES.includes(input.purpose as ModelUsagePurpose) ||
    !safeLabel(input.provider, 32) ||
    !PROVIDERS.has(input.provider) ||
    !safeLabel(input.model) ||
    !safeLabel(input.turnId) ||
    typeof input.retry !== "boolean"
  ) {
    return undefined;
  }
  const step = input.step === undefined ? undefined : nonNegativeInteger(input.step);
  const attempt = input.attempt === undefined
    ? undefined
    : nonNegativeInteger(input.attempt);
  if (
    (input.step !== undefined && (step === undefined || step < 1)) ||
    (input.attempt !== undefined && (attempt === undefined || attempt < 1))
  ) {
    return undefined;
  }
  const usage = parseUsage(input.usage);
  if (input.usage !== undefined && usage === undefined) return undefined;
  if (
    input.sourceAgentId !== undefined &&
    !safeLabel(input.sourceAgentId)
  ) {
    return undefined;
  }
  if (
    input.sourceTaskId !== undefined &&
    !safeLabel(input.sourceTaskId)
  ) {
    return undefined;
  }
  return {
    actor: input.actor,
    purpose: input.purpose as ModelUsagePurpose,
    provider: input.provider as ModelUsageRecord["provider"],
    model: input.model,
    turnId: input.turnId,
    retry: input.retry,
    ...(step !== undefined ? { step } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof input.sourceAgentId === "string"
      ? { sourceAgentId: input.sourceAgentId }
      : {}),
    ...(typeof input.sourceTaskId === "string"
      ? { sourceTaskId: input.sourceTaskId }
      : {}),
  };
}

function addUsage(target: ModelUsageTotals, record: Readonly<ModelUsageRecord>): void {
  target.requests += 1;
  const usage = record.usage;
  if (!usage || Object.values(usage).every((value) => value === undefined)) return;
  target.reportedRequests += 1;
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += usage.totalTokens ?? prompt + completion;
  target.cachedInputTokens += usage.cachedInputTokens ?? 0;
  target.reasoningTokens += usage.reasoningTokens ?? 0;
}

export function aggregateModelUsage(
  records: readonly Readonly<ModelUsageRecord>[],
): ModelUsageSummary {
  const totals = emptyTotals();
  const byPurpose: Record<ModelUsagePurpose, ModelUsageTotals> = {
    auto_route: emptyTotals(),
    agent_step: emptyTotals(),
    context_compaction: emptyTotals(),
  };
  const byActor = {
    mainAgent: emptyTotals(),
    subagents: emptyTotals(),
  };
  const byModel: Record<string, ModelUsageTotals> = {};
  let retryRequests = 0;
  for (const record of records) {
    addUsage(totals, record);
    addUsage(byPurpose[record.purpose], record);
    addUsage(record.actor === "main_agent" ? byActor.mainAgent : byActor.subagents, record);
    const modelKey = `${record.provider}/${record.model}`;
    const modelTotals = byModel[modelKey] ?? (byModel[modelKey] = emptyTotals());
    addUsage(modelTotals, record);
    if (record.retry) retryRequests += 1;
  }
  return {
    ...totals,
    unreportedRequests: totals.requests - totals.reportedRequests,
    retryRequests,
    uncachedInputTokens: Math.max(0, totals.promptTokens - totals.cachedInputTokens),
    byPurpose,
    byActor,
    byModel,
  };
}
