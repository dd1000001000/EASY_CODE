import {
  DEFAULT_THINKING_EFFORT,
  THINKING_EFFORTS,
  type ThinkingEffort,
  type ChatMessage,
  type CommandAuditEntry,
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
import { clonePlanReviewState } from "../plans/plan.js";
import { cloneTaskGraph, isTaskGraph } from "../tasks/task-graph.js";
import { validateCommandApprovalPrefixes } from "../command/approval.js";

export interface SerializedSessionState {
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
  readonly createdAt: string;
  readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

export function serializeSessionState(state: SessionState): SerializedSessionState {
  const steering = normalizedSteeringState(state);
  return {
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
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

export function deserializeSessionState(value: unknown): SessionState {
  if (!isRecord(value)) throw new Error("Invalid serialized session state");
  if (
    typeof value.threadId !== "string" ||
    !["plan", "auto", "code"].includes(String(value.mode)) ||
    !["qwen", "deepseek", "glm"].includes(String(value.provider)) ||
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

  return {
    threadId: value.threadId,
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
    messages: deserializeChatMessages(JSON.stringify(value.messages)),
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
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
