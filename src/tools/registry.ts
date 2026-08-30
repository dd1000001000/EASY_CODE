import type { AgentTool, ToolName } from "../core/types.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { SubagentControl } from "../subagents/types.js";
import type { CommandRuntime } from "../command/runtime.js";
import { CompactContextTool } from "./compact-context.js";
import { CreateFileTool } from "./create-file.js";
import { DeleteFileTool } from "./delete-file.js";
import { ReadFileTool } from "./read-file.js";
import { ReadImageTool } from "./read-image.js";
import { RunCommandTool } from "./run-command.js";
import { ManageMemoryTool } from "./manage-memory.js";
import { ManageTasksTool } from "./manage-tasks.js";
import { ManageSubagentsTool } from "./manage-subagents.js";
import { ProposePlanTool } from "./propose-plan.js";
import { UpdateFileTool } from "./update-file.js";

export class ToolRegistry {
  private readonly tools = new Map<ToolName, AgentTool>();

  constructor(tools: readonly AgentTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
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
  } = {},
): AgentTool[] {
  return [
    new ReadFileTool(workspaceManager),
    new ReadImageTool(workspaceManager),
    new CreateFileTool(workspaceManager),
    new UpdateFileTool(workspaceManager),
    new DeleteFileTool(workspaceManager),
    new RunCommandTool(workspaceManager, options.commandRuntime),
    new ManageTasksTool(),
    ...(options.subagentControl
      ? [new ManageSubagentsTool(options.subagentControl)]
      : []),
    new ProposePlanTool(),
    new CompactContextTool(),
    ...(memoryManager ? [new ManageMemoryTool(memoryManager, workspaceManager)] : []),
  ];
}

export function createDefaultToolRegistry(
  workspaceManager: WorkspaceManager,
  memoryManager?: MemoryManager,
  options: {
    subagentControl?: SubagentControl;
    commandRuntime?: CommandRuntime;
  } = {},
): ToolRegistry {
  return new ToolRegistry(createDefaultTools(workspaceManager, memoryManager, options));
}
