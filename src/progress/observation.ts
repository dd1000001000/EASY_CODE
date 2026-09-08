import type { ToolExecutionResult } from "../core/types.js";
import {
  VERIFICATION_KINDS,
  type VerificationKind,
} from "../command/types.js";
import { sha256 } from "../utils/hash.js";
import {
  PROGRESS_OBSERVATION_SCHEMA_VERSION,
  type ProgressObservation,
  type ProgressObservationBinding,
  type ProgressObservationKind,
  type ProgressOutcomeClass,
} from "./types.js";

const MAX_IDENTIFIER_CHARS = 256;
const MAX_SCOPE_CHARS = 512;
const MAX_KEY_CHARS = 256;
const MAX_TOOL_CHARS = 128;
const MAX_HASH_INPUT_CHARS = 64 * 1024;
const COMMAND_ID = /^command_[0-9a-f-]{36}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

const OBSERVATION_KEYS = new Set([
  "schemaVersion",
  "sourceEventId",
  "sourceCallId",
  "scopeKey",
  "responseOrdinal",
  "tool",
  "kind",
  "confidence",
  "outcomeClass",
  "verificationKind",
  "verificationCycleId",
  "commandId",
  "targetKey",
  "outcomeKey",
  "evidenceDigest",
  "searchRepeatLimit",
]);

const COMMAND_TOOLS = new Set([
  "run_command",
  "start_command",
  "poll_command",
  "cancel_command",
]);

const TERMINAL_STATUSES = new Set([
  "exited",
  "timed_out",
  "canceled",
  "spawn_failed",
  "policy_denied",
  "sandbox_unavailable",
]);

const INFRASTRUCTURE_STATUSES = new Set([
  "canceled",
  "spawn_failed",
  "policy_denied",
  "sandbox_unavailable",
]);

export interface ObserveToolResultInput {
  readonly sourceEventId: string;
  readonly sourceCallId: string;
  readonly scopeKey: string;
  readonly responseOrdinal: number;
  readonly tool: string;
  readonly result: Readonly<ToolExecutionResult>;
  /** Runtime-owned classification; ordinary inspect/install/run failures are not verification. */
  readonly verificationIntent?: boolean;
  /** Runtime-normalized verification category; never inferred from command output text. */
  readonly verificationKind?: VerificationKind;
  /** Optional Runtime-owned override when it has a stronger target identity. */
  readonly targetKey?: string;
  /** Optional Runtime-owned cycle identity; commandId is the default. */
  readonly verificationCycleId?: string;
}

interface CommandResultData extends Record<string, unknown> {
  commandId: string;
  status: string;
  exitCode: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(
  value: unknown,
  maximum: number,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    UNSAFE_TEXT.test(value)
  ) {
    throw new Error(`Invalid ProgressObservation ${field}`);
  }
}

function optionalSafeText(value: unknown, maximum: number, field: string): void {
  if (value !== undefined) safeText(value, maximum, field);
}

function boundedHashText(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length <= MAX_HASH_INPUT_CHARS) return value;
  const half = Math.floor(MAX_HASH_INPUT_CHARS / 2);
  return `${value.slice(0, half)}\n[omitted:${value.length - (half * 2)}]\n${value.slice(-half)}`;
}

function digest(value: unknown): string {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

function outputText(value: unknown): string {
  if (!isRecord(value)) return "";
  return boundedHashText(value.text);
}

function commandData(value: unknown): CommandResultData | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.commandId !== "string" ||
    !COMMAND_ID.test(value.commandId) ||
    typeof value.status !== "string" ||
    (!TERMINAL_STATUSES.has(value.status) && value.status !== "running") ||
    (value.exitCode !== null && !Number.isInteger(value.exitCode))
  ) {
    return undefined;
  }
  return value as CommandResultData;
}

function commandTargetKey(data: CommandResultData, override?: string): string {
  if (override !== undefined) return override;
  const executed = isRecord(data.executed) ? data.executed : undefined;
  return digest({
    program: typeof executed?.program === "string" ? executed.program : "unknown",
    args: Array.isArray(executed?.args)
      ? executed.args.filter((argument): argument is string => typeof argument === "string")
      : [],
    cwd: typeof executed?.cwd === "string" ? executed.cwd : ".",
  });
}

function commandEvidenceDigest(data: CommandResultData): string {
  const failure = isRecord(data.failure) ? data.failure : undefined;
  return digest({
    status: data.status,
    exitCode: data.exitCode,
    failureKind: typeof failure?.kind === "string" ? failure.kind : undefined,
    failureCode: typeof failure?.code === "string" ? failure.code : undefined,
    stdout: outputText(data.stdout),
    stderr: outputText(data.stderr),
  });
}

function readObservation(input: ObserveToolResultInput): ProgressObservation | undefined {
  if (input.tool !== "read_file" || !input.result.ok || !isRecord(input.result.data)) {
    return undefined;
  }
  const data = input.result.data;
  if (
    typeof data.path !== "string" ||
    !Number.isSafeInteger(data.startLine) ||
    Number(data.startLine) < 1 ||
    !Number.isSafeInteger(data.endLine) ||
    Number(data.endLine) < Number(data.startLine) ||
    typeof data.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(data.contentHash)
  ) {
    return undefined;
  }
  const targetKey = input.targetKey ?? digest({
    path: data.path,
    startLine: data.startLine,
    endLine: data.endLine,
  });
  return {
    schemaVersion: PROGRESS_OBSERVATION_SCHEMA_VERSION,
    sourceEventId: input.sourceEventId,
    sourceCallId: input.sourceCallId,
    scopeKey: input.scopeKey,
    responseOrdinal: input.responseOrdinal,
    tool: input.tool,
    kind: "read",
    confidence: "high",
    outcomeClass: "unknown",
    targetKey,
    outcomeKey: `sha256:${data.contentHash}`,
    evidenceDigest: digest({
      targetKey,
      contentHash: data.contentHash,
      totalLines: Number.isSafeInteger(data.totalLines) ? data.totalLines : undefined,
      truncated: data.truncated === true,
    }),
  };
}

function commandObservation(
  input: ObserveToolResultInput,
): ProgressObservation | undefined {
  if (!COMMAND_TOOLS.has(input.tool)) return undefined;
  const data = commandData(input.result.data);
  if (!data) return undefined;
  if (data.status === "running") {
    // Omitting commandId is intentional: a running poll must not consume the
    // terminal de-duplication key needed by a later terminal result.
    return {
      schemaVersion: PROGRESS_OBSERVATION_SCHEMA_VERSION,
      sourceEventId: input.sourceEventId,
      sourceCallId: input.sourceCallId,
      scopeKey: input.scopeKey,
      responseOrdinal: input.responseOrdinal,
      tool: input.tool,
      kind: "neutral",
      confidence: "high",
      outcomeClass: "unknown",
      evidenceDigest: digest({ commandId: data.commandId, status: data.status }),
    };
  }

  const evidenceDigest = commandEvidenceDigest(data);
  if (INFRASTRUCTURE_STATUSES.has(data.status)) {
    return {
      schemaVersion: PROGRESS_OBSERVATION_SCHEMA_VERSION,
      sourceEventId: input.sourceEventId,
      sourceCallId: input.sourceCallId,
      scopeKey: input.scopeKey,
      responseOrdinal: input.responseOrdinal,
      tool: input.tool,
      kind: "infrastructure_failure",
      confidence: "high",
      outcomeClass: "unknown",
      commandId: data.commandId,
      evidenceDigest,
    };
  }

  if (input.verificationIntent !== true) {
    return {
      schemaVersion: PROGRESS_OBSERVATION_SCHEMA_VERSION,
      sourceEventId: input.sourceEventId,
      sourceCallId: input.sourceCallId,
      scopeKey: input.scopeKey,
      responseOrdinal: input.responseOrdinal,
      tool: input.tool,
      kind: "neutral",
      confidence: "low",
      outcomeClass: "unknown",
      evidenceDigest,
    };
  }

  const targetKey = commandTargetKey(data, input.targetKey);
  const outcomeClass: ProgressOutcomeClass = data.status === "timed_out"
    ? "timed_out"
    : data.exitCode === 0
      ? "passed"
      : "failed";
  return {
    schemaVersion: PROGRESS_OBSERVATION_SCHEMA_VERSION,
    sourceEventId: input.sourceEventId,
    sourceCallId: input.sourceCallId,
    scopeKey: input.scopeKey,
    responseOrdinal: input.responseOrdinal,
    tool: input.tool,
    kind: "verification_terminal",
    confidence: "high",
    outcomeClass,
    verificationKind: input.verificationKind ?? "custom",
    verificationCycleId: input.verificationCycleId ?? data.commandId,
    commandId: data.commandId,
    targetKey,
    outcomeKey: outcomeClass === "passed" ? "passed" : evidenceDigest,
    evidenceDigest,
  };
}

function neutralObservation(input: ObserveToolResultInput): ProgressObservation {
  return {
    schemaVersion: PROGRESS_OBSERVATION_SCHEMA_VERSION,
    sourceEventId: input.sourceEventId,
    sourceCallId: input.sourceCallId,
    scopeKey: input.scopeKey,
    responseOrdinal: input.responseOrdinal,
    tool: input.tool,
    kind: "neutral",
    confidence: "low",
    outcomeClass: "unknown",
    evidenceDigest: digest({
      ok: input.result.ok,
      summary: boundedHashText(input.result.summary),
      error: boundedHashText(input.result.error),
    }),
  };
}

function searchObservation(input: ObserveToolResultInput): ProgressObservation | undefined {
  if (input.tool !== "search_files" || !input.result.ok || !isRecord(input.result.data)) return undefined;
  const data = input.result.data;
  if (typeof data.searchIdentity !== "string" || !/^[a-f0-9]{64}$/u.test(data.searchIdentity) ||
      typeof data.outcomeIdentity !== "string" || !/^[a-f0-9]{64}$/u.test(data.outcomeIdentity) ||
      !Number.isInteger(data.repeatWarningCount) || Number(data.repeatWarningCount) < 2 || Number(data.repeatWarningCount) > 20) return undefined;
  // Discovery is not verification or read-before-write evidence. Only exact repeated outcomes prompt a weak hint.
  return { ...neutralObservation(input), targetKey: `sha256:${data.searchIdentity}`,
    outcomeKey: `sha256:${data.outcomeIdentity}`, searchRepeatLimit: Number(data.repeatWarningCount) };
}

/** Derive bounded evidence before Runtime discards/truncates the raw result. */
export function observeToolResult(input: ObserveToolResultInput): ProgressObservation {
  const observation = commandObservation(input) ??
    readObservation(input) ??
    searchObservation(input) ??
    neutralObservation(input);
  return parseProgressObservation(observation, {
    sourceEventId: input.sourceEventId,
    sourceCallId: input.sourceCallId,
    ...(observation.commandId ? { commandId: observation.commandId } : {}),
  });
}

export function assertProgressObservationBinding(
  observation: Readonly<ProgressObservation>,
  binding: Readonly<ProgressObservationBinding>,
): void {
  if (observation.sourceEventId !== binding.sourceEventId) {
    throw new Error("ProgressObservation sourceEventId does not match its tool.result event");
  }
  if (observation.sourceCallId !== binding.sourceCallId) {
    throw new Error("ProgressObservation sourceCallId does not match its tool.result callId");
  }
  if (binding.tool !== undefined && observation.tool !== binding.tool) {
    throw new Error("ProgressObservation tool does not match its tool.result event");
  }
  if (
    binding.commandId !== undefined &&
    observation.commandId !== binding.commandId
  ) {
    throw new Error("ProgressObservation commandId does not match its authoritative tool result");
  }
}

/** Strictly validate and detach untrusted journal material. */
export function parseProgressObservation(
  value: unknown,
  binding?: Readonly<ProgressObservationBinding>,
): ProgressObservation {
  if (!isRecord(value) || Object.keys(value).some((key) => !OBSERVATION_KEYS.has(key))) {
    throw new Error("Invalid ProgressObservation shape");
  }
  safeText(value.sourceEventId, MAX_IDENTIFIER_CHARS, "sourceEventId");
  safeText(value.sourceCallId, MAX_IDENTIFIER_CHARS, "sourceCallId");
  safeText(value.scopeKey, MAX_SCOPE_CHARS, "scopeKey");
  safeText(value.tool, MAX_TOOL_CHARS, "tool");
  optionalSafeText(value.verificationCycleId, MAX_IDENTIFIER_CHARS, "verificationCycleId");
  optionalSafeText(value.targetKey, MAX_KEY_CHARS, "targetKey");
  optionalSafeText(value.outcomeKey, MAX_KEY_CHARS, "outcomeKey");
  if (
    value.schemaVersion !== PROGRESS_OBSERVATION_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.responseOrdinal) ||
    Number(value.responseOrdinal) < 0 ||
    !["read", "verification_terminal", "infrastructure_failure", "neutral"].includes(
      String(value.kind),
    ) ||
    (value.confidence !== "high" && value.confidence !== "low") ||
    !["passed", "failed", "timed_out", "unknown"].includes(String(value.outcomeClass)) ||
    (value.commandId !== undefined &&
      (typeof value.commandId !== "string" || !COMMAND_ID.test(value.commandId))) ||
    (value.evidenceDigest !== undefined &&
      (typeof value.evidenceDigest !== "string" || !SHA256_DIGEST.test(value.evidenceDigest))) ||
    (value.verificationKind !== undefined &&
      !VERIFICATION_KINDS.includes(value.verificationKind as VerificationKind))
  ) {
    throw new Error("Invalid ProgressObservation fields");
  }

  const kind = value.kind as ProgressObservationKind;
  const outcomeClass = value.outcomeClass as ProgressOutcomeClass;
  if (value.searchRepeatLimit !== undefined && (value.tool !== "search_files" || kind !== "neutral" ||
      !Number.isInteger(value.searchRepeatLimit) || Number(value.searchRepeatLimit) < 2 || Number(value.searchRepeatLimit) > 20 ||
      typeof value.targetKey !== "string" || !SHA256_DIGEST.test(value.targetKey) ||
      typeof value.outcomeKey !== "string" || !SHA256_DIGEST.test(value.outcomeKey))) {
    throw new Error("Invalid search repetition evidence");
  }
  if (
    kind === "verification_terminal" &&
    (
      value.verificationCycleId === undefined ||
      value.targetKey === undefined ||
      value.evidenceDigest === undefined ||
      (outcomeClass !== "unknown" && value.outcomeKey === undefined)
    )
  ) {
    throw new Error("A verification ProgressObservation requires bounded cycle and target evidence");
  }
  if (
    kind === "read" &&
    (value.confidence !== "high" || outcomeClass !== "unknown" || value.targetKey === undefined)
  ) {
    throw new Error("A read ProgressObservation requires one high-confidence target");
  }
  if (
    (kind === "neutral" || kind === "infrastructure_failure") &&
    outcomeClass !== "unknown"
  ) {
    throw new Error("Non-verification ProgressObservations must have unknown outcome");
  }
  if (
    kind !== "verification_terminal" && value.verificationCycleId !== undefined
  ) {
    throw new Error("Only verification observations may identify a verification cycle");
  }
  if (kind !== "verification_terminal" && value.verificationKind !== undefined) {
    throw new Error("Only verification observations may identify a verification kind");
  }
  if (kind === "neutral" && value.commandId !== undefined) {
    throw new Error("Neutral observations must not consume a terminal command ID");
  }

  const parsed: ProgressObservation = {
    schemaVersion: PROGRESS_OBSERVATION_SCHEMA_VERSION,
    sourceEventId: value.sourceEventId,
    sourceCallId: value.sourceCallId,
    scopeKey: value.scopeKey,
    responseOrdinal: Number(value.responseOrdinal),
    tool: value.tool,
    kind,
    confidence: value.confidence,
    outcomeClass,
    ...(value.searchRepeatLimit !== undefined ? { searchRepeatLimit: Number(value.searchRepeatLimit) } : {}),
    ...(kind === "verification_terminal"
      ? {
          verificationKind: typeof value.verificationKind === "string"
            ? value.verificationKind as VerificationKind
            : "custom",
        }
      : {}),
    ...(typeof value.verificationCycleId === "string"
      ? { verificationCycleId: value.verificationCycleId }
      : {}),
    ...(typeof value.commandId === "string" ? { commandId: value.commandId } : {}),
    ...(typeof value.targetKey === "string" ? { targetKey: value.targetKey } : {}),
    ...(typeof value.outcomeKey === "string" ? { outcomeKey: value.outcomeKey } : {}),
    ...(typeof value.evidenceDigest === "string"
      ? { evidenceDigest: value.evidenceDigest }
      : {}),
  };
  if (binding) assertProgressObservationBinding(parsed, binding);
  return parsed;
}
