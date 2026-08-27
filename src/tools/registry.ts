import type { AgentTool, ToolName } from "../core/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { CreateFileTool } from "./create-file.js";
import { ReadFileTool } from "./read-file.js";
import { RunCommandTool } from "./run-command.js";
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

export function createDefaultTools(workspaceManager: WorkspaceManager): AgentTool[] {
  return [
    new ReadFileTool(workspaceManager),
    new CreateFileTool(workspaceManager),
    new UpdateFileTool(workspaceManager),
    new RunCommandTool(workspaceManager),
  ];
}

export function createDefaultToolRegistry(workspaceManager: WorkspaceManager): ToolRegistry {
  return new ToolRegistry(createDefaultTools(workspaceManager));
}

