import type { AgentTool, ToolName } from "../core/types.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { SubagentControl } from "../subagents/types.js";
import { CommandRuntime } from "../command/runtime.js";
import { CompactContextTool } from "./compact-context.js";
import { RecallContextTool, SearchContextTool } from "./context-read.js";
import { CreateFileTool } from "./create-file.js";
import { DeleteFileTool } from "./delete-file.js";
import { ReadFileTool } from "./read-file.js";
import { SearchFilesTool } from "./search-files.js";
import { ReadImageTool } from "./read-image.js";
import {
  CancelCommandTool,
  PollCommandTool,
  RunCommandTool,
  StartCommandTool,
} from "./run-command.js";
import { ManageMemoryTool } from "./manage-memory.js";
import { ManageTasksTool } from "./manage-tasks.js";
import { ManageSubagentsTool } from "./manage-subagents.js";
import { ProposePlanTool } from "./propose-plan.js";
import { UpdateFileTool } from "./update-file.js";
import { FetchArtifactTool } from "./fetch-artifact.js";
import type { DownloadBroker } from "../downloads/broker.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import { bindBuiltinToolMetadata, toolMetadata } from "./capabilities.js";

export class ToolRegistry {
  private readonly tools = new Map<ToolName, AgentTool>();

  constructor(tools: readonly AgentTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    toolMetadata(tool);
    this.tools.set(tool.name, tool);
  }

  get(name: ToolName): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }
}

export function createDefaultTools(
  workspaceManager: WorkspaceManager,
  memoryManager?: MemoryManager,
  options: {
    subagentControl?: SubagentControl;
    commandRuntime?: CommandRuntime;
    downloadBroker?: DownloadBroker;
    limits?: Readonly<RuntimeLimits>;
  } = {},
): AgentTool[] {
  const commandRuntime = options.commandRuntime ?? new CommandRuntime(workspaceManager);
  return [
    new ReadFileTool(workspaceManager),
    new SearchFilesTool(workspaceManager),
    new ReadImageTool(workspaceManager),
    new CreateFileTool(workspaceManager),
    new UpdateFileTool(workspaceManager),
    new DeleteFileTool(workspaceManager),
    new RunCommandTool(workspaceManager, commandRuntime),
    new StartCommandTool(workspaceManager, commandRuntime),
    new PollCommandTool(workspaceManager, commandRuntime),
    new CancelCommandTool(workspaceManager, commandRuntime),
    ...(options.downloadBroker ? [new FetchArtifactTool(options.downloadBroker)] : []),
    new ManageTasksTool(),
    ...(options.subagentControl
      ? [new ManageSubagentsTool(options.subagentControl, options.limits)]
      : []),
    new ProposePlanTool(),
    new CompactContextTool(options.limits),
    new RecallContextTool(options.limits),
    new SearchContextTool(),
    ...(memoryManager ? [new ManageMemoryTool(memoryManager, workspaceManager)] : []),
  ].map((tool) => {
    bindBuiltinToolMetadata(tool);
    if (tool.mutating) {
      const execute = tool.execute.bind(tool);
      tool.execute = (input: unknown, context: import("../core/types.js").ToolContext) => {
        commandRuntime.assertEnvironmentSafe();
        return execute(input, context);
      };
    }
    return tool;
  });
}

export function createDefaultToolRegistry(
  workspaceManager: WorkspaceManager,
  memoryManager?: MemoryManager,
  options: {
    subagentControl?: SubagentControl;
    commandRuntime?: CommandRuntime;
    downloadBroker?: DownloadBroker;
  } = {},
): ToolRegistry {
  return new ToolRegistry(createDefaultTools(workspaceManager, memoryManager, options));
}
