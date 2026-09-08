import {
  DEFAULT_THINKING_EFFORT,
  THINKING_EFFORTS,
  type ThinkingEffort,
  type ChatMessage,
  type CommandAuditEntry,
  type ContextCompactionMetadata,
  type FileChangeRecord,
  type FileVersion,
  type ImageAttachment,
  type PlanReviewState,
  type PromptBundleBinding,
  type SessionState,
  type TaskGraph,
  type TurnSteeringEntry,
} from "../core/types.js";
import { validateImageAttachmentCollection } from "../images/image-store.js";
import { isProviderName } from "../models/catalog.js";
import { clonePlanReviewState } from "../plans/plan.js";
import { cloneTaskGraph, isTaskGraph } from "../tasks/task-graph.js";
import { validateCommandApprovalPrefixes } from "../command/approval.js";
import { sha256 } from "../utils/hash.js";

export interface SerializedSessionState {
  readonly orchestrationEnabled?: boolean;
  readonly threadId: string;
  readonly activeTurnId?: string;
  readonly mode: SessionState["mode"];
  readonly provider: SessionState["provider"];
  readonly model: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly workspaceRoot: string;
  /** Optional only for checkpoints created before Prompt Bundle binding. */
  readonly promptBundle?: PromptBundleBinding;
  readonly goal?: string;
  readonly constraints: string[];
  readonly messages: ChatMessage[];
  readonly filesRead: Array<[string, FileVersion]>;
  readonly changes: FileChangeRecord[];
  readonly commands: CommandAuditEntry[];
  /** Optional only for checkpoint compatibility; new checkpoints always write it. */
  readonly commandApprovalPrefixes?: string[];
  readonly taskGraph?: TaskGraph;
  readonly planReview?: PlanReviewState;
  readonly pendingSteering?: TurnSteeringEntry[];
  readonly steeringSequence?: number;
  readonly steeringWatermark?: number;
  readonly steeringSealedTurnId?: string;
  readonly workingSummary: string;
  readonly compactedMessageCount: number;
  readonly contextIntentLedger?: SessionState["contextIntentLedger"];
  readonly contextCompactionMetadata?: SessionState["contextCompactionMetadata"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A bounded, append-only patch over the state reconstructed immediately before
 * its journal event. Runtime-authoritative fields (turn/task/plan/approval and
 * steering state) deliberately have no representation here.
 */
export interface SerializedThreadCheckpointDelta {
  readonly formatVersion: 1;
  readonly baseSequence: number;
  readonly settings?: {
    readonly orchestrationEnabled?: boolean;
    readonly mode?: SessionState["mode"];
    readonly provider?: SessionState["provider"];
    readonly model?: string;
    readonly thinkingEffort?: ThinkingEffort;
    readonly promptBundle?: PromptBundleBinding | null;
    readonly goal?: string | null;
    readonly constraints?: string[];
  };
  readonly messagesAppended?: ChatMessage[];
  readonly filesReadUpserted?: Array<[string, FileVersion]>;
  readonly filesReadRemoved?: string[];
  readonly changesAppended?: FileChangeRecord[];
  readonly commandsAppended?: CommandAuditEntry[];
  readonly compaction?: {
    readonly workingSummary: string;
    readonly compactedMessageCount: number;
    readonly contextIntentLedger?: SessionState["contextIntentLedger"];
    readonly contextCompactionMetadata?: SessionState["contextCompactionMetadata"];
  };
}

/** Prevent one save from turning an incremental record back into an unbounded snapshot. */
export const MAX_SERIALIZED_THREAD_CHECKPOINT_DELTA_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isContextSourceQuote(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ["sourceMessageIndex", "text"]) &&
    Number.isSafeInteger(value.sourceMessageIndex) &&
    Number(value.sourceMessageIndex) >= 0 &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    value.text.length <= 2_400;
}

function isContextIntentLedger(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      "latestRequest",
      "activeConstraints",
      "userCorrections",
      "supersededRequests",
    ]) &&
    isContextSourceQuote(value.latestRequest) &&
    Array.isArray(value.activeConstraints) &&
    value.activeConstraints.length <= 24 &&
    value.activeConstraints.every(isContextSourceQuote) &&
    Array.isArray(value.userCorrections) &&
    value.userCorrections.length <= 32 &&
    value.userCorrections.every(isContextSourceQuote) &&
    Array.isArray(value.supersededRequests) &&
    value.supersededRequests.length <= 32 &&
    value.supersededRequests.every(isContextSourceQuote);
}

function isContextCompactionMetadata(
  value: unknown,
): value is ContextCompactionMetadata {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "formatVersion",
    "sourceStartMessageIndex",
    "sourceEndMessageIndex",
    "compactedMessageCount",
    "sourceHistoryHash",
    "acceptedAt",
    "beforeProjectedChars",
    "afterProjectedChars",
    "savedChars",
    "savingsRatio",
    "postCompactionUtilization",
    "safeWaterlineReached",
    "targetRatio",
  ])) return false;
  const beforeProjectedChars = Number(value.beforeProjectedChars);
  const afterProjectedChars = Number(value.afterProjectedChars);
  const savedChars = Number(value.savedChars);
  const savingsRatio = Number(value.savingsRatio);
  const postCompactionUtilization = Number(value.postCompactionUtilization);
  const targetRatio = value.targetRatio === undefined ? 0.55 : value.targetRatio;
  return value.formatVersion === 2 &&
    Number.isSafeInteger(value.sourceStartMessageIndex) &&
    Number(value.sourceStartMessageIndex) >= 0 &&
    Number.isSafeInteger(value.sourceEndMessageIndex) &&
    Number(value.sourceEndMessageIndex) >= Number(value.sourceStartMessageIndex) &&
    Number.isSafeInteger(value.compactedMessageCount) &&
    Number(value.compactedMessageCount) >= Number(value.sourceEndMessageIndex) &&
    typeof value.sourceHistoryHash === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.sourceHistoryHash) &&
    typeof value.acceptedAt === "string" &&
    Number.isFinite(Date.parse(value.acceptedAt)) &&
    [
      value.beforeProjectedChars,
      value.afterProjectedChars,
      value.savedChars,
      value.savingsRatio,
      value.postCompactionUtilization,
    ].every((item) => typeof item === "number" && Number.isFinite(item)) &&
    beforeProjectedChars >= 0 &&
    afterProjectedChars >= 0 &&
    savedChars > 0 &&
    Math.abs((beforeProjectedChars - afterProjectedChars) - savedChars) < 1e-6 &&
    savingsRatio > 0 && savingsRatio <= 1 &&
    postCompactionUtilization >= 0 && postCompactionUtilization <= 1 &&
    typeof targetRatio === "number" && Number.isFinite(targetRatio) && targetRatio > 0 && targetRatio < 1 &&
    typeof value.safeWaterlineReached === "boolean" &&
    value.safeWaterlineReached === (postCompactionUtilization <= targetRatio);
}

function cloneContextIntentLedger(
  value: NonNullable<SessionState["contextIntentLedger"]>,
): NonNullable<SessionState["contextIntentLedger"]> {
  return {
    latestRequest: { ...value.latestRequest },
    activeConstraints: value.activeConstraints.map((item) => ({ ...item })),
    userCorrections: value.userCorrections.map((item) => ({ ...item })),
    supersededRequests: value.supersededRequests.map((item) => ({ ...item })),
  };
}

function isPromptBundleBinding(value: unknown): value is PromptBundleBinding {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "formatVersion",
    "bundleVersion",
    "bundleHash",
    "manifestHash",
    "toolCatalogHash",
  ])) return false;
  const hash = /^sha256:[a-f0-9]{64}$/u;
  return value.formatVersion === 1 &&
    typeof value.bundleVersion === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value.bundleVersion) &&
    typeof value.bundleHash === "string" && hash.test(value.bundleHash) &&
    typeof value.manifestHash === "string" && hash.test(value.manifestHash) &&
    typeof value.toolCatalogHash === "string" && hash.test(value.toolCatalogHash);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isSafePlanText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(value)
  );
}

export function isPlanReviewState(value: unknown): value is PlanReviewState {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["status", "proposal", "feedback", "approvedAt"])) {
    return false;
  }
  if (
    value.status !== "awaiting_review" &&
    value.status !== "approved_pending_execution"
  ) {
    return false;
  }
  const proposal = value.proposal;
  if (!isRecord(proposal)) return false;
  if (!hasOnlyKeys(proposal, [
    "id",
    "revision",
    "proposedByTurnId",
    "proposedAt",
    "title",
    "overview",
    "steps",
  ])) {
    return false;
  }
  if (
    typeof proposal.id !== "string" ||
    !/^plan_[A-Za-z0-9_-]{1,160}$/u.test(proposal.id) ||
    !Number.isInteger(proposal.revision) ||
    Number(proposal.revision) < 1 ||
    typeof proposal.proposedByTurnId !== "string" ||
    proposal.proposedByTurnId.length < 1 ||
    proposal.proposedByTurnId.length > 256 ||
    typeof proposal.proposedAt !== "string" ||
    !isSafePlanText(proposal.title, 200) ||
    !isSafePlanText(proposal.overview, 4_000) ||
    !Array.isArray(proposal.steps) ||
    proposal.steps.length < 1 ||
    proposal.steps.length > 24
  ) {
    return false;
  }
  for (const step of proposal.steps) {
    if (
      !isRecord(step) ||
      !hasOnlyKeys(step, ["title", "description", "verification"]) ||
      !isSafePlanText(step.title, 200) ||
      !isSafePlanText(step.description, 2_000) ||
      !isSafePlanText(step.verification, 1_000)
    ) {
      return false;
    }
  }
  if (
    value.feedback !== undefined &&
    !isSafePlanText(value.feedback, 4_000)
  ) {
    return false;
  }
  if (value.approvedAt !== undefined && typeof value.approvedAt !== "string") {
    return false;
  }
  if (
    value.status === "approved_pending_execution" &&
    typeof value.approvedAt !== "string"
  ) {
    return false;
  }
  if (value.status === "awaiting_review" && value.approvedAt !== undefined) {
    return false;
  }
  return true;
}

export function isImageAttachment(value: unknown): value is ImageAttachment {
  if (!isRecord(value)) return false;
  try {
    validateImageAttachmentCollection([value as unknown as ImageAttachment]);
    return true;
  } catch {
    return false;
  }
}

function isImageAttachmentArray(value: unknown): value is ImageAttachment[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  try {
    validateImageAttachmentCollection(value as ImageAttachment[]);
    return true;
  } catch {
    return false;
  }
}

export function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value) || typeof value.role !== "string") return false;
  if (value.role === "system") {
    return hasOnlyKeys(value, ["role", "content"]) && typeof value.content === "string";
  }
  if (value.role === "user") {
    return (
      hasOnlyKeys(value, ["role", "content", "images"]) &&
      typeof value.content === "string" &&
      (value.images === undefined ||
        isImageAttachmentArray(value.images))
    );
  }
  if (value.role === "tool") {
    return (
      hasOnlyKeys(value, ["role", "content", "tool_call_id", "name"]) &&
      typeof value.content === "string" &&
      typeof value.tool_call_id === "string" &&
      (value.name === undefined || typeof value.name === "string")
    );
  }
  if (value.role !== "assistant") return false;
  if (!hasOnlyKeys(value, ["role", "content", "tool_calls", "reasoning_content"])) {
    return false;
  }
  if (value.content !== null && typeof value.content !== "string") return false;
  if (
    value.reasoning_content !== undefined &&
    value.reasoning_content !== null &&
    typeof value.reasoning_content !== "string"
  ) {
    return false;
  }
  if (value.tool_calls === undefined) return true;
  if (!Array.isArray(value.tool_calls)) return false;
  return value.tool_calls.every((call) => {
    if (!isRecord(call) || call.type !== "function" || typeof call.id !== "string") {
      return false;
    }
    if (!isRecord(call.function)) return false;
    return (
      typeof call.function.name === "string" &&
      typeof call.function.arguments === "string"
    );
  });
}

function isTurnSteeringEntry(value: unknown): value is TurnSteeringEntry {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id",
    "sequence",
    "targetTurnId",
    "message",
    "queuedAt",
  ])) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    /^[A-Za-z0-9._-]{1,256}$/u.test(value.id) &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) > 0 &&
    typeof value.targetTurnId === "string" &&
    /^[A-Za-z0-9._-]{1,256}$/u.test(value.targetTurnId) &&
    isChatMessage(value.message) &&
    value.message.role === "user" &&
    typeof value.queuedAt === "string" &&
    value.queuedAt.length > 0 &&
    value.queuedAt.length <= 128
  );
}

function normalizedSteeringState(state: Readonly<SessionState>): {
  pendingSteering: TurnSteeringEntry[];
  steeringSequence: number;
  steeringWatermark: number;
  steeringSealedTurnId?: string;
} {
  const pendingSteering = state.pendingSteering ?? [];
  const steeringSequence = state.steeringSequence ?? 0;
  const steeringWatermark = state.steeringWatermark ?? 0;
  if (
    !Array.isArray(pendingSteering) ||
    !pendingSteering.every(isTurnSteeringEntry) ||
    !Number.isSafeInteger(steeringSequence) ||
    steeringSequence < 0 ||
    !Number.isSafeInteger(steeringWatermark) ||
    steeringWatermark < 0 ||
    steeringWatermark > steeringSequence ||
    (state.steeringSealedTurnId !== undefined &&
      !/^[A-Za-z0-9._-]{1,256}$/u.test(state.steeringSealedTurnId))
  ) {
    throw new Error("Invalid steering inbox in serialized session state");
  }
  let previous = steeringWatermark;
  for (const entry of pendingSteering) {
    if (entry.sequence !== previous + 1 || entry.sequence > steeringSequence) {
      throw new Error("Invalid steering FIFO sequence in serialized session state");
    }
    previous = entry.sequence;
  }
  return {
    pendingSteering: pendingSteering.map((entry) => ({
      ...entry,
      message: deserializeChatMessage(serializeChatMessage(entry.message)) as Extract<
        ChatMessage,
        { role: "user" }
      >,
    })),
    steeringSequence,
    steeringWatermark,
    ...(state.steeringSealedTurnId
      ? { steeringSealedTurnId: state.steeringSealedTurnId }
      : {}),
  };
}

export function serializeChatMessage(message: ChatMessage): string {
  if (!isChatMessage(message)) throw new Error("Cannot serialize an invalid chat message");
  return JSON.stringify(message);
}

export function deserializeChatMessage(serialized: string): ChatMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid serialized chat message: ${message}`);
  }
  if (!isChatMessage(parsed)) throw new Error("Invalid serialized chat message shape");
  return parsed;
}

export function serializeChatMessages(messages: readonly ChatMessage[]): string {
  for (const message of messages) {
    if (!isChatMessage(message)) throw new Error("Cannot serialize invalid chat messages");
  }
  return JSON.stringify(messages);
}

export function deserializeChatMessages(serialized: string): ChatMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid serialized chat messages: ${message}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isChatMessage)) {
    throw new Error("Invalid serialized chat message list shape");
  }
  return parsed;
}

function isFileVersion(value: unknown): value is FileVersion {
  return isRecord(value) &&
    hasOnlyKeys(value, ["path", "hash", "readAt"]) &&
    typeof value.path === "string" &&
    typeof value.hash === "string" &&
    typeof value.readAt === "string";
}

function isFileChangeRecord(value: unknown): value is FileChangeRecord {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      "path",
      "operation",
      "beforeHash",
      "afterHash",
      "source",
      "status",
      "timestamp",
    ]) &&
    typeof value.path === "string" &&
    ["create", "update", "delete", "generated", "deleted_by_command"].includes(
      String(value.operation),
    ) &&
    (value.beforeHash === undefined || typeof value.beforeHash === "string") &&
    (value.afterHash === undefined || typeof value.afterHash === "string") &&
    (value.source === "file_tool" || value.source === "command") &&
    ["applied", "verified", "conflict", "failed", "policy_violation"].includes(
      String(value.status),
    ) &&
    typeof value.timestamp === "string";
}

function isCommandAuditEntry(value: unknown): value is CommandAuditEntry {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "program",
      "args",
      "cwd",
      "status",
      "exitCode",
      "durationMs",
      "timestamp",
      "summary",
      "outputEvidence",
      "sourceScopeKey",
      "sourceAgentRole",
      "sourceAgentId",
      "sourceTaskId",
    ]) &&
    typeof value.id === "string" &&
    typeof value.program === "string" &&
    Array.isArray(value.args) &&
    value.args.every((argument) => typeof argument === "string") &&
    typeof value.cwd === "string" &&
    [
      "exited",
      "timed_out",
      "canceled",
      "spawn_failed",
      "policy_denied",
      "sandbox_unavailable",
    ].includes(String(value.status)) &&
    (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    typeof value.timestamp === "string" &&
    typeof value.summary === "string" &&
    (value.sourceScopeKey === undefined || typeof value.sourceScopeKey === "string") &&
    (value.outputEvidence === undefined || (
      isRecord(value.outputEvidence) &&
      hasOnlyKeys(value.outputEvidence, ["capturedOutputDigest", "stdoutTail", "stderrTail", "incomplete", "failureKind", "processStarted"]) &&
      typeof value.outputEvidence.capturedOutputDigest === "string" &&
      /^sha256:[a-f0-9]{64}$/u.test(value.outputEvidence.capturedOutputDigest) &&
      typeof value.outputEvidence.stdoutTail === "string" && value.outputEvidence.stdoutTail.length <= 1_024 &&
      typeof value.outputEvidence.stderrTail === "string" && value.outputEvidence.stderrTail.length <= 1_024 &&
      typeof value.outputEvidence.incomplete === "boolean" &&
      (value.outputEvidence.failureKind === undefined || typeof value.outputEvidence.failureKind === "string") &&
      (value.outputEvidence.processStarted === undefined || typeof value.outputEvidence.processStarted === "boolean")
    )) &&
    (value.sourceAgentRole === undefined ||
      value.sourceAgentRole === "main_agent" ||
      value.sourceAgentRole === "subagent") &&
    (value.sourceAgentId === undefined || typeof value.sourceAgentId === "string") &&
    (value.sourceTaskId === undefined || typeof value.sourceTaskId === "string");
}

function fileChangeIdentity(change: Readonly<FileChangeRecord>): string {
  return [
    change.timestamp,
    change.path,
    change.operation,
    change.beforeHash ?? "",
    change.afterHash ?? "",
  ].join("|");
}

function validateThreadCheckpointDelta(
  value: unknown,
): asserts value is SerializedThreadCheckpointDelta {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "formatVersion",
      "baseSequence",
      "settings",
      "messagesAppended",
      "filesReadUpserted",
      "filesReadRemoved",
      "changesAppended",
      "commandsAppended",
      "compaction",
    ]) ||
    value.formatVersion !== 1 ||
    !Number.isSafeInteger(value.baseSequence) ||
    Number(value.baseSequence) < 1
  ) {
    throw new Error("Invalid serialized thread checkpoint delta");
  }

  if (value.settings !== undefined) {
    const settings = value.settings;
    if (
      !isRecord(settings) ||
      !hasOnlyKeys(settings, [
        "orchestrationEnabled",
        "mode",
        "provider",
        "model",
        "thinkingEffort",
        "promptBundle",
        "goal",
        "constraints",
      ]) ||
      (settings.mode !== undefined &&
        !["plan", "auto", "code"].includes(String(settings.mode))) ||
      (settings.provider !== undefined && !isProviderName(settings.provider)) ||
      (settings.orchestrationEnabled !== undefined && typeof settings.orchestrationEnabled !== "boolean") ||
      (settings.model !== undefined && typeof settings.model !== "string") ||
      (settings.thinkingEffort !== undefined &&
        !THINKING_EFFORTS.includes(settings.thinkingEffort as ThinkingEffort)) ||
      (settings.promptBundle !== undefined &&
        settings.promptBundle !== null &&
        !isPromptBundleBinding(settings.promptBundle)) ||
      (settings.goal !== undefined &&
        settings.goal !== null &&
        typeof settings.goal !== "string") ||
      (settings.constraints !== undefined &&
        (!Array.isArray(settings.constraints) ||
          !settings.constraints.every((constraint) => typeof constraint === "string")))
    ) {
      throw new Error("Invalid settings in serialized thread checkpoint delta");
    }
  }

  if (
    value.messagesAppended !== undefined &&
    (!Array.isArray(value.messagesAppended) ||
      !value.messagesAppended.every(isChatMessage))
  ) {
    throw new Error("Invalid messages in serialized thread checkpoint delta");
  }

  const upsertedPaths = new Set<string>();
  if (value.filesReadUpserted !== undefined) {
    if (!Array.isArray(value.filesReadUpserted)) {
      throw new Error("Invalid file upserts in serialized thread checkpoint delta");
    }
    for (const entry of value.filesReadUpserted) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !isFileVersion(entry[1]) ||
        upsertedPaths.has(entry[0])
      ) {
        throw new Error("Invalid file upsert in serialized thread checkpoint delta");
      }
      upsertedPaths.add(entry[0]);
    }
  }

  if (value.filesReadRemoved !== undefined) {
    if (
      !Array.isArray(value.filesReadRemoved) ||
      !value.filesReadRemoved.every((filePath) => typeof filePath === "string")
    ) {
      throw new Error("Invalid file removals in serialized thread checkpoint delta");
    }
    const removed = new Set<string>();
    for (const filePath of value.filesReadRemoved) {
      if (removed.has(filePath) || upsertedPaths.has(filePath)) {
        throw new Error("Conflicting file update in serialized thread checkpoint delta");
      }
      removed.add(filePath);
    }
  }

  if (
    value.changesAppended !== undefined &&
    (!Array.isArray(value.changesAppended) ||
      !value.changesAppended.every(isFileChangeRecord) ||
      new Set(value.changesAppended.map(fileChangeIdentity)).size !==
        value.changesAppended.length)
  ) {
    throw new Error("Invalid file changes in serialized thread checkpoint delta");
  }

  if (
    value.commandsAppended !== undefined &&
    (!Array.isArray(value.commandsAppended) ||
      !value.commandsAppended.every(isCommandAuditEntry) ||
      new Set(value.commandsAppended.map((command) => command.id)).size !==
        value.commandsAppended.length)
  ) {
    throw new Error("Invalid command audits in serialized thread checkpoint delta");
  }

  if (value.compaction !== undefined) {
    const compaction = value.compaction;
    if (
      !isRecord(compaction) ||
      !hasOnlyKeys(compaction, [
        "workingSummary",
        "compactedMessageCount",
        "contextIntentLedger",
        "contextCompactionMetadata",
      ]) ||
      typeof compaction.workingSummary !== "string" ||
      !Number.isSafeInteger(compaction.compactedMessageCount) ||
      Number(compaction.compactedMessageCount) < 0 ||
      (compaction.contextIntentLedger !== undefined &&
        !isContextIntentLedger(compaction.contextIntentLedger)) ||
      (compaction.contextCompactionMetadata !== undefined &&
        (!isContextCompactionMetadata(compaction.contextCompactionMetadata) ||
          compaction.contextIntentLedger === undefined ||
          Number(compaction.contextCompactionMetadata.compactedMessageCount) !==
            Number(compaction.compactedMessageCount)))
    ) {
      throw new Error("Invalid compaction in serialized thread checkpoint delta");
    }
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Thread checkpoint delta is not JSON-serializable: ${message}`);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_THREAD_CHECKPOINT_DELTA_BYTES) {
    throw new Error(
      `Thread checkpoint delta exceeds ${MAX_SERIALIZED_THREAD_CHECKPOINT_DELTA_BYTES} bytes`,
    );
  }
}

/** Validate and detach an incremental checkpoint before it enters the journal. */
export function serializeThreadCheckpointDelta(
  delta: SerializedThreadCheckpointDelta,
): SerializedThreadCheckpointDelta {
  validateThreadCheckpointDelta(delta);
  return deserializeThreadCheckpointDelta(JSON.parse(JSON.stringify(delta)) as unknown);
}

/** Validate and clone an incremental checkpoint read from the authoritative journal. */
export function deserializeThreadCheckpointDelta(
  value: unknown,
): SerializedThreadCheckpointDelta {
  validateThreadCheckpointDelta(value);
  return {
    formatVersion: 1,
    baseSequence: value.baseSequence,
    ...(value.settings
      ? {
          settings: {
            ...value.settings,
            ...(value.settings.promptBundle
              ? { promptBundle: { ...value.settings.promptBundle } }
              : {}),
            ...(value.settings.constraints
              ? { constraints: [...value.settings.constraints] }
              : {}),
          },
        }
      : {}),
    ...(value.messagesAppended
      ? {
          messagesAppended: deserializeChatMessages(
            serializeChatMessages(value.messagesAppended),
          ),
        }
      : {}),
    ...(value.filesReadUpserted
      ? {
          filesReadUpserted: value.filesReadUpserted.map(([filePath, version]) => [
            filePath,
            { ...version },
          ]),
        }
      : {}),
    ...(value.filesReadRemoved
      ? { filesReadRemoved: [...value.filesReadRemoved] }
      : {}),
    ...(value.changesAppended
      ? { changesAppended: value.changesAppended.map((change) => ({ ...change })) }
      : {}),
    ...(value.commandsAppended
      ? {
          commandsAppended: value.commandsAppended.map((command) => ({
            ...command,
            args: [...command.args],
          })),
        }
      : {}),
    ...(value.compaction
      ? {
          compaction: {
            ...value.compaction,
            ...(value.compaction.contextIntentLedger
              ? {
                  contextIntentLedger: cloneContextIntentLedger(
                    value.compaction.contextIntentLedger,
                  ),
                }
              : {}),
            ...(value.compaction.contextCompactionMetadata
              ? {
                  contextCompactionMetadata: {
                    ...value.compaction.contextCompactionMetadata,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

export function serializeSessionState(state: SessionState): SerializedSessionState {
  const steering = normalizedSteeringState(state);
  return {
    ...(state.orchestrationEnabled !== undefined ? { orchestrationEnabled: state.orchestrationEnabled } : {}),
    threadId: state.threadId,
    activeTurnId: state.activeTurnId,
    mode: state.mode,
    provider: state.provider,
    model: state.model,
    thinkingEffort: state.thinkingEffort,
    workspaceRoot: state.workspaceRoot,
    ...(state.promptBundle ? { promptBundle: { ...state.promptBundle } } : {}),
    goal: state.goal,
    constraints: [...state.constraints],
    messages: deserializeChatMessages(serializeChatMessages(state.messages)),
    filesRead: [...state.filesRead.entries()].map(([filePath, version]) => [
      filePath,
      { ...version },
    ]),
    changes: state.changes.map((change) => ({ ...change })),
    commands: state.commands.map((command) => ({
      ...command,
      args: [...command.args],
    })),
    commandApprovalPrefixes: validateCommandApprovalPrefixes(
      state.commandApprovalPrefixes,
    ),
    ...(state.taskGraph ? { taskGraph: cloneTaskGraph(state.taskGraph) } : {}),
    ...(state.planReview ? { planReview: clonePlanReviewState(state.planReview) } : {}),
    pendingSteering: steering.pendingSteering,
    steeringSequence: steering.steeringSequence,
    steeringWatermark: steering.steeringWatermark,
    ...(steering.steeringSealedTurnId
      ? { steeringSealedTurnId: steering.steeringSealedTurnId }
      : {}),
    workingSummary: state.workingSummary,
    compactedMessageCount: state.compactedMessageCount,
    ...(state.contextIntentLedger
      ? { contextIntentLedger: cloneContextIntentLedger(state.contextIntentLedger) }
      : {}),
    ...(state.contextCompactionMetadata
      ? { contextCompactionMetadata: { ...state.contextCompactionMetadata } }
      : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

export function deserializeSessionState(value: unknown): SessionState {
  if (!isRecord(value)) throw new Error("Invalid serialized session state");
  if (
    (value.orchestrationEnabled !== undefined && typeof value.orchestrationEnabled !== "boolean") ||
    typeof value.threadId !== "string" ||
    !["plan", "auto", "code"].includes(String(value.mode)) ||
    !isProviderName(value.provider) ||
    typeof value.model !== "string" ||
    (value.thinkingEffort !== undefined &&
      !THINKING_EFFORTS.includes(value.thinkingEffort as ThinkingEffort)) ||
    typeof value.workspaceRoot !== "string" ||
    (value.promptBundle !== undefined && !isPromptBundleBinding(value.promptBundle)) ||
    !Array.isArray(value.constraints) ||
    !value.constraints.every((item) => typeof item === "string") ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isChatMessage) ||
    !Array.isArray(value.filesRead) ||
    !Array.isArray(value.changes) ||
    !Array.isArray(value.commands) ||
    (value.taskGraph !== undefined && !isTaskGraph(value.taskGraph)) ||
    (value.planReview !== undefined && !isPlanReviewState(value.planReview)) ||
    (value.pendingSteering !== undefined &&
      (!Array.isArray(value.pendingSteering) ||
        !value.pendingSteering.every(isTurnSteeringEntry))) ||
    (value.steeringSequence !== undefined &&
      (!Number.isSafeInteger(value.steeringSequence) ||
        Number(value.steeringSequence) < 0)) ||
    (value.steeringWatermark !== undefined &&
      (!Number.isSafeInteger(value.steeringWatermark) ||
        Number(value.steeringWatermark) < 0)) ||
    (value.steeringSealedTurnId !== undefined &&
      (typeof value.steeringSealedTurnId !== "string" ||
        !/^[A-Za-z0-9._-]{1,256}$/u.test(value.steeringSealedTurnId))) ||
    typeof value.workingSummary !== "string" ||
    (value.compactedMessageCount !== undefined &&
      (!Number.isInteger(value.compactedMessageCount) ||
        Number(value.compactedMessageCount) < 0 ||
        Number(value.compactedMessageCount) > value.messages.length)) ||
    (value.contextIntentLedger !== undefined &&
      !isContextIntentLedger(value.contextIntentLedger)) ||
    (value.contextCompactionMetadata !== undefined &&
      (!isContextCompactionMetadata(value.contextCompactionMetadata) ||
        value.contextIntentLedger === undefined ||
        Number(value.contextCompactionMetadata.compactedMessageCount) !==
          Number(value.compactedMessageCount))) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Invalid serialized session state shape");
  }

  const filesRead = new Map<string, FileVersion>();
  for (const entry of value.filesRead) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !isRecord(entry[1]) ||
      typeof entry[1].path !== "string" ||
      typeof entry[1].hash !== "string" ||
      typeof entry[1].readAt !== "string"
    ) {
      throw new Error("Invalid file version in serialized session state");
    }
    filesRead.set(entry[0], entry[1] as unknown as FileVersion);
  }

  let commandApprovalPrefixes: string[];
  try {
    // Checkpoints predating reusable per-Thread approvals omitted this field.
    commandApprovalPrefixes = value.commandApprovalPrefixes === undefined
      ? []
      : validateCommandApprovalPrefixes(value.commandApprovalPrefixes);
  } catch {
    throw new Error("Invalid command approval prefixes in serialized session state");
  }

  const steeringSequence = typeof value.steeringSequence === "number"
    ? value.steeringSequence
    : 0;
  const steeringWatermark = typeof value.steeringWatermark === "number"
    ? value.steeringWatermark
    : 0;
  const pendingSteering = value.pendingSteering === undefined
    ? []
    : (value.pendingSteering as TurnSteeringEntry[]).map((entry) => ({
        ...entry,
        message: deserializeChatMessage(serializeChatMessage(entry.message)) as Extract<
          ChatMessage,
          { role: "user" }
        >,
      }));
  if (steeringWatermark > steeringSequence) {
    throw new Error("Invalid steering watermark in serialized session state");
  }
  let previousSteeringSequence = steeringWatermark;
  for (const entry of pendingSteering) {
    if (
      entry.sequence !== previousSteeringSequence + 1 ||
      entry.sequence > steeringSequence
    ) {
      throw new Error("Invalid steering FIFO sequence in serialized session state");
    }
    previousSteeringSequence = entry.sequence;
  }

  const messages = deserializeChatMessages(JSON.stringify(value.messages));
  const compactionMetadata = isContextCompactionMetadata(
    value.contextCompactionMetadata,
  )
    ? value.contextCompactionMetadata
    : undefined;
  if (compactionMetadata) {
    const sourceHistoryHash = `sha256:${sha256(serializeChatMessages(
      messages.slice(0, compactionMetadata.sourceEndMessageIndex),
    ))}`;
    if (sourceHistoryHash !== compactionMetadata.sourceHistoryHash) {
      throw new Error("Context compaction source history hash mismatch");
    }
  }

  return {
    threadId: value.threadId,
    ...(typeof value.orchestrationEnabled === "boolean" ? { orchestrationEnabled: value.orchestrationEnabled } : {}),
    activeTurnId:
      typeof value.activeTurnId === "string" ? value.activeTurnId : undefined,
    mode: value.mode as SessionState["mode"],
    provider: value.provider as SessionState["provider"],
    model: value.model,
    // Checkpoints written before thinking-effort selection was introduced do
    // not contain this field, so upgrade them to the configured product default.
    thinkingEffort:
      value.thinkingEffort === undefined
        ? DEFAULT_THINKING_EFFORT
        : value.thinkingEffort as ThinkingEffort,
    workspaceRoot: value.workspaceRoot,
    ...(isPromptBundleBinding(value.promptBundle)
      ? { promptBundle: { ...value.promptBundle } }
      : {}),
    goal: typeof value.goal === "string" ? value.goal : undefined,
    constraints: [...value.constraints] as string[],
    messages,
    filesRead,
    changes: (value.changes as unknown as FileChangeRecord[]).map((item) => ({
      ...item,
    })),
    commands: (value.commands as unknown as CommandAuditEntry[]).map((item) => ({
      ...item,
      args: [...item.args],
    })),
    commandApprovalPrefixes,
    ...(isTaskGraph(value.taskGraph)
      ? { taskGraph: cloneTaskGraph(value.taskGraph) }
      : {}),
    ...(isPlanReviewState(value.planReview)
      ? { planReview: clonePlanReviewState(value.planReview) }
      : {}),
    pendingSteering,
    steeringSequence,
    steeringWatermark,
    ...(typeof value.steeringSealedTurnId === "string"
      ? { steeringSealedTurnId: value.steeringSealedTurnId }
      : {}),
    // Checkpoints created before model-controlled compaction used workingSummary as a
    // transient overflow cache and had no boundary. Dropping that derived value avoids
    // injecting it alongside the same full message history after an upgrade.
    workingSummary:
      typeof value.compactedMessageCount === "number" ? value.workingSummary : "",
    compactedMessageCount:
      typeof value.compactedMessageCount === "number" ? value.compactedMessageCount : 0,
    ...(isContextIntentLedger(value.contextIntentLedger)
      ? {
          contextIntentLedger: cloneContextIntentLedger(
            value.contextIntentLedger as NonNullable<SessionState["contextIntentLedger"]>,
          ),
        }
      : {}),
    ...(compactionMetadata
      ? {
          contextCompactionMetadata: {
            ...compactionMetadata,
          },
        }
      : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
