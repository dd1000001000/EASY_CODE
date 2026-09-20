import { existsSync, lstatSync, rmSync } from "node:fs";
import path from "node:path";
import type { EasyCodeStorage } from "../storage/database.js";
import { sha256 } from "../utils/hash.js";
import type { ThreadLease, ThreadStore, ThreadSummary } from "./thread-store.js";

interface RevisionRow { memory_id: string; first_sequence: number }
interface SnapshotRow { snapshot_json: string }

function removePrivateDirectory(root: string, ...parts: string[]): void {
  const target = path.resolve(root, ...parts);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error("Private data path escaped its store.");
  if (!existsSync(target)) return;
  if (lstatSync(target).isSymbolicLink()) throw new Error("Refusing to delete a linked private data directory.");
  rmSync(target, { recursive: true, force: true });
}

/** Delete journal-owned sessions, their private files, and every memory contribution after its first revision. */
export function deleteStoredThreads(storage: EasyCodeStorage,
  threads: readonly { threadId: string; workspaceId: string }[]): void {
  if (!threads.length) return;
  for (const thread of threads) {
    if (!/^[A-Za-z0-9._-]+$/u.test(thread.threadId)) throw new Error("Invalid conversation ID.");
  }
  const ids = threads.map(thread => thread.threadId);
  storage.db.transaction(() => {
    const firstRevision = storage.db.prepare<[string], RevisionRow>(
      "SELECT memory_id, MIN(sequence) AS first_sequence FROM memory_revisions WHERE thread_id = ? GROUP BY memory_id",
    );
    const priorSnapshot = storage.db.prepare<[string, number], SnapshotRow>(
      "SELECT snapshot_json FROM memory_revisions WHERE memory_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 1",
    );
    const memoryIds = new Map<string, number>();
    for (const id of ids) {
      for (const row of firstRevision.all(id)) {
        memoryIds.set(row.memory_id, Math.min(row.first_sequence, memoryIds.get(row.memory_id) ?? Infinity));
      }
      for (const row of storage.db.prepare<[string], { id: string }>(
        "SELECT id FROM memories WHERE source_thread_id = ?",
      ).all(id)) if (!memoryIds.has(row.id)) memoryIds.set(row.id, 0);
    }
    for (const [memoryId, first] of memoryIds) {
      const prior = first ? priorSnapshot.get(memoryId, first) : undefined;
      let restored = false;
      if (prior) {
        try {
          const snapshot = JSON.parse(prior.snapshot_json) as { memory?: Record<string, unknown>; provenance?: unknown };
          const memory = snapshot.memory;
          if (memory && typeof memory.workspace_id === "string" && typeof memory.scope === "string" &&
              typeof memory.content === "string" && typeof memory.normalized_content === "string" &&
              typeof memory.category === "string") {
            storage.db.prepare(
              `UPDATE memories SET workspace_id = ?, scope = ?, category = ?, content = ?, normalized_content = ?,
                 status = ?, evidence = ?, source_thread_id = ?, source_turn_id = ?, updated_at = ? WHERE id = ?`,
            ).run(memory.workspace_id, memory.scope, memory.category, memory.content,
              memory.normalized_content, memory.status, memory.evidence,
              memory.source_thread_id, memory.source_turn_id, memory.updated_at, memoryId);
            if (snapshot.provenance) storage.db.prepare(
              "INSERT INTO memory_provenance(memory_id, document_json) VALUES (?, ?) ON CONFLICT(memory_id) DO UPDATE SET document_json = excluded.document_json",
            ).run(memoryId, JSON.stringify(snapshot.provenance));
            else storage.db.prepare("DELETE FROM memory_provenance WHERE memory_id = ?").run(memoryId);
            storage.db.prepare("DELETE FROM memory_revisions WHERE memory_id = ? AND sequence >= ?").run(memoryId, first);
            restored = true;
          }
        } catch { /* A damaged or conflicting prior revision cannot retain deleted-thread content. */ }
      }
      if (!restored) storage.db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
    }
    for (const id of ids) {
      storage.db.prepare("DELETE FROM memory_recall_events WHERE thread_id = ?").run(id);
      storage.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    }
  })();

  for (const thread of threads) {
    removePrivateDirectory(storage.threadsDir, thread.threadId);
    removePrivateDirectory(path.join(storage.dataDir, "attachments"), thread.threadId);
    removePrivateDirectory(path.join(storage.artifactsDir, "command-output", sha256(thread.workspaceId)), sha256(thread.threadId));
  }
}

export function deleteThreadTree(storage: EasyCodeStorage, store: ThreadStore, threadId: string): readonly string[] {
  const known = new Map(store.list({ limit: 100_000 }).map(thread => [thread.threadId, thread]));
  if (!known.has(threadId)) throw new Error("Conversation not found.");
  const selected = new Map<string, ThreadSummary>();
  const collect = (id: string): void => {
    const summary = known.get(id);
    if (!summary || selected.has(id)) return;
    selected.set(id, summary);
    for (const child of store.subagentAssignments(id)) collect(child.assignment.childThreadId);
  };
  collect(threadId);
  const leases: ThreadLease[] = [];
  try {
    for (const id of selected.keys()) leases.push(store.acquireThreadLease(id));
    deleteStoredThreads(storage, [...selected.values()]);
  } catch (error) {
    for (const lease of leases.reverse()) {
      if (store.get(lease.threadId)) {
        try { store.releaseThreadLease(lease); } catch { /* Preserve the original deletion error. */ }
      }
    }
    throw error;
  }
  return [...selected.keys()];
}
