import { Chalk } from "chalk";

import {
  sanitizeCommandOutput,
  stripTerminalControls,
} from "../command/output-stream.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import type { SubagentStatus, SubagentView } from "../subagents/types.js";
import type { TaskGraphView } from "../tasks/task-graph.js";

export interface SubagentRenderOptions {
  readonly color?: boolean;
  readonly taskGraph?: Readonly<TaskGraphView>;
  readonly concurrencyLimit?: number;
}

function safeInline(value: string, maximum: number): string {
  const safe = redactSensitiveInformation(
    sanitizeCommandOutput(stripTerminalControls(value)),
  )
    .replace(/\s+/gu, " ")
    .trim();
  if (safe.length <= maximum) return safe;
  return `${safe.slice(0, Math.max(0, maximum - 1))}…`;
}

function isActive(status: SubagentStatus): boolean {
  return status === "running" || status === "stopping";
}

/** Render process-local child status without exposing private child context. */
export function renderSubagents(
  agents: readonly Readonly<SubagentView>[],
  options: SubagentRenderOptions = {},
): string {
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const active = agents.filter((agent) => isActive(agent.status)).length;
  const activeText = options.concurrencyLimit === undefined
    ? `${active} active`
    : `${active}/${options.concurrencyLimit} active`;
  const header = palette.bold(
    `Child agents · ${activeText} · ${agents.length} total`,
  );
  if (agents.length === 0) {
    return `\n${header}\n${palette.gray("No child agents in this runtime.")}\n`;
  }

  const currentGraph = options.taskGraph;
  const tasks = currentGraph?.tasks ?? [];
  const lines = agents.map((agent, index) => {
    const currentTaskIndex = currentGraph?.id === agent.taskGraphId
      ? tasks.findIndex((task) => task.id === agent.taskId)
      : -1;
    const taskLabel = agent.assignmentKind === "standalone"
      ? `Standalone [${safeInline(agent.taskId, 48)}]`
      : `${currentTaskIndex >= 0 ? `Task ${currentTaskIndex + 1} ` : "Task "}` +
        `[${safeInline(agent.taskId, 48)}]`;
    const label =
      `${index + 1}. ${safeInline(agent.id, 72)} · ${taskLabel} ` +
      `${safeInline(agent.taskTitle, 160)} ` +
      `(${agent.status})`;

    switch (agent.status) {
      case "running":
        return palette.cyan(`▶ ${label}`);
      case "stopping":
        return palette.yellow(`◌ ${label}`);
      case "completed":
        return palette.green(`✓ ${label}`);
      case "blocked":
        return palette.yellow(`⊠ ${label}`);
      case "failed":
        return palette.red(`✗ ${label}`);
      case "stopped":
        return palette.gray(`■ ${label}`);
      case "interrupted":
        return palette.red(`! ${label}`);
    }
  });

  return `\n${header}\n${lines.join("\n")}\n`;
}
