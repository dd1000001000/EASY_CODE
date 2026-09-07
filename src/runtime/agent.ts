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
import { renderPinnedCurrentState } from "../context/artifact-index.js";
import {
  createCompactionMetadata,
  validateCompactionIntegrity,
} from "../context/compaction-integrity.js";
import {
  compactionCooldownSatisfied,
  evaluateCompactionBenefit,
  type CompactionBenefitEvaluation,
} from "../context/compaction-policy.js";
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
import { validateProviderImageAttachments } from "../models/catalog.js";
import {
  clonePlanReviewState,
  createPlanReviewState,
  formatPlanProposal,
  returnPlanExecutionToReview,
  type PlanExecutionReturnOutcome,
} from "../plans/plan.js";
import { loadPromptBundleCatalog } from "../prompt-bundle/index.js";
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
import { jsonForModel, safeJsonParse } from "../utils/json.js";
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

const MEMORY_FINALIZATION_STEP_ALLOWANCE = 2;
const TASK_DAG_FINAL_RESPONSE_STEP_ALLOWANCE = 1;
const CONTEXT_COMPACTION_STEP_ALLOWANCE = 1;
const SUBAGENT_RESULT_STEP_ALLOWANCE = 1;
const SUBAGENT_COLLECTION_STEP_ALLOWANCE = 1;
const BACKGROUND_COMMAND_FINALIZATION_STEP_ALLOWANCE = 1;
const PROGRESS_EXPERIMENT_TOOLS = new Set<ToolName>([
  "read_file",
  "read_image",
  "run_command",
  "start_command",
  "poll_command",
  "cancel_command",
  "compact_context",
]);

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

function contextPressureInstruction(
  level: ContextPressureLevel,
  utilization: number,
): string {
  const percent = contextUtilizationPercent(utilization);
  if (level === "suggest") {
    return renderRuntimePrompt(
      "runtime/context-pressure-suggest.md",
      { percent },
    );
  }
  if (level === "require") {
    return renderRuntimePrompt(
      "runtime/context-pressure-require.md",
      { percent },
    );
  }
  if (level === "force") {
    return renderRuntimePrompt(
      "runtime/context-pressure-force.md",
      { percent },
    );
  }
  return "";
}

function contextPressureRank(level: ContextPressureLevel): number {
  if (level === "force") return 3;
  if (level === "require") return 2;
  if (level === "suggest") return 1;
  return 0;
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
      scopeKey: incident.scopeKey,
      targetKey: incident.targetKey,
      outcomeClass: incident.outcomeClass,
      outcomeKey: incident.outcomeKey,
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
      experiment: incident.reviewReport.experiment,
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

function commandVerificationIntent(
  toolName: ToolName,
  rawArguments: string,
  experimentRequired: boolean,
  knownVerificationCommands: ReadonlySet<string>,
  result: Readonly<ToolExecutionResult>,
): boolean {
  if (experimentRequired) return true;
  if (toolName === "run_command" || toolName === "start_command") {
    try {
      const parsed = safeJsonParse(rawArguments) as { intent?: unknown };
      return parsed.intent === "test" || parsed.intent === "build";
    } catch {
      return false;
    }
  }
  if (toolName !== "poll_command" && toolName !== "cancel_command") return false;
  const data = result.data && typeof result.data === "object"
    ? result.data as Record<string, unknown>
    : undefined;
  return typeof data?.commandId === "string" &&
    knownVerificationCommands.has(data.commandId);
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
}

function pinCurrentState(
  state: Readonly<SessionState>,
  approvedPlanReview: Readonly<PlanReviewState> | undefined,
  derived: RuntimeLayeredContext = {},
): RuntimeLayeredContext {
  return {
    workingCheckpoint: renderPinnedCurrentState(state, approvedPlanReview),
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

export interface AgentRuntimeDependencies {
  provider: ModelProvider;
  tools: AgentTool[];
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
  }) => Promise<{
    workingCheckpoint?: string;
    retrievedThreadEvidence?: string;
  }>;
  /** Catch the derived incremental index up after the final durable message. */
  checkpointContext?: (state: Readonly<SessionState>) => Promise<void>;
  commitMemoryMutations?: (input: {
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
  tools: AgentTool[],
  mode: AgentMode,
  role: AgentRole,
  _thinkingEffort: SessionState["thinkingEffort"],
): AgentTool[] {
  if (role === "subagent") {
    if (mode !== "code") return [];
    return tools.filter((tool) =>
      tool.name === "read_file" ||
      tool.name === "create_file" ||
      tool.name === "update_file" ||
      tool.name === "delete_file" ||
      tool.name === "run_command" ||
      tool.name === "start_command" ||
      tool.name === "poll_command" ||
      tool.name === "cancel_command" ||
      tool.name === "compact_context" ||
      tool.name === "submit_task_result"
    );
  }
  if (mode !== "plan") {
    return tools.filter(
      (tool) =>
        tool.name !== "propose_plan" &&
        tool.name !== "select_mode" &&
        tool.name !== "submit_task_result",
    );
  }
  return tools.filter(
    (tool) =>
      tool.name === "read_file" ||
      tool.name === "read_image" ||
      tool.name === "run_command" ||
      tool.name === "propose_plan" ||
      tool.name === "compact_context" ||
      tool.name === "manage_memory",
  );
}

const TASK_WORK_TOOLS = new Set<ToolName>([
  "read_file",
  "read_image",
  "create_file",
  "update_file",
  "delete_file",
  "run_command",
  "start_command",
  "poll_command",
  "cancel_command",
]);

function taskGraphToolError(
  graph: Readonly<TaskGraph> | undefined,
  toolName: ToolName,
  turnId: string,
): string | undefined {
  if (!graph) return undefined;
  if (graph.status === "completed") {
    if (
      graph.updatedByTurnId === turnId &&
      TASK_WORK_TOOLS.has(toolName)
    ) {
      return "The task DAG was completed in this turn. Return the final result before starting unrelated work.";
    }
    return undefined;
  }
  if (toolName === "manage_memory") {
    return "Long-term memory maintenance must wait until the task DAG is completed.";
  }
  if (!TASK_WORK_TOOLS.has(toolName)) return undefined;
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
  const payload = {
    ok: result.ok,
    summary: result.summary,
    data: result.data,
    error: result.error
  };
  const complete = jsonForModel(payload);
  if (complete.length <= maximumChars) return complete;

  let textBudget = Math.max(16, Math.floor((maximumChars - 120) / 2));
  while (textBudget >= 0) {
    const bounded = jsonForModel({
      ok: result.ok,
      summary: result.summary.slice(0, textBudget),
      ...(result.error ? { error: result.error.slice(0, textBudget) } : {}),
      data: { truncated: true, originalChars: complete.length },
    });
    if (bounded.length <= maximumChars) return bounded;
    if (textBudget === 0) break;
    textBudget = Math.floor(textBudget / 2);
  }
  return jsonForModel({ ok: result.ok, data: { truncated: true } });
}

type AssistantToolCall = NonNullable<
  Extract<ChatMessage, { role: "assistant" }>["tool_calls"]
>[number];

/**
 * coverageCheck and intentLedger are one-request validation inputs used only by
 * Runtime's acceptance gate. The accepted ledger is persisted separately in
 * canonical state; retaining either raw field in the assistant event would
 * duplicate transient material on every resume and in retrieval.
 */
function durableToolCall(call: AssistantToolCall): AssistantToolCall {
  if (call.function.name !== "compact_context") return call;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments) as unknown;
  } catch {
    return {
      ...call,
      function: { ...call.function, arguments: "{}" },
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ...call,
      function: { ...call.function, arguments: "{}" },
    };
  }
  const durable = { ...(parsed as Record<string, unknown>) };
  delete durable.coverageCheck;
  delete durable.intentLedger;
  return {
    ...call,
    function: {
      ...call.function,
      arguments: JSON.stringify(durable),
    },
  };
}

const MAX_PINNED_INTENT_QUOTE_CHARS = 400;
const MAX_COMPACTION_INVENTORY_USER_MESSAGES = 96;

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

function isRuntimeCompactionMessage(content: string): boolean {
  return /^RUNTIME_CONTEXT_(?:COMPACTION|PRESSURE)/u.test(content.trimStart());
}

/** Runtime-owned source map lets every provider cite durable message indices. */
function compactionSourceInventory(state: Readonly<SessionState>): string {
  const userMessages = state.messages
    .map((message, sourceMessageIndex) => ({ message, sourceMessageIndex }))
    .filter(({ message }) =>
      message.role === "user" &&
      message.content.trim() &&
      !isRuntimeCompactionMessage(message.content)
    )
    .slice(-MAX_COMPACTION_INVENTORY_USER_MESSAGES)
    .map(({ message, sourceMessageIndex }) => ({
      sourceMessageIndex,
      exactQuote: boundedIntentQuote(message.content ?? ""),
      ...(message.role === "user" && message.images?.length
        ? { images: message.images.map((image) => image.label) }
        : {}),
    }));
  const latestMessageIndex = userMessages.at(-1)?.sourceMessageIndex ?? -1;
  const blockedTask = state.taskGraph?.tasks.find((task) => task.status === "blocked");
  const latestCommand = state.commands.at(-1);
  const latestFailedCommand = latestCommand &&
    (latestCommand.status !== "exited" || latestCommand.exitCode !== 0)
    ? latestCommand
    : undefined;
  return [
    "RUNTIME_COMPACTION_SOURCE_INVENTORY:",
    "Use these zero-based durable message indices and exact bounded quotes in " +
      "primaryRequest, activeConstraints, intentLedger, and coverageCheck. " +
      "Preserve currentIntentLedger.latestRequest as the primary request and " +
      "keep later steering in userCorrections. latestMessageIndex is the newest " +
      "durable user message. coverageCheck is temporary and discarded after validation.",
    JSON.stringify({
      sourceEndExclusive: state.messages.length,
      latestMessageIndex,
      currentIntentLedger: state.contextIntentLedger ?? null,
      runtimeConstraints: state.constraints.map((constraint) =>
        redactSensitiveInformation(constraint)
      ),
      userMessages,
      activePlan: state.planReview
        ? {
            id: state.planReview.proposal.id,
            revision: state.planReview.proposal.revision,
            status: state.planReview.status,
          }
        : null,
      taskGraph: state.taskGraph
        ? {
            id: state.taskGraph.id,
            goal: state.taskGraph.goal,
            status: state.taskGraph.status,
            currentTaskId: activeTask(state.taskGraph)?.id ?? null,
            blockedTask: blockedTask
              ? { id: blockedTask.id, blocker: blockedTask.blocker ?? null }
              : null,
          }
        : null,
      latestUnresolvedCommand: latestFailedCommand
        ? {
            id: latestFailedCommand.id,
            status: latestFailedCommand.status,
            summary: redactSensitiveInformation(
              latestFailedCommand.summary,
            ).slice(0, 800),
          }
        : null,
    }),
  ].join("\n");
}

interface AcceptedContextCompaction {
  readonly benefit: CompactionBenefitEvaluation;
  readonly intentLedger: NonNullable<SessionState["contextIntentLedger"]>;
  readonly metadata: NonNullable<SessionState["contextCompactionMetadata"]>;
}

interface ContextCompactionAssessment {
  readonly result: ToolExecutionResult;
  readonly accepted?: AcceptedContextCompaction;
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
  constructor(private readonly dependencies: AgentRuntimeDependencies) {
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
          maxModelRequests: input.remainingModelRequests >= 3 ? 2 : 1,
          signal: input.signal,
        },
        {
          provider: this.dependencies.provider,
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

  private assessContextCompaction(input: {
    state: SessionState;
    call: AssistantToolCall;
    result: ToolExecutionResult;
    sourceEndMessageIndex: number;
    retainedTail?: readonly ChatMessage[];
    required: boolean;
    maxContextChars: number;
    maxOutputChars: number;
  }): ContextCompactionAssessment {
    const request = input.result.contextCompaction;
    if (!input.result.ok || !request) return { result: input.result };

    const integrity = validateCompactionIntegrity({
      state: input.state,
      request,
      sourceEndMessageIndex: input.sourceEndMessageIndex,
    });
    const previewToolMessage: Extract<ChatMessage, { role: "tool" }> = {
      role: "tool",
      tool_call_id: input.call.id,
      name: input.call.function.name,
      content: resultForModel(input.result, input.maxOutputChars),
    };
    const compactedMessageCount = input.state.messages.length + 1;
    const candidateMessages = [
      ...input.state.messages,
      previewToolMessage,
      ...(input.retainedTail ?? []),
    ];
    const benefit = evaluateCompactionBenefit(
      this.dependencies.contextManager,
      {
        state: input.state,
        candidateMessages,
        summary: request.summary,
        compactedMessageCount,
        maxContextChars: input.maxContextChars,
        historyEndExclusive: input.sourceEndMessageIndex,
        required: input.required,
      },
    );
    if (!integrity.ok) {
      return {
        result: {
          ok: false,
          summary: "Runtime rejected an incomplete or stale context summary.",
          error: `context_compaction_integrity_failed:${integrity.errors.join(",")}`,
          data: {
            formatVersion: request.formatVersion ?? null,
            validationErrors: integrity.errors,
          },
        },
      };
    }
    if (!benefit.accepted) {
      return {
        result: {
          ok: false,
          summary: "Runtime rejected a low-benefit context compaction.",
          error: benefit.rejectionReason ?? "context_compaction_benefit_failed",
          data: {
            beforeProjectedChars: benefit.beforeProjectedChars,
            afterProjectedChars: benefit.afterProjectedChars,
            newProjectedChars: benefit.newProjectedChars,
            savedChars: benefit.savedChars,
            savingsRatio: benefit.savingsRatio,
            postCompactionUtilization: benefit.postCompactionUtilization,
          },
        },
      };
    }

    const metadata = createCompactionMetadata({
      state: input.state,
      sourceStartMessageIndex: input.state.compactedMessageCount,
      sourceEndMessageIndex: input.sourceEndMessageIndex,
      compactedMessageCount,
      benefit,
    });
    return {
      result: input.result,
      accepted: {
        benefit,
        intentLedger: integrity.intentLedger!,
        metadata,
      },
    };
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
    const actualRequest = input.actualRequest ??
      this.dependencies.contextManager.inspectProviderRequest({
        state: input.state,
        maxContextChars: input.maxContextChars,
        messages: input.messages,
        ...(input.tools ? { tools: input.tools } : {}),
      });
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
    const userInput = typeof input === "string" ? input : input.text;
    const inputImages = typeof input === "string" ? [] : [...(input.images ?? [])];
    validateImageAttachmentCollection(inputImages);
    validateProviderImageAttachments(this.dependencies.provider.name, inputImages);
    const turnId = createId("turn");
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
      const routeContextPressure = this.dependencies.contextManager
        .inspect(state, options.maxContextChars).pressure;
      if (
        !unfinishedGraph &&
        outstandingSubagentsAtRoute.length === 0 &&
        (routeContextPressure === "require" || routeContextPressure === "force")
      ) {
        await this.compactBeforeAutoRoute(
          state,
          turnId,
          userMessage,
          turnImages,
          memoryContext,
          options,
        );
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
            ): Promise<string> => this.dependencies.buildSystemPrompt({
              mode: "auto",
              workspaceSummary: "",
              memories: [],
              ...(context.workingCheckpoint
                ? { workingCheckpoint: context.workingCheckpoint }
                : {}),
              ...(context.retrievedThreadEvidence
                ? { retrievedThreadEvidence: context.retrievedThreadEvidence }
                : {}),
              toolNames: [],
            });
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

    const memories = await this.dependencies.searchMemories(memoryContext.userInput);
    let nextImageNumber = nextThreadImageNumber(state.messages);
    const toolMap = new Map<ToolName, AgentTool>();
    for (const tool of availableTools(
      this.dependencies.tools,
      effectiveMode,
      agentIdentity.role,
      state.thinkingEffort,
    )) {
      toolMap.set(tool.name, tool);
    }
    const progressResponseBase =
      state.progressGuard?.lastObservedResponseOrdinal ?? 0;
    const progressVerificationCommands = new Set<string>();

    let stepLimit = options.maxSteps;
    let memoryFinalizationAllowanceGranted = false;
    let taskDagFinalizationOnly = false;
    let taskDagFinalResponseAllowanceGranted = false;
    let planToolReminderIssued = false;
    let contextCompactionCorrectionIssued = false;
    let forcedContextCompactionRequestActive = false;
    let contextCompactionCorrectionAllowanceGranted = false;
    let contextCompactionContinuationAllowanceGranted = false;
    let lastContextPressureLevel: ContextPressureLevel = "normal";
    let subagentResultReminderIssued = false;
    let subagentResultAllowanceGranted = false;
    let subagentCollectionReminderIssued = false;
    let subagentCollectionAllowanceGranted = false;
    let backgroundCommandFinalizationReminderIssued = false;
    let backgroundCommandFinalizationAllowanceGranted = false;
    let runCommandUnavailable = false;
    let unavailableCommandTool: "run_command" | "start_command" = "run_command";
    let retryableSandboxFailureCount = 0;
    let retryableSandboxRecoveryPending = false;
    let progressReviewModelRequestsUsed = 0;
    let progressExperimentReminderIssued = false;
    for (
      let step = 1;
      step + progressReviewModelRequestsUsed <= stepLimit;
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
        const remainingModelRequests = stepLimit -
          ((step - 1) + progressReviewModelRequestsUsed);
        progressReviewModelRequestsUsed += await this.processProgressIntervention({
          state,
          turnId,
          userInput: memoryContext.userInput,
          remainingModelRequests,
          signal: options.signal,
        });
        if (step + progressReviewModelRequestsUsed > stepLimit) {
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
      if (this.dependencies.getLayeredContext) {
        try {
          const derived = await this.dependencies.getLayeredContext({
            state,
            query: contextRetrievalQuery(state, memoryContext.userInput),
            beforeMessageIndex: 0,
          });
          layeredContext = pinCurrentState(
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
      const workspaceSummary = await this.dependencies.getWorkspaceSummary();
      const compactContextTool = toolMap.get("compact_context");
      const ordinaryEnabledTools = taskDagFinalizationOnly
        ? state.taskGraph?.status === "completed"
          ? [...toolMap.values()].filter((tool) => tool.name === "manage_memory")
          : []
        : [...toolMap.values()].filter((tool) =>
            !runCommandUnavailable ||
            (tool.name !== "run_command" && tool.name !== "start_command")
          );
      const fixedRuntimeInstructions = [
        runCommandUnavailable ? sandboxUnavailableInstruction(agentIdentity.role) : "",
        this.dependencies.hasOpenCommandHandles?.()
          ? backgroundCommandFinalizationInstruction()
          : "",
        agentIdentity.role === "main_agent"
          ? progressRuntimeInstruction(state, progressScopeKey(state, turnId))
          : "",
      ].filter(Boolean);
      const buildStepSystemPrompt = async (
        context: typeof layeredContext,
        exposedTools: readonly AgentTool[],
        runtimeInstructions: readonly string[],
      ): Promise<string> => {
        const base = await this.dependencies.buildSystemPrompt({
          mode: effectiveMode,
          workspaceSummary,
          memories,
          ...(context.workingCheckpoint
            ? { workingCheckpoint: context.workingCheckpoint }
            : {}),
          ...(context.retrievedThreadEvidence
            ? { retrievedThreadEvidence: context.retrievedThreadEvidence }
            : {}),
          toolNames: exposedTools.map((tool) => tool.name),
          ...(state.taskGraph && (
            state.taskGraph.status !== "completed" ||
            state.taskGraph.updatedByTurnId === turnId
          )
            ? { taskGraph: state.taskGraph }
            : {}),
          ...(state.planReview ? { planReview: state.planReview } : {}),
        });
        return runtimeInstructions.length
          ? `${base}\n\n${runtimeInstructions.join("\n\n")}`
          : base;
      };

      // Reserve room with the complete ordinary capability surface before
      // selecting the retrieval boundary. The fixed evidence reserve affects
      // selection only; pressure below is measured from a concrete provider
      // request after retrieval, projection, and tool-schema serialization.
      const selectionSystemPrompt = await buildStepSystemPrompt(
        layeredContext,
        ordinaryEnabledTools,
        fixedRuntimeInstructions,
      );
      const ordinaryToolDefinitions = ordinaryEnabledTools.map((tool) => tool.definition);
      const reservedSystemPromptChars = selectionSystemPrompt.length + 32 +
        estimateToolDefinitionsChars(ordinaryToolDefinitions) +
        (this.dependencies.getLayeredContext
          ? LAYERED_EVIDENCE_SYSTEM_RESERVE_CHARS
          : 0) +
        CONTEXT_PRESSURE_SYSTEM_RESERVE_CHARS;
      let retrievalContextChanged = false;
      if (this.dependencies.getLayeredContext) {
        try {
          const derived = await this.dependencies.getLayeredContext({
            state,
            query: contextRetrievalQuery(state, memoryContext.userInput),
            beforeMessageIndex: this.dependencies.contextManager.retrievalBoundary(
              state,
              options.maxContextChars,
              selectionSystemPrompt,
              reservedSystemPromptChars,
            ),
          });
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
            fixedRuntimeInstructions,
          )
        : selectionSystemPrompt;
      let enabledTools = ordinaryEnabledTools;
      let messages = this.dependencies.contextManager.build({
        systemPrompt,
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

      const rebuildForPressure = async (): Promise<void> => {
        const contextCompactionRequiredNow =
          contextPressure === "require" || contextPressure === "force";
        enabledTools = contextCompactionRequiredNow
          ? compactContextTool
            ? [compactContextTool]
            : []
          : ordinaryEnabledTools;
        const pressureInstruction = contextPressureInstruction(
          contextPressure,
          contextUtilization,
        );
        const compactionInventory = contextPressure === "normal"
          ? ""
          : compactionSourceInventory(state);
        systemPrompt = await buildStepSystemPrompt(
          layeredContext,
          enabledTools,
          [
            pressureInstruction,
            compactionInventory,
            ...fixedRuntimeInstructions,
          ].filter(Boolean),
        );
        messages = this.dependencies.contextManager.build({
          systemPrompt,
          state,
          maxContextChars: options.maxContextChars,
          reservedSystemPromptChars,
        });
        requestInspection = this.dependencies.contextManager.inspectProviderRequest({
          state,
          maxContextChars: options.maxContextChars,
          messages,
          tools: enabledTools.map((tool) => tool.definition),
        });
      };

      if (contextPressure === "force" && !forcedContextCompactionRequestActive) {
        await this.appendContextCompactionRequest({
          state,
          turnId,
          step,
          utilization: contextUtilization,
          correction: false,
        });
        forcedContextCompactionRequestActive = true;
      }
      if (contextPressure !== "normal") await rebuildForPressure();

      // A pressure instruction can make the concrete request cross the next
      // boundary. Escalate at most once and never downgrade within a step,
      // preventing compact-only capability changes from oscillating.
      if (contextPressureRank(requestInspection.pressure) > contextPressureRank(contextPressure)) {
        contextPressure = requestInspection.pressure;
        contextUtilization = requestInspection.utilization;
        if (contextPressure === "force" && !forcedContextCompactionRequestActive) {
          await this.appendContextCompactionRequest({
            state,
            turnId,
            step,
            utilization: contextUtilization,
            correction: false,
          });
          forcedContextCompactionRequestActive = true;
        }
        await rebuildForPressure();
      }

      const contextCompactionRequired =
        contextPressure === "require" || contextPressure === "force";
      if (contextPressure !== lastContextPressureLevel) {
        const percent = contextUtilizationPercent(contextUtilization);
        if (contextPressure === "normal") {
          this.dependencies.onStatus?.(
            `Context utilization returned below 60% (${percent}%).`,
          );
        } else if (contextPressure === "suggest") {
          this.dependencies.onStatus?.(
            `Context utilization is ${percent}%; the model is advised to compact soon.`,
          );
        } else if (contextPressure === "require") {
          this.dependencies.onStatus?.(
            `Context utilization is ${percent}%; compact_context is required before other work.`,
          );
        } else {
          this.dependencies.onStatus?.(
            `Context utilization is ${percent}%; Runtime is forcing a context compaction request.`,
          );
        }
        lastContextPressureLevel = contextPressure;
      }
      this.observeProviderContext({
        state,
        turnId,
        step,
        attempt: 1,
        purpose: contextCompactionRequired ? "context_compaction" : "agent_step",
        messages,
        tools: enabledTools.map((tool) => tool.definition),
        enforcedPressure: contextPressure,
        enforcedUtilization: contextUtilization,
        maxContextChars: options.maxContextChars,
        actualRequest: requestInspection,
      });
      this.dependencies.onStatus?.(
        `Step ${step}/${stepLimit}: requesting ${this.dependencies.provider.model}`
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
          contextCompactionRequired || compactOnly
            ? "context_compaction"
            : "agent_step",
          response.usage,
          { step, attempt: 1, retry: false },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `step_${step}`,
          type: "model.error",
          phase: "failed",
          payload: { message }
        });
        const interrupted = Boolean(options.signal?.aborted);
        return this.finish(
          state,
          turnId,
          interrupted ? "The task was interrupted by the user." : `Model request failed: ${message}`,
          interrupted ? "interrupted" : "failed",
          step,
          memoryContext,
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
        !contextCompactionRequired &&
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

      // Execute the original arguments so the ephemeral coverageCheck reaches
      // Runtime, while only the sanitized call above enters durable history.
      const calls = executionToolCalls ?? [];
      if (calls.length === 0) {
        if (contextCompactionRequired) {
          if (!contextCompactionCorrectionIssued) {
            await this.appendContextCompactionRequest({
              state,
              turnId,
              step,
              utilization: contextUtilization,
              correction: true,
            });
            contextCompactionCorrectionIssued = true;
            if (
              step === stepLimit &&
              !contextCompactionCorrectionAllowanceGranted
            ) {
              stepLimit += CONTEXT_COMPACTION_STEP_ALLOWANCE;
              contextCompactionCorrectionAllowanceGranted = true;
              this.dependencies.onStatus?.(
                "Reserved one correction step for required context compaction.",
              );
            }
            this.dependencies.onStatus?.(
              "The model did not compact the required context; requesting one correction.",
            );
            continue;
          }
          return this.finish(
            state,
            turnId,
            "The model did not complete the required context compaction.",
            "failed",
            step,
            memoryContext,
          );
        }
        if (this.dependencies.hasOpenCommandHandles?.()) {
          const instruction = backgroundCommandFinalizationInstruction();
          if (!backgroundCommandFinalizationReminderIssued) {
            backgroundCommandFinalizationReminderIssued = true;
            const reminder: Extract<ChatMessage, { role: "user" }> = {
              role: "user",
              content: instruction,
            };
            state.messages.push(reminder);
            await this.dependencies.appendEvent({
              threadId: state.threadId,
              turnId,
              stepId: `step_${step}`,
              type: "message.user.synthetic",
              phase: "completed",
              payload: reminder,
            });
            if (
              step === stepLimit &&
              !backgroundCommandFinalizationAllowanceGranted
            ) {
              stepLimit += BACKGROUND_COMMAND_FINALIZATION_STEP_ALLOWANCE;
              backgroundCommandFinalizationAllowanceGranted = true;
            }
            this.dependencies.onStatus?.(
              "The model attempted to finish with a running command; requesting command finalization.",
            );
            continue;
          }
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
          if (!progressExperimentReminderIssued) {
            progressExperimentReminderIssued = true;
            const reminder: Extract<ChatMessage, { role: "user" }> = {
              role: "user",
              content: instruction,
            };
            state.messages.push(reminder);
            await this.dependencies.appendEvent({
              threadId: state.threadId,
              turnId,
              stepId: `step_${step}`,
              type: "message.user.synthetic",
              phase: "completed",
              payload: reminder,
            });
            this.dependencies.onStatus?.(
              "The model attempted to finish before running the required progress experiment; requesting one correction.",
            );
            continue;
          }
          return this.finish(
            state,
            turnId,
            "The required progress experiment was not executed with a real terminal verification result.",
            "blocked",
            step,
            memoryContext,
          );
        }
        const text =
          assistantMessage.content?.trim() ||
          "The task ended, but the model did not provide an explanation.";
        if (agentIdentity.role === "subagent") {
          if (!subagentResultReminderIssued) {
            subagentResultReminderIssued = true;
            const reminder: Extract<ChatMessage, { role: "user" }> = {
              role: "user",
              content: runtimePromptText(
                "runtime/subagent-result-required.md",
              ),
            };
            state.messages.push(reminder);
            await this.dependencies.appendEvent({
              threadId: state.threadId,
              turnId,
              stepId: `step_${step}`,
              type: "message.user.synthetic",
              phase: "completed",
              payload: reminder,
            });
            if (step === stepLimit && !subagentResultAllowanceGranted) {
              stepLimit += SUBAGENT_RESULT_STEP_ALLOWANCE;
              subagentResultAllowanceGranted = true;
            }
            this.dependencies.onStatus?.(
              "The child attempted to finish without submit_task_result; requesting one correction.",
            );
            continue;
          }
          return this.finish(
            state,
            turnId,
            "The child did not submit a structured result for its bound task.",
            "failed",
            step,
            memoryContext,
          );
        }
        const outstandingSubagents = this.dependencies.getOutstandingSubagents?.() ?? [];
        if (outstandingSubagents.length > 0) {
          if (!subagentCollectionReminderIssued) {
            subagentCollectionReminderIssued = true;
            const targets = outstandingSubagents
              .slice(0, 8)
              .map(
                (agent) =>
                  `${agent.id}=${agent.assignmentKind}:${agent.taskId} (${agent.status})`,
              )
              .join(", ");
            const reminder: Extract<ChatMessage, { role: "user" }> = {
              role: "user",
              content: renderRuntimePrompt(
                "runtime/subagent-collection-required.md",
                { targets },
              ),
            };
            state.messages.push(reminder);
            await this.dependencies.appendEvent({
              threadId: state.threadId,
              turnId,
              stepId: `step_${step}`,
              type: "message.user.synthetic",
              phase: "completed",
              payload: reminder,
            });
            if (step === stepLimit && !subagentCollectionAllowanceGranted) {
              stepLimit += SUBAGENT_COLLECTION_STEP_ALLOWANCE;
              subagentCollectionAllowanceGranted = true;
            }
            this.dependencies.onStatus?.(
              "The model attempted to finish with outstanding child work; requesting collection.",
            );
            continue;
          }
          return this.finish(
            state,
            turnId,
            "The main agent did not collect all outstanding child results.",
            "failed",
            step,
            memoryContext,
          );
        }
        if (state.taskGraph?.status === "active" && runCommandUnavailable) {
          const pausedText = sandboxPauseText(text);
          if (await this.takeAndApplySteering(
            state,
            turnId,
            "before_final",
            turnImages,
            true,
            memoryContext,
          )) {
            if (step === stepLimit) stepLimit += 1;
            continue;
          }
          this.dependencies.onText?.(pausedText);
          return this.finish(
            state,
            turnId,
            pausedText,
            "blocked",
            step,
            memoryContext,
          );
        }
        if (state.taskGraph?.status === "active") {
          const reminder: Extract<ChatMessage, { role: "user" }> = {
            role: "user",
            content: incompleteTaskGraphReminder(state.taskGraph),
          };
          state.messages.push(reminder);
          await this.dependencies.appendEvent({
            threadId: state.threadId,
            turnId,
            stepId: `step_${step}`,
            type: "message.user.synthetic",
            phase: "completed",
            payload: reminder,
          });
          this.dependencies.onStatus?.(
            "The model attempted to finish while the task DAG was incomplete; continuing.",
          );
          continue;
        }
        if (effectiveMode === "plan") {
          if (!planToolReminderIssued) {
            planToolReminderIssued = true;
            const reminder: Extract<ChatMessage, { role: "user" }> = {
              role: "user",
              content: runtimePromptText(
                "runtime/plan-submission-required.md",
              ),
            };
            state.messages.push(reminder);
            await this.dependencies.appendEvent({
              threadId: state.threadId,
              turnId,
              stepId: `step_${step}`,
              type: "message.user.synthetic",
              phase: "completed",
              payload: reminder,
            });
            this.dependencies.onStatus?.(
              "The model did not submit its plan with propose_plan; requesting one correction.",
            );
            continue;
          }
          return this.finish(
            state,
            turnId,
            "The model did not submit a structured plan with propose_plan.",
            "failed",
            step,
            memoryContext,
          );
        }
        if (await this.takeAndApplySteering(
          state,
          turnId,
          "before_final",
          turnImages,
          true,
          memoryContext,
        )) {
          if (step === stepLimit) stepLimit += 1;
          continue;
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
      const contextCompactionProtocolViolated =
        contextCompactionRequired && !compactContextIsExclusive;
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
      const compactContextHasNewHistory =
        contextPressure !== "normal" &&
        (
          contextCompactionRequired ||
          compactionCooldownSatisfied(state, state.messages.length - 1)
        );
      const stepImageAttachments: ImageAttachment[] = [];
      let successfulMemoryToolCall = false;
      let successfulContextCompaction = false;
      let proposedPlan: PlanProposal | undefined;
      let submittedTaskReport: SubagentTaskReport | undefined;
      let sandboxPauseRequested = false;
      let steeringAppliedBetweenTools = false;
      let backgroundCommandFinalizationRejected = false;
      let acceptedContextCompaction: AcceptedContextCompaction | undefined;

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
        const tool = toolMap.get(toolName);
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

        if (contextCompactionProtocolViolated) {
          result = {
            ok: false,
            summary:
              "Context compaction is required; compact_context must be the only tool call.",
            error: "context_compaction_required",
          };
        } else if (
          progressExperimentAtCall &&
          !PROGRESS_EXPERIMENT_TOOLS.has(toolName)
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
        } else if (toolName === "compact_context" && !compactContextIsExclusive) {
          result = {
            ok: false,
            summary: "compact_context must be the only tool call in a model response.",
            error: "compact_context_must_be_exclusive",
          };
        } else if (toolName === "compact_context" && !compactContextHasNewHistory) {
          result = {
            ok: false,
            summary:
              "Context compaction is below the pressure/cooldown threshold or has no meaningful new history.",
            error: "context_compaction_cooldown_active",
          };
        } else if (!tool) {
          result = {
            ok: false,
            summary: `Tool ${call.function.name} is not available in the current mode.`,
            error: "tool_not_available"
          };
        } else if (
          (toolName === "run_command" || toolName === "start_command") &&
          runCommandUnavailable
        ) {
          result = {
            ok: false,
            summary:
              `${toolName} is disabled for the rest of this turn because the OS sandbox ` +
              "failed before a previous command started. Do not retry it or persistently " +
              "block the current DAG task; continue with file tools or return a plain-text " +
              "pause report. Runtime will re-enable commands next turn.",
            error: "sandbox_unavailable_for_turn",
          };
        } else {
          try {
            const graphError = taskGraphToolError(state.taskGraph, toolName, turnId);
            if (graphError) throw new Error(graphError);
            const rawInput = safeJsonParse(call.function.arguments);
            let input: unknown = rawInput;
            if (toolName === "manage_tasks") {
              const parsedOperation = taskGraphOperationSchema.parse(rawInput);
              if (
                (parsedOperation.action === "complete" ||
                  parsedOperation.action === "block") &&
                this.dependencies.hasOpenCommandHandles?.()
              ) {
                backgroundCommandFinalizationRejected = true;
                throw new Error(backgroundCommandFinalizationInstruction());
              }
              if (
                (runCommandUnavailable || retryableSandboxRecoveryPending) &&
                parsedOperation.action === "block"
              ) {
                if (runCommandUnavailable) sandboxPauseRequested = true;
                throw new Error(
                  retryableSandboxRecoveryPending && !runCommandUnavailable
                    ? "A first transient Windows SRT initialization failure cannot " +
                      `persistently block a DAG task. Retry ${unavailableCommandTool} once; Runtime keeps ` +
                      "the task in progress."
                    : "A turn-scoped OS sandbox failure cannot persistently block a DAG task. " +
                      "Return a plain-text pause report instead; Runtime keeps the task in " +
                      "progress and re-enables command execution next turn.",
                );
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
              backgroundCommandFinalizationRejected = true;
              throw new Error(backgroundCommandFinalizationInstruction());
            }
            this.dependencies.onStatus?.(`Tool: ${tool.name}`);
            const toolContext = {
              workspaceRoot: state.workspaceRoot,
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
              ...(state.taskGraph
                ? { taskGraph: cloneTaskGraph(state.taskGraph) }
                : {}),
              recordCommand: (entry: CommandAuditEntry) => {
                state.commands.push(entry);
                this.dependencies.recordCommand?.(turnId, entry);
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
            result = await this.withToolExecutionActivity(
              tool.name,
              () => tool.execute(input, toolContext),
            );
            preparedSubagentLifecycle = result.subagentLifecycle;
          } catch (error) {
            result = {
              ok: false,
              summary: `Tool ${call.function.name} failed.`,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }

        if (toolName === "run_command" || toolName === "start_command") {
          const commandData = result.data && typeof result.data === "object"
            ? result.data
            : undefined;
          const commandStatus = commandData && "status" in commandData
            ? commandData.status
            : undefined;
          if (!result.ok && commandStatus === "sandbox_unavailable") {
            unavailableCommandTool = toolName;
            const sandboxFailure = commandData &&
                "sandboxFailure" in commandData &&
                commandData.sandboxFailure &&
                typeof commandData.sandboxFailure === "object"
              ? commandData.sandboxFailure as { retryable?: unknown }
              : undefined;
            if (
              sandboxFailure?.retryable === true &&
              retryableSandboxFailureCount === 0
            ) {
              retryableSandboxFailureCount = 1;
              retryableSandboxRecoveryPending = true;
            } else {
              runCommandUnavailable = true;
            }
          } else if (commandStatus !== undefined || result.ok) {
            // The bounded retry reached a real command outcome (including
            // non-zero exit, timeout, denial, or spawn failure). Sandbox
            // recovery is no longer pending, so later task decisions must be
            // based on that outcome rather than the earlier transient failure.
            retryableSandboxFailureCount = 0;
            retryableSandboxRecoveryPending = false;
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

        if (toolName === "compact_context" && result.ok && result.contextCompaction) {
          const assessment = this.assessContextCompaction({
            state,
            call,
            result,
            sourceEndMessageIndex: state.messages.length - 1,
            required: contextCompactionRequired,
            maxContextChars: options.maxContextChars,
            maxOutputChars: options.maxOutputChars,
          });
          result = assessment.result;
          acceptedContextCompaction = assessment.accepted;
        }

        const toolMessage: ChatMessage = {
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: resultForModel(result, options.maxOutputChars)
        };
        const toolResultEventId = createId("event");
        const verificationIntent = commandVerificationIntent(
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
          verificationIntent &&
          (toolName === "run_command" || toolName === "start_command") &&
          typeof progressCommandData?.commandId === "string"
        ) {
          progressVerificationCommands.add(progressCommandData.commandId);
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
          verificationIntent,
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
              message: toolMessage,
              progressObservation,
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
        state.progressGuard = foldProgressObservation(
          state.progressGuard ?? createProgressGuardState(),
          progressObservation,
        ).state;
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
        if (
          toolName === "compact_context" &&
          result.ok &&
          result.contextCompaction &&
          acceptedContextCompaction
        ) {
          const compaction = this.dependencies.contextManager.applyModelCompaction(
            state,
            result.contextCompaction.summary,
            state.messages.length,
            {
              intentLedger: acceptedContextCompaction.intentLedger,
              metadata: acceptedContextCompaction.metadata,
            },
          );
          await this.dependencies.appendEvent({
            threadId: state.threadId,
            turnId,
            stepId: `step_${step}`,
            type: "context.compacted",
            phase: "completed",
            payload: {
              summary: state.workingSummary,
              compactedMessageCount: compaction.compactedMessageCount,
              summaryChars: compaction.summaryChars,
              contextIntentLedger: state.contextIntentLedger,
              contextCompactionMetadata: state.contextCompactionMetadata,
            },
          });
          this.dependencies.onStatus?.(
            `Context compacted through ${compaction.compactedMessageCount} messages ` +
              `into ${compaction.summaryChars} characters.`,
          );
          if (!acceptedContextCompaction.benefit.safeWaterlineReached) {
            this.dependencies.onStatus?.(
              `Compaction succeeded but remains above the 55% headroom target ` +
                `(${contextUtilizationPercent(
                  acceptedContextCompaction.benefit.postCompactionUtilization,
                )}%).`,
            );
          }
          successfulContextCompaction = true;
          contextCompactionCorrectionIssued = false;
          forcedContextCompactionRequestActive = false;
        }
        if (toolName === "manage_memory" && result.ok && result.memoryMutation) {
          memoryContext.mutations.push(result.memoryMutation);
        }
        if (toolName === "manage_memory" && result.ok) {
          successfulMemoryToolCall = true;
        }
        await this.dependencies.onToolCompleted?.(state, call.function.name, result);
      }

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
        if (step === stepLimit) stepLimit += 1;
        continue;
      }

      if (
        backgroundCommandFinalizationRejected &&
        step === stepLimit &&
        !backgroundCommandFinalizationAllowanceGranted
      ) {
        stepLimit += BACKGROUND_COMMAND_FINALIZATION_STEP_ALLOWANCE;
        backgroundCommandFinalizationAllowanceGranted = true;
        this.dependencies.onStatus?.(
          "Reserved one correction step to finalize the running command.",
        );
      }

      if (sandboxPauseRequested && state.taskGraph?.status === "active") {
        const pausedText = sandboxPauseText();
        if (await this.takeAndApplySteering(
          state,
          turnId,
          "before_final",
          turnImages,
          true,
          memoryContext,
        )) {
          if (step === stepLimit) stepLimit += 1;
          continue;
        }
        this.dependencies.onText?.(pausedText);
        return this.finish(
          state,
          turnId,
          pausedText,
          "blocked",
          step,
          memoryContext,
        );
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

      if (contextCompactionRequired && !successfulContextCompaction) {
        if (!contextCompactionCorrectionIssued) {
          await this.appendContextCompactionRequest({
            state,
            turnId,
            step,
            utilization: contextUtilization,
            correction: true,
          });
          contextCompactionCorrectionIssued = true;
          if (
            step === stepLimit &&
            !contextCompactionCorrectionAllowanceGranted
          ) {
            stepLimit += CONTEXT_COMPACTION_STEP_ALLOWANCE;
            contextCompactionCorrectionAllowanceGranted = true;
            this.dependencies.onStatus?.(
              "Reserved one correction step for required context compaction.",
            );
          }
          this.dependencies.onStatus?.(
            "The model violated the required compaction protocol; requesting one correction.",
          );
          continue;
        }
        return this.finish(
          state,
          turnId,
          "The model did not complete the required context compaction.",
          "failed",
          step,
          memoryContext,
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
          if (step === stepLimit) stepLimit += 1;
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
        successfulContextCompaction &&
        contextCompactionRequired &&
        step === stepLimit &&
        !contextCompactionContinuationAllowanceGranted
      ) {
        stepLimit += CONTEXT_COMPACTION_STEP_ALLOWANCE;
        contextCompactionContinuationAllowanceGranted = true;
        this.dependencies.onStatus?.(
          "Reserved one continuation step after required context compaction.",
        );
      }
      if (
        successfulMemoryToolCall &&
        step === stepLimit &&
        !memoryFinalizationAllowanceGranted
      ) {
        stepLimit += MEMORY_FINALIZATION_STEP_ALLOWANCE;
        memoryFinalizationAllowanceGranted = true;
        this.dependencies.onStatus?.(
          `Reserved ${MEMORY_FINALIZATION_STEP_ALLOWANCE} finalization step(s) after memory maintenance.`,
        );
      }
      if (
        state.taskGraph &&
        (state.taskGraph.status === "completed" || state.taskGraph.status === "blocked") &&
        state.taskGraph.updatedByTurnId === turnId &&
        step === stepLimit &&
        !taskDagFinalResponseAllowanceGranted
      ) {
        stepLimit += TASK_DAG_FINAL_RESPONSE_STEP_ALLOWANCE;
        taskDagFinalResponseAllowanceGranted = true;
        taskDagFinalizationOnly = true;
        this.dependencies.onStatus?.(
          "Reserved one final response step after the task DAG reached a terminal state.",
        );
      }
    }

    return this.finish(
      state,
      turnId,
      `Reached the maximum of ${stepLimit} steps before the task could be confirmed complete.`,
      "limit_reached",
      stepLimit,
      memoryContext,
    );
    } catch (error) {
      const interrupted = Boolean(options.signal?.aborted);
      const message = error instanceof Error ? error.message : String(error);
      const result: AgentRunResult = {
        text: interrupted ? "The task was interrupted by the user." : `Agent run failed: ${message}`,
        reason: interrupted ? "interrupted" : "failed",
        steps: 0,
        threadId: state.threadId,
        turnId
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
          );
        } catch {
          state.activeTurnId = undefined;
          state.updatedAt = new Date().toISOString();
        }
      }
      return result;
    }
  }

  /**
   * Auto must satisfy mandatory context pressure before its controller can
   * choose Plan, Code, or a direct response. This is a control-plane phase,
   * not a permanent Code selection: after compaction the original current
   * request is replayed into active context and normal Auto routing resumes.
   */
  private async compactBeforeAutoRoute(
    state: SessionState,
    turnId: string,
    currentUserMessage: Extract<ChatMessage, { role: "user" }>,
    inputImages: ImageAttachment[],
    memoryContext: { userInput: string },
    options: AgentRunOptions,
  ): Promise<void> {
    const compactTool = this.dependencies.tools.find(
      (tool) => tool.name === "compact_context",
    );
    if (!compactTool) {
      throw new Error(
        "Context compaction is required before Auto routing, but compact_context is unavailable.",
      );
    }
    const progressResponseBase =
      state.progressGuard?.lastObservedResponseOrdinal ?? 0;

    const appendToolResult = async (
      call: NonNullable<Extract<ChatMessage, { role: "assistant" }>["tool_calls"]>[number],
      result: ToolExecutionResult,
      attempt: number,
    ): Promise<void> => {
      const toolMessage: Extract<ChatMessage, { role: "tool" }> = {
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: resultForModel(result, options.maxOutputChars),
      };
      const eventId = createId("event");
      const progressObservation = observeToolResult({
        sourceEventId: eventId,
        sourceCallId: call.id,
        scopeKey: progressScopeKey(state, turnId),
        responseOrdinal: progressResponseOrdinal(progressResponseBase, attempt),
        tool: call.function.name,
        result,
        verificationIntent: false,
      });
      await this.dependencies.appendEvent({
        eventId,
        threadId: state.threadId,
        turnId,
        stepId: `auto_compaction_${attempt}`,
        type: "tool.result",
        phase: result.ok ? "completed" : "failed",
        payload: {
          callId: call.id,
          tool: call.function.name,
          message: toolMessage,
          progressObservation,
        },
      });
      state.progressGuard = foldProgressObservation(
        state.progressGuard ?? createProgressGuardState(),
        progressObservation,
      ).state;
      state.messages.push(toolMessage);
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.takeAndApplySteering(
        state,
        turnId,
        "before_model",
        inputImages,
        false,
        memoryContext,
      );
      const inspection = this.dependencies.contextManager.inspect(
        state,
        options.maxContextChars,
      );
      const utilization = inspection.utilization;
      const pressure = inspection.pressure;
      if (attempt === 1 && pressure === "force") {
        await this.appendContextCompactionRequest({
          state,
          turnId,
          step: 0,
          utilization,
          correction: false,
        });
      }
      const baseSystemPrompt = await this.dependencies.buildSystemPrompt({
        mode: "auto",
        workspaceSummary: "",
        memories: [],
        workingCheckpoint: renderPinnedCurrentState(state),
        toolNames: ["compact_context"],
      });
      const pressureInstruction = contextPressureInstruction(
        pressure === "normal" || pressure === "suggest" ? "require" : pressure,
        utilization,
      );
      const messages = this.dependencies.contextManager.build({
        systemPrompt:
          `${baseSystemPrompt}\n\n${pressureInstruction}\n\n` +
          compactionSourceInventory(state),
        state,
        maxContextChars: options.maxContextChars,
      });
      this.observeProviderContext({
        state,
        turnId,
        step: 0,
        attempt,
        purpose: "context_compaction",
        messages,
        tools: [compactTool.definition],
        enforcedPressure:
          pressure === "normal" || pressure === "suggest" ? "require" : pressure,
        enforcedUtilization: utilization,
        maxContextChars: options.maxContextChars,
      });
      this.dependencies.onStatus?.(
        `Pre-route context compaction ${attempt}/2: requesting ${this.dependencies.provider.model}`,
      );

      let response;
      try {
        const attempted = await this.runProviderAttempt(
          options.signal,
          (attemptSignal) => this.withModelRequestActivity(
            `Waiting for ${this.dependencies.provider.model} response`,
            () => this.dependencies.provider.complete({
              messages,
              currentTurnImageIds: inputImages.map((image) => image.id),
              tools: [compactTool.definition],
              signal: attemptSignal,
              thinkingEffort: state.thinkingEffort,
            }),
          ),
        );
        if (attempted.kind === "steering_interrupted") {
          await this.takeAndApplySteering(
            state,
            turnId,
            "after_model",
            inputImages,
            false,
            memoryContext,
          );
          attempt -= 1;
          continue;
        }
        response = attempted.value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `auto_compaction_${attempt}`,
          type: "model.error",
          phase: "failed",
          payload: { message },
        });
        throw error;
      }
      if (await this.takeAndApplySteering(
        state,
        turnId,
        "after_model",
        inputImages,
        false,
        memoryContext,
      )) {
        attempt -= 1;
        continue;
      }
      await this.reportModelUsage(
        state,
        turnId,
        "context_compaction",
        response.usage,
        { attempt, retry: attempt > 1 },
      );

      const assistantMessage: Extract<ChatMessage, { role: "assistant" }> = {
        role: "assistant",
        content: response.message.content,
        tool_calls: response.message.tool_calls?.map(durableToolCall),
        reasoning_content: response.message.reasoning_content,
      };
      state.messages.push(assistantMessage);
      await this.dependencies.appendEvent({
        threadId: state.threadId,
        turnId,
        stepId: `auto_compaction_${attempt}`,
        type: "message.assistant",
        phase: "completed",
        payload: assistantMessage,
      });
      if (
        state.thinkingEffort !== "none" &&
        response.message.reasoning_content?.trim()
      ) {
        try {
          this.dependencies.onReasoning?.({
            type: "reasoning",
            text: response.message.reasoning_content,
            threadId: state.threadId,
            turnId,
            step: 0,
            provider: this.dependencies.provider.name,
            model: this.dependencies.provider.model,
            thinkingEffort: state.thinkingEffort,
          });
        } catch {
          // Presentation is transient; the assistant message remains durable.
        }
      }

      // The raw calls remain local to this attempt. coverageCheck and the
      // proposed intentLedger are validated below but never become part of the
      // assistant/tool.call event or recovered message.
      const calls = response.message.tool_calls ?? [];
      const validExclusiveCall =
        calls.length === 1 && calls[0]?.function.name === "compact_context";
      let compactionResult: ToolExecutionResult | undefined;
      let acceptedCompaction: AcceptedContextCompaction | undefined;
      const replayMessage: Extract<ChatMessage, { role: "user" }> = {
        role: "user",
        content: currentUserMessage.content,
        ...(currentUserMessage.images?.length
          ? { images: [...currentUserMessage.images] }
          : {}),
      };
      if (validExclusiveCall) {
        const call = calls[0];
        if (!call) throw new Error("The context compaction call disappeared");
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `auto_compaction_${attempt}`,
          type: "tool.call",
          phase: "requested",
          payload: durableToolCall(call),
        });
        try {
          compactionResult = await compactTool.execute(
            safeJsonParse(call.function.arguments),
            {
              workspaceRoot: state.workspaceRoot,
              mode: "code",
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
              agentRole: "main_agent",
              thinkingEffort: state.thinkingEffort,
              provider: state.provider,
              model: state.model,
              toolCallId: call.id,
            },
          );
        } catch (error) {
          compactionResult = {
            ok: false,
            summary: "Tool compact_context failed.",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        const assessment = this.assessContextCompaction({
          state,
          call,
          result: compactionResult,
          sourceEndMessageIndex: state.messages.length - 1,
          retainedTail: [replayMessage],
          required: true,
          maxContextChars: options.maxContextChars,
          maxOutputChars: options.maxOutputChars,
        });
        compactionResult = assessment.result;
        acceptedCompaction = assessment.accepted;
        await appendToolResult(call, compactionResult, attempt);
      } else {
        for (const call of calls) {
          await this.dependencies.appendEvent({
            threadId: state.threadId,
            turnId,
            stepId: `auto_compaction_${attempt}`,
            type: "tool.call",
            phase: "requested",
            payload: durableToolCall(call),
          });
          await appendToolResult(
            call,
            {
              ok: false,
              summary:
                "Pre-route context compaction requires exactly one compact_context call.",
              error: "context_compaction_must_be_exclusive",
            },
            attempt,
          );
        }
      }

      if (
        compactionResult?.ok &&
        compactionResult.contextCompaction &&
        acceptedCompaction
      ) {
        const compactedMessageCount = state.messages.length;
        // Persist the replay before advancing the compaction boundary so a
        // crash can never durably compact away the active request without
        // also retaining its text and image references.
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `auto_compaction_${attempt}`,
          type: "message.user.synthetic",
          phase: "completed",
          payload: replayMessage,
        });
        state.messages.push(replayMessage);
        const compaction = this.dependencies.contextManager.applyModelCompaction(
          state,
          compactionResult.contextCompaction.summary,
          compactedMessageCount,
          {
            intentLedger: acceptedCompaction.intentLedger,
            metadata: acceptedCompaction.metadata,
          },
        );
        await this.dependencies.appendEvent({
          threadId: state.threadId,
          turnId,
          stepId: `auto_compaction_${attempt}`,
          type: "context.compacted",
          phase: "completed",
          payload: {
            summary: state.workingSummary,
            compactedMessageCount: compaction.compactedMessageCount,
            summaryChars: compaction.summaryChars,
            contextIntentLedger: state.contextIntentLedger,
            contextCompactionMetadata: state.contextCompactionMetadata,
          },
        });
        await this.dependencies.onToolCompleted?.(
          state,
          "compact_context",
          compactionResult,
        );
        this.dependencies.onStatus?.(
          `Context compacted before Auto routing through ${compaction.compactedMessageCount} messages ` +
            `into ${compaction.summaryChars} characters.`,
        );
        if (!acceptedCompaction.benefit.safeWaterlineReached) {
          this.dependencies.onStatus?.(
            `Pre-route compaction remains above the 55% headroom target ` +
              `(${contextUtilizationPercent(
                acceptedCompaction.benefit.postCompactionUtilization,
              )}%).`,
          );
        }
        const remainingPressure = this.dependencies.contextManager
          .inspect(state, options.maxContextChars).pressure;
        if (remainingPressure === "require" || remainingPressure === "force") {
          throw new Error(
            "The active request still exceeds the mandatory context limit after compaction. Increase max_context_chars or shorten the request.",
          );
        }
        return;
      }

      if (attempt < 2) {
        await this.appendContextCompactionRequest({
          state,
          turnId,
          step: 0,
          utilization,
          correction: true,
        });
      }
    }

    throw new Error(
      "The model did not complete the required context compaction before Auto routing.",
    );
  }

  private async appendContextCompactionRequest(input: {
    state: SessionState;
    turnId: string;
    step: number;
    utilization: number;
    correction: boolean;
  }): Promise<void> {
    const percent = contextUtilizationPercent(input.utilization);
    const request: Extract<ChatMessage, { role: "user" }> = {
      role: "user",
      content: input.correction
        ? renderRuntimePrompt(
            "runtime/context-compaction-correction.md",
            { percent },
          )
        : renderRuntimePrompt(
            "runtime/context-compaction-force-request.md",
            { percent },
          ),
    };
    input.state.messages.push(request);
    await this.dependencies.appendEvent({
      threadId: input.state.threadId,
      turnId: input.turnId,
      stepId: `step_${input.step}`,
      type: "message.user.synthetic",
      phase: "completed",
      payload: request,
    });
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
    };
    if (
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      Boolean(lastMessage.tool_calls?.length) ||
      !lastMessage.content?.trim()
    ) {
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
