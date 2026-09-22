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
import { bindBuiltinToolMetadata } from "./capabilities.js";
import { CompactContextTool } from "./compact-context.js";
import { RecallContextTool, SearchContextTool } from "./context-read.js";
import { CreateFileTool } from "./create-file.js";
import { DeleteFileTool } from "./delete-file.js";
import { FetchArtifactTool } from "./fetch-artifact.js";
import { MemoryToolSession } from "./memory-tool-session.js";
import { ReadMemoryTool } from "./read-memory.js";
import { ManageSubagentsTool } from "./manage-subagents.js";
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
import {
  CancelCommandTool,
  PollCommandTool,
  RunCommandTool,
  StartCommandTool,
} from "./run-command.js";
import { SearchFilesTool } from "./search-files.js";
import { CreateSkillTool, DeleteSkillTool, ListSkillsTool, ModifySkillTool, ReadSkillTool } from "./skill-tools.js";
import { SubmitTaskResultTool } from "./submit-task-result.js";
import { UpdateFileTool } from "./update-file.js";
import { WriteMemoryTool } from "./write-memory.js";
import { WebSearchTool } from "./web-search.js";
import { FetchWebpageTool } from "./fetch-webpage.js";

type BoundTask = Pick<TaskNode, "id" | "status" | "completionChecks"> & Pick<Partial<TaskNode>, "title">;

export interface BuiltinToolSourceOptions {
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
  readonly threadTitleStore?: ThreadTitleStore;
  readonly skillStore?: SkillStore;
  readonly threadResourceStore?: ThreadResourceStore;
  readonly threadDocumentService?: ThreadDocumentService;
  readonly includePublicWebTools?: boolean;
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
    const commandRuntime = this.options.commandRuntime ?? new CommandRuntime(workspace, undefined, undefined, undefined, {
      limits: this.options.limits,
    });
    const tools: AgentTool[] = [
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
        ? [new WebSearchTool(workspace)] : []),
      ...(this.options.includePublicWebTools !== false && this.options.threadDocumentService
        ? [new FetchWebpageTool(workspace, this.options.threadDocumentService)] : []),
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
      ...(this.options.subagentControl
        ? [new ManageSubagentsTool(this.options.subagentControl, this.options.limits)]
        : []),
      new ProposePlanTool(),
      new CompactContextTool(this.options.limits),
      new RecallContextTool(this.options.limits),
      new SearchContextTool(),
      new ReadMemoryTool(workspace, memorySession),
      ...(this.options.memoryManager
        ? [new WriteMemoryTool(this.options.memoryManager, workspace, memorySession)]
        : []),
      ...(this.options.boundTask ? [new SubmitTaskResultTool(this.options.boundTask, this.options.limits)] : []),
    ].map((tool) => {
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
