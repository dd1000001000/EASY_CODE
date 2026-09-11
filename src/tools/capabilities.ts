import type {
  AgentMode,
  AgentRole,
  AgentTool,
  BuiltinToolName,
  ToolEffect,
  ToolResultClass,
  ToolRuntimeMetadata,
} from "../core/types.js";

const ALL_MODES = ["plan", "auto", "code"] as const;
const WORK_MODES = ["auto", "code"] as const;
const MAIN = ["main_agent"] as const;
const CHILD = ["subagent"] as const;
const BOTH = ["main_agent", "subagent"] as const;

interface BuiltinPolicy {
  readonly effects: readonly ToolEffect[];
  readonly modes: readonly AgentMode[];
  readonly roles: readonly AgentRole[];
  readonly taskWork?: boolean;
  readonly progressExperiment?: boolean;
  readonly requiresOrchestration?: boolean;
  readonly requiresVision?: boolean;
  readonly validationSensitive?: boolean;
  readonly idempotent?: boolean;
  readonly controlPlane?: boolean;
  readonly resultClass?: ToolResultClass;
}

/** One authoritative policy table replaces name lists scattered through Runtime and UI. */
const BUILTIN_POLICIES = {
  select_mode: { effects: [], modes: ["auto"], roles: MAIN, controlPlane: true },
  propose_plan: { effects: [], modes: ["plan"], roles: MAIN, controlPlane: true },
  read_file: { effects: ["workspace_read"], modes: ALL_MODES, roles: BOTH,
    taskWork: true, progressExperiment: true, idempotent: true, resultClass: "file_read" },
  search_files: { effects: ["workspace_read"], modes: ALL_MODES, roles: BOTH,
    taskWork: true, idempotent: true, resultClass: "search" },
  read_image: { effects: ["workspace_read"], modes: ALL_MODES, roles: MAIN,
    taskWork: true, progressExperiment: true, requiresVision: true, idempotent: true },
  create_file: { effects: ["workspace_write"], modes: ALL_MODES, roles: BOTH,
    taskWork: true, validationSensitive: true, resultClass: "file_mutation" },
  update_file: { effects: ["workspace_write"], modes: ALL_MODES, roles: BOTH,
    taskWork: true, validationSensitive: true, resultClass: "file_mutation" },
  delete_file: { effects: ["workspace_write", "destructive"], modes: ALL_MODES, roles: BOTH,
    taskWork: true, validationSensitive: true, resultClass: "file_mutation" },
  run_command: { effects: ["process_execute", "workspace_write"], modes: ALL_MODES, roles: BOTH,
    taskWork: true, progressExperiment: true, validationSensitive: true, resultClass: "command" },
  start_command: { effects: ["process_execute", "workspace_write"], modes: ALL_MODES, roles: BOTH,
    taskWork: true, progressExperiment: true, validationSensitive: true, resultClass: "command" },
  poll_command: { effects: ["process_control"], modes: ALL_MODES, roles: BOTH,
    taskWork: true, progressExperiment: true, idempotent: true, resultClass: "command" },
  cancel_command: { effects: ["process_control", "destructive"], modes: ALL_MODES, roles: BOTH,
    taskWork: true, progressExperiment: true, resultClass: "command" },
  manage_tasks: { effects: ["agent_control"], modes: WORK_MODES, roles: MAIN,
    requiresOrchestration: true, controlPlane: true, resultClass: "task_control" },
  manage_subagents: { effects: ["agent_control", "workspace_write"], modes: WORK_MODES, roles: MAIN,
    requiresOrchestration: true, validationSensitive: true, controlPlane: true,
    resultClass: "subagent_control" },
  submit_task_result: { effects: ["agent_control"], modes: ["code"], roles: CHILD,
    controlPlane: true, resultClass: "task_control" },
  compact_context: { effects: ["context_control"], modes: ALL_MODES, roles: BOTH,
    progressExperiment: true, idempotent: true, controlPlane: true, resultClass: "context_control" },
  manage_memory: { effects: ["memory_write"], modes: ALL_MODES, roles: MAIN,
    controlPlane: true, resultClass: "memory" },
  search_context: { effects: ["memory_read"], modes: ALL_MODES, roles: BOTH,
    progressExperiment: true, idempotent: true, resultClass: "memory" },
  recall_context: { effects: ["memory_read"], modes: ALL_MODES, roles: BOTH,
    progressExperiment: true, idempotent: true, resultClass: "memory" },
  fetch_artifact: { effects: ["network_read", "workspace_write"], modes: WORK_MODES, roles: MAIN,
    validationSensitive: true, resultClass: "artifact" },
} as const satisfies Record<BuiltinToolName, BuiltinPolicy>;

const BUILTIN_NAMES = new Set<string>(Object.keys(BUILTIN_POLICIES));
const TOOL_EFFECTS = new Set<ToolEffect>([
  "workspace_read", "workspace_write", "process_execute", "process_control",
  "network_read", "network_write", "external_read", "external_write", "destructive",
  "agent_control", "memory_read", "memory_write", "context_control",
]);
const AGENT_MODES = new Set<AgentMode>(["plan", "auto", "code"]);
const AGENT_ROLES = new Set<AgentRole>(["main_agent", "subagent"]);

function freezeMetadata(metadata: ToolRuntimeMetadata): Readonly<ToolRuntimeMetadata> {
  return Object.freeze({
    ...metadata,
    identity: Object.freeze({ ...metadata.identity }),
    effects: Object.freeze([...metadata.effects]),
    allowedModes: Object.freeze([...metadata.allowedModes]),
    allowedRoles: Object.freeze([...metadata.allowedRoles]),
  });
}

export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return BUILTIN_NAMES.has(name);
}

export function builtinToolMetadata(name: BuiltinToolName): Readonly<ToolRuntimeMetadata> {
  const policy: BuiltinPolicy = BUILTIN_POLICIES[name];
  return freezeMetadata({
    identity: {
      id: `builtin:${name}`,
      name,
      displayName: name,
      sourceId: "builtin",
      sourceKind: "builtin",
    },
    effects: policy.effects,
    allowedModes: policy.modes,
    allowedRoles: policy.roles,
    taskWork: policy.taskWork ?? false,
    progressExperiment: policy.progressExperiment ?? false,
    requiresOrchestration: policy.requiresOrchestration ?? false,
    requiresVision: policy.requiresVision ?? false,
    validationSensitive: policy.validationSensitive ?? false,
    idempotent: policy.idempotent ?? false,
    controlPlane: policy.controlPlane ?? false,
    resultClass: policy.resultClass ?? "generic",
  });
}

function legacyToolMetadata(tool: Readonly<AgentTool>): Readonly<ToolRuntimeMetadata> {
  return freezeMetadata({
    identity: {
      id: `legacy:${tool.name}`,
      name: tool.name,
      displayName: tool.name,
      sourceId: "legacy",
      sourceKind: "legacy",
    },
    effects: tool.mutating ? ["workspace_write"] : [],
    // Preserve the old fallback: an unknown custom tool was main-agent work-only.
    allowedModes: WORK_MODES,
    allowedRoles: MAIN,
    taskWork: false,
    progressExperiment: false,
    requiresOrchestration: false,
    requiresVision: false,
    validationSensitive: tool.mutating,
    idempotent: !tool.mutating,
    controlPlane: false,
    resultClass: "generic",
  });
}

export function validateToolMetadata(
  tool: Readonly<AgentTool>,
  metadata: Readonly<ToolRuntimeMetadata>,
): void {
  if (metadata.identity.name !== tool.name || metadata.identity.id.length === 0) {
    throw new Error(`Tool metadata identity does not match ${tool.name}`);
  }
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(metadata.identity.id)) {
    throw new Error(`Tool ${tool.name} has an invalid stable identity`);
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(metadata.identity.sourceId)) {
    throw new Error(`Tool ${tool.name} has an invalid source identity`);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(tool.name)) {
    throw new Error(`Tool ${tool.name} has an invalid model-facing name`);
  }
  if (!metadata.identity.displayName || metadata.identity.displayName.length > 256 ||
      /[\u0000-\u001F\u007F]/u.test(metadata.identity.displayName)) {
    throw new Error(`Tool ${tool.name} has an invalid display name`);
  }
  if (!metadata.effects.every((effect) => TOOL_EFFECTS.has(effect)) ||
      !metadata.allowedModes.every((mode) => AGENT_MODES.has(mode)) ||
      !metadata.allowedRoles.every((role) => AGENT_ROLES.has(role)) ||
      metadata.allowedModes.length === 0 || metadata.allowedRoles.length === 0) {
    throw new Error(`Tool ${tool.name} metadata contains an unknown capability`);
  }
  if (metadata.identity.sourceKind === "external" && metadata.identity.sourceId === "builtin") {
    throw new Error(`External tool ${tool.name} cannot claim the builtin source`);
  }
  if (
    metadata.identity.sourceKind === "external" &&
    (metadata.controlPlane || metadata.effects.some((effect) =>
      effect === "agent_control" || effect === "context_control" || effect === "memory_write"))
  ) {
    throw new Error(
      `External tool ${tool.name} cannot claim EASY CODE control-plane capabilities`,
    );
  }
  if (new Set(metadata.effects).size !== metadata.effects.length ||
      new Set(metadata.allowedModes).size !== metadata.allowedModes.length ||
      new Set(metadata.allowedRoles).size !== metadata.allowedRoles.length) {
    throw new Error(`Tool ${tool.name} metadata contains duplicate capabilities`);
  }
}

export function toolMetadata(tool: Readonly<AgentTool>): Readonly<ToolRuntimeMetadata> {
  const metadata = tool.metadata ??
    (isBuiltinToolName(tool.name) ? builtinToolMetadata(tool.name) : legacyToolMetadata(tool));
  validateToolMetadata(tool, metadata);
  return metadata;
}

/** Attach immutable Runtime-owned metadata without wrapping class-specific lifecycle methods. */
export function bindBuiltinToolMetadata<T extends AgentTool>(tool: T): T {
  if (!isBuiltinToolName(tool.name)) throw new Error(`Unknown builtin tool ${tool.name}`);
  if (tool.metadata) {
    validateToolMetadata(tool, tool.metadata);
    return tool;
  }
  Object.defineProperty(tool, "metadata", {
    value: builtinToolMetadata(tool.name),
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return tool;
}

export interface ToolAvailabilityContext {
  readonly mode: AgentMode;
  readonly role: AgentRole;
  readonly orchestrationAvailable: boolean;
  readonly visionAvailable?: boolean;
}

export interface ToolPolicyDecision {
  readonly available: boolean;
  readonly requiresApproval: boolean;
  readonly denialReason?: "mode" | "role" | "orchestration" | "vision";
}

/** External effects that must cross a host-owned approval boundary before invocation. */
export function toolRequiresApproval(tool: Readonly<AgentTool>): boolean {
  const metadata = toolMetadata(tool);
  return metadata.identity.sourceKind === "external" && metadata.effects.some((effect) =>
    effect === "workspace_write" || effect === "process_execute" || effect === "network_write" ||
    effect === "external_write" || effect === "destructive");
}

export function evaluateToolPolicy(
  tool: Readonly<AgentTool>,
  context: Readonly<ToolAvailabilityContext>,
): ToolPolicyDecision {
  const metadata = toolMetadata(tool);
  if (!metadata.allowedModes.includes(context.mode)) return { available: false, requiresApproval: false, denialReason: "mode" };
  if (!metadata.allowedRoles.includes(context.role)) return { available: false, requiresApproval: false, denialReason: "role" };
  if (metadata.requiresOrchestration && !context.orchestrationAvailable) {
    return { available: false, requiresApproval: false, denialReason: "orchestration" };
  }
  if (metadata.requiresVision && context.visionAvailable === false) {
    return { available: false, requiresApproval: false, denialReason: "vision" };
  }
  return { available: true, requiresApproval: toolRequiresApproval(tool) };
}

export function isToolAvailable(
  tool: Readonly<AgentTool>,
  context: Readonly<ToolAvailabilityContext>,
): boolean {
  return evaluateToolPolicy(tool, context).available;
}

export function availableAgentTools(
  tools: readonly AgentTool[],
  context: Readonly<ToolAvailabilityContext>,
): AgentTool[] {
  return tools.filter((tool) => isToolAvailable(tool, context));
}

export function toolHasEffect(tool: Readonly<AgentTool>, effect: ToolEffect): boolean {
  return toolMetadata(tool).effects.includes(effect);
}
