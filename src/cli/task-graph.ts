import { Chalk } from "chalk";

import {
  sanitizeCommandOutput,
  stripTerminalControls,
} from "../command/output-stream.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import type { TaskGraphView } from "../tasks/task-graph.js";

export interface TaskGraphRenderOptions {
  readonly color?: boolean;
}

function safeInline(value: string): string {
  return redactSensitiveInformation(
    sanitizeCommandOutput(stripTerminalControls(value)),
  )
    .replace(/\s+/gu, " ")
    .trim();
}

/** Render the authoritative DAG in its stable task-array order. */
export function renderTaskGraph(
  graph: Readonly<TaskGraphView>,
  options: TaskGraphRenderOptions = {},
): string {
  const palette = new Chalk({ level: options.color ? 1 : 0 });
  const header = palette.bold(
    `Task DAG · ${graph.completed}/${graph.total} completed`,
  );
  const goal = palette.gray(`Goal: ${safeInline(graph.goal)}`);
  const tasks = graph.tasks.map((task, index) => {
    const assignment = task.owner === "subagent"
      ? ` · child ${safeInline(task.assignedAgentId ?? "unassigned")}`
      : "";
    const label =
      `${index + 1}. [${safeInline(task.id)}] ${safeInline(task.title)}` +
      assignment;
    switch (task.status) {
      case "completed":
        return palette.green(`✓ ${label}`);
      case "in_progress":
        return palette.cyan(`▶ ${label} (in progress)`);
      case "blocked": {
        const blocker = task.blocker
          ? `: ${safeInline(task.blocker)}`
          : "";
        return palette.yellow(`⊠ ${label} (blocked${blocker})`);
      }
      case "pending":
        return palette.gray(`□ ${label}`);
    }
  });
  return `\n${header}\n${goal}\n${tasks.join("\n")}\n`;
}
