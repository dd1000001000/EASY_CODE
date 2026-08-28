import type {
  ProviderName,
  SubagentTaskReport,
  ThinkingEffort,
  ToolContext,
  ToolExecutionResult,
} from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";

export type { SubagentTaskReport } from "../core/types.js";

export const MAX_SUBAGENT_INSTRUCTIONS_CHARS = 6_000;
export const MAX_SUBAGENT_FOLLOW_UP_CHARS = 4_000;
export const MAX_SUBAGENT_STOP_REASON_CHARS = 1_000;
export const MAX_SUBAGENT_SUMMARY_CHARS = 6_000;
export const MAX_SUBAGENT_EVIDENCE_CHARS = 1_000;
export const MAX_SUBAGENT_AGENT_IDS_PER_CALL = 8;
export const MAX_SUBAGENT_WAIT_MS = 60_000;
export const DEFAULT_SUBAGENT_WAIT_MS = 30_000;

const UNSAFE_SUBAGENT_TEXT =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/gu;
const TERMINAL_ESCAPE_SEQUENCE =
  /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/gu;

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

export type SubagentStatus =
  | "running"
  | "stopping"
  | "completed"
  | "blocked"
  | "failed"
  | "stopped"
  | "interrupted";

export interface StandaloneSubagentTask {
  title: string;
  description: string;
  completionChecks: string[];
}

export type SpawnSubagentRequest =
  | {
      action: "spawn";
      taskId: string;
      task?: never;
      instructions: string;
    }
  | {
      action: "spawn";
      taskId?: never;
      task: StandaloneSubagentTask;
      instructions: string;
    };

export interface SubagentStatusRequest {
  action: "status";
  agentIds?: string[];
}

export interface WaitForSubagentsRequest {
  action: "wait";
  agentIds: string[];
  timeoutMs: number;
}

export interface FollowUpSubagentRequest {
  action: "follow_up";
  agentId: string;
  message: string;
}

export interface StopSubagentRequest {
  action: "stop";
  agentId: string;
  reason: string;
}

export type ManageSubagentsInput =
  | SpawnSubagentRequest
  | SubagentStatusRequest
  | WaitForSubagentsRequest
  | FollowUpSubagentRequest
  | StopSubagentRequest;

export type SubagentTaskResult = SubagentTaskReport;

export interface SubagentRecord {
  id: string;
  parentThreadId: string;
  createdByTurnId: string;
  assignmentKind: "dag" | "standalone";
  taskGraphId?: string;
  taskId: string;
  /** Stable display name copied from the authoritative assignment at spawn time. */
  taskTitle: string;
  mode: "code";
  provider: ProviderName;
  model: string;
  thinkingEffort: ThinkingEffort;
  status: SubagentStatus;
  revision: number;
  instructions: string;
  followUpCount: number;
  result?: SubagentTaskResult;
  error?: string;
  resultObservedAt?: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/** Bounded, user-facing snapshot. Private child prompts and context stay isolated. */
export interface SubagentView {
  id: string;
  assignmentKind: "dag" | "standalone";
  taskGraphId?: string;
  taskId: string;
  taskTitle: string;
  mode: "code";
  provider: ProviderName;
  model: string;
  thinkingEffort: ThinkingEffort;
  status: SubagentStatus;
  revision: number;
  followUpCount: number;
  result?: SubagentTaskResult;
  error?: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  resultObservedAt?: string;
}

/**
 * Runtime-owned control plane injected into the model-facing tool. Implementations
 * remain responsible for main-agent authorization, task binding, dynamic
 * concurrency, persistence, and lifecycle transitions.
 */
export interface SubagentControl {
  assertAuthorized(context: ToolContext): void | Promise<void>;
  spawn(
    request: SpawnSubagentRequest,
    context: ToolContext,
  ): Promise<ToolExecutionResult>;
  status(
    request: SubagentStatusRequest,
    context: ToolContext,
  ): Promise<ToolExecutionResult>;
  wait(
    request: WaitForSubagentsRequest,
    context: ToolContext,
  ): Promise<ToolExecutionResult>;
  followUp(
    request: FollowUpSubagentRequest,
    context: ToolContext,
  ): Promise<ToolExecutionResult>;
  stop(
    request: StopSubagentRequest,
    context: ToolContext,
  ): Promise<ToolExecutionResult>;
}

export type SubagentTaskReportExecutionResult = ToolExecutionResult;
