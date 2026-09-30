import { type ApiKeyCredentialStore } from "../config/credentials.js";
import type {
  AgentMode,
  ApprovalPolicyName,
  ImageAttachment,
  PlanProposal,
  ProviderName,
  ThinkingEffort,
} from "../core/types.js";
import { type ClipboardImageReader } from "../images/index.js";
import type { ProjectWorkspace } from "../projects/types.js";
import { TurnSteeringAttemptNotifier } from "../runtime/turn-steering-notifier.js";
import { type SandboxStartupService } from "../sandbox/startup.js";
import { WorkspaceMutationLock } from "../subagents/workspace-mutation-lock.js";
import { type ToolSource } from "../tools/catalog.js";
import type { ToolExecutionAuthorizer } from "../tools/execution-gateway.js";
import type { AppInteractionPort } from "../ui/interaction-port.js";
export interface EasyCodeAppOptions {
  workspaceRoot?: string;
  /** Host-owned logical project identity and active folder membership. */
  projectWorkspace?: ProjectWorkspace;
  provider?: ProviderName;
  model?: string;
  mode?: AgentMode;
  approvalPolicy?: ApprovalPolicyName;
  thinkingEffort?: ThinkingEffort;
  assumeYes?: boolean;
  /** Optional aggregate model-request limit for one non-interactive task. */
  maxModelRequests?: number;
  resumeThreadId?: string;
  startupInteraction?: "none" | "select-model" | "ensure-api-key";
  /** Run the retained-UI sandbox readiness guide before model selection. */
  sandboxStartup?: boolean;
  /** Dependency injection for sandbox startup tests. */
  sandboxStartupService?: SandboxStartupService;
  terminal?: AppInteractionPort;
  /** Share this lock between concurrent hosted Threads in one workspace. */
  workspaceMutationLock?: WorkspaceMutationLock;
  /** Web hosts reuse one interaction stream while switching workspace sessions. */
  keepInteractionOpen?: boolean;
  /** Dependency injection for isolated tests; false disables keyring reads. */
  credentialStore?: ApiKeyCredentialStore | false;
  /** Images queued before the first prompt; the option may be repeated by the CLI. */
  imagePaths?: readonly string[];
  /** Internal composition seam for future managed tool adapters such as MCP. */
  toolSourceFactories?: readonly ToolSourceFactory[];
  /** Host-owned approval bridge for effectful tools from those sources. */
  authorizeToolExecution?: ToolExecutionAuthorizer;
  /** Dependency injection for clipboard tests. */
  clipboardImageReader?: ClipboardImageReader;
}

export interface ToolSourceFactoryContext {
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly role: "main_agent" | "subagent";
  readonly agentId?: string;
  readonly assignedTaskId?: string;
}

export type ToolSourceFactory = (context: Readonly<ToolSourceFactoryContext>) => ToolSource | Promise<ToolSource>;

export interface ExecutePromptOptions {
  modeOverride?: "plan" | "code";
  approvedPlan?: Pick<PlanProposal, "id" | "revision">;
}

export interface ActiveTurnSteering {
  readonly threadId: string;
  readonly controller: AbortController;
  readonly notifier: TurnSteeringAttemptNotifier;
  readonly requestImages: readonly ImageAttachment[];
  readonly draftImages: Map<string, ImageAttachment>;
}
