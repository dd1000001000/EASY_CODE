import { type VerificationKind } from "../command/types.js";
import { type RuntimeLimits } from "../config/runtime-limits.js";
import { type ContextSearchHit } from "../context/artifact-index.js";
import {
  ContextManager,
  type ContextPressureLevel,
  type ProviderRequestContextInspection,
} from "../context/manager.js";
import { type CompactionProgress } from "../context/manual-compaction.js";
import { selectMemoryContext } from "../context/memory-controller.js";
import type { TokenCalibration } from "../context/token-calibration.js";
import {
  type AgentMode,
  type AgentReasoningNotification,
  type AgentRole,
  type AgentRunResult,
  type AgentTool,
  type ApprovalHandler,
  type ChatMessage,
  type CommandAuditEntry,
  type CommandExecutionMode,
  type EventRecord,
  type FunctionToolCall,
  type ImageAttachment,
  type LongTermMemory,
  type MemoryMutationRequest,
  type ModelProvider,
  type ModelUsagePurpose,
  type ModelUsageRecord,
  type PlanProposal,
  type PlanReviewState,
  type ProviderStreamEvent,
  type SessionState,
  type SubagentLifecycleUpdate,
  type SubagentTaskReport,
  type TaskGraph,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolName,
  type TurnSteeringBatch,
  type TurnSteeringBoundary,
} from "../core/types.js";
import type { LocalDecisionResult, LocalDecisionTask } from "../local-decision/client.js";
import { type ToolCatalogSnapshot } from "../tools/catalog.js";
import { ToolExecutionGateway, type ToolExecutionAuthorizer } from "../tools/execution-gateway.js";
import { CommandRetryTracker } from "./command-retry.js";
import { ToolRecoveryBudget } from "./tool-recovery.js";
import type { TurnSteeringAttemptNotifier } from "./turn-steering-notifier.js";
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

export interface CommandVerificationClassification {
  readonly intent: boolean;
  readonly kind?: VerificationKind;
}

export interface RuntimeLayeredContext {
  workingCheckpoint?: string;
  retrievedThreadEvidence?: string;
  evidence?: readonly Readonly<ContextSearchHit>[];
}

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
  agentIdentity?: { role: "main_agent" } | { role: "subagent"; agentId: string; assignedTaskId: string };
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
    options?: {
      readonly limit?: number;
      readonly includeInactive?: boolean;
      readonly scope?: "all" | "global" | "project";
    },
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
  captureToolEvidence?: (
    state: Readonly<SessionState>,
    callId: string,
    tool: string,
    result: ToolExecutionResult,
  ) => string;
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
  runReviewSession?: (
    input: import("../review/application.js").WorkspaceReviewRequest,
  ) => Promise<import("../review/application.js").WorkspaceReviewResult>;
  /** Local choice model; errors fall back to the existing controller or delivery path. */
  localDecision?: (task: LocalDecisionTask, input: string, signal?: AbortSignal) => Promise<LocalDecisionResult>;
  recordLocalDecision?: (input: {
    id: string;
    threadId: string;
    turnId: string;
    decision: LocalDecisionResult;
    appliedDecision: string;
    challenged?: boolean;
    challengeAlreadyUsed?: boolean;
  }) => Promise<void>;
  recordLocalDecisionFallback?: (input: {
    id: string;
    threadId: string;
    turnId: string;
    task: LocalDecisionTask;
    input: string;
    reason: string;
  }) => Promise<void>;
  deliveryChallengeAlreadyUsed?: (threadId: string) => boolean;
  requestApproval: ApprovalHandler;
  /** Interactive main-agent hosts answer ask_user; subagents never receive it. */
  askUser?: import("../core/types.js").UserQuestionHandler;
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
    /** The journaled call, so presentation saved for it can be found from the transcript. */
    call?: { readonly turnId: string; readonly callId: string },
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
  onCompactionProgress?: (progress: CompactionProgress) => void;
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
  hasPendingSteering?: (input: { threadId: string; turnId: string }) => Promise<boolean>;
  /**
   * Atomic finalization gate. It either seals this turn or returns the durable
   * pending prefix that won the race and must be handled before finishing.
   */
  sealSteering?: (input: { threadId: string; turnId: string }) => Promise<TurnSteeringBatch | undefined>;
  /** Process-local wakeup only; ThreadStore remains the durable source of truth. */
  steeringNotifier?: TurnSteeringAttemptNotifier;
  onSteeringApplied?: (batch: Readonly<TurnSteeringBatch>, boundary: TurnSteeringBoundary) => void;
  attachImage?: (input: {
    threadId: string;
    label: string;
    absolutePath: string;
    sourceName?: string;
  }) => Promise<ImageAttachment>;
  discardImage?: (threadId: string, attachment: ImageAttachment) => Promise<void>;
  commitImages?: (threadId: string, attachments: readonly ImageAttachment[]) => Promise<void>;
}

export interface AgentUserInput {
  readonly text: string;
  readonly images?: readonly ImageAttachment[];
}

export interface AgentRunOptions {
  orchestrationEnabled?: boolean;
  isOrchestrationEnabled?: () => boolean;
  /** The model's token window, resolved by the host; omit to measure context in characters. */
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

export type AssistantToolCall = NonNullable<Extract<ChatMessage, { role: "assistant" }>["tool_calls"]>[number];

/** The runtime identity a turn runs under (main agent unless a child runtime was configured). */
export type AgentIdentity = NonNullable<AgentRuntimeDependencies["agentIdentity"]>;

/** Per-turn memory bookkeeping threaded through the phases of AgentRuntime.run. */
export interface TurnMemoryContext {
  userInput: string;
  mutations: MemoryMutationRequest[];
  approvedPlanReview: PlanReviewState | undefined;
}

/** One AgentRuntime.run turn: the claimed user request and the state its phases share. */
export interface TurnRun {
  readonly state: SessionState;
  readonly options: AgentRunOptions;
  readonly turnId: string;
  readonly agentIdentity: AgentIdentity;
  readonly userInput: string;
  readonly userMessage: Extract<ChatMessage, { role: "user" }>;
  /** Images of this turn; steering can add more while the turn runs. */
  readonly turnImages: ImageAttachment[];
  /** Index of the user message in state.messages. */
  readonly turnHistoryStart: number;
  readonly memoryContext: TurnMemoryContext;
  /** Child assignments still open when the turn was routed (main agent only). */
  outstandingSubagentsAtRoute: readonly {
    id: string;
    assignmentKind: "dag" | "standalone";
    taskId: string;
    taskTitle: string;
    status: string;
  }[];
  effectiveMode: AgentMode;
}

/** Memory search and layered retrieval results reused across steps while their keys are unchanged. */
export interface StepRetrievalCache {
  memories: readonly Readonly<LongTermMemory>[];
  rememberedPhaseKey: string | undefined;
  rememberedQueryKey: string;
  retrievedCache: RuntimeLayeredContext | undefined;
  retrievedQueryKey: string;
}

/** A routed turn with its tool exposure bound; the step loop runs over this. */
export interface StepLoop extends TurnRun {
  readonly toolGateway: ToolExecutionGateway;
  /** Shared by reference: tool callbacks (attachImage) advance it from inside tool execution. */
  readonly imageNumbering: { next: number };
  readonly progressResponseBase: number;
  readonly progressVerificationCommands: Map<string, VerificationKind>;
  readonly toolRecovery: ToolRecoveryBudget;
  readonly commandRetries: CommandRetryTracker;
  readonly retrieval: StepRetrievalCache;
  invalidOutputAttempts: number;
}

/** Ends the turn. The value is passed through unawaited, exactly like `return this.finish(...)` in run. */
export type TurnReturn = { kind: "return"; value: AgentRunResult | Promise<AgentRunResult> };

/** How one step ends: move on to the next step, redo this one, or end the turn. */
export type StepOutcome = { kind: "continue" } | { kind: "retry" } | TurnReturn;

/** Values executeToolCalls reads from the enclosing step; see AgentRuntime.runToolBatch. */
export interface ToolCallsContext extends StepLoop {
  readonly calls: FunctionToolCall[];
  readonly ordinaryToolDefinitions: ToolDefinition[];
  readonly projectionHistory: ChatMessage[];
  readonly proposePlanBatched: boolean;
  readonly askUserBatched: boolean;
  readonly step: number;
  readonly stepImageAttachments: ImageAttachment[];
  readonly submitTaskResultBatched: boolean;
}

/** What executeToolCalls records while it runs a tool batch. */
export interface ToolCallsState {
  completedVerificationPhase: boolean;
  environmentFault: string | undefined;
  finishRejectedReason: string | undefined;
  proposedPlan: PlanProposal | undefined;
  /** ask_user closed without an answer: the request ends waiting for the user. */
  unansweredQuestions: ToolExecutionResult["unansweredQuestions"];
  requiredProtocolExhaustion: { tool: string; attempt: number } | undefined;
  steeringAppliedBetweenTools: boolean;
  submittedTaskReport: SubagentTaskReport | undefined;
}

/** Values handleTextResponse reads from the enclosing step; see AgentRuntime.runStep. */
export interface TextResponseContext extends TurnRun {
  readonly assistantMessage: ChatMessage;
  readonly calls: FunctionToolCall[];
  readonly step: number;
}

export type HandleTextResponseFlow = { kind: "next" } | { kind: "continue" } | TurnReturn;

/** Values settleToolBatch reads from the enclosing step; see AgentRuntime.runToolBatch. */
export interface ToolBatchOutcomeContext
  extends TurnRun, Readonly<Omit<ToolCallsState, "steeringAppliedBetweenTools">> {
  readonly step: number;
  readonly stepImageAttachments: ImageAttachment[];
}

/** Turn-local variables settleToolBatch updates; written back when it returns or throws. */
export interface ToolBatchOutcomeState {
  steeringAppliedBetweenTools: boolean;
}

export type SettleToolBatchFlow = { kind: "next" } | TurnReturn | { kind: "continue" };

export type PrepareStepRequestFlow =
  | {
      kind: "next";
      outputs: {
        stepRuntimeContext: string;
        selectedForStep: ReturnType<typeof selectMemoryContext> | undefined;
        ordinaryToolDefinitions: ToolDefinition[];
        enabledTools: AgentTool[];
        messages: ChatMessage[];
      };
    }
  | TurnReturn
  | { kind: "retry" };

/** The step request prepareStepRequest is assembling; its stages refine the mutable fields in order. */
export interface StepRequestDraft {
  readonly loop: StepLoop;
  readonly memoryLimits: Readonly<RuntimeLimits>;
  readonly workspaceSummary: string;
  readonly runtimeNextActions: readonly string[];
  readonly ordinaryEnabledTools: AgentTool[];
  layeredContext: RuntimeLayeredContext;
  optionalAllowance: number;
  selectedForStep: ReturnType<typeof selectMemoryContext> | undefined;
  selectedOptionalCount: number;
  memorySelectionInfo: Pick<ReturnType<typeof selectMemoryContext>, "estimatedTokens" | "dropped">;
  stepRuntimeContext: string;
}

/** A built step request and the pressure it was measured at. */
export interface StepRequestFit {
  readonly systemPrompt: string;
  messages: ChatMessage[];
  requestInspection: ReturnType<AgentRuntimeDependencies["contextManager"]["inspectProviderRequest"]>;
  readonly contextPressure: ReturnType<
    AgentRuntimeDependencies["contextManager"]["inspectProviderRequest"]
  >["pressure"];
  readonly contextUtilization: number;
}
