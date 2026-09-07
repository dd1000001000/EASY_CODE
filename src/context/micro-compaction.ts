import type { ChatMessage } from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { sha256 } from "../utils/hash.js";

/**
 * Tool results smaller than this are cheaper to retain than to replace with a
 * recovery reference. The durable Thread history remains authoritative at all
 * sizes; this threshold only controls the provider-facing projection.
 */
export const MICRO_COMPACTION_MIN_TOOL_RESULT_CHARS = 2_048;

export const MICRO_COMPACTION_PLACEHOLDER_PREFIX =
  "[Old tool result cleared from the provider working set after consumption.";

/**
 * Tools whose results commonly contain reconstructable source, search, edit,
 * or command output. Some names are reserved for compatible future tools so
 * adding one does not silently reintroduce unbounded historical output.
 */
const COMPACTABLE_TOOL_NAMES = new Set<string>([
  "read_file",
  "run_command",
  "start_command",
  "poll_command",
  "cancel_command",
  "create_file",
  "update_file",
  "delete_file",
  "grep",
  "glob",
  "web_search",
  "web_fetch",
  "file_edit",
  "file_write",
  "manage_tasks",
  "manage_subagents",
  "submit_task_result",
]);

type JsonRecord = Record<string, unknown>;

const TERMINAL_ESCAPE_SEQUENCE =
  /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/gu;
const UNSAFE_REFERENCE_TEXT =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/gu;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:/-]+$/u;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function parseToolResult(content: string): JsonRecord | undefined {
  try {
    return asRecord(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function boundedSafeText(value: unknown, maximumChars = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = redactSensitiveInformation(
    value
      .replace(TERMINAL_ESCAPE_SEQUENCE, " ")
      .replace(UNSAFE_REFERENCE_TEXT, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
  if (!safe) return undefined;
  if (safe.length <= maximumChars) return safe;
  return `${safe.slice(0, Math.max(0, maximumChars - 1))}…`;
}

function referenceValue(value: unknown, maximumChars = 160): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "null";
  const safe = boundedSafeText(value, maximumChars);
  if (!safe) return undefined;
  return SAFE_IDENTIFIER.test(safe) ? safe : JSON.stringify(safe);
}

function addField(
  fields: string[],
  name: string,
  value: unknown,
  maximumChars = 160,
): void {
  const rendered = referenceValue(value, maximumChars);
  if (rendered !== undefined) fields.push(`${name}=${rendered}`);
}

function addArrayCount(fields: string[], name: string, value: unknown): void {
  if (Array.isArray(value)) fields.push(`${name}=${value.length}`);
}

function addBooleanField(fields: string[], name: string, value: unknown): void {
  if (typeof value === "boolean") fields.push(`${name}=${String(value)}`);
}

function resultData(payload: JsonRecord | undefined): JsonRecord | undefined {
  return asRecord(payload?.data) ?? payload;
}

function addCommonResultFields(fields: string[], payload: JsonRecord | undefined): void {
  if (typeof payload?.ok === "boolean") fields.push(`ok=${String(payload.ok)}`);
  addField(fields, "summary", payload?.summary, 160);
}

function readFileSynopsis(payload: JsonRecord | undefined): string[] {
  const data = resultData(payload);
  const fields = ["kind=file_read"];
  addCommonResultFields(fields, payload);
  addField(fields, "path", data?.path, 200);
  if (typeof data?.startLine === "number" && typeof data.endLine === "number") {
    const total = typeof data.totalLines === "number" ? `/${data.totalLines}` : "";
    fields.push(`lines=${data.startLine}-${data.endLine}${total}`);
  }
  addField(fields, "file_hash", data?.contentHash, 80);
  addBooleanField(fields, "truncated", data?.truncated);
  return fields;
}

function commandSynopsis(payload: JsonRecord | undefined): string[] {
  const data = resultData(payload);
  const stdout = asRecord(data?.stdout);
  const stderr = asRecord(data?.stderr);
  const delta = asRecord(data?.workspaceDelta);
  const failure = asRecord(data?.failure);
  const fields = ["kind=command"];
  addCommonResultFields(fields, payload);
  addField(fields, "command_id", data?.commandId, 100);
  addField(fields, "status", data?.status, 40);
  if (Object.prototype.hasOwnProperty.call(data ?? {}, "exitCode")) {
    addField(fields, "exit_code", data?.exitCode);
  }
  addField(fields, "duration_ms", data?.durationMs);
  addField(fields, "stdout_bytes", stdout?.totalBytes);
  addField(fields, "stderr_bytes", stderr?.totalBytes);
  if (stdout?.truncated === true || stderr?.truncated === true) {
    fields.push("output_truncated=true");
  }
  if (delta) {
    const created = Array.isArray(delta.created) ? delta.created.length : 0;
    const updated = Array.isArray(delta.updated) ? delta.updated.length : 0;
    const deleted = Array.isArray(delta.deleted) ? delta.deleted.length : 0;
    fields.push(`workspace_delta=${created}/${updated}/${deleted}`);
    addBooleanField(fields, "delta_truncated", delta.truncated);
  }
  addField(fields, "failure_kind", failure?.kind, 40);
  addField(fields, "failure_code", failure?.code, 80);
  addBooleanField(fields, "retryable", failure?.retryable);
  addBooleanField(fields, "result_truncated", data?.truncated);
  return fields;
}

function searchSynopsis(toolName: string, payload: JsonRecord | undefined): string[] {
  const data = resultData(payload);
  const fields = [`kind=${toolName === "web_fetch" ? "web_fetch" : "search"}`];
  addCommonResultFields(fields, payload);
  addField(fields, "status", data?.status, 40);
  addField(fields, "status_code", data?.statusCode);
  for (const [name, value] of [
    ["matches", data?.matches],
    ["results", data?.results],
    ["files", data?.files],
    ["items", data?.items],
  ] as const) {
    addArrayCount(fields, name, value);
  }
  for (const [name, value] of [
    ["match_count", data?.matchCount],
    ["result_count", data?.resultCount],
    ["file_count", data?.fileCount],
    ["total", data?.totalCount ?? data?.total ?? data?.count],
  ] as const) {
    addField(fields, name, value);
  }
  if (typeof data?.content === "string") fields.push(`content_chars=${data.content.length}`);
  addBooleanField(fields, "truncated", data?.truncated);
  return fields;
}

function mutationSynopsis(toolName: string, payload: JsonRecord | undefined): string[] {
  const data = resultData(payload);
  const inferredOperation = toolName === "create_file"
    ? "create"
    : toolName === "update_file"
      ? "update"
      : toolName === "delete_file"
        ? "delete"
        : "mutate";
  const fields = ["kind=file_mutation", `operation=${inferredOperation}`];
  addCommonResultFields(fields, payload);
  addField(fields, "path", data?.path, 200);
  addField(fields, "before_hash", data?.beforeHash, 80);
  addField(fields, "after_hash", data?.contentHash ?? data?.afterHash, 80);
  addField(fields, "bytes_written", data?.bytesWritten);
  addField(fields, "bytes_deleted", data?.bytesDeleted);
  addField(fields, "edits_applied", data?.editsApplied);
  addBooleanField(fields, "truncated", data?.truncated);
  return fields;
}

function taskSynopsis(payload: JsonRecord | undefined): string[] {
  const data = resultData(payload);
  const graph = asRecord(data?.graph);
  const fields = ["kind=task_graph"];
  addCommonResultFields(fields, payload);
  if (graph === undefined && data?.graph === null) fields.push("graph=none");
  addField(fields, "graph_id", graph?.id, 100);
  addField(fields, "status", graph?.status, 40);
  addField(fields, "current_task", graph?.currentTask, 80);
  addField(fields, "completed", graph?.completed);
  addField(fields, "total", graph?.total);
  addArrayCount(fields, "startable", graph?.startableTasks);
  addField(fields, "task_statuses", statusCounts(graph?.tasks), 160);
  return fields;
}

function statusCounts(records: unknown): string | undefined {
  if (!Array.isArray(records)) return undefined;
  const counts = new Map<string, number>();
  for (const record of records) {
    const status = boundedSafeText(asRecord(record)?.status, 40);
    if (!status || !SAFE_IDENTIFIER.test(status)) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(",");
}

function subagentSynopsis(payload: JsonRecord | undefined): string[] {
  const data = resultData(payload);
  const observedAgentId = boundedSafeText(data?.observedAgentId, 100);
  const observedAgent = Array.isArray(data?.agents)
    ? data.agents
        .map(asRecord)
        .find((candidate) => candidate?.id === observedAgentId)
    : undefined;
  const agent = asRecord(data?.agent) ?? observedAgent;
  const result = asRecord(data?.result);
  const concurrency = asRecord(data?.concurrency);
  const fields = ["kind=subagent"];
  addCommonResultFields(fields, payload);
  addBooleanField(fields, "timed_out", data?.timedOut);
  addField(fields, "agent_id", observedAgentId ?? data?.agentId ?? agent?.id, 100);
  addField(fields, "task_id", result?.taskId ?? agent?.taskId, 100);
  addField(fields, "status", agent?.status, 40);
  addField(fields, "outcome", result?.outcome, 40);
  addArrayCount(fields, "agents", data?.agents);
  addField(fields, "agent_statuses", statusCounts(data?.agents), 160);
  if (concurrency) {
    addField(fields, "active", concurrency.active);
    addField(fields, "limit", concurrency.limit);
  }
  const artifact = asRecord(agent?.resultArtifact ?? result?.resultArtifact);
  addField(fields, "artifact_id", artifact?.id, 100);
  addField(fields, "artifact_status", artifact?.status, 40);
  addField(fields, "result_commit", artifact?.resultCommit, 100);
  addField(fields, "snapshot_ref", artifact?.snapshotRef, 160);
  addField(fields, "changed_files", artifact?.changedFileCount);
  return fields;
}

function submittedTaskSynopsis(payload: JsonRecord | undefined): string[] {
  const data = resultData(payload);
  const fields = ["kind=task_result"];
  addCommonResultFields(fields, payload);
  addField(fields, "task_id", data?.taskId, 100);
  addField(fields, "outcome", data?.outcome, 40);
  addField(fields, "evidence_count", data?.evidenceCount);
  return fields;
}

function genericSynopsis(toolName: string, payload: JsonRecord | undefined): string[] {
  const fields = ["kind=opaque"];
  addCommonResultFields(fields, payload);
  if (!payload) fields.push("format=non_json");
  addField(fields, "tool", toolName, 80);
  return fields;
}

function synopsisForTool(toolName: string, payload: JsonRecord | undefined): string[] {
  if (!payload) return genericSynopsis(toolName, payload);
  if (toolName === "read_file") return readFileSynopsis(payload);
  if (["run_command", "start_command", "poll_command", "cancel_command"].includes(toolName)) {
    return commandSynopsis(payload);
  }
  if (["grep", "glob", "web_search", "web_fetch"].includes(toolName)) {
    return searchSynopsis(toolName, payload);
  }
  if (["create_file", "update_file", "delete_file", "file_edit", "file_write"].includes(toolName)) {
    return mutationSynopsis(toolName, payload);
  }
  if (toolName === "manage_tasks") return taskSynopsis(payload);
  if (toolName === "manage_subagents") return subagentSynopsis(payload);
  if (toolName === "submit_task_result") return submittedTaskSynopsis(payload);
  return genericSynopsis(toolName, payload);
}

function recoveryPlaceholder(
  message: Extract<ChatMessage, { role: "tool" }>,
  toolName: string,
): string {
  const contentHash = sha256(message.content);
  const synopsis = synopsisForTool(toolName, parseToolResult(message.content)).join("; ");
  const safeToolName = referenceValue(toolName, 80) ?? "unknown";
  const safeToolCallId = referenceValue(message.tool_call_id, 160) ?? "unknown";
  return `${MICRO_COMPACTION_PLACEHOLDER_PREFIX} ` +
    `Full content remains in durable Thread history. ` +
    `Reference: tool=${safeToolName}; tool_call_id=${safeToolCallId}; ` +
    `original_chars=${message.content.length}; sha256=${contentHash}. ` +
    `Synopsis: ${synopsis}.]`;
}

/**
 * Project long, already-consumed tool results into lightweight recovery
 * references before a provider request.
 *
 * A result is consumed only when a later assistant message exists. Therefore
 * every result at the active protocol tail remains intact for the next model
 * call, including batches from one assistant tool-call message. Only content
 * is replaced: role, name, tool_call_id, ordering, and assistant tool calls are
 * preserved, so native provider tool-call/result pairing remains valid.
 *
 * The input messages and their nested durable objects are never mutated.
 */
export function microCompactToolResults(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const toolNamesByResultIndex = new Map<number, string>();
  const precedingToolCalls = new Map<string, string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        precedingToolCalls.set(call.id, call.function.name);
      }
      continue;
    }
    if (message.role === "tool") {
      const name = message.name ?? precedingToolCalls.get(message.tool_call_id);
      if (name) toolNamesByResultIndex.set(index, name);
    }
  }

  const projection = [...messages];
  let hasLaterAssistantMessage = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "assistant") {
      hasLaterAssistantMessage = true;
      continue;
    }
    if (
      message.role !== "tool" ||
      !hasLaterAssistantMessage ||
      message.content.length < MICRO_COMPACTION_MIN_TOOL_RESULT_CHARS
    ) {
      continue;
    }
    const toolName = toolNamesByResultIndex.get(index);
    if (!toolName || !COMPACTABLE_TOOL_NAMES.has(toolName)) continue;
    projection[index] = {
      ...message,
      content: recoveryPlaceholder(message, toolName),
    };
  }

  return projection;
}

/**
 * Remove model reasoning that has already served its turn from the
 * provider-facing projection.
 *
 * Durable Thread messages are deliberately left untouched. The only
 * reasoning that remains visible to the provider is the reasoning attached
 * to the latest assistant message when that message is an unresolved tool
 * request. This keeps the active native tool-call tail intact while avoiding
 * repeatedly paying for reasoning that preceded an answer or an earlier tool
 * round. The rule is intentionally provider-independent.
 */
export function pruneConsumedReasoning(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  let latestAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      latestAssistantIndex = index;
      break;
    }
  }

  return messages.map((message, index) => {
    if (message.role !== "assistant" || message.reasoning_content === undefined) {
      return message;
    }
    const preserveActiveToolReasoning =
      index === latestAssistantIndex && (message.tool_calls?.length ?? 0) > 0;
    if (preserveActiveToolReasoning) return message;

    const projected = { ...message };
    delete projected.reasoning_content;
    return projected;
  });
}

/**
 * Canonical, deterministic projection used for every model-input estimate and
 * provider request. Calling it repeatedly is safe and produces the same
 * value; no durable message is mutated.
 */
export function projectModelInputMessages(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  return pruneConsumedReasoning(microCompactToolResults(messages));
}
