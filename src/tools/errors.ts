import { ZodError } from "zod";
import type { AgentTool, ToolExecutionResult, ToolFailureInfo } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { jsonForModel } from "../utils/json.js";
import { projectText } from "../utils/bounded-text.js";

/** Projection only, after raw evidence has been archived. Never reuse this
 * object as executable arguments, file-read authority or verification facts. */
function projectResultData(data: unknown, budget: number): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const source = data as Record<string, any>;
  const result: Record<string, any> = { ...source, truncated: true };
  const prefix = (text: string, room: number) => projectText(text, Math.max(0, room)).text;
  const headTail = (text: string, room: number) => {
    if (text.length <= room) return text;
    const marker = "\n[omitted; recall captured evidence]\n";
    const half = Math.max(0, Math.floor((room - marker.length) / 2));
    let tail = text.slice(-half);
    if (half === 0) tail = "";
    if (/^[\uDC00-\uDFFF]/u.test(tail)) tail = tail.slice(1);
    return prefix(text, half) + marker + tail;
  };
  if (source.stdout && source.stderr && typeof source.stdout.text === "string" && typeof source.stderr.text === "string") {
    const room = Math.floor(budget / 2);
    result.stdout = { ...source.stdout, text: headTail(source.stdout.text, room), truncated: true };
    result.stderr = { ...source.stderr, text: headTail(source.stderr.text, room), truncated: true };
  } else if (typeof source.content === "string") {
    const text = prefix(source.content, budget);
    if (Number.isInteger(source.startLine) && Number.isInteger(source.endLine) && source.path) {
      const fullLines = text.length === source.content.length ? text : text.slice(0, Math.max(0, text.lastIndexOf("\n")));
      result.content = fullLines;
      result.endLine = fullLines ? source.startLine + fullLines.split("\n").length - 1 : source.startLine - 1;
      result.nextStartLine = result.endLine + 1;
    } else {
      result.content = text;
      if (Number.isInteger(source.offset)) result.nextOffset = source.offset + text.length;
    }
  } else if (Array.isArray(source.matches)) {
    const matches: unknown[] = [];
    let chars = 2;
    for (const match of source.matches) {
      const cost = jsonForModel(match).length + 1;
      if (chars + cost > budget) break;
      matches.push(match); chars += cost;
    }
    result.matches = matches;
    result.stopReason = "result_budget";
  }
  return result;
}

const MAX_ISSUES = 12;
const EXCLUSIVE_PROTOCOL_ERRORS = new Set([
  "context_compaction_required", "context_compaction_must_be_exclusive",
  "compact_context_must_be_exclusive", "manage_tasks_must_be_exclusive",
  "manage_subagents_must_not_mix_with_other_tools", "propose_plan_must_be_exclusive",
  "submit_task_result_must_be_exclusive",
]);
const safeText = (value: string, limit: number) => redactSensitiveInformation(value).slice(0, limit);

class InvalidToolJson extends Error {}
class InvalidToolParameters extends Error {
  constructor(readonly cause: ZodError) { super("Tool parameters do not satisfy the schema."); }
}

/** No tool side effects occur before this function returns. Never invent defaults. */
export function prepareToolInput(tool: AgentTool, argumentsJson: string): unknown {
  let input: unknown;
  try { input = JSON.parse(argumentsJson); }
  catch { throw new InvalidToolJson("Tool arguments must be valid JSON."); }
  try {
    // Validate without replacing the original input: tools own normalization,
    // and transformations such as secret sanitization need not be idempotent.
    tool.inputSchema?.parse(input);
    return input;
  } catch (error) {
    if (error instanceof ZodError) throw new InvalidToolParameters(error);
    throw error;
  }
}

export function describeToolFailure(error: unknown): ToolFailureInfo {
  const preflight = error instanceof InvalidToolParameters;
  if (error instanceof InvalidToolParameters) error = error.cause;
  if (error instanceof ZodError) {
    return {
      version: 1, kind: "validation", code: "invalid_parameters",
      execution: preflight ? "not_started" : "unknown",
      recovery: preflight ? "correct_arguments" : "inspect_state",
      issues: error.issues.slice(0, MAX_ISSUES).map((issue) => ({
        path: safeText(issue.path.map(String).join("."), 160) || "$",
        code: issue.code,
        ...("expected" in issue ? { expected: String(issue.expected).slice(0, 64) } : {}),
        // Zod messages may contain enum/input values. Do not echo those values.
        message: issue.code === "invalid_type" && issue.received === "undefined"
          ? "Required field is missing."
          : "Value does not satisfy the declared tool schema.",
      })),
      ...(error.issues.length > MAX_ISSUES ? { issuesTruncated: true } : {}),
      instruction: preflight
        ? "Correct the listed fields using the tool schema and existing evidence; preserve valid fields. Submit a complete corrected call. Do not invent constraints, evidence, IDs or true coverage flags. No tool action was executed."
        : "Validation failed inside tool execution. Inspect current state before correcting fields; do not assume no effects occurred or blindly replay the action.",
    };
  }
  if (error instanceof InvalidToolJson) {
    return {
      version: 1, kind: "validation", code: "invalid_json",
      execution: "not_started", recovery: "correct_arguments",
      issues: [{ path: "$", code: "invalid_json", message: "Submit one complete valid JSON object matching the tool schema." }],
      instruction: "Repair JSON syntax without changing the intended action. No tool action was executed.",
    };
  }
  return {
    version: 1, kind: "execution", code: "tool_execution_failed",
    execution: "unknown", recovery: "inspect_state", issues: [],
    instruction: "Inspect the reported error and current state before deciding what to do. Do not automatically replay mutations, bypass a denial, or treat an unknown outcome as not executed.",
  };
}

export function protocolToolFailure(code: string, instruction: string): ToolFailureInfo {
  return {
    version: 1, kind: "protocol", code: safeText(code, 80), execution: "not_started",
    recovery: "correct_arguments", issues: [], instruction: safeText(instruction, 2_000),
  };
}

export function normalizeToolFailure(result: ToolExecutionResult): ToolExecutionResult {
  if (result.ok || result.failure) return result;
  if (result.error && EXCLUSIVE_PROTOCOL_ERRORS.has(result.error)) {
    return { ...result, failure: protocolToolFailure(result.error,
      "The batch was rejected before execution. Follow the tool exclusivity requirement and resubmit only the permitted call(s); do not claim any rejected action ran.") };
  }
  // Adapt the command subsystem's existing authoritative failure metadata.
  const data = result.data as { lifecycle?: { execution?: string }; failure?: { kind?: string; code?: string; processStarted?: boolean; executionState?: string } } | undefined;
  const command = data?.failure;
  if (command && typeof command.code === "string" && typeof command.processStarted === "boolean") {
    const execution = data?.lifecycle?.execution ?? command.executionState ?? (command.processStarted ? "unknown" : "not_started");
    const parameter = command.kind === "parameter" && execution === "not_started";
    const denied = command.kind === "policy" || command.kind === "approval";
    return { ...result, failure: {
      version: 1, kind: parameter ? "validation" : "execution", code: safeText(command.code, 80),
      execution: execution === "not_started" ? "not_started" : "unknown",
      recovery: parameter ? "correct_arguments" : denied ? "none" : "inspect_state",
      issues: [], instruction: parameter
        ? "Correct command parameters according to the schema; the process did not start."
        : denied ? "The action was denied. Do not bypass the denial or automatically retry it."
          : "Inspect command status and recorded output before deciding whether to retry. A process may already have produced effects.",
    } };
  }
  return { ...result, failure: describeToolFailure(result.error) };
}

/** Keep actionable field paths ahead of verbose error strings under output pressure. */
export function toolResultForModel(result: ToolExecutionResult, maximumChars: number): string {
  const data = result.data as { commandId?: unknown; status?: unknown; exitCode?: unknown } | undefined;
  const commandState = typeof data?.commandId === "string" && typeof data.status === "string"
    ? { commandId: data.commandId.slice(0, 80), status: data.status.slice(0, 80),
      ...(typeof data.exitCode === "number" || data.exitCode === null ? { exitCode: data.exitCode } : {}) } : {};
  const payload = {
    evidenceId: result.evidenceId,
    ok: result.ok, summary: result.summary, data: result.data,
    error: result.error, failure: result.failure,
  };
  const encode = jsonForModel;
  const full = encode(payload);
  if (full.length <= maximumChars) return full;
  // Spend the payload budget on useful whole records before falling back to
  // identifiers. JSON escaping and the complete metadata are measured together.
  for (let room = Math.floor(maximumChars * 0.75); room >= 128; room = Math.floor(room / 2)) {
    const projected = encode({ ...payload, summary: projectText(result.summary, Math.min(room, 512)).text,
      data: projectResultData(result.data, room) });
    if (projected.length <= maximumChars) return projected;
  }
  const failure = result.failure ? { ...result.failure, issues: [...result.failure.issues] } : undefined;
  if (failure) {
    while (true) {
      const bounded = encode({ evidenceId: result.evidenceId, ok: result.ok, summary: result.summary.slice(0, 100), failure,
        data: { ...commandState, truncated: true } });
      if (bounded.length <= maximumChars) return bounded;
      if (failure.issues.length <= 1) break;
      failure.issues.pop();
      failure.issuesTruncated = true;
    }
    const compact = encode({ evidenceId: result.evidenceId, ok: false, data: { ...commandState, truncated: true }, failure: {
      code: failure.code, execution: failure.execution, recovery: failure.recovery,
      issues: failure.issues.map(({ path, expected }) => ({ path, expected })),
      issuesTruncated: true,
    } });
    if (compact.length <= maximumChars) return compact;
  }
  let textBudget = Math.max(0, Math.floor((maximumChars - 120) / 2));
  while (true) {
    const bounded = encode({
      evidenceId: result.evidenceId,
      ok: result.ok, summary: result.summary.slice(0, textBudget),
      ...(result.error ? { error: result.error.slice(0, textBudget) } : {}),
      data: { ...commandState, truncated: true, originalChars: full.length },
    });
    if (bounded.length <= maximumChars) return bounded;
    if (textBudget === 0) return encode({ ok: result.ok, data: { truncated: true } });
    textBudget = Math.floor(textBudget / 2);
  }
}
