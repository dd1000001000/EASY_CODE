import type { AgentTool, SessionState, ToolDisplayDetail, ToolExecutionResult } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { sanitizeTerminalText } from "../ui/render/layout.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function bounded(value: string): string {
  const clean = redactSensitiveInformation(sanitizeTerminalText(value, { allowSgr: false }));
  return clean.length > 1_500 ? `${clean.slice(0, 1_500)}…` : clean;
}

function detail(label: string, value: string | undefined): ToolDisplayDetail[] {
  return value ? [{ label, value: bounded(value) }] : [];
}

const SECRET_FLAG = /^--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|auth|credential)s?$/iu;
const SECRET_ASSIGNMENT = /^(--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|auth|credential)s?=).+$/iu;

function commandText(program: string, args: readonly string[]): string {
  let redactNext = false;
  const safeArgs = args.map(arg => {
    if (redactNext) { redactNext = false; return "[REDACTED]"; }
    if (SECRET_FLAG.test(arg)) { redactNext = true; return arg; }
    if (SECRET_ASSIGNMENT.test(arg)) return arg.replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
    return redactSensitiveInformation(arg);
  });
  return [program, ...safeArgs].map(part => /\s/u.test(part) ? JSON.stringify(part) : part).join(" ");
}

function taskTitle(state: SessionState, result: ToolExecutionResult, id: string): string | undefined {
  return result.taskGraphUpdate?.tasks.find(task => task.id === id)?.title
    ?? state.taskGraph?.tasks.find(task => task.id === id)?.title;
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(item => string(record(item)?.title) ?? string(record(item)?.taskTitle) ?? []) : [];
}

/** Human-readable targets only. Never include raw MCP arguments, command environment, or tool output. */
export function toolDisplayDetails(tool: AgentTool | undefined, toolName: string, rawArguments: string,
  result: ToolExecutionResult, state: SessionState): ToolDisplayDetail[] {
  let input: Record<string, unknown> | undefined;
  try { input = record(JSON.parse(rawArguments)); } catch { /* malformed calls still have a result */ }

  if (["run_command", "start_command", "poll_command", "cancel_command"].includes(toolName)) {
    const executed = record(record(result.data)?.executed);
    const program = string(executed?.program) ?? string(input?.program);
    const args = Array.isArray(executed?.args) ? executed.args : input?.args;
    const command = program ? commandText(program, Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : []) : undefined;
    return [
      ...detail("Command", command ?? "Original command unavailable"),
      ...(!command ? detail("Command ID", string(input?.commandId)) : []),
    ];
  }

  if (["read_file", "create_file", "update_file", "delete_file", "read_image"].includes(toolName)) {
    return detail("File", string(input?.path));
  }

  if (toolName === "search_files") {
    return detail("Search path", string(input?.path));
  }

  if (["read_skill", "create_skill", "modify_skill", "delete_skill"].includes(toolName)) {
    return [...detail("Skill", string(input?.name)), ...detail("Scope", string(input?.scope))];
  }

  if (toolName === "name_thread") return detail("Thread title", string(input?.title));

  if (toolName === "manage_tasks") {
    const action = string(input?.action);
    const created = names(input?.tasks);
    const id = string(input?.taskId);
    const titles = created.length ? created : id ? [taskTitle(state, result, id) ?? id]
      : action === "list" ? (result.taskGraphUpdate ?? state.taskGraph)?.tasks.map(task => task.title) ?? [] : [];
    return [...detail("Action", action), ...detail("Tasks", titles.slice(0, 16).join("; "))];
  }

  if (toolName === "manage_subagents") {
    const action = string(input?.action);
    const task = record(input?.task);
    const id = string(input?.taskId);
    const data = record(result.data);
    const returnedAgent = record(data?.agent);
    const returnedTitles = names(data?.agents);
    const assignedTask = state.taskGraph?.tasks.find(task => task.assignedAgentId === input?.agentId);
    const title = result.subagentAssignment?.taskTitle ?? string(task?.title)
      ?? string(data?.taskTitle) ?? string(returnedAgent?.taskTitle) ?? assignedTask?.title
      ?? (id ? taskTitle(state, result, id) : undefined);
    const agentIds = Array.isArray(input?.agentIds)
      ? input.agentIds.filter((value): value is string => typeof value === "string") : [];
    const label = title ?? (returnedTitles.slice(0, 8).join("; ")
      || string(input?.agentId) || agentIds.join(", "));
    return [...detail("Action", action), ...detail("Subagent", label)];
  }

  if (toolName === "submit_task_result") {
    const id = result.subagentTaskReport?.taskId ?? string(record(result.data)?.taskId);
    return detail("Task", string(record(result.data)?.taskTitle) ?? (id ? taskTitle(state, result, id) ?? id : undefined));
  }

  if (tool?.metadata?.identity.sourceId === "mcp") {
    const identity = tool.metadata.identity;
    const server = identity.id.startsWith("mcp:") && identity.id.endsWith(`:${toolName}`)
      ? identity.id.slice(4, -toolName.length - 1) : undefined;
    if (toolName.includes("catalog_search")) return [];
    let invoked: string | undefined;
    if (tool.approvalTarget) {
      try { invoked = tool.approvalTarget(input ?? {}).name; } catch { /* invalid input */ }
    }
    invoked ??= string(input?.name);
    return [...detail("MCP server", server), ...detail("MCP tool", invoked ?? identity.displayName)];
  }

  if (["save_local_mcp_server", "save_remote_mcp_server", "disable_mcp_server", "remove_mcp_server"].includes(toolName)) {
    return detail("MCP server", string(input?.id));
  }

  return [];
}

export function safeToolDisplayDetails(details: readonly ToolDisplayDetail[]): ToolDisplayDetail[] {
  return details.slice(0, 16).flatMap(item => {
    if (typeof item.label !== "string" || typeof item.value !== "string") return [];
    return [{ label: bounded(item.label).slice(0, 40), value: bounded(item.value) }];
  });
}
