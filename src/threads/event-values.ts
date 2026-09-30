/** Small value helpers shared by Thread journal persistence, replay and projection. */

import type { ChatMessage, FileChangeRecord, CommandAuditEntry } from "../core/types.js";
import { serializeChatMessage } from "./serialization.js";

export function asPayloadRecord(payload: unknown): Record<string, unknown> | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  return payload as Record<string, unknown>;
}

export function cloneMessage(message: ChatMessage): ChatMessage {
  return JSON.parse(serializeChatMessage(message)) as ChatMessage;
}

export function artifactPayload(payload: Record<string, unknown>): {
  changes: FileChangeRecord[];
  commands: CommandAuditEntry[];
} {
  const changes = payload.changes;
  const commands = payload.commands;
  if (!Array.isArray(changes) || !Array.isArray(commands)) {
    throw new Error("Invalid subagent artifact event payload");
  }
  for (const change of changes) {
    if (
      change === null ||
      typeof change !== "object" ||
      typeof (change as Partial<FileChangeRecord>).path !== "string" ||
      typeof (change as Partial<FileChangeRecord>).timestamp !== "string"
    ) {
      throw new Error("Invalid subagent file-change record");
    }
  }
  for (const command of commands) {
    if (
      command === null ||
      typeof command !== "object" ||
      typeof (command as Partial<CommandAuditEntry>).id !== "string" ||
      !Array.isArray((command as Partial<CommandAuditEntry>).args)
    ) {
      throw new Error("Invalid subagent command-audit record");
    }
  }
  return {
    changes: changes.map((change) => ({ ...(change as FileChangeRecord) })),
    commands: commands.map((command) => ({
      ...(command as CommandAuditEntry),
      args: [...(command as CommandAuditEntry).args],
    })),
  };
}
