import { z } from "zod";
import defaults from "./runtime-defaults.json" with { type: "json" };

const integer = (min: number, max: number) => z.number().int().min(min).max(max);
/** Operational budgets. Parser/security ceilings remain non-configurable. */
export const runtimeLimitsSchema = z.object({
  steps: z.object({ none: integer(1, 1000), low: integer(1, 1000),
    medium: integer(1, 1000), high: integer(1, 1000) }).strict(),
  maxContextChars: integer(4096, 2000000),
  maxActiveContextChars: integer(4096, 2000000),
  maxContextTokens: z.union([z.literal(0), integer(4096, 2000000)]),
  maxOutputChars: integer(1024, 1000000),
  maxToolResultChars: integer(1024, 1000000),
  commandTimeoutMs: integer(1, 1200000),
  maxManagedWorktrees: integer(1, 200),
  maxConcurrentSubagents: z.object({ none: integer(1, 16), low: integer(1, 16),
    medium: integer(1, 16), high: integer(1, 16) }).strict(),
  maxSubagentsPerTurn: integer(1, 128),
  maxSubagentFollowUps: integer(0, 32),
  maxDagNodes: integer(1, 32),
  maxModelRequests: integer(1, 10000),
  maxTaskTokens: integer(0, Number.MAX_SAFE_INTEGER),
  // Local output reservation; never a server generation limit.
  maxResponseTokens: integer(256, 131072),
  providerResponseMaxBytes: integer(1048576, 67108864),
  providerTimeoutMs: z.object({ none: integer(1000, 3600000), low: integer(1000, 3600000),
    medium: integer(1000, 3600000), high: integer(1000, 3600000) }).strict(),
  maxProviderRetries: integer(0, 10),
  // Retry counts exclude the initial attempt. Shared by every agent role.
  modelContentRetries: integer(0, 2),
  sandboxInitializationRetries: integer(0, 1),
  // Replaying effects or treating unfinished work as complete is never a recovery.
  commandExecutionRetries: z.literal(0),
  subagentFailureRetries: z.literal(0),
  prematureFinishRetries: z.literal(0),
  providerRetryWaitMs: integer(0, 60000),
  defaultReadLines: integer(1, 10000),
  maxReadLines: integer(1, 10000),
  maxReadResultTokens: integer(256, 100000),
  memoryAutoTokens: integer(0, 32000),
  memoryRecallTokens: integer(0, 32000),
  memoryMaxItems: integer(0, 30),
  memoryMaxQueries: integer(1, 4),
  memorySearchLimit: integer(1, 20),
  memoryMinRelevantTerms: integer(0, 10),
  maxDurableMemoryTokens: integer(64, 4000),
  searchMaxEntries: integer(1, 100000),
  searchMaxDepth: integer(1, 256),
  searchRepeatWarningCount: integer(2, 20),
  searchMaxFileBytes: integer(1024, 10485760),
  searchMaxBytes: integer(1024, 268435456),
  searchMaxMatches: integer(1, 500),
  searchContextLines: integer(0, 10),
  searchMaxResultTokens: integer(256, 16000),
  commandQueryChars: integer(256, 1000000),
  commandMaxDiagnostics: integer(1, 50),
  commandSuccessChars: integer(256, 1000000),
  commandFailureChars: integer(256, 1000000),
  commandPollWaitMs: integer(0, 1200000),
  compactionRetainRecentExchanges: integer(1, 64),
  contextReferenceTriggerRatio: z.number().min(0.5).max(0.9),
  contextReferenceTargetRatio: z.number().min(0.2).max(0.8),
  contextRecallProtectionExchanges: integer(1, 10),
  reviewMaxRounds: integer(1, 5),
  reviewMaxRequests: integer(4, 200),
  reviewMaxToolCalls: integer(0, 100),
  reviewTimeoutMs: integer(1000, 3600000),
  reviewSummaryTimeoutMs: integer(1000, 300000),
  reviewSnapshotMaxBytes: integer(1024, 1073741824),
  reviewDependencyMaxBytes: integer(1024, 4294967296),
  reviewDependencyMaxFiles: integer(100, 1000000),
  reviewPreparationTimeoutMs: integer(1000, 1200000),
  reviewSummaryMaxTokens: integer(256, 2048),
  reviewMaxSessionsPerTask: integer(1, 10),
  contextCompactionTriggerRatio: z.number().min(0.5).max(0.9),
  contextCompactionTargetRatio: z.number().min(0.2).max(0.8),
  contextCompactionMinGrowthRatio: z.number().min(0.01).max(0.3),
  contextMaxRebasesPerRequest: integer(0, 1),
  contextMaxCapacityRetries: integer(0, 1),
  contextSummaryMaxTokens: integer(256, 2048),
  contextToolBatchTokens: integer(512, 100000),
  contextToolReferenceMinChars: integer(512, 1000000),
  reviewerOutputTokens: integer(256, 6144),
  approvalInputChars: integer(2048, 128000),
  approvalOutputTokens: integer(256, 4096),
  approvalTimeoutMs: integer(1000, 300000),
  validationBaselineMaxFiles: integer(16, 16000),
  validationScanMaxEntries: integer(100, 200000),
  validationScanMaxBytes: integer(1024, 268435456),
  progressInvestigationMinSamples: integer(5, 64),
  progressInvestigationRepeatRatio: z.number().min(0.5).max(1),
  progressInvestigationWindowResponses: integer(4, 64),
  progressInvestigationReviewEnabled: z.boolean(),
  contextOutputReserveRatio: z.number().min(0.01).max(0.4),
  contextToolReserveTokens: integer(0, 131072),
  contextToolReserveRatio: z.number().min(0).max(0.2),
  contextSafetyReserveTokens: integer(128, 131072),
  contextSafetyReserveRatio: z.number().min(0.01).max(0.2),
}).strict().superRefine((value, context) => {
  if (value.contextReferenceTargetRatio >= value.contextReferenceTriggerRatio) context.addIssue({
    code: "custom", path: ["contextReferenceTargetRatio"], message: "Reference target must be below trigger" });
  if (value.contextCompactionTargetRatio >= value.contextCompactionTriggerRatio) context.addIssue({
    code: "custom", path: ["contextCompactionTargetRatio"], message: "Compaction target must be below trigger" });
  if (value.memoryRecallTokens < value.memoryAutoTokens) context.addIssue({ code: "custom",
    path: ["memoryRecallTokens"], message: "must not be smaller than memoryAutoTokens" });
  if (value.defaultReadLines > value.maxReadLines) context.addIssue({ code: "custom",
    path: ["defaultReadLines"], message: "must not exceed maxReadLines" });
  if (value.maxContextTokens && value.contextSafetyReserveTokens >= value.maxContextTokens / 2) {
    context.addIssue({ code: "custom", path: ["contextSafetyReserveTokens"], message: "must leave room for model input and output" });
  }
});
export type RuntimeLimits = z.infer<typeof runtimeLimitsSchema>;
export const DEFAULT_RUNTIME_LIMITS: Readonly<RuntimeLimits> = Object.freeze(runtimeLimitsSchema.parse(defaults));
export function defaultRuntimeLimits(): RuntimeLimits {
  return { ...DEFAULT_RUNTIME_LIMITS, steps: { ...DEFAULT_RUNTIME_LIMITS.steps },
    maxConcurrentSubagents: { ...DEFAULT_RUNTIME_LIMITS.maxConcurrentSubagents },
    providerTimeoutMs: { ...DEFAULT_RUNTIME_LIMITS.providerTimeoutMs } };
}
