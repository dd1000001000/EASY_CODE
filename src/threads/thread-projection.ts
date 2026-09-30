/**
 * SQLite projection of the Thread journal: thread rows, turn rows, event index and tool audits.
 * The journal stays authoritative; everything written here is derived from it.
 */

import { type ChatMessage, type CommandAuditEntry, type EventRecord, type SessionState } from "../core/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import { workspaceIdFromRoot } from "../storage/database.js";
import { deserializeThreadCheckpointDelta, isChatMessage, serializeChatMessage } from "./serialization.js";
import { asPayloadRecord } from "./event-values.js";
import { type UserChatMessage } from "./steering-entries.js";
import { artifactPayload } from "./event-values.js";

export class ThreadProjection {
  constructor(private readonly storage: EasyCodeStorage) {}

  reconcileProjection(state: SessionState, events: readonly EventRecord[], journalPath: string): void {
    this.storage.db.transaction(() => {
      this.projectRecoveredThread(state, events, journalPath);
    })();
  }

  projectRecoveredThread(state: SessionState, events: readonly EventRecord[], journalPath: string): void {
    this.projectState(state, "active");
    for (const event of events) {
      this.projectEvent(event, journalPath);
      this.projectAuxiliaryEvent(state.threadId, event);
    }
    // Auxiliary events rebuild turn/audit rows. The recovered snapshot remains
    // authoritative for the thread's final mode and active-turn pointer.
    this.projectState(state, "active");
  }

  projectAuxiliaryEvent(threadId: string, event: EventRecord): void {
    const payload = asPayloadRecord(event.payload);
    if (event.type === "thread.checkpoint.updated") {
      const delta = deserializeThreadCheckpointDelta(event.payload);
      for (const entry of delta.commandsAppended ?? []) {
        this.projectToolAudit(threadId, event.turnId, entry);
      }
      return;
    }
    if (event.type === "turn.started" && event.turnId && payload) {
      if (isChatMessage(payload.message) && payload.message.role === "user") {
        this.projectTurnStarted(threadId, event.turnId, payload.message as UserChatMessage, event.timestamp);
        this.storage.db.prepare("UPDATE threads SET active_turn_id = ? WHERE id = ?").run(event.turnId, threadId);
      }
      return;
    }
    if (event.type === "message.user" && event.turnId && payload) {
      const message =
        isChatMessage(payload.message) && payload.message.role === "user"
          ? payload.message
          : typeof payload.content === "string"
            ? { role: "user" as const, content: payload.content }
            : undefined;
      if (message) {
        this.projectTurnStarted(threadId, event.turnId, message, event.timestamp);
        this.storage.db.prepare("UPDATE threads SET active_turn_id = ? WHERE id = ?").run(event.turnId, threadId);
      }
      return;
    }
    if ((event.type === "message.assistant" || event.type === "message.assistant.synthetic") && event.turnId) {
      if (isChatMessage(event.payload) && event.payload.role === "assistant") {
        this.projectTurnAssistant(threadId, event.turnId, event.payload, event.timestamp);
      }
      return;
    }
    if (event.type === "turn.completed" && event.turnId) {
      const reason = typeof payload?.reason === "string" ? payload.reason : "success";
      this.projectRuntimeTurnCompleted(threadId, event.turnId, reason, event.timestamp);
      this.storage.db.prepare("UPDATE threads SET active_turn_id = NULL WHERE id = ?").run(threadId);
      return;
    }
    if (event.type === "turn.recovered" && event.turnId && payload) {
      const messages = Array.isArray(payload.messages) ? payload.messages.filter(isChatMessage) : [];
      const assistant = [...messages]
        .reverse()
        .find((message): message is Extract<ChatMessage, { role: "assistant" }> => message.role === "assistant");
      if (assistant) {
        this.projectTurnCompleted(threadId, event.turnId, assistant, "interrupted", event.timestamp);
      } else {
        this.projectRuntimeTurnCompleted(threadId, event.turnId, "interrupted", event.timestamp);
      }
      this.storage.db.prepare("UPDATE threads SET active_turn_id = NULL WHERE id = ?").run(threadId);
      return;
    }
    if (event.type === "turn.completed" && event.turnId && payload) {
      if (isChatMessage(payload.message) && payload.message.role === "assistant") {
        const reason = typeof payload.reason === "string" ? payload.reason : "success";
        this.projectTurnCompleted(threadId, event.turnId, payload.message, reason, event.timestamp);
        this.storage.db.prepare("UPDATE threads SET active_turn_id = NULL WHERE id = ?").run(threadId);
      }
      return;
    }
    if (event.type === "command.audit.recorded" && payload) {
      const entry = payload.entry as CommandAuditEntry | undefined;
      if (entry && typeof entry.id === "string" && Array.isArray(entry.args)) {
        this.projectToolAudit(threadId, event.turnId, entry);
      }
      return;
    }
    if (event.type === "subagent.artifact" && payload) {
      const artifacts = artifactPayload(payload);
      for (const entry of artifacts.commands) {
        this.projectToolAudit(threadId, event.turnId, entry);
      }
    }
  }

  private projectTurnStarted(threadId: string, turnId: string, message: UserChatMessage, startedAt: string): void {
    this.storage.db
      .prepare(
        `INSERT INTO turns(
           id, thread_id, status, user_message_json, workspace_revision, started_at
         ) VALUES (?, ?, 'active', ?, COALESCE((SELECT workspace_revision FROM threads WHERE id = ?), 1), ?)
         ON CONFLICT(id) DO UPDATE SET
           user_message_json = COALESCE(turns.user_message_json, excluded.user_message_json),
           started_at = MIN(turns.started_at, excluded.started_at)`,
      )
      .run(turnId, threadId, serializeChatMessage(message), threadId, startedAt);
  }

  private projectTurnCompleted(
    threadId: string,
    turnId: string,
    message: Extract<ChatMessage, { role: "assistant" }>,
    reason: string,
    completedAt: string,
  ): void {
    this.storage.db
      .prepare(
        `INSERT INTO turns(
           id, thread_id, status, assistant_message_json, result_reason,
           started_at, completed_at
         ) VALUES (?, ?, 'completed', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = 'completed',
           assistant_message_json = excluded.assistant_message_json,
           result_reason = excluded.result_reason,
           completed_at = excluded.completed_at`,
      )
      .run(turnId, threadId, serializeChatMessage(message), reason, completedAt, completedAt);
  }

  private projectTurnAssistant(
    threadId: string,
    turnId: string,
    message: Extract<ChatMessage, { role: "assistant" }>,
    timestamp: string,
  ): void {
    this.storage.db
      .prepare(
        `INSERT INTO turns(
           id, thread_id, status, assistant_message_json, started_at
         ) VALUES (?, ?, 'active', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           assistant_message_json = excluded.assistant_message_json`,
      )
      .run(turnId, threadId, serializeChatMessage(message), timestamp);
  }

  private projectRuntimeTurnCompleted(threadId: string, turnId: string, reason: string, completedAt: string): void {
    this.storage.db
      .prepare(
        `INSERT INTO turns(
           id, thread_id, status, result_reason, started_at, completed_at
         ) VALUES (?, ?, 'completed', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = 'completed',
           result_reason = excluded.result_reason,
           completed_at = excluded.completed_at`,
      )
      .run(turnId, threadId, reason, completedAt, completedAt);
  }

  projectState(state: SessionState, status: string): void {
    this.storage.db
      .prepare(
        `INSERT INTO threads(
           id, workspace_root, workspace_id, workspace_revision, mode, provider, model, goal,
           constraints_json, working_summary, active_turn_id, status,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_root = excluded.workspace_root,
           workspace_id = excluded.workspace_id,
           workspace_revision = excluded.workspace_revision,
           mode = excluded.mode,
           provider = excluded.provider,
           model = excluded.model,
           goal = excluded.goal,
           constraints_json = excluded.constraints_json,
           working_summary = excluded.working_summary,
           active_turn_id = excluded.active_turn_id,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.threadId,
        state.workspaceRoot,
        state.projectId ?? workspaceIdFromRoot(state.workspaceRoot),
        state.workspaceRevision ?? 1,
        state.mode,
        state.provider,
        state.model,
        state.goal ?? null,
        JSON.stringify(state.constraints),
        state.workingSummary,
        state.activeTurnId ?? null,
        status,
        state.createdAt,
        state.updatedAt,
      );
  }

  projectEvent(event: EventRecord, journalPath: string): void {
    this.storage.db
      .prepare(
        `INSERT INTO item_index(
           event_id, thread_id, turn_id, sequence, event_type, phase,
           timestamp, journal_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(
        event.eventId,
        event.threadId,
        event.turnId ?? null,
        event.sequence,
        event.type,
        event.phase ?? null,
        event.timestamp,
        journalPath,
      );
  }

  projectToolAudit(threadId: string, turnId: string | undefined, entry: CommandAuditEntry): void {
    this.storage.db
      .prepare(
        `INSERT INTO tool_audit(
           id, thread_id, turn_id, program, args_json, cwd, status,
           exit_code, duration_ms, timestamp, summary, source_agent_role,
           source_agent_id, source_task_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           exit_code = excluded.exit_code,
           duration_ms = excluded.duration_ms,
           timestamp = excluded.timestamp,
           summary = excluded.summary,
           source_agent_role = excluded.source_agent_role,
           source_agent_id = excluded.source_agent_id,
           source_task_id = excluded.source_task_id`,
      )
      .run(
        entry.id,
        threadId,
        turnId ?? null,
        entry.program,
        JSON.stringify(entry.args),
        entry.cwd,
        entry.status,
        entry.exitCode,
        entry.durationMs,
        entry.timestamp,
        entry.summary,
        entry.sourceAgentRole ?? null,
        entry.sourceAgentId ?? null,
        entry.sourceTaskId ?? null,
      );
  }

  touchThread(threadId: string, timestamp: string): void {
    this.storage.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(timestamp, threadId);
  }
}
