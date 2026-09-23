import { CommandEnvironmentQuarantined } from "../sandbox/environment-fault.js";
import { safeToolDisplayDetails, toolDisplayDetails } from "./tool-display-details.js";
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
  type ProviderStreamEvent,
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
import { budgetedRequest, requestTokens, responseTokenReserve } from "../context/token-budget.js";
import type { TokenCalibration } from "../context/token-calibration.js";
import { runCompactionTransaction, foldCompactionControl, completeExchange, investigationExchangeStart, type CompactionResult } from "../context/compaction-transaction.js";
import type { NormalRequestEnvelope } from "../context/context-request.js";
import { foldPendingOperations, pendingCommandObservation } from "../context/pending-operations.js";
import { parseSemanticRequestPatch } from "../context/semantic-compaction.js";
import { recallThreadContext } from "../context/recall.js";
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
  planDraftFromText,
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
  validateTaskGraphTransition,
  subagentTaskOperationSchema,
  validateSubagentTaskTransition,
  type SubagentTaskOperation,
  type TaskGraphTransitionOperation,
} from "../tasks/task-graph.js";
import { createId } from "../utils/ids.js";
import { sha256 } from "../utils/hash.js";
import { safeJsonParse } from "../utils/json.js";
import {
  createProgressGuardState,
  foldProgressHint,
  foldProgressObservation,
} from "../progress/guard.js";
import { observeToolResult } from "../progress/observation.js";
import {
  AutoRouteRequestError,
  AutoRouteSelectionError,
  determineAutoRoute,
  projectAutoRouteContext,
  type AutoRouteContext,
  type AutoRouteAttempt,
} from "./auto-router.js";
import { autoRouteCapabilitySummary } from "./auto-route-capabilities.js";
import { createProviderAttemptSignal } from "./provider-attempt-signal.js";
import type { TurnSteeringAttemptNotifier } from "./turn-steering-notifier.js";
import { toolFailure } from "../tools/base.js";
import {
  normalizeToolFailure, prepareToolInput, protocolToolFailure, toolResultForModel,
} from "../tools/errors.js";
import {
  ToolRecoveryBudget, ToolProtocolExhausted,
} from "./tool-recovery.js";
import { availableAgentTools } from "../tools/capabilities.js";
import { snapshotToolSet, type ToolCatalogSnapshot } from "../tools/catalog.js";
import { toolApprovalIdentity } from "../tools/approval.js";
import {
  ToolExecutionGateway,
  type ToolExecutionAuthorizer,
} from "../tools/execution-gateway.js";
import {
  evaluateCompletionGate,
  foldCompletionControl,
  nextCompletionAttempt,
  renderCompletionCorrection,
} from "./completion-gate.js";

function runtimePromptText(path: string): string {
  return loadPromptBundleCatalog().readText(path).trimEnd();
}

function renderRuntimePrompt(
  path: string,
  values: Readonly<Record<string, string | number | boolean>>,
): string {
  return loadPromptBundleCatalog().render(path, values).trimEnd();
}

function contextCapacityFailure(error: unknown, state: Readonly<SessionState>): AgentRunResult["failure"] {
  if (error instanceof CommandEnvironmentQuarantined) return { code: error.code, tool: "runtime", attempts: 0, recoverable: true };
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
    blockedTask?.blockerDetails
      ? `blockedTask=${blockedTask.id}\n${blockedTask.blockerDetails.reason}`
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
        `${task.completionChecks.join("\n")}\n${task.blockerDetails?.reason ?? ""}`
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

function progressRuntimeInstruction(
  state: Readonly<SessionState>,
  scopeKey: string,
): string {
  const guard = state.progressGuard;
  if (!guard) return "";
  if (guard.searchWarning?.scopeKey === scopeKey && !guard.presentedWeakHintScopes?.includes(`search:${scopeKey}`)) {
    return renderRuntimePrompt("runtime/progress-search-warning.md", {
      count: guard.searchWarning.count,
    });
  }
  if (guard.readWarning?.scopeKey === scopeKey && !guard.presentedWeakHintScopes?.includes(`read:${scopeKey}`)) {
    return renderRuntimePrompt("runtime/progress-read-warning.md", {
      warningId: guard.readWarning.id,
      totalReads: guard.readWarning.totalReads,
      repeatedReads: guard.readWarning.repeatedReads,
      repeatedPercent: Math.floor(guard.readWarning.repeatedRatio * 100),
    });
  }
  return "";
}

function progressWeakHintKind(state: Readonly<SessionState>, scopeKey: string): "read" | "search" | undefined {
  const guard = state.progressGuard;
  const shown = guard.presentedWeakHintScopes ?? [];
  if (guard.searchWarning?.scopeKey === scopeKey && !shown.includes(`search:${scopeKey}`)) return "search";
  if (guard.readWarning?.scopeKey === scopeKey && !shown.includes(`read:${scopeKey}`)) return "read";
  return undefined;
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
      return kind ? { intent: true, kind } : { intent: false };
    } catch {
      return { intent: false };
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
  /** Read-only health projection; mutations remain gated by the tool layer. */
  getEnvironmentFault?: () => string | undefined;
  limits?: Readonly<import("../config/runtime-limits.js").RuntimeLimits>;
  taskBudget?: import("./task-budget.js").TaskBudget;
  tokenCalibration?: TokenCalibration;
  provider: ModelProvider;
  /** Immutable, source-aware tool set captured once for this Runtime run. */
  toolCatalog: Readonly<ToolCatalogSnapshot>;
  /** Live MCP connections captured with the tool catalog, never inferred from conversation history. */
  connectedMcpServers?: readonly Readonly<{ id: string; toolCount: number }>[];
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
  searchMemories: (
    query: string,
    options?: { readonly limit?: number; readonly includeInactive?: boolean;
      readonly scope?: "all" | "global" | "project" },
  ) => Promise<ReadonlyArray<Readonly<LongTermMemory>>>;
  memoryGeneration?: () => string;
  recordMemoryRecall?: (threadId: string, turnId: string, memoryIds: readonly string[]) => void;
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
  commitMemoryMutations?: (input: {
    workspaceRoot: string;
    threadId: string;
    turnId: string;
    outcome: "success" | "planned";
    mutations: readonly MemoryMutationRequest[];
  }) => Promise<{ applied: number; memoryIds: string[] }>;
  appendEvent: (
    event: Omit<EventRecord, "schemaVersion" | "eventId" | "sequence" | "timestamp"> & {
      eventId?: string;
    },
  ) => Promise<void>;
  runReviewSession?: (input: import("../review/application.js").WorkspaceReviewRequest) =>
    Promise<import("../review/application.js").WorkspaceReviewResult>;
  requestApproval: ApprovalHandler;
  /** Optional conversation metadata service; never controls task execution. */
  threadTitle?: {
    isUnclaimed(threadId: string): boolean;
    claim(threadId: string, title: string): boolean;
  };
  onThreadTitleClaimed?: (title: string) => void;
  recordCommand?: (turnId: string, entry: CommandAuditEntry) => void;
  onToolCompleted?: (
    state: SessionState,
    toolName: string,
    result: ToolExecutionResult,
    displayName?: string,
    details?: readonly import("../core/types.js").ToolDisplayDetail[],
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
  /** Runtime-owned collection of terminal child results; never fabricates a model tool call. */
  collectReadySubagents?: (state: SessionState, turnId: string, signal?: AbortSignal) => Promise<number>;
  /** True until this actor has observed every supervised command's terminal result. */
  hasOpenCommandHandles?: () => boolean;
  onText?: (text: string) => void;
  onStatus?: (text: string) => void;
  /** Presentation hook after an Auto route has durably become the Thread mode. */
  onModeSelected?: (mode: "plan" | "code") => void;
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
  /** Transient provider deltas; the assembled assistant message remains authoritative. */
  onModelStream?: (event: Readonly<ProviderStreamEvent>) => void;
  /** Child-only FIFO parent guidance, drained at a model-step boundary. */
  takeAdditionalInstructions?: () => readonly string[];
  /** Main-agent journal-backed child reports, committed before they enter model context. */
  takeSubagentMessages?: (threadId: string, turnId: string) => Promise<readonly ChatMessage[]>;
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
  /** Optional per-actor model-request ceiling. Interactive hosts leave this unset. */
  maxModelRequests?: number;
  /** @deprecated Test/library compatibility alias; hosts should use maxModelRequests. */
  maxSteps?: number;
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

function threadTitleUnclaimed(dependencies: AgentRuntimeDependencies, threadId: string): boolean {
  try { return dependencies.threadTitle?.isUnclaimed(threadId) ?? false; }
  catch { return false; } // Naming metadata must not block the user's request.
}

function resultForModel(result: ToolExecutionResult, maximumChars: number): string {
  return toolResultForModel(result, maximumChars);
}

type AssistantToolCall = NonNullable<
  Extract<ChatMessage, { role: "assistant" }>["tool_calls"]
>[number];

/** Keep a provider from repeating one-shot conversation metadata work in one response. */
function deduplicateThreadTitleCalls(
  calls: readonly AssistantToolCall[] | undefined,
): AssistantToolCall[] | undefined {
  if (!calls) return undefined;
  let found = false;
  return calls.filter((call) => {
    if (call.function.name !== "name_thread") return true;
    if (found) return false;
    found = true;
    return true;
  });
}

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
  private requestLimit: number | undefined;
  private modelRequestsUsed = 0;
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
        if (this.requestLimit !== undefined && this.modelRequestsUsed >= this.requestLimit)
          throw new TaskBudgetExceeded("actor model-request limit reached");
        const limits = dependencies.limits ?? DEFAULT_RUNTIME_LIMITS;
        const capacity = dependencies.contextManager.tokenCapacity;
        const effortReserve = request.thinkingEffort === undefined
          ? capacity?.outputReserve ?? responseTokenReserve(limits, "none")
          : responseTokenReserve(limits, request.thinkingEffort, capacity?.window);
        const sent = budgetedRequest({ ...request,
          outputReserveTokens: request.outputReserveTokens ?? effortReserve }, capacity,
          dependencies.contextManager.estimateRequestTokens);
        this.modelRequestsUsed += 1; // Logical model request, not physical transport retries.
        let actualRequest = sent;
        const response = await completeWithApiRetries(provider, sent, {
          limits,
          reserve: value => { actualRequest = value; return dependencies.taskBudget?.reserve(value, dependencies.contextManager.estimateRequestTokens) ?? (() => undefined); },
          onSettled: async attempt => {
            if (this.retryContext) await dependencies.appendEvent({ threadId: this.retryContext.state.threadId,
              turnId: this.retryContext.turnId, type: "model.api_attempt", phase: attempt.outcome, payload: attempt });
            if (attempt.outcome === "failed" &&
                ["stream_header_timeout", "stream_semantic_idle_timeout"].includes(attempt.failure?.code ?? "")) {
              const progress = attempt.failure?.progress;
              const detail = progress
                ? ` (${progress.reasoningChars} thinking, ${progress.textChars} text, ${progress.toolArgumentChars} tool-argument chars received)`
                : "";
              const reason = attempt.failure?.code === "stream_header_timeout"
                ? "Model response headers did not arrive within the configured interval"
                : "Model stream made no semantic progress for the configured idle interval";
              dependencies.onStatus?.(attempt.failure?.recovery === "retry_api"
                ? `${reason}${detail}. Retrying API attempt ${attempt.attempt + 1}/${limits.maxProviderRetries + 1}.`
                : `${reason}${detail}. No API retries remain.`);
            }
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

  private async appendProgressHint(
    state: SessionState,
    turnId: string,
    payload: unknown,
  ): Promise<void> {
    await this.dependencies.appendEvent({
      threadId: state.threadId,
      turnId,
      type: "progress.hint.presented",
      phase: "completed",
      payload,
    });
    state.progressGuard = foldProgressHint(state.progressGuard, payload);
  }

  /** Run the single current review implementation; no legacy reviewer or experiment gate remains. */
  private async processProgressIntervention(input: {
    state: SessionState;
    turnId: string;
    userInput: string;
    remainingModelRequests?: number;
    signal?: AbortSignal;
  }): Promise<number> {
    const runReviewSession = this.dependencies.runReviewSession;
    if (!runReviewSession) return 0;
    const scopeKey = progressScopeKey(input.state, input.turnId);
    const pending = input.state.progressGuard.incidents.find(incident =>
      incident.scopeKey === scopeKey &&
      incident.phase === "review_pending");
    const unfinished = input.state.reviewSessions?.find(session =>
      session.status !== "applied");
    if (!pending && !unfinished) return 0;
    const result = await runReviewSession({
      ...input,
      maxContextTokens: this.dependencies.contextManager.tokenCapacity?.window,
      incidentId: pending?.incidentId ?? unfinished?.incidentId,
    });
    return result.requests;
  }

  private requestLimitReached(): boolean {
    return this.requestLimit !== undefined && this.modelRequestsUsed >= this.requestLimit;
  }

  private remainingRequestAllowance(): number | undefined {
    return this.requestLimit === undefined
      ? undefined
      : Math.max(0, this.requestLimit - this.modelRequestsUsed);
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
      batch.throughSequence <= state.steeringWatermark ||
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
    state.pendingSteering = state.pendingSteering
      .filter((entry) => entry.sequence > batch.throughSequence);
    state.steeringSequence = Math.max(
      state.steeringSequence,
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
    if (options.maxModelRequests !== undefined && options.maxSteps !== undefined &&
        options.maxModelRequests !== options.maxSteps)
      throw new RangeError("maxModelRequests and the legacy maxSteps alias must match");
    const configuredRequestLimit = options.maxModelRequests ?? options.maxSteps;
    if (configuredRequestLimit !== undefined &&
        (!Number.isSafeInteger(configuredRequestLimit) || configuredRequestLimit < 1))
      throw new RangeError("maxModelRequests must be a positive safe integer when provided");
    this.requestLimit = configuredRequestLimit;
    this.modelRequestsUsed = 0;
    this.dependencies.contextManager.configureTokenBudget(
      effectiveContextWindow(state.provider, state.model, options.maxContextTokens),
      this.dependencies.limits,
      state.thinkingEffort,
    );
    const userInput = typeof input === "string" ? input : input.text;
    const inputImages = typeof input === "string" ? [] : [...(input.images ?? [])];
    validateImageAttachmentCollection(inputImages);
    validateProviderImageAttachments(this.dependencies.provider.name, inputImages);
    const turnId = createId("turn");
    this.retryContext = { state, turnId };
    const turnImages = [...inputImages];
    this.dependencies.steeringNotifier?.consume(state.steeringWatermark);
    const agentIdentity = this.dependencies.agentIdentity ?? { role: "main_agent" as const };
    if (agentIdentity.role === "subagent" && state.mode !== "code" && state.mode !== "plan") {
      throw new Error("An isolated child runtime must remain in Plan or Code mode");
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
      const replacedTaskGraphId = state.taskGraph && state.taskGraph.status !== "completed"
        ? state.taskGraph.id
        : undefined;
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "plan.execution_started",
        phase: "completed",
        payload: {
          planId: review.proposal.id,
          revision: review.proposal.revision,
          ...(replacedTaskGraphId ? { replacedTaskGraphId } : {}),
        },
      });
      memoryContext.approvedPlanReview = clonePlanReviewState(review);
      state.planReview = undefined;
      if (replacedTaskGraphId) state.taskGraph = undefined;
      state.updatedAt = new Date().toISOString();
    }

    if (options.modeOverride && state.mode !== "auto") {
      throw new Error("A review mode override is valid only while the persistent mode is Auto");
    }
    const outstandingSubagentsAtRoute = agentIdentity.role === "main_agent"
      ? (this.dependencies.getOutstandingSubagents?.() ?? [])
      : [];
    if (outstandingSubagentsAtRoute.length > 0 && options.modeOverride === "plan")
      throw new Error("Outstanding child assignments must be collected before entering a Plan review override");
    let effectiveMode: AgentMode = options.modeOverride ?? state.mode;
    let autoReason = "";
    const commitAutoRoute = async (mode: "plan" | "code", reason: string): Promise<void> => {
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        type: "mode.auto_route",
        phase: "completed",
        payload: { mode, reason },
      });
      state.mode = mode;
      state.updatedAt = new Date().toISOString();
      effectiveMode = mode;
      autoReason = reason;
      try { this.dependencies.onModeSelected?.(mode); }
      catch { /* Presentation cannot undo a durable mode transition. */ }
    };
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
    } else if (state.mode === "auto") {
      const routingPressure = this.dependencies.contextManager.inspect(state, options.maxContextChars).utilization;
      if (
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
            options, nextRequest, false, this.remainingRequestAllowance());
          phaseCompactionRequestsUsed += compacted.requests;
          if (compacted.paused) return this.finish(state, turnId,
            `Context paused: ${compacted.paused.reason} Required ${compacted.paused.usage} / ${compacted.paused.capacity} ${compacted.paused.unit}. History and task state are preserved.`,
            "limit_reached", phaseCompactionRequestsUsed, memoryContext, undefined, undefined,
            { code: "context_capacity_exhausted", tool: "runtime", attempts: state.compactionControl?.transaction?.attempts ?? 0, recoverable: true });
          if (this.requestLimitReached()) return this.finish(state, turnId,
            "The shared model-request budget was exhausted during pre-route context compaction.",
            "limit_reached", this.modelRequestsUsed, memoryContext);
        }
      }
      const backgroundCommandHandleOpenAtRoute =
        this.dependencies.hasOpenCommandHandles?.() ?? false;
      const reconciliationPendingAtRoute = reconciliationPending(state);
      const fixedSelection = reconciliationPendingAtRoute
        ? {
            mode: "code" as const,
            reason: "Reconcile the reset context, workspace and original pending operations before finishing.",
          }
        : backgroundCommandHandleOpenAtRoute
        ? {
            mode: "code" as const,
            reason: backgroundCommandFinalizationInstruction(),
          }
        : outstandingSubagentsAtRoute.length > 0
          ? {
              mode: "code" as const,
              reason:
                "Collect every running or unobserved child assignment in code mode before planning or finishing.",
            }
          : undefined;
      if (fixedSelection) {
        await commitAutoRoute(fixedSelection.mode, fixedSelection.reason);
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
              threadNeedsTitle: threadTitleUnclaimed(this.dependencies, state.threadId),
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
              } catch {
                // Layered retrieval is an internal optimization; the current
                // durable context remains authoritative when it is unavailable.
              }
            }
            // Direct answers must inherit the same base security contract and
            // layered EASYCODE.md guidance as a normal agent request. Empty
            // workspace/memory inputs prevent this controller from answering
            // questions that require repository or retrieval facts.
            const planRouteTools = availableTools(
              this.dependencies.toolCatalog.tools,
              "plan",
              agentIdentity.role,
              state.thinkingEffort,
              this.orchestrationToolsAvailable(state, options),
              this.dependencies.visionAvailable ?? true,
            );
            const codeRouteTools = availableTools(
              this.dependencies.toolCatalog.tools,
              "code",
              agentIdentity.role,
              state.thinkingEffort,
              this.orchestrationToolsAvailable(state, options),
              this.dependencies.visionAvailable ?? true,
            );
            const routeCapabilities = autoRouteCapabilitySummary({
              planTools: planRouteTools,
              codeTools: codeRouteTools,
              connectedMcpServers: this.dependencies.connectedMcpServers?.length ?? 0,
            });
            const buildControllerPolicy = async (
              context: typeof routeLayeredContext,
            ): Promise<string> => {
              const allowance = optionalMemoryTokenBudget(options.maxContextChars, options.maxContextTokens, this.dependencies.limits);
              const selection = selectMemoryContext({ state, memories: [], evidence: context.evidence ?? [],
                tokenBudget: allowance, limits: this.dependencies.limits,
                presentText: [state.workingSummary] });
              const evidenceText = context.evidence ? renderRetrievedContext(selection.evidence)
                : requestTokens([{ role: "user", content: context.retrievedThreadEvidence ?? "" }]) <= allowance
                  ? context.retrievedThreadEvidence : undefined;
              const basePolicy = await this.dependencies.buildSystemPrompt({
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
              return `${basePolicy}\n\n${renderRuntimePrompt("controllers/live-capability-status.md", {
                planCapabilities: routeCapabilities.planCapabilities,
                codeCapabilities: routeCapabilities.codeCapabilities,
                currentConditions: routeCapabilities.currentConditions,
              })}`;
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
              } catch {
                // Fall back to the pinned checkpoint without surfacing an
                // implementation detail in the conversation.
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
          if (decision.threadTitle) {
            try {
              if (this.dependencies.threadTitle?.claim(state.threadId, decision.threadTitle)) {
                this.dependencies.onThreadTitleClaimed?.(decision.threadTitle);
              }
            }
            catch {
              // Automatic naming is best-effort and must not add noise to the
              // user's response when the title store is unavailable.
            }
          }
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
            const directAssistant: Extract<ChatMessage, { role: "assistant" }> = {
              role: "assistant",
              content: decision.content,
              phase: "final_answer",
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
          await commitAutoRoute(decision.mode, decision.reason);
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
    ).filter(tool => (tool.name !== "name_thread" || threadTitleUnclaimed(this.dependencies, state.threadId)) &&
      (state.mode !== "auto" || (tool.name !== "manage_tasks" &&
        (tool.name !== "manage_subagents" || outstandingSubagentsAtRoute.length > 0))));
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

    const toolRecovery = new ToolRecoveryBudget((this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).modelContentRetries + 1);
    let invalidOutputAttempts = 0;
    const commandRetries = new CommandRetryTracker((this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).sandboxInitializationRetries);
    // Once execution becomes uncertain, this run never re-enables mutations.
    // Recovery is an explicit external repair followed by Resume.
    for (let step = 1; !this.requestLimitReached(); step += 1) {
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

      if (agentIdentity.role === "main_agent") {
        for (const report of await this.dependencies.takeSubagentMessages?.(state.threadId, turnId) ?? []) {
          state.messages.push(report);
        }
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
        const sharedRemaining = shared?.maxRequests === null || shared === undefined
          ? undefined
          : Math.max(0, shared.maxRequests - shared.requests);
        const localRemaining = this.remainingRequestAllowance();
        const remainingModelRequests = localRemaining === undefined
          ? sharedRemaining
          : sharedRemaining === undefined
            ? localRemaining
            : Math.min(localRemaining, sharedRemaining);
        const reviewRequests = await this.processProgressIntervention({
          state,
          turnId,
          userInput: memoryContext.userInput,
          remainingModelRequests,
          signal: options.signal,
        });
        this.modelRequestsUsed += reviewRequests;
        if (this.requestLimitReached()) {
          return this.finish(
            state,
            turnId,
            "The shared model-request budget was exhausted while reviewing stalled progress.",
            "limit_reached",
            this.modelRequestsUsed,
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
      const queryKey = `${memoryQueryKey(state, queries)}:${this.dependencies.memoryGeneration?.() ?? ""}`;
      let memorySearchCalls = 0;
      const memorySearchStarted = Date.now();
      if (queryKey !== rememberedQueryKey && !reconciliationPending(state)) {
        const found: Readonly<LongTermMemory>[] = [];
        for (const [index, query] of queries.entries()) {
          memorySearchCalls += 1;
          found.push(...await this.dependencies.searchMemories(query,
            index === 0 || query === memoryContext.userInput ? undefined : { scope: "project" }));
        }
        memories = [...new Map(found.map((memory) => [memory.id, memory])).values()];
        rememberedQueryKey = queryKey;
      }
      const memorySearchDurationMs = Date.now() - memorySearchStarted;
      const workspaceSummary = await this.dependencies.getWorkspaceSummary();
      const ordinaryEnabledTools = [...toolGateway.catalog.tools].filter((tool) =>
        tool.name !== "compact_context" &&
        (tool.name !== "name_thread" || threadTitleUnclaimed(this.dependencies, state.threadId)));
      const currentProgressScope = progressScopeKey(state, turnId);
      const progressInstruction = agentIdentity.role === "main_agent"
        ? progressRuntimeInstruction(state, currentProgressScope) : "";
      const weakHintKind = progressInstruction ? progressWeakHintKind(state, currentProgressScope) : undefined;
      if (weakHintKind) await this.appendProgressHint(
        state, turnId, { scopeKey: currentProgressScope, kind: weakHintKind });
      const runtimeNextActions = [
        this.dependencies.hasOpenCommandHandles?.()
          ? backgroundCommandFinalizationInstruction()
          : "",
        progressInstruction,
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
            memories: selected.memories.map((memory) => ({ id: memory.id, scope: memory.scope, category: memory.category,
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
          presentText: [state.workingSummary, ...state.constraints] });
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
        } catch {
          // Continue with the pinned checkpoint. Retrieval diagnostics belong
          // in durable internals, not the user-visible activity stream.
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
          this.remainingRequestAllowance());
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
      // Remove only duplicates backed by the FINAL visible message set. Keep
      // all other messages byte-identical: no re-selection can evict their proof.
      if (selectedForStep && selectedOptionalCount > 0) {
        const subset = selectMemoryContext({ state, memories: selectedForStep.memories, evidence: selectedForStep.evidence,
          tokenBudget: optionalAllowance, limits: memoryLimits,
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
          selectedForStep = subset;
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
        `Step ${step}${this.requestLimit === undefined ? "" : `/${this.requestLimit}`}: requesting ${this.dependencies.provider.model}`
      );

      let response;
      try {
        const attempted = await this.runProviderAttempt(
          options.signal,
          (attemptSignal) => this.withModelRequestActivity(
            `Waiting for ${this.dependencies.provider.model} response`,
            () => this.dependencies.provider.complete({
              messages,
              // Every actor prefers the same streaming provider transport.
              // Presentation remains main-agent-only so private child context
              // cannot leak into the parent's terminal.
              responseMode: "stream",
              currentTurnImageIds: turnImages.map((image) => image.id),
              tools: enabledTools.map((tool) => tool.definition),
              signal: attemptSignal,
              thinkingEffort: state.thinkingEffort,
              ...(agentIdentity.role === "main_agent" && this.dependencies.onModelStream
                ? {
                    onStreamEvent: (event: ProviderStreamEvent) => {
                      try {
                        this.dependencies.onModelStream?.(event);
                      } catch {
                        // Live presentation must never replace provider output.
                      }
                    },
                  }
                : {}),
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
        if (agentIdentity.role === "main_agent" && selectedForStep?.memories.length &&
            messages.some((message) => message.role === "user" && message.content === stepRuntimeContext)) {
          try {
            this.dependencies.recordMemoryRecall?.(state.threadId, turnId,
              selectedForStep.memories.map((memory) => memory.id));
          } catch {
            // Recall accounting is derived state, never a reason to discard a model response.
          }
        }
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
          error instanceof TaskBudgetExceeded ? this.modelRequestsUsed : step,
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

      const executionToolCalls = deduplicateThreadTitleCalls(response.message.tool_calls);
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response.message.content,
        ...(response.message.phase ? { phase: response.message.phase } : {}),
        tool_calls: executionToolCalls?.map(durableToolCall),
        reasoning_content: response.message.reasoning_content
      };
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
        if (agentIdentity.role === "main_agent" && this.dependencies.collectReadySubagents) {
          const collected = await this.dependencies.collectReadySubagents(state, turnId, options.signal);
          if (collected > 0) {
            continue;
          }
        }
        const outstandingSubagents = agentIdentity.role === "main_agent"
          ? this.dependencies.getOutstandingSubagents?.() ?? []
          : [];
        const obligations = evaluateCompletionGate({
          state,
          role: agentIdentity.role,
          planning: effectiveMode === "plan",
          reconciliationPending: reconciliationPending(state),
          openCommandHandles: this.dependencies.hasOpenCommandHandles?.() ?? false,
          outstandingSubagents,
        });
        if (obligations.length) {
          const { signature, attempt } = nextCompletionAttempt(state, obligations);
          const payload = { signature, attempt, obligations };
          await this.dependencies.appendEvent({ threadId: state.threadId, turnId,
            type: "completion.rejected", phase: "completed", payload });
          foldCompletionControl(state, "completion.rejected", payload);
          const limits = this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS;
          // When several obligations coexist, stop as soon as the most
          // restrictive configured correction budget is exhausted. Resolving
          // that obligation creates a new signature and lets the remaining
          // obligations use their own budget on Resume.
          const maximum = limits.prematureFinishRetries;
          if (attempt <= maximum) {
            const feedback: ChatMessage = { role: "user", content: renderCompletionCorrection(
              obligations, attempt, maximum - attempt) };
            state.messages.push(feedback);
            await this.dependencies.appendEvent({ threadId: state.threadId, turnId,
              type: "message.user.synthetic", phase: "completed", payload: feedback });
            continue;
          }
          return this.finish(state, turnId,
            `Task paused after ${attempt} repeated invalid completion proposals. Pending obligations: ` +
              obligations.map(item => item.description).join(" "),
            "paused", step, memoryContext, undefined, undefined, undefined,
            { cause: obligations.some(item => item.kind === "subagent_submission" || item.kind === "collect_subagents")
              ? "subagent" : "completion_protocol",
              resumable: true,
              requiredAction: obligations.map(item => item.requiredAction).join(" "),
              obligations });
        }
        if (state.completionControl?.active) {
          const payload = { signature: state.completionControl.active.signature };
          await this.dependencies.appendEvent({ threadId: state.threadId, turnId,
            type: "completion.resolved", phase: "completed", payload });
          foldCompletionControl(state, "completion.resolved", payload);
        }
        if (effectiveMode === "plan" && agentIdentity.role === "main_agent" && assistantMessage.content?.trim()) {
          if (await this.takeAndApplySteering(
            state, turnId, "before_final", turnImages, true, memoryContext,
          )) continue;
          const planReview = createPlanReviewState(
            planDraftFromText(assistantMessage.content), turnId, state.planReview,
          );
          await this.dependencies.appendEvent({ threadId: state.threadId, turnId,
            type: "plan.proposed", phase: "completed", payload: { planReview } });
          state.planReview = planReview;
          state.updatedAt = new Date().toISOString();
          const text = `${formatPlanProposal(planReview.proposal)}\n\n` +
            runtimePromptText("runtime/plan-waiting-review.md");
          this.dependencies.onText?.(text);
          return this.finish(state, turnId, text, "planned", step, memoryContext, planReview.proposal);
        }
        let text =
          assistantMessage.content?.trim() ||
          "The task ended, but the model did not provide an explanation.";
        if (await this.takeAndApplySteering(
          state,
          turnId,
          "before_final",
          turnImages,
          false,
          memoryContext,
        )) {
          continue;
        }
        // Finalization seals user steering exactly once. Reviewer advice, when
        // present, was already injected before this model request.
        if (await this.takeAndApplySteering(state, turnId, "before_final", turnImages, true, memoryContext)) continue;
        this.dependencies.onText?.(text);
        const reason = state.taskGraph?.status === "terminal_blocked"
          ? "blocked"
          : "success";
        return this.finish(state, turnId, text, reason, step, memoryContext);
      }

      const compactContextIsExclusive =
        calls.length === 1 && calls[0]?.function.name === "compact_context";
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
      let environmentFault = this.dependencies.getEnvironmentFault?.();

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
              state.progressGuard,
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
        // The gateway is a run-level snapshot, while this one-shot tool can be
        // withdrawn between requests. Other Runtime-owned tools (notably
        // isolated compaction) intentionally have their own exposure path.
        const tool = toolName === "name_thread" &&
          !threadTitleUnclaimed(this.dependencies, state.threadId)
          ? undefined
          : toolGateway.get(toolName);
        let displayName = toolName;
        // Verification relies on recorded changes and actual command results;
        // no whole-repository test baseline is captured or replayed.
        const taskIdAtCall = activeTask(state.taskGraph)?.id;
        let taskGraphOperation: TaskGraphTransitionOperation | undefined;
        let subagentTaskOperation: SubagentTaskOperation | undefined;
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

        if (environmentFault && tool?.mutating) {
          result = toolFailure(new CommandEnvironmentQuarantined(environmentFault), "Tool skipped: environment quarantined; task paused.");
        } else if (!compactContextIsExclusive && calls.some((item) => item.function.name === "compact_context")) {
          result = { ok: false, summary: "compact_context cannot be batched with workspace tools; no call in this batch was executed.",
            error: "context_compaction_must_be_exclusive",
            failure: protocolToolFailure("context_compaction_must_be_exclusive", "Continue normal work without compact_context; Runtime manages context maintenance.") };
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
            const preparedInvocation = toolGateway.prepare(toolName, call.function.arguments);
            if (!preparedInvocation) throw new Error(`Tool ${toolName} is not available`);
            const rawInput = preparedInvocation.input;
            displayName = toolApprovalIdentity(preparedInvocation.tool, rawInput,
              preparedInvocation.binding, state.workspaceRoot).label;
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
            this.dependencies.onStatus?.(`Tool: ${displayName}`);
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
              ...(toolName === "run_command" || toolName === "start_command"
                ? { validationPriorChanges: state.changes.map(change => ({ ...change })) } : {}),
              mode: effectiveMode,
              selectedMode: state.mode,
              threadId: state.threadId,
              turnId,
              approvalPolicy: options.approvalPolicy,
              commandExecutionMode: options.commandExecutionMode,
              isUnrestrictedHostAccessActive: options.isUnrestrictedHostAccessActive,
              unrestrictedHostAccessEpoch: options.unrestrictedHostAccessEpoch,
              requestApproval: this.dependencies.requestApproval,
              signal: options.signal,
              reportProgress: (update: { message?: string; progress?: number; total?: number }) => {
                const detail = update.message?.replace(/[\u0000-\u001F\u007F]/gu, " ").slice(0, 240);
                const amount = typeof update.progress === "number"
                  ? `${update.progress}${typeof update.total === "number" ? `/${update.total}` : ""}`
                  : undefined;
                this.dependencies.onStatus?.([`Tool: ${displayName}`, amount, detail].filter(Boolean).join(" · "));
              },
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
              recordMemoryRecall: (memoryIds: readonly string[]) =>
                this.dependencies.recordMemoryRecall?.(state.threadId, turnId, memoryIds),
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
            result = toolFailure(error, `Tool ${displayName} failed.`);
          }
        }


        if (
          toolName === "write_memory" &&
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
            if (state.taskGraph && state.taskGraph.status !== "completed")
              throw new Error("Finish the planning task DAG before proposing a plan");
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

        result = normalizeToolFailure(result);
        if (toolName === "write_memory" && !result.ok && result.failure) {
          // Long-term memory is a best-effort projection of completed work. A
          // malformed or unsupported proposal must never consume the shared
          // tool-protocol budget or turn a successfully completed coding task
          // into a paused task. Keep the per-call failure visible, skip only
          // that proposal, and let the model deliver its result.
          result = {
            ...result,
            failure: {
              ...result.failure,
              recovery: "none",
              instruction:
                `${result.failure.instruction} This memory proposal was skipped. ` +
                "Do not retry it solely for memory maintenance; continue the task or provide the final answer.",
            },
          };
          toolRecovery.succeed(toolName);
        }
        if (result.failure?.code === "command_environment_quarantined") {
          environmentFault = result.error ?? result.failure.instruction;
        }
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

        if (this.dependencies.captureToolEvidence && toolName !== "compact_context" && toolName !== "write_memory") {
          try {
            result = { ...result, evidenceId: this.dependencies.captureToolEvidence(state, call.id, toolName, result) };
          } catch {
            // The bounded journal result remains authoritative. Evidence
            // archival is internal bookkeeping and should fail silently.
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
        const isMcpResult = tool?.metadata?.identity.sourceId === "mcp";
        const resultChars = versionedRead ? projectionLimits.maxReadResultTokens * 8 + 4096
          : toolName === "search_files" ? projectionLimits.searchMaxResultTokens * 8 + 4096
          : isMcpResult ? options.maxOutputChars
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
        let displayDetails: ReturnType<typeof safeToolDisplayDetails> = [];
        try {
          displayDetails = safeToolDisplayDetails(toolDisplayDetails(
            tool, toolName, call.function.arguments, result, state));
        } catch {
          // Presentation metadata must never prevent a tool result from being committed.
        }
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
              ...(displayDetails.length ? { toolDetails: displayDetails } : {}),
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
              ...(result.ok && result.subagentMessageId
                ? { subagentMessageId: result.subagentMessageId }
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
          state.progressGuard,
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
        if (toolName === "write_memory" && result.ok && result.memoryMutation) {
          memoryContext.mutations.push(result.memoryMutation);
        }
        await this.dependencies.onToolCompleted?.(state, call.function.name, result, displayName, displayDetails);
      }

      if (environmentFault) {
        return this.finish(state, turnId,
          `Task paused because the command environment is quarantined. ${environmentFault}`,
          "paused", step, memoryContext, undefined, undefined, undefined,
          { cause: "command_environment", resumable: true,
            requiredAction: "Repair the command environment and verify cleanup, then resume this task.", obligations: [] });
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
      if (finishRejectedReason) {
        const obligations = evaluateCompletionGate({ state, role: agentIdentity.role,
          reconciliationPending: reconciliationPending(state), openCommandHandles: true,
          outstandingSubagents: agentIdentity.role === "main_agent"
            ? this.dependencies.getOutstandingSubagents?.() ?? [] : [] });
        const { signature, attempt } = nextCompletionAttempt(state, obligations);
        const payload = { signature, attempt, obligations };
        await this.dependencies.appendEvent({ threadId: state.threadId, turnId,
          type: "completion.rejected", phase: "completed", payload });
        foldCompletionControl(state, "completion.rejected", payload);
        const maximum = (this.dependencies.limits ?? DEFAULT_RUNTIME_LIMITS).prematureFinishRetries;
        if (attempt <= maximum) {
          const feedback: ChatMessage = { role: "user", content: renderCompletionCorrection(
            obligations, attempt, maximum - attempt) };
          state.messages.push(feedback);
          await this.dependencies.appendEvent({ threadId: state.threadId, turnId,
            type: "message.user.synthetic", phase: "completed", payload: feedback });
          continue;
        }
        return this.finish(state, turnId, finishRejectedReason, "paused", step, memoryContext,
          undefined, undefined, undefined,
          { cause: "completion_protocol", resumable: true,
            requiredAction: obligations.map(item => item.requiredAction).join(" "), obligations });
      }
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
        return this.finish(
          state,
          turnId,
          text,
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
    }

    if (state.completionControl?.active) {
      const obligations = state.completionControl.active.obligations;
      const cause: NonNullable<AgentRunResult["pause"]>["cause"] = obligations.some(item =>
        item.kind === "subagent_submission" || item.kind === "collect_subagents")
        ? "subagent"
        : "completion_protocol";
      return this.finish(state, turnId,
        `Task paused at the model-request limit with ${obligations.length} unresolved completion obligation(s).`,
        "paused", this.modelRequestsUsed, memoryContext, undefined, undefined, undefined,
        { cause, resumable: true, requiredAction: obligations.map(item => item.requiredAction).join(" "), obligations });
    }
    if (this.requestLimit === undefined) {
      throw new Error("Agent loop ended without completion or a configured model-request limit");
    }
    return this.finish(
      state,
      turnId,
      `Reached the hard limit of ${this.requestLimit} model requests before the task could be confirmed complete.`,
      "limit_reached",
      this.modelRequestsUsed,
      memoryContext,
    );
    } catch (error) {
      const interrupted = Boolean(options.signal?.aborted);
      const message = error instanceof Error ? error.message : String(error);
      const protocolFailure = !interrupted && error instanceof ToolProtocolExhausted ? error : undefined;
      const controlFailure = protocolFailure?.failure ?? (!interrupted ? contextCapacityFailure(error, state) : undefined);
      const capacityExhausted = !interrupted && isContextCapacityError(error);
      const result: AgentRunResult = {
        text: interrupted ? "The task was interrupted by the user." : error instanceof CommandEnvironmentQuarantined
          ? `Task paused: the command environment is quarantined. History and pending work are preserved; repair and verify cleanup before resuming. ${message}` : capacityExhausted
          ? "Context paused: the required request exceeds the model capacity. History and pending work are preserved; reduce required input or use a supported larger window before resuming."
          : `Agent run failed: ${message}`,
        reason: interrupted ? "interrupted" : capacityExhausted || error instanceof TaskBudgetExceeded ? "limit_reached" : "failed",
        steps: error instanceof TaskBudgetExceeded || error instanceof CommandEnvironmentQuarantined ? this.modelRequestsUsed : protocolFailure?.steps ?? 0,
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
    required: boolean, maxRequests?: number, forceRecovery = false): Promise<CompactionResult> {
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
        const attempted = await this.runProviderAttempt(options.signal, (signal) => this.withModelRequestActivity(
          "Summarizing older exchanges", () => this.dependencies.provider.complete({ messages,
            tools, signal, thinkingEffort: "none", responseMode: "stream",
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
    } catch {
      // Usage accounting is internal telemetry and must not alter or annotate
      // the user-visible result.
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
    pause?: AgentRunResult["pause"],
  ): Promise<AgentRunResult> {
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
      ...(pause ? { pause } : {}),
    };
    if (completeExchange(state.messages) && (
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      Boolean(lastMessage.tool_calls?.length) ||
      !lastMessage.content?.trim()
    )) {
      const syntheticMessage: ChatMessage = { role: "assistant", content: text, phase: "final_answer" };
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
        ...(pause ? { pause } : {}),
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
          workspaceRoot: state.workspaceRoot,
          threadId: state.threadId,
          turnId,
          outcome: reason,
          mutations: memoryContext.mutations,
        });
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          type: "memory.committed",
          phase: "completed",
          payload: committed,
        }).catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          type: "memory.commit_failed",
          phase: "failed",
          payload: { message },
        }).catch(() => undefined);
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
      } catch {
        // The durable Thread journal remains authoritative. A best-effort
        // projection failure is not a user-facing task failure.
      }
    }
    return result;
  }
}
