import type { AgentTool, TaskNode } from "../core/types.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { SubagentControl } from "../subagents/types.js";
import { CommandRuntime } from "../command/runtime.js";
import type { DownloadBroker } from "../downloads/broker.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
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
import { ManageMemoryTool } from "./manage-memory.js";
import { ManageSubagentsTool } from "./manage-subagents.js";
import { ManageTasksTool } from "./manage-tasks.js";
import { ProposePlanTool } from "./propose-plan.js";
import { ReadFileTool } from "./read-file.js";
import { ReadImageTool } from "./read-image.js";
import {
  CancelCommandTool,
  PollCommandTool,
  RunCommandTool,
  StartCommandTool,
} from "./run-command.js";
import { SearchFilesTool } from "./search-files.js";
import { SubmitTaskResultTool } from "./submit-task-result.js";
import { UpdateFileTool } from "./update-file.js";

type BoundTask = Pick<TaskNode, "id" | "status" | "completionChecks">;

export interface BuiltinToolSourceOptions {
  readonly workspace: WorkspaceManager;
  readonly memoryManager?: MemoryManager;
  readonly subagentControl?: SubagentControl;
  readonly commandRuntime?: CommandRuntime;
  readonly downloadBroker?: DownloadBroker;
  readonly limits?: Readonly<RuntimeLimits>;
  readonly mutationLock?: WorkspaceMutationLock;
  readonly boundTask?: BoundTask;
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
    const commandRuntime = this.options.commandRuntime ?? new CommandRuntime(workspace);
    const tools: AgentTool[] = [
      new ReadFileTool(workspace),
      new SearchFilesTool(workspace),
      new ReadImageTool(workspace),
      new CreateFileTool(workspace),
      new UpdateFileTool(workspace),
      new DeleteFileTool(workspace),
      new RunCommandTool(workspace, commandRuntime),
      new StartCommandTool(workspace, commandRuntime),
      new PollCommandTool(workspace, commandRuntime),
      new CancelCommandTool(workspace, commandRuntime),
      ...(this.options.downloadBroker ? [new FetchArtifactTool(this.options.downloadBroker)] : []),
      new ManageTasksTool(),
      ...(this.options.subagentControl
        ? [new ManageSubagentsTool(this.options.subagentControl, this.options.limits)]
        : []),
      new ProposePlanTool(),
      new CompactContextTool(this.options.limits),
      new RecallContextTool(this.options.limits),
      new SearchContextTool(),
      ...(this.options.memoryManager ? [new ManageMemoryTool(this.options.memoryManager, workspace)] : []),
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
