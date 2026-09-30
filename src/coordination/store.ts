import { createHash } from "node:crypto";
import path from "node:path";
import type { EasyCodeStorage } from "../storage/database.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";

export function coordinationPath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export interface PeerMessage {
  id: string;
  sender_thread_id: string;
  target_thread_id: string;
  text: string;
  queued_at: string;
}

export interface FileObservation {
  threadId: string;
  turnId: string;
  callId: string;
  agentId: string;
  tool: string;
  path: string;
  operation: "created" | "modified" | "deleted";
}

/** Shared SQLite indexes; receiving processes alone append to their own journals. */
export class CoordinationStore {
  constructor(private readonly storage: EasyCodeStorage) {}

  record(changes: readonly FileObservation[]): void {
    if (!changes.length) return;
    const now = new Date().toISOString();
    this.storage.db.transaction(() => {
      const insert = this.storage.db.prepare(`INSERT INTO file_observations
        (thread_id, turn_id, call_id, path, agent_id, tool, operation, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, call_id, path)
        DO UPDATE SET operation = excluded.operation, observed_at = excluded.observed_at`);
      for (const change of changes)
        insert.run(
          change.threadId,
          change.turnId,
          change.callId,
          coordinationPath(change.path),
          change.agentId,
          change.tool,
          change.operation,
          now,
        );
    })();
  }

  find(filename: string, requestingThread: string) {
    return this.storage.db
      .prepare(
        `SELECT o.thread_id AS threadId, t.title, t.goal,
      t.status, t.active_turn_id AS activeTurnId, MAX(o.observed_at) AS lastObservedAt
      FROM file_observations o JOIN threads t ON t.id = o.thread_id
      WHERE o.path = ? AND o.thread_id <> ? GROUP BY o.thread_id
      ORDER BY lastObservedAt DESC LIMIT 10`,
      )
      .all(coordinationPath(filename), requestingThread);
  }

  send(
    senderThread: string,
    senderTurn: string,
    callId: string,
    target: string,
    text: string,
    limits: Readonly<RuntimeLimits>,
  ): { messageId: string; status: "queued"; targetState: string } {
    if (senderThread === target) throw new Error("Send to another Thread, not yourself.");
    if (!text.trim() || text.length > limits.coordinationMessageMaxChars)
      throw new Error(`Message must contain 1-${limits.coordinationMessageMaxChars} characters.`);
    const id = `peer_${createHash("sha256")
      .update(JSON.stringify([senderThread, callId]))
      .digest("hex")}`;
    return this.storage.db.transaction(() => {
      const thread = this.storage.db
        .prepare<unknown[], { status: string; active_turn_id: string | null }>(
          "SELECT status, active_turn_id FROM threads WHERE id = ?",
        )
        .get(target);
      if (!thread) throw new Error("Target Thread does not exist.");
      const existing = this.storage.db
        .prepare<unknown[], PeerMessage>("SELECT * FROM peer_messages WHERE id = ?")
        .get(id);
      if (existing && (existing.target_thread_id !== target || existing.text !== text)) {
        throw new Error("Message call ID was reused with different content.");
      }
      if (!existing) {
        const count = this.storage.db
          .prepare<unknown[], { count: number }>(
            "SELECT COUNT(*) AS count FROM peer_messages WHERE sender_thread_id = ? AND sender_turn_id = ?",
          )
          .get(senderThread, senderTurn)!.count;
        if (count >= limits.coordinationMessagesPerTurn)
          throw new Error(
            "This turn's peer message limit is reached; continue the task without sending more messages.",
          );
        this.storage.db
          .prepare(
            `INSERT INTO peer_messages
          (id, sender_thread_id, sender_turn_id, target_thread_id, text, queued_at) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, senderThread, senderTurn, target, text, new Date().toISOString());
      }
      return {
        messageId: id,
        status: "queued" as const,
        targetState: thread.active_turn_id ? "active_turn" : "not_running; retained until the next turn",
      };
    })();
  }

  pending(threadId: string, limit: number): PeerMessage[] {
    return this.storage.db
      .prepare<unknown[], PeerMessage>(
        `SELECT * FROM peer_messages
      WHERE target_thread_id = ? AND admitted = 0 ORDER BY sequence LIMIT ?`,
      )
      .all(threadId, limit);
  }

  acknowledge(id: string): void {
    this.storage.db.prepare("UPDATE peer_messages SET admitted = 1 WHERE id = ?").run(id);
  }

  prune(days: number): void {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    this.storage.db.transaction(() => {
      this.storage.db.prepare("DELETE FROM file_observations WHERE observed_at < ?").run(cutoff);
      // Undelivered messages are preserved, including while the target is paused.
      this.storage.db.prepare("DELETE FROM peer_messages WHERE admitted = 1 AND queued_at < ?").run(cutoff);
    })();
  }
}
