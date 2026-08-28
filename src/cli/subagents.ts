import { Chalk, type ChalkInstance } from "chalk";

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

function environmentDetails(
  agent: Readonly<SubagentView>,
  palette: ChalkInstance,
): string {
  const effectiveIsolation = agent.environment?.kind ?? "pending";
  const environmentStatus = agent.environment?.status ?? "pending";
  return palette.gray(
    `  thread ${safeInline(agent.childThreadId, 80)} · ` +
    `isolation ${agent.requestedIsolation} → ${effectiveIsolation} · ` +
    `environment ${safeInline(agent.environmentId, 80)} (${environmentStatus})`,
  );
}

function resultDetails(
  agent: Readonly<SubagentView>,
  palette: ChalkInstance,
): string {
  const artifact = agent.resultArtifact;
  if (!artifact) {
    const artifactStatus = isActive(agent.status) ? "pending" : "none";
    const handoffStatus = agent.environment?.kind === "shared"
      ? "shared workspace"
      : isActive(agent.status)
        ? "pending"
        : "unavailable";
    return palette.gray(
      `  artifact ${artifactStatus} · handoff ${handoffStatus}`,
    );
  }

  const changedFiles = artifact.changedFileCount === 1
    ? "1 changed file"
    : `${artifact.changedFileCount} changed files`;
  const handoffStatus = artifact.delivery === "local"
    ? "local"
    : artifact.delivery === "branch"
      ? `branch ${safeInline(artifact.branchName ?? "unknown", 80)}`
      : artifact.environmentKind === "shared"
        ? "shared workspace"
        : "pending";
  return palette.gray(
    `  artifact ${safeInline(artifact.id, 80)} (${artifact.status}) · ` +
    `${changedFiles} · handoff ${handoffStatus}`,
  );
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

    let statusLine: string;
    switch (agent.status) {
      case "running":
        statusLine = palette.cyan(`▶ ${label}`);
        break;
      case "stopping":
        statusLine = palette.yellow(`◌ ${label}`);
        break;
      case "completed":
        statusLine = palette.green(`✓ ${label}`);
        break;
      case "blocked":
        statusLine = palette.yellow(`⊠ ${label}`);
        break;
      case "failed":
        statusLine = palette.red(`✗ ${label}`);
        break;
      case "stopped":
        statusLine = palette.gray(`■ ${label}`);
        break;
      case "interrupted":
        statusLine = palette.red(`! ${label}`);
        break;
    }
    return [
      statusLine,
      environmentDetails(agent, palette),
      resultDetails(agent, palette),
    ].join("\n");
  });

  return `\n${header}\n${lines.join("\n")}\n`;
}
