import type { AgentTool, ToolEffect, ToolResultClass } from "../core/types.js";
import { toolMetadata } from "../tools/capabilities.js";

interface CapabilityFlags {
  readonly workspaceRead: boolean;
  readonly publicWebSearch: boolean;
  readonly publicWebPageRead: boolean;
  readonly visualRead: boolean;
  readonly processExecution: boolean;
  readonly fileMutation: boolean;
  readonly managedExternalWrite: boolean;
  readonly artifactRetrieval: boolean;
  readonly orchestration: boolean;
  readonly externalServiceTools: boolean;
  readonly memory: boolean;
  readonly planSubmission: boolean;
}

function hasEffect(tool: Readonly<AgentTool>, effect: ToolEffect): boolean {
  return toolMetadata(tool).effects.includes(effect);
}

function hasResultClass(tool: Readonly<AgentTool>, resultClass: ToolResultClass): boolean {
  return toolMetadata(tool).resultClass === resultClass;
}

function flags(tools: readonly Readonly<AgentTool>[]): CapabilityFlags {
  return {
    workspaceRead: tools.some(tool => hasEffect(tool, "workspace_read")),
    publicWebSearch: tools.some(tool => hasEffect(tool, "network_read") && hasResultClass(tool, "search")),
    publicWebPageRead: tools.some(tool => hasEffect(tool, "network_read") && hasResultClass(tool, "file_read")),
    visualRead: tools.some(tool => toolMetadata(tool).requiresVision),
    processExecution: tools.some(tool => hasEffect(tool, "process_execute") || hasEffect(tool, "process_control")),
    fileMutation: tools.some(tool => hasEffect(tool, "workspace_write") && hasResultClass(tool, "file_mutation")),
    managedExternalWrite: tools.some(tool => hasEffect(tool, "external_write")),
    artifactRetrieval: tools.some(tool => hasResultClass(tool, "artifact")),
    orchestration: tools.some(tool => toolMetadata(tool).requiresOrchestration),
    externalServiceTools: tools.some(tool => toolMetadata(tool).identity.sourceKind === "external"),
    memory: tools.some(tool => hasEffect(tool, "memory_read") || hasEffect(tool, "memory_write")),
    planSubmission: tools.some(tool => tool.name === "propose_plan"),
  };
}

function bullets(entries: readonly string[]): string {
  return entries.length
    ? entries.map(entry => `- ${entry}`).join("\n")
    : "- No ordinary work capability is currently available in this mode.";
}

function modeNames(plan: boolean, code: boolean): string {
  if (plan && code) return "Plan and Code";
  if (plan) return "Plan only";
  if (code) return "Code only";
  return "unavailable";
}

export interface AutoRouteCapabilitySummary {
  readonly planCapabilities: string;
  readonly codeCapabilities: string;
  readonly currentConditions: string;
}

/**
 * Describe executable capability categories without exposing provider-facing
 * tool names or schemas to the lightweight Auto controller.
 */
export function autoRouteCapabilitySummary(input: {
  readonly planTools: readonly Readonly<AgentTool>[];
  readonly codeTools: readonly Readonly<AgentTool>[];
  readonly connectedMcpServers: number;
}): AutoRouteCapabilitySummary {
  const plan = flags(input.planTools);
  const code = flags(input.codeTools);
  const planEntries: string[] = [];
  if (plan.workspaceRead) planEntries.push("Inspect project files and local resources, including converted documents.");
  if (plan.publicWebSearch || plan.publicWebPageRead) {
    planEntries.push("Search the public Web and read selected public pages for planning evidence.");
  }
  if (plan.visualRead) planEntries.push("Inspect workspace images with the active vision-capable model.");
  if (plan.processExecution) planEntries.push("Run bounded investigation and diagnostic commands under the active approval policy.");
  if (plan.memory) planEntries.push("Retrieve relevant conversation, project, and long-term memory.");
  if (plan.planSubmission) planEntries.push("Finish with a reviewable implementation plan for the user; do not implement the requested change.");

  const codeEntries: string[] = [];
  if (code.workspaceRead) codeEntries.push("Inspect project files and local resources, including converted documents.");
  if (code.publicWebSearch || code.publicWebPageRead) {
    codeEntries.push("Search the public Web and read selected public pages for a current answer or implementation.");
  }
  if (code.visualRead) codeEntries.push("Inspect workspace images with the active vision-capable model.");
  if (code.fileMutation) codeEntries.push("Create, change, and remove project or managed files.");
  if (code.processExecution) codeEntries.push("Run commands, tests, builds, and supervised long-running services.");
  if (code.artifactRetrieval) codeEntries.push("Retrieve authorized external artifacts into the workspace.");
  if (code.managedExternalWrite) codeEntries.push("Modify managed skills, external-service configuration, or connected external systems when authorized.");
  if (code.orchestration) codeEntries.push("Create task graphs and delegate bounded work to child agents.");
  if (code.externalServiceTools) codeEntries.push("Use tools exposed by currently connected external services.");
  if (code.memory) codeEntries.push("Retrieve and maintain relevant conversation, project, and long-term memory.");
  codeEntries.push("Finish with the requested current answer or the verified implementation result.");

  const conditions = [
    `Public Web search/page reading: ${modeNames(plan.publicWebSearch || plan.publicWebPageRead, code.publicWebSearch || code.publicWebPageRead)}.`,
    `Image understanding: ${modeNames(plan.visualRead, code.visualRead)}.`,
    `Task graphs and child agents: ${code.orchestration ? "available in Code" : "unavailable"}.`,
    `Connected MCP servers: ${input.connectedMcpServers}; model-facing external-service tools are ${code.externalServiceTools ? "available in Code" : "not currently exposed"}.`,
    `Reviewable plan submission: ${plan.planSubmission ? "available in Plan" : "unavailable"}.`,
  ];

  return {
    planCapabilities: bullets(planEntries),
    codeCapabilities: bullets(codeEntries),
    currentConditions: bullets(conditions),
  };
}
