import { existsSync, lstatSync, rmSync } from "node:fs";
import path from "node:path";
import type { EasyCodeStorage } from "../storage/database.js";
import { memorySearchText } from "../memory/search-terms.js";
import { sha256 } from "../utils/hash.js";
import type { ThreadLease, ThreadStore, ThreadSummary } from "./thread-store.js";

interface RevisionRow {
  sequence: number;
  thread_id: string;
  snapshot_json: string;
}

interface SnapshotMemory {
  workspace_id: string;
  scope: string;
  category: string;
  content: string;
  normalized_content: string;
  status: string;
  evidence: string | null;
  source_thread_id: string | null;
  source_turn_id: string | null;
  updated_at: string;
}

interface Revision {
  readonly sequence: number;
  readonly threadId: string;
  readonly memory: SnapshotMemory | undefined;
  /** The thread whose words the memory holds at this revision: the latest one that set its content or category. */
  readonly author: string;
}

/** What deleting the threads does to one memory they touched. */
type MemoryPlan =
  | { readonly kind: "delete" }
  | { readonly kind: "keep"; readonly removeAfter: number }
  | { readonly kind: "restore"; readonly revision: Revision };

function removePrivateDirectory(root: string, ...parts: string[]): void {
  const target = path.resolve(root, ...parts);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error("Private data path escaped its store.");
  if (!existsSync(target)) return;
  if (lstatSync(target).isSymbolicLink()) throw new Error("Refusing to delete a linked private data directory.");
  rmSync(target, { recursive: true, force: true });
}

function snapshotMemory(json: string): SnapshotMemory | undefined {
  try {
    const memory = (JSON.parse(json) as { memory?: Record<string, unknown> }).memory;
    if (
      memory &&
      typeof memory.workspace_id === "string" &&
      typeof memory.scope === "string" &&
      typeof memory.content === "string" &&
      typeof memory.normalized_content === "string" &&
      typeof memory.category === "string" &&
      typeof memory.status === "string" &&
      typeof memory.updated_at === "string"
    )
      return memory as unknown as SnapshotMemory;
  } catch {
    /* A damaged revision cannot be restored. */
  }
  return undefined;
}

/** Each revision with the thread that authored the content it holds; status-only changes keep the earlier author. */
function revisionHistory(rows: readonly RevisionRow[]): Revision[] {
  const history: Revision[] = [];
  for (const row of rows) {
    const memory = snapshotMemory(row.snapshot_json);
    const previous = history.at(-1);
    const sameText =
      previous?.memory &&
      memory &&
      previous.memory.content === memory.content &&
      previous.memory.category === memory.category;
    history.push({
      sequence: row.sequence,
      threadId: row.thread_id,
      memory,
      author: sameText ? previous.author : row.thread_id,
    });
  }
  return history;
}

/**
 * The latest state no deleted thread wrote or changed survives. A later change
 * by another conversation or by the user is kept; only what the deleted threads
 * authored, and states built on it, is removed.
 */
function planMemory(history: readonly Revision[], deleted: ReadonlySet<string>): MemoryPlan {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const revision = history[index]!;
    if (deleted.has(revision.threadId) || deleted.has(revision.author) || !revision.memory) continue;
    return index === history.length - 1
      ? { kind: "keep", removeAfter: revision.sequence }
      : { kind: "restore", revision };
  }
  return { kind: "delete" };
}

/** Delete journal-owned sessions, their private files, and the memory content they contributed. */
export function deleteStoredThreads(
  storage: EasyCodeStorage,
  threads: readonly { threadId: string; workspaceId: string }[],
): void {
  if (!threads.length) return;
  for (const thread of threads) {
    if (!/^[A-Za-z0-9._-]+$/u.test(thread.threadId)) throw new Error("Invalid conversation ID.");
  }
  const ids = threads.map((thread) => thread.threadId);
  const deleted = new Set(ids);
  storage.db.transaction(() => {
    const touched = new Set<string>();
    for (const id of ids) {
      for (const row of storage.db
        .prepare<[string, string], { memory_id: string }>(
          `SELECT DISTINCT memory_id FROM memory_revisions WHERE thread_id = ?
           UNION SELECT id FROM memories WHERE source_thread_id = ?`,
        )
        .all(id, id))
        touched.add(row.memory_id);
    }
    const revisions = storage.db.prepare<[string], RevisionRow>(
      "SELECT sequence, thread_id, snapshot_json FROM memory_revisions WHERE memory_id = ? ORDER BY sequence",
    );
    const plans = new Map<string, MemoryPlan>();
    for (const memoryId of touched) plans.set(memoryId, planMemory(revisionHistory(revisions.all(memoryId)), deleted));

    for (const [memoryId, plan] of plans) {
      if (plan.kind === "delete") {
        storage.db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
        continue;
      }
      let removeAfter = plan.kind === "keep" ? plan.removeAfter : plan.revision.sequence;
      // A memory superseded by a deleted thread stays superseded while its replacement survives.
      const current = storage.db
        .prepare<[string], { status: string; evidence: string | null }>(
          "SELECT status, evidence FROM memories WHERE id = ?",
        )
        .get(memoryId);
      const replacement = current?.status === "superseded" ? supersededBy(current.evidence) : undefined;
      const keepSuperseded =
        plan.kind === "restore" &&
        plan.revision.memory!.status !== "superseded" &&
        replacement !== undefined &&
        plans.get(replacement)?.kind !== "delete" &&
        !!storage.db.prepare<[string], { id: string }>("SELECT id FROM memories WHERE id = ?").get(replacement);
      if (plan.kind === "restore" && !keepSuperseded) {
        const memory = plan.revision.memory!;
        storage.db
          .prepare(
            `UPDATE memories SET workspace_id = ?, scope = ?, category = ?, content = ?, normalized_content = ?,
             search_text = ?, status = ?, evidence = ?, source_thread_id = ?, source_turn_id = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            memory.workspace_id,
            memory.scope,
            memory.category,
            memory.content,
            memory.normalized_content,
            memorySearchText(memory.content),
            memory.status,
            memory.evidence,
            memory.source_thread_id,
            memory.source_turn_id,
            memory.updated_at,
            memoryId,
          );
      } else if (keepSuperseded) removeAfter = Number.MAX_SAFE_INTEGER;
      // Later revisions hold the deleted threads' content; their own earlier revisions do too.
      storage.db
        .prepare("DELETE FROM memory_revisions WHERE memory_id = ? AND sequence > ?")
        .run(memoryId, removeAfter);
      for (const id of ids)
        storage.db.prepare("DELETE FROM memory_revisions WHERE memory_id = ? AND thread_id = ?").run(memoryId, id);
    }
    for (const id of ids) {
      storage.db.prepare("DELETE FROM memory_recall_events WHERE thread_id = ?").run(id);
      storage.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    }
  })();

  for (const thread of threads) {
    removePrivateDirectory(storage.threadsDir, thread.threadId);
    removePrivateDirectory(path.join(storage.dataDir, "attachments"), thread.threadId);
    removePrivateDirectory(
      path.join(storage.artifactsDir, "command-output", sha256(thread.workspaceId)),
      sha256(thread.threadId),
    );
  }
}

/** The replacement named by a memory's latest supersession. */
function supersededBy(evidence: string | null): string | undefined {
  if (!evidence) return undefined;
  try {
    const history = (JSON.parse(evidence) as { history?: { action?: string; relatedMemoryId?: string }[] }).history;
    const entry = [...(history ?? [])].reverse().find((item) => item.action === "supersede");
    return typeof entry?.relatedMemoryId === "string" ? entry.relatedMemoryId : undefined;
  } catch {
    return undefined;
  }
}

export function deleteThreadTree(storage: EasyCodeStorage, store: ThreadStore, threadId: string): readonly string[] {
  const known = new Map(store.list({ limit: 100_000 }).map((thread) => [thread.threadId, thread]));
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
        try {
          store.releaseThreadLease(lease);
        } catch {
          /* Preserve the original deletion error. */
        }
      }
    }
    throw error;
  }
  return [...selected.keys()];
}
