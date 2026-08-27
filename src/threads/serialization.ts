import type {
  ChatMessage,
  CommandAuditEntry,
  FileChangeRecord,
  FileVersion,
  SessionState,
} from "../core/types.js";

export interface SerializedSessionState {
  readonly threadId: string;
  readonly activeTurnId?: string;
  readonly mode: SessionState["mode"];
  readonly provider: SessionState["provider"];
  readonly model: string;
  readonly workspaceRoot: string;
  readonly goal?: string;
  readonly constraints: string[];
  readonly messages: ChatMessage[];
  readonly filesRead: Array<[string, FileVersion]>;
  readonly changes: FileChangeRecord[];
  readonly commands: CommandAuditEntry[];
  readonly workingSummary: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value) || typeof value.role !== "string") return false;
  if (value.role === "system" || value.role === "user") {
    return typeof value.content === "string";
  }
  if (value.role === "tool") {
    return (
      typeof value.content === "string" &&
      typeof value.tool_call_id === "string" &&
      (value.name === undefined || typeof value.name === "string")
    );
  }
  if (value.role !== "assistant") return false;
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
  return {
    threadId: state.threadId,
    activeTurnId: state.activeTurnId,
    mode: state.mode,
    provider: state.provider,
    model: state.model,
    workspaceRoot: state.workspaceRoot,
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
    workingSummary: state.workingSummary,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

export function deserializeSessionState(value: unknown): SessionState {
  if (!isRecord(value)) throw new Error("Invalid serialized session state");
  if (
    typeof value.threadId !== "string" ||
    !["plan", "auto", "code"].includes(String(value.mode)) ||
    !["qwen", "deepseek"].includes(String(value.provider)) ||
    typeof value.model !== "string" ||
    typeof value.workspaceRoot !== "string" ||
    !Array.isArray(value.constraints) ||
    !value.constraints.every((item) => typeof item === "string") ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isChatMessage) ||
    !Array.isArray(value.filesRead) ||
    !Array.isArray(value.changes) ||
    !Array.isArray(value.commands) ||
    typeof value.workingSummary !== "string" ||
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

  return {
    threadId: value.threadId,
    activeTurnId:
      typeof value.activeTurnId === "string" ? value.activeTurnId : undefined,
    mode: value.mode as SessionState["mode"],
    provider: value.provider as SessionState["provider"],
    model: value.model,
    workspaceRoot: value.workspaceRoot,
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
    workingSummary: value.workingSummary,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

