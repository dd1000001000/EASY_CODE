/** Incremental Thread checkpoints: diff a session state against its predecessor and apply the delta on replay. */

import type {
  ChatMessage,
  FileChangeRecord,
  CommandAuditEntry,
  FileVersion,
  EventRecord,
  SessionState,
} from "../core/types.js";
import { CURRENT_PROTOCOL } from "../protocol/versions.js";
import { sha256 } from "../utils/hash.js";
import { cloneMessage } from "./event-values.js";
import {
  type SerializedThreadCheckpointDelta,
  serializeThreadCheckpointDelta,
  serializeChatMessages,
} from "./serialization.js";

export function messagePrefix(prefix: readonly ChatMessage[], messages: readonly ChatMessage[]): boolean {
  if (prefix.length > messages.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (JSON.stringify(prefix[index]) !== JSON.stringify(messages[index])) return false;
  }
  return true;
}

export function fileChangeKey(change: Readonly<FileChangeRecord>): string {
  return [change.timestamp, change.path, change.operation, change.beforeHash ?? "", change.afterHash ?? ""].join("|");
}

export function mergeFileChanges(target: FileChangeRecord[], additions: readonly FileChangeRecord[]): void {
  const known = new Set(target.map(fileChangeKey));
  for (const change of additions) {
    const key = fileChangeKey(change);
    if (known.has(key)) continue;
    target.push({ ...change });
    known.add(key);
  }
}

export function mergeCommandAudits(target: CommandAuditEntry[], additions: readonly CommandAuditEntry[]): void {
  const known = new Set(target.map((entry) => entry.id));
  for (const entry of additions) {
    if (known.has(entry.id)) continue;
    target.push({ ...entry, args: [...entry.args] });
    known.add(entry.id);
  }
}

export type CheckpointDeltaSettings = NonNullable<SerializedThreadCheckpointDelta["settings"]>;

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameFileVersion(left: Readonly<FileVersion> | undefined, right: Readonly<FileVersion>): boolean {
  return Boolean(left && left.path === right.path && left.hash === right.hash && left.readAt === right.readAt);
}

export function sameFilesRead(
  left: ReadonlyMap<string, FileVersion>,
  right: ReadonlyMap<string, FileVersion>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [filePath, version] of left) {
    if (!sameFileVersion(right.get(filePath), version)) return false;
  }
  return true;
}

export function createThreadCheckpointDelta(
  durable: Readonly<SessionState>,
  requested: Readonly<SessionState>,
  baseSequence: number,
): SerializedThreadCheckpointDelta {
  if (requested.threadId !== durable.threadId) {
    throw new Error(`Thread checkpoint belongs to ${requested.threadId}, expected ${durable.threadId}`);
  }
  if (requested.workspaceRoot !== durable.workspaceRoot) {
    throw new Error("Thread checkpoint cannot change the durable workspace root");
  }
  if (requested.createdAt !== durable.createdAt) {
    throw new Error("Thread checkpoint cannot change the durable creation time");
  }
  if (requested.modelRegistryHash !== durable.modelRegistryHash) {
    throw new Error("Thread checkpoint cannot change the bound model registry");
  }
  if (!sameJson(requested.promptBundle, durable.promptBundle)) {
    throw new Error("Thread checkpoint cannot change the bound Prompt Bundle");
  }

  let requestedMessagesAreStale = false;
  let messagesAppended: ChatMessage[] = [];
  if (messagePrefix(durable.messages, requested.messages)) {
    messagesAppended = requested.messages.slice(durable.messages.length).map(cloneMessage);
  } else if (messagePrefix(requested.messages, durable.messages)) {
    requestedMessagesAreStale = true;
  } else {
    throw new Error("Thread checkpoint diverged from durable message history");
  }

  // A checkpoint is a derived workspace snapshot. Runtime-owned state can only
  // be introduced by its validated event transition, never by save().
  if (!durable.taskGraph && requested.taskGraph) {
    throw new Error("Thread checkpoint introduced a task DAG without a legal transition");
  }
  if (!durable.planReview && requested.planReview) {
    throw new Error("Thread checkpoint introduced a plan review without a legal event");
  }

  if (
    requestedMessagesAreStale &&
    (requested.mode !== durable.mode ||
      requested.provider !== durable.provider ||
      requested.model !== durable.model ||
      requested.thinkingEffort !== durable.thinkingEffort ||
      requested.orchestrationEnabled !== durable.orchestrationEnabled ||
      !sameJson(requested.promptBundle, durable.promptBundle) ||
      !sameJson(requested.constraints, durable.constraints) ||
      !sameFilesRead(requested.filesRead, durable.filesRead) ||
      requested.compactedMessageCount > durable.compactedMessageCount ||
      (requested.compactedMessageCount === durable.compactedMessageCount &&
        (requested.workingSummary !== durable.workingSummary ||
          !sameJson(requested.contextIntentLedger, durable.contextIntentLedger) ||
          !sameJson(requested.contextCompactionMetadata, durable.contextCompactionMetadata))))
  ) {
    throw new Error("Stale thread checkpoint cannot replace newer checkpoint-owned state");
  }

  const settings: {
    orchestrationEnabled?: boolean;
    mode?: CheckpointDeltaSettings["mode"];
    provider?: CheckpointDeltaSettings["provider"];
    model?: string;
    thinkingEffort?: CheckpointDeltaSettings["thinkingEffort"];
    goal?: string | null;
    constraints?: string[];
  } = {};
  if (requested.mode !== durable.mode) settings.mode = requested.mode;
  if (requested.orchestrationEnabled !== durable.orchestrationEnabled && requested.orchestrationEnabled !== undefined) {
    settings.orchestrationEnabled = requested.orchestrationEnabled;
  }
  if (requested.provider !== durable.provider) settings.provider = requested.provider;
  if (requested.model !== durable.model) settings.model = requested.model;
  if (requested.thinkingEffort !== durable.thinkingEffort) {
    settings.thinkingEffort = requested.thinkingEffort;
  }
  if (!requestedMessagesAreStale && requested.goal !== durable.goal) {
    settings.goal = requested.goal ?? null;
  }
  if (!sameJson(requested.constraints, durable.constraints)) {
    settings.constraints = [...requested.constraints];
  }

  const filesReadUpserted = [...requested.filesRead.entries()]
    .filter(([filePath, version]) => !sameFileVersion(durable.filesRead.get(filePath), version))
    .map(([filePath, version]): [string, FileVersion] => [filePath, { ...version }]);
  const filesReadRemoved = [...durable.filesRead.keys()].filter((filePath) => !requested.filesRead.has(filePath));

  const durableChanges = new Set(durable.changes.map(fileChangeKey));
  const changesAppended = requested.changes
    .filter((change) => !durableChanges.has(fileChangeKey(change)))
    .map((change) => ({ ...change }));
  const durableCommands = new Set(durable.commands.map((command) => command.id));
  const commandsAppended = requested.commands
    .filter((command) => !durableCommands.has(command.id))
    .map((command) => ({ ...command, args: [...command.args] }));

  let compaction: SerializedThreadCheckpointDelta["compaction"];
  if (
    requested.compactedMessageCount > durable.compactedMessageCount ||
    (requested.compactedMessageCount === durable.compactedMessageCount &&
      (requested.workingSummary !== durable.workingSummary ||
        !sameJson(requested.contextIntentLedger, durable.contextIntentLedger) ||
        !sameJson(requested.contextCompactionMetadata, durable.contextCompactionMetadata)))
  ) {
    const resultingMessageCount = durable.messages.length + messagesAppended.length;
    if (requested.compactedMessageCount > resultingMessageCount) {
      throw new Error("Thread checkpoint compaction exceeds durable message history");
    }
    compaction = {
      workingSummary: requested.workingSummary,
      compactedMessageCount: requested.compactedMessageCount,
      ...(requested.contextIntentLedger
        ? {
            contextIntentLedger: {
              latestRequest: { ...requested.contextIntentLedger.latestRequest },
              activeConstraints: requested.contextIntentLedger.activeConstraints.map((item) => ({ ...item })),
              userCorrections: requested.contextIntentLedger.userCorrections.map((item) => ({ ...item })),
              supersededRequests: requested.contextIntentLedger.supersededRequests.map((item) => ({ ...item })),
            },
          }
        : {}),
      ...(requested.contextCompactionMetadata
        ? { contextCompactionMetadata: { ...requested.contextCompactionMetadata } }
        : {}),
    };
  }

  return serializeThreadCheckpointDelta({
    formatVersion: CURRENT_PROTOCOL.checkpointDelta,
    baseSequence,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...(messagesAppended.length > 0 ? { messagesAppended } : {}),
    ...(filesReadUpserted.length > 0 ? { filesReadUpserted } : {}),
    ...(filesReadRemoved.length > 0 ? { filesReadRemoved } : {}),
    ...(changesAppended.length > 0 ? { changesAppended } : {}),
    ...(commandsAppended.length > 0 ? { commandsAppended } : {}),
    ...(compaction ? { compaction } : {}),
  });
}

export function applyThreadCheckpointDelta(
  state: SessionState,
  delta: Readonly<SerializedThreadCheckpointDelta>,
  event: Pick<EventRecord, "eventId" | "sequence">,
): void {
  if (delta.baseSequence !== event.sequence - 1) {
    throw new Error(
      `Thread checkpoint delta ${event.eventId} has base sequence ` +
        `${delta.baseSequence}; expected ${event.sequence - 1}`,
    );
  }

  const settings = delta.settings;
  if (settings) {
    if (settings.orchestrationEnabled !== undefined) state.orchestrationEnabled = settings.orchestrationEnabled;
    if (settings.mode !== undefined) state.mode = settings.mode;
    if (settings.provider !== undefined) state.provider = settings.provider;
    if (settings.model !== undefined) state.model = settings.model;
    if (settings.thinkingEffort !== undefined) {
      state.thinkingEffort = settings.thinkingEffort;
    }
    if (settings.goal !== undefined) {
      if (settings.goal === null) delete state.goal;
      else state.goal = settings.goal;
    }
    if (settings.constraints !== undefined) {
      state.constraints = [...settings.constraints];
    }
  }

  for (const message of delta.messagesAppended ?? []) {
    state.messages.push(cloneMessage(message));
  }
  for (const filePath of delta.filesReadRemoved ?? []) {
    if (!state.filesRead.delete(filePath)) {
      throw new Error(`Thread checkpoint delta ${event.eventId} removed an unknown file ${filePath}`);
    }
  }
  for (const [filePath, version] of delta.filesReadUpserted ?? []) {
    state.filesRead.set(filePath, { ...version });
  }

  const knownChanges = new Set(state.changes.map(fileChangeKey));
  for (const change of delta.changesAppended ?? []) {
    const key = fileChangeKey(change);
    if (knownChanges.has(key)) {
      throw new Error(`Thread checkpoint delta ${event.eventId} duplicated a file change`);
    }
    state.changes.push({ ...change });
    knownChanges.add(key);
  }
  const knownCommands = new Set(state.commands.map((command) => command.id));
  for (const command of delta.commandsAppended ?? []) {
    if (knownCommands.has(command.id)) {
      throw new Error(`Thread checkpoint delta ${event.eventId} duplicated command ${command.id}`);
    }
    state.commands.push({ ...command, args: [...command.args] });
    knownCommands.add(command.id);
  }

  if (delta.compaction) {
    const boundary = delta.compaction.compactedMessageCount;
    if (boundary < state.compactedMessageCount || boundary > state.messages.length) {
      throw new Error(`Thread checkpoint delta ${event.eventId} has invalid compaction`);
    }
    if (boundary === state.compactedMessageCount && delta.compaction.workingSummary === state.workingSummary) {
      throw new Error(`Thread checkpoint delta ${event.eventId} repeated its compaction`);
    }
    const metadata = delta.compaction.contextCompactionMetadata;
    if (state.compactionControl?.transaction || state.pressureRecovery) {
      throw new Error(`Thread checkpoint delta ${event.eventId} cannot replace transaction-owned compaction`);
    }
    if (metadata) {
      const sourceHistoryHash = `sha256:${sha256(
        serializeChatMessages(state.messages.slice(0, metadata.sourceEndMessageIndex)),
      )}`;
      if (sourceHistoryHash !== metadata.sourceHistoryHash) {
        throw new Error(`Thread checkpoint delta ${event.eventId} has a context source hash mismatch`);
      }
    }
    state.workingSummary = delta.compaction.workingSummary;
    state.compactedMessageCount = boundary;
    state.contextIntentLedger = delta.compaction.contextIntentLedger
      ? {
          latestRequest: { ...delta.compaction.contextIntentLedger.latestRequest },
          activeConstraints: delta.compaction.contextIntentLedger.activeConstraints.map((item) => ({ ...item })),
          userCorrections: delta.compaction.contextIntentLedger.userCorrections.map((item) => ({ ...item })),
          supersededRequests: delta.compaction.contextIntentLedger.supersededRequests.map((item) => ({ ...item })),
        }
      : undefined;
    state.contextCompactionMetadata = metadata ? { ...metadata } : undefined;
  }
}

export function threadCheckpointDeltaHasChanges(delta: Readonly<SerializedThreadCheckpointDelta>): boolean {
  return Object.keys(delta).some((key) => key !== "formatVersion" && key !== "baseSequence");
}
