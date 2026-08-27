export type AgentMode = "plan" | "auto" | "code";
export type ProviderName = "qwen" | "deepseek";
export type ApprovalPolicyName = "safe" | "ask" | "never";

export type ToolName =
  | "read_file"
  | "create_file"
  | "update_file"
  | "run_command";

export interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
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
}

export interface ProviderResponse {
  message: Extract<ChatMessage, { role: "assistant" }>;
  usage?: ProviderUsage;
  finishReason?: string | null;
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
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
  timeoutMs: number;
  maxRetries: number;
}

export interface EasyCodeConfig {
  provider: ProviderName;
  mode: AgentMode;
  approvalPolicy: ApprovalPolicyName;
  workspaceRoot: string;
  dataDir: string;
  configDir: string;
  cacheDir: string;
  maxSteps: number;
  maxContextChars: number;
  maxOutputChars: number;
  commandTimeoutMs: number;
  qwen: ProviderConfig;
  deepseek: ProviderConfig;
}

export interface ToolExecutionResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
  /** Local-only terminal presentation. AgentRuntime deliberately excludes it from model messages and events. */
  presentation?: ToolPresentation;
}

export interface FileDiffPresentation {
  type: "file_diff";
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
  commandPreview?: string;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

export interface ToolContext {
  workspaceRoot: string;
  mode: AgentMode;
  threadId: string;
  turnId: string;
  approvalPolicy: ApprovalPolicyName;
  requestApproval: ApprovalHandler;
  signal?: AbortSignal;
  commandTimeoutMs: number;
  maxOutputChars: number;
  recordCommand?: (entry: CommandAuditEntry) => void;
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
  operation: "create" | "update" | "generated" | "deleted_by_command";
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
  status: "exited" | "timed_out" | "canceled" | "spawn_failed" | "policy_denied";
  exitCode: number | null;
  durationMs: number;
  timestamp: string;
  summary: string;
}

export interface SessionState {
  threadId: string;
  activeTurnId?: string;
  mode: AgentMode;
  provider: ProviderName;
  model: string;
  workspaceRoot: string;
  goal?: string;
  constraints: string[];
  messages: ChatMessage[];
  filesRead: Map<string, FileVersion>;
  changes: FileChangeRecord[];
  commands: CommandAuditEntry[];
  workingSummary: string;
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
  category: "preference" | "convention" | "architecture" | "decision" | "environment";
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
}
