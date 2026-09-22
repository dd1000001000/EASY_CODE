import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ProjectFolder, ProjectRecord, ProjectWorkspace } from "../projects/types.js";
import { projectPrimaryFolder, projectWorkspace } from "../projects/types.js";
import type { EasyCodeStorage } from "../storage/database.js";
import type { ThreadSummary } from "../threads/thread-store.js";
import { ThreadTitleStore } from "../threads/thread-title.js";
import { WorkspacePathGuard } from "../workspace/path-guard.js";

export interface ProjectItem {
  id: string;
  name: string;
  workspaceRevision: number;
  primaryFolderId?: string;
  folders: ProjectFolder[];
  ready: boolean;
  /** Primary folder path for compact labels and deletion confirmations. */
  root: string;
}
export interface ProjectEditInput {
  name: string;
  retainedFolderIds: readonly string[];
  addedFolderPaths: readonly string[];
  primaryFolderId?: string;
  primaryFolderPath?: string;
}
export interface SidebarThread extends ThreadSummary { title: string; canRename: boolean }

interface ProjectRow {
  id: string; name: string; workspace_revision: number; primary_folder_id: string | null;
  created_at: string; updated_at: string;
}
interface FolderRow {
  id: string; project_id: string; folder_key: string; canonical_path: string; active: number;
  added_revision: number; removed_revision: number | null; sort_order: number;
}
interface TitleRow { id: string; title: string | null }

function displayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || /[\x00-\x1f\x7f]/u.test(name)) throw new Error("Name must contain 1–120 printable characters.");
  return name;
}

function canonicalDirectory(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("Select an absolute local folder path.");
  // Reuse the file-tool boundary so roots cannot traverse a junction/symlink.
  return new WorkspacePathGuard(value).root;
}

function pathKey(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function overlaps(left: string, right: string): boolean {
  const a = pathKey(left); const b = pathKey(right);
  const relativeAB = path.relative(a, b);
  const relativeBA = path.relative(b, a);
  const contained = (relative: string) => relative === "" ||
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return contained(relativeAB) || contained(relativeBA);
}

function defaultName(root: string): string { return path.basename(root) || root; }

function baseFolderKey(root: string): string {
  const ascii = defaultName(root).normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
  return ascii || "folder";
}

function folder(row: FolderRow): ProjectFolder {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.folder_key,
    path: row.canonical_path,
    active: row.active === 1,
    addedRevision: row.added_revision,
    ...(row.removed_revision === null ? {} : { removedRevision: row.removed_revision }),
    sortOrder: row.sort_order,
  };
}

/** Durable logical projects and their revisioned host-folder membership. */
export class ProjectIndex {
  private readonly titles: ThreadTitleStore;
  constructor(private readonly storage: EasyCodeStorage) {
    this.titles = new ThreadTitleStore(storage);
  }

  private rows(): ProjectRow[] {
    return this.storage.db.prepare<[], ProjectRow>(
      `SELECT id, name, workspace_revision, primary_folder_id, created_at, updated_at
         FROM projects ORDER BY name COLLATE NOCASE, id`,
    ).all();
  }

  private folderRows(projectId?: string): FolderRow[] {
    return projectId
      ? this.storage.db.prepare<[string], FolderRow>(
        `SELECT id, project_id, folder_key, canonical_path, active, added_revision,
                removed_revision, sort_order FROM project_folders
          WHERE project_id = ? ORDER BY sort_order, id`,
      ).all(projectId)
      : this.storage.db.prepare<[], FolderRow>(
        `SELECT id, project_id, folder_key, canonical_path, active, added_revision,
                removed_revision, sort_order FROM project_folders ORDER BY project_id, sort_order, id`,
      ).all();
  }

  private record(row: ProjectRow, folders: readonly FolderRow[]): ProjectRecord {
    return {
      id: row.id,
      name: row.name,
      workspaceRevision: row.workspace_revision,
      ...(row.primary_folder_id ? { primaryFolderId: row.primary_folder_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      folders: folders.filter(item => item.project_id === row.id).map(folder),
    };
  }

  private item(record: ProjectRecord): ProjectItem {
    const primary = projectPrimaryFolder(record);
    return { ...record, folders: [...record.folders], ready: Boolean(primary), root: primary?.path ?? "" };
  }

  list(threads: readonly ThreadSummary[] = []): { projects: ProjectItem[]; threads: SidebarThread[] } {
    const folderRows = this.folderRows();
    const projects = this.rows().map(row => this.item(this.record(row, folderRows)));
    const titles = this.storage.db.prepare<[], TitleRow>("SELECT id, title FROM threads WHERE title IS NOT NULL").all();
    const byId = new Map(titles.map(row => [row.id, row.title]));
    return {
      projects,
      threads: threads.map(thread => ({ ...thread,
        title: byId.get(thread.threadId) ?? thread.goal ?? `Thread ${thread.threadId.slice(0, 8)}`,
        canRename: !byId.has(thread.threadId) })),
    };
  }

  create(name = "Untitled project"): ProjectItem {
    const id = `project_${randomUUID()}`;
    const now = new Date().toISOString();
    this.storage.db.prepare<[string, string, string, string]>(
      `INSERT INTO projects(id, name, workspace_revision, primary_folder_id, created_at, updated_at)
       VALUES (?, ?, 1, NULL, ?, ?)`,
    ).run(id, displayName(name), now, now);
    return this.get(id);
  }

  /** Create a distinct project whose first folder is the selected directory. */
  add(folderPath: string, name?: string): ProjectItem {
    const root = canonicalDirectory(folderPath);
    const created = this.create(name ?? defaultName(root));
    this.addFolder(created.id, root);
    return this.get(created.id);
  }

  get(id: string): ProjectItem {
    const row = this.storage.db.prepare<[string], ProjectRow>(
      `SELECT id, name, workspace_revision, primary_folder_id, created_at, updated_at
         FROM projects WHERE id = ?`,
    ).get(id);
    if (!row) throw new Error("Project not found.");
    return this.item(this.record(row, this.folderRows(id)));
  }

  workspace(id: string): ProjectWorkspace { return projectWorkspace(this.get(id)); }

  addFolder(projectId: string, folderPath: string): ProjectFolder {
    const root = canonicalDirectory(folderPath);
    const project = this.get(projectId);
    for (const existing of project.folders.filter(item => item.active)) {
      if (overlaps(existing.path, root)) {
        throw new Error(pathKey(existing.path) === pathKey(root)
          ? "This folder is already attached to the project."
          : `Project folders cannot contain one another (${existing.path} and ${root}).`);
      }
    }
    const prior = project.folders.find(item => pathKey(item.path) === pathKey(root));
    const revision = project.workspaceRevision + 1;
    const now = new Date().toISOString();
    this.storage.db.transaction(() => {
      let folderId = prior?.id;
      if (prior) {
        this.storage.db.prepare<[number, number, string, string]>(
          `UPDATE project_folders SET active = 1, added_revision = ?, removed_revision = NULL,
                  sort_order = ?, updated_at = ? WHERE id = ?`,
        ).run(revision, project.folders.length, now, prior.id);
      } else {
        const used = new Set(project.folders.map(item => item.key));
        const base = baseFolderKey(root);
        let key = base;
        for (let suffix = 2; used.has(key); suffix += 1) key = `${base}-${suffix}`;
        folderId = `folder_${randomUUID()}`;
        this.storage.db.prepare<[string, string, string, string, number, number, string, string]>(
          `INSERT INTO project_folders(
             id, project_id, folder_key, canonical_path, active, added_revision,
             removed_revision, sort_order, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?)`,
        ).run(folderId, projectId, key, root, revision, project.folders.length, now, now);
      }
      const nextPrimary = project.primaryFolderId ?? folderId;
      this.storage.db.prepare<[number, string | null, string, string]>(
        "UPDATE projects SET workspace_revision = ?, primary_folder_id = ?, updated_at = ? WHERE id = ?",
      ).run(revision, nextPrimary ?? null, now, projectId);
    })();
    const refreshed = this.get(projectId);
    return refreshed.folders.find(item => item.active && pathKey(item.path) === pathKey(root))!;
  }

  removeFolder(projectId: string, folderId: string): void {
    const project = this.get(projectId);
    const target = project.folders.find(item => item.id === folderId && item.active);
    if (!target) throw new Error("Project folder not found.");
    const revision = project.workspaceRevision + 1;
    const now = new Date().toISOString();
    const nextPrimary = project.folders.find(item => item.active && item.id !== folderId)?.id;
    this.storage.db.transaction(() => {
      this.storage.db.prepare<[number, string, string]>(
        `UPDATE project_folders SET active = 0, removed_revision = ?, updated_at = ? WHERE id = ?`,
      ).run(revision, now, folderId);
      this.storage.db.prepare<[number, string | null, string, string]>(
        "UPDATE projects SET workspace_revision = ?, primary_folder_id = ?, updated_at = ? WHERE id = ?",
      ).run(revision, project.primaryFolderId === folderId ? nextPrimary ?? null : project.primaryFolderId ?? null, now, projectId);
    })();
  }

  setPrimaryFolder(projectId: string, folderId: string): void {
    const project = this.get(projectId);
    if (!project.folders.some(item => item.id === folderId && item.active)) throw new Error("Project folder not found.");
    if (project.primaryFolderId === folderId) return;
    const revision = project.workspaceRevision + 1;
    this.storage.db.prepare<[number, string, string, string]>(
      "UPDATE projects SET workspace_revision = ?, primary_folder_id = ?, updated_at = ? WHERE id = ?",
    ).run(revision, folderId, new Date().toISOString(), projectId);
  }

  /** Atomically update a project's label and complete active folder set. */
  editProject(projectId: string, input: Readonly<ProjectEditInput>): ProjectItem {
    const project = this.get(projectId);
    const name = displayName(input.name);
    const retainedIds = new Set(input.retainedFolderIds);
    if (retainedIds.size !== input.retainedFolderIds.length) throw new Error("Project folders must be unique.");

    const activeById = new Map(project.folders.filter(item => item.active).map(item => [item.id, item]));
    const desired: Array<{ folder: ProjectFolder; path: string; existing: boolean }> = [];
    for (const folderId of input.retainedFolderIds) {
      const existing = activeById.get(folderId);
      if (!existing) throw new Error("Project folder not found.");
      desired.push({ folder: existing, path: existing.path, existing: true });
    }

    const usedKeys = new Set(project.folders.map(item => item.key));
    const usedPaths = new Set(desired.map(item => pathKey(item.path)));
    for (const value of input.addedFolderPaths) {
      const root = canonicalDirectory(value);
      const normalized = pathKey(root);
      if (usedPaths.has(normalized)) throw new Error("This folder is already attached to the project.");
      usedPaths.add(normalized);
      const prior = project.folders.find(item => pathKey(item.path) === normalized);
      if (prior) {
        desired.push({ folder: prior, path: root, existing: true });
        continue;
      }
      const base = baseFolderKey(root);
      let key = base;
      for (let suffix = 2; usedKeys.has(key); suffix += 1) key = `${base}-${suffix}`;
      usedKeys.add(key);
      desired.push({
        folder: {
          id: `folder_${randomUUID()}`,
          projectId,
          key,
          path: root,
          active: true,
          addedRevision: project.workspaceRevision + 1,
          sortOrder: desired.length,
        },
        path: root,
        existing: false,
      });
    }

    for (let left = 0; left < desired.length; left += 1) {
      for (let right = left + 1; right < desired.length; right += 1) {
        if (overlaps(desired[left]!.path, desired[right]!.path)) {
          throw new Error(`Project folders cannot contain one another (${desired[left]!.path} and ${desired[right]!.path}).`);
        }
      }
    }

    if (input.primaryFolderId && input.primaryFolderPath) throw new Error("Select only one primary project folder.");
    let primaryFolderId: string | undefined;
    if (input.primaryFolderId) {
      primaryFolderId = desired.find(item => item.folder.id === input.primaryFolderId)?.folder.id;
      if (!primaryFolderId) throw new Error("Primary project folder not found.");
    } else if (input.primaryFolderPath) {
      const primaryPath = pathKey(canonicalDirectory(input.primaryFolderPath));
      primaryFolderId = desired.find(item => pathKey(item.path) === primaryPath)?.folder.id;
      if (!primaryFolderId) throw new Error("Primary project folder not found.");
    } else {
      primaryFolderId = desired[0]?.folder.id;
    }

    const active = project.folders.filter(item => item.active);
    const workspaceChanged = active.length !== desired.length ||
      active.some((item, index) => item.id !== desired[index]?.folder.id) ||
      project.primaryFolderId !== primaryFolderId;
    const revision = workspaceChanged ? project.workspaceRevision + 1 : project.workspaceRevision;
    const now = new Date().toISOString();
    const desiredIds = new Set(desired.map(item => item.folder.id));

    this.storage.db.transaction(() => {
      if (workspaceChanged) {
        for (const current of active) {
          if (desiredIds.has(current.id)) continue;
          this.storage.db.prepare<[number, string, string]>(
            "UPDATE project_folders SET active = 0, removed_revision = ?, updated_at = ? WHERE id = ?",
          ).run(revision, now, current.id);
        }
        desired.forEach((item, sortOrder) => {
          if (item.existing && item.folder.active) {
            this.storage.db.prepare<[number, string, string]>(
              "UPDATE project_folders SET sort_order = ?, updated_at = ? WHERE id = ?",
            ).run(sortOrder, now, item.folder.id);
          } else if (item.existing) {
            this.storage.db.prepare<[number, number, string, string]>(
              `UPDATE project_folders SET active = 1, added_revision = ?, removed_revision = NULL,
                      sort_order = ?, updated_at = ? WHERE id = ?`,
            ).run(revision, sortOrder, now, item.folder.id);
          } else {
            this.storage.db.prepare<[string, string, string, string, number, number, string, string]>(
              `INSERT INTO project_folders(
                 id, project_id, folder_key, canonical_path, active, added_revision,
                 removed_revision, sort_order, created_at, updated_at
               ) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?)`,
            ).run(item.folder.id, projectId, item.folder.key, item.path, revision, sortOrder, now, now);
          }
        });
      }
      this.storage.db.prepare<[string, number, string | null, string, string]>(
        "UPDATE projects SET name = ?, workspace_revision = ?, primary_folder_id = ?, updated_at = ? WHERE id = ?",
      ).run(name, revision, primaryFolderId ?? null, now, projectId);
    })();
    return this.get(projectId);
  }

  renameProject(id: string, name: string): void {
    this.get(id);
    this.storage.db.prepare<[string, string, string]>("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
      .run(displayName(name), new Date().toISOString(), id);
  }

  renameThread(thread: Readonly<ThreadSummary>, name: string): void {
    if (!this.titles.claim(thread.threadId, name)) throw new Error("Conversation was already named and cannot be renamed again.");
  }

  forgetProject(id: string): void {
    this.get(id);
    this.storage.db.prepare<[string]>("DELETE FROM projects WHERE id = ?").run(id);
  }
}
