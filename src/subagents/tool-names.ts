import type { SubagentLifecycleUpdate } from "../core/types.js";

/** Model-facing child-agent controls, one tool per lifecycle operation. */
export const SUBAGENT_TOOL_NAMES = [
  "spawn_subagent",
  "observe_subagents",
  "message_subagent",
  "stop_subagent",
  "handoff_subagent",
] as const;

export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

const SUBAGENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(SUBAGENT_TOOL_NAMES);

/** The only tool allowed to record each durable child lifecycle transition. */
const LIFECYCLE_SOURCE: Readonly<Record<SubagentLifecycleUpdate["action"], SubagentToolName>> = {
  activate: "spawn_subagent",
  observe: "observe_subagents",
  deliver_follow_up: "message_subagent",
  request_stop: "stop_subagent",
};

/** Tools whose results may carry a Runtime-issued child task-DAG transition. */
const TASK_GRAPH_SOURCES: ReadonlySet<string> = new Set<SubagentToolName>(["spawn_subagent", "observe_subagents"]);

export function isSubagentToolName(name: unknown): name is SubagentToolName {
  return typeof name === "string" && SUBAGENT_TOOL_NAME_SET.has(name);
}

export function subagentLifecycleSource(action: SubagentLifecycleUpdate["action"]): SubagentToolName {
  return LIFECYCLE_SOURCE[action];
}

export function isSubagentTaskGraphSource(name: unknown): boolean {
  return typeof name === "string" && TASK_GRAPH_SOURCES.has(name);
}
