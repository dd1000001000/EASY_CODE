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

function safeInline(value: string): string {
  return redactSensitiveInformation(
    sanitizeCommandOutput(stripTerminalControls(value)),
  )
    .replace(/\s+/gu, " ")
    .trim();
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
    `  thread ${safeInline(agent.childThreadId)} · ` +
    `isolation ${agent.requestedIsolation} → ${effectiveIsolation} · ` +
    `environment ${safeInline(agent.environmentId)} (${environmentStatus})`,
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
      ? `branch ${safeInline(artifact.branchName ?? "unknown")}`
      : artifact.environmentKind === "shared"
        ? "shared workspace"
        : "pending";
  return palette.gray(
    `  artifact ${safeInline(artifact.id)} (${artifact.status}) · ` +
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
      ? `Standalone [${safeInline(agent.taskId)}]`
      : `${currentTaskIndex >= 0 ? `Task ${currentTaskIndex + 1} ` : "Task "}` +
        `[${safeInline(agent.taskId)}]`;
    const label =
      `${index + 1}. ${safeInline(agent.id)} · ${taskLabel} ` +
      `${safeInline(agent.taskTitle)} ` +
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
