import type { PromptBundleBinding } from "../prompt-bundle/types.js";
export type { PromptBundleBinding } from "../prompt-bundle/types.js";

export type AgentMode = "plan" | "auto" | "code";
export type AgentRole = "main_agent" | "subagent";
export type ProviderName = "qwen" | "deepseek" | "glm";
export type ApprovalPolicyName = "safe" | "ask" | "never";
/** Process-local command posture selected by the user from /approval. */
export type CommandExecutionMode = "manual" | "auto_approve" | "unrestricted";
export const THINKING_EFFORTS = ["none", "low", "medium", "high"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = "medium";

export type ToolName =
  | "select_mode"
  | "propose_plan"
  | "read_file"
  | "read_image"
  | "create_file"
  | "update_file"
  | "delete_file"
  | "run_command"
  | "manage_tasks"
  | "manage_subagents"
  | "submit_task_result"
  | "compact_context"
  | "manage_memory";

export interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type SupportedImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

/**
 * Durable metadata for an image copied into EASY CODE's private attachment store.
 * Image bytes are deliberately excluded so checkpoints, journals, and SQLite never
 * contain Base64 payloads.
 */
export interface ImageAttachment {
  id: string;
  label: string;
  mediaType: SupportedImageMediaType;
  storageKey: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  sourceName?: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: ImageAttachment[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: FunctionToolCall[];
      reasoning_content?: string | null;
    }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export interface ToolDefinition {
  type: "function";
  function: {
    name: ToolName;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Provider-reported prompt tokens served from cache, when available. */
  cachedInputTokens?: number;
  /** Provider-reported hidden reasoning tokens, when available. */
  reasoningTokens?: number;
}

export type ModelUsagePurpose =
  | "auto_route"
  | "agent_step"
  | "context_compaction";

/** Durable accounting metadata for one completed provider response. */
export interface ModelUsageRecord {
  actor: AgentRole;
  purpose: ModelUsagePurpose;
  provider: ProviderName;
  model: string;
  turnId: string;
  step?: number;
  attempt?: number;
  retry: boolean;
  usage?: ProviderUsage;
  sourceAgentId?: string;
  sourceTaskId?: string;
}

export interface ProviderResponse {
  message: Extract<ChatMessage, { role: "assistant" }>;
  usage?: ProviderUsage;
  finishReason?: string | null;
}

/**
 * Ephemeral UI notification for reasoning returned by a main agent request.
 * The text remains durably represented only by the matching assistant
 * ChatMessage; consumers must not persist this notification as a second copy.
 */
export interface AgentReasoningNotification {
  readonly type: "reasoning";
  readonly text: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly step: number;
  readonly provider: ProviderName;
  readonly model: string;
  readonly thinkingEffort: Exclude<ThinkingEffort, "none">;
}

export interface ModelRequest {
  messages: ChatMessage[];
  /**
   * Image IDs introduced by the active turn. Providers use this boundary to
   * keep current input validation strict while safely omitting older images
   * that are incompatible after a provider or model switch.
   */
  currentTurnImageIds?: readonly string[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** User-selected normalized effort; unsupported provider/model combinations ignore it. */
  thinkingEffort?: ThinkingEffort;
}

export interface ModelProvider {
  readonly name: ProviderName;
  readonly model: string;
  complete(request: ModelRequest): Promise<ProviderResponse>;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  /** Optional exact timeout override; defaults otherwise depend on thinking effort. */
  timeoutMs?: number;
  maxRetries: number;
}

export interface EasyCodeConfig {
  provider: ProviderName;
  mode: AgentMode;
  thinkingEffort: ThinkingEffort;
  approvalPolicy: ApprovalPolicyName;
  workspaceRoot: string;
  dataDir: string;
  configDir: string;
  cacheDir: string;
  /** Base step budget for none/low thinking; higher efforts derive their budget from this value. */
  maxSteps: number;
  /** Base context-character budget for none/low thinking; higher efforts derive their budget from this value. */
  maxContextChars: number;
  maxOutputChars: number;
  commandTimeoutMs: number;
  /** Default child checkout selection; individual spawn calls may narrow it. */
  subagentIsolation: SubagentIsolationMode;
  /** Git baseline used when a managed child has no DAG dependency artifact. */
  worktreeBaseMode: WorktreeBaseMode;
  /** Trusted manager-owned root, always resolved outside model control. */
  worktreeRoot: string;
  /** Retention target for completed managed child environments. */
  maxManagedWorktrees: number;
  qwen: ProviderConfig;
  deepseek: ProviderConfig;
  glm: ProviderConfig;
}

export interface ToolExecutionResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
  /** Local-only terminal presentation. AgentRuntime deliberately excludes it from model messages and events. */
  presentation?: ToolPresentation;
  /** Local-only context transition. AgentRuntime deliberately excludes the submitted summary from tool messages. */
  contextCompaction?: ContextCompactionRequest;
  /** Local-only durable-memory request, staged until the turn completes successfully. */
  memoryMutation?: MemoryMutationRequest;
  /** Runtime-owned task-DAG transition. It is persisted separately from model-visible data. */
  taskGraphUpdate?: TaskGraph;
  /** Runtime-only child assignment/completion transition paired with taskGraphUpdate. */
  subagentTaskOperation?: SubagentTaskUpdateOperation;
  /** Runtime-owned immutable binding for a child lifecycle transition. */
  subagentAssignment?: SubagentAssignmentSnapshot;
  /** Local-only lifecycle commit performed only after the matching DAG event is durable. */
  subagentLifecycle?: SubagentLifecycleUpdate;
  /** Child-only terminal result. It is never copied verbatim into a child tool message. */
  subagentTaskReport?: SubagentTaskReport;
  /** Structured Plan-mode proposal. Runtime assigns its durable identity and review revision. */
  planProposal?: PlanDraft;
  /**
   * Local image references that Runtime promotes into a synthetic multimodal user
   * message after all matching textual tool results have been appended.
   */
  imageAttachments?: ImageAttachment[];
}

export interface ContextCompactionRequest {
  summary: string;
}

export type LongTermMemoryCategory =
  | "preference"
  | "convention"
  | "architecture"
  | "decision"
  | "environment";

export const MAX_MEMORY_MUTATIONS_PER_TURN = 8;

export type MemoryMutationRequest =
  | {
      action: "remember";
      category: LongTermMemoryCategory;
      content: string;
      reason: string;
    }
  | {
      action: "revise";
      memoryId: string;
      category: LongTermMemoryCategory;
      content: string;
      reason: string;
    }
  | {
      action: "forget";
      memoryId: string;
      reason: string;
    };

export interface FileDiffPresentation {
  type: "file_diff";
  /** Explicit operation disambiguates empty-file creation from deletion. */
  operation?: "create" | "update" | "delete";
  path: string;
  before: string;
  after: string;
}

export type ToolPresentation = FileDiffPresentation;

export interface ApprovalRequest {
  id: string;
  title: string;
  description: string;
  risk: "read" | "workspace" | "install" | "system" | "external" | "destructive";
  /** Runtime-resolved executable identity; UIs must not derive this from the preview. */
  commandPrefix: string;
  commandPreview?: string;
}

export type ApprovalDecision = "allow_once" | "allow_prefix" | "reject";

/** Runtime boundary: the application resolves any interactive choice to allow/deny. */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

export interface ToolContext {
  workspaceRoot: string;
  mode: AgentMode;
  threadId: string;
  turnId: string;
  approvalPolicy: ApprovalPolicyName;
  /** Omitted by legacy callers; Runtime treats omission as the normal policy-controlled mode. */
  commandExecutionMode?: CommandExecutionMode;
  /**
   * Process-owned revocation check for unrestricted host access. A background
   * worker must not retain host authority after the user switches modes.
   */
  isUnrestrictedHostAccessActive?: () => boolean;
  /** Monotonic process epoch; host read-before-write grants never cross activations. */
  unrestrictedHostAccessEpoch?: () => number;
  requestApproval: ApprovalHandler;
  signal?: AbortSignal;
  commandTimeoutMs: number;
  maxOutputChars: number;
  /** Runtime-issued identity. Missing values are never accepted by subagent controls. */
  agentRole?: AgentRole;
  agentId?: string;
  assignedTaskId?: string;
  thinkingEffort?: ThinkingEffort;
  provider?: ProviderName;
  model?: string;
  toolCallId?: string;
  /** Read-only authoritative snapshot used by manage_tasks to propose one transition. */
  taskGraph?: Readonly<TaskGraph>;
  recordCommand?: (entry: CommandAuditEntry) => void;
  attachImage?: (input: {
    absolutePath: string;
    sourceName?: string;
  }) => Promise<ImageAttachment>;
}

export interface AgentTool {
  readonly name: ToolName;
  readonly definition: ToolDefinition;
  readonly mutating: boolean;
  execute(input: unknown, context: ToolContext): Promise<ToolExecutionResult>;
}

export interface FileVersion {
  path: string;
  hash: string;
  readAt: string;
}

export interface FileChangeRecord {
  path: string;
  operation: "create" | "update" | "delete" | "generated" | "deleted_by_command";
  beforeHash?: string;
  afterHash?: string;
  source: "file_tool" | "command";
  status: "applied" | "verified" | "conflict" | "failed" | "policy_violation";
  timestamp: string;
}

export interface CommandAuditEntry {
  id: string;
  program: string;
  args: string[];
  cwd: string;
  status:
    | "exited"
    | "timed_out"
    | "canceled"
    | "spawn_failed"
    | "policy_denied"
    | "sandbox_unavailable";
  exitCode: number | null;
  durationMs: number;
  timestamp: string;
  summary: string;
  /** Runtime attribution for commands executed by an isolated child worker. */
  sourceAgentRole?: AgentRole;
  sourceAgentId?: string;
  sourceTaskId?: string;
}

/** Model-selectable isolation preference for one child assignment. */
export type SubagentIsolationMode = "auto" | "shared" | "worktree";

/** Physical execution environment selected by Runtime after validating the repository. */
export type ExecutionEnvironmentKind = "shared" | "worktree";

export type ExecutionEnvironmentStatus =
  | "provisioning"
  | "ready"
  | "running"
  | "result_ready"
  | "conflicted"
  | "handed_off"
  | "retained"
  | "removed"
  | "failed";

export type WorktreeBaseMode = "fresh" | "head" | "current-snapshot";

/**
 * Durable binding between an agent session and its physical checkout. Paths are
 * local-only runtime data and are never copied into model-facing task text.
 */
export interface ExecutionEnvironmentSnapshot {
  id: string;
  /** Durable V2 identity binding; absent only on legacy environment records. */
  agentId?: string;
  parentThreadId?: string;
  childThreadId?: string;
  taskId?: string;
  kind: ExecutionEnvironmentKind;
  status: ExecutionEnvironmentStatus;
  logicalWorkspaceRoot: string;
  executionRoot: string;
  requestedIsolation: SubagentIsolationMode;
  baseMode: WorktreeBaseMode;
  repositoryRoot?: string;
  worktreeRoot?: string;
  baseCommit?: string;
  baselineCommit?: string;
  /** Root snapshot used to deliver the complete accumulated DAG result. */
  handoffBaseCommit?: string;
  resultCommit?: string;
  snapshotRef?: string;
  createdAt: string;
  updatedAt: string;
}

export type ResultArtifactStatus =
  | "ready"
  | "integrated"
  | "conflicted"
  | "delivered"
  | "retained";

/** Runtime-created code result. The model cannot invent or edit these fields. */
export interface ResultArtifact {
  id: string;
  agentId: string;
  taskId: string;
  environmentId: string;
  environmentKind: ExecutionEnvironmentKind;
  status: ResultArtifactStatus;
  logicalWorkspaceRoot: string;
  baseCommit?: string;
  resultCommit?: string;
  snapshotRef?: string;
  /** Optional on legacy artifacts; Runtime fills the DAG reference with an empty list. */
  parentArtifactIds?: string[];
  changedFiles: string[];
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  delivery?: "local" | "branch";
  branchName?: string;
}

/**
 * Bounded lineage metadata stored in the task DAG. The complete result artifact,
 * including its potentially large changed-file manifest and local workspace path,
 * remains in the private environment/thread stores.
 */
export interface ResultArtifactRef {
  id: string;
  agentId: string;
  taskId: string;
  environmentId: string;
  environmentKind: ExecutionEnvironmentKind;
  status: ResultArtifactStatus;
  baseCommit?: string;
  resultCommit?: string;
  snapshotRef?: string;
  parentArtifactIds: string[];
  changedFileCount: number;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
}

export type TaskNodeStatus = "pending" | "in_progress" | "completed" | "blocked";
export type TaskGraphStatus = "active" | "completed" | "blocked";

export interface TaskCompletionEvidence {
  check: string;
  evidence: string;
}

/** Runtime-only; models cannot invoke these transitions through manage_tasks. */
export type SubagentTaskUpdateOperation =
  | { action: "claim"; taskId: string; agentId: string }
  | {
      action: "complete";
      taskId: string;
      agentId: string;
      evidence: string[];
      resultArtifact?: ResultArtifactRef;
    }
  | { action: "release"; taskId: string; agentId: string };

export type SubagentTaskReport =
  | {
      taskId: string;
      outcome: "completed";
      summary: string;
      completionEvidence: TaskCompletionEvidence[];
    }
  | {
      taskId: string;
      outcome: "blocked";
      summary: string;
      blocker: string;
    };

interface SubagentAssignmentSnapshotBase {
  agentId: string;
  /** Present for durable child sessions; absent only on legacy journal events. */
  childThreadId?: string;
  /** Runtime-preallocated physical environment binding. */
  environmentId?: string;
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  completionChecks: string[];
  provider: ProviderName;
  model: string;
  thinkingEffort: ThinkingEffort;
  /** Present for worktree-aware assignments; legacy assignments imply shared. */
  requestedIsolation?: SubagentIsolationMode;
  createdAt: string;
}

/** Durable, Runtime-issued child binding. It never contains the child's private context. */
export type SubagentAssignmentSnapshot = SubagentAssignmentSnapshotBase &
  (
    | { kind: "dag"; taskGraphId: string }
    | { kind: "standalone"; taskGraphId?: never }
  );

export type SubagentLifecycleUpdate =
  | { action: "activate"; agentId: string }
  | { action: "observe"; agentId: string }
  | { action: "deliver_follow_up"; agentId: string; message: string }
  | { action: "request_stop"; agentId: string; reason: string };

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  inputs: string[];
  expectedArtifacts: string[];
  completionChecks: string[];
  failureHandling: string;
  owner: "main_agent" | "subagent";
  /** Runtime-assigned identity. Present exactly when owner is subagent. */
  assignedAgentId?: string;
  status: TaskNodeStatus;
  completionEvidence?: TaskCompletionEvidence[];
  /** Runtime-issued result accepted into the DAG lineage. */
  resultArtifact?: ResultArtifactRef;
  blocker?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskGraph {
  id: string;
  goal: string;
  status: TaskGraphStatus;
  createdByTurnId: string;
  updatedByTurnId: string;
  tasks: TaskNode[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanStepDraft {
  title: string;
  description: string;
  verification: string;
}

export interface PlanDraft {
  title: string;
  overview: string;
  steps: PlanStepDraft[];
}

export interface PlanProposal extends PlanDraft {
  id: string;
  revision: number;
  proposedByTurnId: string;
  proposedAt: string;
}

export interface PlanReviewState {
  status: "awaiting_review" | "approved_pending_execution";
  proposal: PlanProposal;
  feedback?: string;
  approvedAt?: string;
}

/** One independently persisted user follow-up targeting an active main turn. */
export interface TurnSteeringEntry {
  id: string;
  /** Monotonic per-Thread FIFO sequence assigned by ThreadStore. */
  sequence: number;
  /** Turn that was active when the user submitted this entry. */
  targetTurnId: string;
  message: Extract<ChatMessage, { role: "user" }>;
  queuedAt: string;
}

/** Exact pending prefix coalesced into one model-visible user message. */
export interface TurnSteeringBatch {
  entries: TurnSteeringEntry[];
  throughSequence: number;
  message: Extract<ChatMessage, { role: "user" }>;
}

export type TurnSteeringBoundary =
  | "before_model"
  | "after_model"
  | "between_tools"
  | "before_final";

export interface SessionState {
  threadId: string;
  activeTurnId?: string;
  mode: AgentMode;
  provider: ProviderName;
  model: string;
  thinkingEffort: ThinkingEffort;
  workspaceRoot: string;
  /** Exact trusted prompt/tool resource identity used for this session. */
  promptBundle?: PromptBundleBinding;
  goal?: string;
  constraints: string[];
  messages: ChatMessage[];
  filesRead: Map<string, FileVersion>;
  changes: FileChangeRecord[];
  commands: CommandAuditEntry[];
  /** Runtime-normalized executable identities approved for this Thread only. */
  commandApprovalPrefixes: string[];
  /** Optional model-created DAG for one complex objective; Runtime owns all transitions. */
  taskGraph?: TaskGraph;
  /** Runtime-owned proposal awaiting a user review or an already-approved execution turn. */
  planReview?: PlanReviewState;
  /** Event-authoritative main-turn steering inbox; legacy checkpoints omit it. */
  pendingSteering?: TurnSteeringEntry[];
  /** Highest sequence assigned to a durable steering entry. */
  steeringSequence?: number;
  /** Highest FIFO sequence durably applied to model context. */
  steeringWatermark?: number;
  /** Admission seal used to close the enqueue/final-response race. */
  steeringSealedTurnId?: string;
  workingSummary: string;
  /** Number of leading messages represented by workingSummary and omitted from future model requests. */
  compactedMessageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EventRecord {
  schemaVersion: number;
  eventId: string;
  threadId: string;
  turnId?: string;
  stepId?: string;
  sequence: number;
  timestamp: string;
  type: string;
  phase?: "requested" | "started" | "completed" | "failed" | "denied" | "interrupted";
  payload: unknown;
}

export interface LongTermMemory {
  id: string;
  workspaceId: string;
  category: LongTermMemoryCategory;
  content: string;
  confidence: number;
  status: "active" | "needs_verification" | "superseded" | "expired";
  evidence?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunResult {
  text: string;
  reason: "success" | "planned" | "needs_input" | "blocked" | "limit_reached" | "interrupted" | "failed";
  steps: number;
  threadId: string;
  turnId: string;
  /** Present only when propose_plan ended this turn for interactive review. */
  planProposal?: PlanProposal;
  /** Present only for an isolated child that used submit_task_result. */
  subagentTaskReport?: SubagentTaskReport;
}
