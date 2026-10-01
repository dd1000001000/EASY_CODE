/** Parsing and identity rules for Runtime-issued subagent assignment snapshots in the Thread journal. */

import type { SubagentAssignmentSnapshot, ProviderName, ThinkingEffort } from "../core/types.js";
import { isProviderIdentifier } from "../models/catalog.js";
import { MAX_SUBAGENT_DISPLAY_NAME_CHARS } from "../subagents/display-name.js";
import { asPayloadRecord } from "./event-values.js";

export function subagentAssignment(value: unknown): SubagentAssignmentSnapshot | undefined {
  const input = asPayloadRecord(value);
  if (
    (input?.kind !== "standalone" && input?.kind !== "dag") ||
    typeof input.agentId !== "string" ||
    !input.agentId ||
    (input.displayName !== undefined &&
      (typeof input.displayName !== "string" ||
        !input.displayName ||
        input.displayName.length > MAX_SUBAGENT_DISPLAY_NAME_CHARS)) ||
    typeof input.childThreadId !== "string" ||
    !input.childThreadId ||
    typeof input.environmentId !== "string" ||
    !input.environmentId ||
    typeof input.taskId !== "string" ||
    !input.taskId ||
    typeof input.taskTitle !== "string" ||
    !input.taskTitle ||
    typeof input.taskDescription !== "string" ||
    !input.taskDescription ||
    !Array.isArray(input.completionChecks) ||
    input.completionChecks.length === 0 ||
    !input.completionChecks.every((check) => typeof check === "string" && check.length > 0) ||
    !isProviderIdentifier(input.provider) ||
    typeof input.model !== "string" ||
    !input.model ||
    (input.thinkingEffort !== "none" &&
      input.thinkingEffort !== "low" &&
      input.thinkingEffort !== "medium" &&
      input.thinkingEffort !== "high") ||
    (input.mode !== "plan" && input.mode !== "code") ||
    typeof input.createdAt !== "string" ||
    !input.createdAt ||
    (input.requestedIsolation !== "auto" &&
      input.requestedIsolation !== "shared" &&
      input.requestedIsolation !== "worktree") ||
    (input.kind === "dag" && (typeof input.taskGraphId !== "string" || !input.taskGraphId))
  ) {
    return undefined;
  }
  const common = {
    agentId: input.agentId,
    ...(typeof input.displayName === "string" ? { displayName: input.displayName } : {}),
    childThreadId: input.childThreadId,
    environmentId: input.environmentId,
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    taskDescription: input.taskDescription,
    completionChecks: [...input.completionChecks] as string[],
    provider: input.provider as ProviderName,
    model: input.model,
    thinkingEffort: input.thinkingEffort as ThinkingEffort,
    mode: input.mode as "plan" | "code",
    requestedIsolation: input.requestedIsolation as "auto" | "shared" | "worktree",
    createdAt: input.createdAt,
  };
  return input.kind === "dag"
    ? { kind: "dag", taskGraphId: input.taskGraphId as string, ...common }
    : { kind: "standalone", ...common };
}

export function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Observation events may only close the exact Runtime-issued assignment. */
export function sameSubagentAssignmentIdentity(
  activated: Readonly<SubagentAssignmentSnapshot>,
  observed: Readonly<SubagentAssignmentSnapshot>,
): boolean {
  if (
    activated.kind !== observed.kind ||
    activated.agentId !== observed.agentId ||
    activated.displayName !== observed.displayName ||
    activated.taskId !== observed.taskId ||
    activated.taskTitle !== observed.taskTitle ||
    activated.taskDescription !== observed.taskDescription ||
    !sameStringArray(activated.completionChecks, observed.completionChecks) ||
    activated.provider !== observed.provider ||
    activated.model !== observed.model ||
    activated.thinkingEffort !== observed.thinkingEffort ||
    activated.mode !== observed.mode ||
    activated.requestedIsolation !== observed.requestedIsolation ||
    activated.createdAt !== observed.createdAt
  ) {
    return false;
  }
  if (activated.kind === "dag" && (observed.kind !== "dag" || activated.taskGraphId !== observed.taskGraphId)) {
    return false;
  }

  return activated.childThreadId === observed.childThreadId && activated.environmentId === observed.environmentId;
}
