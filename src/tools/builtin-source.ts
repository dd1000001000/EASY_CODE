import type { AgentTool, TaskNode } from "../core/types.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { SubagentControl } from "../subagents/types.js";
import { CommandRuntime } from "../command/runtime.js";
import type { DownloadBroker } from "../downloads/broker.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import type { McpConfigStore } from "../mcp/config.js";
import { SkillStore } from "../skills/store.js";
import type { ThreadTitleStore } from "../threads/thread-title.js";
import type { ThreadDocumentService, ThreadResourceStore } from "../resources/index.js";
import {
  WorkspaceMutationLock,
  wrapAgentToolsWithWorkspaceMutationLock,
} from "../subagents/workspace-mutation-lock.js";
import type { ToolSource } from "./catalog.js";
import { AskUserTool } from "./ask-user.js";
import { bindBuiltinToolMetadata } from "./capabilities.js";
import { RecallContextTool, SearchContextTool } from "./context-read.js";
import { CreateFileTool } from "./create-file.js";
import { DeleteFileTool } from "./delete-file.js";
import { FetchArtifactTool } from "./fetch-artifact.js";
import { MemoryToolSession } from "./memory-tool-session.js";
import { ReadMemoryTool } from "./read-memory.js";
import { createSubagentTools } from "./subagent-tools.js";
import { ManageTasksTool } from "./manage-tasks.js";
import { NameThreadTool } from "./name-thread.js";
import {
  DisableMcpServerTool,
  ListMcpServersTool,
  RemoveMcpServerTool,
  SaveLocalMcpServerTool,
  SaveRemoteMcpServerTool,
} from "./mcp-config-tools.js";
import { ProposePlanTool } from "./propose-plan.js";
import { ReadFileTool } from "./read-file.js";
import { ReadDocumentTool } from "./read-document.js";
import { ReadImageTool } from "./read-image.js";
import { CancelCommandTool, PollCommandTool, RunCommandTool, StartCommandTool } from "./run-command.js";
import { SearchFilesTool } from "./search-files.js";
import { CreateSkillTool, DeleteSkillTool, ListSkillsTool, ModifySkillTool, ReadSkillTool } from "./skill-tools.js";
import { SubmitTaskResultTool } from "./submit-task-result.js";
import { SendParentMessageTool, type ParentMessageBinding } from "./send-parent-message.js";
import type { SubagentParentMessage } from "../subagents/types.js";
import { UpdateFileTool } from "./update-file.js";
import { WriteMemoryTool } from "./write-memory.js";
import { WebSearchTool } from "./web-search.js";
import { FetchWebpageTool } from "./fetch-webpage.js";
import type { WebpageReader } from "../resources/web-reader.js";
import type { CoordinationStore } from "../coordination/store.js";
import { FindFileEditorsTool, SendThreadMessageTool } from "./thread-coordination.js";

type BoundTask = Pick<TaskNode, "id" | "status" | "completionChecks"> & Pick<Partial<TaskNode>, "title">;

export interface BuiltinToolSourceOptions {
  readonly profile?: "benchmark";
  readonly coordination?: CoordinationStore;
  readonly workspace: WorkspaceManager;
  readonly memoryManager?: MemoryManager;
  readonly subagentControl?: SubagentControl;
  readonly commandRuntime?: CommandRuntime;
  readonly downloadBroker?: DownloadBroker;
  readonly limits?: Readonly<RuntimeLimits>;
  readonly mutationLock?: WorkspaceMutationLock;
  readonly mcpConfigStore?: McpConfigStore;
  readonly onMcpConfigChanged?: (id: string) => Promise<void>;
  readonly boundTask?: BoundTask;
  readonly parentMessage?: {
    binding: ParentMessageBinding;
    post: (
      message: Omit<SubagentParentMessage, "id" | "createdAt">,
      childThreadId: string,
      toolCallId: string,
    ) => SubagentParentMessage;
  };
  readonly threadTitleStore?: ThreadTitleStore;
  readonly skillStore?: SkillStore;
  readonly threadResourceStore?: ThreadResourceStore;
  readonly threadDocumentService?: ThreadDocumentService;
  readonly includePublicWebTools?: boolean;
  /** How fetch_webpage reads pages; shared so a Jina Reader rate-limit pause spans conversations. */
  readonly webpageReader?: WebpageReader;
  /** Offer ask_user: only an interactive main-agent session can answer it. */
  readonly userQuestions?: boolean;
}

/** Trusted in-process tools exposed through the same source contract as future adapters. */
export class BuiltinToolSource implements ToolSource {
  readonly id = "builtin";
  readonly kind = "builtin" as const;
  readonly priority = 0;
  private tools: readonly AgentTool[] | undefined;

  constructor(private readonly options: Readonly<BuiltinToolSourceOptions>) {}

  async listTools(): Promise<readonly AgentTool[]> {
    if (!this.tools) this.tools = Object.freeze(this.createTools());
    return this.tools;
  }

  private createTools(): AgentTool[] {
    const { workspace } = this.options;
    const memorySession = new MemoryToolSession();
    const skillStore = this.options.skillStore ?? new SkillStore(workspace.root);
    const commandRuntime =
      this.options.commandRuntime ??
      new CommandRuntime(workspace, undefined, undefined, undefined, {
        limits: this.options.limits,
      });
    const tools: AgentTool[] = [
      ...(this.options.coordination && this.options.limits?.coordinationEnabled !== false
        ? [
            new FindFileEditorsTool(workspace, this.options.coordination),
            new SendThreadMessageTool(this.options.coordination),
          ]
        : []),
      new ReadFileTool(workspace, this.options.threadResourceStore),
      ...(this.options.threadDocumentService
        ? [new ReadDocumentTool(workspace, this.options.threadDocumentService)]
        : []),
      new SearchFilesTool(workspace, this.options.threadResourceStore),
      new ListSkillsTool(workspace, skillStore),
      new ReadSkillTool(workspace, skillStore),
      new CreateSkillTool(workspace, skillStore),
      new ModifySkillTool(workspace, skillStore),
      new DeleteSkillTool(workspace, skillStore),
      new ReadImageTool(workspace),
      new CreateFileTool(workspace),
      new UpdateFileTool(workspace),
      new DeleteFileTool(workspace),
      new RunCommandTool(workspace, commandRuntime),
      new StartCommandTool(workspace, commandRuntime),
      new PollCommandTool(workspace, commandRuntime),
      new CancelCommandTool(workspace, commandRuntime),
      ...(this.options.downloadBroker ? [new FetchArtifactTool(this.options.downloadBroker)] : []),
      ...(this.options.includePublicWebTools !== false && this.options.threadResourceStore
        ? [new WebSearchTool(workspace)]
        : []),
      ...(this.options.includePublicWebTools !== false && this.options.threadDocumentService
        ? [new FetchWebpageTool(workspace, this.options.threadDocumentService, this.options.webpageReader)]
        : []),
      new ManageTasksTool(),
      ...(this.options.threadTitleStore ? [new NameThreadTool(this.options.threadTitleStore)] : []),
      ...(this.options.mcpConfigStore
        ? [
            new ListMcpServersTool(workspace, this.options.mcpConfigStore),
            new SaveLocalMcpServerTool(workspace, this.options.mcpConfigStore, this.options.onMcpConfigChanged),
            new SaveRemoteMcpServerTool(workspace, this.options.mcpConfigStore, this.options.onMcpConfigChanged),
            new DisableMcpServerTool(workspace, this.options.mcpConfigStore, this.options.onMcpConfigChanged),
            new RemoveMcpServerTool(workspace, this.options.mcpConfigStore, this.options.onMcpConfigChanged),
          ]
        : []),
      ...(this.options.subagentControl ? createSubagentTools(this.options.subagentControl, this.options.limits) : []),
      new ProposePlanTool(),
      ...(this.options.userQuestions ? [new AskUserTool(this.options.limits)] : []),
      new RecallContextTool(this.options.limits),
      new SearchContextTool(),
      new ReadMemoryTool(workspace, memorySession),
      ...(this.options.memoryManager
        ? [new WriteMemoryTool(this.options.memoryManager, workspace, memorySession)]
        : []),
      ...(this.options.boundTask ? [new SubmitTaskResultTool(this.options.boundTask, this.options.limits)] : []),
      ...(this.options.parentMessage
        ? [
            new SendParentMessageTool(
              this.options.parentMessage.binding,
              this.options.parentMessage.post,
              this.options.limits?.subagentParentMessageMaxChars,
            ),
          ]
        : []),
    ]
      .filter((tool) => this.options.profile !== "benchmark" || !BENCHMARK_DISABLED_TOOLS.has(tool.name))
      .map((tool) => {
        bindBuiltinToolMetadata(tool);
        if (tool.mutating) {
          const execute = tool.execute.bind(tool);
          tool.execute = (input, context) => {
            commandRuntime.assertEnvironmentSafe();
            return execute(input, context);
          };
        }
        return tool;
      });
    return this.options.mutationLock
      ? wrapAgentToolsWithWorkspaceMutationLock(tools, this.options.mutationLock)
      : tools;
  }
}

// One policy for main/child catalogs. Trial-local memory, task orchestration
// and parent/child messages remain available; cross-trial services do not.
export const BENCHMARK_DISABLED_TOOLS: ReadonlySet<string> = new Set([
  "ask_user",
  "find_file_editors",
  "send_thread_message",
  "name_thread",
  "list_skills",
  "read_skill",
  "create_skill",
  "modify_skill",
  "delete_skill",
  "web_search",
  "fetch_webpage",
  "fetch_artifact",
  "list_mcp_servers",
  "save_local_mcp_server",
  "save_remote_mcp_server",
  "disable_mcp_server",
  "remove_mcp_server",
]);
