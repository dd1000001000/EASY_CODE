import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { workspaceIdFromRoot, type EasyCodeStorage } from "../storage/database.js";
import type { ThreadSummary } from "../threads/thread-store.js";
import { ThreadTitleStore } from "../threads/thread-title.js";

export interface ProjectItem { id: string; root: string; name: string }
export interface SidebarThread extends ThreadSummary { title: string; canRename: boolean }

interface ProjectRow { id: string; workspace_root: string; name: string }
interface TitleRow { id: string; title: string | null }

function displayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || /[\x00-\x1f\x7f]/u.test(name)) throw new Error("Name must contain 1–120 printable characters.");
  return name;
}

function canonicalDirectory(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("Select an absolute local folder path.");
  const root = realpathSync.native(path.resolve(value));
  if (!statSync(root).isDirectory()) throw new Error("Selected project path is not a folder.");
  return root;
}

function defaultName(root: string): string { return path.basename(root) || root; }

/** Project and conversation labels live in the existing EASY CODE SQLite database. */
export class ProjectIndex {
  private readonly titles: ThreadTitleStore;
  constructor(private readonly storage: EasyCodeStorage) {
    this.titles = new ThreadTitleStore(storage);
  }

  list(threads: readonly ThreadSummary[]): { projects: ProjectItem[]; threads: SidebarThread[] } {
    const rows = this.storage.db.prepare<[], ProjectRow>(
      "SELECT id, workspace_root, name FROM projects ORDER BY name COLLATE NOCASE, id",
    ).all();
    const projects = new Map(rows.map(row => [row.id, { id: row.id, root: row.workspace_root, name: row.name }]));
    for (const thread of threads) {
      if (!projects.has(thread.workspaceId)) projects.set(thread.workspaceId, {
        id: thread.workspaceId, root: thread.workspaceRoot, name: defaultName(thread.workspaceRoot),
      });
    }
    const titles = this.storage.db.prepare<[], TitleRow>("SELECT id, title FROM threads WHERE title IS NOT NULL").all();
    const byId = new Map(titles.map(row => [row.id, row.title]));
    return {
      projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
      threads: threads.map(thread => ({ ...thread,
        title: byId.get(thread.threadId) ?? thread.goal ?? `Thread ${thread.threadId.slice(0, 8)}`,
        canRename: !byId.has(thread.threadId) })),
    };
  }

  add(folder: string): ProjectItem {
    const root = canonicalDirectory(folder);
    const id = workspaceIdFromRoot(root);
    this.storage.db.prepare<[string, string, string, string]>(
      "INSERT OR IGNORE INTO projects(id, workspace_root, name, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, root, defaultName(root), new Date().toISOString());
    return this.get(id);
  }

  get(id: string): ProjectItem {
    const row = this.storage.db.prepare<[string], ProjectRow>(
      "SELECT id, workspace_root, name FROM projects WHERE id = ?",
    ).get(id);
    if (!row) throw new Error("Project not found.");
    return { id: row.id, root: row.workspace_root, name: row.name };
  }

  renameProject(id: string, name: string): void {
    this.get(id);
    this.storage.db.prepare<[string, string]>("UPDATE projects SET name = ? WHERE id = ?")
      .run(displayName(name), id);
  }

  renameThread(thread: Readonly<ThreadSummary>, name: string): void {
    if (!this.titles.claim(thread.threadId, name)) throw new Error("Conversation was already named and cannot be renamed again.");
  }

  forgetProject(id: string): void {
    this.get(id);
    this.storage.db.prepare<[string]>("DELETE FROM projects WHERE id = ?").run(id);
  }
}
