import type {
  ContextCompactionMetadata,
  ContextCompactionRequest,
  ContextIntentLedger,
  ContextSourceQuote,
  SessionState,
} from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { activeTask } from "../tasks/task-graph.js";
import { sha256 } from "../utils/hash.js";
import type { CompactionBenefitEvaluation } from "./compaction-policy.js";
import { unresolvedCommands } from "./runtime-state.js";

const RUNTIME_COMPACTION_MESSAGE = /^RUNTIME_CONTEXT_(?:COMPACTION|PRESSURE)/u;

export interface CompactionIntegrityResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly intentLedger?: ContextIntentLedger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceMessage(
  state: Readonly<SessionState>,
  source: Readonly<ContextSourceQuote>,
  sourceEndMessageIndex: number,
): string | undefined {
  if (
    !Number.isInteger(source.sourceMessageIndex) ||
    source.sourceMessageIndex < 0 ||
    source.sourceMessageIndex >= sourceEndMessageIndex
  ) return undefined;
  const message = state.messages[source.sourceMessageIndex];
  if (!message || message.role !== "user") return undefined;
  return redactSensitiveInformation(message.content);
}

function quoteIsExact(
  state: Readonly<SessionState>,
  source: Readonly<ContextSourceQuote>,
  sourceEndMessageIndex: number,
): boolean {
  const content = sourceMessage(state, source, sourceEndMessageIndex);
  return Boolean(content && source.text.trim() && content.includes(source.text));
}

function latestUserMessageIndex(
  state: Readonly<SessionState>,
  sourceEndMessageIndex: number,
): number {
  for (
    let index = Math.min(sourceEndMessageIndex, state.messages.length) - 1;
    index >= 0;
    index -= 1
  ) {
    const message = state.messages[index];
    if (
      message?.role === "user" &&
      message.content.trim() &&
      !RUNTIME_COMPACTION_MESSAGE.test(message.content.trimStart())
    ) return index;
  }
  return -1;
}

function sourceKey(source: Readonly<ContextSourceQuote>): string {
  return `${source.sourceMessageIndex}\u0000${source.text}`;
}

function sameSourceQuote(
  left: Readonly<ContextSourceQuote>,
  right: Readonly<ContextSourceQuote>,
): boolean {
  return left.sourceMessageIndex === right.sourceMessageIndex &&
    left.text === right.text;
}

function containsEverySourceQuote(
  actual: readonly ContextSourceQuote[],
  expected: readonly ContextSourceQuote[],
): boolean {
  const actualKeys = new Set(actual.map(sourceKey));
  return expected.every((source) => actualKeys.has(sourceKey(source)));
}

function uniqueSources(sources: readonly ContextSourceQuote[]): boolean {
  return new Set(sources.map(sourceKey)).size === sources.length;
}

function collectEvidenceReferenceIds(summary: Record<string, unknown>): {
  declared: Set<string>;
  used: string[];
} {
  const declared = new Set<string>();
  const evidenceRefs = summary.evidenceRefs;
  if (Array.isArray(evidenceRefs)) {
    for (const item of evidenceRefs) {
      if (isRecord(item) && typeof item.id === "string") declared.add(item.id);
    }
  }
  const used: string[] = [];
  for (const key of [
    "technicalDecisions",
    "filesAndChanges",
    "verifiedResults",
    "errorsAndBlockers",
  ]) {
    const items = summary[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!isRecord(item) || !Array.isArray(item.evidenceRefIds)) continue;
      for (const id of item.evidenceRefIds) {
        if (typeof id === "string") used.push(id);
      }
    }
  }
  return { declared, used };
}

/**
 * Verify semantic anchors against immutable source messages. The model may
 * summarize conclusions, but it cannot invent the text or provenance of user
 * intent that Runtime pins across compactions.
 */
export function validateCompactionIntegrity(input: {
  readonly state: Readonly<SessionState>;
  readonly request: Readonly<ContextCompactionRequest>;
  readonly sourceEndMessageIndex: number;
}): CompactionIntegrityResult {
  const errors: string[] = [];
  if (
    input.request.formatVersion !== 2 ||
    !input.request.coverageCheck ||
    !input.request.intentLedger
  ) {
    return { ok: false, errors: ["structured_compaction_v2_required"] };
  }
  const coverage = input.request.coverageCheck;
  const ledger = input.request.intentLedger;
  const latestIndex = latestUserMessageIndex(input.state, input.sourceEndMessageIndex);
  const pinnedPrimary = input.state.contextIntentLedger?.latestRequest;
  const expectedPrimary = pinnedPrimary && quoteIsExact(
    input.state,
    pinnedPrimary,
    input.sourceEndMessageIndex,
  )
    ? pinnedPrimary
    : undefined;
  if (latestIndex < 0) errors.push("latest_user_request_missing");
  if (coverage.latestMessageIndex !== latestIndex) {
    errors.push("latest_message_index_mismatch");
  }
  if (
    expectedPrimary
      ? !sameSourceQuote(ledger.latestRequest, expectedPrimary)
      : ledger.latestRequest.sourceMessageIndex !== latestIndex
  ) {
    errors.push("latest_request_source_mismatch");
  }

  const expectedLedger = input.state.contextIntentLedger;
  if (expectedLedger) {
    if (!containsEverySourceQuote(
      ledger.activeConstraints,
      expectedLedger.activeConstraints,
    )) errors.push("active_constraint_ledger_incomplete");
    if (!containsEverySourceQuote(
      ledger.userCorrections,
      expectedLedger.userCorrections,
    )) errors.push("user_correction_ledger_incomplete");
    if (!containsEverySourceQuote(
      ledger.supersededRequests,
      expectedLedger.supersededRequests,
    )) errors.push("superseded_request_ledger_incomplete");
  }

  const allSources = [
    ledger.latestRequest,
    ...ledger.activeConstraints,
    ...ledger.userCorrections,
    ...ledger.supersededRequests,
  ];
  for (const source of allSources) {
    if (!quoteIsExact(input.state, source, input.sourceEndMessageIndex)) {
      errors.push(`invalid_source_quote:${source.sourceMessageIndex}`);
    }
  }
  if (!uniqueSources(allSources)) errors.push("duplicate_intent_source_quote");

  const covered = new Set(coverage.coveredMessageIndices);
  if (latestIndex >= 0 && !covered.has(latestIndex)) {
    errors.push(`uncovered_latest_user_message:${latestIndex}`);
  }
  for (const source of allSources) {
    if (!covered.has(source.sourceMessageIndex)) {
      errors.push(`uncovered_intent_source:${source.sourceMessageIndex}`);
    }
  }
  for (const [name, value] of Object.entries({
    latestRequestPreserved: coverage.latestRequestPreserved,
    activeConstraintsPreserved: coverage.activeConstraintsPreserved,
    activePlanOrTaskPreserved: coverage.activePlanOrTaskPreserved,
    unresolvedErrorsPreserved: coverage.unresolvedErrorsPreserved,
    currentWorkPreserved: coverage.currentWorkPreserved,
    nextStepPreserved: coverage.nextStepPreserved,
  })) {
    if (!value) errors.push(`coverage_not_confirmed:${name}`);
  }

  let summary: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(input.request.summary) as unknown;
    if (isRecord(parsed)) summary = parsed;
  } catch {
    // Tool validation should make this impossible, but Runtime remains the
    // final authority at the persistence boundary.
  }
  if (!summary || summary.formatVersion !== 2) {
    errors.push("invalid_persisted_summary_v2");
  } else {
    const references = collectEvidenceReferenceIds(summary);
    for (const id of references.used) {
      if (!references.declared.has(id)) errors.push(`unknown_evidence_ref:${id}`);
    }
    const activeConstraints = summary.activeConstraints;
    if (!Array.isArray(activeConstraints) ||
        activeConstraints.length !== ledger.activeConstraints.length) {
      errors.push("active_constraint_ledger_mismatch");
    }
    if (input.state.constraints.some(
      (constraint) => !input.request.summary.includes(
        redactSensitiveInformation(constraint).slice(0, 1_000),
      ),
    )) {
      errors.push("runtime_constraint_missing");
    }
    if (
      input.state.planReview &&
      !input.request.summary.includes(input.state.planReview.proposal.id)
    ) {
      errors.push("active_plan_missing_from_summary");
    }
    if (input.state.taskGraph?.status !== undefined &&
        input.state.taskGraph.status !== "completed") {
      const currentTask = activeTask(input.state.taskGraph);
      if (!input.request.summary.includes(input.state.taskGraph.id)) {
        errors.push("active_task_graph_missing_from_summary");
      }
      if (currentTask && !input.request.summary.includes(currentTask.id)) {
        errors.push("active_task_missing_from_summary");
      }
    }
    if (
      input.state.taskGraph?.status === "blocked" &&
      (!Array.isArray(summary.errorsAndBlockers) || summary.errorsAndBlockers.length === 0)
    ) {
      errors.push("blocked_task_missing_from_summary");
    }
    for (const command of unresolvedCommands(input.state)) {
      if (
        !Array.isArray(summary.errorsAndBlockers) ||
        summary.errorsAndBlockers.length === 0 ||
        !input.request.summary.includes(command.id)
      ) errors.push("unresolved_command_missing_from_summary");
    }
    // Free-text prose cannot prove a test passed. Require a resolvable durable
    // locator for any claimed verified result; Runtime continuity remains the
    // authority for command outcomes and pending experiments.
    const refs = Array.isArray(summary.evidenceRefs) ? summary.evidenceRefs.filter(isRecord) : [];
    if (Array.isArray(summary.verifiedResults)) for (const item of summary.verifiedResults) {
      if (!isRecord(item) || !Array.isArray(item.evidenceRefIds) || !item.evidenceRefIds.length) {
        errors.push("verified_result_without_evidence");
        continue;
      }
      for (const id of item.evidenceRefIds) {
        const ref = refs.find((candidate) => candidate.id === id);
        const locator = typeof ref?.reference === "string" ? ref.reference : "";
        const message = /^message:(\d+)$/u.exec(locator);
        const command = /^command:(.+)$/u.exec(locator);
        const source = message ? input.state.messages[Number(message[1])] : undefined;
        const validMessage = source?.role === "tool" && Number(message?.[1]) < input.sourceEndMessageIndex;
        const validCommand = command && input.state.commands.some((entry) => entry.id === command[1]);
        if (!validMessage && !validCommand) errors.push("unresolvable_verified_evidence");
      }
    }
  }

  return errors.length > 0
    ? { ok: false, errors: [...new Set(errors)] }
    : {
        ok: true,
        errors: [],
        intentLedger: {
          latestRequest: { ...ledger.latestRequest },
          activeConstraints: ledger.activeConstraints.map((item) => ({ ...item })),
          userCorrections: ledger.userCorrections.map((item) => ({ ...item })),
          supersededRequests: ledger.supersededRequests.map((item) => ({ ...item })),
        },
      };
}

export function createCompactionMetadata(input: {
  readonly state: Readonly<SessionState>;
  readonly sourceStartMessageIndex: number;
  readonly sourceEndMessageIndex: number;
  readonly compactedMessageCount: number;
  readonly benefit: Readonly<CompactionBenefitEvaluation>;
  readonly acceptedAt?: string;
}): ContextCompactionMetadata {
  const source = JSON.stringify(
    input.state.messages.slice(0, input.sourceEndMessageIndex),
  );
  return {
    formatVersion: 2,
    sourceStartMessageIndex: input.sourceStartMessageIndex,
    sourceEndMessageIndex: input.sourceEndMessageIndex,
    compactedMessageCount: input.compactedMessageCount,
    sourceHistoryHash: `sha256:${sha256(source)}`,
    acceptedAt: input.acceptedAt ?? new Date().toISOString(),
    beforeProjectedChars: input.benefit.beforeProjectedChars,
    afterProjectedChars: input.benefit.afterProjectedChars,
    savedChars: input.benefit.savedChars,
    savingsRatio: input.benefit.savingsRatio,
    postCompactionUtilization: input.benefit.postCompactionUtilization,
    safeWaterlineReached: input.benefit.safeWaterlineReached,
    ...(input.benefit.targetRatio !== undefined ? { targetRatio: input.benefit.targetRatio } : {}),
  };
}
