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

function safeInline(value: string, maximum: number): string {
  const safe = redactSensitiveInformation(
    sanitizeCommandOutput(stripTerminalControls(value)),
  )
    .replace(/\s+/gu, " ")
    .trim();
  if (safe.length <= maximum) return safe;
  return `${safe.slice(0, Math.max(0, maximum - 1))}…`;
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
  const goal = palette.gray(`Goal: ${safeInline(graph.goal, 240)}`);
  const tasks = graph.tasks.map((task, index) => {
    const label = `${index + 1}. [${safeInline(task.id, 48)}] ${safeInline(task.title, 160)}`;
    switch (task.status) {
      case "completed":
        return palette.green(`✓ ${label}`);
      case "in_progress":
        return palette.cyan(`▶ ${label} (in progress)`);
      case "blocked": {
        const blocker = task.blocker
          ? `: ${safeInline(task.blocker, 200)}`
          : "";
        return palette.yellow(`⊠ ${label} (blocked${blocker})`);
      }
      case "pending":
        return palette.gray(`□ ${label}`);
    }
  });
  return `\n${header}\n${goal}\n${tasks.join("\n")}\n`;
}
