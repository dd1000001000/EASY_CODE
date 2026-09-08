import type { ChatMessage, ToolExecutionResult } from "../core/types.js";
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from "../config/runtime-limits.js";
import { sha256 } from "../utils/hash.js";
import { summarizeVerification } from "./command-summary.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function excerpt(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = "\n[output omitted; recall evidenceId for captured output]\n";
  const room = Math.max(0, limit - marker.length);
  if (limit <= marker.length) return marker.slice(0, limit);
  const tail = Math.floor(room / 2);
  return value.slice(0, Math.ceil(room / 2)) + marker + (tail ? value.slice(-tail) : "");
}

function previousCommand(messages: readonly ChatMessage[], id: string): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "tool" || !["run_command", "start_command", "poll_command", "cancel_command"].includes(message.name ?? "")) continue;
    try {
      const value = JSON.parse(message.content);
      if (record(value?.data) && value.data.commandId === id) return value.data;
    } catch { /* Legacy/clipped output is not a cursor. */ }
  }
  return undefined;
}

function streamDelta(stream: Record<string, unknown>, previous: unknown) {
  const text = stream.text as string;
  const cursor = { chars: text.length, hash: sha256(text), sourceTruncated: stream.truncated === true };
  const prior = record(previous) ? previous : undefined;
  const appendOnly = prior && Number.isSafeInteger(prior.chars) && Number(prior.chars) >= 0 &&
    Number(prior.chars) <= text.length && prior.sourceTruncated === false && !cursor.sourceTruncated &&
    prior.hash === sha256(text.slice(0, Number(prior.chars)));
  return { text: appendOnly ? text.slice(Number(prior.chars)) : text, cursor,
    mode: appendOnly ? "delta" : "snapshot", gap: Boolean(prior && !appendOnly) };
}

/** Pure model projection. Never pass this to ProgressGuard or the evidence journal. */
export function projectToolResult(result: ToolExecutionResult,
  limits: Readonly<RuntimeLimits> = DEFAULT_RUNTIME_LIMITS,
  context: { intent?: string; previousMessages?: readonly ChatMessage[] } = {}): ToolExecutionResult {
  const data = result.data;
  if (!record(data) || typeof data.commandId !== "string" || typeof data.status !== "string" ||
      !record(data.stdout) || !record(data.stderr) || typeof data.stdout.text !== "string" || typeof data.stderr.text !== "string") return result;
  const previous = previousCommand(context.previousMessages ?? [], data.commandId);
  const intent = context.intent ?? (typeof previous?.intent === "string" ? previous.intent : undefined);
  const verification = ["test", "verify", "build"].includes(intent ?? "");
  const maximum = intent === "inspect" ? limits.commandQueryChars : result.ok ? limits.commandSuccessChars : limits.commandFailureChars;
  const priorCursor = record(previous?.outputCursor) ? previous.outputCursor : undefined;
  const out = streamDelta(data.stdout, priorCursor?.stdout);
  const err = streamDelta(data.stderr, priorCursor?.stderr);
  // First terminal observation always summarizes the cumulative capture, never just a delta.
  const firstTerminal = data.status !== "running" && (!previous || previous.status === "running");
  const terminalSummary = firstTerminal && verification && data.status === "exited" &&
    !data.stdout.truncated && !data.stderr.truncated
    ? summarizeVerification(data.stdout.text + "\n" + data.stderr.text, limits.commandMaxDiagnostics) : undefined;
  const stdoutText = terminalSummary
    ? terminalSummary.reportedSummary + "\n" + terminalSummary.diagnostics.map((item) =>
      item.text + (item.occurrences > 1 ? `\n[exact repeat x${item.occurrences}]` : "")).join("\n")
    : firstTerminal ? data.stdout.text : out.text;
  const stderrText = terminalSummary ? "" : firstTerminal ? data.stderr.text : err.text;
  const stdoutLimit = Math.min(stdoutText.length, stderrText.length === 0 ? maximum : Math.floor(maximum / 2));
  const stderrLimit = maximum - stdoutLimit;
  const digest = (stream: Record<string, unknown>, text: string, limit: number) => ({
    text: excerpt(text, limit), totalBytes: stream.totalBytes,
    truncated: stream.truncated === true || text.length > limit,
  });
  return { ...result, data: {
    commandId: data.commandId, status: data.status, exitCode: data.exitCode,
    intent,
    signal: data.signal, durationMs: data.durationMs,
    stdout: digest(data.stdout, stdoutText, stdoutLimit), stderr: digest(data.stderr, stderrText, stderrLimit),
    outputCursor: { stdout: out.cursor, stderr: err.cursor },
    outputMode: firstTerminal ? "terminal_snapshot" : out.mode === "delta" && err.mode === "delta" ? "delta" : "snapshot",
    outputGap: out.gap || err.gap,
    outputCompressed: Boolean(terminalSummary),
    ...(terminalSummary ? { verificationSummary: { framework: terminalSummary.framework,
      diagnosticsTruncated: terminalSummary.diagnosticsTruncated, source: "reported_output_not_requirement_verification" } } : {}),
    workspaceDelta: data.workspaceDelta,
    // Keep infrastructure failure classification; never reinterpret it as a test failure.
    failure: data.failure, sandboxFailure: data.sandboxFailure,
    ...(!result.ok ? { policyDecision: data.policyDecision } : {}),
    evidenceId: result.evidenceId,
  } };
}
