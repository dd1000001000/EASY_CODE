import { z } from "zod";
import type { AgentMode, SessionState, TaskGraph } from "../core/types.js";
import { sha256 } from "../utils/hash.js";

export const completionObligationKinds = [
  "context_reconciliation",
  "background_commands",
  "progress_experiment",
  "subagent_submission",
  "collect_subagents",
  "dag_active",
  "plan_proposal",
  "command_environment",
] as const;
export type CompletionObligationKind = typeof completionObligationKinds[number];

export interface CompletionObligation {
  id: string;
  kind: CompletionObligationKind;
  description: string;
  requiredAction: string;
}

export interface CompletionControlState {
  active?: {
    signature: string;
    attempts: number;
    obligations: CompletionObligation[];
  };
}

const obligationSchema = z.object({
  id: z.string().min(1).max(512),
  kind: z.enum(completionObligationKinds),
  description: z.string().min(1).max(4_000),
  requiredAction: z.string().min(1).max(4_000),
}).strict();
const rejectedSchema = z.object({
  signature: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  attempt: z.number().int().positive(),
  obligations: z.array(obligationSchema).min(1).max(64),
}).strict();
const resolvedSchema = z.object({
  signature: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict();

export function completionSignature(obligations: readonly CompletionObligation[]): string {
  return `sha256:${sha256(JSON.stringify(obligations.map(item => ({
    id: item.id,
    kind: item.kind,
    description: item.description,
    requiredAction: item.requiredAction,
  }))))}`;
}

export function nextCompletionAttempt(
  state: Readonly<SessionState>,
  obligations: readonly CompletionObligation[],
): { signature: string; attempt: number } {
  const signature = completionSignature(obligations);
  return {
    signature,
    attempt: state.completionControl?.active?.signature === signature
      ? state.completionControl.active.attempts + 1
      : 1,
  };
}

export function foldCompletionControl(
  state: SessionState,
  type: "completion.rejected" | "completion.resolved",
  raw: unknown,
): void {
  if (type === "completion.rejected") {
    const event = rejectedSchema.parse(raw);
    const expected = completionSignature(event.obligations);
    if (event.signature !== expected) throw new Error("Invalid completion obligation signature");
    const previous = state.completionControl?.active;
    const expectedAttempt = previous?.signature === event.signature ? previous.attempts + 1 : 1;
    if (event.attempt !== expectedAttempt) throw new Error("Invalid completion correction attempt");
    state.completionControl = { active: {
      signature: event.signature,
      attempts: event.attempt,
      obligations: event.obligations.map(item => ({ ...item })),
    } };
    return;
  }
  const event = resolvedSchema.parse(raw);
  if (state.completionControl?.active?.signature !== event.signature) {
    throw new Error("Completion resolution does not match the active obligation");
  }
  state.completionControl = {};
}

export interface CompletionGateInput {
  state: Readonly<SessionState>;
  role: "main_agent" | "subagent";
  mode: AgentMode;
  reconciliationPending: boolean;
  openCommandHandles: boolean;
  pendingExperiment?: { scopeKey: string };
  outstandingSubagents: readonly {
    id: string;
    taskId: string;
    status: string;
  }[];
  commandEnvironmentFault?: string;
}

function dagObligation(graph: Readonly<TaskGraph>): CompletionObligation | undefined {
  if (graph.status !== "active" && graph.status !== "waiting_input") return undefined;
  const unfinished = graph.tasks.filter(task => task.status !== "completed");
  return {
    id: `dag:${graph.id}:${unfinished.map(task => `${task.id}:${task.status}`).join(",")}`,
    kind: "dag_active",
    description: `Task DAG ${graph.id} is ${graph.status} with ${unfinished.length} unfinished node(s).`,
    requiredAction: graph.status === "waiting_input"
      ? "Resolve or report the recorded recoverable blockers before finishing."
      : "Continue, block with durable evidence, or complete every remaining DAG node before finishing.",
  };
}

export function evaluateCompletionGate(input: CompletionGateInput): CompletionObligation[] {
  const obligations: CompletionObligation[] = [];
  if (input.reconciliationPending) obligations.push({
    id: "context:reconciliation",
    kind: "context_reconciliation",
    description: "Context-reset reconciliation is incomplete.",
    requiredAction: "Inspect the workspace and query every original pending command, child and DAG state before finishing.",
  });
  if (input.openCommandHandles) obligations.push({
    id: "commands:open-handles",
    kind: "background_commands",
    description: "One or more supervised commands have not been observed in a terminal state.",
    requiredAction: "Poll or cancel the original command handles and collect their terminal results. Do not rerun them.",
  });
  if (input.commandEnvironmentFault) obligations.push({
    id: `command-environment:${sha256(input.commandEnvironmentFault)}`,
    kind: "command_environment",
    description: "The command environment is quarantined, so mutation and verification tools are unavailable.",
    requiredAction: "Continue safe read-only analysis if useful. Do not replay an uncertain command. Ask the user to repair and verify cleanup before further mutations.",
  });
  if (input.pendingExperiment) obligations.push({
    id: `experiment:${input.pendingExperiment.scopeKey}`,
    kind: "progress_experiment",
    description: "A required progress experiment has not produced a real terminal verification result.",
    requiredAction: "Run the recorded falsifiable experiment and record its terminal result before finishing.",
  });
  if (input.role === "subagent") obligations.push({
    id: "subagent:submit-result",
    kind: "subagent_submission",
    description: "The child has not submitted its bound result through submit_task_result.",
    requiredAction: "Submit either completed evidence for every bound completion check or a concrete blocker.",
  });
  if (input.role === "main_agent" && input.outstandingSubagents.length) obligations.push({
    id: `subagents:${input.outstandingSubagents.map(agent => `${agent.id}:${agent.status}`).sort().join(",")}`,
    kind: "collect_subagents",
    description: `${input.outstandingSubagents.length} child result(s) are running or uncollected.`,
    requiredAction: "Wait for running children and collect every terminal result before finishing.",
  });
  const dag = input.state.taskGraph ? dagObligation(input.state.taskGraph) : undefined;
  if (dag) obligations.push(dag);
  // Review objections remain durable evidence, but they are not a hard
  // completion protocol. Safety, command cleanup, DAG and child collection
  // obligations above remain mandatory.
  if (input.mode === "plan") obligations.push({
    id: "plan:proposal",
    kind: "plan_proposal",
    description: "Plan mode has no accepted propose_plan result for this turn.",
    requiredAction: "Submit the complete plan with propose_plan before finishing the turn.",
  });
  return obligations;
}

export function renderCompletionCorrection(
  obligations: readonly CompletionObligation[],
  attempt: number,
  remaining: number,
): string {
  return "RUNTIME_COMPLETION_REQUIRED\n" + JSON.stringify({
    attempt,
    remainingCorrections: remaining,
    warning: "The previous answer was recorded as a proposed completion, not a completed task.",
    obligations,
  });
}
