import { foldDelivery, newDelivery, pendingDelivery } from "../review/delivery.js";
import {
  MAX_MEMORY_MUTATIONS_PER_TURN,
  type AgentMode,
  type AgentRole,
  type AgentReasoningNotification,
  type AgentRunResult,
  type AgentTool,
  type ApprovalHandler,
  type ChatMessage,
  type CommandAuditEntry,
  type CommandExecutionMode,
  type EventRecord,
  type ImageAttachment,
  type LongTermMemory,
  type MemoryMutationRequest,
  type ModelUsagePurpose,
  type ModelUsageRecord,
  type ModelProvider,
  type PlanProposal,
  type PlanReviewState,
  type SessionState,
  type SubagentLifecycleUpdate,
  type SubagentAssignmentSnapshot,
  type SubagentTaskReport,
  type TaskGraph,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolName,
  type TurnSteeringBatch,
  type TurnSteeringBoundary,
} from "../core/types.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { TaskBudgetExceeded } from "./task-budget.js";
import { completeWithApiRetries, markRetryManaged, isContextCapacityError, incompleteModelOutput } from "./model-retry.js";
import { resetServerContext, resetRequestHistory, resetStateRequest } from "../context/server-reset.js";
import { recordUserRequirement } from "../context/user-requirements.js";
import { reconciliationPending, reconciliationGate, reconciliationObservation } from "../context/reconciliation.js";
import { failureCategory } from "./failure-policy.js";
import { CommandRetryTracker } from "./command-retry.js";
import { ProviderError } from "../providers/errors.js";
import { setTimeout as delay } from "node:timers/promises";
import { projectToolResult } from "../tools/output-projection.js";
import { renderPinnedCurrentState, renderRetrievedContext, type ContextSearchHit } from "../context/artifact-index.js";
import { memoryQueries, memoryQueryKey, optionalMemoryTokenBudget, selectMemoryContext, expandedMemoryRecall, visibleMemoryText } from "../context/memory-controller.js";
import { foldMemoryGate } from "../context/pressure-recovery.js";
import { budgetedRequest, requestTokens } from "../context/token-budget.js";
import type { TokenCalibration } from "../context/token-calibration.js";
import { runCompactionTransaction, foldCompactionControl, completeExchange, investigationExchangeStart, type CompactionResult } from "../context/compaction-transaction.js";
import type { NormalRequestEnvelope } from "../context/context-request.js";
import { foldPendingOperations, pendingCommandObservation } from "../context/pending-operations.js";
import { parseSemanticRequestPatch, recallCompactionEvidence } from "../context/semantic-compaction.js";
import { recallThreadContext } from "../context/recall.js";
import { captureValidationBaseline } from "../progress/validation-standard.js";
import { matchesReviewExperiment } from "../progress/experiment.js";
import { RequestPrefixTracker } from "../context/request-prefix.js";
import {
  ContextManager,
  estimateToolDefinitionsChars,
  type ContextPressureLevel,
  type ProviderRequestContextInspection,
} from "../context/manager.js";
import {
  MAX_IMAGES_PER_MODEL_REQUEST,
  validateImageAttachmentCollection,
} from "../images/image-store.js";
import {
  assertThreadImageNumberAvailable,
  nextThreadImageNumber,
} from "../images/labels.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { validateProviderImageAttachments, effectiveContextWindow } from "../models/catalog.js";
import {
  clonePlanReviewState,
  createPlanReviewState,
  formatPlanProposal,
  returnPlanExecutionToReview,
  type PlanExecutionReturnOutcome,
} from "../plans/plan.js";
import { loadPromptBundleCatalog } from "../prompt-bundle/index.js";
import {
  commandVerificationKind,
  VERIFICATION_KINDS,
  type CommandIntent,
  type VerificationKind,
} from "../command/types.js";
import {
  activeTask,
  cloneTaskGraph,
  taskGraphOperationSchema,
  taskGraphView,
  validateTaskGraphTransition,
  subagentTaskOperationSchema,
  validateSubagentTaskTransition,
  type SubagentTaskTransitionOperation,
  type TaskGraphTransitionOperation,
} from "../tasks/task-graph.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hash.js";
import { safeJsonParse } from "../utils/json.js";
import {
  createProgressGuardState,
  foldProgressObservation,
} from "../progress/guard.js";
import { observeToolResult } from "../progress/observation.js";
import {
  foldProgressReviewEvent,
  interruptedProgressIncident,
  nextPendingProgressIncident,
  requestedProgressIncident,
  reviewAttemptUsedForScope,
  type ProgressReviewEventType,
} from "../progress/lifecycle.js";
import {
  progressReviewPacketDigest,
  runProgressReviewer,
  type ProgressReviewAccounting,
  type ProgressReviewBinding,
  type ProgressReviewModelRequestRecord,
} from "../progress/reviewer.js";
import type { ProgressIncident } from "../progress/types.js";
import {
  AutoRouteRequestError,
  AutoRouteSelectionError,
  determineAutoRoute,
  projectAutoRouteContext,
  type AutoRouteContext,
  type AutoRouteAttempt,
} from "./auto-router.js";
import { createProviderAttemptSignal } from "./provider-attempt-signal.js";
import type { TurnSteeringAttemptNotifier } from "./turn-steering-notifier.js";
import { toolFailure } from "../tools/base.js";
import {
  normalizeToolFailure, prepareToolInput, protocolToolFailure, toolResultForModel,
} from "../tools/errors.js";
import {
  ToolRecoveryBudget, ToolProtocolExhausted,
} from "./tool-recovery.js";
import { availableAgentTools, toolMetadata } from "../tools/capabilities.js";
import { snapshotToolSet, type ToolCatalogSnapshot } from "../tools/catalog.js";
import {
  ToolExecutionGateway,
  type ToolExecutionAuthorizer,
} from "../tools/execution-gateway.js";

function runtimePromptText(path: string): string {
  return loadPromptBundleCatalog().readText(path).trimEnd();
}

function renderRuntimePrompt(
  path: string,
  values: Readonly<Record<string, string | number | boolean>>,
): string {
  return loadPromptBundleCatalog().render(path, values).trimEnd();
}

function contextUtilizationPercent(utilization: number): string {
  // Never round a lower pressure band up to the next threshold in status text.
  // For example, 89.99% must remain visibly below the 90% force boundary.
  return (Math.floor(Math.max(0, utilization) * 1_000) / 10).toFixed(1);
}

function contextCapacityFailure(error: unknown, state: Readonly<SessionState>): AgentRunResult["failure"] {
  if (error instanceof TaskBudgetExceeded) return { code: "task_budget_exhausted", tool: "runtime", attempts: 0, recoverable: true };
  return isContextCapacityError(error)
    ? { code: "context_capacity_exhausted", tool: "runtime",
      attempts: state.compactionControl?.transaction?.attempts ?? 0, recoverable: true } : undefined;
}

export interface ProviderContextSnapshot {
  readonly threadId: string;
  readonly turnId: string;
  readonly actor: AgentRole;
  readonly purpose: ModelUsagePurpose;
  readonly provider: ModelProvider["name"];
  readonly model: string;
  readonly timestamp: string;
  readonly step?: number;
  readonly attempt: number;
  /** Monotonic Runtime decision used to choose the exposed capability set. */
  readonly enforcedPressure: ContextPressureLevel;
  readonly enforcedUtilization: number;
  /** Metrics for the exact messages and tool schemas passed to the provider. */
  readonly actualRequest: ProviderRequestContextInspection;
}

function sandboxUnavailableInstruction(role: AgentRole): string {
  return runtimePromptText(
    role === "subagent"
      ? "runtime/sandbox-paused-child.md"
      : "runtime/sandbox-paused-main.md",
  );
}

function sandboxPauseText(prefix = ""): string {
  const detail = prefix.trim();
  return renderRuntimePrompt("runtime/sandbox-pause-result.md", {
    prefix: detail ? `${detail}\n\n` : "",
  });
}

function backgroundCommandFinalizationInstruction(): string {
  return runtimePromptText("runtime/background-command-finalization-required.md");
}

function contextRetrievalQuery(
  state: Readonly<SessionState>,
  currentUserInput: string,
): string {
  const task = state.taskGraph ? activeTask(state.taskGraph) : undefined;
  const blockedTask = state.taskGraph?.tasks.find(
    (candidate) => candidate.status === "blocked",
  );
  const latestCommand = state.commands.at(-1);
  const latestFailedCommand = latestCommand && (
    latestCommand.status !== "exited" || latestCommand.exitCode !== 0
  )
    ? latestCommand
    : undefined;
  let latestToolFailure = "";
  const recentToolPathEvidence: string[] = [];
  const observedToolNames = new Set<string>();
  const earliestToolMessageIndex = Math.max(0, state.messages.length - 64);
  for (
    let index = state.messages.length - 1;
    index >= earliestToolMessageIndex;
    index -= 1
  ) {
    const message = state.messages[index];
    if (!message || message.role !== "tool") continue;
    const toolName = message.name ?? "unknown";
    const isLatestForTool = !observedToolNames.has(toolName);
    observedToolNames.add(toolName);
    try {
      const parsed = JSON.parse(message.content) as {
        ok?: unknown;
        summary?: unknown;
        error?: unknown;
        data?: unknown;
      };
      const data = parsed.data && typeof parsed.data === "object"
        ? parsed.data as Record<string, unknown>
        : undefined;
      const path = typeof data?.path === "string" ? data.path : "";
      const beforeHash = typeof data?.beforeHash === "string" ? data.beforeHash : "";
      const contentHash = typeof data?.contentHash === "string" ? data.contentHash : "";
      if (path && recentToolPathEvidence.length < 6) {
        recentToolPathEvidence.push([
          toolName,
          path,
          beforeHash ? `before=${beforeHash}` : "",
          contentHash ? `after=${contentHash}` : "",
        ].filter(Boolean).join(" "));
      }
      if (
        !latestToolFailure &&
        isLatestForTool &&
        (parsed.ok === false || typeof parsed.error === "string")
      ) {
        latestToolFailure = [
          `tool=${toolName}`,
          typeof parsed.summary === "string" ? parsed.summary : "",
          typeof parsed.error === "string" ? parsed.error : "",
          path ? `path=${path}` : "",
        ].filter(Boolean).join("\n").slice(0, 2_500);
      }
    } catch {
      // Opaque tool output remains available in recent conversation/RAG; only
      // structured evidence is promoted into the high-priority query fields.
    }
  }
  const latestFailure = [
    latestToolFailure,
    latestFailedCommand
      ? [
          `command=${latestFailedCommand.program}`,
          `status=${latestFailedCommand.status}`,
          `exitCode=${String(latestFailedCommand.exitCode)}`,
          latestFailedCommand.summary,
          `cwd=${latestFailedCommand.cwd}`,
        ].join("\n")
      : "",
    blockedTask?.blocker
      ? `blockedTask=${blockedTask.id}\n${blockedTask.blocker}`
      : "",
  ].filter(Boolean).join("\n\n").slice(0, 4_000);
  const diffAndPathEvidence = [
    ...state.changes.slice(-12).map((change) => [
      `${change.operation}:${change.path}`,
      `status=${change.status}`,
      change.beforeHash ? `before=${change.beforeHash}` : "",
      change.afterHash ? `after=${change.afterHash}` : "",
    ].filter(Boolean).join(" ")),
    ...recentToolPathEvidence,
    ...[...state.filesRead.values()].slice(-8).map(
      (file) => `read:${file.path} hash=${file.hash}`,
    ),
  ].join("\n").slice(0, 4_000);
  const recentConversation = state.messages
    .slice(-8)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => message.content?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
  return [
    currentUserInput.trim()
      ? `[CURRENT_REQUEST]\n${currentUserInput.trim().slice(0, 4_000)}`
      : "",
    state.goal?.trim()
      ? `[CURRENT_GOAL]\n${state.goal.trim().slice(0, 2_500)}`
      : "",
    state.constraints.length
      ? `[CURRENT_CONSTRAINTS]\n${state.constraints.join("\n").slice(0, 2_500)}`
      : "",
    task
      ? `[ACTIVE_TASK]\n${task.title}\n${task.description}\n` +
        `${task.completionChecks.join("\n")}\n${task.blocker ?? ""}`
      : "",
    latestFailure ? `[LATEST_FAILURE]\n${latestFailure}` : "",
    diffAndPathEvidence
      ? `[CURRENT_DIFF_AND_PATH_EVIDENCE]\n${diffAndPathEvidence}`
      : "",
    recentConversation ? `[RECENT_CONVERSATION]\n${recentConversation}` : "",
  ]
    .filter(Boolean)
    .map((section) => redactSensitiveInformation(section))
    .join("\n\n")
    .slice(0, 12_000);
}

function progressScopeKey(state: Readonly<SessionState>, turnId: string): string {
  const task = state.taskGraph ? activeTask(state.taskGraph) : undefined;
  return task
    ? `thread:${state.threadId}/task:${task.id}`
    : `thread:${state.threadId}/turn:${turnId}`;
}

function progressIntentRevision(state: Readonly<SessionState>): number {
  let latestUserIndex = -1;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    if (state.messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  return Math.max(
    latestUserIndex + 1,
    (state.steeringWatermark ?? 0) + 1,
    (state.contextIntentLedger?.latestRequest.sourceMessageIndex ?? -1) + 1,
  );
}

function progressReviewPacket(
  state: Readonly<SessionState>,
  incident: Readonly<ProgressIncident>,
  currentUserInput: string,
): string {
  const recentToolEvidence = state.messages
    .slice(-24)
    .filter((message) => message.role === "tool")
    .map((message) => `${message.name ?? "tool"}: ${message.content}`)
    .join("\n\n")
    .slice(0, 24_000);
  return redactSensitiveInformation([
    "[PROGRESS_INCIDENT]",
    JSON.stringify({
      incidentId: incident.incidentId,
      reason: incident.reason ?? "repeated_verified_failure",
      baselineDigest: incident.baselineDigest,
      scopeKey: incident.scopeKey,
      targetKey: incident.targetKey,
      outcomeClass: incident.outcomeClass,
      outcomeKey: incident.outcomeKey,
      verificationKind: incident.verificationKind ?? "custom",
      verificationCycleIds: incident.verificationCycleIds,
    }),
    "[CURRENT_RUNTIME_CONTEXT]",
    contextRetrievalQuery(state, currentUserInput),
    recentToolEvidence ? "[RECENT_TOOL_EVIDENCE]" : "",
    recentToolEvidence,
  ].filter(Boolean).join("\n\n")).slice(0, 64_000);
}

function progressRuntimeInstruction(
  state: Readonly<SessionState>,
  scopeKey: string,
): string {
  const guard = state.progressGuard;
  if (!guard) return "";
  const suspected = guard.incidents.find(item => item.scopeKey === scopeKey && item.phase === "investigation_suspected");
  if (suspected) return "Runtime observed repeated source/search evidence in a complete investigation window. This is a stagnation suspicion, not proof that the task is stuck. Propose and execute one minimal falsifiable experiment with expected and opposite outcomes. New filenames, summaries and thinking alone do not prove progress. Continued repetition in a separate window may request one read-only reviewer. Incident: " + suspected.incidentId;
  const incident = [...guard.incidents]
    .reverse()
    .find((candidate) =>
      candidate.scopeKey === scopeKey &&
      (
        candidate.phase === "experiment_required" ||
        candidate.phase === "strategy_adjustment" ||
        candidate.phase === "review_exhausted"
      )
    );
  if (incident?.phase === "experiment_required" && incident.reviewReport) {
    return renderRuntimePrompt("runtime/progress-experiment-required.md", {
      incidentId: incident.incidentId,
      diagnosis: incident.reviewReport.diagnosis,
      evidence: incident.reviewReport.evidence,
      experiment: incident.reviewReport.experiment + (incident.reviewReport.experimentProgram ?
        "\nExact experiment command (normal approval still applies): " + JSON.stringify({
          program: incident.reviewReport.experimentProgram, args: JSON.parse(incident.reviewReport.experimentArgsJson ?? "[]"),
          cwd: incident.reviewReport.experimentCwd || ".", intent: "verify", verificationKind: "custom" }) : ""),
      expectedSignal: incident.reviewReport.expectedSignal,
      falsifyingSignal: incident.reviewReport.falsifyingSignal,
    });
  }
  if (
    (incident?.phase === "strategy_adjustment" ||
      incident?.phase === "review_exhausted") &&
    incident.reviewReport
  ) {
    return renderRuntimePrompt("runtime/progress-strategy-adjustment.md", {
      incidentId: incident.incidentId,
      diagnosis: incident.reviewReport.diagnosis,
      experiment: incident.reviewReport.experiment,
      experimentResult: incident.experiment
        ? JSON.stringify({
            outcomeClass: incident.experiment.outcomeClass,
            outcomeKey: incident.experiment.outcomeKey ?? "unknown",
            newEvidence: incident.experiment.newEvidence,
            verifiedImprovement: incident.experiment.verifiedImprovement,
          })
        : "No reviewer experiment was requested; gather stronger evidence.",
      budgetState: incident.phase === "review_exhausted"
        ? "The automatic review attempt is exhausted for this task."
        : "Use the new evidence to choose a materially different strategy.",
    });
  }
  if (guard.searchWarning?.scopeKey === scopeKey) {
    return renderRuntimePrompt("runtime/progress-search-warning.md", {
      count: guard.searchWarning.count,
    });
  }
  if (guard.readWarning?.scopeKey === scopeKey) {
    return renderRuntimePrompt("runtime/progress-read-warning.md", {
      warningId: guard.readWarning.id,
      totalReads: guard.readWarning.totalReads,
      repeatedReads: guard.readWarning.repeatedReads,
      repeatedPercent: Math.floor(guard.readWarning.repeatedRatio * 100),
    });
  }
  return "";
}

function progressResponseOrdinal(
  base: number,
  responseOffset: number,
): number {
  return base + responseOffset;
}

interface CommandVerificationClassification {
  readonly intent: boolean;
  readonly kind?: VerificationKind;
}

function commandVerificationClassification(
  toolName: ToolName,
  rawArguments: string,
  experimentRequired: boolean,
  knownVerificationCommands: ReadonlyMap<string, VerificationKind>,
  result: Readonly<ToolExecutionResult>,
): CommandVerificationClassification {
  if (toolName === "run_command" || toolName === "start_command") {
    try {
      const output = result.data as { requestMetadata?: { intent?: unknown; verificationKind?: unknown } } | undefined;
      const parsed = (output?.requestMetadata ?? safeJsonParse(rawArguments)) as {
        intent?: unknown;
        verificationKind?: unknown;
      };
      const declaredKind = typeof parsed.verificationKind === "string" &&
          VERIFICATION_KINDS.includes(parsed.verificationKind as VerificationKind)
        ? parsed.verificationKind as VerificationKind
        : undefined;
      const declaredIntent = parsed.intent === "test" ||
          parsed.intent === "build" ||
          parsed.intent === "verify"
        ? parsed.intent as CommandIntent
        : undefined;
      const kind = declaredIntent
        ? commandVerificationKind({ intent: declaredIntent, verificationKind: declaredKind })
        : undefined;
      if (experimentRequired) return { intent: true, kind: kind ?? "custom" };
      return kind ? { intent: true, kind } : { intent: false };
    } catch {
      return experimentRequired
        ? { intent: true, kind: "custom" }
        : { intent: false };
    }
  }
  if (toolName !== "poll_command" && toolName !== "cancel_command") {
    return { intent: false };
  }
  const data = result.data && typeof result.data === "object"
    ? result.data as Record<string, unknown>
    : undefined;
  const kind = typeof data?.commandId === "string"
    ? knownVerificationCommands.get(data.commandId)
    : undefined;
  return kind ? { intent: true, kind } : { intent: false };
}

function requiredProgressExperiment(
  state: Readonly<SessionState>,
  scopeKey: string,
): Readonly<ProgressIncident> | undefined {
  return state.progressGuard?.incidents.find(
    (incident) =>
      incident.scopeKey === scopeKey &&
      incident.phase === "experiment_required",
  );
}

function persistedProgressReviewAccounting(
  incident: Readonly<ProgressIncident>,
): ProgressReviewAccounting {
  return {
    reviewAttempts: incident.reviewAttempts > 0 ? 1 : 0,
    validReviews: incident.validReviews > 0 ? 1 : 0,
    reviewModelRequests: incident.reviewModelRequests,
    reportedModelRequests: incident.reviewFinishedRequestOrdinals.length,
    unreportedModelRequests: Math.max(
      0,
      incident.reviewModelRequests - incident.reviewFinishedRequestOrdinals.length,
    ),
    reviewInputTokens: incident.reviewInputTokens,
    reviewOutputTokens: incident.reviewOutputTokens,
    reviewTotalTokens: incident.reviewTotalTokens,
    reviewCachedInputTokens: incident.reviewCachedInputTokens,
    reviewReasoningTokens: incident.reviewReasoningTokens,
    reviewDurationMs: incident.reviewDurationMs,
    requests: [],
  };
}

interface RuntimeLayeredContext {
  workingCheckpoint?: string;
  retrievedThreadEvidence?: string;
  evidence?: readonly Readonly<ContextSearchHit>[];
}

function pinCurrentState(
  state: Readonly<SessionState>,
  approvedPlanReview: Readonly<PlanReviewState> | undefined,
  derived: RuntimeLayeredContext = {},
): RuntimeLayeredContext {
  return {
    workingCheckpoint: renderPinnedCurrentState(state, approvedPlanReview),
    ...(derived.evidence ? { evidence: derived.evidence } : {}),
    ...(derived.retrievedThreadEvidence
      ? { retrievedThreadEvidence: derived.retrievedThreadEvidence }
      : {}),
  };
}

// PromptBuilder bounds retrieved Thread evidence to 20,000 characters. Keep a
// small allowance for the untrusted-data envelope so ContextManager can use the
// same raw-message boundary before and after retrieval.
const LAYERED_EVIDENCE_SYSTEM_RESERVE_CHARS = 21_000;
// Keep the conversation boundary stable while the pressure instruction itself
// is selected. This is deliberately small and is charged through the same
// reservation passed to ContextManager.build().
const CONTEXT_PRESSURE_SYSTEM_RESERVE_CHARS = 1_024;
const MAX_AUDITED_TOOL_BINDINGS = 256;

export interface AgentRuntimeDependencies {
  limits?: Readonly<import("../config/runtime-limits.js").RuntimeLimits>;
  taskBudget?: import("./task-budget.js").TaskBudget;
  tokenCalibration?: TokenCalibration;
  provider: ModelProvider;
  /** Immutable, source-aware tool set captured once for this Runtime run. */
  toolCatalog: Readonly<ToolCatalogSnapshot>;
  /** Provider capability used when filtering the captured catalog. */
  visionAvailable?: boolean;
  /** Host-owned authorization bridge for effectful external tool sources. */
  authorizeToolExecution?: ToolExecutionAuthorizer;
  /** Runtime-issued actor identity; the default is the only main agent. */
  agentIdentity?:
    | { role: "main_agent" }
    | { role: "subagent"; agentId: string; assignedTaskId: string };
  contextManager: ContextManager;
  buildSystemPrompt: (input: {
    mode: AgentMode;
    workspaceSummary: string;
    memories: ReadonlyArray<Readonly<LongTermMemory>>;
    workingCheckpoint?: string;
    retrievedThreadEvidence?: string;
    /** Exact tools exposed on this provider request. */
    toolNames: readonly ToolName[];
    taskGraph?: Readonly<TaskGraph>;
    planReview?: Readonly<PlanReviewState>;
  }) => Promise<string>;
  getWorkspaceSummary: () => Promise<string>;
  searchMemories: (query: string) => Promise<ReadonlyArray<Readonly<LongTermMemory>>>;
  /**
   * Builds derived, Thread-private context layers. Failures must never replace
   * the event journal or prevent an otherwise valid model request.
   */
  getLayeredContext?: (input: {
    state: Readonly<SessionState>;
    query: string;
    beforeMessageIndex: number;
    queries?: readonly string[];
  }) => Promise<{
    workingCheckpoint?: string;
    retrievedThreadEvidence?: string;
    evidence?: readonly Readonly<ContextSearchHit>[];
  }>;
  /** Catch the derived incremental index up after the final durable message. */
  checkpointContext?: (state: Readonly<SessionState>) => Promise<void>;
  captureToolEvidence?: (state: Readonly<SessionState>, callId: string, tool: string,
    result: ToolExecutionResult) => string;
  readToolEvidence?: (state: Readonly<SessionState>, id: string, offset: number, limit: number) => object;
  validateMemorySources?: (state: Readonly<SessionState>, turnId: string, userInput: string,
    mutation: MemoryMutationRequest) => void;
  commitMemoryMutations?: (input: {
    sourceState: Readonly<SessionState>;
    workspaceRoot: string;
    threadId: string;
    turnId: string;
    outcome: "success" | "planned";
    userInput: string;
    mutations: readonly MemoryMutationRequest[];
  }) => Promise<{ applied: number; memoryIds: string[] }>;
  appendEvent: (
    event: Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp"> & {
      eventId?: string;
    },
  ) => Promise<void>;
  /** Fresh workspace identity used to reject stale reviewer advice. */
  getProgressWorkspaceFingerprint?: () => Promise<string>;
  captureValidationBaseline?: () => Promise<import("../progress/validation-standard.js").ValidationBaseline>;
  runReviewSession?: (input: import("../review/application.js").WorkspaceReviewRequest) =>
    Promise<import("../review/application.js").WorkspaceReviewResult>;
  requestApproval: ApprovalHandler;
  recordCommand?: (turnId: string, entry: CommandAuditEntry) => void;
  onToolCompleted?: (
    state: SessionState,
    toolName: string,
    result: ToolExecutionResult
  ) => Promise<void>;
  /** Roll back a prepared child lifecycle when its authoritative event cannot commit. */
  onSubagentLifecycleRollback?: (update: SubagentLifecycleUpdate) => void;
  /** Process-local children that must be collected before the main agent can finish. */
  getOutstandingSubagents?: () => readonly {
    id: string;
    assignmentKind: "dag" | "standalone";
    taskId: string;
    taskTitle: string;
    status: string;
  }[];
  /** True until this actor has observed every supervised command's terminal result. */
  hasOpenCommandHandles?: () => boolean;
  onText?: (text: string) => void;
  onStatus?: (text: string) => void;
  /** Transient presentation lifecycle around each provider API request. */
  onModelRequestStart?: (text: string) => unknown;
  onModelRequestEnd?: (activityToken: unknown) => void;
  /** Transient presentation lifecycle around one concrete tool execution. */
  onToolExecutionStart?: (toolName: string, text: string) => unknown;
  onToolExecutionEnd?: (toolName: string, activityToken: unknown) => void;
  /** Durable accounting hook; failures are reported but never replace model output. */
  onModelUsage?: (record: ModelUsageRecord) => Promise<void>;
  /** Ephemeral accounting for the exact provider-bound request projection. */
  onProviderContext?: (snapshot: ProviderContextSnapshot) => void;
  /** Transient presentation only; reasoning is persisted in its assistant message. */
  onReasoning?: (notification: AgentReasoningNotification) => void;
  /** Child-only FIFO parent guidance, drained at a model-step boundary. */
  takeAdditionalInstructions?: () => readonly string[];
  /**
   * Main-agent durable inbox drain. The implementation must commit the FIFO
   * application event before returning the batch.
   */
  takeSteering?: (input: {
    threadId: string;
    turnId: string;
    boundary: TurnSteeringBoundary;
  }) => Promise<TurnSteeringBatch | undefined>;
  /** Durable read-only check used to stop a stale batched tool suffix safely. */
  hasPendingSteering?: (input: {
    threadId: string;
    turnId: string;
  }) => Promise<boolean>;
  /**
   * Atomic finalization gate. It either seals this turn or returns the durable
   * pending prefix that won the race and must be handled before finishing.
   */
  sealSteering?: (input: {
    threadId: string;
    turnId: string;
  }) => Promise<TurnSteeringBatch | undefined>;
  /** Process-local wakeup only; ThreadStore remains the durable source of truth. */
  steeringNotifier?: TurnSteeringAttemptNotifier;
  onSteeringApplied?: (
    batch: Readonly<TurnSteeringBatch>,
    boundary: TurnSteeringBoundary,
  ) => void;
  attachImage?: (input: {
    threadId: string;
    label: string;
    absolutePath: string;
    sourceName?: string;
  }) => Promise<ImageAttachment>;
  discardImage?: (threadId: string, attachment: ImageAttachment) => Promise<void>;
  commitImages?: (
    threadId: string,
    attachments: readonly ImageAttachment[],
  ) => Promise<void>;
}

export interface AgentUserInput {
  readonly text: string;
  readonly images?: readonly ImageAttachment[];
}

export interface AgentRunOptions {
  orchestrationEnabled?: boolean;
  isOrchestrationEnabled?: () => boolean;
  maxContextTokens?: number;
  maxSteps: number;
  maxContextChars: number;
  maxOutputChars: number;
  commandTimeoutMs: number;
  approvalPolicy: "safe" | "ask" | "never";
  commandExecutionMode?: CommandExecutionMode;
  isUnrestrictedHostAccessActive?: () => boolean;
  unrestrictedHostAccessEpoch?: () => number;
  signal?: AbortSignal;
  /** Runtime-owned Plan-review transition; never inferred from user text. */
  modeOverride?: "plan" | "code";
  /** Exact approved proposal consumed after its execution user message is durable. */
  approvedPlan?: Pick<PlanProposal, "id" | "revision">;
}

function availableTools(
  tools: readonly AgentTool[],
  mode: AgentMode,
  role: AgentRole,
  _thinkingEffort: SessionState["thinkingEffort"],
  orchestrationAvailable = true,
  visionAvailable = true,
): AgentTool[] {
  return availableAgentTools(tools, {
    mode,
    role,
    orchestrationAvailable,
    visionAvailable,
  });
}

function taskGraphToolError(
  graph: Readonly<TaskGraph> | undefined,
  tool: Readonly<AgentTool>,
  turnId: string,
): string | undefined {
  if (!graph) return undefined;
  const metadata = toolMetadata(tool);
  if (graph.status === "completed") {
    if (
      graph.updatedByTurnId === turnId &&
      metadata.taskWork
    ) {
      return "The task DAG was completed in this turn. Return the final result before starting unrelated work.";
    }
    return undefined;
  }
  if (tool.name === "manage_memory") {
    return "Long-term memory maintenance must wait until the task DAG is completed.";
  }
  if (!metadata.taskWork) return undefined;
  const current = activeTask(graph);
  if (current) return undefined;
  if (graph.status === "blocked") {
    return "The task DAG is blocked. Resume its blocked node before using work tools.";
  }
  return "Start one unblocked DAG task with manage_tasks before using work tools.";
}

function incompleteTaskGraphReminder(graph: Readonly<TaskGraph>): string {
  const view = taskGraphView(graph);
  const childTasks = view.tasks.filter(
    (task) => task.status === "in_progress" && task.owner === "subagent",
  );
  const action = view.currentTask
      ? `Continue task ${view.currentTask}, then mark it complete with verified evidence or block it with a concrete external reason.`
      : childTasks.length
        ? `Use manage_subagents status/wait to collect the running child task(s): ${childTasks.map((task) => `${task.id}=${task.assignedAgentId}`).join(", ")}.`
        : `Start one available task with manage_tasks. Startable tasks: ${view.startableTasks.join(", ") || "none"}.`;
  return renderRuntimePrompt("runtime/task-dag-final-required.md", {
    action,
  });
}

function terminalTaskGraphText(graph: Readonly<TaskGraph> | undefined): string {
  const blockedTask = graph?.tasks.find((task) => task.status === "blocked");
  return graph?.status === "blocked"
    ? `The task DAG is blocked${blockedTask?.blocker ? `: ${blockedTask.blocker}` : "."}`
    : "The task DAG completed all declared tasks and completion checks.";
}

function resultForModel(result: ToolExecutionResult, maximumChars: number): string {
  return toolResultForModel(result, maximumChars);
}

type AssistantToolCall = NonNullable<
  Extract<ChatMessage, { role: "assistant" }>["tool_calls"]
>[number];

/**
 * Preserve the full candidate for correction and journal replay, including
 * rejected calls. Accepted compaction retires these messages from the active
 * context; buildPersistedSummary still excludes temporary coverage metadata.
 */
function durableToolCall(call: AssistantToolCall): AssistantToolCall {
  if (call.function.name !== "compact_context") return call;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments) as unknown;
  } catch {
    return {
      ...call,
      function: { ...call.function, arguments: redactSensitiveInformation(call.function.arguments) },
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ...call,
      function: { ...call.function, arguments: redactSensitiveInformation(call.function.arguments) },
    };
  }
  return {
    ...call,
    function: {
      ...call.function,
      arguments: JSON.stringify(parsed, (_key, value: unknown) =>
        typeof value === "string" ? redactSensitiveInformation(value) : value),
    },
  };
}

const MAX_PINNED_INTENT_QUOTE_CHARS = 400;

function boundedIntentQuote(value: string): string {
  const redacted = redactSensitiveInformation(value).trim();
  return (redacted || "[User message contains attachments only]")
    .slice(0, MAX_PINNED_INTENT_QUOTE_CHARS);
}

function updateLatestRequestLedger(
  state: SessionState,
  sourceMessageIndex: number,
  content: string,
): void {
  recordUserRequirement(state, sourceMessageIndex);
  const previous = state.contextIntentLedger;
  state.contextIntentLedger = {
    latestRequest: {
      sourceMessageIndex,
      text: boundedIntentQuote(content),
    },
    activeConstraints: previous?.activeConstraints.map((item) => ({ ...item })) ?? [],
    userCorrections: previous?.userCorrections.map((item) => ({ ...item })) ?? [],
    supersededRequests: previous?.supersededRequests.map((item) => ({ ...item })) ?? [],
  };
}

function appendSteeringLedgerEntry(
  state: SessionState,
  sourceMessageIndex: number,
  content: string,
): void {
  recordUserRequirement(state, sourceMessageIndex);
  const quote = {
    sourceMessageIndex,
    text: boundedIntentQuote(content),
  };
  const previous = state.contextIntentLedger;
  state.contextIntentLedger = {
    latestRequest: previous?.latestRequest
      ? { ...previous.latestRequest }
      : quote,
    activeConstraints: previous?.activeConstraints.map((item) => ({ ...item })) ?? [],
    userCorrections: [
      ...(previous?.userCorrections.map((item) => ({ ...item })) ?? []),
      quote,
    ].slice(-32),
    supersededRequests: previous?.supersededRequests.map((item) => ({ ...item })) ?? [],
  };
}

function isSubagentAssignmentSnapshot(
  value: unknown,
): value is SubagentAssignmentSnapshot {
  if (!value || typeof value !== "object") return false;
  const assignment = value as Partial<SubagentAssignmentSnapshot>;
  return (
    (assignment.kind === "dag" || assignment.kind === "standalone") &&
    typeof assignment.agentId === "string" &&
    assignment.agentId.length > 0 &&
    typeof assignment.taskId === "string" &&
    assignment.taskId.length > 0 &&
    typeof assignment.taskTitle === "string" &&
    assignment.taskTitle.length > 0 &&
    typeof assignment.taskDescription === "string" &&
    assignment.taskDescription.length > 0 &&
    Array.isArray(assignment.completionChecks) &&
    assignment.completionChecks.length > 0 &&
    assignment.completionChecks.every(
      (check) => typeof check === "string" && check.length > 0,
    ) &&
    typeof assignment.provider === "string" &&
    typeof assignment.model === "string" &&
    (assignment.thinkingEffort === "none" ||
      assignment.thinkingEffort === "low" ||
      assignment.thinkingEffort === "medium" ||
      assignment.thinkingEffort === "high") &&
    typeof assignment.createdAt === "string" &&
    (assignment.kind === "standalone" ||
      (typeof assignment.taskGraphId === "string" && assignment.taskGraphId.length > 0))
  );
}

export class AgentRuntime {
  private orchestrationToolsAvailable(state: Readonly<SessionState>, options: AgentRunOptions): boolean {
    return options.orchestrationEnabled !== false || Boolean(state.taskGraph && state.taskGraph.status !== "completed") ||
      (this.dependencies.getOutstandingSubagents?.().length ?? 0) > 0;
  }
  private remainingRequests = Infinity;
  private retryContext?: { state: SessionState; turnId: string };
  private readonly requestPrefixTracker = new RequestPrefixTracker();
  constructor(private readonly dependencies: AgentRuntimeDependencies) {
    const provider = dependencies.provider;
    dependencies.contextManager.estimateRequestTokens = dependencies.tokenCalibration
      ? dependencies.tokenCalibration.estimate.bind(dependencies.tokenCalibration)
      : requestTokens;
    this.dependencies = { ...dependencies, provider: {
      get name() { return provider.name; },
      get model() { return provider.model; },
      complete: async (request) => {
        if (this.remainingRequests <= 0) throw new TaskBudgetExceeded("actor step limit reached");
        const limits = dependencies.limits ?? DEFAULT_RUNTIME_LIMITS;
        const sent = budgetedRequest({ ...request, outputReserveTokens: request.outputReserveTokens ?? dependencies.contextManager.tokenCapacity?.outputReserve ?? limits.maxResponseTokens }, dependencies.contextManager.tokenCapacity,
          dependencies.contextManager.estimateRequestTokens);
        this.remainingRequests -= 1; // Logical model step, not physical API attempts.
        let actualRequest = sent;
        const response = await completeWithApiRetries(provider, sent, {
          limits,
          reserve: value => { actualRequest = value; return dependencies.taskBudget?.reserve(value, dependencies.contextManager.estimateRequestTokens) ?? (() => undefined); },
          onSettled: async attempt => {
            if (this.retryContext) await dependencies.appendEvent({ threadId: this.retryContext.state.threadId,
              turnId: this.retryContext.turnId, type: "model.api_attempt", phase: attempt.outcome, payload: attempt });
          },
          resetContext: async rejected => {
            const active = this.retryContext;
            if (!active) return resetRequestHistory(rejected);
            await resetServerContext(active.state, active.turnId, dependencies.appendEvent);
            dependencies.onStatus?.("Server rejected context capacity. Historical context cleared; retrying once with user requirements. Files, budgets and execution state are unchanged.");
            return resetStateRequest(rejected, active.state);
          },
        });
        try { dependencies.tokenCalibration?.observe(actualRequest.messages, actualRequest.tools ?? [], response.usage); }
        catch { /* Calibration persistence must not replace a successful response. */ }
        return response;
      },
    } };
    markRetryManaged(this.dependencies.provider);
    const steeringConfigured = Boolean(
      dependencies.takeSteering ||
      dependencies.sealSteering ||
      dependencies.hasPendingSteering ||
      dependencies.steeringNotifier ||
      dependencies.onSteeringApplied,
    );
    if (
      steeringConfigured &&
      (!dependencies.takeSteering || !dependencies.sealSteering)
    ) {
      throw new Error(
        "Turn steering requires both boundary consumption and finalization sealing",
      );
    }
  }

  private async progressWorkspaceFingerprint(): Promise<
    { ok: true; fingerprint: string } | { ok: false; error: string }
  > {
    if (!this.dependencies.getProgressWorkspaceFingerprint) {
      return {
        ok: false,
        error: "A fresh complete workspace fingerprint provider is unavailable.",
      };
    }
    try {
      const fingerprint = await this.dependencies.getProgressWorkspaceFingerprint();
      if (!/^sha256:[0-9a-f]{64}$/u.test(fingerprint)) {
        throw new Error("workspace fingerprint has an invalid format");
      }
      return { ok: true, fingerprint };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async appendProgressReviewEvent(
    state: SessionState,
    turnId: string,
    type: ProgressReviewEventType,
    phase: EventRecord["phase"],
    payload: unknown,
  ): Promise<void> {
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type,
      phase,
      payload,
    });
    state.progressGuard = foldProgressReviewEvent(
      state.progressGuard ?? createProgressGuardState(),
      type,
      payload,
    );
  }

  private async reportProgressReviewRequestUsage(
    state: Readonly<SessionState>,
    turnId: string,
    request: Readonly<ProgressReviewModelRequestRecord>,
  ): Promise<void> {
    if (!this.dependencies.onModelUsage) return;
    const record: ModelUsageRecord = {
      actor: "reviewer",
      purpose: "progress_review",
      provider: this.dependencies.provider.name,
      model: this.dependencies.provider.model,
      turnId,
      attempt: request.ordinal,
      retry: request.ordinal > 1,
      ...(request.usage ? { usage: { ...request.usage } } : {}),
    };
    try {
      await this.dependencies.onModelUsage(record);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.dependencies.onStatus?.(
        `Progress reviewer usage accounting could not be saved: ${detail}`,
      );
    }
  }

  /**
   * Resolve one durable intervention before the next main-model request. The
   * return value is the number of reviewer Provider requests charged against
   * the same step budget as the parent task.
   */
  private async processProgressIntervention(input: {
    state: SessionState;
    turnId: string;
    userInput: string;
    remainingModelRequests: number;
    signal?: AbortSignal;
  }): Promise<number> {
    const { state, turnId } = input;
    state.progressGuard ??= createProgressGuardState();
    const currentScopeKey = progressScopeKey(state, turnId);
    if (this.dependencies.runReviewSession) {
      const pending = state.progressGuard.incidents.find(incident => incident.scopeKey === currentScopeKey &&
        incident.phase === "review_pending" && incident.reason !== "validation_standard_changed");
      const unfinished = state.reviewSessions?.find(s => s.status !== "applied" && s.purpose === "stagnation");
      if (!pending && !unfinished) return 0;
      const result = await this.dependencies.runReviewSession({ ...input, purpose: "stagnation",
        maxContextTokens: this.dependencies.contextManager.tokenCapacity?.window,
        incidentId: pending?.incidentId ?? unfinished?.incidentId });
      return result.requests;
    }

    // Crash recovery is global, not current-turn scoped. Otherwise a standalone
    // review started in the interrupted turn becomes permanently unreachable
    // when resume creates a new turn ID.
    for (let interrupted = interruptedProgressIncident(state.progressGuard);
      interrupted?.reviewBinding;
      interrupted = interruptedProgressIncident(state.progressGuard)) {
      await this.appendProgressReviewEvent(
        state,
        turnId,
        "progress.review.unavailable",
        "interrupted",
        {
          incidentId: interrupted.incidentId,
          reviewId: interrupted.reviewBinding.reviewId,
          reason:
            "A prior reviewer was started but has no durable terminal event; its attempt remains charged and is not retried.",
          accounting: persistedProgressReviewAccounting(interrupted),
        },
      );
    }

    // Requested/pending reviews belong to immutable task material. If resume
    // moved to a different logical scope, close them instead of silently
    // orphaning them or reviewing a new request with stale evidence.
    for (let requested = requestedProgressIncident(state.progressGuard);
      requested && requested.scopeKey !== currentScopeKey;
      requested = requestedProgressIncident(state.progressGuard)) {
      await this.appendProgressReviewEvent(
        state,
        turnId,
        "progress.review.stale",
        "interrupted",
        {
          incidentId: requested.incidentId,
          reviewId: requested.reviewBinding!.reviewId,
          reason: "The logical task scope changed before the reviewer started.",
        },
      );
    }
    for (let pending = nextPendingProgressIncident(state.progressGuard);
      pending && pending.scopeKey !== currentScopeKey;
      pending = nextPendingProgressIncident(state.progressGuard)) {
      await this.appendProgressReviewEvent(
        state,
        turnId,
        "progress.review.unavailable",
        "interrupted",
        {
          incidentId: pending.incidentId,
          reason: "The logical task scope ended before a review attempt started.",
        },
      );
    }

    // A completed review remains usable only while its intent and complete
    // workspace snapshot are still the ones it audited. Evidence gathered by
    // the requested experiment may advance the watermark, so watermark is not
    // rechecked after completion.
    const activeReport = [...state.progressGuard.incidents]
      .reverse()
      .find((candidate) =>
        candidate.scopeKey === currentScopeKey &&
        (
          candidate.phase === "experiment_required" ||
          candidate.phase === "strategy_adjustment" ||
          candidate.phase === "review_exhausted"
        ) &&
        candidate.reviewBinding !== undefined
      );
    if (activeReport?.reviewBinding) {
      const steeringPending = await this.dependencies.hasPendingSteering?.({
        threadId: state.threadId,
        turnId,
      }) ?? false;
      const snapshot = await this.progressWorkspaceFingerprint();
      if (!snapshot.ok) {
        await this.appendProgressReviewEvent(
          state,
          turnId,
          "progress.review.unavailable",
          "failed",
          {
            incidentId: activeReport.incidentId,
            reviewId: activeReport.reviewBinding.reviewId,
            reason: `The completed review cannot be freshness-checked: ${snapshot.error}`,
            accounting: persistedProgressReviewAccounting(activeReport),
          },
        );
        return 0;
      }
      if (
        steeringPending ||
        activeReport.reviewBinding.intentRevision !== progressIntentRevision(state) ||
        activeReport.reviewBinding.workspaceFingerprint !== snapshot.fingerprint
      ) {
        await this.appendProgressReviewEvent(
          state,
          turnId,
          "progress.review.stale",
          "interrupted",
          {
            incidentId: activeReport.incidentId,
            reviewId: activeReport.reviewBinding.reviewId,
            reason: "Intent or workspace changed after the review completed.",
            accounting: persistedProgressReviewAccounting(activeReport),
          },
        );
        return 0;
      }
      return 0;
    }

    let incident = requestedProgressIncident(state.progressGuard, currentScopeKey);
    let requestedNow = false;
    if (!incident) {
      incident = nextPendingProgressIncident(state.progressGuard, currentScopeKey);
      if (!incident) return 0;
      if (
        reviewAttemptUsedForScope(
          state.progressGuard,
          incident.scopeKey,
          incident.incidentId,
        )
      ) {
        await this.appendProgressReviewEvent(
          state,
          turnId,
          "progress.review.unavailable",
          "failed",
          {
            incidentId: incident.incidentId,
            reason: "The one-review-attempt budget for this task scope is exhausted.",
          },
        );
        return 0;
      }
      if (input.remainingModelRequests < 2) {
        await this.appendProgressReviewEvent(
          state,
          turnId,
          "progress.review.unavailable",
          "failed",
          {
            incidentId: incident.incidentId,
            reason:
              "The shared model-request budget has no room for both a reviewer and a parent verification step.",
          },
        );
        return 0;
      }
      const snapshot = await this.progressWorkspaceFingerprint();
      if (!snapshot.ok) {
        await this.appendProgressReviewEvent(
          state,
          turnId,
          "progress.review.unavailable",
          "failed",
          {
            incidentId: incident.incidentId,
            reason: `A fresh complete workspace snapshot is required: ${snapshot.error}`,
          },
        );
        return 0;
      }
      const packet = progressReviewPacket(state, incident, input.userInput);
      const reviewId = createId("review");
      const binding: ProgressReviewBinding = {
        reviewId,
        incidentId: incident.incidentId,
        intentRevision: progressIntentRevision(state),
        workspaceFingerprint: snapshot.fingerprint,
        progressWatermark: state.progressGuard.acceptedObservations,
        packetDigest: progressReviewPacketDigest(packet),
      };
      await this.appendProgressReviewEvent(
        state,
        turnId,
        "progress.review.requested",
        "requested",
        { incidentId: incident.incidentId, binding, packet },
      );
      requestedNow = true;
      incident = requestedProgressIncident(state.progressGuard, currentScopeKey);
      if (!incident) throw new Error("Progress review request did not enter durable state");
    }

    const binding = incident.reviewBinding;
    const packet = incident.reviewPacket;
    if (!binding || !packet) {
      throw new Error("A requested progress review is missing its immutable material");
    }
    const currentSnapshot = requestedNow
      ? { ok: true as const, fingerprint: binding.workspaceFingerprint }
      : await this.progressWorkspaceFingerprint();
    if (!currentSnapshot.ok) {
      await this.appendProgressReviewEvent(
        state,
        turnId,
        "progress.review.unavailable",
        "failed",
        {
          incidentId: incident.incidentId,
          reviewId: binding.reviewId,
          reason: `The requested review cannot be freshness-checked: ${currentSnapshot.error}`,
        },
      );
      return 0;
    }
    const steeringPendingBeforeStart =
      await this.dependencies.hasPendingSteering?.({
        threadId: state.threadId,
        turnId,
      }) ?? false;
    if (
      steeringPendingBeforeStart ||
      binding.intentRevision !== progressIntentRevision(state) ||
      binding.workspaceFingerprint !== currentSnapshot.fingerprint ||
      binding.progressWatermark !== state.progressGuard.acceptedObservations
    ) {
      await this.appendProgressReviewEvent(
        state,
        turnId,
        "progress.review.stale",
        "interrupted",
        {
          incidentId: incident.incidentId,
          reviewId: binding.reviewId,
          reason: "Intent, workspace, or progress evidence changed before reviewer start.",
        },
      );
      return 0;
    }

    await this.appendProgressReviewEvent(
      state,
      turnId,
      "progress.review.started",
      "started",
      {
        incidentId: incident.incidentId,
        reviewId: binding.reviewId,
      },
    );
    this.dependencies.onStatus?.(
      `Progress stalled; running one isolated read-only reviewer for ${incident.incidentId}.`,
    );
    const execution = await this.withModelRequestActivity(
      `Reviewing stalled progress with ${this.dependencies.provider.model}`,
      () => runProgressReviewer(
        {
          binding,
          packet,
          thinkingEffort: state.thinkingEffort,
          maxModelRequests: Math.min(Math.max(1, input.remainingModelRequests - 1), (this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).modelContentRetries + 1),
          maxOutputTokens: (this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).reviewerOutputTokens,
          signal: input.signal,
        },
        {
          provider: this.dependencies.provider,
          limits: this.dependencies.limits,
          onRequestStarted: async (request) => {
            await this.appendProgressReviewEvent(
              state,
              turnId,
              "progress.review.model_request.started",
              "started",
              {
                incidentId: incident.incidentId,
                reviewId: binding.reviewId,
                ordinal: request.ordinal,
                kind: request.kind,
              },
            );
          },
          onRequestFinished: async (request) => {
            await this.appendProgressReviewEvent(
              state,
              turnId,
              "progress.review.model_request.finished",
              request.status === "completed" ? "completed" : "failed",
              {
                incidentId: incident.incidentId,
                reviewId: binding.reviewId,
                ordinal: request.ordinal,
                kind: request.kind,
                status: request.status,
                durationMs: request.durationMs,
                ...(request.usage ? { usage: request.usage } : {}),
                ...(request.error ? { error: request.error } : {}),
              },
            );
            await this.reportProgressReviewRequestUsage(state, turnId, request);
          },
          onResponse: async response => {
            await this.dependencies.appendEvent({ threadId: state.threadId, turnId, type: "model.output.captured",
              payload: { purpose: "reviewer", reviewId: binding.reviewId,
                finishReason: response.finishReason ?? null,
                message: JSON.parse(redactSensitiveInformation(JSON.stringify({ content: response.message.content,
                  tool_calls: response.message.tool_calls }))) } });
          },
        },
      ),
    );

    const finalSnapshot = await this.progressWorkspaceFingerprint();
    if (!finalSnapshot.ok) {
      await this.appendProgressReviewEvent(
        state,
        turnId,
        "progress.review.unavailable",
        "failed",
        {
          incidentId: incident.incidentId,
          reviewId: binding.reviewId,
          reason: `The reviewer result cannot be freshness-checked: ${finalSnapshot.error}`,
          accounting: execution.accounting,
        },
      );
      return execution.accounting.reviewModelRequests;
    }
    const steeringPendingAfterReview =
      await this.dependencies.hasPendingSteering?.({
        threadId: state.threadId,
        turnId,
      }) ?? false;
    const stale =
      steeringPendingAfterReview ||
      binding.intentRevision !== progressIntentRevision(state) ||
      binding.workspaceFingerprint !== finalSnapshot.fingerprint ||
      binding.progressWatermark !== state.progressGuard.acceptedObservations;
    if (stale) {
      await this.appendProgressReviewEvent(
        state,
        turnId,
        "progress.review.stale",
        "interrupted",
        {
          incidentId: incident.incidentId,
          reviewId: binding.reviewId,
          reason: "Intent, workspace, or progress evidence changed while reviewer was running.",
          accounting: execution.accounting,
        },
      );
      return execution.accounting.reviewModelRequests;
    }
    if (execution.status === "completed") {
      await this.appendProgressReviewEvent(
        state,
        turnId,
        "progress.review.completed",
        "completed",
        {
          incidentId: incident.incidentId,
          binding,
          report: execution.report,
          accounting: execution.accounting,
        },
      );
      this.dependencies.onStatus?.(
        execution.report.recommendation === "run_experiment"
          ? "Reviewer proposed a falsifiable experiment; the parent must verify it before further edits."
          : "Reviewer found insufficient evidence; the parent must gather a materially different signal.",
      );
    } else {
      await this.appendProgressReviewEvent(
        state,
        turnId,
        "progress.review.unavailable",
        execution.reason === "interrupted" ? "interrupted" : "failed",
        {
          incidentId: incident.incidentId,
          reviewId: binding.reviewId,
          reason: `${execution.reason}: ${execution.error}`,
          accounting: execution.accounting,
        },
      );
      this.dependencies.onStatus?.(
        `Progress reviewer is unavailable (${execution.reason}); this is not code-failure evidence.`,
      );
    }
    return execution.accounting.reviewModelRequests;
  }

  private observeProviderContext(input: {
    state: SessionState;
    turnId: string;
    purpose: ModelUsagePurpose;
    messages: readonly ChatMessage[];
    tools?: readonly ToolDefinition[];
    enforcedPressure: ContextPressureLevel;
    enforcedUtilization: number;
    attempt: number;
    step?: number;
    maxContextChars: number;
    actualRequest?: ProviderRequestContextInspection;
  }): ProviderRequestContextInspection {
    const measuredRequest = input.actualRequest ??
      this.dependencies.contextManager.inspectProviderRequest({
        state: input.state,
        maxContextChars: input.maxContextChars,
        messages: input.messages,
        ...(input.tools ? { tools: input.tools } : {}),
      });
    const actualRequest = { ...measuredRequest, ...this.requestPrefixTracker.observe(
      `${input.state.threadId}:${this.dependencies.provider.name}:${this.dependencies.provider.model}:${input.state.thinkingEffort}`,
      input.messages, input.tools,
    ) };
    const identity = this.dependencies.agentIdentity ?? { role: "main_agent" as const };
    try {
      this.dependencies.onProviderContext?.({
        threadId: input.state.threadId,
        turnId: input.turnId,
        actor: identity.role,
        purpose: input.purpose,
        provider: this.dependencies.provider.name,
        model: this.dependencies.provider.model,
        timestamp: new Date().toISOString(),
        ...(input.step === undefined ? {} : { step: input.step }),
        attempt: input.attempt,
        enforcedPressure: input.enforcedPressure,
        enforcedUtilization: input.enforcedUtilization,
        actualRequest,
      });
    } catch {
      // Context telemetry is observational and must never block model work.
    }
    return actualRequest;
  }

  private async takeAndApplySteering(
    state: SessionState,
    turnId: string,
    boundary: TurnSteeringBoundary,
    turnImages: ImageAttachment[],
    seal = false,
    memoryContext?: { userInput: string },
  ): Promise<TurnSteeringBatch | undefined> {
    const batch = seal
      ? await this.dependencies.sealSteering?.({ threadId: state.threadId, turnId })
      : await this.dependencies.takeSteering?.({
          threadId: state.threadId,
          turnId,
          boundary,
        });
    if (!batch) return undefined;
    if (
      !Number.isSafeInteger(batch.throughSequence) ||
      batch.throughSequence <= (state.steeringWatermark ?? 0) ||
      batch.entries.length === 0 ||
      batch.entries[batch.entries.length - 1]?.sequence !== batch.throughSequence ||
      batch.message.role !== "user"
    ) {
      throw new Error("Runtime received an invalid or already-applied steering batch");
    }
    const batchImages = batch.message.images ?? [];
    if (batchImages.length > 0) {
      validateImageAttachmentCollection([...turnImages, ...batchImages]);
      validateProviderImageAttachments(this.dependencies.provider.name, batchImages);
      for (const image of batchImages) {
        if (!turnImages.some((candidate) => candidate.id === image.id)) {
          turnImages.push({ ...image });
        }
      }
    }
    const steeringMessageIndex = state.messages.length;
    state.messages.push({
      role: "user",
      content: batch.message.content,
      ...(batchImages.length > 0
        ? { images: batchImages.map((image) => ({ ...image })) }
        : {}),
    });
    appendSteeringLedgerEntry(
      state,
      steeringMessageIndex,
      batch.message.content,
    );
    state.pendingSteering = (state.pendingSteering ?? [])
      .filter((entry) => entry.sequence > batch.throughSequence);
    state.steeringSequence = Math.max(
      state.steeringSequence ?? 0,
      batch.throughSequence,
    );
    state.steeringWatermark = batch.throughSequence;
    state.updatedAt = new Date().toISOString();
    if (memoryContext) {
      const provenance = batch.entries.map((entry) => {
        const labels = (entry.message.images ?? []).map((image) => image.label).join(", ");
        return [entry.message.content, labels ? `[Attachments: ${labels}]` : ""]
          .filter(Boolean)
          .join("\n");
      }).join("\n\n");
      memoryContext.userInput += `\n\n[MID_TURN_USER_STEERING]\n${provenance}`;
    }
    this.dependencies.steeringNotifier?.consume(batch.throughSequence);
    try {
      this.dependencies.onSteeringApplied?.(batch, boundary);
    } catch {
      // Presentation is transient; durable application already succeeded.
    }
    return batch;
  }

  private async runProviderAttempt<T>(
    turnSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<{ kind: "completed"; value: T } | { kind: "steering_interrupted" }> {
    const steeringAttempt = this.dependencies.steeringNotifier?.openAttempt();
    const attemptSignal = createProviderAttemptSignal({
      turnSignal,
      steeringSignal: steeringAttempt?.signal,
    });
    try {
      if (attemptSignal.signal.aborted && attemptSignal.abortSource === "steering") {
        return { kind: "steering_interrupted" };
      }
      const value = await operation(
        turnSignal || steeringAttempt ? attemptSignal.signal : undefined,
      );
      if (attemptSignal.abortSource === "turn") {
        throw turnSignal?.reason ?? new Error("The turn was interrupted");
      }
      if (attemptSignal.abortSource === "steering") {
        return { kind: "steering_interrupted" };
      }
      return { kind: "completed", value };
    } catch (error) {
      if (attemptSignal.abortSource === "turn") throw error;
      if (attemptSignal.abortSource === "steering") {
        return { kind: "steering_interrupted" };
      }
      throw error;
    } finally {
      attemptSignal.dispose();
      steeringAttempt?.dispose();
    }
  }

  async run(
    state: SessionState,
    input: string | AgentUserInput,
    options: AgentRunOptions
  ): Promise<AgentRunResult> {
    this.remainingRequests = options.maxSteps;
    this.dependencies.contextManager.configureTokenBudget(effectiveContextWindow(state.provider, state.model, options.maxContextTokens), this.dependencies.limits);
    const userInput = typeof input === "string" ? input : input.text;
    const inputImages = typeof input === "string" ? [] : [...(input.images ?? [])];
    validateImageAttachmentCollection(inputImages);
    validateProviderImageAttachments(this.dependencies.provider.name, inputImages);
    const turnId = createId("turn");
    this.retryContext = { state, turnId };
    const turnImages = [...inputImages];
    this.dependencies.steeringNotifier?.consume(state.steeringWatermark ?? 0);
    const agentIdentity = this.dependencies.agentIdentity ?? { role: "main_agent" as const };
    if (agentIdentity.role === "subagent" && state.mode !== "code") {
      throw new Error("An isolated child runtime must remain in Code mode");
    }
    const memoryContext = {
      userInput,
      mutations: [] as MemoryMutationRequest[],
      approvedPlanReview: undefined as PlanReviewState | undefined,
    };
    state.activeTurnId = turnId;
    state.goal = userInput || "Analyze the attached image(s).";
    state.updatedAt = new Date().toISOString();
    const userMessage: Extract<ChatMessage, { role: "user" }> = {
      role: "user",
      content: userInput,
      ...(inputImages.length ? { images: inputImages } : {}),
    };
    const turnHistoryStart = state.messages.length;
    const turnChangeStart = state.changes.length;
    let phaseCompactionRequestsUsed = 0;
    state.messages.push(userMessage);
    updateLatestRequestLedger(state, turnHistoryStart, userMessage.content);

    try {
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "message.user",
      phase: "completed",
      payload: { content: userInput, message: userMessage }
    });
    if (inputImages.length) {
      await this.dependencies.commitImages?.(state.threadId, inputImages);
    }

    if (options.approvedPlan) {
      const review = state.planReview;
      if (
        !review ||
        review.status !== "approved_pending_execution" ||
        review.proposal.id !== options.approvedPlan.id ||
        review.proposal.revision !== options.approvedPlan.revision
      ) {
        throw new Error("The approved plan no longer matches the pending review state");
      }
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "plan.execution_started",
        phase: "completed",
        payload: {
          planId: review.proposal.id,
          revision: review.proposal.revision,
        },
      });
      memoryContext.approvedPlanReview = clonePlanReviewState(review);
      state.planReview = undefined;
      state.updatedAt = new Date().toISOString();
    }

    if (options.modeOverride && state.mode !== "auto") {
      throw new Error("A review mode override is valid only while the persistent mode is Auto");
    }
    const outstandingSubagentsAtRoute = agentIdentity.role === "main_agent"
      ? (this.dependencies.getOutstandingSubagents?.() ?? [])
      : [];
    if (
      outstandingSubagentsAtRoute.length > 0 &&
      (options.modeOverride === "plan" ||
        (options.modeOverride === undefined && state.mode === "plan"))
    ) {
      throw new Error(
        "Outstanding child assignments must be collected in Code mode before entering Plan mode",
      );
    }
    if (
      options.modeOverride === "plan" &&
      state.taskGraph &&
      state.taskGraph.status !== "completed"
    ) {
      throw new Error("An active task DAG cannot be adjusted in Plan mode");
    }

    let effectiveMode: AgentMode = options.modeOverride ?? state.mode;
    let autoReason = "";
    let contextLayerFailureReported = false;
    if (state.mode === "auto" && options.modeOverride) {
      autoReason = options.modeOverride === "plan"
        ? "The user requested a revision of the pending plan."
        : "Runtime resumed an explicitly selected Code operation.";
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "mode.review_override",
        phase: "completed",
        payload: { mode: options.modeOverride, reason: autoReason },
      });
      this.dependencies.onStatus?.(
        `Auto mode review transition: ${options.modeOverride} — ${autoReason}`,
      );
    } else if (state.mode === "auto") {
      const unfinishedGraph = state.taskGraph && state.taskGraph.status !== "completed";
      const routingPressure = this.dependencies.contextManager.inspect(state, options.maxContextChars).utilization;
      if (
        !unfinishedGraph &&
        outstandingSubagentsAtRoute.length === 0 &&
        routingPressure >= (this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).contextCompactionTriggerRatio
      ) {
        {
          const nextTools = availableTools(
            this.dependencies.toolCatalog.tools,
            "code", agentIdentity.role, state.thinkingEffort,
            this.orchestrationToolsAvailable(state, options),
            this.dependencies.visionAvailable ?? true)
            .filter((tool) => tool.name !== "compact_context");
          const nextRequest = { systemPrompt: await this.dependencies.buildSystemPrompt({ mode: "code",
            workspaceSummary: "", memories: [], toolNames: nextTools.map((tool) => tool.name) }),
            runtimeContext: renderPinnedCurrentState(state), tools: nextTools.map((tool) => tool.definition),
            reservedTokens: optionalMemoryTokenBudget(options.maxContextChars, options.maxContextTokens,
              this.dependencies.limits, true) };
          const compacted = await this.maintainContext(state, turnId, turnImages, memoryContext,
            options, nextRequest, false, options.maxSteps);
          phaseCompactionRequestsUsed += compacted.requests;
          if (compacted.paused) return this.finish(state, turnId,
            `Context paused: ${compacted.paused.reason} Required ${compacted.paused.usage} / ${compacted.paused.capacity} ${compacted.paused.unit}. History and task state are preserved.`,
            "limit_reached", phaseCompactionRequestsUsed, memoryContext, undefined, undefined,
            { code: "context_capacity_exhausted", tool: "runtime", attempts: state.compactionControl?.transaction?.attempts ?? 0, recoverable: true });
          if (phaseCompactionRequestsUsed >= options.maxSteps) return this.finish(state, turnId,
            "The shared model-request budget was exhausted during pre-route context compaction.",
            "limit_reached", phaseCompactionRequestsUsed, memoryContext);
        }
      }
      const backgroundCommandHandleOpenAtRoute =
        this.dependencies.hasOpenCommandHandles?.() ?? false;
      const fixedSelection = backgroundCommandHandleOpenAtRoute
        ? {
            mode: "code" as const,
            reason: backgroundCommandFinalizationInstruction(),
          }
        : unfinishedGraph
        ? {
            mode: "code" as const,
            reason: "Continue the existing task DAG in code mode until it is completed or explicitly blocked.",
          }
        : outstandingSubagentsAtRoute.length > 0
          ? {
              mode: "code" as const,
              reason:
                "Collect every running or unobserved child assignment in code mode before planning or finishing.",
            }
          : undefined;
      if (fixedSelection) {
        effectiveMode = fixedSelection.mode;
        autoReason = fixedSelection.reason;
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          type: "mode.auto_route",
          phase: "completed",
          payload: fixedSelection,
        });
        this.dependencies.onStatus?.(
          `Auto mode selected ${fixedSelection.mode} — ${fixedSelection.reason}`,
        );
      } else {
        let routeResolved = false;
        while (!routeResolved) {
          await this.takeAndApplySteering(
            state,
            turnId,
            "before_model",
            turnImages,
            false,
            memoryContext,
          );
          let routed;
          try {
            this.dependencies.onStatus?.("Auto mode is choosing how to handle this request...");
            const steeringText = state.messages
              .slice(turnHistoryStart + 1)
              .filter(
                (message): message is Extract<ChatMessage, { role: "user" }> =>
                  message.role === "user" &&
                  message.content.startsWith(
                    runtimePromptText("runtime/steering-prefix.md"),
                  ),
              )
              .map((message) => message.content)
              .join("\n\n");
            const routingInput = [
              userInput,
              turnImages.length
                ? `[${turnImages.length} image attachment(s) are included.]`
                : "",
              steeringText,
            ].filter(Boolean).join("\n\n");
            const priorMessagesStart = Math.min(
              state.compactedMessageCount,
              turnHistoryStart,
            );
            const autoRouteContext: AutoRouteContext = {
              workingSummary: state.workingSummary,
              priorMessages: state.messages.slice(priorMessagesStart, turnHistoryStart),
            };
            const autoRouteBoundary = priorMessagesStart +
              projectAutoRouteContext(autoRouteContext).priorMessageBoundary;
            let routeLayeredContext = pinCurrentState(
              state,
              memoryContext.approvedPlanReview,
            );
            if (this.dependencies.getLayeredContext) {
              try {
                const derived = await this.dependencies.getLayeredContext({
                  state,
                  query: contextRetrievalQuery(state, memoryContext.userInput),
                  beforeMessageIndex: 0,
                });
                routeLayeredContext = pinCurrentState(
                  state,
                  memoryContext.approvedPlanReview,
                  derived,
                );
              } catch (error) {
                if (!contextLayerFailureReported) {
                  contextLayerFailureReported = true;
                  const detail = error instanceof Error ? error.message : String(error);
                  this.dependencies.onStatus?.(
                    `Layered context index is unavailable (${detail}); continuing with the current context.`,
                  );
                }
              }
            }
            // Direct answers must inherit the same base security contract and
            // layered EASYCODE.md guidance as a normal agent request. Empty
            // workspace/memory inputs prevent this controller from answering
            // questions that require repository or retrieval facts.
            const buildControllerPolicy = async (
              context: typeof routeLayeredContext,
            ): Promise<string> => {
              const allowance = optionalMemoryTokenBudget(options.maxContextChars, options.maxContextTokens, this.dependencies.limits);
              const selection = selectMemoryContext({ state, memories: [], evidence: context.evidence ?? [],
                tokenBudget: allowance, limits: this.dependencies.limits,
                queries: memoryQueries(state, memoryContext.userInput), presentText: [state.workingSummary] });
              const evidenceText = context.evidence ? renderRetrievedContext(selection.evidence)
                : requestTokens([{ role: "user", content: context.retrievedThreadEvidence ?? "" }]) <= allowance
                  ? context.retrievedThreadEvidence : undefined;
              return this.dependencies.buildSystemPrompt({
              mode: "auto",
              workspaceSummary: "",
              memories: [],
              ...(context.workingCheckpoint
                ? { workingCheckpoint: context.workingCheckpoint }
                : {}),
              ...(evidenceText
                ? { retrievedThreadEvidence: evidenceText }
                : {}),
              toolNames: [],
              });
            };
            let controllerPolicy = await buildControllerPolicy(routeLayeredContext);
            if (this.dependencies.getLayeredContext) {
              try {
                const derived = await this.dependencies.getLayeredContext({
                  state,
                  query: contextRetrievalQuery(state, memoryContext.userInput),
                  beforeMessageIndex: autoRouteBoundary,
                });
                routeLayeredContext = pinCurrentState(
                  state,
                  memoryContext.approvedPlanReview,
                  derived,
                );
                controllerPolicy = await buildControllerPolicy(routeLayeredContext);
              } catch (error) {
                if (!contextLayerFailureReported) {
                  contextLayerFailureReported = true;
                  const detail = error instanceof Error ? error.message : String(error);
                  this.dependencies.onStatus?.(
                    `Layered context retrieval is unavailable (${detail}); continuing with the Working Checkpoint.`,
                  );
                }
              }
            }
            routed = await this.runProviderAttempt(
              options.signal,
              (attemptSignal) => this.withModelRequestActivity(
                `Waiting for ${this.dependencies.provider.model} response`,
                () => determineAutoRoute(
                  this.dependencies.provider,
                  routingInput,
                  attemptSignal,
                  turnImages,
                  state.thinkingEffort,
                  autoRouteContext,
                  controllerPolicy,
                  (request, attempt) => {
                    const inspection = this.dependencies.contextManager.inspectProviderRequest({
                      state,
                      maxContextChars: options.maxContextChars,
                      messages: request.messages,
                      ...(request.tools ? { tools: request.tools } : {}),
                    });
                    this.observeProviderContext({
                      state,
                      turnId,
                      attempt,
                      purpose: "auto_route",
                      messages: request.messages,
                      ...(request.tools ? { tools: request.tools } : {}),
                      enforcedPressure: inspection.pressure,
                      enforcedUtilization: inspection.utilization,
                      maxContextChars: options.maxContextChars,
                      actualRequest: inspection,
                    });
                  },
                  this.dependencies.limits,
                ),
              ),
            );
          } catch (error) {
            if (
              error instanceof AutoRouteSelectionError ||
              error instanceof AutoRouteRequestError
            ) {
              await this.reportAutoRouteUsage(state, turnId, error.attempts);
            }
            if (error instanceof AutoRouteRequestError) throw error.originalError;
            throw error;
          }
          if (routed.kind === "steering_interrupted") {
            await this.dependencies.appendEvent({
              threadId: state.threadId,
              turnId,
              type: "model.attempt.steering_interrupted",
              phase: "interrupted",
              payload: { purpose: "auto_route" },
            });
            await this.takeAndApplySteering(
              state,
              turnId,
              "after_model",
              turnImages,
              false,
              memoryContext,
            );
            continue;
          }
          const decision = routed.value;
          await this.reportAutoRouteUsage(state, turnId, decision.attempts);
          if (await this.takeAndApplySteering(
            state,
            turnId,
            "after_model",
            turnImages,
            false,
            memoryContext,
          )) {
            continue;
          }
          if (decision.kind === "direct_response") {
            if (reconciliationPending(state)) return this.finish(state, turnId,
              "Cannot finish directly after context reset before reconciling workspace and pending operations. No completion retry.", "failed", 0, memoryContext);
            if (await this.takeAndApplySteering(
              state,
              turnId,
              "before_final",
              turnImages,
              true,
              memoryContext,
            )) {
              continue;
            }
            await this.dependencies.appendEvent({
              threadId: state.threadId,
              turnId,
              type: "mode.auto_direct_response",
              phase: "completed",
              payload: { attempts: decision.attempts.length },
            });
            this.dependencies.onStatus?.(
              "Auto mode answered directly without starting a second model request.",
            );
            const directAssistant: Extract<ChatMessage, { role: "assistant" }> = {
              role: "assistant",
              content: decision.content,
              ...(decision.reasoningContent
                ? { reasoning_content: decision.reasoningContent }
                : {}),
            };
            state.messages.push(directAssistant);
            await this.dependencies.appendEvent({
              threadId: state.threadId,
              turnId,
              type: "message.assistant",
              phase: "completed",
              payload: directAssistant,
            });
            if (state.thinkingEffort !== "none" && decision.reasoningContent) {
              try {
                this.dependencies.onReasoning?.({
                  type: "reasoning",
                  text: decision.reasoningContent,
                  threadId: state.threadId,
                  turnId,
                  step: 0,
                  provider: this.dependencies.provider.name,
                  model: this.dependencies.provider.model,
                  thinkingEffort: state.thinkingEffort,
                });
              } catch {
                // Presentation is transient; the durable assistant remains authoritative.
              }
            }
            this.dependencies.onText?.(decision.content);
            return this.finish(
              state,
              turnId,
              decision.content,
              "success",
              0,
              memoryContext,
            );
          }
          effectiveMode = decision.mode;
          autoReason = decision.reason;
          await this.dependencies.appendEvent({
            threadId: state.threadId,
            turnId,
            type: "mode.auto_route",
            phase: "completed",
            payload: { mode: decision.mode, reason: decision.reason },
          });
          this.dependencies.onStatus?.(
            `Auto mode selected ${decision.mode} — ${decision.reason}`,
          );
          routeResolved = true;
        }
      }
    }

    let memories: readonly Readonly<LongTermMemory>[] = [];
    let rememberedQueryKey = "";
    let rememberedPhaseKey: string | undefined;
    let retrievedQueryKey = "";
    let retrievedCache: RuntimeLayeredContext | undefined;
    let nextImageNumber = nextThreadImageNumber(state.messages);
    const exposedTools = availableTools(
      this.dependencies.toolCatalog.tools,
      effectiveMode,
      agentIdentity.role,
      state.thinkingEffort,
      this.orchestrationToolsAvailable(state, options),
      this.dependencies.visionAvailable ?? true,
    );
    const exposedToolCatalog = snapshotToolSet(
      exposedTools,
      this.dependencies.toolCatalog.revision,
    );
    const toolGateway = new ToolExecutionGateway(
      exposedToolCatalog,
      this.dependencies.authorizeToolExecution,
    );
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "tool.catalog.bound",
      phase: "completed",
      payload: {
        catalogRevision: this.dependencies.toolCatalog.revision,
        catalogHash: this.dependencies.toolCatalog.hash,
        exposureHash: exposedToolCatalog.hash,
        toolCount: exposedToolCatalog.bindings.size,
        toolsTruncated: exposedToolCatalog.bindings.size > MAX_AUDITED_TOOL_BINDINGS,
        tools: [...exposedToolCatalog.bindings.values()]
          .slice(0, MAX_AUDITED_TOOL_BINDINGS)
          .map((binding) => ({
          toolId: binding.toolId,
          modelName: binding.modelName,
          sourceId: binding.sourceId,
          sourceKind: binding.sourceKind,
          schemaHash: binding.schemaHash,
          metadataHash: binding.metadataHash,
          })),
      },
    });
    const progressResponseBase =
      state.progressGuard?.lastObservedResponseOrdinal ?? 0;
    const progressVerificationCommands = new Map<string, VerificationKind>();

    const stepLimit = options.maxSteps;
    let taskDagFinalizationOnly = false;
    const toolRecovery = new ToolRecoveryBudget((this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).modelContentRetries + 1);
    let invalidOutputAttempts = 0;
    const commandRetries = new CommandRetryTracker((this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).sandboxInitializationRetries);
    let lastContextPressureLevel: ContextPressureLevel = "normal";
    let progressReviewModelRequestsUsed = 0;
    for (
      let step = 1;
      step + progressReviewModelRequestsUsed + phaseCompactionRequestsUsed <= Math.min(stepLimit, options.maxSteps) && this.remainingRequests > 0;
      step += 1
    ) {
      if (options.signal?.aborted) {
        return this.finish(
          state,
          turnId,
          "The task was interrupted by the user.",
          "interrupted",
          step - 1,
          memoryContext,
        );
      }

      for (const instruction of this.dependencies.takeAdditionalInstructions?.() ?? []) {
        const followUp: Extract<ChatMessage, { role: "user" }> = {
          role: "user",
          content: renderRuntimePrompt("runtime/parent-follow-up.md", {
            instruction,
          }),
        };
        state.messages.push(followUp);
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `step_${step}`,
          type: "message.user.synthetic",
          phase: "completed",
          payload: followUp,
        });
      }
      if (agentIdentity.role === "main_agent") {
        await this.takeAndApplySteering(
          state,
          turnId,
          "before_model",
          turnImages,
          false,
          memoryContext,
        );
        const shared = this.dependencies.taskBudget?.snapshot();
        const remainingModelRequests = Math.min(this.remainingRequests,
          shared ? shared.maxRequests - shared.requests : Infinity,
          stepLimit - phaseCompactionRequestsUsed - ((step - 1) + progressReviewModelRequestsUsed));
        progressReviewModelRequestsUsed += await this.processProgressIntervention({
          state,
          turnId,
          userInput: memoryContext.userInput,
          remainingModelRequests,
          signal: options.signal,
        });
        if (step + progressReviewModelRequestsUsed + phaseCompactionRequestsUsed > stepLimit) {
          return this.finish(
            state,
            turnId,
            "The shared model-request budget was exhausted while reviewing stalled progress.",
            "limit_reached",
            step - 1,
            memoryContext,
          );
        }
      }
      let layeredContext = pinCurrentState(
        state,
        memoryContext.approvedPlanReview,
      );
      const memoryLimits = this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS;
      const queries = memoryQueries(state, memoryContext.userInput).slice(0, memoryLimits.memoryMaxQueries);
      const queryKey = memoryQueryKey(state, queries);
      let memorySearchCalls = 0;
      const memorySearchStarted = Date.now();
      if (queryKey !== rememberedQueryKey && !reconciliationPending(state)) {
        const found: Readonly<LongTermMemory>[] = [];
        for (const query of queries) {
          memorySearchCalls += 1;
          found.push(...await this.dependencies.searchMemories(query));
        }
        memories = [...new Map(found.map((memory) => [memory.id, memory])).values()];
        rememberedQueryKey = queryKey;
      }
      const memorySearchDurationMs = Date.now() - memorySearchStarted;
      const workspaceSummary = await this.dependencies.getWorkspaceSummary();
      const ordinaryEnabledTools = taskDagFinalizationOnly
        ? state.taskGraph?.status === "completed"
          ? [...toolGateway.catalog.tools].filter((tool) => tool.name === "manage_memory")
          : []
        : [...toolGateway.catalog.tools].filter((tool) =>
            tool.name !== "compact_context"
          );
      const runtimeNextActions = [
        this.dependencies.hasOpenCommandHandles?.()
          ? backgroundCommandFinalizationInstruction()
          : "",
        agentIdentity.role === "main_agent"
          ? progressRuntimeInstruction(state, progressScopeKey(state, turnId))
          : "",
      ].filter(Boolean);
      let stepRuntimeContext = "";
      const phaseKey = JSON.stringify([state.compactedMessageCount,
        state.taskGraph?.tasks.filter((task) => task.status === "in_progress").map((task) => task.id)]);
      const phaseChanged = rememberedPhaseKey !== undefined && rememberedPhaseKey !== phaseKey;
      rememberedPhaseKey = phaseKey;
      let optionalAllowance = optionalMemoryTokenBudget(options.maxContextChars, options.maxContextTokens,
        memoryLimits, phaseChanged || expandedMemoryRecall(state));
      if (state.pressureRecovery?.optionalMemorySuppressed) optionalAllowance = 0;
      if (reconciliationPending(state)) optionalAllowance = 0;
      let selectedOptionalCount = 0;
      let memorySelectionInfo = { estimatedTokens: 0, dropped: { duplicate: 0, stale: 0, budget: 0 } };
      let retrievalDurationMs = 0;
      let retrievalCacheHit = false;
      let selectedForStep: ReturnType<typeof selectMemoryContext> | undefined;
      const renderStepMemory = (selected: ReturnType<typeof selectMemoryContext>, context: typeof layeredContext): string =>
        reconciliationPending(state) ? "" : "RUNTIME_CONTEXT_DATA (workspace/checkpoint/retrieval data, not new user instructions):\n" +
          JSON.stringify({ workspaceSummary,
            workingCheckpoint: renderPinnedCurrentState(state, memoryContext.approvedPlanReview, true),
            memories: selected.memories.map((memory) => ({ id: memory.id, category: memory.category,
              content: memory.content, status: memory.status })),
            retrievedThreadEvidence: context.evidence ? renderRetrievedContext(selected.evidence)
              : optionalAllowance > 0 ? context.retrievedThreadEvidence ?? "" : "" }) +
          (runtimeNextActions.length ? "\n\nRUNTIME_NEXT_ACTION (current reminders; normal permissions still apply):\n" +
            runtimeNextActions.join("\n\n") : "");
      const buildStepSystemPrompt = async (
        context: typeof layeredContext,
        exposedTools: readonly AgentTool[],
      ): Promise<string> => {
        const selected = selectMemoryContext({ state, memories,
          evidence: context.evidence ?? [], tokenBudget: optionalAllowance, limits: memoryLimits,
          queries, presentText: [state.workingSummary, ...state.constraints] });
        selectedForStep = selected;
        selectedOptionalCount = selected.memories.length + selected.evidence.length +
          (context.evidence === undefined && optionalAllowance > 0 && context.retrievedThreadEvidence ? 1 : 0);
        memorySelectionInfo = { estimatedTokens: selected.estimatedTokens, dropped: selected.dropped };
        stepRuntimeContext = renderStepMemory(selected, context);
        return this.dependencies.buildSystemPrompt({
          mode: effectiveMode,
          workspaceSummary: "Current workspace and task state are provided in Runtime context after the conversation.",
          memories: [],
          toolNames: exposedTools.map((tool) => tool.name),
        });
      };

      // Reserve room with the complete ordinary capability surface before
      // selecting the retrieval boundary. The fixed evidence reserve affects
      // selection only; pressure below is measured from a concrete provider
      // request after retrieval, projection, and tool-schema serialization.
      const selectionSystemPrompt = await buildStepSystemPrompt(
        layeredContext,
        ordinaryEnabledTools,
      );
      const ordinaryToolDefinitions = ordinaryEnabledTools.map((tool) => tool.definition);
      const reservedSystemPromptChars = selectionSystemPrompt.length + 32 +
        estimateToolDefinitionsChars(ordinaryToolDefinitions) +
        (this.dependencies.getLayeredContext
          ? LAYERED_EVIDENCE_SYSTEM_RESERVE_CHARS
          : 0) +
        CONTEXT_PRESSURE_SYSTEM_RESERVE_CHARS;
      let retrievalContextChanged = false;
      if (this.dependencies.getLayeredContext && !reconciliationPending(state)) {
        try {
          const boundary = this.dependencies.contextManager.retrievalBoundary(
            state, options.maxContextChars, selectionSystemPrompt, reservedSystemPromptChars, stepRuntimeContext);
          const cacheKey = `${queryKey}:${boundary}`;
          const retrievalStarted = Date.now();
          retrievalCacheHit = retrievedQueryKey === cacheKey && retrievedCache !== undefined;
          const derived = retrievedQueryKey === cacheKey && retrievedCache ? retrievedCache
            : await this.dependencies.getLayeredContext({
            state,
            query: contextRetrievalQuery(state, memoryContext.userInput), queries,
            beforeMessageIndex: boundary,
          });
          retrievedQueryKey = cacheKey;
          retrievedCache = derived;
          retrievalDurationMs = Date.now() - retrievalStarted;
          layeredContext = pinCurrentState(
            state,
            memoryContext.approvedPlanReview,
            derived,
          );
          retrievalContextChanged = true;
        } catch (error) {
          if (!contextLayerFailureReported) {
            contextLayerFailureReported = true;
            const detail = error instanceof Error ? error.message : String(error);
            this.dependencies.onStatus?.(
              `Layered context retrieval is unavailable (${detail}); continuing with the Working Checkpoint.`,
            );
          }
        }
      }

      let systemPrompt = retrievalContextChanged
        ? await buildStepSystemPrompt(
            layeredContext,
            ordinaryEnabledTools,
          )
        : selectionSystemPrompt;
      let enabledTools = ordinaryEnabledTools;
      let messages = this.dependencies.contextManager.build({
        systemPrompt,
        runtimeContext: stepRuntimeContext,
        state,
        maxContextChars: options.maxContextChars,
        reservedSystemPromptChars,
      });
      let requestInspection = this.dependencies.contextManager.inspectProviderRequest({
        state,
        maxContextChars: options.maxContextChars,
        messages,
        tools: ordinaryToolDefinitions,
      });
      let contextPressure = requestInspection.pressure;
      let contextUtilization = requestInspection.utilization;
      const setMemoryGate = async (suppressed: boolean) => {
        if (Boolean(state.pressureRecovery?.optionalMemorySuppressed) === suppressed) return;
        const payload = { suppressed };
        await this.dependencies.appendEvent({ threadId: state.threadId, turnId,
          type: "context.memory.gated", phase: "completed", payload });
        foldMemoryGate(state, payload);
      };
      if (contextUtilization >= memoryLimits.contextReferenceTriggerRatio) await setMemoryGate(true);
      else if (contextUtilization <= memoryLimits.contextMemoryResumeRatio) await setMemoryGate(false);

      // Optional recall must not force eviction of the live working chain.
      // First remove optional memory as whole records, then reassess pressure.
      if (selectedOptionalCount > 0 && contextPressure !== "normal") {
        optionalAllowance = 0;
        systemPrompt = await buildStepSystemPrompt(layeredContext, ordinaryEnabledTools);
        messages = this.dependencies.contextManager.build({ systemPrompt, runtimeContext: stepRuntimeContext,
          state, maxContextChars: options.maxContextChars, reservedSystemPromptChars });
        requestInspection = this.dependencies.contextManager.inspectProviderRequest({ state,
          maxContextChars: options.maxContextChars, messages, tools: ordinaryToolDefinitions });
        contextPressure = requestInspection.pressure;
        contextUtilization = requestInspection.utilization;
      }

      // One isolated transaction for token/character capacity and explicit requests.
      { // Also enforce the aggregate tool-output budget below the pressure trigger.
        const compacted = await this.maintainContext(state, turnId, turnImages, memoryContext, options,
          { systemPrompt, runtimeContext: stepRuntimeContext, tools: ordinaryToolDefinitions,
            reservedTokens: Math.max(0, optionalAllowance - memorySelectionInfo.estimatedTokens) },
          contextUtilization >= memoryLimits.contextCompactionTriggerRatio,
          stepLimit - step + 1 - progressReviewModelRequestsUsed - phaseCompactionRequestsUsed);
        phaseCompactionRequestsUsed += compacted.requests;
        if (compacted.paused) return this.finish(state, turnId,
          `Context paused: ${compacted.paused.reason} Required ${compacted.paused.usage} / ${compacted.paused.capacity} ${compacted.paused.unit}. History, files and pending operations are preserved. Reduce required input or use a larger supported window to resume.`,
          "limit_reached", step, memoryContext, undefined, undefined,
          { code: "context_capacity_exhausted", tool: "runtime", attempts: state.compactionControl?.transaction?.attempts ?? 0, recoverable: true });
        if (compacted.committed || compacted.requests > 0) {
          step -= 1;
          continue;
        }
      }
      if (contextPressure !== lastContextPressureLevel) {
        const percent = contextUtilizationPercent(contextUtilization);
        if (contextPressure === "normal") {
          this.dependencies.onStatus?.(
            `Context utilization returned below 60% (${percent}%).`,
          );
        } else if (contextPressure === "suggest") {
          this.dependencies.onStatus?.(
            `Context utilization is ${percent}%; Runtime will maintain context at complete tool-exchange boundaries.`,
          );
        } else if (contextPressure === "require") {
          this.dependencies.onStatus?.(
            `Context utilization is ${percent}%; Runtime is reclaiming context before more work.`,
          );
        } else {
          this.dependencies.onStatus?.(
            `Context utilization is ${percent}%; Runtime is checking local recovery capacity.`,
          );
        }
        lastContextPressureLevel = contextPressure;
      }
      // Remove only duplicates backed by the FINAL visible message set. Keep
      // all other messages byte-identical: no re-selection can evict their proof.
      if (selectedForStep && selectedOptionalCount > 0) {
        const subset = selectMemoryContext({ state, memories: selectedForStep.memories, evidence: selectedForStep.evidence,
          tokenBudget: optionalAllowance, limits: memoryLimits, queries,
          presentText: [state.workingSummary, ...state.constraints, ...visibleMemoryText(messages.filter((message) =>
            message.content !== stepRuntimeContext))] });
        const reducedContext = renderStepMemory(subset, layeredContext);
        if (reducedContext.length <= stepRuntimeContext.length) {
          messages = messages.map((message) => message.role === "user" && message.content === stepRuntimeContext
            ? { ...message, content: reducedContext } : message);
          stepRuntimeContext = reducedContext;
          memorySelectionInfo = { estimatedTokens: subset.estimatedTokens, dropped: {
            duplicate: selectedForStep.dropped.duplicate + subset.dropped.duplicate,
            stale: selectedForStep.dropped.stale + subset.dropped.stale,
            budget: selectedForStep.dropped.budget + subset.dropped.budget } };
          selectedOptionalCount -= selectedForStep.memories.length + selectedForStep.evidence.length - subset.memories.length - subset.evidence.length;
          requestInspection = this.dependencies.contextManager.inspectProviderRequest({ state,
            maxContextChars: options.maxContextChars, messages, tools: enabledTools.map((tool) => tool.definition) });
        }
      }
      await this.dependencies.appendEvent({ threadId: state.threadId, turnId, stepId: `step_${step}`,
        type: "context.memory.selected", phase: "completed", payload: {
          estimatedTokens: memorySelectionInfo.estimatedTokens, dropped: memorySelectionInfo.dropped,
          memorySearchCalls, memorySearchDurationMs, retrievalCacheHit, optionalAllowance,
          retrievalDurationMs, selectedOptionalCount, tokenCapacityEnabled: options.maxContextTokens !== undefined,
        } });
      this.observeProviderContext({
        state,
        turnId,
        step,
        attempt: 1,
        purpose: "agent_step",
        messages,
        tools: enabledTools.map((tool) => tool.definition),
        enforcedPressure: contextPressure,
        enforcedUtilization: contextUtilization,
        maxContextChars: options.maxContextChars,
        actualRequest: requestInspection,
      });
      this.dependencies.onStatus?.(
        `Step ${step}/${options.maxSteps}: requesting ${this.dependencies.provider.model}`
      );

      let response;
      try {
        const attempted = await this.runProviderAttempt(
          options.signal,
          (attemptSignal) => this.withModelRequestActivity(
            `Waiting for ${this.dependencies.provider.model} response`,
            () => this.dependencies.provider.complete({
              messages,
              currentTurnImageIds: turnImages.map((image) => image.id),
              tools: enabledTools.map((tool) => tool.definition),
              signal: attemptSignal,
              thinkingEffort: state.thinkingEffort,
            }),
          ),
        );
        if (attempted.kind === "steering_interrupted") {
          await this.dependencies.appendEvent({
            threadId: state.threadId,
            turnId,
            stepId: `step_${step}`,
            type: "model.attempt.steering_interrupted",
            phase: "interrupted",
            payload: { purpose: "agent_step" },
          });
          await this.takeAndApplySteering(
            state,
            turnId,
            "after_model",
            turnImages,
            false,
            memoryContext,
          );
          step -= 1;
          continue;
        }
        response = attempted.value;
        const compactOnly =
          response.message.tool_calls?.length === 1 &&
          response.message.tool_calls[0]?.function.name === "compact_context";
        await this.reportModelUsage(
          state,
          turnId,
          compactOnly
            ? "context_compaction"
            : "agent_step",
          response.usage,
          { step, attempt: 1, retry: false },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!options.signal?.aborted && isContextCapacityError(error)) {
          return this.finish(state, turnId,
            "Context paused: the provider rejected the input capacity after bounded recovery. History, files and pending operations are preserved; reduce required input or configure a supported model window before resuming.",
            "limit_reached", step, memoryContext, undefined, undefined,
            { code: "context_capacity_exhausted", tool: "runtime", attempts: state.pressureRecovery?.serverReset ? 1 : 0, recoverable: true });
        }
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `step_${step}`,
          type: "model.error",
          phase: "failed",
          payload: { message, category: failureCategory(error, options.signal), commandReplay: false }
        });
        const interrupted = Boolean(options.signal?.aborted);
        return this.finish(
          state,
          turnId,
          interrupted ? "The task was interrupted by the user." : `Model request failed: ${message}`,
          interrupted ? "interrupted" : error instanceof TaskBudgetExceeded ? "limit_reached" : "failed",
          error instanceof TaskBudgetExceeded ? options.maxSteps - this.remainingRequests : step,
          memoryContext,
          undefined,
          undefined,
          interrupted ? undefined : contextCapacityFailure(error, state),
        );
      }

      if (
        agentIdentity.role === "main_agent" &&
        await this.takeAndApplySteering(
          state,
          turnId,
          "after_model",
          turnImages,
          false,
          memoryContext,
        )
      ) {
        // The response was never added to the transcript, so a tool-call
        // protocol cannot be left half-open. Retry this logical step with the
        // newly coalesced user message.
        step -= 1;
        continue;
      }

      const suppressFinalizationToolCalls =
        taskDagFinalizationOnly &&
        Boolean(response.message.tool_calls?.length) &&
        !(
          state.taskGraph?.status === "completed" &&
          response.message.tool_calls?.every(
            (call) => call.function.name === "manage_memory",
          )
        );
      const executionToolCalls = suppressFinalizationToolCalls
        ? undefined
        : response.message.tool_calls;
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: suppressFinalizationToolCalls
          ? response.message.content?.trim() || terminalTaskGraphText(state.taskGraph)
          : response.message.content,
        tool_calls: suppressFinalizationToolCalls
          ? undefined
          : executionToolCalls?.map(durableToolCall),
        reasoning_content: response.message.reasoning_content
      };
      if (suppressFinalizationToolCalls) {
        this.dependencies.onStatus?.(
          "Ignored tools other than memory maintenance during task-DAG finalization.",
        );
      }
      state.messages.push(assistantMessage);
      const projectionHistory: ChatMessage[] = [...messages, assistantMessage];
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        stepId: `step_${step}`,
        type: "message.assistant",
        phase: "completed",
        payload: assistantMessage
      });
      const reasoningText = response.message.reasoning_content;
      const thinkingEffort = state.thinkingEffort;
      if (
        thinkingEffort !== "none" &&
        reasoningText !== undefined &&
        reasoningText !== null &&
        reasoningText.trim().length > 0
      ) {
        try {
          this.dependencies.onReasoning?.({
            type: "reasoning",
            text: reasoningText,
            threadId: state.threadId,
            turnId,
            step,
            provider: this.dependencies.provider.name,
            model: this.dependencies.provider.model,
            thinkingEffort,
          });
        } catch {
          // This hook is ephemeral presentation only. A broken UI must not
          // interrupt the durable assistant message or its pending tool calls.
        }
      }

      // Execute original arguments; the complete sanitized candidate remains
      // in history until an accepted compaction retires it.
      const invalidOutput = incompleteModelOutput(response);
      if (invalidOutput) {
        invalidOutputAttempts++;
        for (const call of executionToolCalls ?? []) {
          const rejected: ChatMessage = { role: "tool", name: call.function.name, tool_call_id: call.id,
            content: JSON.stringify({ ok: false, error: invalidOutput, executed: false }) };
          state.messages.push(rejected);
          await this.dependencies.appendEvent({ threadId: state.threadId, turnId, type: "tool.result", phase: "failed",
            payload: { callId: call.id, tool: call.function.name, message: rejected, result: { ok: false, executed: false, error: invalidOutput } } });
        }
        const feedback: ChatMessage = { role: "user", content: "RUNTIME_MODEL_CONTENT_ERROR: " + invalidOutput };
        state.messages.push(feedback);
        await this.dependencies.appendEvent({ threadId: state.threadId, turnId, type: "message.user.synthetic", payload: feedback });
        if (invalidOutputAttempts <= (this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).modelContentRetries) continue;
        return this.finish(state, turnId, invalidOutput + " Content correction budget exhausted; work is unverified and retained.", "failed", step, memoryContext);
      }
      invalidOutputAttempts = 0;
      const calls = executionToolCalls ?? [];
      if (calls.length === 0) {
        if (reconciliationPending(state)) return this.finish(state, turnId,
          "Cannot finish before context-reset reconciliation. Inspect the current workspace and query original pending operations; no completion retry.", "failed", step, memoryContext);
        if (this.dependencies.hasOpenCommandHandles?.()) {
          const instruction = backgroundCommandFinalizationInstruction();
          return this.finish(
            state,
            turnId,
            instruction,
            "failed",
            step,
            memoryContext,
          );
        }
        const pendingExperiment = agentIdentity.role === "main_agent"
          ? requiredProgressExperiment(
              state,
              progressScopeKey(state, turnId),
            )
          : undefined;
        if (pendingExperiment) {
          const instruction = progressRuntimeInstruction(
            state,
            pendingExperiment.scopeKey,
          );
          return this.finish(
            state,
            turnId,
            "The required progress experiment was not executed with a real terminal verification result. No automatic completion retry.",
            "failed",
            step,
            memoryContext,
          );
        }
        const text =
          assistantMessage.content?.trim() ||
          "The task ended, but the model did not provide an explanation.";
        if (agentIdentity.role === "subagent") {
          return this.finish(state, turnId, "The child tried to finish without submit_task_result. No automatic retry; parent must decide how to continue.", "failed", step, memoryContext);
        }
        const outstandingSubagents = this.dependencies.getOutstandingSubagents?.() ?? [];
        if (outstandingSubagents.length > 0) {
          return this.finish(
            state,
            turnId,
            "The main agent did not collect all outstanding child results.",
            "failed",
            step,
            memoryContext,
          );
        }
        if (state.taskGraph?.status === "active") {
          return this.finish(state, turnId, "Cannot finish: the task DAG is incomplete. No automatic completion retry.", "failed", step, memoryContext);
        }
        if (effectiveMode === "plan") {
          return this.finish(state, turnId, "Cannot finish Plan mode without a valid propose_plan submission. No automatic completion retry.", "failed", step, memoryContext);
        }
        if (await this.takeAndApplySteering(
          state,
          turnId,
          "before_final",
          turnImages,
          true,
          memoryContext,
        )) {
          continue;
        }
        if (agentIdentity.role === "main_agent" && this.dependencies.runReviewSession && (state.changes.length > 0 || pendingDelivery(state)) &&
            state.taskGraph?.status !== "blocked") {
          if (!state.delivery || pendingDelivery(state) && state.reviewSessions?.some(s => s.scope === state.delivery!.id && s.approval && s.status === "applied")) {
            const obligation = newDelivery(state, memoryContext.userInput, turnHistoryStart, turnChangeStart);
            await this.dependencies.appendEvent({ threadId: state.threadId, turnId, type: "delivery.required", payload: obligation });
            foldDelivery(state, obligation);
          }
          const review = await this.dependencies.runReviewSession({ state, turnId, userInput: state.delivery!.request,
            maxContextTokens: this.dependencies.contextManager.tokenCapacity?.window,
            purpose: "delivery", remainingModelRequests: Math.max(0, stepLimit - step - progressReviewModelRequestsUsed - phaseCompactionRequestsUsed),
            signal: options.signal });
          progressReviewModelRequestsUsed += review.requests;
          if (!review.approved) {
            if (review.decision === "unavailable" || review.decision === "interrupted") return this.finish(state, turnId,
              `Review unavailable; work and the unverified delivery obligation are retained. ${review.reason ?? "No valid review could be completed."}`,
              review.decision === "interrupted" ? "interrupted" : "blocked", step, memoryContext);
            return this.finish(state, turnId,
              `Delivery remains unapproved: ${review.reason ?? "unresolved review"}. Opinions and evidence are retained. No automatic completion retry.`,
              "failed", step, memoryContext);
          }
          if (await this.takeAndApplySteering(state, turnId, "before_final", turnImages, true, memoryContext)) continue;
        }
        this.dependencies.onText?.(text);
        const reason = state.taskGraph?.status === "blocked"
          ? "blocked"
          : "success";
        const prefix = state.mode === "auto" && autoReason ? `Auto decision: ${autoReason}\n\n` : "";
        return this.finish(state, turnId, `${prefix}${text}`, reason, step, memoryContext);
      }

      const compactContextIsExclusive =
        calls.length === 1 && calls[0]?.function.name === "compact_context";
      const manageTasksBatched =
        calls.length > 1 && calls.some((call) => call.function.name === "manage_tasks");
      const manageSubagentsMixed =
        calls.length > 1 &&
        calls.some((call) => call.function.name === "manage_subagents") &&
        !calls.every((call) => call.function.name === "manage_subagents");
      const proposePlanBatched =
        calls.length > 1 && calls.some((call) => call.function.name === "propose_plan");
      const submitTaskResultBatched =
        calls.length > 1 &&
        calls.some((call) => call.function.name === "submit_task_result");
      const stepImageAttachments: ImageAttachment[] = [];
      let proposedPlan: PlanProposal | undefined;
      let submittedTaskReport: SubagentTaskReport | undefined;
      let steeringAppliedBetweenTools = false;
      let requiredProtocolExhaustion: { tool: string; attempt: number } | undefined;
      let finishRejectedReason: string | undefined;
      let completedVerificationPhase = false;

      for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
        const call = calls[callIndex]!;
        if (
          agentIdentity.role === "main_agent" &&
          await this.dependencies.hasPendingSteering?.({
            threadId: state.threadId,
            turnId,
          })
        ) {
          // Close the assistant's complete tool-call protocol before the
          // durable steering application event adds a new user message.
          for (const skipped of calls.slice(callIndex)) {
            await this.dependencies.appendEvent({
              threadId: state.threadId,
              turnId,
              stepId: `step_${step}`,
              type: "tool.call",
              phase: "requested",
              payload: durableToolCall(skipped),
            });
            const skippedResult: ToolExecutionResult = {
              ok: false,
              summary: "Tool call skipped because newer user steering arrived.",
              error: "superseded_by_user_steering",
            };
            const skippedMessage: ChatMessage = {
              role: "tool",
              tool_call_id: skipped.id,
              name: skipped.function.name,
              content: resultForModel(skippedResult, options.maxOutputChars),
            };
            const skippedEventId = createId("event");
            const skippedObservation = observeToolResult({
              sourceEventId: skippedEventId,
              sourceCallId: skipped.id,
              scopeKey: progressScopeKey(state, turnId),
              responseOrdinal: progressResponseOrdinal(progressResponseBase, step),
              tool: skipped.function.name,
              result: skippedResult,
              verificationIntent: false,
            });
            await this.dependencies.appendEvent({
              eventId: skippedEventId,
              threadId: state.threadId,
              turnId,
              stepId: `step_${step}`,
              type: "tool.result",
              phase: "interrupted",
              payload: {
                callId: skipped.id,
                tool: skipped.function.name,
                message: skippedMessage,
                progressObservation: skippedObservation,
              },
            });
            state.progressGuard = foldProgressObservation(
              state.progressGuard ?? createProgressGuardState(),
              skippedObservation,
            ).state;
            state.messages.push(skippedMessage);
          }
          await this.takeAndApplySteering(
            state,
            turnId,
            "between_tools",
            turnImages,
            false,
            memoryContext,
          );
          steeringAppliedBetweenTools = true;
          break;
        }
        const toolName = call.function.name as ToolName;
        const tool = toolGateway.get(toolName);
        // Pure file reading and Plan explanations pay no inventory-scan cost.
        // Capture before the first capability that could change verification bytes,
        // including arbitrary inspect commands and shared-workspace children.
        if (!state.progressGuard?.validationBaseline && tool &&
            toolMetadata(tool).validationSensitive) {
          const baseline = await (this.dependencies.captureValidationBaseline?.() ?? captureValidationBaseline(state.workspaceRoot, this.dependencies.limits));
          await this.appendProgressReviewEvent(state, turnId, "progress.validation.baseline", "completed", { baseline });
        }
        const taskIdAtCall = activeTask(state.taskGraph)?.id;
        const progressExperimentAtCall = agentIdentity.role === "main_agent"
          ? requiredProgressExperiment(
              state,
              taskIdAtCall
                ? `thread:${state.threadId}/task:${taskIdAtCall}`
                : progressScopeKey(state, turnId),
            )
          : undefined;
        let taskGraphOperation: TaskGraphTransitionOperation | undefined;
        let subagentTaskOperation: SubagentTaskTransitionOperation | undefined;
        let result: ToolExecutionResult;
        let preparedSubagentLifecycle: SubagentLifecycleUpdate | undefined;
        let preparedSubagentLifecycleRolledBack = false;

        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `step_${step}`,
          type: "tool.call",
          phase: "requested",
          payload: durableToolCall(call)
        });

        const journalRecall = tool && toolName === "manage_memory"
          ? recallCompactionEvidence(state, call.function.arguments, this.dependencies.limits) : undefined;
        if (!compactContextIsExclusive && calls.some((item) => item.function.name === "compact_context")) {
          result = { ok: false, summary: "compact_context cannot be batched with workspace tools; no call in this batch was executed.",
            error: "context_compaction_must_be_exclusive",
            failure: protocolToolFailure("context_compaction_must_be_exclusive", "Continue normal work without compact_context; Runtime manages context maintenance.") };
        } else if (journalRecall) {
          result = journalRecall;
        } else if (toolName === "compact_context") {
          result = { ok: false, summary: "No valid semantic compaction request was parsed." };
          let patch: ReturnType<typeof parseSemanticRequestPatch> | undefined;
          try {
            if (!tool || !compactContextIsExclusive) throw new Error("compact_context must be available and called alone");
            patch = parseSemanticRequestPatch(prepareToolInput(tool, call.function.arguments));
          } catch (error) {
            const rejected = toolFailure(error, "Invalid semantic compaction request");
            result = { ...rejected, failure: { ...rejected.failure!,
              execution: "not_started", recovery: "correct_arguments" } };
          }
          if (patch) {
            const payload = { patch };
            // Journal failures are not model content errors and must not be retried as parameters.
            await this.dependencies.appendEvent({ threadId: state.threadId, turnId, type: "context.compaction.requested", payload });
            foldCompactionControl(state, "context.compaction.requested", payload);
            result = { ok: true, summary: "Compaction requested. Runtime will assess the candidate at the next complete tool-exchange boundary." };
          }
        } else if (
          progressExperimentAtCall &&
          (!tool || !toolMetadata(tool).progressExperiment)
        ) {
          result = {
            ok: false,
            summary:
              "Runtime requires a read-only or command-based falsifiable experiment before ordinary mutations or task transitions.",
            error: "progress_experiment_required",
          };
        } else if (manageTasksBatched) {
          result = {
            ok: false,
            summary: "manage_tasks must be the only tool call in a model response.",
            error: "manage_tasks_must_be_exclusive",
          };
        } else if (manageSubagentsMixed) {
          result = {
            ok: false,
            summary:
              "manage_subagents may be batched only with other manage_subagents calls.",
            error: "manage_subagents_must_not_mix_with_other_tools",
          };
        } else if (proposePlanBatched) {
          result = {
            ok: false,
            summary: "propose_plan must be the only tool call in a model response.",
            error: "propose_plan_must_be_exclusive",
          };
        } else if (submitTaskResultBatched) {
          result = {
            ok: false,
            summary: "submit_task_result must be the only tool call in a model response.",
            error: "submit_task_result_must_be_exclusive",
          };
        } else if (!tool) {
          result = {
            ok: false,
            summary: `Tool ${call.function.name} is not available in the current mode.`,
            error: "tool_not_available",
            failure: protocolToolFailure("tool_not_available", "Use only currently exposed tools. This call was not executed; permissions have not changed."),
          };
        } else {
          try {
            const graphError = taskGraphToolError(state.taskGraph, tool, turnId);
            if (graphError) throw new Error(graphError);
            const preparedInvocation = toolGateway.prepare(toolName, call.function.arguments);
            if (!preparedInvocation) throw new Error(`Tool ${toolName} is not available`);
            const rawInput = preparedInvocation.input;
            let input: unknown = rawInput;
            if (toolName === "manage_tasks") {
              const parsedOperation = taskGraphOperationSchema.parse(rawInput);
              if (
                (parsedOperation.action === "complete" ||
                  parsedOperation.action === "block") &&
                this.dependencies.hasOpenCommandHandles?.()
              ) {
                finishRejectedReason = backgroundCommandFinalizationInstruction();
                throw new Error(finishRejectedReason);
              }
              if (
                parsedOperation.action === "create" &&
                (this.dependencies.getOutstandingSubagents?.() ?? []).some(
                  (agent) => agent.assignmentKind === "standalone",
                )
              ) {
                throw new Error(
                  "Collect every standalone child result before creating a task DAG.",
                );
              }
              input = parsedOperation;
              if (parsedOperation.action !== "list") {
                taskGraphOperation = parsedOperation;
              }
            }
            if (
              toolName === "submit_task_result" &&
              this.dependencies.hasOpenCommandHandles?.()
            ) {
              finishRejectedReason = backgroundCommandFinalizationInstruction();
              throw new Error(finishRejectedReason);
            }
            this.dependencies.onStatus?.(`Tool: ${tool.name}`);
            const toolContext = {
              limits: this.dependencies.limits,
              resultTokenBudget: this.dependencies.contextManager.tokenCapacity
                ? Math.max(0, this.dependencies.contextManager.tokenCapacity.inputCapacity -
                  this.dependencies.contextManager.estimateRequestTokens(projectionHistory, ordinaryToolDefinitions) -
                  (this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).contextSafetyReserveTokens)
                : undefined,
              resultCharBudget: this.dependencies.contextManager.tokenCapacity ? undefined
                : Math.max(0, this.dependencies.contextManager.activeCharBudget(options.maxContextChars) -
                  JSON.stringify(projectionHistory).length - estimateToolDefinitionsChars(ordinaryToolDefinitions) -
                  (this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).contextSafetyReserveTokens * 2),
              orchestrationEnabled: options.orchestrationEnabled,
              isOrchestrationEnabled: options.isOrchestrationEnabled,
              workspaceRoot: state.workspaceRoot,
              validationBaseline: state.progressGuard?.validationBaseline,
              ...(progressExperimentAtCall?.reviewReport ? { progressExperiment: {
                incidentId: progressExperimentAtCall.incidentId, report: progressExperimentAtCall.reviewReport } } : {}),
              mode: effectiveMode,
              threadId: state.threadId,
              turnId,
              approvalPolicy: options.approvalPolicy,
              commandExecutionMode: options.commandExecutionMode,
              isUnrestrictedHostAccessActive: options.isUnrestrictedHostAccessActive,
              unrestrictedHostAccessEpoch: options.unrestrictedHostAccessEpoch,
              requestApproval: this.dependencies.requestApproval,
              signal: options.signal,
              commandTimeoutMs: options.commandTimeoutMs,
              maxOutputChars: options.maxOutputChars,
              agentRole: agentIdentity.role,
              ...(agentIdentity.role === "subagent"
                ? {
                    agentId: agentIdentity.agentId,
                    assignedTaskId: agentIdentity.assignedTaskId,
                  }
                : {}),
              thinkingEffort: state.thinkingEffort,
              provider: state.provider,
              model: state.model,
              toolCallId: call.id,
              searchProjectMemory: this.dependencies.searchMemories,
              recallContext: async (input: { evidenceId: string; offset: number; limit: number }) => recallThreadContext(state, input,
                this.dependencies.readToolEvidence ? (id, offset, limit) =>
                  this.dependencies.readToolEvidence!(state, id, offset, limit) : undefined, this.dependencies.limits),
              ...(this.dependencies.getLayeredContext ? { searchHistory: async (query: string, limit: number) => {
                const history = await this.dependencies.getLayeredContext!({ state, query, queries: [query],
                  beforeMessageIndex: state.messages.length });
                return (history.evidence ?? []).slice(0, limit).map((hit) => ({
                  id: hit.id, title: hit.title.slice(0, 160), preview: hit.content.slice(0, 400), historical: true as const,
                }));
              } } : {}),
              ...(state.taskGraph
                ? { taskGraph: cloneTaskGraph(state.taskGraph) }
                : {}),
              recordCommand: (entry: CommandAuditEntry) => {
                const taskId = state.taskGraph ? activeTask(state.taskGraph)?.id : undefined;
                const scopedEntry: CommandAuditEntry = { ...entry,
                  sourceAgentRole: agentIdentity.role,
                  sourceScopeKey: state.taskGraph
                    ? `${state.threadId}/${state.taskGraph.id}/${taskId ?? "none"}`
                    : `${state.threadId}/intent:${state.contextIntentLedger?.latestRequest.sourceMessageIndex ?? turnId}`,
                  ...(agentIdentity.role === "subagent" ? { sourceAgentId: agentIdentity.agentId } : {}),
                  ...(taskId ? { sourceTaskId: taskId } : {}),
                };
                state.commands.push(scopedEntry);
                this.dependencies.recordCommand?.(turnId, scopedEntry);
              },
              ...(this.dependencies.attachImage
                ? {
                    attachImage: async (image: {
                      absolutePath: string;
                      sourceName?: string;
                    }) => {
                      if (turnImages.length >= MAX_IMAGES_PER_MODEL_REQUEST) {
                        throw new Error(
                          `A turn can contain at most ${MAX_IMAGES_PER_MODEL_REQUEST} images.`,
                        );
                      }
                      assertThreadImageNumberAvailable(nextImageNumber);
                      const attachment = await this.dependencies.attachImage?.({
                        threadId: state.threadId,
                        label: `Image #${nextImageNumber}`,
                        absolutePath: image.absolutePath,
                        sourceName: image.sourceName,
                      });
                      if (!attachment) {
                        throw new Error("Image attachment storage is unavailable.");
                      }
                      try {
                        validateImageAttachmentCollection([...turnImages, attachment]);
                        validateProviderImageAttachments(
                          this.dependencies.provider.name,
                          [attachment],
                        );
                      } catch (error) {
                        await this.dependencies.discardImage?.(state.threadId, attachment)
                          .catch(() => undefined);
                        throw error;
                      }
                      turnImages.push(attachment);
                      nextImageNumber += 1;
                      return attachment;
                    },
                  }
                : {}),
            };
            const waitAttempt = tool.name === "poll_command" ? this.dependencies.steeringNotifier?.openAttempt() : undefined;
            try {
              result = reconciliationGate(state, tool.name, input) ?? commandRetries.before(tool.name, input) ?? await toolGateway.invoke(
                { ...preparedInvocation, input },
                { ...toolContext, waitSignal: waitAttempt?.signal },
                (name, execute) => this.withToolExecutionActivity(name, execute),
              );
              result = commandRetries.after(tool.name, input, result);
            } finally { waitAttempt?.dispose(); }
            preparedSubagentLifecycle = result.subagentLifecycle;
          } catch (error) {
            result = toolFailure(error, `Tool ${call.function.name} failed.`);
          }
        }


        if (
          toolName === "manage_memory" &&
          result.ok &&
          result.memoryMutation &&
          memoryContext.mutations.length >= MAX_MEMORY_MUTATIONS_PER_TURN
        ) {
          result = {
            ok: false,
            summary: `A turn can stage at most ${MAX_MEMORY_MUTATIONS_PER_TURN} memory changes.`,
            error: "memory_mutation_limit_reached",
          };
        }

        let taskGraphUpdate: TaskGraph | undefined;
        if (result.ok && result.taskGraphUpdate) {
          try {
            if (toolName === "manage_tasks" && taskGraphOperation) {
              taskGraphUpdate = validateTaskGraphTransition(
                state.taskGraph,
                taskGraphOperation,
                result.taskGraphUpdate,
                turnId,
              );
            } else if (toolName === "manage_subagents" && result.subagentTaskOperation) {
              subagentTaskOperation = subagentTaskOperationSchema.parse(
                result.subagentTaskOperation,
              );
              taskGraphUpdate = validateSubagentTaskTransition(
                state.taskGraph,
                subagentTaskOperation,
                result.taskGraphUpdate,
                turnId,
              );
            } else {
              throw new Error(
                "Only an authorized manage_tasks or manage_subagents call may update the task DAG",
              );
            }
          } catch (error) {
            result = {
              ok: false,
              summary: "Runtime rejected an invalid task DAG transition.",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        } else if (result.ok && taskGraphOperation) {
          result = {
            ok: false,
            summary: "Runtime rejected a missing task DAG transition.",
            error: "manage_tasks did not return an authoritative task DAG update",
          };
        }

        if (result.ok && result.subagentLifecycle) {
          const lifecycle = result.subagentLifecycle;
          const requiresBinding =
            lifecycle.action === "activate" || lifecycle.action === "observe";
          const assignment = result.subagentAssignment;
          let lifecycleError: string | undefined;
          if (toolName !== "manage_subagents") {
            lifecycleError = "Only manage_subagents may change child lifecycle state";
          } else if (requiresBinding) {
            if (
              !isSubagentAssignmentSnapshot(assignment) ||
              assignment.agentId !== lifecycle.agentId
            ) {
              lifecycleError = "The child lifecycle transition is missing its exact Runtime binding";
            } else if (assignment.kind === "dag") {
              if (
                !taskGraphUpdate ||
                !subagentTaskOperation ||
                assignment.taskGraphId !== taskGraphUpdate.id ||
                assignment.taskId !== subagentTaskOperation.taskId ||
                assignment.agentId !== subagentTaskOperation.agentId ||
                (lifecycle.action === "activate" &&
                  subagentTaskOperation.action !== "claim") ||
                (lifecycle.action === "observe" &&
                  subagentTaskOperation.action === "claim")
              ) {
                lifecycleError =
                  "A DAG child lifecycle transition requires its matching authoritative task-DAG transition";
              }
            } else if (taskGraphUpdate || subagentTaskOperation) {
              lifecycleError =
                "A standalone child lifecycle transition must not update the task DAG";
            }
          } else if (taskGraphUpdate || subagentTaskOperation || assignment) {
            lifecycleError =
              "Follow-up and stop lifecycle transitions must not alter the child binding or task DAG";
          }
          if (lifecycleError) {
            result = {
              ok: false,
              summary: "Runtime rejected an invalid subagent lifecycle transition.",
              error: lifecycleError,
            };
          }
        } else if (result.ok && result.subagentAssignment) {
          result = {
            ok: false,
            summary: "Runtime rejected an unpaired child assignment.",
            error: "A child assignment requires an activate or observe lifecycle transition",
          };
        }

        if (result.ok && result.subagentTaskReport) {
          const report = result.subagentTaskReport;
          if (
            toolName !== "submit_task_result" ||
            agentIdentity.role !== "subagent" ||
            report.taskId !== agentIdentity.assignedTaskId
          ) {
            result = {
              ok: false,
              summary: "Runtime rejected an unauthorized child task result.",
              error: "invalid_subagent_task_result",
            };
          } else {
            submittedTaskReport = report;
          }
        } else if (result.ok && toolName === "submit_task_result") {
          result = {
            ok: false,
            summary: "Runtime rejected a missing child task result.",
            error: "submit_task_result did not return a structured result",
          };
        }

        let planReviewUpdate: SessionState["planReview"] | undefined;
        if (result.ok && result.planProposal) {
          try {
            if (toolName !== "propose_plan" || effectiveMode !== "plan") {
              throw new Error("Only propose_plan may submit a proposal in Plan mode");
            }
            if ((this.dependencies.getOutstandingSubagents?.() ?? []).length > 0) {
              throw new Error(
                "Outstanding child assignments must be collected before proposing a plan",
              );
            }
            planReviewUpdate = createPlanReviewState(
              result.planProposal,
              turnId,
              state.planReview,
            );
          } catch (error) {
            result = {
              ok: false,
              summary: "Runtime rejected an invalid plan proposal.",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        } else if (result.ok && toolName === "propose_plan") {
          result = {
            ok: false,
            summary: "Runtime rejected a missing plan proposal.",
            error: "propose_plan did not return a structured proposal",
          };
        }
        if (!result.ok && toolName === "submit_task_result") {
          submittedTaskReport = undefined;
        }

        if (result.ok && result.memoryMutation && this.dependencies.validateMemorySources) {
          try {
            this.dependencies.validateMemorySources(state, turnId, memoryContext.userInput, result.memoryMutation);
          } catch (error) {
            result = { ok: false, summary: "Memory source validation failed; nothing was staged.",
              failure: protocolToolFailure("memory_source_invalid", error instanceof Error ? error.message : String(error)) };
          }
        }
        result = normalizeToolFailure(result);
        if (result.ok) toolRecovery.succeed(toolName);
        // Ordinary tools share field-level repair guidance; mutations are never auto-replayed.
        // Once accepted, context maintenance owns its own durable correction budget.
        // Invalid public compact_context parameters still need bounded preflight correction.
        if (result.failure?.recovery === "correct_arguments") {
          const recovery = toolRecovery.fail(toolName);
          result = { ...result, failure: { ...result.failure,
            instruction: `${result.failure.instruction} Correction attempts remaining: ${recovery.remaining}.`,
            ...(recovery.remaining === 0 ? { recovery: "none" as const } : {}),
          } };
          if (recovery.remaining === 0) requiredProtocolExhaustion = { tool: toolName, attempt: recovery.attempt };
        }

        if (this.dependencies.captureToolEvidence && toolName !== "compact_context" && toolName !== "manage_memory") {
          try {
            result = { ...result, evidenceId: this.dependencies.captureToolEvidence(state, call.id, toolName, result) };
          } catch {
            this.dependencies.onStatus?.("Full tool evidence was not archived; the bounded journal result remains available.");
          }
        }
        let projectionIntent: string | undefined;
        if (toolName === "run_command" || toolName === "start_command") {
          try { projectionIntent = JSON.parse(call.function.arguments).intent; } catch { /* invalid arguments were not executed */ }
        }
        const projected = projectToolResult(result, this.dependencies.limits,
          { intent: projectionIntent, previousMessages: projectionHistory });
        const projectionLimits = this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS;
        const readData = result.data as { path?: unknown; content?: unknown; contentHash?: unknown; startLine?: unknown; endLine?: unknown } | undefined;
        const versionedRead = result.ok && toolName === "read_file" && readData &&
          typeof readData.path === "string" && typeof readData.content === "string" &&
          typeof readData.contentHash === "string" && /^[a-f0-9]{64}$/u.test(readData.contentHash) &&
          Number.isSafeInteger(readData.startLine) && Number.isSafeInteger(readData.endLine);
        const resultChars = versionedRead ? projectionLimits.maxReadResultTokens * 8 + 4096
          : toolName === "search_files" ? projectionLimits.searchMaxResultTokens * 8 + 4096
          : this.dependencies.limits?.maxToolResultChars ?? options.maxOutputChars;
        const toolMessage: ChatMessage = {
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: resultForModel(projected, resultChars)
        };
        const toolResultEventId = createId("event");
        const verification = commandVerificationClassification(
          toolName,
          call.function.arguments,
          progressExperimentAtCall !== undefined,
          progressVerificationCommands,
          result,
        );
        const progressCommandData = result.data && typeof result.data === "object"
          ? result.data as Record<string, unknown>
          : undefined;
        if (
          verification.intent &&
          (toolName === "run_command" || toolName === "start_command") &&
          typeof progressCommandData?.commandId === "string"
        ) {
          progressVerificationCommands.set(
            progressCommandData.commandId,
            verification.kind ?? "custom",
          );
        }
        const progressObservation = observeToolResult({
          sourceEventId: toolResultEventId,
          sourceCallId: call.id,
          scopeKey: taskIdAtCall
            ? `thread:${state.threadId}/task:${taskIdAtCall}`
            : progressScopeKey(state, turnId),
          responseOrdinal: progressResponseOrdinal(progressResponseBase, step),
          tool: call.function.name,
          result,
          verificationIntent: verification.intent,
          investigationPolicy: {
            minimum: projectionLimits.progressInvestigationMinSamples, ratio: projectionLimits.progressInvestigationRepeatRatio,
            window: projectionLimits.progressInvestigationWindowResponses, review: projectionLimits.progressInvestigationReviewEnabled,
          },
          ...(progressExperimentAtCall?.reviewReport && ["run_command", "start_command"].includes(toolName) &&
            matchesReviewExperiment(progressExperimentAtCall.reviewReport, call.function.arguments, state.workspaceRoot)
            ? { experimentIncidentId: progressExperimentAtCall.incidentId } : {}),
          ...(verification.kind ? { verificationKind: verification.kind } : {}),
        });
        const rollbackPreparedSubagent = (): void => {
          if (!preparedSubagentLifecycle || preparedSubagentLifecycleRolledBack) return;
          preparedSubagentLifecycleRolledBack = true;
          try {
            this.dependencies.onSubagentLifecycleRollback?.(preparedSubagentLifecycle);
          } catch {
            // A local reservation cleanup hook must not replace the durable tool result/error.
          }
        };
        if (!result.ok) rollbackPreparedSubagent();
        const contextCommand = pendingCommandObservation(toolName, result, taskIdAtCall);
        const contextReconciliation = reconciliationObservation(state, toolName, result);
        try {
          await this.dependencies.appendEvent({
            eventId: toolResultEventId,
            threadId: state.threadId,
            turnId,
            stepId: `step_${step}`,
            type: "tool.result",
            phase: result.ok ? "completed" : "failed",
            payload: {
              callId: call.id,
              tool: call.function.name,
              ...(toolGateway.catalog.bindings.get(call.function.name)
                ? { toolBinding: toolGateway.catalog.bindings.get(call.function.name) }
                : {}),
              message: toolMessage,
              progressObservation,
              ...(contextCommand ? { contextCommand } : {}),
              ...(contextReconciliation ? { contextReconciliation } : {}),
              outputProjection: { capturedResultChars: JSON.stringify(result.data ?? null).length,
                modelResultChars: toolMessage.content.length },
              ...(result.failure ? { failure: result.failure } : {}),
              ...(taskIdAtCall ? { taskId: taskIdAtCall } : {}),
              ...(taskGraphUpdate && taskGraphOperation
                ? { taskGraph: taskGraphUpdate, taskGraphOperation }
                : {}),
              ...(taskGraphUpdate && subagentTaskOperation
                ? { taskGraph: taskGraphUpdate, subagentTaskOperation }
                : {}),
              ...(result.ok && result.subagentLifecycle
                ? { subagentLifecycle: result.subagentLifecycle }
                : {}),
              ...(result.ok && result.subagentAssignment
                ? { subagentAssignment: result.subagentAssignment }
                : {}),
              ...(planReviewUpdate ? { planReview: planReviewUpdate } : {}),
            }
          });
        } catch (error) {
          rollbackPreparedSubagent();
          throw error;
        }
        projectionHistory.push(toolMessage);
        const progressFold = foldProgressObservation(
          state.progressGuard ?? createProgressGuardState(),
          progressObservation,
        );
        state.progressGuard = progressFold.state;
        foldPendingOperations(state, { tool: toolName, contextCommand, contextReconciliation,
          ...(result.ok ? { subagentLifecycle: result.subagentLifecycle, subagentAssignment: result.subagentAssignment } : {}) });
        completedVerificationPhase ||= progressFold.accepted && progressObservation.kind === "verification_terminal";
        state.messages.push(toolMessage);
        if (taskGraphUpdate) {
          state.taskGraph = taskGraphUpdate;
          state.updatedAt = new Date().toISOString();
        }
        if (planReviewUpdate) {
          state.planReview = planReviewUpdate;
          proposedPlan = planReviewUpdate.proposal;
          state.updatedAt = new Date().toISOString();
        }
        if (result.ok && result.imageAttachments?.length) {
          stepImageAttachments.push(...result.imageAttachments);
        }
        if (toolName === "manage_memory" && result.ok && result.memoryMutation) {
          memoryContext.mutations.push(result.memoryMutation);
        }
        await this.dependencies.onToolCompleted?.(state, call.function.name, result);
        if (agentIdentity.role === "main_agent" && this.dependencies.runReviewSession && state.changes.length > turnChangeStart &&
            (!state.delivery || state.reviewSessions?.some(s => s.scope === state.delivery!.id && s.approval && s.status === "applied"))) {
          const obligation = newDelivery(state, memoryContext.userInput, turnHistoryStart, turnChangeStart);
          await this.dependencies.appendEvent({ threadId: state.threadId, turnId, type: "delivery.required", payload: obligation });
          foldDelivery(state, obligation);
        }
      }

      if (completedVerificationPhase) await this.closeContextPhase(state, turnId);
      else if (investigationExchangeStart(state.messages) !== undefined)
        await this.closeContextPhase(state, turnId, "investigation");
      if (!steeringAppliedBetweenTools && agentIdentity.role === "main_agent") {
        steeringAppliedBetweenTools = Boolean(await this.takeAndApplySteering(
          state,
          turnId,
          "between_tools",
          turnImages,
          false,
          memoryContext,
        ));
      }
      if (steeringAppliedBetweenTools) {
        continue;
      }

      if (requiredProtocolExhaustion) {
        throw new ToolProtocolExhausted(requiredProtocolExhaustion.tool, requiredProtocolExhaustion.attempt, step);
      }
      if (finishRejectedReason) return this.finish(state, turnId, finishRejectedReason, "failed", step, memoryContext);
      if (submittedTaskReport) {
        const text = submittedTaskReport.summary;
        this.dependencies.onText?.(text);
        return this.finish(
          state,
          turnId,
          text,
          submittedTaskReport.outcome === "completed" ? "success" : "blocked",
          step,
          memoryContext,
          undefined,
          submittedTaskReport,
        );
      }

      if (proposedPlan) {
        if (await this.takeAndApplySteering(
          state,
          turnId,
          "before_final",
          turnImages,
          true,
          memoryContext,
        )) {
          continue;
        }
        const text =
          `${formatPlanProposal(proposedPlan)}\n\n` +
          runtimePromptText("runtime/plan-waiting-review.md");
        this.dependencies.onText?.(text);
        const prefix = state.mode === "auto" && autoReason
          ? `Auto decision: ${autoReason}\n\n`
          : "";
        return this.finish(
          state,
          turnId,
          `${prefix}${text}`,
          "planned",
          step,
          memoryContext,
          proposedPlan,
        );
      }

      if (stepImageAttachments.length) {
        const labels = stepImageAttachments.map((image) => image.label).join(", ");
        const imageMessage: Extract<ChatMessage, { role: "user" }> = {
          role: "user",
          content: renderRuntimePrompt("runtime/read-image-follow-up.md", {
            labels,
          }),
          images: stepImageAttachments,
        };
        state.messages.push(imageMessage);
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `step_${step}`,
          type: "message.user.synthetic",
          phase: "completed",
          payload: imageMessage,
        });
        await this.dependencies.commitImages?.(state.threadId, stepImageAttachments);
      }
      if (
        state.taskGraph &&
        (state.taskGraph.status === "completed" || state.taskGraph.status === "blocked") &&
        state.taskGraph.updatedByTurnId === turnId && step === stepLimit
      ) {
        taskDagFinalizationOnly = true;
      }
    }

    return this.finish(
      state,
      turnId,
      `Reached the hard limit of ${options.maxSteps} model requests before the task could be confirmed complete.`,
      "limit_reached",
      options.maxSteps - this.remainingRequests,
      memoryContext,
    );
    } catch (error) {
      const interrupted = Boolean(options.signal?.aborted);
      const message = error instanceof Error ? error.message : String(error);
      const protocolFailure = !interrupted && error instanceof ToolProtocolExhausted ? error : undefined;
      const controlFailure = protocolFailure?.failure ?? (!interrupted ? contextCapacityFailure(error, state) : undefined);
      const capacityExhausted = !interrupted && isContextCapacityError(error);
      const result: AgentRunResult = {
        text: interrupted ? "The task was interrupted by the user." : capacityExhausted
          ? "Context paused: the required request exceeds the model capacity. History and pending work are preserved; reduce required input or use a supported larger window before resuming."
          : `Agent run failed: ${message}`,
        reason: interrupted ? "interrupted" : capacityExhausted || error instanceof TaskBudgetExceeded ? "limit_reached" : "failed",
        steps: error instanceof TaskBudgetExceeded ? options.maxSteps - this.remainingRequests : protocolFailure?.steps ?? 0,
        threadId: state.threadId,
        turnId,
        ...(controlFailure ? { failure: controlFailure } : {}),
      };
      if (state.activeTurnId === turnId) {
        try {
          return await this.finish(
            state,
            turnId,
            result.text,
            result.reason,
            result.steps,
            memoryContext,
            undefined,
            undefined,
            result.failure,
          );
        } catch {
          state.activeTurnId = undefined;
          state.updatedAt = new Date().toISOString();
        }
      }
      return result;
    }
  }

  private async closeContextPhase(state: SessionState, turnId: string, kind: "verification" | "turn" | "investigation" = "verification"): Promise<void> {
    if (!state.messages.length || !completeExchange(state.messages)) return;
    if (kind === "turn" && state.compactionControl?.lastVerificationTurnId === turnId) return;
    const payload = { end: state.messages.length, kind, turnId };
    await this.dependencies.appendEvent({ threadId: state.threadId, turnId, type: "context.phase.closed", phase: "completed", payload });
    foldCompactionControl(state, "context.phase.closed", payload);
  }

  private async maintainContext(state: SessionState, turnId: string, images: ImageAttachment[],
    memoryContext: { userInput: string }, options: AgentRunOptions, nextRequest: NormalRequestEnvelope,
    required: boolean, maxRequests: number, forceRecovery = false): Promise<CompactionResult> {
    const compactTool = this.dependencies.toolCatalog.tools
      .find((tool) => tool.name === "compact_context");
    const result = await runCompactionTransaction({ state, manager: this.dependencies.contextManager, turnId,
      limits: this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS, signal: options.signal,
      skipSummary: forceRecovery, forceRecovery,
      retainRecentExchanges: (this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).compactionRetainRecentExchanges,
      maxContextChars: options.maxContextChars, required, maxRequests, nextRequest,
      tool: compactTool?.definition,
      append: (event) => this.dependencies.appendEvent(event),
      complete: async (messages, attempt, tools) => {
        if (!compactTool) return undefined;
        const inspection = this.dependencies.contextManager.inspectProviderRequest({ state,
          maxContextChars: options.maxContextChars, messages, tools });
        this.observeProviderContext({ state, turnId, purpose: "context_compaction", attempt, messages,
          tools, enforcedPressure: required ? "require" : "suggest",
          enforcedUtilization: inspection.utilization, maxContextChars: options.maxContextChars, actualRequest: inspection });
        this.dependencies.onStatus?.("Context maintenance: complete response, local summary projection; length overflow needs no model retry.");
        const attempted = await this.runProviderAttempt(options.signal, (signal) => this.withModelRequestActivity(
          "Summarizing older exchanges", () => this.dependencies.provider.complete({ messages,
            tools, signal, thinkingEffort: "none",
            currentTurnImageIds: images.map((image) => image.id) })));
        if (attempted.kind === "steering_interrupted") {
          return undefined;
        }
        await this.reportModelUsage(state, turnId, "context_compaction", attempted.value.usage, { attempt, retry: attempt > 1 });
        await this.dependencies.appendEvent({ threadId: state.threadId, turnId,
          type: "context.summary.response", payload: { finishReason: attempted.value.finishReason ?? null,
            usage: attempted.value.usage, contentChars: attempted.value.message.content?.length ?? 0,
            thinkingChars: attempted.value.message.reasoning_content?.length ?? 0,
            toolCalls: attempted.value.message.tool_calls?.length ?? 0 } });
        return { ...attempted.value.message,
          tool_calls: attempted.value.message.tool_calls?.map(durableToolCall) };
      },
      afterComplete: async () => {
        await this.takeAndApplySteering(state, turnId, "after_model", images, false, memoryContext);
      },
    });
    if (result.committed) this.dependencies.onStatus?.(
      state.workingSummary.includes('"mode":"minimal_rebase"')
        ? "Context recovery: a complete exchange (including thinking) was archived. Continuing the same task from pinned state and Journal references; budgets and pending operations are unchanged."
        : "Context maintenance completed: bounded history and tool references retained; raw Journal remains available.");
    return result;
  }

  private async withModelRequestActivity<T>(
    text: string,
    request: () => Promise<T>,
  ): Promise<T> {
    let activityToken: unknown;
    let activityStarted = false;
    try {
      if (this.dependencies.onModelRequestStart) {
        activityToken = this.dependencies.onModelRequestStart(text);
        activityStarted = true;
      }
    } catch {
      // Transient terminal presentation must never prevent an API request.
    }
    try {
      return await request();
    } finally {
      try {
        if (activityStarted) {
          this.dependencies.onModelRequestEnd?.(activityToken);
        }
      } catch {
        // A broken presentation hook must not replace a model result or error.
      }
    }
  }

  private async withToolExecutionActivity<T>(
    toolName: string,
    request: () => Promise<T>,
  ): Promise<T> {
    let activityToken: unknown;
    let activityStarted = false;
    try {
      if (this.dependencies.onToolExecutionStart) {
        activityToken = this.dependencies.onToolExecutionStart(
          toolName,
          `Running Tool: ${toolName}`,
        );
        activityStarted = true;
      }
    } catch {
      // Tool execution remains authoritative if presentation fails.
    }
    try {
      return await request();
    } finally {
      try {
        if (activityStarted) {
          this.dependencies.onToolExecutionEnd?.(toolName, activityToken);
        }
      } catch {
        // A broken presentation hook must not replace a tool result or error.
      }
    }
  }

  private async reportModelUsage(
    state: Readonly<SessionState>,
    turnId: string,
    purpose: ModelUsagePurpose,
    usage: ModelUsageRecord["usage"],
    request: { step?: number; attempt?: number; retry: boolean },
  ): Promise<void> {
    if (!this.dependencies.onModelUsage) return;
    const identity = this.dependencies.agentIdentity ?? { role: "main_agent" as const };
    const record: ModelUsageRecord = {
      actor: identity.role,
      purpose,
      provider: this.dependencies.provider.name,
      model: this.dependencies.provider.model,
      turnId,
      retry: request.retry,
      ...(request.step !== undefined ? { step: request.step } : {}),
      ...(request.attempt !== undefined ? { attempt: request.attempt } : {}),
      ...(usage ? { usage: { ...usage } } : {}),
      ...(identity.role === "subagent"
        ? {
            sourceAgentId: identity.agentId,
            sourceTaskId: identity.assignedTaskId,
          }
        : {}),
    };
    try {
      await this.dependencies.onModelUsage(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.onStatus?.(
        `Model usage accounting could not be saved: ${message}`,
      );
    }
  }

  private async reportAutoRouteUsage(
    state: Readonly<SessionState>,
    turnId: string,
    attempts: readonly AutoRouteAttempt[],
  ): Promise<void> {
    for (const attempt of attempts) {
      await this.reportModelUsage(
        state,
        turnId,
        "auto_route",
        attempt.usage,
        {
          attempt: attempt.attempt,
          retry: attempt.attempt > 1,
        },
      );
    }
  }

  private async finish(
    state: SessionState,
    turnId: string,
    text: string,
    reason: AgentRunResult["reason"],
    steps: number,
    memoryContext: {
      userInput: string;
      mutations: readonly MemoryMutationRequest[];
      approvedPlanReview?: Readonly<PlanReviewState>;
    },
    planProposal?: PlanProposal,
    subagentTaskReport?: SubagentTaskReport,
    failure?: AgentRunResult["failure"],
  ): Promise<AgentRunResult> {
    // A last-line seal for every completion path, not only the normal text branch.
    if (reason === "success" && this.dependencies.runReviewSession &&
        (this.dependencies.agentIdentity?.role ?? "main_agent") === "main_agent" && pendingDelivery(state)) {
      reason = "blocked";
      text += "\nDelivery remains unverified; the persistent review obligation is not completed.";
    }
    const returnOutcome: PlanExecutionReturnOutcome | undefined =
      reason === "failed" || reason === "interrupted" || reason === "limit_reached"
        ? reason
        : undefined;
    if (
      returnOutcome &&
      memoryContext.approvedPlanReview &&
      !state.planReview &&
      state.taskGraph?.createdByTurnId !== turnId
    ) {
      const restoredPlanReview = returnPlanExecutionToReview(
        memoryContext.approvedPlanReview,
        returnOutcome,
      );
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "plan.execution_returned_to_review",
        phase: "completed",
        payload: {
          planId: restoredPlanReview.proposal.id,
          revision: restoredPlanReview.proposal.revision,
          outcome: returnOutcome,
          planReview: restoredPlanReview,
        },
      });
      state.planReview = restoredPlanReview;
      memoryContext.approvedPlanReview = undefined;
    }
    state.activeTurnId = undefined;
    state.updatedAt = new Date().toISOString();
    const lastMessage = state.messages[state.messages.length - 1];
    const result: AgentRunResult = {
      text,
      reason,
      steps,
      threadId: state.threadId,
      turnId,
      ...(planProposal ? { planProposal } : {}),
      ...(subagentTaskReport ? { subagentTaskReport } : {}),
      ...(failure ? { failure } : {}),
    };
    if (completeExchange(state.messages) && (
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      Boolean(lastMessage.tool_calls?.length) ||
      !lastMessage.content?.trim()
    )) {
      const syntheticMessage: ChatMessage = { role: "assistant", content: text };
      state.messages.push(syntheticMessage);
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "message.assistant",
        phase: "completed",
        payload: syntheticMessage
      });
    }
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "turn.completed",
      phase: "completed",
      payload: {
        reason,
        steps,
        ...(failure ? { failure } : {}),
        ...(planProposal
          ? { planId: planProposal.id, revision: planProposal.revision }
          : {}),
      }
    });

    if (
      memoryContext.mutations.length > 0 &&
      this.dependencies.commitMemoryMutations &&
      (reason === "success" || reason === "planned")
    ) {
      try {
        const committed = await this.dependencies.commitMemoryMutations({
          sourceState: state,
          workspaceRoot: state.workspaceRoot,
          threadId: state.threadId,
          turnId,
          outcome: reason,
          userInput: memoryContext.userInput,
          mutations: memoryContext.mutations,
        });
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          type: "memory.committed",
          phase: "completed",
          payload: committed,
        }).catch(() => undefined);
        this.dependencies.onStatus?.(
          `Committed ${committed.applied} long-term memory change(s).`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          type: "memory.commit_failed",
          phase: "failed",
          payload: { message },
        }).catch(() => undefined);
        this.dependencies.onStatus?.(`Long-term memory maintenance was not saved: ${message}`);
      }
    } else if (memoryContext.mutations.length > 0) {
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "memory.discarded",
        phase: "completed",
        payload: { count: memoryContext.mutations.length, reason },
      }).catch(() => undefined);
    }
    if (reason === "success" || reason === "planned") await this.closeContextPhase(state, turnId, "turn");
    if (this.dependencies.checkpointContext) {
      try {
        await this.dependencies.checkpointContext(state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.dependencies.onStatus?.(
          `Incremental context checkpoint was not updated (${message}); the Thread journal remains authoritative.`,
        );
      }
    }
    return result;
  }
}
