import { z } from "zod";
import type { SessionState } from "../core/types.js";
import { sha256 } from "../utils/hash.js";

export const completionObligationKinds = [
  "context_reconciliation",
  "background_commands",
  "subagent_submission",
  "collect_subagents",
  "planning_dag",
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
  planning?: boolean;
  reconciliationPending: boolean;
  openCommandHandles: boolean;
  outstandingSubagents: readonly {
    id: string;
    taskId: string;
    status: string;
  }[];
}

export function evaluateCompletionGate(input: CompletionGateInput): CompletionObligation[] {
  const obligations: CompletionObligation[] = [];
  if (input.planning && input.role === "main_agent" && input.state.taskGraph &&
      input.state.taskGraph.status !== "completed") obligations.push({
    id: `planning-dag:${input.state.taskGraph.id}:${input.state.taskGraph.status}`,
    kind: "planning_dag",
    description: "The planning task DAG is unfinished.",
    requiredAction: "Complete or resolve every planning task before proposing the plan.",
  });
  if (input.reconciliationPending) obligations.push({
    id: "context:reconciliation",
    kind: "context_reconciliation",
    description: "Context-reset reconciliation is incomplete.",
    requiredAction: "Observe the original pending command and child handles before finishing.",
  });
  if (input.openCommandHandles) obligations.push({
    id: "commands:open-handles",
    kind: "background_commands",
    description: "One or more supervised commands have not been observed in a terminal state.",
    requiredAction: "Poll or cancel the original command handles and collect their terminal results. Do not rerun them.",
  });
  if (input.role === "subagent") obligations.push({
    id: "subagent:submit-result",
    kind: "subagent_submission",
    description: "The child has not submitted its bound result through submit_task_result.",
    requiredAction: "Submit concise completion evidence or a concrete blocker for the bound assignment.",
  });
  if (input.role === "main_agent" && input.outstandingSubagents.length) obligations.push({
    id: `subagents:${input.outstandingSubagents.map(agent => `${agent.id}:${agent.status}`).sort().join(",")}`,
    kind: "collect_subagents",
    description: `${input.outstandingSubagents.length} child result(s) are running or uncollected.`,
    requiredAction: "Wait for running children and collect every terminal result before finishing.",
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
