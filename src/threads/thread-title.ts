import type { EasyCodeStorage } from "../storage/database.js";
import { containsSensitiveInformation } from "../memory/sensitive.js";

/** A stored title is the one-way claim marker; display fallbacks never claim it. */
export function normalizeThreadTitle(value: string): string {
  const title = value.trim();
  if (!title || Array.from(title).length > 120 || /[\x00-\x1f\x7f]/u.test(title)) {
    throw new Error("Thread title must contain 1–120 printable characters.");
  }
  if (containsSensitiveInformation(title)) throw new Error("Thread title must not contain credentials.");
  return title;
}

export class ThreadTitleStore {
  constructor(private readonly storage: EasyCodeStorage) {}

  isUnclaimed(threadId: string): boolean {
    const row = this.storage.db.prepare<[string], { title: string | null }>(
      "SELECT title FROM threads WHERE id = ?",
    ).get(threadId);
    return row?.title === null;
  }

  /** Atomic across Web, CLI and concurrent agents sharing the database. */
  claim(threadId: string, value: string): boolean {
    const title = normalizeThreadTitle(value);
    return this.storage.db.prepare<[string, string]>(
      "UPDATE threads SET title = ? WHERE id = ? AND title IS NULL",
    ).run(title, threadId).changes === 1;
  }
}
