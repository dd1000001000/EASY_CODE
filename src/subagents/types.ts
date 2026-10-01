import type {
  ProviderName,
  ExecutionEnvironmentSnapshot,
  ResultArtifact,
  ResultArtifactRef,
  SubagentIsolationMode,
  SubagentTaskReport,
  ThinkingEffort,
  ToolContext,
  ToolExecutionResult,
} from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { DEFAULT_RUNTIME_LIMITS } from "../config/runtime-limits.js";
import { projectHeadTailText } from "../utils/bounded-text.js";

export type { SubagentTaskReport } from "../core/types.js";

export const MAX_SUBAGENT_INSTRUCTIONS_CHARS = DEFAULT_RUNTIME_LIMITS.subagentInstructionsMaxChars;
export const MAX_SUBAGENT_FOLLOW_UP_CHARS = DEFAULT_RUNTIME_LIMITS.subagentFollowUpMaxChars;
export const MAX_SUBAGENT_PARENT_MESSAGE_CHARS = DEFAULT_RUNTIME_LIMITS.subagentParentMessageMaxChars;
export const MAX_SUBAGENT_STOP_REASON_CHARS = 1_000;
export const MAX_SUBAGENT_SUMMARY_CHARS = DEFAULT_RUNTIME_LIMITS.subagentSummaryMaxChars;
export const MAX_SUBAGENT_EVIDENCE_CHARS = 1_000;
export const MAX_SUBAGENT_AGENT_IDS_PER_CALL = 8;
export const MAX_SUBAGENT_WAIT_MS = 60_000;

const UNSAFE_SUBAGENT_TEXT =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/gu;
const TERMINAL_ESCAPE_SEQUENCE = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/gu;

/** Keep useful line breaks while removing terminal controls, bidi spoofing, and secrets. */
export function sanitizeSubagentText(value: string): string {
  return redactSensitiveInformation(
    value
      .replace(/\r\n?/gu, "\n")
      .replace(TERMINAL_ESCAPE_SEQUENCE, " ")
      .replace(UNSAFE_SUBAGENT_TEXT, " ")
      .replace(/[ \t]+/gu, " ")
      .replace(/ *\n */gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
  );
}

/** Sanitize first, then retain both ends within the configured message length. */
export function truncateSubagentMessage(value: string, maximum: number): string {
  const sanitized = sanitizeSubagentText(value);
  return projectHeadTailText(sanitized, maximum).text;
}

export type SubagentStatus =
  "running" | "stopping" | "completed" | "blocked" | "needs_parent_decision" | "failed" | "stopped" | "interrupted";

export interface StandaloneSubagentTask {
  title: string;
  description: string;
  completionChecks: string[];
}

/** Exactly one of `taskId` (a dependency-ready DAG task) or `task` (a standalone assignment) is present. */
export interface SpawnSubagentRequest {
  /** User-facing display name; unique per parent Thread and never used for addressing. */
  name: string;
  taskId?: string;
  task?: StandaloneSubagentTask;
  instructions: string;
  isolation?: SubagentIsolationMode;
  thinkingEffort?: ThinkingEffort;
}

/** A bounded child report addressed to its Runtime-bound parent, not a new task instruction. */
export interface SubagentParentMessage {
  id: string;
  agentId: string;
  taskId: string;
  taskTitle: string;
  text: string;
  createdAt: string;
}

/** Omitted agentIds select every child of the parent; a zero timeout returns an immediate snapshot. */
export interface ObserveSubagentsRequest {
  agentIds?: string[];
  timeoutMs: number;
}

export interface FollowUpSubagentRequest {
  agentId: string;
  message: string;
}

export interface StopSubagentRequest {
  agentId: string;
  reason: string;
}

export interface HandoffSubagentRequest {
  agentId: string;
  destination: "local" | "branch";
  branchName?: string;
}

export interface SubagentRecord {
  id: string;
  /** User-facing name chosen at spawn; absent only for children recorded before names existed. */
  displayName?: string;
  childThreadId: string;
  environmentId: string;
  parentThreadId: string;
  createdByTurnId: string;
  assignmentKind: "dag" | "standalone";
  taskGraphId?: string;
  taskId: string;
  /** Stable display name copied from the authoritative assignment at spawn time. */
  taskTitle: string;
  mode: "plan" | "code";
  provider: ProviderName;
  model: string;
  thinkingEffort: ThinkingEffort;
  requestedIsolation: SubagentIsolationMode;
  environment?: ExecutionEnvironmentSnapshot;
  resultArtifact?: ResultArtifact;
  status: SubagentStatus;
  revision: number;
  instructions: string;
  followUpCount: number;
  result?: SubagentTaskReport;
  error?: string;
  resultObservedAt?: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/** Model/UI-safe execution state. Physical paths and private Git details stay Runtime-local. */
export type SubagentEnvironmentView = Pick<
  ExecutionEnvironmentSnapshot,
  "id" | "kind" | "status" | "requestedIsolation" | "baseMode" | "createdAt" | "updatedAt"
>;

/** Bounded public artifact metadata; the full changed-file manifest remains private. */
export interface SubagentArtifactView extends ResultArtifactRef {
  delivery?: "local" | "branch";
  branchName?: string;
}

/** Bounded, user-facing snapshot. Private child prompts and context stay isolated. */
export interface SubagentView {
  id: string;
  displayName?: string;
  childThreadId: string;
  environmentId: string;
  assignmentKind: "dag" | "standalone";
  taskGraphId?: string;
  taskId: string;
  taskTitle: string;
  mode: "plan" | "code";
  provider: ProviderName;
  model: string;
  thinkingEffort: ThinkingEffort;
  requestedIsolation: SubagentIsolationMode;
  environment?: SubagentEnvironmentView;
  resultArtifact?: SubagentArtifactView;
  status: SubagentStatus;
  /** Ephemeral live activity; durable child records remain the source of truth. */
  activity?: { kind: "working" | "thinking" | "tool"; label?: string; startedAt: string };
  revision: number;
  followUpCount: number;
  result?: SubagentTaskReport;
  error?: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  resultObservedAt?: string;
}

/**
 * Runtime-owned control plane injected into the model-facing subagent tools. Implementations
 * remain responsible for main-agent authorization, task binding, dynamic
 * concurrency, persistence, and lifecycle transitions.
 */
export interface SubagentControl {
  assertAuthorized(context: ToolContext): void | Promise<void>;
  spawn(request: SpawnSubagentRequest, context: ToolContext): Promise<ToolExecutionResult>;
  observe(request: ObserveSubagentsRequest, context: ToolContext): Promise<ToolExecutionResult>;
  followUp(request: FollowUpSubagentRequest, context: ToolContext): Promise<ToolExecutionResult>;
  stop(request: StopSubagentRequest, context: ToolContext): Promise<ToolExecutionResult>;
  handoff(request: HandoffSubagentRequest, context: ToolContext): Promise<ToolExecutionResult>;
}
